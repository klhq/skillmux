import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { insertAdminAuditRow, openAudit } from "../src/db";

describe("admin audit store", () => {
  let tmp: string;
  let db: Database;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "skillmux-admin-audit-test-"));
    db = openAudit(tmp);
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  test("should append an admin_audit row recording ts, changed keys with old/new values, and the resulting revision hash", () => {
    insertAdminAuditRow(db, {
      ts: "2026-08-31T00:00:00.000Z",
      changes: [{ key: "recall.k_lexical", old_value: 15, new_value: 25 }],
      resulting_revision: "revision-abc123",
    });

    const row = db.query("SELECT * FROM admin_audit").get() as any;
    expect(row).toBeTruthy();
    expect(row.ts).toBe("2026-08-31T00:00:00.000Z");
    expect(row.resulting_revision).toBe("revision-abc123");
    expect(JSON.parse(row.changes)).toEqual([
      { key: "recall.k_lexical", old_value: 15, new_value: 25 },
    ]);
  });
});
