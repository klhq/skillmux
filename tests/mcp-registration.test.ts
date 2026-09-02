import { describe, expect, test } from "bun:test";
import {
  isMcpRegistrable,
  MCP_REGISTRABLE_AGENTS,
  registerMcpServer,
} from "../src/mcp-registration";

function fakeStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

describe("MCP_REGISTRABLE_AGENTS", () => {
  test("only lists agents with a verified CLI registration command", () => {
    expect(MCP_REGISTRABLE_AGENTS).toEqual(["claude-code", "codex"]);
  });

  test("isMcpRegistrable matches the registrable set", () => {
    expect(isMcpRegistrable("claude-code")).toBe(true);
    expect(isMcpRegistrable("codex")).toBe(true);
    expect(isMcpRegistrable("gemini-cli")).toBe(false);
    expect(isMcpRegistrable("goose")).toBe(false);
  });
});

describe("registerMcpServer", () => {
  test("runs claude-code's exact verified command", async () => {
    let capturedCmd: string[] = [];
    const result = await registerMcpServer("claude-code", {
      spawn: (cmd) => {
        capturedCmd = cmd;
        return { exited: Promise.resolve(0), stderr: fakeStream("") };
      },
    });
    expect(capturedCmd).toEqual([
      "claude",
      "mcp",
      "add",
      "-s",
      "user",
      "skillmux",
      "--",
      "skillmux",
      "serve",
    ]);
    expect(result).toEqual({ agent: "claude-code", ok: true });
  });

  test("runs codex's exact verified command", async () => {
    let capturedCmd: string[] = [];
    const result = await registerMcpServer("codex", {
      spawn: (cmd) => {
        capturedCmd = cmd;
        return { exited: Promise.resolve(0), stderr: fakeStream("") };
      },
    });
    expect(capturedCmd).toEqual([
      "codex",
      "mcp",
      "add",
      "skillmux",
      "--",
      "skillmux",
      "serve",
    ]);
    expect(result).toEqual({ agent: "codex", ok: true });
  });

  test("reports failure with stderr on a non-zero exit code", async () => {
    const result = await registerMcpServer("claude-code", {
      spawn: () => ({
        exited: Promise.resolve(1),
        stderr: fakeStream("server \"skillmux\" already exists\n"),
      }),
    });
    expect(result).toEqual({
      agent: "claude-code",
      ok: false,
      error: 'server "skillmux" already exists',
    });
  });

  test("reports a clear error when the agent's CLI is not installed", async () => {
    const result = await registerMcpServer("codex", {
      spawn: () => {
        throw new Error("spawn codex ENOENT");
      },
    });
    expect(result).toEqual({
      agent: "codex",
      ok: false,
      error: '"codex" is not installed or not on PATH',
    });
  });

  test("rejects an agent with no known registration command", async () => {
    const result = await registerMcpServer("goose");
    expect(result.ok).toBe(false);
    expect(result.error).toContain('no MCP registration command known for agent "goose"');
  });
});
