import { existsSync } from "node:fs";
import { rollbackConfigAgents, writeConfigAgents, type ConfigAgentsWrite } from "../agents-config";
import { expandHome, loadConfig, resolveConfigPath } from "../config";
import { adoptSurfaces } from "../init";
import { isAgentId, planAgentSurfaces, SUPPORTED_AGENT_IDS, type AgentId } from "../init-agents";
import { parseManifest, resolveManifestPath, resolveSyncSurfaces } from "../manifest";
import { emitSuccess, unknownSubcommandError } from "../output";
import {
  applyTargetMarkerRehome,
  planTargetMarkerRehome,
  readSkillmuxMarker,
  resolveProjectPinDir,
} from "../sync";
import { confirmIfNeeded } from "./shared";
import { executeSync } from "./sync";

function parseAgentIds(args: string[], usage: string): AgentId[] {
  const ids = args.filter((arg) => !arg.startsWith("--"));
  if (ids.length === 0) throw new Error(usage);
  for (const id of ids) {
    if (!isAgentId(id)) {
      throw new Error(`unsupported agent "${id}"; supported agents: ${SUPPORTED_AGENT_IDS.join(", ")}`);
    }
  }
  return [...new Set(ids as AgentId[])];
}

function dirState(dir: string): "managed" | "missing" | "unmanaged" {
  if (!existsSync(dir)) return "missing";
  return readSkillmuxMarker(dir)?.role === "target" ? "managed" : "unmanaged";
}

