import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { insertAdminAuditRow, openAudit, verifyAdminAuditChain } from "../src/db";

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

  test("should chain each row's hash to the previous row's hash, verifying intact by default", () => {
    const first = insertAdminAuditRow(db, {
      ts: "2026-08-31T00:00:00.000Z",
      changes: [{ key: "recall.k_lexical", old_value: 15, new_value: 25 }],
      resulting_revision: "rev-1",
    });
    const second = insertAdminAuditRow(db, {
      ts: "2026-08-31T00:01:00.000Z",
      changes: [{ key: "recall.k_vector", old_value: 15, new_value: 30 }],
      resulting_revision: "rev-2",
    });

    expect(first.prev_row_hash).toBeNull();
    expect(second.prev_row_hash).toBe(first.row_hash);
    expect(verifyAdminAuditChain(db)).toEqual({ valid: true, broken_at_id: null });
  });

  test("should detect a broken chain when a row is edited out-of-band", () => {
    insertAdminAuditRow(db, {
      ts: "2026-08-31T00:00:00.000Z",
      changes: [{ key: "recall.k_lexical", old_value: 15, new_value: 25 }],
      resulting_revision: "rev-1",
    });
    const second = insertAdminAuditRow(db, {
      ts: "2026-08-31T00:01:00.000Z",
      changes: [{ key: "recall.k_vector", old_value: 15, new_value: 30 }],
      resulting_revision: "rev-2",
    });

    db.run("UPDATE admin_audit SET resulting_revision = ? WHERE id = ?", ["tampered-rev", second.id]);

    expect(verifyAdminAuditChain(db)).toEqual({ valid: false, broken_at_id: second.id });
  });
});
