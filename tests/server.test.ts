import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Remote endpoints point at a dead port — startup and resolve_skill must still
// work (AC7: fully offline model host).
const tmp = mkdtempSync(join(tmpdir(), "skill-router-server-"));
const vaultDir = join(tmp, "vault");
const configPath = join(tmp, "config.toml");

function writeSkill(id: string, description: string, files: Record<string, string> = {}) {
  const dir = join(vaultDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${id}\ndescription: ${description}\n---\n\n# ${id}\n\nBody of ${id}.\n`,
  );
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, content);
  }
}

let client: Client;

beforeAll(async () => {
  writeSkill("stdio-skill", "Answers stdio transport questions.", {
    "references/notes.md": "notes\n",
  });
  writeSkill("other-skill", "Another indexed skill for listing.");
  writeFileSync(
    configPath,
    [
      `vault_path = "${vaultDir}"`,
      `state_dir = "${join(tmp, "state")}"`,
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
      `[inference]`,
      `mode = "remote"`,
      `timeout_ms = 200`,
      ``,
      `[inference.embedding]`,
      `provider = "openai"`,
      `base_url = "http://127.0.0.1:9"`,
      `model = "microsoft/harrier-oss-v1-0.6b"`,
      `dimension = 1024`,
      ``,
      `[inference.reranker]`,
      `provider = "infinity"`,
      `base_url = "http://127.0.0.1:9"`,
      `model = "BAAI/bge-reranker-v2-m3"`,
      ``,
      `[inference.thresholds]`,
      `match_score = 0.9`,
      `match_margin = 0.2`,
      `candidate_floor = 0.4`,
    ].join("\n"),
  );

  const transport = new StdioClientTransport({
    command: "bun",
    args: ["run", join(import.meta.dir, "..", "src", "server.ts")],
    env: { ...(process.env as Record<string, string>), SKILL_ROUTER_CONFIG: configPath },
  });
  client = new Client({ name: "skill-router-test", version: "0.0.0" });
  await client.connect(transport);
});

afterAll(async () => {
  await client?.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("MCP stdio server", () => {
  test("exposes exactly the two contract tools", async () => {
    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name).sort()).toEqual(["fetch_skill", "resolve_skill"]);
  });

  test("fetch_skill returns metadata in structuredContent and the body exactly once as text", async () => {
    const result = await client.callTool({
      name: "fetch_skill",
      arguments: { skill_id: "stdio-skill" },
    });

    expect(result.isError).toBeFalsy();
    const meta = result.structuredContent as Record<string, unknown>;
    expect(meta.skill_id).toBe("stdio-skill");
    expect(meta.title).toBe("stdio-skill");
    expect(meta.content_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(meta.files).toEqual(["references/notes.md"]);
    expect(meta).not.toHaveProperty("body");
    const texts = (result.content as { type: string; text: string }[]).filter((c) => c.type === "text");
    expect(texts).toHaveLength(1);
    expect(texts[0]!.text).toStartWith("---\nname: stdio-skill\n");
    expect(texts[0]!.text).toEndWith("Body of stdio-skill.\n");
  });

  test("resolve_skill answers degraded with model host fully offline (AC7)", async () => {
    const result = await client.callTool({
      name: "resolve_skill",
      arguments: { query: "stdio transport questions" },
    });

    expect(result.isError).toBeFalsy();
    const payload = result.structuredContent as Record<string, unknown>;
    expect(payload.retrieval).toBe("lexical");
    expect(["ambiguous", "no_match"]).toContain(payload.outcome as string);
  });

  test("fetch_skill with unknown skill_id returns a SKILL_NOT_FOUND tool error", async () => {
    const result = await client.callTool({
      name: "fetch_skill",
      arguments: { skill_id: "does-not-exist" },
    });

    expect(result.isError).toBe(true);
    const texts = (result.content as { type: string; text: string }[]).map((c) => c.text).join(" ");
    expect(texts).toContain("SKILL_NOT_FOUND");
  });
});
