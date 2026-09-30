import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateVault } from "../src/vault-update";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "skillmux-vault-update-"));
  dirs.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`);
  return proc.stdout.toString().trim();
}

/** A bare repo standing in for the GitHub remote, plus a working clone to push new commits from. */
function createRemote(): { url: string; publish: (file: string, content: string) => void } {
  const root = tempDir();
  const bare = join(root, "remote.git");
  const work = join(root, "work");
  git(root, "init", "--bare", "-b", "main", bare);
  git(root, "clone", "--quiet", bare, work);
  const publish = (file: string, content: string) => {
    writeFileSync(join(work, file), content);
    git(work, "add", file);
    git(work, "commit", "-q", "-m", `add ${file}`);
    git(work, "push", "-q", "origin", "HEAD:main");
  };
  publish("first.txt", "one\n");
  return { url: `file://${bare}`, publish };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("updateVault", () => {
  test("clones vault_url into vault_path when vault_path does not exist", async () => {
    const remote = createRemote();
    const vaultPath = join(tempDir(), "vault");

    const result = await updateVault({ vaultPath, vaultUrl: remote.url });

    expect(result.status).toBe("cloned");
    expect(readFileSync(join(vaultPath, "first.txt"), "utf8")).toBe("one\n");
    expect(existsSync(join(vaultPath, ".git"))).toBe(true);
  });

  test("fast-forwards an existing checkout whose origin is vault_url", async () => {
    const remote = createRemote();
    const vaultPath = join(tempDir(), "vault");
    await updateVault({ vaultPath, vaultUrl: remote.url });
    remote.publish("second.txt", "two\n");

    const result = await updateVault({ vaultPath, vaultUrl: remote.url });

    expect(result.status).toBe("updated");
    expect(readFileSync(join(vaultPath, "second.txt"), "utf8")).toBe("two\n");
  });

  test("reports up-to-date and changes nothing when upstream has no new commits", async () => {
    const remote = createRemote();
    const vaultPath = join(tempDir(), "vault");
    await updateVault({ vaultPath, vaultUrl: remote.url });
    const before = git(vaultPath, "rev-parse", "HEAD");

    const result = await updateVault({ vaultPath, vaultUrl: remote.url });

    expect(result.status).toBe("up-to-date");
    expect(git(vaultPath, "rev-parse", "HEAD")).toBe(before);
  });

  test("refuses a checkout whose origin is not vault_url, naming both and changing nothing", async () => {
    const remote = createRemote();
    const other = createRemote();
    const vaultPath = join(tempDir(), "vault");
    await updateVault({ vaultPath, vaultUrl: remote.url });
    remote.publish("second.txt", "two\n");
    const before = git(vaultPath, "rev-parse", "HEAD");

    await expect(updateVault({ vaultPath, vaultUrl: other.url })).rejects.toThrow(
      new RegExp(`${remote.url}.*${other.url}|${other.url}.*${remote.url}`),
    );

    expect(git(vaultPath, "rev-parse", "HEAD")).toBe(before);
    expect(existsSync(join(vaultPath, "second.txt"))).toBe(false);
  });

  test("warns instead of throwing when the remote is unreachable, leaving the clone as it was", async () => {
    const remote = createRemote();
    const vaultPath = join(tempDir(), "vault");
    await updateVault({ vaultPath, vaultUrl: remote.url });
    rmSync(remote.url.replace("file://", ""), { recursive: true, force: true });

    const result = await updateVault({ vaultPath, vaultUrl: remote.url });

    expect(result.status).toBe("failed");
    expect(result.warning).toContain("git pull");
    expect(readFileSync(join(vaultPath, "first.txt"), "utf8")).toBe("one\n");
  });

  test("leaves a checkout with uncommitted changes alone and says why", async () => {
    const remote = createRemote();
    const vaultPath = join(tempDir(), "vault");
    await updateVault({ vaultPath, vaultUrl: remote.url });
    writeFileSync(join(vaultPath, "first.txt"), "hand edit\n");
    remote.publish("second.txt", "two\n");

    const result = await updateVault({ vaultPath, vaultUrl: remote.url });

    expect(result.status).toBe("failed");
    expect(result.warning).toContain("uncommitted");
    expect(readFileSync(join(vaultPath, "first.txt"), "utf8")).toBe("hand edit\n");
    expect(existsSync(join(vaultPath, "second.txt"))).toBe(false);
  });

  test("leaves a diverged checkout alone instead of merging or rebasing", async () => {
    const remote = createRemote();
    const vaultPath = join(tempDir(), "vault");
    await updateVault({ vaultPath, vaultUrl: remote.url });
    writeFileSync(join(vaultPath, "local.txt"), "local\n");
    git(vaultPath, "add", "local.txt");
    git(vaultPath, "commit", "-q", "-m", "local commit");
    const before = git(vaultPath, "rev-parse", "HEAD");
    remote.publish("second.txt", "two\n");

    const result = await updateVault({ vaultPath, vaultUrl: remote.url });

    expect(result.status).toBe("failed");
    expect(git(vaultPath, "rev-parse", "HEAD")).toBe(before);
    expect(existsSync(join(vaultPath, "second.txt"))).toBe(false);
  });

  test("refuses a vault_url whose host is not in [egress] allowed_hosts before touching the network", async () => {
    const vaultPath = join(tempDir(), "vault");

    await expect(
      updateVault({
        vaultPath,
        vaultUrl: "https://untrusted.example.com/klhq/skills.git",
        allowedHosts: ["github.com"],
      }),
    ).rejects.toThrow("not in [egress] allowed_hosts");

    expect(existsSync(vaultPath)).toBe(false);
  });

  test("warns instead of throwing when a first clone cannot reach the remote", async () => {
    const vaultPath = join(tempDir(), "vault");

    const result = await updateVault({ vaultPath, vaultUrl: `file://${tempDir()}/missing.git` });

    expect(result.status).toBe("failed");
    expect(result.warning).toContain("git clone");
    expect(existsSync(vaultPath)).toBe(false);
  });
});
