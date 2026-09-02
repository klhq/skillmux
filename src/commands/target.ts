import { expandHome } from "../config";
import {
  BUILT_IN_TARGET_NAMES,
  planAgentSurfaces,
  resolveBuiltInTarget,
  SUPPORTED_AGENT_IDS,
} from "../init-agents";
import { planInitManifest, applyInit } from "../init";
import { writeManifestAtomic } from "../manifest";
import { emitSuccess, unknownSubcommandError } from "../output";
import { confirmIfNeeded, loadManifestContext } from "./shared";

export async function runTarget(
  subCommand: string,
  args: string[],
  options: { isJson: boolean; dryRun: boolean },
): Promise<void> {
  const { vaultPath, manifestPath, manifest } = await loadManifestContext();

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
        return surface !== undefined && surface.path === expandHome(target.dir);
      });
      return { name, ...target, agents };
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
        { name, preserved_dir: manifest.targets[name]!.dir },
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
    const removedDir = manifest.targets[name]!.dir;
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

  throw unknownSubcommandError("target", subCommand, ["list", "show", "add", "remove"]);
}
