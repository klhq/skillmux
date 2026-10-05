import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dryRunTag } from "../src/output";
import { ESC, python, runOnPty } from "./helpers/pty";

const SRC = new URL("../src/", import.meta.url).pathname;

async function sourceFiles(): Promise<{ path: string; text: string }[]> {
  const files: { path: string; text: string }[] = [];
  for await (const path of new Bun.Glob("**/*.ts").scan(SRC)) {
    files.push({ path, text: await Bun.file(join(SRC, path)).text() });
  }
  return files;
}

describe("one dry-run marker shape", () => {
  test("dryRunTag is plain text without a TTY", () => {
    expect(dryRunTag()).toBe("(dry-run)");
  });

  test("no source file spells the marker any other way", async () => {
    const offenders: string[] = [];
    for (const { path, text } of await sourceFiles()) {
      if (path === "output.ts") continue; // defines dryRunTag()
      const shapes: [RegExp, string][] = [
        [/\(dry-run\)/, "a literal (dry-run); use dryRunTag()"],
        [/\[dry-run\]/, "a [dry-run] prefix; use a trailing dryRunTag()"],
        [/`dry-run: /, "a leading dry-run: label; use a trailing dryRunTag()"],
      ];
      for (const [pattern, why] of shapes) {
        if (pattern.test(text)) offenders.push(`${path}: ${why}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test.skipIf(!python)("the marker is colored as an informational label on a TTY", async () => {
    const home = mkdtempSync(join(tmpdir(), "skillmux-dry-"));
    const env = { HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_STATE_HOME: join(home, ".state") };

    const prune = await runOnPty(["audit", "prune", "--dry-run"], undefined, env);
    expect(prune.tty).toContain(`admin_audit=0 ${ESC}36m(dry-run)${ESC}0m`);

    const set = await runOnPty(["config", "set", "recall.k_lexical", "30", "--dry-run"], undefined, env);
    expect(set.tty).toContain(`-> 30 ${ESC}36m(dry-run)${ESC}0m`);
  });
});
