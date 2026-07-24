import { describe, expect, it } from "bun:test";
import { formatJsonEnvelope, mapExitCode, suggestCorrection } from "../src/output";
import { generateCompletions } from "../src/completions";

describe("Output Formatting, Exit Codes, and Discoverability (AC11, AC12)", () => {
  it("formats standard JSON envelope with schema_version 1 (AC12)", () => {
    const successEnv = formatJsonEnvelope({
      ok: true,
      target: "local",
      data: { key: "value" },
    });
    expect(successEnv.schema_version).toBe(1);
    expect(successEnv.ok).toBe(true);
    expect(successEnv.target).toBe("local");
    expect(successEnv.data).toEqual({ key: "value" });
    expect(successEnv.error).toBeNull();

    const errEnv = formatJsonEnvelope({
      ok: false,
      target: { name: "prod", server: "https://prod:8080" },
      error: { code: "CONFIG_REVISION_CONFLICT", message: "Conflict" },
    });
    expect(errEnv.schema_version).toBe(1);
    expect(errEnv.ok).toBe(false);
    expect(errEnv.error?.code).toBe("CONFIG_REVISION_CONFLICT");
  });

  it("maps error types to exact specified exit codes (AC12)", () => {
    expect(mapExitCode(new Error("usage error"))).toBe(2);
    expect(mapExitCode(new Error("Validation error"))).toBe(2);

    expect(mapExitCode(new Error("Unauthorized"))).toBe(3);
    expect(mapExitCode(new Error("Failed to reach remote server"))).toBe(3);

    expect(mapExitCode(new Error("Revision conflict"))).toBe(4);
    expect(mapExitCode(new Error("Configuration is externally managed"))).toBe(4);
  });

  it("suggests corrections for mistyped commands (AC12)", () => {
    const known = ["context", "config", "calibrate", "serve", "index", "sync", "scan"];
    expect(suggestCorrection("conifg", known)).toBe("config");
    expect(suggestCorrection("cntxt", known)).toBe("context");
    expect(suggestCorrection("completely_unknown_command", known)).toBeNull();
  });

  it("generates completions for bash, zsh, and fish (AC12)", () => {
    const bash = generateCompletions("bash");
    expect(bash).toContain("skillmux");
    expect(bash).toContain("context");
    expect(bash).toContain("config");
    expect(bash).toContain("--client");
    expect(bash).toContain("claude-code");
    expect(bash).toContain("skillmux-mcp");
    expect(bash).toContain("--migrate-full-vault");

    const zsh = generateCompletions("zsh");
    expect(zsh).toContain("#compdef skillmux");
    expect(zsh).toContain("--client");

    const fish = generateCompletions("fish");
    expect(fish).toContain("complete -c skillmux");
    expect(fish).toContain("-l client");
  });
});
