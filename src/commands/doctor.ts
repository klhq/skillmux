import { resolveConfigPath } from "../config";
import { diagnose } from "../doctor";
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
      throw new Error(`unknown doctor option: ${option}`);
    }
  }
}

export async function runDoctor(options: {
  isJson: boolean;
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
    for (const check of report.checks)
      console.log(
        `${check.ok ? green("ok") : red("fail")}: ${check.name} - ${check.detail}`,
      );
  });
  if (report.checks.some((check) => !check.ok)) process.exitCode = 1;
}
