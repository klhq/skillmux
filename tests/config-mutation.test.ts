import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { patchToml, patchTomlFile, removeSectionBlock } from "../src/config-mutation";

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("config-mutation (TOML patching)", () => {
  test("removes target section block while preserving preceding and following sections", () => {
    const input = `
# Header comment
vault_path = "~/skills"

[inference]
mode = "local"

[inference.thresholds]
match_score = 0.8
match_margin = 0.2

[recall]
k_lexical = 20
`.trim();

    const output = removeSectionBlock(input, "[inference.thresholds]");
    expect(output).toContain('vault_path = "~/skills"');
    expect(output).toContain('mode = "local"');
    expect(output).toContain("k_lexical = 20");
    expect(output).not.toContain("[inference.thresholds]");
    expect(output).not.toContain("match_score = 0.8");
  });

  test("patches missing threshold and calibration sections", () => {
    const input = `
vault_path = "~/skills"

[inference]
mode = "local"
`.trim();

    const patched = patchToml(input, {
      matchScore: 0.95,
      matchMargin: 0.15,
      candidateFloor: 0.5,
      runId: "run_abc123",
    });

    expect(patched).toContain("[inference.thresholds]\nmatch_score = 0.95\nmatch_margin = 0.15\ncandidate_floor = 0.5");
    expect(patched).toContain('[inference.calibration]\nrun_id = "run_abc123"');
    expect(patched).toContain('vault_path = "~/skills"');
  });

  test("replaces existing adjacent or repeated sections surgically", () => {
    const input = `
[inference.thresholds]
match_score = 0.5
match_margin = 0.1
candidate_floor = 0.2

[inference.calibration]
run_id = "run_old"

[recall]
k_lexical = 10
`.trim();

    const patched = patchToml(input, {
      matchScore: 0.85,
      matchMargin: 0.25,
      candidateFloor: 0.45,
      runId: "run_new",
    });

    expect(patched).toContain("match_score = 0.85");
    expect(patched).toContain('run_id = "run_new"');
    expect(patched).not.toContain("run_old");
    expect(patched).toContain("k_lexical = 10");
  });

  test("patchTomlFile performs atomic write using temp file rename", async () => {
    const root = mkdtempSync(join(tmpdir(), "skillmux-config-mutation-"));
    dirs.push(root);
    const tomlPath = join(root, "config.toml");
    writeFileSync(tomlPath, 'vault_path = "~/skills"\n');

    await patchTomlFile(tomlPath, {
      matchScore: 0.9,
      matchMargin: 0.2,
      candidateFloor: 0.4,
      runId: "run_atomic_test",
    });

    const content = readFileSync(tomlPath, "utf-8");
    expect(content).toContain('run_id = "run_atomic_test"');
    expect(content).toContain("match_score = 0.9");
  });
});
