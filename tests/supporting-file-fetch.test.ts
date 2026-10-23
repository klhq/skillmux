import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeRuntime, configure, fetchSkill } from "../src/router-core";
import type { Config } from "../src/types";
import { sha256Hex } from "../src/vault";

const cleanupDirs: string[] = [];
afterEach(() => {
  closeRuntime();
  for (const dir of cleanupDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const tmp = mkdtempSync(join(tmpdir(), "skillmux-file-fetch-"));
  cleanupDirs.push(tmp);
  const vault = join(tmp, "vault");
  const local = join(tmp, "local");
  const skill = join(vault, "test-skill");
  mkdirSync(join(skill, "references"), { recursive: true });
  mkdirSync(local);
  writeFileSync(join(skill, "SKILL.md"), "---\nname: test-skill\ndescription: Test references.\n---\nRead references/notes.md.\n");
  const config: Config = {
    vault_path: vault, local_vault_paths: [local], agents: [], state_dir: join(tmp, "state"),
    recall: { k_lexical: 15, k_vector: 15, k_rerank: 10 },
    output: { top_k: 10, max_top_k: 50 },
    inference: { mode: "remote", timeout_ms: 200,
      embedding: { provider: "openai", endpoint: "http://127.0.0.1:9/v1/embeddings", model: "test", dimension: 3 } },
  };
  configure({ config, clients: { embed: async (texts) => texts.map(() => new Float32Array(3)) } });
  return { tmp, vault, local, skill, config };
}

describe("supporting-file fetch", () => {
  test("delivers one listed reference verbatim with the hash of its current bytes", async () => {
    const { skill } = fixture();
    const bytes = Buffer.from("\uFEFF# 筆記\r\n保持原文。\r\n");
    writeFileSync(join(skill, "references/notes.md"), bytes);

    const result = await fetchSkill({ skill_id: "test-skill", path: "references/notes.md" });

    expect(result.body).toBe(bytes.toString("utf8"));
    expect(result.content_sha256).toBe(sha256Hex(bytes));
    expect(result.path).toBe("references/notes.md");
    expect(result.byte_length).toBe(bytes.length);
  });

  test("rejects noncanonical paths and files outside the supporting-file allowlist", async () => {
    const { tmp, skill } = fixture();
    writeFileSync(join(tmp, "secret.txt"), "private");
    writeFileSync(join(skill, "references/notes.md"), "notes");
    writeFileSync(join(skill, ".skillmux-origin"), "provenance");
    symlinkSync(join(tmp, "secret.txt"), join(skill, "references/link.txt"));
    symlinkSync(tmp, join(skill, "external"));
    symlinkSync(join(skill, "references/notes.md"), join(skill, "references/internal-link.txt"));
    const paths = ["../secret.txt", "references/../SKILL.md", "/etc/passwd", "C:/secret.txt",
      "references\\notes.md", "", ".", "references/./notes.md", "references//notes.md", "references/notes.md/",
      "references/notes.md\0", "SKILL.md", ".skillmux-origin", "references", "missing.md",
      "references/link.txt", "references/internal-link.txt", "external/secret.txt"];

    for (const path of paths) {
      await expect(fetchSkill({ skill_id: "test-skill", path })).rejects.toThrow(/(?:INVALID_FILE_PATH|FILE_NOT_FOUND):/);
    }
  });

  test("enforces the byte limit without truncating and rejects binary or invalid UTF-8 content", async () => {
    const { skill } = fixture();
    const path = "references/notes.md";
    for (const bytes of [Buffer.alloc(0), Buffer.alloc(262144, 0x61)]) {
      writeFileSync(join(skill, path), bytes);
      const result = await fetchSkill({ skill_id: "test-skill", path });
      expect(result.body).toBe(bytes.toString("utf8"));
      expect(result.byte_length).toBe(bytes.length);
    }
    writeFileSync(join(skill, path), Buffer.alloc(262145, 0x61));
    await expect(fetchSkill({ skill_id: "test-skill", path })).rejects.toThrow("FILE_TOO_LARGE:");
    for (const bytes of [Buffer.from([0xc3, 0x28]), Buffer.from("PNG\0payload"), Buffer.from([0x01, 0x02])]) {
      writeFileSync(join(skill, path), bytes);
      await expect(fetchSkill({ skill_id: "test-skill", path })).rejects.toThrow("FILE_NOT_TEXT:");
    }
  });

  test("uses the selected skill's override and current bytes without falling back for a missing attachment", async () => {
    const { skill, local } = fixture();
    writeFileSync(join(skill, "references/notes.md"), "upstream");
    writeFileSync(join(skill, "upstream-only.txt"), "must not leak across roots");
    const override = join(local, "test-skill");
    mkdirSync(join(override, "references"), { recursive: true });
    writeFileSync(join(override, "SKILL.md"), "---\nname: local-title\n---\nLocal override.");
    writeFileSync(join(override, "references/notes.md"), "local");
    const input = { skill_id: "test-skill", path: "references/notes.md" };

    expect(await fetchSkill(input)).toMatchObject({ body: "local", title: "local-title" });
    writeFileSync(join(override, input.path), "updated local");
    expect(await fetchSkill(input)).toMatchObject({ body: "updated local", content_sha256: sha256Hex("updated local") });
    await expect(fetchSkill({ skill_id: "test-skill", path: "upstream-only.txt" })).rejects.toThrow("FILE_NOT_FOUND:");
    writeFileSync(join(override, "SKILL.md"), "---\nname: broken");
    expect(await fetchSkill(input)).toMatchObject({ body: "upstream", title: "test-skill" });
    rmSync(join(override, "SKILL.md"));
    rmSync(join(skill, input.path));
    await expect(fetchSkill(input)).rejects.toThrow("FILE_NOT_FOUND:");
  });
});
