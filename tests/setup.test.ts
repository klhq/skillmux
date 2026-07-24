import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectVault } from "../src/setup";

describe("inspectVault", () => {
  test("reports a missing vault with an actionable diagnostic", () => {
    const path = `/tmp/skillmux-missing-vault-${crypto.randomUUID()}`;

    expect(inspectVault(path)).toEqual({
      path,
      state: "missing",
      ok: false,
      skillCount: 0,
      message: `vault does not exist: ${path}`,
    });
  });

  test("distinguishes a dangling vault symlink from an ordinary missing path", () => {
    const root = mkdtempSync(join(tmpdir(), "skillmux-setup-vault-"));
    const path = join(root, "vault");
    symlinkSync(join(root, "absent"), path);

    expect(inspectVault(path)).toEqual({
      path,
      state: "broken-symlink",
      ok: false,
      skillCount: 0,
      message: `vault is a dangling symlink: ${path}`,
    });

    rmSync(root, { recursive: true, force: true });
  });

  test("rejects a vault path that resolves to a non-directory", () => {
    const root = mkdtempSync(join(tmpdir(), "skillmux-setup-vault-"));
    const path = join(root, "vault");
    writeFileSync(path, "not a directory");

    expect(inspectVault(path)).toEqual({
      path,
      state: "not-directory",
      ok: false,
      skillCount: 0,
      message: `vault is not a directory: ${path}`,
    });

    rmSync(root, { recursive: true, force: true });
  });

  test("reports an existing directory with no skills as unexpectedly empty", () => {
    const path = mkdtempSync(join(tmpdir(), "skillmux-setup-empty-vault-"));
    mkdirSync(join(path, ".git"));

    expect(inspectVault(path)).toEqual({
      path,
      state: "empty",
      ok: false,
      skillCount: 0,
      message: `vault contains no skill directories: ${path}`,
    });

    rmSync(path, { recursive: true, force: true });
  });

  test("reports a populated skill vault as ready", () => {
    const path = mkdtempSync(join(tmpdir(), "skillmux-setup-ready-vault-"));
    const skillDir = join(path, "writing-clearly");
    mkdirSync(skillDir);
    writeFileSync(join(skillDir, "SKILL.md"), "---\nname: Writing Clearly\n---\n");

    expect(inspectVault(path)).toEqual({
      path,
      state: "ready",
      ok: true,
      skillCount: 1,
      message: `vault ready: ${path} (1 skill)`,
    });

    rmSync(path, { recursive: true, force: true });
  });
});
