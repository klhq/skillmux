#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createClients } from "./clients";
import { loadConfig } from "./config";
import { backfillEmbeddings, configure, fetchSkill, resolveSkill } from "./router-core";
import { SKILL_ID_PATTERN } from "./vault";

export async function startServer(opts?: { transport?: "stdio" | "http"; port?: number }): Promise<void> {
  const config = await loadConfig();
  configure({ config, clients: createClients(config) });

  const server = new McpServer({ name: "skill-router", version: "0.1.0" });

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
      const result = await resolveSkill({ query });
      if (result.outcome === "matched") {
        const { body, ...meta } = result;
        return { content: [{ type: "text" as const, text: body }], structuredContent: { ...meta } };
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        structuredContent: { ...result },
      };
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
      const result = await fetchSkill({ skill_id });
      const { body, ...meta } = result;
      return { content: [{ type: "text" as const, text: body }], structuredContent: { ...meta } };
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

    const port = opts?.port ?? Number(process.env.PORT || 3000);
    const bunServer = Bun.serve({
      port,
      async fetch(req) {
        if (req.method === "OPTIONS") {
          return new Response(null, {
            headers: {
              "Access-Control-Allow-Origin": "*",
              "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
              "Access-Control-Allow-Headers": "Content-Type, MCP-Protocol-Version",
            },
          });
        }
        const res = await transport.handleRequest(req);
        const headers = new Headers(res.headers);
        headers.set("Access-Control-Allow-Origin", "*");
        return new Response(res.body, {
          status: res.status,
          statusText: res.statusText,
          headers,
        });
      },
    });
    console.log(`skill-router serving over HTTP on port ${bunServer.port}`);
  } else {
    await server.connect(new StdioServerTransport());
  }

  // model host offline (AC7/AC8) — lexical-only service is the floor.
  backfillEmbeddings().catch(() => {});
}

if (import.meta.main) await startServer();
