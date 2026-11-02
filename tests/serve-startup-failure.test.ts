import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;

test("serve exits non-zero when it refuses an unsafe bind instead of idling", async () => {
  const root = mkdtempSync(join(tmpdir(), "skillmux-serve-refuse-"));
  mkdirSync(join(root, "vault"));
  const proc = Bun.spawn(
    ["bun", CLI, "serve", "--transport", "http", "--port", "0", "--host", "0.0.0.0", "--vault", join(root, "vault"), "--state-dir", join(root, "state")],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: process.env.PATH!, HOME: root, XDG_CONFIG_HOME: join(root, "c"), XDG_STATE_HOME: join(root, "s") },
    },
  );
  const timer = setTimeout(() => proc.kill(), 8000);
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  clearTimeout(timer);
  expect(stderr).toContain("refusing to bind");
  expect(proc.signalCode).toBeNull();
  expect(code).not.toBe(0);
}, 15_000);
