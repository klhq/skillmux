import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_PACK_LIMITS,
  PackError,
  packEntries,
  readVaultForPush,
  unpackEntries,
  validatePackPath,
  type PackEntry,
} from "../src/vault-pack";
import { sha256Hex } from "../src/vault";

const enc = new TextEncoder();
const dec = new TextDecoder();

function entry(path: string, content = "x"): PackEntry {
  return { path, bytes: enc.encode(content) };
}

const SKILL = "---\nname: a\ndescription: A skill.\n---\nbody\n";

/** Builds a pack by hand so a test can lie in the header the way a hostile client would. */
function rawPack(header: unknown, data: Uint8Array): Uint8Array {
  const headerBytes = enc.encode(JSON.stringify(header));
  const out = new Uint8Array(4 + headerBytes.length + data.length);
  new DataView(out.buffer).setUint32(0, headerBytes.length);
  out.set(headerBytes, 4);
  out.set(data, 4 + headerBytes.length);
  return out;
}

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof PackError) return error.code;
    throw error;
  }
  return "no error";
}

describe("validatePackPath", () => {
  test.each([
    "alpha/SKILL.md",
    "alpha/references/guide.md",
    "alpha/.skillmux-origin",
    "skillmux.toml",
    "a1/scripts/run.sh",
  ])("accepts %s", (path) => {
    expect(validatePackPath(path)).toBeNull();
  });

  test.each([
    ["", "empty"],
    ["/etc/passwd", "absolute"],
    ["../outside/SKILL.md", "parent segment first"],
    ["alpha/../../outside", "parent segment inside"],
    ["alpha/./SKILL.md", "dot segment"],
    ["alpha//SKILL.md", "empty segment"],
    ["alpha/SKILL.md/", "trailing slash"],
    ["alpha\\SKILL.md", "backslash"],
    ["alpha/SK\u0000ILL.md", "NUL"],
    ["alpha/SK\nILL.md", "newline"],
    ["alpha/.git/config", ".git directory"],
    ["alpha/.GIT/config", ".git in another case"],
    ["alpha/evil\u202Egnp.sh", "right-to-left override in a file name"],
    ["alpha/zero\u200Bwidth.md", "zero-width space in a file name"],
    ["alpha/line\u2028break.md", "unicode line separator"],
    ["alpha/bom\uFEFF.md", "byte order mark inside a name"],
    [".git/config", "root .git"],
    ["Alpha/SKILL.md", "uppercase skill id"],
    ["a/SKILL.md", "skill id too short"],
    ["README.md", "loose file at the root"],
    ["alpha", "skill id alone"],
    [`alpha/${"x".repeat(600)}`, "path too long"],
  ])("rejects %j (%s)", (path) => {
    expect(validatePackPath(path)).not.toBeNull();
  });
});

