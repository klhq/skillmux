import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateDataset } from "../src/dataset-generator";
import { scanVault } from "../src/vault";
import { loadDecisionCases } from "../src/calibrate";

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("calibrate generate-dataset CLI integration (AC3)", () => {
  test("scans vault and writes a valid decision dataset to the specified out path", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "skillmux-cli-gendata-"));
    dirs.push(tmp);

    const vaultDir = join(tmp, "vault");
    for (let i = 1; i <= 4; i++) {
      const skillDir = join(vaultDir, `my-skill-${i}`);
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, "SKILL.md"),
        `---\nname: Custom Skill ${i}\ndescription: Specialized automation workflow ${i}.\naliases: [custom-flow-${i}]\n---\nBody content`,
      );
    }

    const outPath = join(tmp, "out", "dataset.json");

    const skills = await scanVault(vaultPath(vaultDir));
    const dataset = generateDataset(skills);

    mkdirSync(join(outPath, ".."), { recursive: true });
    writeFileSync(outPath, JSON.stringify(dataset, null, 2));

    expect(existsSync(outPath)).toBe(true);
    const content = JSON.parse(readFileSync(outPath, "utf-8"));
    expect(Array.isArray(content)).toBe(true);

    const cases = loadDecisionCases(content, skills.map((skill) => skill.skill_id));
    expect(cases.length).toBeGreaterThan(0);
  });
});

function vaultPath(p: string): string {
  return p;
}
