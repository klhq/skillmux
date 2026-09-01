import { existsSync, lstatSync } from "node:fs";
import { basename } from "node:path";
import { expandHome } from "../config";
import { planClientSurfaces, SUPPORTED_CLIENT_IDS } from "../init-clients";
import {
  parseManifest,
  pinProject,
  unpinProject,
  updateProjectPaths,
  updateProjectTargets,
  upsertProject,
  validateManifest,
  writeManifestAtomic,
} from "../manifest";
import { resolveProjectDirectory, suggestProjectName } from "../project-setup";
import {
  parseCommaList,
  promptMultiSelect,
  promptText,
  shouldUseWizard,
} from "../prompts";
import { emitSuccess, isInteractive } from "../output";
import { confirmAction, confirmIfNeeded, loadManifestContext } from "./shared";
import { isGlobalFlag } from "../global-flags";
const PROJECT_INIT_USAGE =
  "usage: skillmux project init [path] [--name <group>] [--skill <id>...] [--client <id>...] [--target <name>...] [--yes] [--no-sync]";

interface ProjectInitArgs {
  path: string;
  name: string;
  skills: string[];
  clients: string[];
  targets: string[];
  yes: boolean;
  sync: boolean;
}

export function configuredTargetForSurface(
  manifest: ReturnType<typeof parseManifest>,
  surface: { targetName: string; path: string },
): string | undefined {
  if (manifest.targets[surface.targetName]) return surface.targetName;
  return Object.entries(manifest.targets).find(
    ([, target]) => expandHome(target.dir) === surface.path,
  )?.[0];
}

function configuredTargetsForClients(
  manifest: ReturnType<typeof parseManifest>,
  clients: readonly string[],
): string[] {
  return planClientSurfaces(clients).surfaces.map((surface) => {
    const target = configuredTargetForSurface(manifest, surface);
    if (target) return target;
    const client = surface.clients[0]!;
    throw new Error(
      `client target for "${client}" is not configured; run "skillmux init --client ${client} --yes" first`,
    );
  });
}

