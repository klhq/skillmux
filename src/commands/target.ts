import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { expandHome } from "../config";
import {
  BUILT_IN_TARGET_NAMES,
  planAgentSurfaces,
  resolveBuiltInTarget,
  SUPPORTED_AGENT_IDS,
} from "../init-agents";
import { planInitManifest, applyInit } from "../init";
import { resolveTargetDir, writeManifestAtomic } from "../manifest";
import { emitSuccess, unknownSubcommandError } from "../output";
import { applyTargetMarkerRehome, planTargetMarkerRehome, resolveProjectPinDir } from "../sync";
import { confirmIfNeeded, loadManifestContext } from "./shared";

export async function runTarget(
  subCommand: string,
  args: string[],
  options: { isJson: boolean; dryRun: boolean },
): Promise<void> {
  const { config, vaultPath, manifestPath, manifest } = await loadManifestContext();

  if (subCommand === "list" || subCommand === "show") {
    const names =
      subCommand === "show" ? [args[0] ?? ""] : Object.keys(manifest.targets);
    if (subCommand === "show" && !manifest.targets[names[0]!]) {
      throw new Error(`target "${names[0]}" does not exist`);
    }
    const targets = names.map((name) => {
      const target = manifest.targets[name]!;
      const agents = SUPPORTED_AGENT_IDS.filter((agent) => {
        const surface = planAgentSurfaces([agent]).surfaces[0];
        return surface !== undefined && surface.path === resolveTargetDir(name, target);
      });
      return { name, ...target, dir: resolveTargetDir(name, target), agents };
    });
    emitSuccess({ isJson: options.isJson }, { targets }, () => {
      if (targets.length === 0) {
        console.log("no targets configured");
      } else {
        for (const target of targets) {
          console.log(`${target.name}:`);
          console.log(`  dir: ${target.dir}`);
          console.log(`  host: ${target.host ?? "(global)"}`);
          console.log(`  agents: ${target.agents.join(", ") || "(custom)"}`);
          console.log(
            `  projects: ${target.project_groups.join(", ") || "(none)"}`,
          );
        }
      }
    });
    return;
  }

  if (subCommand === "add") {
    const name = args[0];
    const dirIndex = args.indexOf("--dir");
    const rawPath = dirIndex === -1 ? undefined : args[dirIndex + 1];
    if (!name)
      throw new Error("usage: skillmux target add <name> --dir <dir> --yes");

    let path: string;
    if (rawPath) {
      path = expandHome(rawPath);
    } else if (BUILT_IN_TARGET_NAMES.has(name)) {
      path = resolveBuiltInTarget(name, {
        codexHome: process.env.CODEX_HOME ? expandHome(process.env.CODEX_HOME) : undefined,
      }).path;
    } else {
      throw new Error(
        "usage: skillmux target add <name> --dir <dir> --yes  (--dir may be omitted for built-in target names: agent-skills, claude-code, codex)",
      );
    }
    if (options.dryRun) {
      const planned = planInitManifest(vaultPath, [{ name, dir: path }], []);
      emitSuccess(
        { isJson: options.isJson },
        { target: planned.targets[name] },
        () => console.log(`target add: ${name} -> ${path} (dry-run)`),
      );
      return;
    }
    if (
      !(await confirmIfNeeded({
        confirmed: args.includes("--yes"),
        isJson: options.isJson,
        prompt: `adopt target ${name} at ${path}?`,
        nonInteractiveError:
          "skillmux target add requires --yes when run non-interactively",
      }))
    )
      return;
    applyInit(vaultPath, [{ name, dir: path }]);
    emitSuccess({ isJson: options.isJson }, { name, dir: path }, () =>
      console.log(`target "${name}" added at ${path}`),
    );
    return;
  }

  if (subCommand === "remove") {
    const name = args[0];
    if (!name || !manifest.targets[name]) {
      throw new Error(
        name
          ? `target "${name}" does not exist`
          : "usage: skillmux target remove <name> --yes",
      );
    }
    if (options.dryRun) {
      emitSuccess(
        { isJson: options.isJson },
        { name, preserved_dir: resolveTargetDir(name, manifest.targets[name]!) },
        () => console.log(`target remove: ${name} (files preserved, dry-run)`),
      );
      return;
    }
    if (
      !(await confirmIfNeeded({
        confirmed: args.includes("--yes"),
        isJson: options.isJson,
        prompt: `remove target ${name} from the manifest and preserve its files?`,
        nonInteractiveError:
          "skillmux target remove requires --yes when run non-interactively",
      }))
    )
      return;
    const targets = { ...manifest.targets };
    const removedDir = resolveTargetDir(name, manifest.targets[name]!);
    delete targets[name];
    writeManifestAtomic(manifestPath, { ...manifest, targets });
    emitSuccess(
      { isJson: options.isJson },
      { name, preserved_dir: removedDir },
      () =>
        console.log(
          `target "${name}" removed from the manifest; files preserved at ${removedDir}`,
        ),
    );
    return;
  }

  if (subCommand === "rehome") {
    const name = args[0];
    const target = name ? manifest.targets[name] : undefined;
    if (!name || !target) {
      throw new Error(name ? `target "${name}" does not exist` : "usage: skillmux target rehome <name> --yes");
    }
    if (target.host !== undefined && target.host !== hostname()) {
      throw new Error(`target "${name}" is scoped to host ${target.host}, not ${hostname()}`);
    }

    const targetDir = resolveTargetDir(name, target);
    if (!existsSync(targetDir)) throw new Error(`target "${name}" directory does not exist: ${targetDir}`);
    const dirs = [targetDir];
    for (const groupName of target.project_groups) {
      const group = manifest.project?.[groupName];
      if (!group) continue;
      for (const projectPath of group.paths) {
        if (!existsSync(projectPath)) continue;
        const pinDir = resolveProjectPinDir(targetDir, projectPath);
        if (existsSync(pinDir)) dirs.push(pinDir);
      }
    }
    const plans = dirs.map((dir) =>
      planTargetMarkerRehome(dir, name, vaultPath, config.local_vault_paths.map(expandHome)),
    );
    const markerPaths = plans.map((plan) => plan.markerPath);
    if (options.dryRun) {
      emitSuccess(
        { isJson: options.isJson },
        { name, marker_paths: markerPaths },
        () => console.log(`target rehome: ${name} (${markerPaths.length} markers, dry-run)`),
      );
      return;
    }
    if (
      !(await confirmIfNeeded({
        confirmed: args.includes("--yes"),
        isJson: options.isJson,
        prompt: `rehome ${markerPaths.length} ${name} marker(s) to ${vaultPath}?`,
        nonInteractiveError: "skillmux target rehome requires --yes when run non-interactively",
      }))
    )
      return;
    applyTargetMarkerRehome(plans, vaultPath);
    emitSuccess(
      { isJson: options.isJson },
      { name, marker_paths: markerPaths },
      () => console.log(`target "${name}" rehomed ${markerPaths.length} marker(s) to ${vaultPath}`),
    );
    return;
  }

  if (subCommand === "migrate") {
    const builtInTargets = Object.entries(manifest.targets).filter(([name]) =>
      BUILT_IN_TARGET_NAMES.has(name),
    );
    if (options.dryRun) {
      emitSuccess(
        { isJson: options.isJson },
        { migrated_targets: builtInTargets.map(([name]) => name) },
        () => console.log(`target migrate: ${builtInTargets.length} built-in target(s) (dry-run)`),
      );
      return;
    }
    if (
      !(await confirmIfNeeded({
        confirmed: args.includes("--yes"),
        isJson: options.isJson,
        prompt: `remove redundant dir fields from ${builtInTargets.length} built-in target(s)?`,
        nonInteractiveError: "skillmux target migrate requires --yes when run non-interactively",
      }))
    )
      return;
    writeManifestAtomic(manifestPath, manifest);
    emitSuccess(
      { isJson: options.isJson },
      { migrated_targets: builtInTargets.map(([name]) => name) },
      () => console.log(`target migrate: normalized ${builtInTargets.length} built-in target(s)`),
    );
    return;
  }

  throw unknownSubcommandError("target", subCommand, ["list", "show", "add", "remove", "rehome", "migrate"]);
}
