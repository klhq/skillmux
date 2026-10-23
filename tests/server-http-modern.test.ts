import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import packageJson from "../package.json" with { type: "json" };
import { sha256Hex } from "../src/vault";
import { startServer, type ServerHandle } from "../src/server";
import { waitFor } from "./test-utils";
import {
  MODERN_VERSION,
  legacyInitialize,
  modernRequest,
  postModern,
  readMcpResponse,
  serveCommand,
  writeFixture,
} from "./helpers/mcp-wire";

// MCP over Streamable HTTP for both protocol eras against one server process.
// Runs in-process by default; with SKILLMUX_TEST_BIN it spawns that binary
// with `serve --transport http` instead, so the compiled build is covered too.
const TOKEN_ENV = "SKILLMUX_WIRE_TEST_TOKEN";
const TOKEN = "wire-test-token";
const tmp = mkdtempSync(join(tmpdir(), "skillmux-http-modern-"));
const { configPath, skillPath } = writeFixture(tmp, [
  `[server]`,
  `auth_enabled = true`,
  `auth_token_env = "${TOKEN_ENV}"`,
  ``,
]);
const auth = { authorization: `Bearer ${TOKEN}` };
const SERVER_INFO = "io.modelcontextprotocol/serverInfo";

let url: string;
let stop: () => Promise<void>;

async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = probe.port!;
  probe.stop(true);
  return port;
}

beforeAll(async () => {
  process.env[TOKEN_ENV] = TOKEN;
  if (process.env.SKILLMUX_TEST_BIN) {
    const port = await freePort();
    const proc = Bun.spawn(serveCommand("--transport", "http", "--port", String(port)), {
      stdout: "ignore",
      stderr: "inherit",
      env: { ...process.env, SKILLMUX_CONFIG: configPath },
    });
    url = `http://127.0.0.1:${port}/mcp`;
    await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/health`)).ok, 15_000);
    stop = async () => {
      proc.kill();
      await proc.exited;
    };
  } else {
    const handle: ServerHandle = await startServer({ transport: "http", port: 0, configPath });
    url = `http://127.0.0.1:${handle.port}/mcp`;
    stop = () => handle.stop();
  }
});

afterAll(async () => {
  await stop?.();
  delete process.env[TOKEN_ENV];
  rmSync(tmp, { recursive: true, force: true });
});

/** One full 2026-07-28 client session: discover, list, call. No initialize, no session id. */
async function modernClientRun(idBase: number) {
  const discoverRes = await postModern(url, modernRequest(idBase, "server/discover"), auth);
  expect(discoverRes.status).toBe(200);
  expect(discoverRes.headers.get("mcp-session-id")).toBeNull();
  const discover = await readMcpResponse(discoverRes);

  const listRes = await postModern(url, modernRequest(idBase + 1, "tools/list"), auth);
  expect(listRes.status).toBe(200);
  const list = await readMcpResponse(listRes);

  const callRes = await postModern(
    url,
    modernRequest(idBase + 2, "tools/call", { name: "fetch_skill", arguments: { skill_id: "wire-skill" } }),
    auth,
  );
  expect(callRes.status).toBe(200);
  const call = await readMcpResponse(callRes);
  return { discover, list, call };
}

