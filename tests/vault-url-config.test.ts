import { afterEach, describe, expect, mock, test } from "bun:test";
import { rmSync } from "node:fs";

const fakeHome = `/tmp/fake-home-vault-url-${crypto.randomUUID()}`;

mock.module("node:os", () => ({
  homedir: () => fakeHome,
  tmpdir: () => "/tmp",
}));

import { loadConfig } from "../src/config";

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

describe("vault_url", () => {
  test("is absent by default, so sync has no remote to fetch from", async () => {
    const config = await loadConfig("/does/not/exist/config.toml");

    expect(config.vault_url).toBeUndefined();
  });

  test("loads a configured vault_url next to the unchanged vault_path", async () => {
    const path = await configFile(`
vault_path = "~/skills"
vault_url = "git@github.com:klhq/skills.git"
`);

    const config = await loadConfig(path);

    expect(config.vault_url).toBe("git@github.com:klhq/skills.git");
    expect(config.vault_path).toBe("~/skills");
  });

  test.each([
    "git@github.com:klhq/skills.git",
    "https://github.com/klhq/skills.git",
    "ssh://git@github.com/klhq/skills.git",
  ])("accepts the git remote form %s", async (url) => {
    const path = await configFile(`vault_url = "${url}"\n`);

    expect((await loadConfig(path)).vault_url).toBe(url);
  });

  test.each([
    "--upload-pack=touch /tmp/pwned@host:path",
    "-oProxyCommand=x",
    "klhq/skills",
    "ftp://example.com/skills.git",
    "not a url",
  ])("rejects %s, which git would read as a flag or cannot clone", async (url) => {
    const path = await configFile(`vault_url = ${JSON.stringify(url)}\n`);

    await expect(loadConfig(path)).rejects.toThrow("vault_url");
  });
});
