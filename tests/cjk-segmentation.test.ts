import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ftsSearch, openIndex, replaceSkills, type SkillRow } from "../src/db";
import { segmentForFts } from "../src/fts-segment";

function skill(skill_id: string, overrides: Partial<SkillRow> = {}): SkillRow {
  return { skill_id, title: "Tool", description: "Instructions", aliases: "", content_sha256: "hash", ...overrides };
}

function withIndex(run: (db: ReturnType<typeof openIndex>) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "skillmux-cjk-"));
  const db = openIndex(dir);
  try {
    run(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("segmentForFts leaves spaced scripts and technical names untouched", () => {
  expect(segmentForFts("Deploy C++ and C# services")).toBe("Deploy C++ and C# services");
  expect(segmentForFts("서버에 애플리케이션을 배포")).toBe("서버에 애플리케이션을 배포");
});

test("segmentForFts inserts word boundaries only inside unspaced runs", () => {
  expect(segmentForFts("部署應用程式 with docker")).toMatch(/^部署 .*程式 with docker$/);
  expect(segmentForFts("審查程式碼中的安全漏洞").split(" ").length).toBeGreaterThan(1);
});

test("a short Chinese term finds a skill whose description only contains it inside a sentence", () => {
  withIndex((db) => {
    replaceSkills(db, [
      skill("audit", { description: "审查代码中的安全漏洞与注入风险" }),
      skill("notes", { description: "整理会议记录并提取行动项" }),
    ]);
    expect(ftsSearch(db, "安全漏洞", 5).map((r) => r.skill_id)).toEqual(["audit"]);
    expect(ftsSearch(db, "会议记录", 5).map((r) => r.skill_id)).toEqual(["notes"]);
  });
});

test("a Japanese sentence query matches a Japanese description through its content words", () => {
  withIndex((db) => {
    replaceSkills(db, [
      skill("ci", { description: "CIパイプラインの失敗ログを分析し、原因を特定します" }),
      skill("excel", { description: "売上データからExcelレポートを作成します" }),
    ]);
    expect(ftsSearch(db, "CIが失敗した原因を調べて", 5)[0]?.skill_id).toBe("ci");
  });
});

test("opening an index at schema version 3 re-segments existing rows", () => {
  const dir = mkdtempSync(join(tmpdir(), "skillmux-cjk-migrate-"));
  try {
    const first = openIndex(dir);
    replaceSkills(first, [skill("audit", { description: "审查代码中的安全漏洞与注入风险" })]);
    first.run("UPDATE index_meta SET value = '3' WHERE key = 'lexical_schema_version'");
    first.run("DELETE FROM skills_fts");
    first.run("INSERT INTO skills_fts (skill_id, title, description, aliases) SELECT skill_id, title, description, aliases FROM skills");
    first.close();
    const reopened = openIndex(dir);
    expect(ftsSearch(reopened, "安全漏洞", 5).map((r) => r.skill_id)).toEqual(["audit"]);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
