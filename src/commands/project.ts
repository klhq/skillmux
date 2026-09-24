import { existsSync, lstatSync } from "node:fs";
import { basename } from "node:path";
import { expandHome } from "../config";
import { isAgentId, planAgentSurfaces, SUPPORTED_AGENT_IDS, type AgentId } from "../init-agents";
import {
  applyInstructionPlan,
  planProjectInstructionSetup,
} from "../init-instructions";
import {
  parseManifest,
  pinProject,
  unpinProject,
  updateProjectAgents,
  updateProjectPaths,
  upsertProject,
  validateManifest,
  writeManifestAtomic,
} from "../manifest";
import {
  MCP_PROJECT_REGISTRABLE_AGENTS,
  registerMcpServer,
  type McpRegistrationResult,
} from "../mcp-registration";
import { resolveProjectDirectory, suggestProjectName } from "../project-setup";
import {
  parseCommaList,
  promptMultiSelect,
  promptText,
  shouldUseWizard,
} from "../prompts";
import { emitSuccess, isInteractive, unknownSubcommandError } from "../output";
import { confirmAction, confirmIfNeeded, loadManifestContext } from "./shared";
import { isGlobalFlag } from "../global-flags";
const PROJECT_INIT_USAGE =
  "usage: skillmux project init [path] [--name <group>] [--skill <id>...] [--agent <id>...] [--register-mcp] [--yes] [--no-sync]";

interface ProjectInitArgs {
  path: string;
  name: string;
  skills: string[];
  agents: string[];
  registerMcp: boolean;
  yes: boolean;
  sync: boolean;
}

const TARGET_FLAG_REMOVED =
  "--target was removed; name the agents that should see the project's skills with --agent";

function requireAgentIds(agents: readonly string[]): AgentId[] {
  for (const agent of agents) {
    if (!isAgentId(agent)) {
      throw new Error(
        `unsupported agent "${agent}"; supported agents: ${SUPPORTED_AGENT_IDS.join(", ")}`,
      );
    }
  }
  return [...new Set(agents as AgentId[])];
}

function describeAgents(agents: readonly AgentId[]): string {
  return planAgentSurfaces(agents)
    .surfaces.map((surface) => `${surface.agents.join(", ")} (${surface.path})`)
    .join("; ");
}