function parseProjectInitArgs(args: string[]): ProjectInitArgs {
  let projectPath: string | undefined;
  let name: string | undefined;
  const skills: string[] = [];
  const clients: string[] = [];
  const targets: string[] = [];
  let yes = false;
  let sync = true;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--name") {
      name = args[++i];
      if (!name) throw new Error("--name requires a group name");
    } else if (arg === "--skill") {
      const skill = args[++i];
      if (!skill) throw new Error("--skill requires a skill_id");
      skills.push(skill);
    } else if (arg === "--target") {
      const target = args[++i];
      if (!target) throw new Error("--target requires a name");
      targets.push(target);
    } else if (arg === "--client") {
      const client = args[++i];
      if (!client) throw new Error("--client requires a name");
      clients.push(client);
    } else if (arg === "--yes") {
      yes = true;
    } else if (arg === "--no-sync") {
      sync = false;
    } else if (
      isGlobalFlag(arg, "--dry-run", "--json") ||
      arg === "--interactive"
    ) {
      continue;
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown project init option: ${arg}`);
    } else if (projectPath) {
      throw new Error(PROJECT_INIT_USAGE);
    } else {
      projectPath = arg;
    }
  }

  const path = resolveProjectDirectory(
    projectPath ? expandHome(projectPath) : undefined,
  );
  return {
    path,
    name: name ?? suggestProjectName(basename(path)),
    skills,
    clients,
    targets,
    yes,
    sync,
  };
}

export async function runProject(
  subCommand: string,
  args: string[],
  options: {
    isJson: boolean;
    dryRun: boolean;
    sync: (args: string[]) => Promise<void>;
  },
): Promise<void> {
  if (subCommand === "list" || subCommand === "show") {
    const { manifest } = await loadManifestContext();
    const names =
      subCommand === "show"
        ? [args[0] ?? ""]
        : Object.keys(manifest.project ?? {});
    if (subCommand === "show" && !manifest.project?.[names[0]!]) {
      throw new Error(`[project.${names[0]}] does not exist`);
    }
    const projects = names.map((name) => ({
      name,
      paths: manifest.project?.[name]!.paths ?? [],
      skills: manifest.project?.[name]!.skills ?? [],
      targets: Object.entries(manifest.targets)
        .filter(([, target]) => target.project_groups.includes(name))
        .map(([target]) => target),
    }));
    emitSuccess({ isJson: options.isJson }, { projects }, () => {
      if (projects.length === 0) {
        console.log("no project groups configured");
      } else {
        for (const project of projects) {
          console.log(`${project.name}:`);
          console.log(`  paths: ${project.paths.join(", ") || "(none)"}`);
          console.log(`  skills: ${project.skills.join(", ") || "(none)"}`);
          console.log(`  targets: ${project.targets.join(", ") || "(none)"}`);
        }
      }
    });
    return;
  }
  if (subCommand === "add-path" || subCommand === "remove-path") {
    const group = args[0];
    if (!group)
      throw new Error(
        `usage: skillmux project ${subCommand} <group> [path] --yes`,
      );
    const rawPath = args[1]?.startsWith("-") ? undefined : args[1];
    const projectPath = resolveProjectDirectory(
      rawPath ? expandHome(rawPath) : undefined,
    );
    const yes = args.includes("--yes");
    if (!existsSync(projectPath) || !lstatSync(projectPath).isDirectory()) {
      throw new Error(`project path is not a directory: ${projectPath}`);
    }
    const { config, vaultPath, manifestPath, manifest } =
      await loadManifestContext();
    const updated = updateProjectPaths(manifest, group, {
      ...(subCommand === "add-path"
        ? { add: [projectPath] }
        : { remove: [projectPath] }),
    });
    validateManifest(
      updated,
      vaultPath,
      config.local_vault_paths.map(expandHome),
    );
    if (options.dryRun) {
      emitSuccess(
        { isJson: options.isJson },
        { subcommand: subCommand, group, path: projectPath },
        () => console.log(`${subCommand}: [project.${group}] ${projectPath} (dry-run)`),
      );
      return;
    }
    if (
      !(await confirmIfNeeded({
        confirmed: yes,
        isJson: options.isJson,
        prompt: `${subCommand} ${projectPath} in [project.${group}]?`,
        nonInteractiveError: `skillmux project ${subCommand} requires --yes when run non-interactively`,
      }))
    )
      return;
    writeManifestAtomic(manifestPath, updated);
    emitSuccess(
      { isJson: options.isJson },
      { subcommand: subCommand, group, path: projectPath },
      () => console.log(`${subCommand}: [project.${group}] ${projectPath}`),
    );
    return;
  }
  if (subCommand === "pin" || subCommand === "unpin") {
    const group = args[0];
    const skills = args.slice(1).filter((arg) => !arg.startsWith("-"));
    if (!group || skills.length === 0) {
      throw new Error(
        `usage: skillmux project ${subCommand} <group> <skill_id>... --yes`,
      );
    }
    const yes = args.includes("--yes");
    const { config, vaultPath, manifestPath, manifest } =
      await loadManifestContext();
    let updated = manifest;
    for (const skill of skills) {
      updated =
        subCommand === "pin"
          ? pinProject(updated, skill, group)
          : unpinProject(updated, skill, group);
    }
    validateManifest(
      updated,
      vaultPath,
      config.local_vault_paths.map(expandHome),
    );
    if (options.dryRun) {
      emitSuccess(
        { isJson: options.isJson },
        { subcommand: subCommand, group, skill_ids: skills },
        () =>
          console.log(
            `${subCommand}: [project.${group}] ${skills.join(", ")} (dry-run)`,
          ),
      );
      return;
    }
    if (
      !(await confirmIfNeeded({
        confirmed: yes,
        isJson: options.isJson,
        prompt: `${subCommand} ${skills.join(", ")} in [project.${group}]?`,
        nonInteractiveError: `skillmux project ${subCommand} requires --yes when run non-interactively`,
      }))
    )
      return;
    writeManifestAtomic(manifestPath, updated);
    emitSuccess(
      { isJson: options.isJson },
      { subcommand: subCommand, group, skill_ids: skills },
      () => console.log(`${subCommand}: [project.${group}] ${skills.join(", ")}`),
    );
    return;
  }
  if (subCommand === "attach" || subCommand === "detach") {
    const group = args[0];
    if (!group)
      throw new Error(
        `usage: skillmux project ${subCommand} <group> (--client <id>... | --target <name>...) --yes`,
      );
    const clients: string[] = [];
    const requestedTargets: string[] = [];
    for (let i = 1; i < args.length; i++) {
      if (args[i] === "--client") {
        const value = args[++i];
        if (!value) throw new Error("--client requires a name");
        clients.push(value);
      } else if (args[i] === "--target") {
        const value = args[++i];
        if (!value) throw new Error("--target requires a name");
        requestedTargets.push(value);
      } else if (
        args[i] !== "--yes" &&
        args[i] !== "--dry-run" &&
        args[i] !== "--json"
      ) {
        throw new Error(`unknown project ${subCommand} option: ${args[i]}`);
      }
    }
    const { config, vaultPath, manifestPath, manifest } =
      await loadManifestContext();
    const clientTargets = configuredTargetsForClients(manifest, clients);
    const targets = [...new Set([...requestedTargets, ...clientTargets])];
    if (targets.length === 0) {
      throw new Error(`project ${subCommand} requires --client or --target`);
    }
    const updated = updateProjectTargets(manifest, group, {
      ...(subCommand === "attach" ? { attach: targets } : { detach: targets }),
    });
    validateManifest(
      updated,
      vaultPath,
      config.local_vault_paths.map(expandHome),
    );
    if (options.dryRun) {
      emitSuccess(
        { isJson: options.isJson },
        { subcommand: subCommand, group, targets },
        () =>
          console.log(
            `${subCommand}: [project.${group}] ${targets.join(", ")} (dry-run)`,
          ),
      );
      return;
    }
    if (
      !(await confirmIfNeeded({
        confirmed: args.includes("--yes"),
        isJson: options.isJson,
        prompt: `${subCommand} [project.${group}] to ${targets.join(", ")}?`,
        nonInteractiveError: `skillmux project ${subCommand} requires --yes when run non-interactively`,
      }))
    )
      return;
    writeManifestAtomic(manifestPath, updated);
    emitSuccess(
      { isJson: options.isJson },
      { subcommand: subCommand, group, targets },
      () => console.log(`${subCommand}: [project.${group}] ${targets.join(", ")}`),
    );
    return;
  }
  if (subCommand !== "init") throw new Error(PROJECT_INIT_USAGE);
  let request = parseProjectInitArgs(args);
  const guided = shouldUseWizard(args, {
    interactive: isInteractive(),
    json: options.isJson,
    dryRun: options.dryRun,
  });
  if (!existsSync(request.path))
    throw new Error(`project path does not exist: ${request.path}`);
  if (!lstatSync(request.path).isDirectory()) {
    throw new Error(`project path is not a directory: ${request.path}`);
  }

  const { config, vaultPath, manifestPath, manifest } =
    await loadManifestContext();
  const localVaultPaths = config.local_vault_paths.map(expandHome);
  if (guided) {
    const name = await promptText("Project group", request.name);
    const availableClients = SUPPORTED_CLIENT_IDS.filter((client) => {
      const surface = planClientSurfaces([client]).surfaces[0];
      return (
        surface !== undefined &&
        configuredTargetForSurface(manifest, surface) !== undefined
      );
    });
    const clients = await promptMultiSelect(
      "Which clients should receive project skills?",
      availableClients.map((client) => ({
        value: client,
        label: client,
        selected:
          request.clients.length === 0 || request.clients.includes(client),
      })),
    );
    const skills = parseCommaList(
      await promptText(
        "Project skill IDs, comma-separated",
        request.skills.join(","),
      ),
    );
    request = { ...request, name, clients, skills };
  }
  const clientTargets = configuredTargetsForClients(manifest, request.clients);
  const targets = [...new Set([...request.targets, ...clientTargets])];
  const updated = upsertProject(manifest, {
    name: request.name,
    paths: [request.path],
    skills: request.skills,
    targets,
  });
  const { notes } = validateManifest(updated, vaultPath, localVaultPaths);
  const plan = {
    mode: "project",
    project: request.name,
    path: request.path,
    skills: request.skills,
    clients: request.clients,
    targets,
    sync: request.sync,
    notes,
  };

  if (options.dryRun) {
    emitSuccess({ isJson: options.isJson }, { plan }, () =>
      console.log(`project plan: ${JSON.stringify(plan)}`),
    );
    return;
  }
  if (!request.yes) {
    if (!options.isJson && isInteractive()) {
      if (guided) {
        console.log("\nReview");
        console.log(`  project: ${request.name}`);
        console.log(`  path: ${request.path}`);
        console.log(`  clients: ${request.clients.join(", ") || "(none)"}`);
        console.log(`  skills: ${request.skills.join(", ") || "(none)"}`);
        console.log(`  sync: ${request.sync ? "yes" : "no"}`);
      }
      if (
        !(await confirmAction(
          `apply project setup for ${request.name} at ${request.path}?`,
        ))
      ) {
        console.log("project setup cancelled");
        return;
      }
    } else {
      throw new Error(
        "skillmux project init requires --yes when run non-interactively",
      );
    }
  }

  writeManifestAtomic(manifestPath, updated);
  if (request.sync) {
    try {
      // Reaching here already required approval above (request.yes, or an
      // accepted interactive confirmAction) — that approval covers whatever
      // new target/pin directories this project setup implies, so the
      // downstream sync's own new-target confirmation gate would just be a
      // redundant (and, non-interactively, silently-skipping) re-ask.
      await options.sync(["--yes"]);
    } catch (error) {
      throw new Error(
        `project configuration was saved, but sync failed; fix the reported issue and run "skillmux sync": ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  emitSuccess({ isJson: options.isJson }, { result: plan }, () =>
    console.log(`project "${request.name}" ready at ${request.path}`),
  );
}
