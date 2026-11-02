import { describe, expect, test } from "bun:test";
import { mcpRemoteFromContext, parseMcpRemote, remoteAuthorizationHeader } from "../src/mcp-remote";

describe("parseMcpRemote", () => {
  test("accepts an https endpoint and a token variable name", () => {
    expect(parseMcpRemote({ url: "https://skills.example.com/mcp", tokenEnv: "SKILLMUX_TOKEN" })).toEqual({
      url: "https://skills.example.com/mcp",
      tokenEnv: "SKILLMUX_TOKEN",
    });
  });

  test("adds /mcp when only a host is given", () => {
    expect(parseMcpRemote({ url: "https://skills.example.com" }).url).toBe("https://skills.example.com/mcp");
    expect(parseMcpRemote({ url: "https://skills.example.com/" }).url).toBe("https://skills.example.com/mcp");
  });

  test("keeps a path the operator chose", () => {
    expect(parseMcpRemote({ url: "https://example.com/skills/mcp" }).url).toBe("https://example.com/skills/mcp");
  });

  test("allows plain http only for loopback, or when no token would travel over it", () => {
    expect(parseMcpRemote({ url: "http://127.0.0.1:3000/mcp", tokenEnv: "T" }).url).toBe("http://127.0.0.1:3000/mcp");
    expect(parseMcpRemote({ url: "http://localhost:3000/mcp", tokenEnv: "T" }).url).toBe("http://localhost:3000/mcp");
    expect(parseMcpRemote({ url: "http://[::1]:3000/mcp", tokenEnv: "T" }).url).toBe("http://[::1]:3000/mcp");
    expect(parseMcpRemote({ url: "http://lan-host:3000/mcp" }).url).toBe("http://lan-host:3000/mcp");
    expect(() => parseMcpRemote({ url: "http://skills.example.com/mcp", tokenEnv: "T" })).toThrow(/plain http/);
  });

  test("rejects anything that is not an http(s) URL", () => {
    for (const url of ["", "skills.example.com", "ftp://example.com/mcp", "file:///etc/passwd", "javascript:alert(1)"]) {
      expect(() => parseMcpRemote({ url })).toThrow();
    }
  });

  test("rejects credentials, query strings and fragments in the URL", () => {
    expect(() => parseMcpRemote({ url: "https://user:pw@example.com/mcp" })).toThrow(/credentials/);
    expect(() => parseMcpRemote({ url: "https://example.com/mcp?token=abc" })).toThrow(/query/);
    expect(() => parseMcpRemote({ url: "https://example.com/mcp#frag" })).toThrow(/fragment/);
  });

  test("rejects a token value pasted where a variable name belongs", () => {
    for (const tokenEnv of ["sk-abc def", "1TOKEN", "A-B", "Bearer abc", "$(id)", "A=B", ""]) {
      expect(() => parseMcpRemote({ url: "https://example.com/mcp", tokenEnv })).toThrow(/environment variable name/);
    }
  });
});

describe("remoteAuthorizationHeader", () => {
  test("references the variable instead of holding its value", () => {
    expect(remoteAuthorizationHeader("SKILLMUX_TOKEN")).toBe("Bearer ${SKILLMUX_TOKEN}");
  });
});

describe("mcpRemoteFromContext", () => {
  test("derives the MCP endpoint and token variable from a context", () => {
    expect(mcpRemoteFromContext({ server: "https://skills.example.com/", token_env: "PROD_TOKEN" })).toEqual({
      url: "https://skills.example.com/mcp",
      tokenEnv: "PROD_TOKEN",
    });
  });

  test("works for a context without a token", () => {
    expect(mcpRemoteFromContext({ server: "http://127.0.0.1:3000" })).toEqual({ url: "http://127.0.0.1:3000/mcp" });
  });

  test("refuses the local context", () => {
    expect(() => mcpRemoteFromContext({ server: "local" })).toThrow(/local/);
  });
});
