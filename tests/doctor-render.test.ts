import { describe, expect, test } from "bun:test";
import { renderChecks } from "../src/commands/doctor";
import type { DoctorCheck } from "../src/doctor";

const ok = (name: string, detail = "fine"): DoctorCheck => ({ name, ok: true, detail });
const fail = (name: string, detail = "broken"): DoctorCheck => ({ name, ok: false, detail });

describe("doctor check rendering", () => {
  test("collapses config_source checks into one count by source", () => {
    const lines = renderChecks(
      [
        ok("config_source:a", "toml"),
        ok("config_source:b", "default"),
        ok("config_source:c", "toml"),
        ok("config_source:d", "environment"),
        ok("vault", "/v"),
      ],
      false,
    );
    expect(lines).toEqual([
      "ok: vault - /v",
      "ok: config sources - 4 keys (environment: 1, toml: 2, default: 1); --verbose lists each",
      "5 checks passed",
    ]);
  });

  test("--verbose lists every check and no collapsed line", () => {
    const lines = renderChecks([ok("config_source:a", "toml"), ok("vault")], true);
    expect(lines).toEqual(["ok: config_source:a - toml", "ok: vault - fine", "2 checks passed"]);
  });

  test("failures print before passing checks and are tallied", () => {
    const lines = renderChecks([ok("vault"), fail("manifest"), ok("state"), fail("embedding")], false);
    expect(lines).toEqual([
      "fail: manifest - broken",
      "fail: embedding - broken",
      "ok: vault - fine",
      "ok: state - fine",
      "2 of 4 checks failed",
    ]);
  });

  test("a failing config_source check is never collapsed away", () => {
    const lines = renderChecks([fail("config_source:a", "invalid"), ok("config_source:b", "toml")], false);
    expect(lines[0]).toBe("fail: config_source:a - invalid");
    expect(lines).toContain("ok: config sources - 1 key (toml: 1); --verbose lists each");
    expect(lines.at(-1)).toBe("1 of 2 checks failed");
  });

  test("counts an unrecognized source after the known ones", () => {
    const [line] = renderChecks([ok("config_source:a", "other"), ok("config_source:b", "toml")], false);
    expect(line).toContain("(toml: 1, other: 1)");
  });

  test("with no checks it reports zero passed and no collapsed line", () => {
    expect(renderChecks([], false)).toEqual(["0 checks passed"]);
  });
});
