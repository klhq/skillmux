import { describe, expect, it } from "bun:test";
import { CliError, emitSuccess, formatJsonEnvelope, isInteractive, mapExitCode, suggestCorrection } from "../src/output";
import { generateCompletions } from "../src/completions";

describe("Output Formatting, Exit Codes, and Discoverability (AC11, AC12)", () => {
  it("keeps prompts interactive when NO_COLOR is set", () => {
    expect(isInteractive({ TERM: "xterm-256color", NO_COLOR: "1" }, true)).toBe(true);
  });

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

    expect(mapExitCode(new CliError("Unauthorized", 3))).toBe(3);
    expect(mapExitCode(new CliError("Failed to reach remote server", 3))).toBe(3);

    expect(mapExitCode(new CliError("Revision conflict", 4))).toBe(4);
    expect(mapExitCode(new CliError("Configuration is externally managed", 4))).toBe(4);
  });

  it("maps a CliError to its own exitCode regardless of message content", () => {
    expect(mapExitCode(new CliError("some message", 4))).toBe(4);
    expect(mapExitCode(new CliError("some message", 3))).toBe(3);
  });

  it("does not misclassify an untagged Error as a conflict just because its message contains the word 'conflict'", () => {
    expect(mapExitCode(new Error('skill "foo" already pinned in [project.conflict-resolution]'))).toBe(2);
  });

  it("emitSuccess prints a schema-versioned JSON envelope when isJson is true, and defers to the text renderer otherwise", () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg: string) => {
      logs.push(msg);
    };
    try {
      emitSuccess({ isJson: true }, { foo: "bar" }, () => console.log("plain text"));
      emitSuccess({ isJson: false }, { foo: "bar" }, () => console.log("plain text"));
    } finally {
      console.log = originalLog;
    }

    expect(JSON.parse(logs[0]!)).toEqual({
      schema_version: 1,
      ok: true,
      target: "local",
      data: { foo: "bar" },
      error: null,
    });
    expect(logs[1]).toBe("plain text");
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
    expect(bash).toContain("core");
    expect(bash).not.toContain("manifest");

    const zsh = generateCompletions("zsh");
    expect(zsh).toContain("#compdef skillmux");
    expect(zsh).toContain("--client");

    const fish = generateCompletions("fish");
    expect(fish).toContain("complete -c skillmux");
    expect(fish).toContain("-l client");
  });
});
