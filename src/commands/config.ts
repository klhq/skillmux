import { expandHome, migrateLegacyPaths, resolveConfigPath } from "../config";
import { type ContextAdapter } from "../adapters";
import { type ResolvedContext } from "../context";
import { applyConfigInit, planConfigInit, type ConfigInitPlan } from "../setup";
import { emitSuccess, isInteractive, renderContextBanner, unknownSubcommandError } from "../output";
import { confirmAction } from "./shared";
import { isGlobalFlag } from "../global-flags";
function emitConfigInitOutcome(
  ctx: { isJson: boolean },
  opts: {
    phase: "plan" | "result";
    dryRun: boolean;
    applied: boolean;
    plan: ConfigInitPlan;
    action: "create" | "preserve";
    text: string;
  },
): void {
  if (ctx.isJson) {
    console.log(
      JSON.stringify({
        schema_version: 1,
        ok: true,
        command: "config init",
        phase: opts.phase,
        dry_run: opts.dryRun,
        applied: opts.applied,
        plan: {
          config_path: opts.plan.configPath,
          vault_path: opts.plan.vaultPath,
          action: opts.action,
        },
      }),
    );
    return;
  }
  console.log(opts.text);
}

export async function handleConfigCommand(
  adapter: ContextAdapter,
  sub: string,
  args: string[],
  ctx: { context: ResolvedContext; isJson: boolean; dryRun: boolean },
) {
  if (sub === "init") {
    let vaultPath: string | undefined;
    let yes = false;
    for (let i = 0; i < args.length; i++) {
      const option = args[i];
      if (option === "--vault") {
        vaultPath = args[++i];
        if (!vaultPath)
          throw new Error("usage: skillmux config init --vault <path> --yes");
      } else if (option === "--yes") {
        yes = true;
      } else if (isGlobalFlag(option, "--dry-run", "--json")) {
        continue;
      } else {
        throw new Error(`unknown config init option: ${option}`);
      }
    }
    if (!vaultPath) {
      if (isInteractive() && !ctx.isJson) {
        vaultPath = "~/skills";
      } else {
        throw new Error("usage: skillmux config init --vault <path> --yes");
      }
    }

    migrateLegacyPaths();
    const plan = planConfigInit(resolveConfigPath(), expandHome(vaultPath));
    if (plan.action === "preserve") {
      emitConfigInitOutcome(ctx, {
        phase: "result",
        dryRun: ctx.dryRun,
        applied: false,
        plan,
        action: "preserve",
        text: `preserved existing config: ${plan.configPath}`,
      });
      return;
    }
    if (ctx.dryRun) {
      emitConfigInitOutcome(ctx, {
        phase: "plan",
        dryRun: true,
        applied: false,
        plan,
        action: "create",
        text: `config create: ${plan.configPath} (dry-run)`,
      });
      return;
    }
    if (!yes) {
      if (!ctx.isJson && isInteractive()) {
        if (
          !(await confirmAction(
            `create ${plan.configPath} with vault_path ${plan.vaultPath}?`,
          ))
        ) {
          console.log("config init cancelled; nothing written");
          return;
        }
      } else {
        throw new Error(
          "config initialization requires --yes in noninteractive mode",
        );
      }
    }

    const result = applyConfigInit(plan);
    emitConfigInitOutcome(ctx, {
      phase: "result",
      dryRun: false,
      applied: result === "created",
      plan,
      action: plan.action,
      text:
        result === "created"
          ? `created ${plan.configPath}`
          : `preserved existing config: ${plan.configPath}`,
    });
    return;
  }

  if (sub === "show") {
    const withSources = args.includes("--sources");
    const data = await adapter.getConfigShow();
    emitSuccess({ isJson: ctx.isJson, context: ctx.context }, data, () => {
      renderContextBanner(ctx.context);
      if (withSources) {
        const policy =
          data.effective.config?.environment_overrides === false
            ? "strict (TOML authoritative)"
            : "permissive (environment overrides enabled)";
        console.log(`Policy: ${policy}`);
        console.log("\nSources:");
        for (const [k, src] of Object.entries(data.sources)) {
          console.log(`  ${k}: ${src}`);
        }
        console.log("\nEffective Configuration:");
      }
      console.log(JSON.stringify(data.effective, null, 2));
    });
    return;
  }

  if (sub === "get") {
    const key = args[0];
    if (!key) throw new Error("usage: skillmux config get <key>");
    const val = await adapter.getConfigGet(key);
    emitSuccess(
      { isJson: ctx.isJson, context: ctx.context },
      { key, value: val },
      () => {
        console.log(
          typeof val === "object" ? JSON.stringify(val) : String(val),
        );
      },
    );
    return;
  }

  if (sub === "validate") {
    const res = await adapter.configValidate();
    emitSuccess({ isJson: ctx.isJson, context: ctx.context }, res, () => {
      console.log(res.valid ? "configuration is valid" : "configuration is invalid");
    });
    return;
  }

  if (sub === "diff") {
    const res = await adapter.configDiff();
    emitSuccess({ isJson: ctx.isJson, context: ctx.context }, res, () => {
      renderContextBanner(ctx.context);
      console.log(JSON.stringify(res.diff, null, 2));
    });
    return;
  }

  if (sub === "set") {
    const key = args[0];
    const value = args[1];
    if (!key || value === undefined) {
      throw new Error("usage: skillmux config set <key> <value> [--dry-run]");
    }
    const res = await adapter.configSet(key, value, { dryRun: ctx.dryRun });
    emitSuccess({ isJson: ctx.isJson, context: ctx.context }, res, () => {
      renderContextBanner(ctx.context);
      const prefix = ctx.dryRun ? "[dry-run] " : "";
      console.log(
        `${prefix}${key}: ${JSON.stringify(res.prior_val)} -> ${JSON.stringify(res.resulting_val)}`,
      );
      console.log(
        `Persistence: ${res.persistence}, Application: ${res.application}`,
      );
    });
    return;
  }

  if (sub === "status") {
    const res = await adapter.configStatus();
    emitSuccess({ isJson: ctx.isJson, context: ctx.context }, res, () => {
      renderContextBanner(ctx.context);
      console.log(`runtime: ${res.runtime}`);
      console.log(`deployment runtime: ${res.deployment_runtime}`);
      console.log(`image variant: ${res.image_variant ?? "none"}`);
      console.log(`active revision: ${res.active_revision}`);
      console.log(`readiness: ${res.readiness.status}`);
    });
    return;
  }

  throw unknownSubcommandError("config", sub, [
    "init",
    "show",
    "get",
    "set",
    "validate",
    "diff",
    "status",
  ]);
}
