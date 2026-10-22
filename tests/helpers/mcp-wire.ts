import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";

/**
 * Raw JSON-RPC helpers for driving `skillmux serve` at the wire level, the way
 * a 2026-07-28 client (Claude Code) does: no SDK client, no `initialize`.
 */

export const MODERN_VERSION = "2026-07-28";
export const LEGACY_VERSION = "2025-11-25";
export const UNSUPPORTED_PROTOCOL_VERSION = -32022;

/** The per-request `_meta` envelope every 2026-07-28 request carries. */
export function envelope(version = MODERN_VERSION): Record<string, unknown> {
  return {
    "io.modelcontextprotocol/protocolVersion": version,
    "io.modelcontextprotocol/clientCapabilities": {},
    "io.modelcontextprotocol/clientInfo": { name: "skillmux-wire-test", version: "0.0.0" },
  };
}

export function modernRequest(
  id: number,
  method: string,
  params: Record<string, unknown> = {},
  version = MODERN_VERSION,
) {
  return { jsonrpc: "2.0", id, method, params: { ...params, _meta: envelope(version) } };
}

export function legacyInitialize(id: number) {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: LEGACY_VERSION,
      capabilities: {},
      clientInfo: { name: "skillmux-wire-test", version: "0.0.0" },
    },
  };
}

/** Writes a two-skill vault plus an offline (dead-endpoint) config, as server.test.ts does. */
export function writeFixture(tmp: string, extraConfig: string[] = []) {
  const vaultDir = join(tmp, "vault");
  const configPath = join(tmp, "config.toml");
  const skillPath = join(vaultDir, "wire-skill", "SKILL.md");
  for (const [id, description] of [
    ["wire-skill", "Answers wire protocol questions."],
    ["other-skill", "Another indexed skill for listing."],
  ] as const) {
    mkdirSync(join(vaultDir, id), { recursive: true });
    writeFileSync(
      join(vaultDir, id, "SKILL.md"),
      `---\nname: ${id}\ndescription: ${description}\n---\n\n# ${id}\n\nBody of ${id}.\n`,
    );
  }
  writeFileSync(
    configPath,
    [
      `vault_path = "${vaultDir}"`,
      `state_dir = "${join(tmp, "state")}"`,
      `[recall]`,
      `k_lexical = 50`,
      `k_vector = 50`,
      `k_rerank = 50`,
      ``,
      `[output]`,
      `top_k = 10`,
      `max_top_k = 50`,
      ``,
      `[inference]`,
      `mode = "remote"`,
      `timeout_ms = 200`,
      ``,
      `[inference.embedding]`,
      `provider = "openai"`,
      `endpoint = "http://127.0.0.1:9/v1/embeddings"`,
      `model = "microsoft/harrier-oss-v1-0.6b"`,
      `dimension = 1024`,
      ``,
      `[inference.reranker]`,
      `adapter = "jina-v1"`,
      `endpoint = "http://127.0.0.1:9/rerank"`,
      `model = "BAAI/bge-reranker-v2-m3"`,
      ``,
      ...extraConfig,
    ].join("\n"),
  );
  return { vaultDir, configPath, skillPath };
}

/**
 * The command that runs `skillmux serve`. Defaults to the TypeScript source;
 * set SKILLMUX_TEST_BIN to a compiled binary (`bun run build` output) to run
 * the same wire tests against it.
 */
export function serveCommand(...args: string[]): string[] {
  const bin = process.env.SKILLMUX_TEST_BIN;
  return bin
    ? [bin, "serve", ...args]
    : ["bun", "run", join(import.meta.dir, "..", "..", "src", "cli.ts"), "serve", ...args];
}

/** One stdio connection to a spawned `skillmux serve`, matched by JSON-RPC id. */
export class StdioWire {
  private proc: Subprocess<"pipe", "pipe", "pipe">;
  private pending = new Map<number | string, { resolve: (msg: any) => void; reject: (err: Error) => void }>();
  private buffered = "";
  private stderr = "";

  constructor(configPath: string) {
    this.proc = Bun.spawn(serveCommand(), {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, SKILLMUX_CONFIG: configPath },
    });
    void this.readLoop();
    void new Response(this.proc.stderr).text().then((text) => (this.stderr = text));
    void this.proc.exited.then(async (code) => {
      await Bun.sleep(50);
      for (const { reject } of this.pending.values()) {
        reject(new Error(`skillmux serve exited (${code}) before answering:\n${this.stderr}`));
      }
      this.pending.clear();
    });
  }

  private async readLoop() {
    const decoder = new TextDecoder();
    for await (const chunk of this.proc.stdout) {
      this.buffered += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = this.buffered.indexOf("\n")) >= 0) {
        const line = this.buffered.slice(0, nl).trim();
        this.buffered = this.buffered.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          this.pending.get(msg.id)!.resolve(msg);
          this.pending.delete(msg.id);
        }
      }
    }
  }

  send(message: Record<string, unknown>) {
    this.proc.stdin.write(JSON.stringify(message) + "\n");
    this.proc.stdin.flush();
  }

  request(message: { id: number | string } & Record<string, unknown>, timeoutMs = 4_000): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(message.id);
        reject(new Error(`no response to ${JSON.stringify(message)} within ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(message.id, {
        resolve: (msg) => {
          clearTimeout(timer);
          resolve(msg);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.send(message);
    });
  }

  async close() {
    this.proc.stdin.end();
    const exited = await Promise.race([this.proc.exited, Bun.sleep(3_000).then(() => "timeout")]);
    if (exited === "timeout") this.proc.kill();
  }
}

/** Reads a Streamable HTTP reply that is either a JSON body or an SSE stream. */
export async function readMcpResponse(res: Response): Promise<any> {
  const text = await res.text();
  if (!(res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    return JSON.parse(text);
  }
  const messages = text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean)
    .map((data) => JSON.parse(data));
  const response = messages.find((m) => "result" in m || "error" in m);
  if (!response) throw new Error(`no JSON-RPC response in SSE stream: ${text}`);
  return response;
}

/** POSTs one 2026-07-28 request with the MCP-Protocol-Version / Mcp-Method / Mcp-Name headers. */
export async function postModern(
  url: string,
  message: { method: string; params?: Record<string, unknown> } & Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Response> {
  const name = (message.params as { name?: string } | undefined)?.name;
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": MODERN_VERSION,
      "mcp-method": message.method,
      ...(name ? { "mcp-name": name } : {}),
      ...headers,
    },
    body: JSON.stringify(message),
  });
}
