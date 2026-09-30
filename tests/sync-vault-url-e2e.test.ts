import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, createRemote, tempDir } from "./git-remote-fixture";

const CLI_PATH = join(process.cwd(), "src/cli.ts");

afterEach(() => cleanupTempDirs());

/** A remote holding a manifest that pins one core skill, and a machine that has never cloned it. */
function setup(configExtra: string) {
  const remote = createRemote();
  remote.publish("skillmux.toml", '[core]\nskills = ["demo-skill"]\n');
  remote.publish("demo-skill/SKILL.md", "---\nname: demo-skill\ndescription: A demo.\n---\nBody\n");

  const root = tempDir();
  const home = join(root, "home");
  const vault = join(root, "vault");
  mkdirSync(home, { recursive: true });
  const configPath = join(root, "config.toml");
  writeFileSync(
    configPath,
    `vault_path = "${vault}"\nvault_url = "${remote.url}"\nstate_dir = "${join(root, "state")}"\n${configExtra}`,
  );
  return { home, vault, configPath, remote };
}

async function runSync(setupResult: ReturnType<typeof setup>, ...args: string[]) {
  return runSyncWithEnv(setupResult, {}, ...args);
}

async function runSyncWithEnv(
  setupResult: ReturnType<typeof setup>,
  extraEnv: Record<string, string>,
  ...args: string[]
) {
  const proc = Bun.spawn(["bun", CLI_PATH, "sync", ...args], {
    env: { ...process.env, HOME: setupResult.home, SKILLMUX_CONFIG: setupResult.configPath, ...extraEnv },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("skillmux sync with vault_url", () => {
  test("clones the vault and delivers its core skills to the agent directory in one command", async () => {
    const machine = setup('agents = ["opencode"]\n');

    const { exitCode } = await runSync(machine, "--yes");

    expect(exitCode).toBe(0);
    expect(existsSync(join(machine.vault, "skillmux.toml"))).toBe(true);
    expect(lstatSync(join(machine.home, ".agents", "skills", "demo-skill")).isSymbolicLink()).toBe(true);
  });

  test("--no-pull leaves an absent vault absent and syncs nothing", async () => {
    const machine = setup('agents = ["opencode"]\n');

    const { exitCode, stdout } = await runSync(machine, "--no-pull", "--yes");

    expect(exitCode).toBe(0);
    expect(existsSync(machine.vault)).toBe(false);
    expect(stdout).toContain("nothing to sync");
  });

  test("a host with no agents prints the no-agents note and does not clone", async () => {
    const machine = setup("agents = []\n");

    const { exitCode, stdout } = await runSync(machine, "--yes");

    expect(exitCode).toBe(0);
    expect(existsSync(machine.vault)).toBe(false);
    expect(stdout).toContain("no agents configured");
  });

  test("--dry-run says it would clone and does not", async () => {
    const machine = setup('agents = ["opencode"]\n');

    const { exitCode, stdout } = await runSync(machine, "--dry-run");

    expect(exitCode).toBe(0);
    expect(stdout).toContain(`vault: would clone ${machine.remote.url} (dry-run)`);
    expect(existsSync(machine.vault)).toBe(false);
  });

  test("an unreachable remote warns and still exits 0, leaving delivered skills in place", async () => {
    const machine = setup('agents = ["opencode"]\n');
    await runSync(machine, "--yes");
    rmSync(machine.remote.url.replace("file://", ""), { recursive: true, force: true });

    const { exitCode, stderr } = await runSync(machine, "--yes");

    expect(exitCode).toBe(0);
    expect(stderr).toContain("git pull failed");
    expect(lstatSync(join(machine.home, ".agents", "skills", "demo-skill")).isSymbolicLink()).toBe(true);
  });

  test("says why it did not pull when SKILLMUX_SYNC_ACTIVE marks it as started by a vault pull", async () => {
    const machine = setup('agents = ["opencode"]\n');

    const { exitCode, stdout } = await runSyncWithEnv(machine, { SKILLMUX_SYNC_ACTIVE: "1" }, "--yes");

    expect(exitCode).toBe(0);
    expect(existsSync(machine.vault)).toBe(false);
    expect(stdout).toContain("vault: not pulling, this sync was started by a vault pull (SKILLMUX_SYNC_ACTIVE is set)");
  });

  test("--json reports the vault update as data.vault_update", async () => {
    const machine = setup('agents = ["opencode"]\n');

    const { stdout } = await runSync(machine, "--json", "--yes");

    expect(JSON.parse(stdout).data.vault_update).toEqual({ status: "cloned" });
  });

  test("--json reports a skipped update with its reason, and a failed one with its warning", async () => {
    const machine = setup('agents = ["opencode"]\n');
    const skipped = await runSync(machine, "--json", "--no-pull");
    expect(JSON.parse(skipped.stdout).data.vault_update).toEqual({ status: "skipped", reason: "no-pull" });

    await runSync(machine, "--yes");
    rmSync(machine.remote.url.replace("file://", ""), { recursive: true, force: true });
    const failed = await runSync(machine, "--json", "--yes");

    const update = JSON.parse(failed.stdout).data.vault_update;
    expect(update.status).toBe("failed");
    expect(update.warning).toContain("git pull failed");
  });
});
