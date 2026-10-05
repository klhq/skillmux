import { unknownOptionError } from "../arg-errors";
import { resolveConfigPath } from "../config";
import { diagnose, type DoctorCheck } from "../doctor";
import { getEffectiveConfig } from "../config-service";
import type { ContextAdapter } from "../adapters";
import type { ResolvedContext } from "../context";
import { isGlobalFlag, isGlobalFlagWithValue } from "../global-flags";
import {
  emitSuccess,
  green,
  red,
  renderContextBanner,
} from "../output";

/**
 * doctor takes no options of its own, but it still has to reject unknown ones
 * rather than silently ignoring them the way every other command does.
 */
export function parseDoctorArgs(args: readonly string[]): void {
  for (let i = 0; i < args.length; i++) {
    const option = args[i];
    if (isGlobalFlag(option, "--json", "--allow-insecure", "--verbose")) {
      // handled globally by main(); recognized here so it isn't rejected
    } else if (isGlobalFlagWithValue(option)) {
      // handled globally by main()'s resolveContext(); skip its value too
      i++;
    } else {
      throw unknownOptionError("doctor", option);
    }
  }
}

const CONFIG_SOURCE_PREFIX = "config_source:";
const SOURCE_ORDER = ["environment", "toml", "default"];

function formatCheck(check: DoctorCheck): string {
  return `${check.ok ? green("ok") : red("fail")}: ${check.name} - ${check.detail}`;
}

/**
 * Human-readable check lines: failures first, so the thing to fix is never
 * buried, then passing checks, then a tally. The per-key config_source checks
 * are pure provenance (33 near-identical lines), so they collapse into one
 * count by source unless `verbose`. An environment override stays visible in
 * that count. The JSON report always carries every check.
 */
export function renderChecks(checks: readonly DoctorCheck[], verbose: boolean): string[] {
  const isSource = (check: DoctorCheck) => check.ok && check.name.startsWith(CONFIG_SOURCE_PREFIX);
  const sources = verbose ? [] : checks.filter(isSource);
  const shown = checks.filter((check) => verbose || !isSource(check));
  const lines = [
    ...shown.filter((check) => !check.ok).map(formatCheck),
    ...shown.filter((check) => check.ok).map(formatCheck),
  ];

  if (sources.length > 0) {
    const counts = new Map<string, number>();
    for (const check of sources) counts.set(check.detail, (counts.get(check.detail) ?? 0) + 1);
    const ordered = [...counts.entries()].sort(([a], [b]) => {
      const ai = SOURCE_ORDER.indexOf(a);
      const bi = SOURCE_ORDER.indexOf(b);
      return (ai === -1 ? SOURCE_ORDER.length : ai) - (bi === -1 ? SOURCE_ORDER.length : bi) || a.localeCompare(b);
    });
    const breakdown = ordered.map(([source, n]) => `${source}: ${n}`).join(", ");
    lines.push(`${green("ok")}: config sources - ${sources.length} ${sources.length === 1 ? "key" : "keys"} (${breakdown}); --verbose lists each`);
  }

  const failed = checks.filter((check) => !check.ok).length;
  lines.push(
    failed === 0
      ? `${checks.length} checks passed`
      : `${red(`${failed} of ${checks.length} checks failed`)}`,
  );
  return lines;
}

export async function runDoctor(options: {
  isJson: boolean;
  verbose?: boolean;
  context: ResolvedContext;
  adapter: ContextAdapter;
  args?: readonly string[];
}): Promise<void> {
  parseDoctorArgs(options.args ?? []);
  if (options.context.type === "remote") {
    const context = options.context;
    const [status, caps] = await Promise.all([
      options.adapter.configStatus(),
      options.adapter.getCapabilities(),
    ]);
    const remoteReport = {
      target: context.name || context.server,
      server: context.server,
      version: status.version,
      deployment_runtime: status.deployment_runtime,
      image_variant: status.image_variant ?? null,
      runtime: status.runtime,
      readiness: status.readiness,
      active_revision: status.active_revision,
      capabilities: caps,
      restart_required_keys: status.restart_required_keys,
      last_reload_error: status.last_reload_error,
    };
    emitSuccess({ isJson: options.isJson, target: options.context }, remoteReport, () => {
      renderContextBanner(options.context);
      console.log(`server: ${remoteReport.server}`);
      console.log(`version: ${remoteReport.version}`);
      console.log(`deployment runtime: ${remoteReport.deployment_runtime}`);
      console.log(`image variant: ${remoteReport.image_variant ?? "none"}`);
      console.log(`runtime: ${remoteReport.runtime}`);
      console.log(`readiness: ${remoteReport.readiness.status} (${remoteReport.readiness.capability})`);
      console.log(`active revision: ${remoteReport.active_revision}`);
      console.log(`persistence: ${caps.persistence}`);
      console.log(`config read: ${caps.config_read}`);
      console.log(`config write: ${caps.config_write}`);
      if (status.last_reload_error) {
        console.log(`last reload error: ${status.last_reload_error}`);
      }
      if (status.restart_required_keys.length > 0) {
        console.log(`restart required for: ${status.restart_required_keys.join(", ")}`);
      }
    });
    return;
  }

  const effective = await getEffectiveConfig(resolveConfigPath());
  const report = await diagnose(effective.effective, process.env, effective.sources);
  emitSuccess({ isJson: options.isJson }, report, () => {
    console.log(`version: ${report.version}`);
    console.log(`runtime: ${report.runtime}`);
    console.log(`image variant: ${report.image_variant ?? "none"}`);
    console.log(`vault path: ${report.vault_path}`);
    console.log(`state directory: ${report.state_dir}`);
    console.log(`inference mode: ${report.mode}`);
    console.log(`routing capability: ${report.capability}`);
    console.log(`retrieval capability: ${report.retrieval_capability}`);
    for (const line of renderChecks(report.checks, options.verbose ?? false)) console.log(line);
  });
  if (report.checks.some((check) => !check.ok)) process.exitCode = 1;
}
