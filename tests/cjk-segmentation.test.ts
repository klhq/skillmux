import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ftsSearch, openIndex, replaceSkills, type SkillRow } from "../src/db";
import { toFtsQuery } from "../src/db-index";
import { SEGMENTER_VERSION, segmentForFts } from "../src/fts-segment";

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
  expect(segmentForFts("部署應用程式 with docker").split(/\s+/).filter(Boolean)).toContain("部署");
  expect(segmentForFts("部署應用程式 with docker").split(/\s+/)).toContain("docker");
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

test("an index built with a different segmenter version is rebuilt on open", () => {
  const dir = mkdtempSync(join(tmpdir(), "skillmux-cjk-icu-"));
  try {
    const first = openIndex(dir);
    replaceSkills(first, [skill("audit", { description: "审查代码中的安全漏洞与注入风险" })]);
    // Simulate rows segmented by an older ICU: the whole run is one token.
    first.run("DELETE FROM skills_fts");
    first.run("INSERT INTO skills_fts (skill_id, title, description, aliases) SELECT skill_id, title, description, aliases FROM skills");
    first.run("UPDATE index_meta SET value = 'icu-0.0' WHERE key = 'lexical_segmenter'");
    first.close();
    const reopened = openIndex(dir);
    expect(ftsSearch(reopened, "安全漏洞", 5).map((r) => r.skill_id)).toEqual(["audit"]);
    const meta = reopened.query("SELECT value FROM index_meta WHERE key = 'lexical_segmenter'").get() as { value: string };
    expect(meta.value).toBe(SEGMENTER_VERSION);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Latin words glued to Japanese text are split so they stay searchable", () => {
  const tokens = segmentForFts("PDFからテキストを抽出").split(/\s+/).filter(Boolean);
  expect(tokens).toContain("PDF");
  withIndex((db) => {
    replaceSkills(db, [skill("pdf", { description: "Extract text from PDF files" })]);
    expect(ftsSearch(db, "PDFからテキストを抽出", 5).map((r) => r.skill_id)).toEqual(["pdf"]);
  });
});

test("Japanese particles do not become query terms", () => {
  expect(toFtsQuery("CIが失敗した原因を調べて")).not.toMatch(/"が"|"を"|"て"/);
  expect(toFtsQuery("CIが失敗した原因を調べて")).toContain('"失敗"');
  expect(toFtsQuery("の")).toBeNull();
});
