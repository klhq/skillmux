import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const python = Bun.which("python3");

const CLI = new URL("../../src/cli.ts", import.meta.url).pathname;

const PTY_SCRIPT = `
import os, pty, select, sys, json
args = json.loads(sys.argv[1])
redirect = json.loads(sys.argv[2])
pid, fd = pty.fork()
if pid == 0:
    for stream, path in redirect.items():
        target = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC)
        os.dup2(target, 1 if stream == "stdout" else 2)
    env = {k: v for k, v in os.environ.items() if k != "NO_COLOR"}
    env["TERM"] = "xterm-256color"
    os.execvpe(args[0], args, env)
out = b""
while True:
    try:
        if not select.select([fd], [], [], 60)[0]:
            break
        chunk = os.read(fd, 4096)
        if not chunk:
            break
        out += chunk
    except OSError:
        break
os.waitpid(pid, 0)
sys.stdout.write(out.decode(errors="replace"))
`;

export interface PtyResult {
  /** Everything the child wrote to the pty (whichever of stdout/stderr was not redirected). */
  tty: string;
  /** What the child wrote to a redirected stream, if any. */
  file: string;
}

/**
 * Runs the skillmux CLI with its stdout and/or stderr attached to a real pty,
 * so TTY detection and color behave as in a terminal. Name a stream in
 * `redirect` to send it to a file instead, which is how piping or `2>file`
 * looks to the process. NO_COLOR is removed from the environment: a
 * developer's own setting would otherwise hide a regression.
 */
export async function runOnPty(
  args: string[],
  redirect?: "stdout" | "stderr",
): Promise<PtyResult> {
  if (!python) throw new Error("python3 is required for pty tests");
  const dir = mkdtempSync(join(tmpdir(), "skillmux-pty-"));
  const file = join(dir, "redirected");
  const proc = Bun.spawn(
    [
      python,
      "-c",
      PTY_SCRIPT,
      JSON.stringify(["bun", CLI, ...args]),
      JSON.stringify(redirect ? { [redirect]: file } : {}),
    ],
    { stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH!, HOME: process.env.HOME! } },
  );
  const tty = await new Response(proc.stdout).text();
  await proc.exited;
  let content = "";
  if (redirect) {
    try {
      content = readFileSync(file, "utf8");
    } catch {
      // the child wrote nothing to it
    }
  }
  return { tty, file: content };
}

export const ESC = "\x1b[";
export const ansiCount = (text: string): number => text.split(ESC).length - 1;
