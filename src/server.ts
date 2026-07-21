#!/usr/bin/env bun
import { timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createClients } from "./clients";
import { loadConfig } from "./config";
import { backfillEmbeddings, configure, fetchSkill, resolveSkill } from "./router-core";
import { closeRuntime, getRuntime, startVaultWatcher } from "./router-core";
import { getStats, SINCE_PATTERN } from "./stats";
import { SKILL_ID_PATTERN } from "./vault";
import { MetricsRegistry } from "./metrics";
import { ReadinessState } from "./readiness";
import { initializeRuntime } from "./lifecycle";
import type { Clients, Config } from "./types";
import {
  computeHash,
  getEffectiveConfig,
  getLocalConfigStatus,
  setDottedKey,
  RELOADABLE_KEYS,
  RESTART_REQUIRED_KEYS,
} from "./config-service";
import { applyCalibrationRun, getCalibrationRun, listCalibrationRuns } from "./calibrate";

export const metricsRegistry = new MetricsRegistry();
export const readinessState = new ReadinessState();

export interface ServerHandle {
  port?: number;
  stop(): Promise<void>;
}

let warnedAuthToken = false;
function resolveAuthToken(envName: string): string {
  const value = process.env[envName];
  if (value) return value;
  if (envName === "SKILLMUX_AUTH_TOKEN" && process.env.SKILL_ROUTER_AUTH_TOKEN) {
    if (!warnedAuthToken) {
      warnedAuthToken = true;
      console.error("skillmux: SKILL_ROUTER_AUTH_TOKEN is deprecated, set SKILLMUX_AUTH_TOKEN instead");
    }
    return process.env.SKILL_ROUTER_AUTH_TOKEN;
  }
  return "";
}

function safeTokenEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export async function startServer(opts?: {
  transport?: "stdio" | "http";
  port?: number;
  config?: Config;
  clients?: Partial<Clients>;
}): Promise<ServerHandle> {
  const config = opts?.config ?? await loadConfig();
  configure({ config, clients: opts?.clients ?? createClients(config) });
  await initializeRuntime(readinessState);
  metricsRegistry.setReadiness(readinessState.get());
  const stopWatcher = await startVaultWatcher();

  const server = new McpServer({ name: "skillmux", version: "0.1.0" });

  // Transport rule from schema.json: the SKILL.md body appears exactly once on
  // the wire — verbatim as text content; structuredContent carries the metadata.
  server.registerTool(
    "resolve_skill",
    {
      description:
        "Route a natural-language task description to the most relevant skill in the vault. " +
        "Returns outcome matched (skill delivered inline), ambiguous (shortlist — pick one, then call fetch_skill), " +
        "or no_match (proceed under your normal workflow).",
      inputSchema: { query: z.string().min(1).max(8192) },
    },
    async ({ query }) => {
      const startTime = performance.now();
      try {
        const result = await resolveSkill({ query });
        const duration = (performance.now() - startTime) / 1000;
        metricsRegistry.recordResolveLatencySeconds(duration);
        metricsRegistry.recordResolveOutcome(result.outcome);

        if (result.outcome === "matched") {
          const { body, ...meta } = result;
          return { content: [{ type: "text" as const, text: body }], structuredContent: { ...meta } };
        }
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          structuredContent: { ...result },
        };
      } catch (err) {
        metricsRegistry.recordError();
        throw err;
      }
    },
  );

  server.registerTool(
    "fetch_skill",
    {
      description:
        "Fetch a skill's SKILL.md verbatim by skill_id, with sha256 and supporting-file paths. " +
        "Independent of any prior resolve_skill outcome.",
      inputSchema: { skill_id: z.string().regex(SKILL_ID_PATTERN) },
    },
    async ({ skill_id }) => {
      try {
        const result = await fetchSkill({ skill_id });
        const { body, ...meta } = result;
        return { content: [{ type: "text" as const, text: body }], structuredContent: { ...meta } };
      } catch (err) {
        metricsRegistry.recordError();
        throw err;
      }
    },
  );

  const transportType = opts?.transport ?? "stdio";
  if (transportType === "http") {
    const { WebStandardStreamableHTTPServerTransport } = await import(
      "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
    );
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
    });
    await server.connect(transport);

    const { RateLimiter } = await import("./rate-limiter");
    const rateLimiter = new RateLimiter(
      config.server?.rate_limit || { enabled: false, requests_per_minute: 60 }
    );

    const port = opts?.port ?? Number(process.env.PORT || 3000);
    const hostname = config.server?.hostname ?? "127.0.0.1";
    const bunServer = Bun.serve({
      port,
      hostname,
      async fetch(req, server) {
        const serverConfig = config.server || {
          auth_enabled: false,
          auth_token_env: "SKILLMUX_AUTH_TOKEN",
          allowed_origins: [],
        };
        const origin = req.headers.get("origin") || "";
        const allowedOrigins = serverConfig.allowed_origins;
        const isAllowed = allowedOrigins.includes("*") || allowedOrigins.includes(origin);
        const allowOriginHeader = isAllowed ? (allowedOrigins.includes("*") ? "*" : origin) : "";

        if (origin && !isAllowed) {
          return new Response("CORS origin not allowed", { status: 403 });
        }

        if (req.method === "OPTIONS") {
          return new Response(null, {
            headers: {
              "Access-Control-Allow-Origin": allowOriginHeader,
              "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
              "Access-Control-Allow-Headers": "Content-Type, Authorization, MCP-Protocol-Version",
            },
          });
        }

        // Run rate limiter check
        const rateLimitResult = rateLimiter.check({
          nowMs: Date.now(),
          auth_enabled: serverConfig.auth_enabled,
          req,
          server,
        });

        if (!rateLimitResult.allowed) {
          metricsRegistry.recordRateLimitExceeded();

          // Count the request in requests_total under the method if possible
          let mcpMethod = "unknown";
          try {
            const bodyClone = await req.clone().json();
            if (bodyClone.method === "tools/call") {
              mcpMethod = bodyClone.params?.name || "tools/call";
            } else {
              mcpMethod = bodyClone.method || "unknown";
            }
          } catch {
            // Non-JSON or parsing error
          }
          metricsRegistry.recordRequest(mcpMethod);

          const headers = new Headers(rateLimitResult.headers);
          if (allowOriginHeader) {
            headers.set("Access-Control-Allow-Origin", allowOriginHeader);
          }
          return new Response("Too Many Requests", {
            status: 429,
            headers,
          });
        }

        const url = new URL(req.url);
        if (req.method === "GET") {
          if (url.pathname === "/health" || url.pathname === "/health/live") {
            const headers = new Headers({ "Content-Type": "application/json" });
            if (allowOriginHeader) {
              headers.set("Access-Control-Allow-Origin", allowOriginHeader);
            }
            for (const [key, value] of Object.entries(rateLimitResult.headers)) {
              headers.set(key, value);
            }
            return new Response(JSON.stringify({ status: "ok" }), { status: 200, headers });
          }
          if (url.pathname === "/health/ready") {
            const readiness = readinessState.get();
            const headers = new Headers({ "Content-Type": "application/json" });
            if (allowOriginHeader) headers.set("Access-Control-Allow-Origin", allowOriginHeader);
            return new Response(JSON.stringify(readiness), {
              status: readiness.status === "ready" ? 200 : 503,
              headers,
            });
          }
          if (url.pathname === "/metrics") {
            const headers = new Headers({ "Content-Type": "text/plain; version=0.0.4" });
            if (allowOriginHeader) {
              headers.set("Access-Control-Allow-Origin", allowOriginHeader);
            }
            for (const [key, value] of Object.entries(rateLimitResult.headers)) {
              headers.set(key, value);
            }
            return new Response(metricsRegistry.render(), { status: 200, headers });
          }
        }

        // Token Auth Check
        if (serverConfig.auth_enabled) {
          const expectedToken = resolveAuthToken(serverConfig.auth_token_env);
          if (!expectedToken) {
            return new Response("Server authentication configured but token environment variable is empty", { status: 500 });
          }
          const authHeader = req.headers.get("authorization") || "";
          const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : authHeader;
          if (!token || !safeTokenEquals(token, expectedToken)) {
            return new Response("Unauthorized", { status: 401 });
          }
        }

        // GET /stats — placed after the Token Auth Check above (unlike /health and /metrics,
        // which return earlier and stay open) since audit queries carry raw user text.
        if (req.method === "GET" && url.pathname === "/stats") {
          const since = url.searchParams.get("since") ?? "";
          if (!SINCE_PATTERN.test(since)) {
            return new Response(
              JSON.stringify({ error: "since must be a relative window (e.g. 30d) or an absolute ISO-8601 date" }),
              { status: 400, headers: { "Content-Type": "application/json" } },
            );
          }
          const { db } = await getRuntime();
          const headers = new Headers({ "Content-Type": "application/json" });
          if (allowOriginHeader) headers.set("Access-Control-Allow-Origin", allowOriginHeader);
          for (const [key, value] of Object.entries(rateLimitResult.headers)) headers.set(key, value);
          return new Response(JSON.stringify(getStats(db, since)), { status: 200, headers });
        }

        // Admin HTTP API (/admin/v1/*)
        if (url.pathname.startsWith("/admin/v1/")) {
          if (!serverConfig.admin?.enabled) {
            return new Response("Admin endpoints disabled", { status: 403 });
          }

          const adminTokenEnv = serverConfig.admin.token_env || "SKILLMUX_ADMIN_TOKEN";
          const expectedAdminToken = process.env[adminTokenEnv] || "";
          const authHeader = req.headers.get("authorization") || "";
          const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : authHeader;

          if (!expectedAdminToken || !token || !safeTokenEquals(token, expectedAdminToken)) {
            return new Response("Unauthorized", { status: 401 });
          }

          const headers = new Headers({ "Content-Type": "application/json" });
          if (allowOriginHeader) headers.set("Access-Control-Allow-Origin", allowOriginHeader);

          if (req.method === "GET" && url.pathname === "/admin/v1/capabilities") {
            const isExternallyManaged = process.env.SKILLMUX_CONFIG_READONLY === "true";
            return new Response(
              JSON.stringify({
                config_read: true,
                config_write: !isExternallyManaged,
                calibration: true,
                persistence: isExternallyManaged ? "externally_managed" : "writable",
                reloadable_keys: RELOADABLE_KEYS,
                restart_required_keys: RESTART_REQUIRED_KEYS,
              }),
              { status: 200, headers }
            );
          }

          if (req.method === "GET" && url.pathname === "/admin/v1/config") {
            const { effective, sources } = await getEffectiveConfig();
            const hash = computeHash(effective);
            const status = await getLocalConfigStatus();
            headers.set("ETag", `"${hash}"`);
            return new Response(
              JSON.stringify({
                desired: effective,
                effective,
                sources,
                active_revision: hash,
                runtime: status,
              }),
              { status: 200, headers }
            );
          }

          if (req.method === "PATCH" && url.pathname === "/admin/v1/config") {
            if (process.env.SKILLMUX_CONFIG_READONLY === "true") {
              return new Response(
                JSON.stringify({ error: "CONFIG_EXTERNALLY_MANAGED", message: "Configuration is externally managed" }),
                { status: 409, headers }
              );
            }

            const ifMatch = req.headers.get("if-match") || "";
            const cleanIfMatch = ifMatch.replace(/^"|"$/g, "");
            const { effective } = await getEffectiveConfig();
            const currentHash = computeHash(effective);

            if (!ifMatch || cleanIfMatch !== currentHash) {
              return new Response(
                JSON.stringify({ error: "CONFIG_REVISION_CONFLICT", message: "Revision conflict" }),
                { status: 409, headers }
              );
            }

            const body = (await req.json()) as { changes: Record<string, string | number | boolean> };
            let lastResult: any = null;
            for (const [k, v] of Object.entries(body.changes ?? {})) {
              lastResult = await setDottedKey(k, String(v), { targetName: "remote" });
            }

            return new Response(JSON.stringify(lastResult ?? { ok: true }), { status: 200, headers });
          }

          if (url.pathname.startsWith("/admin/v1/calibrations")) {
            const { db } = await getRuntime();
            if (req.method === "GET" && url.pathname === "/admin/v1/calibrations") {
              const runs = listCalibrationRuns(db);
              return new Response(JSON.stringify(runs), { status: 200, headers });
            }
            const runIdMatch = url.pathname.match(/^\/admin\/v1\/calibrations\/([^\/]+)$/);
            if (req.method === "GET" && runIdMatch) {
              const run = getCalibrationRun(db, runIdMatch[1]);
              if (!run) return new Response(JSON.stringify({ error: "Calibration run not found" }), { status: 404, headers });
              return new Response(JSON.stringify(run), { status: 200, headers });
            }
            if (req.method === "POST" && url.pathname === "/admin/v1/calibrations") {
              const runId = "run_" + Math.random().toString(36).slice(2, 10);
              return new Response(JSON.stringify({ run_id: runId, status: "running" }), { status: 202, headers });
            }
            const applyMatch = url.pathname.match(/^\/admin\/v1\/calibrations\/([^\/]+)\/apply$/);
            if (req.method === "POST" && applyMatch) {
              const run = getCalibrationRun(db, applyMatch[1]);
              if (!run) return new Response(JSON.stringify({ error: "Calibration run not found" }), { status: 404, headers });
              await applyCalibrationRun(db, applyMatch[1]);
              return new Response(JSON.stringify({ ok: true, run_id: applyMatch[1] }), { status: 200, headers });
            }
          }

          return new Response("Not Found", { status: 404, headers });
        }

        // Record request metrics
        let mcpMethod = "unknown";
        try {
          const bodyClone = await req.clone().json();
          if (bodyClone.method === "tools/call") {
            mcpMethod = bodyClone.params?.name || "tools/call";
          } else {
            mcpMethod = bodyClone.method || "unknown";
          }
        } catch {
          // Non-JSON or parsing error
        }
        metricsRegistry.recordRequest(mcpMethod);

        const res = await transport.handleRequest(req);
        const headers = new Headers(res.headers);
        if (allowOriginHeader) {
          headers.set("Access-Control-Allow-Origin", allowOriginHeader);
        }
        for (const [key, value] of Object.entries(rateLimitResult.headers)) {
          headers.set(key, value);
        }
        return new Response(res.body, {
          status: res.status,
          statusText: res.statusText,
          headers,
        });
      },
    });
    let stopped = false;
    console.log(`skillmux serving over HTTP on ${hostname}:${bunServer.port}`);
    return {
      port: bunServer.port,
      async stop() {
        if (stopped) return;
        stopped = true;
        readinessState.set({ ...readinessState.get(), status: "stopping" });
        metricsRegistry.setReadiness(readinessState.get());
        bunServer.stop(true);
        stopWatcher();
        await server.close();
        closeRuntime();
      },
    };
  } else {
    await server.connect(new StdioServerTransport());
    let stopped = false;
    return {
      async stop() {
        if (stopped) return;
        stopped = true;
        readinessState.set({ ...readinessState.get(), status: "stopping" });
        metricsRegistry.setReadiness(readinessState.get());
        stopWatcher();
        await server.close();
        closeRuntime();
      },
    };
  }
}

if (import.meta.main) await startServer();