export async function runAgent(
  subCommand: string,
  args: string[],
  options: { isJson: boolean; dryRun: boolean },
): Promise<void> {
  const config = await loadConfig();
  const configPath = resolveConfigPath();
  const vaultPath = expandHome(config.vault_path);

  if (subCommand === "list") {
    const dirs = planAgentSurfaces(config.agents).surfaces.map((surface) => ({
      dir: surface.path,
      agents: surface.agents,
      state: dirState(surface.path),
    }));
    emitSuccess({ isJson: options.isJson }, { agents: config.agents, dirs }, () => {
      if (dirs.length === 0) {
        console.log(`no agents configured in ${configPath}`);
        return;
      }
      for (const dir of dirs) {
        console.log(`${dir.dir} (${dir.agents.join(", ")}): ${dir.state}`);
      }
    });
    return;
  }

  if (subCommand === "add") {
    const requested = parseAgentIds(args, "usage: skillmux agent add <agent>... --yes [--no-sync]");
    const nextAgents = [...new Set([...config.agents, ...requested])];
    const known = new Set(planAgentSurfaces(config.agents).surfaces.map((surface) => surface.path));
    const newSurfaces = planAgentSurfaces(nextAgents).surfaces.filter((surface) => !known.has(surface.path));
    if (options.dryRun) {
      emitSuccess(
        { isJson: options.isJson },
        { agents: nextAgents, new_dirs: newSurfaces.map((surface) => surface.path) },
        () => console.log(`agent add: agents = [${nextAgents.join(", ")}] (dry-run)`),
      );
      return;
    }
    const newDirs = newSurfaces.map((surface) => surface.path);
    if (
      !(await confirmIfNeeded({
        confirmed: args.includes("--yes"),
        isJson: options.isJson,
        prompt:
          `add ${requested.join(", ")} to ${configPath}` +
          (newDirs.length > 0 ? ` and manage ${newDirs.join(", ")}?` : "?"),
        nonInteractiveError: "skillmux agent add requires --yes when run non-interactively",
      }))
    )
      return;

    let write: ConfigAgentsWrite | undefined;
    adoptSurfaces(
      vaultPath,
      newSurfaces.map((surface) => ({ name: surface.id, dir: surface.path })),
      {
        apply: () => {
          write = writeConfigAgents(configPath, nextAgents);
        },
        rollback: () => {
          if (write) rollbackConfigAgents(write);
        },
      },
    );
    if (!options.isJson) console.log(`agents = [${nextAgents.join(", ")}] in ${configPath}`);

    const synced = args.includes("--no-sync")
      ? undefined
      : await executeSync({
          config: { ...config, agents: nextAgents },
          yes: true,
          log: options.isJson ? undefined : (line: string) => console.log(line),
        });
    emitSuccess(
      { isJson: options.isJson },
      { agents: nextAgents, new_dirs: newDirs, synced: synced !== undefined, dirs: synced?.dirs ?? [] },
      () => {},
    );
    return;
  }

  if (subCommand === "remove") {
    const requested = parseAgentIds(args, "usage: skillmux agent remove <agent>... --yes");
    const missing = requested.filter((agent) => !config.agents.includes(agent));
    if (missing.length > 0) {
      throw new Error(`not configured in ${configPath}: ${missing.join(", ")}`);
    }
    const nextAgents = config.agents.filter((agent) => !requested.includes(agent));
    const remaining = new Set(planAgentSurfaces(nextAgents).surfaces.map((surface) => surface.path));
    const released = planAgentSurfaces(config.agents)
      .surfaces.filter((surface) => !remaining.has(surface.path))
      .map((surface) => surface.path);
    if (options.dryRun) {
      emitSuccess(
        { isJson: options.isJson },
        { agents: nextAgents, released_dirs: released },
        () => console.log(`agent remove: agents = [${nextAgents.join(", ")}] (dry-run)`),
      );
      return;
    }
    if (
      !(await confirmIfNeeded({
        confirmed: args.includes("--yes"),
        isJson: options.isJson,
        prompt: `remove ${requested.join(", ")} from ${configPath}? (files are left in place)`,
        nonInteractiveError: "skillmux agent remove requires --yes when run non-interactively",
      }))
    )
      return;
    writeConfigAgents(configPath, nextAgents);
    emitSuccess(
      { isJson: options.isJson },
      { agents: nextAgents, released_dirs: released },
      () => {
        console.log(`agents = [${nextAgents.join(", ")}] in ${configPath}`);
        for (const dir of released) {
          console.log(`no longer synced, files left in place: ${dir}`);
        }
      },
    );
    return;
  }

  if (subCommand === "rehome") {
    const manifestPath = resolveManifestPath(vaultPath);
    if (!manifestPath) throw new Error(`no skillmux.toml found at ${vaultPath}; run skillmux init first`);
    const manifest = parseManifest(await Bun.file(manifestPath).text());
    const localVaultPaths = config.local_vault_paths.map(expandHome);
    const plans = [];
    for (const surface of resolveSyncSurfaces(manifest, config.agents)) {
      if (!existsSync(surface.dir)) continue;
      const dirs = [surface.dir];
      for (const group of Object.values(surface.projectGroups)) {
        for (const projectPath of group.paths) {
          if (!existsSync(projectPath)) continue;
          const pinDir = resolveProjectPinDir(surface.dir, projectPath);
          if (existsSync(pinDir)) dirs.push(pinDir);
        }
      }
      for (const dir of dirs) {
        plans.push(planTargetMarkerRehome(dir, surface.id, vaultPath, localVaultPaths));
      }
    }
    const markerPaths = plans.map((plan) => plan.markerPath);
    if (options.dryRun) {
      emitSuccess(
        { isJson: options.isJson },
        { marker_paths: markerPaths },
        () => console.log(`agent rehome: ${markerPaths.length} marker(s) (dry-run)`),
      );
      return;
    }
    if (
      !(await confirmIfNeeded({
        confirmed: args.includes("--yes"),
        isJson: options.isJson,
        prompt: `rehome ${markerPaths.length} marker(s) to ${vaultPath}?`,
        nonInteractiveError: "skillmux agent rehome requires --yes when run non-interactively",
      }))
    )
      return;
    applyTargetMarkerRehome(plans, vaultPath);
    emitSuccess(
      { isJson: options.isJson },
      { marker_paths: markerPaths },
      () => console.log(`rehomed ${markerPaths.length} marker(s) to ${vaultPath}`),
    );
    return;
  }

  throw unknownSubcommandError("agent", subCommand, ["list", "add", "remove", "rehome"]);
}
