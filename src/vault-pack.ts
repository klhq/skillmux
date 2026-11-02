import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SKILL_ID_PATTERN, sha256Hex } from "./vault";

/**
 * Wire format for `skillmux vault push`: a 4-byte big-endian header length, a
 * JSON header listing every file as { path, size, sha256 }, then the file
 * bytes back to back in header order. It is deliberately not tar or zip. Those
 * formats carry symlinks, hard links, absolute paths and device nodes, and
 * every one of them has been a path-traversal bug somewhere. This format can
 * express only regular files, and every field the server acts on is checked
 * before any byte reaches the disk.
 */
export const PACK_CONTENT_TYPE = "application/vnd.skillmux.vault-pack";

const MAX_HEADER_BYTES = 4 * 1024 * 1024;
const MAX_PATH_LENGTH = 512;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const VAULT_MANIFEST = "skillmux.toml";

export interface PackLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export const DEFAULT_PACK_LIMITS: PackLimits = {
  maxFiles: 5000,
  maxFileBytes: 8 * 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
};

export interface PackEntry {
  path: string;
  bytes: Uint8Array;
}

export type PackErrorCode = "INVALID_PACK" | "PACK_TOO_LARGE";

export class PackError extends Error {
  constructor(
    readonly code: PackErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PackError";
  }
}

const invalid = (message: string) => new PackError("INVALID_PACK", message);
const tooLarge = (message: string) => new PackError("PACK_TOO_LARGE", message);

/**
 * Returns why a pack path is unacceptable, or null when it is fine. A path is a
 * "/"-separated relative path that is either the vault manifest or lives inside
 * a skill directory whose name is a valid skill id. Nothing else is allowed, so
 * a push cannot write loose files, hidden directories or `.git` into the vault.
 */
export function validatePackPath(path: unknown): string | null {
  if (typeof path !== "string" || path === "") return "path is empty";
  if (path.length > MAX_PATH_LENGTH) return "path is too long";
  // Control and format characters (zero-width, bidi overrides, line separators) let a
  // file name read as something other than what it is, so they never belong in a path.
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\\]/u.test(path)) return "path contains a control, invisible or direction-changing character, or a backslash";
  if (path.startsWith("/")) return "path is absolute";
  const segments = path.split("/");
  for (const segment of segments) {
    if (segment === "") return "path has an empty segment";
    if (segment === "." || segment === "..") return "path has a . or .. segment";
    if (segment.toLowerCase() === ".git") return "path enters .git";
  }
  if (path === VAULT_MANIFEST) return null;
  if (segments.length < 2) return "path is not inside a skill directory";
  if (!SKILL_ID_PATTERN.test(segments[0]!)) return `"${segments[0]}" is not a valid skill id`;
  return null;
}

/** Packs entries in path order, so the same vault always produces the same bytes and hash. */
export function packEntries(entries: PackEntry[]): Uint8Array {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const header = new TextEncoder().encode(
    JSON.stringify({
      version: 1,
      files: sorted.map((e) => ({ path: e.path, size: e.bytes.length, sha256: sha256Hex(e.bytes) })),
    }),
  );
  const total = sorted.reduce((sum, e) => sum + e.bytes.length, 0);
  const out = new Uint8Array(4 + header.length + total);
  new DataView(out.buffer).setUint32(0, header.length);
  out.set(header, 4);
  let offset = 4 + header.length;
  for (const e of sorted) {
    out.set(e.bytes, offset);
    offset += e.bytes.length;
  }
  return out;
}

interface HeaderFile {
  path: string;
  size: number;
  sha256: string;
}

function parseHeader(raw: unknown): HeaderFile[] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw invalid("header is not an object");
  const header = raw as Record<string, unknown>;
  const unknownKeys = Object.keys(header).filter((key) => key !== "version" && key !== "files");
  if (unknownKeys.length > 0) throw invalid(`header has unknown field "${unknownKeys[0]}"`);
  if (header.version !== 1) throw invalid(`unsupported pack version ${JSON.stringify(header.version)}`);
  if (!Array.isArray(header.files)) throw invalid("header.files is not an array");
  return header.files.map((file, index) => {
    if (typeof file !== "object" || file === null) throw invalid(`file ${index} is not an object`);
    const { path, size, sha256 } = file as Record<string, unknown>;
    const reason = validatePackPath(path);
    if (reason) throw invalid(`file ${index} (${JSON.stringify(path)}): ${reason}`);
    if (typeof size !== "number" || !Number.isInteger(size) || size < 0) {
      throw invalid(`${path}: size must be a non-negative integer`);
    }
    if (typeof sha256 !== "string" || !SHA256_PATTERN.test(sha256)) {
      throw invalid(`${path}: sha256 must be 64 lowercase hex characters`);
    }
    return { path: path as string, size, sha256 };
  });
}