describe("packEntries and unpackEntries", () => {
  test("round-trips entries and reports a stable content hash", () => {
    const entries = [entry("beta/SKILL.md", SKILL), entry("alpha/SKILL.md", SKILL), entry("alpha/notes.md", "n")];

    const first = unpackEntries(packEntries(entries), DEFAULT_PACK_LIMITS);
    const second = unpackEntries(packEntries([...entries].reverse()), DEFAULT_PACK_LIMITS);

    expect(first.entries.map((e) => e.path)).toEqual(["alpha/SKILL.md", "alpha/notes.md", "beta/SKILL.md"]);
    expect(dec.decode(first.entries[1]!.bytes)).toBe("n");
    expect(first.content_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(second.content_sha256).toBe(first.content_sha256);
  });

  test("a changed byte changes the content hash", () => {
    const a = unpackEntries(packEntries([entry("alpha/SKILL.md", "one")]), DEFAULT_PACK_LIMITS);
    const b = unpackEntries(packEntries([entry("alpha/SKILL.md", "two")]), DEFAULT_PACK_LIMITS);
    expect(a.content_sha256).not.toBe(b.content_sha256);
  });

  test("handles non-ASCII content and paths that are valid ids", () => {
    const body = "---\nname: x\ndescription: 你好\n---\n內容\n";
    const result = unpackEntries(packEntries([entry("alpha/SKILL.md", body)]), DEFAULT_PACK_LIMITS);
    expect(dec.decode(result.entries[0]!.bytes)).toBe(body);
  });

  test("rejects a path that escapes the vault even when the header is otherwise honest", () => {
    const data = enc.encode("pwned");
    const pack = rawPack(
      { version: 1, files: [{ path: "../../etc/cron.d/x", size: data.length, sha256: sha256Hex(data) }] },
      data,
    );
    expect(code(() => unpackEntries(pack, DEFAULT_PACK_LIMITS))).toBe("INVALID_PACK");
  });

  test("rejects a size field that disagrees with the bytes that follow", () => {
    const data = enc.encode("hello");
    const longer = rawPack({ version: 1, files: [{ path: "alpha/SKILL.md", size: 99, sha256: sha256Hex(data) }] }, data);
    const shorter = rawPack({ version: 1, files: [{ path: "alpha/SKILL.md", size: 2, sha256: sha256Hex(data) }] }, data);
    expect(code(() => unpackEntries(longer, DEFAULT_PACK_LIMITS))).toBe("INVALID_PACK");
    expect(code(() => unpackEntries(shorter, DEFAULT_PACK_LIMITS))).toBe("INVALID_PACK");
  });

  test("rejects bytes that do not match their declared hash", () => {
    const data = enc.encode("hello");
    const pack = rawPack({ version: 1, files: [{ path: "alpha/SKILL.md", size: 5, sha256: sha256Hex("other") }] }, data);
    expect(code(() => unpackEntries(pack, DEFAULT_PACK_LIMITS))).toBe("INVALID_PACK");
  });

  test.each([
    ["negative size", { path: "alpha/SKILL.md", size: -1, sha256: "0".repeat(64) }],
    ["fractional size", { path: "alpha/SKILL.md", size: 1.5, sha256: "0".repeat(64) }],
    ["string size", { path: "alpha/SKILL.md", size: "5", sha256: "0".repeat(64) }],
    ["missing hash", { path: "alpha/SKILL.md", size: 5 }],
    ["short hash", { path: "alpha/SKILL.md", size: 5, sha256: "abc" }],
    ["non-string path", { path: 5, size: 5, sha256: "0".repeat(64) }],
  ])("rejects a malformed file entry: %s", (_name, file) => {
    expect(code(() => unpackEntries(rawPack({ version: 1, files: [file] }, enc.encode("hello")), DEFAULT_PACK_LIMITS))).toBe(
      "INVALID_PACK",
    );
  });

  test.each([
    ["wrong version", { version: 2, files: [] }],
    ["no files array", { version: 1 }],
    ["files is not an array", { version: 1, files: {} }],
    ["null header", null],
    ["unknown extra key", { version: 1, files: [], extra: true }],
  ])("rejects a malformed header: %s", (_name, header) => {
    expect(code(() => unpackEntries(rawPack(header, new Uint8Array()), DEFAULT_PACK_LIMITS))).toBe("INVALID_PACK");
  });

  test("rejects a truncated pack, an oversized header and a header that is not JSON", () => {
    expect(code(() => unpackEntries(new Uint8Array([0, 0]), DEFAULT_PACK_LIMITS))).toBe("INVALID_PACK");
    const lying = new Uint8Array(8);
    new DataView(lying.buffer).setUint32(0, 0xffffffff);
    expect(code(() => unpackEntries(lying, DEFAULT_PACK_LIMITS))).toBe("PACK_TOO_LARGE");
    const notJson = new Uint8Array(4 + 3);
    new DataView(notJson.buffer).setUint32(0, 3);
    notJson.set(enc.encode("{{{"), 4);
    expect(code(() => unpackEntries(notJson, DEFAULT_PACK_LIMITS))).toBe("INVALID_PACK");
  });

  test("rejects duplicate paths, including ones that differ only in case", () => {
    const data = enc.encode("x");
    const file = (path: string) => ({ path, size: 1, sha256: sha256Hex(data) });
    const two = new Uint8Array([...data, ...data]);
    expect(code(() => unpackEntries(rawPack({ version: 1, files: [file("alpha/SKILL.md"), file("alpha/SKILL.md")] }, two), DEFAULT_PACK_LIMITS))).toBe("INVALID_PACK");
    expect(code(() => unpackEntries(rawPack({ version: 1, files: [file("alpha/notes.md"), file("alpha/Notes.md")] }, two), DEFAULT_PACK_LIMITS))).toBe("INVALID_PACK");
  });

  test("rejects a path that is both a file and a directory", () => {
    const data = enc.encode("x");
    const file = (path: string) => ({ path, size: 1, sha256: sha256Hex(data) });
    const two = new Uint8Array([...data, ...data]);
    expect(code(() => unpackEntries(rawPack({ version: 1, files: [file("alpha/ref"), file("alpha/ref/more.md")] }, two), DEFAULT_PACK_LIMITS))).toBe("INVALID_PACK");
  });

  test("enforces the file count, per-file and total byte limits as PACK_TOO_LARGE", () => {
    const limits = { maxFiles: 2, maxFileBytes: 10, maxTotalBytes: 15 };
    const ok = [entry("alpha/SKILL.md", "12345"), entry("alpha/a.md", "12345")];
    expect(code(() => unpackEntries(packEntries(ok), limits))).toBe("no error");
    expect(code(() => unpackEntries(packEntries([...ok, entry("alpha/b.md", "1")]), limits))).toBe("PACK_TOO_LARGE");
    expect(code(() => unpackEntries(packEntries([entry("alpha/SKILL.md", "12345678901")]), limits))).toBe("PACK_TOO_LARGE");
    expect(code(() => unpackEntries(packEntries([entry("alpha/SKILL.md", "1234567890"), entry("alpha/a.md", "123456")]), limits))).toBe("PACK_TOO_LARGE");
  });

  test("a header that claims more bytes than the limit is refused before any data is read", () => {
    const pack = rawPack({ version: 1, files: [{ path: "alpha/SKILL.md", size: 1e12, sha256: "0".repeat(64) }] }, new Uint8Array());
    expect(code(() => unpackEntries(pack, DEFAULT_PACK_LIMITS))).toBe("PACK_TOO_LARGE");
  });
});

describe("readVaultForPush", () => {
  function makeVault(): string {
    const root = mkdtempSync(join(tmpdir(), "skillmux-push-src-"));
    mkdirSync(join(root, "alpha", "references"), { recursive: true });
    writeFileSync(join(root, "alpha", "SKILL.md"), SKILL);
    writeFileSync(join(root, "alpha", "references", "guide.md"), "guide");
    mkdirSync(join(root, "beta"));
    writeFileSync(join(root, "beta", "SKILL.md"), SKILL);
    writeFileSync(join(root, "skillmux.toml"), "[core]\nskills = []\n");
    return root;
  }

  test("packs skill directories and skillmux.toml, and reports what it left out", () => {
    const root = makeVault();
    try {
      mkdirSync(join(root, ".git"));
      writeFileSync(join(root, ".git", "HEAD"), "ref");
      writeFileSync(join(root, "notes.txt"), "loose");
      mkdirSync(join(root, "Not_A_Skill"));
      writeFileSync(join(root, "Not_A_Skill", "SKILL.md"), SKILL);

      const { entries, skipped } = readVaultForPush(root);

      expect(entries.map((e) => e.path).sort()).toEqual([
        "alpha/SKILL.md",
        "alpha/references/guide.md",
        "beta/SKILL.md",
        "skillmux.toml",
      ]);
      expect([...skipped].sort()).toEqual([".git", "Not_A_Skill", "notes.txt"]);
      for (const e of entries) expect(validatePackPath(e.path)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses a vault that contains a symlink instead of following it", () => {
    const root = makeVault();
    try {
      symlinkSync("/etc/passwd", join(root, "alpha", "leak.md"));
      expect(() => readVaultForPush(root)).toThrow(/symlink/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses a skill directory that is itself a symlink", () => {
    const root = makeVault();
    try {
      symlinkSync("/etc", join(root, "gamma"));
      expect(() => readVaultForPush(root)).toThrow(/symlink/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses a vault with no skills, since pushing it would empty the server", () => {
    const root = mkdtempSync(join(tmpdir(), "skillmux-push-empty-"));
    try {
      expect(() => readVaultForPush(root)).toThrow(/no skills/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
