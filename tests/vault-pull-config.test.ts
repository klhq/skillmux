import { afterEach, describe, expect, mock, test } from "bun:test";
import { rmSync } from "node:fs";

const fakeHome = `/tmp/fake-home-vault-pull-${crypto.randomUUID()}`;

mock.module("node:os", () => ({
  homedir: () => fakeHome,
  tmpdir: () => "/tmp",
}));

import { loadConfig, parsePullInterval } from "../src/config";

const files: string[] = [];

async function configFile(content: string): Promise<string> {
  const path = `/tmp/skillmux-config-${crypto.randomUUID()}.toml`;
  files.push(path);
  await Bun.write(path, content);
  return path;
}

afterEach(() => {
  for (const path of files.splice(0)) rmSync(path, { force: true });
});

describe("parsePullInterval", () => {
  test.each([
    ["10s", 10_000],
    ["90s", 90_000],
    ["10m", 600_000],
    ["2h", 7_200_000],
  ])("reads %s as %d ms", (value, ms) => {
    expect(parsePullInterval(value)).toBe(ms);
  });

  test.each(["", "10", "m", "1.5m", "-5m", "10 m", "10d", "5s", "0s"])("rejects %p", (value) => {
    expect(() => parsePullInterval(value)).toThrow();
  });
});

describe("vault_pull_interval", () => {
  test("is absent by default, so a server never pulls on its own", async () => {
    const config = await loadConfig("/does/not/exist/config.toml");

    expect(config.vault_pull_interval).toBeUndefined();
  });

  test("loads next to vault_url", async () => {
    const path = await configFile(`
vault_url = "https://github.com/klhq/skills.git"
vault_pull_interval = "10m"
`);

    expect((await loadConfig(path)).vault_pull_interval).toBe("10m");
  });

  test.each(["soon", "10", "5s"])("rejects %p with a message that names the key", async (value) => {
    const path = await configFile(`vault_pull_interval = "${value}"\n`);

    await expect(loadConfig(path)).rejects.toThrow(/vault_pull_interval/);
  });

  test("requires vault_url, since there is nothing to pull from otherwise", async () => {
    const path = await configFile(`vault_pull_interval = "10m"\n`);

    await expect(loadConfig(path)).rejects.toThrow(/vault_url/);
  });
});