/**
 * Checks a pack end to end and returns its files and a content hash. Every
 * limit is applied to the header's claims before the data is touched, so a
 * header that promises a terabyte is refused without allocating anything.
 */
export function unpackEntries(
  buffer: Uint8Array,
  limits: PackLimits,
): { entries: PackEntry[]; content_sha256: string } {
  if (buffer.length < 4) throw invalid("pack is shorter than its length prefix");
  const headerLength = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength).getUint32(0);
  if (headerLength > MAX_HEADER_BYTES) throw tooLarge("pack header is too large");
  if (4 + headerLength > buffer.length) throw invalid("pack is shorter than its header");

  const headerBytes = buffer.subarray(4, 4 + headerLength);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(headerBytes));
  } catch {
    throw invalid("pack header is not valid JSON");
  }
  const files = parseHeader(parsed);

  if (files.length > limits.maxFiles) throw tooLarge(`pack has ${files.length} files; the limit is ${limits.maxFiles}`);
  let total = 0;
  for (const file of files) {
    if (file.size > limits.maxFileBytes) {
      throw tooLarge(`${file.path} is ${file.size} bytes; the per-file limit is ${limits.maxFileBytes}`);
    }
    total += file.size;
    if (total > limits.maxTotalBytes) throw tooLarge(`pack exceeds the ${limits.maxTotalBytes} byte limit`);
  }
  const data = buffer.subarray(4 + headerLength);
  if (total !== data.length) throw invalid(`header declares ${total} bytes of content but the pack carries ${data.length}`);

  const seen = new Set<string>();
  const directories = new Set<string>();
  for (const file of files) {
    const folded = file.path.toLowerCase();
    if (seen.has(folded)) throw invalid(`${file.path} appears twice (paths are compared without case)`);
    seen.add(folded);
    const parts = folded.split("/");
    for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join("/"));
  }
  for (const file of files) {
    if (directories.has(file.path.toLowerCase())) throw invalid(`${file.path} is both a file and a directory`);
  }

  const entries: PackEntry[] = [];
  let offset = 0;
  for (const file of files) {
    const bytes = data.slice(offset, offset + file.size);
    offset += file.size;
    if (sha256Hex(bytes) !== file.sha256) throw invalid(`${file.path} does not match its declared sha256`);
    entries.push({ path: file.path, bytes });
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { entries, content_sha256: sha256Hex(headerBytes) };
}

/**
 * Reads the part of a local vault that a push carries: every skill directory
 * and the vault's skillmux.toml. Anything else at the top level (a .git
 * directory, loose notes, a directory whose name is not a skill id) is left out
 * and reported in `skipped`. A symlink anywhere in what would be sent aborts
 * the push, because the server writes regular files only and silently
 * following the link would send content from outside the vault.
 */
export function readVaultForPush(vaultPath: string): { entries: PackEntry[]; skipped: string[] } {
  const entries: PackEntry[] = [];
  const skipped: string[] = [];
  let skills = 0;

  const walk = (dir: string, prefix: string) => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const relative = `${prefix}/${item.name}`;
      const absolute = join(dir, item.name);
      if (item.isSymbolicLink()) throw new Error(`${relative} is a symlink; a pushed vault may contain regular files only`);
      if (item.isDirectory()) walk(absolute, relative);
      else if (item.isFile()) entries.push({ path: relative, bytes: new Uint8Array(readFileSync(absolute)) });
      else throw new Error(`${relative} is not a regular file`);
    }
  };

  for (const item of readdirSync(vaultPath, { withFileTypes: true })) {
    const absolute = join(vaultPath, item.name);
    if (item.name === VAULT_MANIFEST && !lstatSync(absolute).isDirectory()) {
      if (lstatSync(absolute).isSymbolicLink()) throw new Error(`${item.name} is a symlink; a pushed vault may contain regular files only`);
      entries.push({ path: item.name, bytes: new Uint8Array(readFileSync(absolute)) });
      continue;
    }
    if (!SKILL_ID_PATTERN.test(item.name) || (!item.isDirectory() && !item.isSymbolicLink())) {
      skipped.push(item.name);
      continue;
    }
    if (item.isSymbolicLink()) throw new Error(`${item.name} is a symlink; a pushed vault may contain regular files only`);
    skills++;
    walk(absolute, item.name);
  }

  if (skills === 0) throw new Error(`${vaultPath} has no skills to push`);
  return { entries, skipped };
}
