import { describe, expect, test } from "bun:test";
import {
  isMcpRegistrable,
  MCP_PROJECT_REGISTRABLE_AGENTS,
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
    expect(isMcpRegistrable("windsurf")).toBe(false);
    expect(isMcpRegistrable("goose")).toBe(false);
  });
});

describe("MCP_PROJECT_REGISTRABLE_AGENTS", () => {
  test("only lists agents whose own CLI has a project MCP scope", () => {
    // codex's mcp add has no --scope flag at all (always global), so only
    // claude-code (--scope project) qualifies here.
    expect(MCP_PROJECT_REGISTRABLE_AGENTS).toEqual(["claude-code"]);
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

  test("runs claude-code's project-scoped command with the project directory as cwd", async () => {
    let capturedCmd: string[] = [];
    let capturedCwd: string | undefined;
    const result = await registerMcpServer("claude-code", {
      scope: "project",
      cwd: "/tmp/some-project",
      spawn: (cmd, opts) => {
        capturedCmd = cmd;
        capturedCwd = opts?.cwd;
        return { exited: Promise.resolve(0), stderr: fakeStream("") };
      },
    });
    expect(capturedCmd).toEqual([
      "claude",
      "mcp",
      "add",
      "-s",
      "project",
      "skillmux",
      "--",
      "skillmux",
      "serve",
    ]);
    expect(capturedCwd).toBe("/tmp/some-project");
    expect(result).toEqual({ agent: "claude-code", ok: true });
  });

  test("rejects codex for project scope since its CLI has no scope flag", async () => {
    const result = await registerMcpServer("codex", { scope: "project" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain(
      'no project-scoped MCP registration command known for agent "codex"',
    );
  });
});
