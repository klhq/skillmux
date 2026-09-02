import { describe, expect, test } from "bun:test";
import {
  COMMAND_CONTEXT_SUPPORT,
  KNOWN_COMMANDS,
  getLocalOnlyCommand,
} from "../src/cli";

describe("COMMAND_CONTEXT_SUPPORT consistency", () => {
  test("every KNOWN_COMMANDS entry has a declared context-support classification", () => {
    for (const command of KNOWN_COMMANDS) {
      expect(COMMAND_CONTEXT_SUPPORT[command]).toBeDefined();
    }
  });

  test("COMMAND_CONTEXT_SUPPORT declares no command outside KNOWN_COMMANDS", () => {
    for (const command of Object.keys(COMMAND_CONTEXT_SUPPORT)) {
      expect(KNOWN_COMMANDS).toContain(command);
    }
  });

  test("every command declared local-only is actually rejected for a remote context", () => {
    for (const [command, support] of Object.entries(COMMAND_CONTEXT_SUPPORT)) {
      if (support === "local-only") {
        expect(getLocalOnlyCommand(command, "")).not.toBeNull();
      }
    }
  });

  test("every command declared remote-capable or context-agnostic is not rejected for a remote context", () => {
    for (const [command, support] of Object.entries(COMMAND_CONTEXT_SUPPORT)) {
      if (support !== "local-only") {
        expect(getLocalOnlyCommand(command, "")).toBeNull();
      }
    }
  });

  test("skill which resolves through its own subcommand-specific rejection path", () => {
    expect(getLocalOnlyCommand("skill", "which")).toBe("skill which");
    expect(getLocalOnlyCommand("skill", "")).toBe("skill which");
  });

  test("config init is a local-only exception within an otherwise remote-capable command", () => {
    expect(COMMAND_CONTEXT_SUPPORT.config).toBe("remote-capable");
    expect(getLocalOnlyCommand("config", "init")).toBe("config init");
    expect(getLocalOnlyCommand("config", "show")).toBeNull();
    expect(getLocalOnlyCommand("config", "get")).toBeNull();
    expect(getLocalOnlyCommand("config", "set")).toBeNull();
    expect(getLocalOnlyCommand("config", "validate")).toBeNull();
    expect(getLocalOnlyCommand("config", "diff")).toBeNull();
    expect(getLocalOnlyCommand("config", "status")).toBeNull();
  });
});
