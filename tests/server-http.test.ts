import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server";
import { configure } from "../src/router-core";
import { loadConfig } from "../src/config";

const tmp = mkdtempSync(join(tmpdir(), "skill-router-http-"));
const vaultDir = join(tmp, "vault");
const configPath = join(tmp, "config.toml");
let port: number;

function writeSkill(id: string, description: string) {
  const dir = join(vaultDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${id}\ndescription: ${description}\n---\n\n# ${id}\n\nBody of ${id}.\n`,
  );
}

beforeAll(async () => {
  writeSkill("http-test-skill", "Matches http transport queries.");
  writeFileSync(
    configPath,
    [
      `vault_path = "${vaultDir}"`,
      `state_dir = "${join(tmp, "state")}"`,
      `remote_timeout_ms = 200`,
      ``,
      `[recall]`,
      `k_lexical = 15`,
      `k_vector = 15`,
      ``,
      `[thresholds]`,
      `match_score = 0.9`,
      `match_margin = 0.2`,
      `candidate_floor = 0.4`,
      `candidate_limit = 5`,
      ``,
      `[embedding]`,
      `base_url = "http://127.0.0.1:9"`,
      `api_key_env = "SKILL_ROUTER_EMBED_KEY"`,
      `model = "microsoft/harrier-oss-v1-0.6b"`,
      `dimension = 1024`,
      ``,
      `[rerank]`,
      `base_url = "http://127.0.0.1:9"`,
      `model = "BAAI/bge-reranker-v2-m3"`,
    ].join("\n"),
  );

  // Set config path override
  process.env.SKILL_ROUTER_CONFIG = configPath;
  
  // Start server on a random port (0)
  const origServe = Bun.serve;
  let capturedPort = 0;
  // Mock Bun.serve to capture the server port
  const mockServe = (options: any) => {
    const s = origServe(options);
    capturedPort = s.port;
    return s;
  };
  // @ts-ignore
  Bun.serve = mockServe;

  await startServer({ transport: "http", port: 0 });
  port = capturedPort;
  
  // Restore original Bun.serve
  // @ts-ignore
  Bun.serve = origServe;
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function parseSSEResponse(text: string): any {
  const match = text.match(/data:\s*({.*})/);
  if (!match) throw new Error(`Could not parse SSE response: ${text}`);
  return JSON.parse(match[1]);
}

describe("MCP Streamable HTTP Server (AC3)", () => {
  test("handles JSON-RPC initialization handshake over HTTP POST", async () => {
    // 1. Initial request to establish session and get session id
    const initPayload = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test-client", version: "0.0.1" },
      },
    };

    const response = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "accept": "application/json, text/event-stream",
      },
      body: JSON.stringify(initPayload),
    });

    expect(response.status).toBe(200);
    const responseText = await response.text();
    const body = parseSSEResponse(responseText);
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBe(1);
    expect(body.result.protocolVersion).toBe("2024-11-05");
    expect(body.result.serverInfo.name).toBe("skill-router");

    // Capture Session ID from response headers
    const sessionId = response.headers.get("x-session-id") || response.headers.get("x-mcp-session-id") || response.headers.get("mcp-session-id");
    
    // 2. Call listTools
    const listToolsPayload = {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    };

    const headers: Record<string, string> = {
      "content-type": "application/json",
      "accept": "application/json, text/event-stream",
    };
    if (sessionId) {
      headers["mcp-session-id"] = sessionId;
    }

    const listRes = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers,
      body: JSON.stringify(listToolsPayload),
    });

    expect(listRes.status).toBe(200);
    const listResText = await listRes.text();
    const listBody = parseSSEResponse(listResText);
    expect(listBody.jsonrpc).toBe("2.0");
    expect(listBody.id).toBe(2);
    expect(listBody.result.tools.map((t: any) => t.name).sort()).toEqual(["fetch_skill", "resolve_skill"]);
  });

  test("handles OPTIONS preflight requests for CORS compatibility", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      method: "OPTIONS",
      headers: {
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "Content-Type",
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-methods")).toContain("POST");
  });
});