async function legacyClientRun() {
  const client = new Client({ name: "skillmux-legacy-test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: auth } }));
  try {
    const { tools } = await client.listTools();
    const fetched = await client.callTool({ name: "fetch_skill", arguments: { skill_id: "wire-skill" } });
    return { tools, fetched };
  } finally {
    await client.close();
  }
}

describe("MCP 2026-07-28 over Streamable HTTP", () => {
  test("fetches one supporting file over HTTP with visible metadata and parent correlation", async () => {
    const content = "\uFEFF# Remote reference\r\n原文\r\n";
    const dir = join(tmp, "vault", "wire-skill", "references");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "notes.md"), content);
    const parent = await readMcpResponse(await postModern(url,
      modernRequest(50, "tools/call", { name: "fetch_skill", arguments: { skill_id: "wire-skill" } }), auth));
    const { fetch_id } = JSON.parse(parent.result.content[1].text);
    const response = await readMcpResponse(await postModern(url,
      modernRequest(51, "tools/call", { name: "fetch_skill", arguments: {
        skill_id: "wire-skill", path: "references/notes.md", parent_fetch_id: fetch_id,
      } }), auth));

    expect(response.result.isError).toBeFalsy();
    expect(response.result).not.toHaveProperty("structuredContent");
    expect(response.result.content).toHaveLength(2);
    expect(response.result.content[0].text).toBe(content);
    expect(JSON.parse(response.result.content[1].text)).not.toHaveProperty("fetch_id");
    expect(JSON.parse(response.result.content[1].text)).toMatchObject({
      skill_id: "wire-skill", path: "references/notes.md", content_sha256: sha256Hex(Buffer.from(content)),
      byte_length: Buffer.byteLength(content), parent_fetch_id: fetch_id,
    });
  });

  test("discover, tools/list and tools/call work with the per-request envelope and headers", async () => {
    const { discover, list, call } = await modernClientRun(1);

    expect(discover.error).toBeUndefined();
    expect(discover.result.supportedVersions).toContain(MODERN_VERSION);
    expect(discover.result.capabilities.tools).toBeDefined();
    expect(discover.result.capabilities.tools.listChanged).toBeFalsy();
    expect(discover.result._meta[SERVER_INFO].name).toBe("skillmux");
    expect(discover.result._meta[SERVER_INFO].version).toBe(packageJson.version);

    expect(list.result.resultType).toBe("complete");
    expect(typeof list.result.ttlMs).toBe("number");
    expect(list.result.ttlMs).toBeGreaterThan(0);
    expect(["public", "private"]).toContain(list.result.cacheScope);
    expect(list.result.tools.map((t: { name: string }) => t.name).sort()).toEqual([
      "fetch_skill",
      "resolve_skill",
    ]);

    expect(call.result.resultType).toBe("complete");
    expect(call.result.isError).toBeFalsy();
    expect(call.result.content[0].text).toBe(readFileSync(skillPath, "utf8"));
  });
});

describe("one HTTP server process serves many clients (regression: second initialize got 400)", () => {
  test("two independent 2025-era initialize flows in a row both succeed", async () => {
    const body = readFileSync(skillPath, "utf8");
    for (let i = 0; i < 2; i++) {
      const { tools, fetched } = await legacyClientRun();
      expect(tools.map((t) => t.name).sort()).toEqual(["fetch_skill", "resolve_skill"]);
      expect(fetched.isError).toBeFalsy();
      expect((fetched.content as { text: string }[])[0]!.text).toBe(body);
    }
  });

  test("two concurrent 2026-07-28 clients both succeed", async () => {
    const runs = await Promise.all([modernClientRun(100), modernClientRun(200)]);
    for (const { list, call } of runs) {
      expect(list.result.tools).toHaveLength(2);
      expect(call.result.content[0].text).toBe(readFileSync(skillPath, "utf8"));
    }
  });

  test("concurrent clients of both eras succeed", async () => {
    const [legacy, modern] = await Promise.all([legacyClientRun(), modernClientRun(300)]);
    expect(legacy.fetched.isError).toBeFalsy();
    expect(modern.call.result.isError).toBeFalsy();
  });

  test("legacy session GET is answered 405: HTTP serving is stateless", async () => {
    const res = await fetch(url, { method: "GET", headers: { accept: "text/event-stream", ...auth } });
    expect(res.status).toBe(405);
  });

  test("CORS preflight advertises only the methods the endpoint accepts", async () => {
    const res = await fetch(url, {
      method: "OPTIONS",
      headers: { "access-control-request-method": "POST" },
    });
    expect(res.headers.get("access-control-allow-methods")).toBe("POST, OPTIONS");
  });

  test("an unknown Mcp-Name is counted as unknown, not under the header value", async () => {
    const metricsUrl = url.replace(/\/mcp$/, "/metrics");
    const unknownCount = async () => {
      const text = await (await fetch(metricsUrl)).text();
      return { text, count: Number(text.match(/requests_total\{method="unknown"\} (\d+)/)?.[1] ?? 0) };
    };
    const before = await unknownCount();
    const res = await postModern(
      url,
      modernRequest(400, "tools/call", { name: "fetch_skill", arguments: { skill_id: "wire-skill" } }),
      { ...auth, "mcp-name": "bogus-label-xyz" },
    );
    expect(res.status).toBe(400);
    const after = await unknownCount();
    expect(after.text).not.toContain("bogus-label-xyz");
    expect(after.count).toBe(before.count + 1);
  });
});

describe("HTTP auth applies to both eras", () => {
  test("a modern request without the bearer token is rejected with 401", async () => {
    const res = await postModern(url, modernRequest(1, "server/discover"));
    expect(res.status).toBe(401);
  });

  test("a legacy initialize without the bearer token is rejected with 401", async () => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify(legacyInitialize(1)),
    });
    expect(res.status).toBe(401);
  });
});
