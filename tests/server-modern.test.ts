import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import packageJson from "../package.json" with { type: "json" };
import {
  LEGACY_VERSION,
  MODERN_VERSION,
  StdioWire,
  UNSUPPORTED_PROTOCOL_VERSION,
  legacyInitialize,
  modernRequest,
  writeFixture,
} from "./helpers/mcp-wire";

// MCP 2026-07-28 over stdio, driven at the wire level the way Claude Code
// does it: a `server/discover` probe and per-request `_meta` envelopes, no
// `initialize`. tests/server.test.ts stays the 2025-era regression suite.
const tmp = mkdtempSync(join(tmpdir(), "skillmux-modern-"));
const { configPath, skillPath } = writeFixture(tmp);
const SERVER_INFO = "io.modelcontextprotocol/serverInfo";

const wires: StdioWire[] = [];
function connect(): StdioWire {
  const wire = new StdioWire(configPath);
  wires.push(wire);
  return wire;
}

afterAll(async () => {
  await Promise.all(wires.map((w) => w.close()));
  rmSync(tmp, { recursive: true, force: true });
});

describe("MCP 2026-07-28 over stdio", () => {
  let wire: StdioWire;
  beforeAll(() => {
    wire = connect();
  });

  test("server/discover advertises 2026-07-28, tools, and serverInfo", async () => {
    const res = await wire.request(modernRequest(1, "server/discover"));

    expect(res.error).toBeUndefined();
    expect(res.result.supportedVersions).toContain(MODERN_VERSION);
    expect(res.result.capabilities.tools).toBeDefined();
    // The tool set is fixed for the life of the process.
    expect(res.result.capabilities.tools.listChanged).toBeFalsy();
    expect(res.result.resultType).toBe("complete");
    expect(res.result._meta[SERVER_INFO].name).toBe("skillmux");
    expect(res.result._meta[SERVER_INFO].version).toBe(packageJson.version);
  });

  test("tools/list without initialize carries resultType and cache hints", async () => {
    const res = await wire.request(modernRequest(2, "tools/list"));

    expect(res.error).toBeUndefined();
    expect(res.result.resultType).toBe("complete");
    expect(typeof res.result.ttlMs).toBe("number");
    expect(res.result.ttlMs).toBeGreaterThan(0);
    expect(["public", "private"]).toContain(res.result.cacheScope);
    expect(res.result.tools.map((t: { name: string }) => t.name).sort()).toEqual([
      "fetch_skill",
      "resolve_skill",
    ]);
    expect(res.result._meta[SERVER_INFO].name).toBe("skillmux");
  });

  test("tools/call fetch_skill returns the SKILL.md body byte-identical to the vault file", async () => {
    const res = await wire.request(
      modernRequest(3, "tools/call", { name: "fetch_skill", arguments: { skill_id: "wire-skill" } }),
    );

    expect(res.error).toBeUndefined();
    expect(res.result.resultType).toBe("complete");
    expect(res.result.isError).toBeFalsy();
    expect(res.result).not.toHaveProperty("structuredContent");
    const texts = res.result.content.filter((c: { type: string }) => c.type === "text");
    expect(texts).toHaveLength(2);
    expect(texts[0].text).toBe(readFileSync(skillPath, "utf8"));
    expect(JSON.parse(texts[1].text).skill_id).toBe("wire-skill");
  });

  test("tools/call resolve_skill ranks the matching skill first", async () => {
    const res = await wire.request(
      modernRequest(4, "tools/call", {
        name: "resolve_skill",
        arguments: { query: "wire protocol questions" },
      }),
    );

    expect(res.error).toBeUndefined();
    expect(res.result.resultType).toBe("complete");
    expect(res.result.structuredContent.candidates[0].skill_id).toBe("wire-skill");
  });

  test("fetch_skill with an unknown skill_id stays a tool execution error", async () => {
    const res = await wire.request(
      modernRequest(5, "tools/call", { name: "fetch_skill", arguments: { skill_id: "does-not-exist" } }),
    );

    expect(res.error).toBeUndefined();
    expect(res.result.isError).toBe(true);
    expect(JSON.stringify(res.result.content)).toContain("SKILL_NOT_FOUND");
  });

  test("fetch_skill refuses a parent_fetch_id without an attachment path", async () => {
    const res = await wire.request(modernRequest(6, "tools/call", {
      name: "fetch_skill", arguments: { skill_id: "wire-skill", parent_fetch_id: 1 },
    }));
    expect(Boolean(res.error) || res.result?.isError === true).toBe(true);
    expect(JSON.stringify(res)).toContain("path");
  });

  test("fetch_skill delivers a supporting file over stdio and rejects traversal as a tool error", async () => {
    const dir = join(tmp, "vault", "wire-skill", "references");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "stdio.md"), "stdio reference\n");
    const res = await wire.request(modernRequest(7, "tools/call", {
      name: "fetch_skill", arguments: { skill_id: "wire-skill", path: "references/stdio.md" },
    }));
    expect(res.result.isError).toBeFalsy();
    expect(res.result).not.toHaveProperty("structuredContent");
    expect(res.result.content).toHaveLength(2);
    expect(res.result.content[0].text).toBe("stdio reference\n");
    expect(JSON.parse(res.result.content[1].text)).toMatchObject({ path: "references/stdio.md", parent_fetch_id: null });

    const invalid = await wire.request(modernRequest(8, "tools/call", {
      name: "fetch_skill", arguments: { skill_id: "wire-skill", path: "../config.toml" },
    }));
    expect(invalid.result.isError).toBe(true);
    expect(JSON.stringify(invalid.result.content)).toContain("INVALID_FILE_PATH:");
  });
});

describe("protocol era pinning over stdio", () => {
  test("a connection opened with initialize 2025-11-25 stays legacy and keeps working", async () => {
    const wire = connect();
    const init = await wire.request(legacyInitialize(1));
    expect(init.result.protocolVersion).toBe(LEGACY_VERSION);
    expect(init.result.serverInfo.name).toBe("skillmux");
    expect(init.result.serverInfo.version).toBe(packageJson.version);
    wire.send({ jsonrpc: "2.0", method: "notifications/initialized" });

    const before = await wire.request({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    expect(before.result.tools).toHaveLength(2);
    // 2025-era results carry no 2026 envelope fields.
    expect(before.result).not.toHaveProperty("resultType");
    expect(before.result).not.toHaveProperty("ttlMs");

    // A modern-only request on a legacy-pinned connection must not break it.
    await wire.request(modernRequest(3, "server/discover"));

    const after = await wire.request({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "fetch_skill", arguments: { skill_id: "wire-skill" } },
    });
    expect(after.error).toBeUndefined();
    expect(after.result.content[0].text).toBe(readFileSync(skillPath, "utf8"));
  });

  test("a request at an unknown future protocol version gets -32022", async () => {
    const wire = connect();
    const res = await wire.request(modernRequest(1, "server/discover", {}, "2099-01-01"));

    expect(res.result).toBeUndefined();
    expect(res.error.code).toBe(UNSUPPORTED_PROTOCOL_VERSION);
  });
});
