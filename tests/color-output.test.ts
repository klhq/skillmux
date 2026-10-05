import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderError, styleHelp } from "../src/output";
import { renderScanText } from "../src/scan";
import { ESC, ansiCount, python, runOnPty } from "./helpers/pty";

const strip = (text: string) => text.replaceAll(/\x1b\[[0-9;]*m/g, "").replaceAll("\r\n", "\n");

describe("plain rendering without a TTY", () => {
  test("renderError labels the first line and leaves the message alone", () => {
    expect(renderError("missing <repo> argument\nusage: skillmux install <repo>")).toBe(
      "error: missing <repo> argument\nusage: skillmux install <repo>",
    );
  });

  test("renderError does not label an error twice, or label a bare usage line", () => {
    expect(renderError("error: boom")).toBe("error: boom");
    expect(renderError("usage: skillmux config <get|set>")).toBe("usage: skillmux config <get|set>");
  });

  test("styleHelp changes nothing when color is off", () => {
    const help = "doctor: check\n\nusage:\n  skillmux doctor\n\nSetup:\n  x";
    expect(styleHelp(help)).toBe(help);
  });

  test("scan text keeps its severity tags and summary", () => {
    const text = renderScanText({
      scanned: 2,
      findings: [{ severity: "high", skill_id: "a", file: "SKILL.md", line: 3, rule_id: "r", message: "m" }],
    } as never);
    expect(text).toBe("scanned 2 skills, 1 finding(s)\n[high] a/SKILL.md:3 r — m");
  });
});

describe.skipIf(!python)("color on a real terminal", () => {
  test("an error colors only its label, not the message", async () => {
    const { tty } = await runOnPty(["install"]);
    expect(tty).toStartWith(`${ESC}1;31merror:${ESC}0m missing <repo> argument`);
    // the message and usage text carry no further color except the usage label
    expect(ansiCount(tty)).toBe(4);
    expect(strip(tty)).toStartWith("error: missing <repo> argument\nusage: skillmux install");
  });

  test("errors are colored by whether stderr is a TTY, not stdout", async () => {
    const stdoutRedirected = await runOnPty(["install"], "stdout");
    // stdout went to a file, so stderr is the pty: still colored
    expect(ansiCount(stdoutRedirected.tty)).toBeGreaterThan(0);

    const stderrRedirected = await runOnPty(["install"], "stderr");
    // stderr went to a file (2>err.log): no escape codes may land in it
    expect(ansiCount(stderrRedirected.file)).toBe(0);
    expect(stderrRedirected.file).toStartWith("error: missing <repo> argument");
  });

  test("warnings color only the label", async () => {
    const warning = await runOnPty(["scan", "--format", "text", tmpEmptyVault()]);
    expect(warning.tty).toContain(`${ESC}1;33mwarning:${ESC}0m --format is deprecated`);
  });

  test("config deprecation warnings use the same colored label as other warnings", async () => {
    const { tty } = await runOnPty(["config", "validate"], undefined, { SKILL_ROUTER_CONFIG: "/nonexistent/config.toml" });
    expect(tty).toContain(
      `${ESC}1;33mwarning:${ESC}0m SKILL_ROUTER_CONFIG is deprecated, use SKILLMUX_CONFIG instead`,
    );
  });

  test("scan colors severity tags by level", async () => {
    const vault = mkdtempSync(join(tmpdir(), "skillmux-scan-"));
    const dir = join(vault, "skill-a");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "---\nname: skill-a\ndescription: test\n---\nhidden​char\n");
    const { tty } = await runOnPty(["scan", vault]);
    expect(tty).toContain(`${ESC}1;31m[high]${ESC}0m`);
  });

  test("config validation reports a valid configuration in green", async () => {
    const { tty } = await runOnPty(["config", "validate"]);
    expect(tty).toContain(`${ESC}32mconfiguration is valid${ESC}0m`);
  });

  test("help headings are bold, and command names too", async () => {
    const top = await runOnPty(["--help"]);
    expect(top.tty).toContain(`${ESC}1musage:${ESC}0m skillmux <command> [options]`);
    expect(top.tty).toContain(`${ESC}1mCommands:${ESC}0m`);
    const sub = await runOnPty(["doctor", "--help"]);
    expect(sub.tty).toContain(`${ESC}1mdoctor:${ESC}0m check`);
    expect(sub.tty).toContain(`${ESC}1musage:${ESC}0m`);
  });

  test("piped stdout never carries color", async () => {
    const { file } = await runOnPty(["--help"], "stdout");
    expect(ansiCount(file)).toBe(0);
  });
});

function tmpEmptyVault(): string {
  return mkdtempSync(join(tmpdir(), "skillmux-empty-"));
}
