import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DISCOVERY_PARAGRAPH } from "../src/init";
import {
  applyInstructionPlan,
  planInstructionSetup,
} from "../src/init-instructions";

describe("init instruction adapters", () => {
  test("uses safe durable files and never selects Hermes identity or engineering context", () => {
    const plan = planInstructionSetup(
      ["claude-code", "codex", "gemini-cli", "antigravity", "goose", "hermes"],
      {
        home: "/home/tester",
        codexHome: "/srv/codex",
        readFile: () => null,
      },
    );

    expect(plan.changes.map((change) => change.path)).toEqual([
      "/home/tester/.claude/CLAUDE.md",
      "/srv/codex/AGENTS.md",
      "/home/tester/.gemini/GEMINI.md",
      "/home/tester/.config/goose/.goosehints",
      "/home/tester/.hermes.md",
    ]);
    expect(plan.changes.find((change) => change.path.endsWith("GEMINI.md"))?.clients)
      .toEqual(["gemini-cli", "antigravity"]);
    expect(plan.changes.some((change) => /SOUL\.md$/.test(change.path))).toBe(false);
    expect(plan.changes.some((change) => /\/AGENTS\.md$/.test(change.path) && change.path !== "/srv/codex/AGENTS.md"))
      .toBe(false);
  });

  test("preserves existing content and applies one idempotent managed block", () => {
    const root = mkdtempSync(join(tmpdir(), "skillmux-instructions-"));
    const instructionPath = join(root, ".claude", "CLAUDE.md");
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(instructionPath, "# My instructions\n\nKeep this.\n");

    const firstPlan = planInstructionSetup(["claude-code"], { home: root });
    expect(firstPlan.changes[0]?.status).toBe("update");
    applyInstructionPlan(firstPlan);

    const written = readFileSync(instructionPath, "utf8");
    expect(written).toContain("# My instructions\n\nKeep this.");
    expect(written).toContain(DISCOVERY_PARAGRAPH);

    const secondPlan = planInstructionSetup(["claude-code"], { home: root });
    expect(secondPlan.changes[0]?.status).toBe("unchanged");
    applyInstructionPlan(secondPlan);
    expect(readFileSync(instructionPath, "utf8")).toBe(written);

    rmSync(root, { recursive: true, force: true });
  });

  test("refuses to follow an instruction-file symlink", () => {
    const root = mkdtempSync(join(tmpdir(), "skillmux-instructions-symlink-"));
    const external = join(root, "external.md");
    const instructionPath = join(root, ".hermes.md");
    writeFileSync(external, "do not touch\n");
    symlinkSync(external, instructionPath);

    expect(() => planInstructionSetup(["hermes"], { home: root }))
      .toThrow(`instruction file is a symbolic link and will not be modified: ${instructionPath}`);
    expect(readFileSync(external, "utf8")).toBe("do not touch\n");

    rmSync(root, { recursive: true, force: true });
  });

  test("fails before writing when an instruction file changed after planning", () => {
    const root = mkdtempSync(join(tmpdir(), "skillmux-instructions-race-"));
    const instructionPath = join(root, ".claude", "CLAUDE.md");
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(instructionPath, "before planning\n");
    const plan = planInstructionSetup(["claude-code"], { home: root });
    writeFileSync(instructionPath, "changed concurrently\n");

    expect(() => applyInstructionPlan(plan))
      .toThrow(`instruction file changed after planning: ${instructionPath}`);
    expect(readFileSync(instructionPath, "utf8")).toBe("changed concurrently\n");

    rmSync(root, { recursive: true, force: true });
  });
});
