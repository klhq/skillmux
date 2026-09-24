import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderConfigAgents, rollbackConfigAgents, writeConfigAgents } from "../src/agents-config";

describe("renderConfigAgents", () => {
  test("inserts agents as a top-level key before the first table, keeping comments", () => {
    const text = [
      "# my machine",
      'vault_path = "~/skills"',
      "",
      "# inference lives below",
      "[inference]",
      'mode = "remote"',
      "",
    ].join("\n");

    expect(renderConfigAgents(text, ["claude-code", "codex"])).toBe(
      [
        "# my machine",
        'vault_path = "~/skills"',
        'agents = ["claude-code", "codex"]',
        "",
        "# inference lives below",
        "[inference]",
        'mode = "remote"',
        "",
      ].join("\n"),
    );
  });

  test("replaces an existing single-line or multi-line agents value in place", () => {
    expect(renderConfigAgents('agents = ["codex"] # mine\nvault_path = "x"\n', ["opencode"])).toBe(
      'agents = ["opencode"]\nvault_path = "x"\n',
    );
    expect(
      renderConfigAgents('vault_path = "x"\nagents = [\n  "codex",\n  "goose",\n]\n\n[output]\ntop_k = 5\n', []),
    ).toBe('vault_path = "x"\nagents = []\n\n[output]\ntop_k = 5\n');
  });

  test("never touches an agents key that lives inside a table", () => {
    const next = renderConfigAgents('vault_path = "x"\n\n[other]\nagents = "unrelated"\n', ["codex"]);
    expect(Bun.TOML.parse(next)).toEqual({
      vault_path: "x",
      agents: ["codex"],
      other: { agents: "unrelated" },
    });
  });

  test("handles a file with no top-level keys, or no content at all", () => {
    expect(renderConfigAgents("[output]\ntop_k = 5\n", ["codex"])).toBe(
      'agents = ["codex"]\n\n[output]\ntop_k = 5\n',
    );
    expect(renderConfigAgents("", ["codex"])).toBe('agents = ["codex"]\n');
  });
});

describe("writeConfigAgents", () => {
  test("writes atomically, keeps the file mode, is a no-op when unchanged, and rolls back", () => {
    const dir = mkdtempSync(join(tmpdir(), "skillmux-agents-config-"));
    const path = join(dir, "config.toml");
    const original = '# keep me\nvault_path = "~/skills"\n';
    writeFileSync(path, original, { mode: 0o600 });

    const write = writeConfigAgents(path, ["hermes"]);
    expect(write.changed).toBe(true);
    expect(readFileSync(path, "utf8")).toBe('# keep me\nvault_path = "~/skills"\nagents = ["hermes"]\n');
    expect(statSync(path).mode & 0o777).toBe(0o600);

    expect(writeConfigAgents(path, ["hermes"]).changed).toBe(false);

    rollbackConfigAgents(write);
    expect(readFileSync(path, "utf8")).toBe(original);

    rmSync(dir, { recursive: true, force: true });
  });
});