function parseProjectInitArgs(args: string[]): ProjectInitArgs {
  let projectPath: string | undefined;
  let name: string | undefined;
  const skills: string[] = [];
  const agents: string[] = [];
  let registerMcp = false;
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
      throw new Error(TARGET_FLAG_REMOVED);
    } else if (arg === "--agent") {
      const agent = args[++i];
      if (!agent) throw new Error("--agent requires a name");
      agents.push(agent);
    } else if (arg === "--register-mcp") {
      registerMcp = true;
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
    agents,
    registerMcp,
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
      agents: manifest.project?.[name]!.agents ?? [],
    }));
    emitSuccess({ isJson: options.isJson }, { projects }, () => {
      if (projects.length === 0) {
        console.log("no project groups configured");
      } else {
        for (const project of projects) {
          console.log(`${project.name}:`);
          console.log(`  paths: ${project.paths.join(", ") || "(none)"}`);
          console.log(`  skills: ${project.skills.join(", ") || "(none)"}`);
          console.log(`  agents: ${project.agents.join(", ") || "(none)"}`);
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
    const usage = `usage: skillmux project ${subCommand} <group> --agent <id>... --yes`;
    if (!group) throw new Error(usage);
    const requested: string[] = [];
    for (let i = 1; i < args.length; i++) {
      if (args[i] === "--agent") {
        const value = args[++i];
        if (!value) throw new Error("--agent requires a name");
        requested.push(value);
      } else if (args[i] === "--target") {
        throw new Error(TARGET_FLAG_REMOVED);
      } else if (
        args[i] !== "--yes" &&
        args[i] !== "--dry-run" &&
        args[i] !== "--json"
      ) {
        throw new Error(`unknown project ${subCommand} option: ${args[i]}`);
      }
    }
    if (requested.length === 0) throw new Error(usage);
    const agents = requireAgentIds(requested);
    const { config, vaultPath, manifestPath, manifest } =
      await loadManifestContext();
    const updated = updateProjectAgents(manifest, group, {
      ...(subCommand === "attach" ? { attach: agents } : { detach: agents }),
    });
    validateManifest(
      updated,
      vaultPath,
      config.local_vault_paths.map(expandHome),
    );
    // Several agents share one directory (e.g. opencode/windsurf both read
    // ~/.agents/skills), so show the directory too, making it clear at
    // confirmation time which folder inside the project this affects.
    const display = describeAgents(agents);
    const payload = {
      subcommand: subCommand,
      group,
      agents: updated.project![group]!.agents,
    };
    if (options.dryRun) {
      emitSuccess({ isJson: options.isJson }, payload, () =>
        console.log(`${subCommand}: [project.${group}] ${display} (dry-run)`),
      );
      return;
    }
    if (
      !(await confirmIfNeeded({
        confirmed: args.includes("--yes"),
        isJson: options.isJson,
        prompt: `${subCommand} [project.${group}] ${subCommand === "attach" ? "to" : "from"} ${display}?`,
        nonInteractiveError: `skillmux project ${subCommand} requires --yes when run non-interactively`,
      }))
    )
      return;
    writeManifestAtomic(manifestPath, updated);
    emitSuccess({ isJson: options.isJson }, payload, () =>
      console.log(`${subCommand}: [project.${group}] ${display}`),
    );
    return;
  }
  if (subCommand !== "init")
    throw unknownSubcommandError("project", subCommand, [
      "init",
      "list",
      "show",
      "add-path",
      "remove-path",
      "pin",
      "unpin",
      "attach",
      "detach",
    ]);
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
    const agents = await promptMultiSelect(
      "Which agents should receive project skills?",
      SUPPORTED_AGENT_IDS.map((agent) => ({
        value: agent,
        label: agent,
        selected:
          request.agents.length === 0
            ? config.agents.includes(agent)
            : request.agents.includes(agent),
      })),
    );
    const skills = parseCommaList(
      await promptText(
        "Project skill IDs, comma-separated",
        request.skills.join(","),
      ),
    );
    request = { ...request, name, agents, skills };
  }
  // Local MCP registration + instruction writing are independent of skill
  // pins — only offered for agents with a verified project-scoped CLI
  // command (currently just claude-code; see MCP_PROJECT_REGISTRABLE_AGENTS).
  const registrableAgents = request.agents.filter((agent) =>
    MCP_PROJECT_REGISTRABLE_AGENTS.includes(agent as AgentId),
  ) as AgentId[];
  if (guided && registrableAgents.length > 0) {
    request = {
      ...request,
      registerMcp: await confirmAction(
        `Also register skillmux as a project-scoped MCP server for ${registrableAgents.join(", ")}? ` +
          `This writes ${request.path}/.mcp.json, shared via git.`,
      ),
    };
  }
  // A project always records its agents explicitly: with no --agent, it
  // takes this machine's own agents rather than an empty list that would
  // silently sync nowhere.
  const projectAgents = requireAgentIds(
    request.agents.length > 0 ? request.agents : config.agents,
  );
  if (projectAgents.length === 0) {
    throw new Error(
      "project init needs --agent <id> (no agents are configured in config.toml to default to)",
    );
  }
  const updated = upsertProject(manifest, {
    name: request.name,
    paths: [request.path],
    skills: request.skills,
    agents: projectAgents,
  });
  const { notes } = validateManifest(updated, vaultPath, localVaultPaths);

  // The project-local instruction block only teaches an agent to call
  // resolve_skill/fetch_skill (MCP tools) — write it only for agents that
  // are actually getting a project-scoped MCP registration this run.
  const mcpInstructionAgents = request.registerMcp ? registrableAgents : [];
  const instructionPlan = planProjectInstructionSetup(
    mcpInstructionAgents,
    request.path,
  );
  const hasInstructionWrites = instructionPlan.changes.some(
    (change) => change.status !== "unchanged",
  );

  const plan = {
    mode: "project",
    project: request.name,
    path: request.path,
    skills: request.skills,
    agents: projectAgents,
    sync: request.sync,
    notes,
    instructions: instructionPlan.changes.map(({ path, agents, status }) => ({
      path,
      agents,
      status,
    })),
    register_mcp_for: mcpInstructionAgents,
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
        console.log(`  agents: ${projectAgents.join(", ")}`);
        console.log(`  skills: ${request.skills.join(", ") || "(none)"}`);
        console.log(
          `  instructions: ${instructionPlan.changes.filter((change) => change.status !== "unchanged").length} file(s)`,
        );
        console.log(
          `  MCP registration: ${mcpInstructionAgents.join(", ") || "(none)"}`,
        );
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
  if (hasInstructionWrites) {
    try {
      applyInstructionPlan(instructionPlan);
    } catch (error) {
      throw new Error(
        `project configuration was saved, but writing instruction files failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  if (request.sync) {
    try {
      // Reaching here already required approval above (request.yes, or an
      // accepted interactive confirmAction), which covers the project
      // directories this setup implies, so sync's own project-path gate would
      // just be a redundant (and, non-interactively, silently-skipping) re-ask.
      await options.sync(["--yes"]);
    } catch (error) {
      throw new Error(
        `project configuration was saved, but sync failed; fix the reported issue and run "skillmux sync": ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  // Best-effort and outside the checks above: this mutates another tool's
  // own config, not skillmux's, so a registration failure is reported, never
  // rolled back — the successful project setup above still stands either way.
  const mcpRegistrations: McpRegistrationResult[] = [];
  if (request.registerMcp) {
    for (const agent of registrableAgents) {
      mcpRegistrations.push(
        await registerMcpServer(agent, { scope: "project", cwd: request.path }),
      );
    }
  }

  emitSuccess(
    { isJson: options.isJson },
    {
      result: {
        ...plan,
        instructions_changed: instructionPlan.changes
          .filter((change) => change.status !== "unchanged")
          .map((change) => change.path),
        mcp_registrations: mcpRegistrations,
      },
    },
    () => {
      console.log(`project "${request.name}" ready at ${request.path}`);
      for (const registration of mcpRegistrations) {
        console.log(
          registration.ok
            ? `MCP registered: ${registration.agent} (project scope)`
            : `MCP registration failed for ${registration.agent}: ${registration.error}`,
        );
      }
    },
  );
}
