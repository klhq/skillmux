import type { Database } from "bun:sqlite";
import { expandHome } from "./config";
import { insertAdminAuditRow } from "./db";
import type { Config, VaultPushConfig } from "./types";
import { DEFAULT_PACK_LIMITS, PACK_CONTENT_TYPE, type PackLimits } from "./vault-pack";
import { vaultLock } from "./vault-lock";
import { applyVaultPush, VaultPushError, type VaultPushErrorCode } from "./vault-push";
import { sha256Hex } from "./vault";

/** The pack header may be up to 4 MiB on top of the content the byte limit covers. */
export const PUSH_HEADER_ALLOWANCE = 4 * 1024 * 1024;

export interface VaultPushEndpointDeps {
  config: Pick<Config, "vault_path" | "vault_url">;
  /** The server.admin.vault_push block, or undefined when the admin API is off. */
  settings: VaultPushConfig | undefined;
  auditDb: Database;
  pauseWatcher: () => () => void;
  reindex: () => Promise<void>;
  redact: (text: string) => string;
  warn: (message: string) => void;
}

export interface EndpointResponse {
  status: number;
  body: Record<string, unknown>;
}

const STATUS_FOR: Record<VaultPushErrorCode, number> = {
  INVALID_PACK: 400,
  PACK_TOO_LARGE: 413,
  SCAN_REJECTED: 422,
  VAULT_MANAGED_BY_GIT: 409,
  IO_ERROR: 500,
};

/** Largest body this endpoint will read, which the server also uses as its request body ceiling. */
export function vaultPushBodyLimit(settings: VaultPushConfig | undefined): number {
  if (!settings?.enabled) return 0;
  return (settings.max_bytes ?? DEFAULT_PACK_LIMITS.maxTotalBytes) + PUSH_HEADER_ALLOWANCE;
}

export function vaultPushLimits(settings: VaultPushConfig): PackLimits {
  const maxTotalBytes = settings.max_bytes ?? DEFAULT_PACK_LIMITS.maxTotalBytes;
  return {
    maxFiles: DEFAULT_PACK_LIMITS.maxFiles,
    maxFileBytes: Math.min(DEFAULT_PACK_LIMITS.maxFileBytes, maxTotalBytes),
    maxTotalBytes,
  };
}

let pushInProgress = false;

/**
 * Handles POST /admin/v1/vault. The caller has already checked the admin
 * token. Every attempt that gets as far as reading a pack leaves a row in the
 * tamper-evident admin_audit chain, whether it was applied, rejected or only a
 * dry run, so an operator can see who changed the served vault and to what.
 */
export async function handleVaultPush(req: Request, url: URL, deps: VaultPushEndpointDeps): Promise<EndpointResponse> {
  const { settings } = deps;
  if (!settings?.enabled) {
    return {
      status: 403,
      body: { error: "VAULT_PUSH_DISABLED", message: "Vault push is off. Set server.admin.vault_push.enabled = true to allow it." },
    };
  }
  if (deps.config.vault_url !== undefined) {
    return {
      status: 409,
      body: {
        error: "VAULT_MANAGED_BY_GIT",
        message: "This server pulls its vault from vault_url. Push to that remote instead of to the server.",
      },
    };
  }
  if (!(req.headers.get("content-type") ?? "").startsWith(PACK_CONTENT_TYPE)) {
    return { status: 415, body: { error: "UNSUPPORTED_MEDIA_TYPE", message: `Content-Type must be ${PACK_CONTENT_TYPE}` } };
  }
  const ceiling = vaultPushBodyLimit(settings);
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > ceiling) {
    return { status: 413, body: { error: "PACK_TOO_LARGE", message: `Push bodies are limited to ${ceiling} bytes` } };
  }
  if (pushInProgress) {
    return { status: 409, body: { error: "PUSH_IN_PROGRESS", message: "Another vault push is running. Try again when it finishes." } };
  }

  pushInProgress = true;
  const dryRun = url.searchParams.get("dry_run") === "1" || url.searchParams.get("dry_run") === "true";
  let bodySha256 = "";
  let outcome = "";
  let detail: Record<string, unknown> = {};
  let revision = "unchanged";
  try {
    const body = new Uint8Array(await req.arrayBuffer());
    bodySha256 = sha256Hex(body);
    if (body.length > ceiling) {
      outcome = "PACK_TOO_LARGE";
      return { status: 413, body: { error: outcome, message: `Push bodies are limited to ${ceiling} bytes` } };
    }
    try {
      const result = await applyVaultPush(body, {
        vaultPath: expandHome(deps.config.vault_path),
        limits: vaultPushLimits(settings),
        failOn: settings.fail_on === "none" ? undefined : (settings.fail_on ?? "high"),
        dryRun,
        exclusive: (fn) =>
          vaultLock.write(async () => {
            const resume = deps.pauseWatcher();
            try {
              return await fn();
            } finally {
              resume();
            }
          }),
        reindex: deps.reindex,
        warn: deps.warn,
      });
      outcome = result.status;
      detail = { content_sha256: result.content_sha256, skills: result.skills.length, files: result.files, bytes: result.bytes, findings: result.findings.length };
      if (result.status === "replaced") revision = result.content_sha256;
      return { status: 200, body: { ...result } };
    } catch (error) {
      if (!(error instanceof VaultPushError)) throw error;
      outcome = error.code;
      detail = { reason: deps.redact(error.message), ...(error.findings ? { findings: error.findings.length } : {}) };
      return {
        status: STATUS_FOR[error.code],
        body: {
          error: error.code,
          message: deps.redact(error.message),
          ...(error.findings ? { findings: error.findings } : {}),
        },
      };
    }
  } finally {
    pushInProgress = false;
    if (outcome !== "") {
      try {
        insertAdminAuditRow(deps.auditDb, {
          ts: new Date().toISOString(),
          changes: [{ key: "vault.push", old_value: null, new_value: { outcome, dry_run: dryRun, body_sha256: bodySha256, ...detail } }],
          resulting_revision: revision,
        });
      } catch (error) {
        deps.warn(`vault push: could not write the audit row: ${error instanceof Error ? error.message : error}`);
      }
    }
  }
}
