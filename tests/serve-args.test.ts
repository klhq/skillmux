import { describe, expect, test } from "bun:test";
import { applyServeOverrides, parseServeArgs, verifyServeOverrides } from "../src/serve-args";

describe("parseServeArgs", () => {
  test("keeps the existing flags and defaults to stdio", () => {
    expect(parseServeArgs([])).toEqual({ transport: "stdio", overrides: {} });
    expect(parseServeArgs(["--transport", "http", "--port", "0", "--stats-port", "9"])).toEqual({
      transport: "http",
      port: 0,
      statsPort: 9,
      overrides: {},
    });
  });

  test("reads --vault, --state-dir and --host", () => {
    const parsed = parseServeArgs(["--vault", "/srv/skills", "--state-dir", "/var/lib/skillmux", "--host", "0.0.0.0"]);
    expect(parsed.overrides).toEqual({ vault: "/srv/skills", stateDir: "/var/lib/skillmux", host: "0.0.0.0" });
  });

  test("keeps ~ so config can expand it, and makes other relative paths absolute", () => {
    const parsed = parseServeArgs(["--vault", "~/skills", "--state-dir", "state"]);
    expect(parsed.overrides.vault).toBe("~/skills");
    expect(parsed.overrides.stateDir).toBe(`${process.cwd()}/state`);
  });

  test("rejects a flag with no value or an empty value", () => {
    for (const flag of ["--vault", "--state-dir", "--host"]) {
      expect(() => parseServeArgs([flag])).toThrow(`${flag} requires a value`);
      expect(() => parseServeArgs([flag, ""])).toThrow(`${flag} requires a value`);
    }
  });

  test("rejects a flag that swallows the next flag as its value", () => {
    expect(() => parseServeArgs(["--vault", "--transport", "http"])).toThrow("--vault requires a value");
  });

  test("rejects an unknown flag", () => {
    expect(() => parseServeArgs(["--bogus"])).toThrow();
  });
});

describe("applyServeOverrides", () => {
  test("sets the environment variables loadConfig already reads", () => {
    const env: Record<string, string | undefined> = {};
    applyServeOverrides({ vault: "/v", stateDir: "/s", host: "10.0.0.5" }, env);
    expect(env).toEqual({
      SKILLMUX_VAULT_PATH: "/v",
      SKILLMUX_STATE_DIR: "/s",
      SKILLMUX_HTTP_HOSTNAME: "10.0.0.5",
    });
  });

  test("leaves the environment alone when nothing was passed", () => {
    const env: Record<string, string | undefined> = { SKILLMUX_VAULT_PATH: "/keep" };
    applyServeOverrides({}, env);
    expect(env).toEqual({ SKILLMUX_VAULT_PATH: "/keep" });
  });
});

describe("verifyServeOverrides", () => {
  const config = { vault_path: "/v", state_dir: "/s", server: { hostname: "0.0.0.0" } };

  test("accepts a config that took every override", () => {
    expect(() => verifyServeOverrides({ vault: "/v", stateDir: "/s", host: "0.0.0.0" }, config as never)).not.toThrow();
  });

  test("names the flag a config with environment_overrides = false ignored", () => {
    expect(() => verifyServeOverrides({ vault: "/other" }, config as never)).toThrow(/--vault/);
    expect(() => verifyServeOverrides({ host: "127.0.0.1" }, config as never)).toThrow(/--host/);
    expect(() => verifyServeOverrides({ stateDir: "/other" }, config as never)).toThrow(/environment_overrides/);
  });
});
