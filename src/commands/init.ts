import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  expandHome,
  loadConfig,
  migrateLegacyPaths,
  resolveConfigPath,
} from "../config";
import {
  applyInit,
  deriveTargetName,
  detectSurfaces,
  planInitManifest,
  printLastMile,
  surfaceCandidates,
} from "../init";
import {
  assessAgentReadiness,
  detectInstalledAgents,
  planAgentSurfaces,
  SUPPORTED_AGENT_IDS,
  type AgentId,
  type ReadinessAxis,
} from "../init-agents";
import {
  applyInstructionPlan,
  planInstructionSetup,
  rollbackInstructionPlan,
} from "../init-instructions";
import { parseManifest, resolveManifestPath } from "../manifest";
import {
  MCP_REGISTRABLE_AGENTS,
  registerMcpServer,
  type McpRegistrationResult,
} from "../mcp-registration";
import { isInteractive } from "../output";
import { isGlobalFlag } from "../global-flags";
import {
  parseCommaList,
  promptMultiSelect,
  promptText,
  shouldUseWizard,
} from "../prompts";
import {
  applyConfigInit,
  inspectVault,
  planConfigInit,
  rollbackConfigInit,
  type ConfigInitPlan,
} from "../setup";
import { configuredTargetForSurface } from "./project";
import { confirmAction } from "./shared";
import { runSync } from "./sync";

function parseInitArgs(args: string[]): {
  agents: string[];
  coreSkillIds: string[];
  migrateFullVault: boolean;
  showMcpSetup: boolean;
  registerMcp: boolean;
  skipInstructions: boolean;
  sync: boolean;
  vaultPath?: string;
  yes: boolean;
} {
  const agents: string[] = [];
  const coreSkillIds: string[] = [];
  let migrateFullVault = false;
  let showMcpSetup = false;
  let registerMcp = false;
  let skipInstructions = false;
  let sync = true;
  let vaultPath: string | undefined;
  let yes = false;
  for (let i = 0; i < args.length; i++) {
    const option = args[i];
    if (option === "--target" || option === "--dir" || option === "--client") {
      throw new Error(
        `${option} was removed; select a specific supported agent with --agent instead (see "skillmux init --help")`,
      );
    } else if (option === "--agent") {
      const value = args[i + 1];
      if (!value) throw new Error("--agent requires a name");
      agents.push(value);
      i++;
    } else if (option === "--vault") {
      const value = args[i + 1];
      if (!value) throw new Error("--vault requires a path");
      vaultPath = value;
      i++;
    } else if (option === "--core") {
      const value = args[i + 1];
      if (!value) throw new Error("--core requires a skill_id");
      coreSkillIds.push(value);
      i++;
    } else if (
      isGlobalFlag(option, "--dry-run", "--json") ||
      option === "--interactive"
    ) {
      continue;
    } else if (option === "--migrate-full-vault") {
      migrateFullVault = true;
    } else if (option === "--show-mcp-setup") {
      showMcpSetup = true;
    } else if (option === "--register-mcp") {
      registerMcp = true;
    } else if (option === "--no-instructions") {
      skipInstructions = true;
    } else if (option === "--no-sync") {
      sync = false;
    } else if (option === "--yes") {
      yes = true;
    } else {
      throw new Error(`unknown init option: ${option}`);
    }
  }
  return {
    agents,
    coreSkillIds,
    migrateFullVault,
    showMcpSetup,
    registerMcp,
    skipInstructions,
    sync,
    vaultPath,
    yes,
  };
}

export async function runInit(
  args: string[],
  options: { isJson: boolean; dryRun: boolean },
): Promise<void> {
  const {
    agents: requestedAgents,
    coreSkillIds,
    migrateFullVault,
    showMcpSetup,
    registerMcp: requestedRegisterMcp,
    skipInstructions,
    sync,
    vaultPath: requestedVaultPath,
    yes,
  } = parseInitArgs(args);
  const guided = shouldUseWizard(args, {
    interactive: isInteractive(),
    json: options.isJson,
    dryRun: options.dryRun,
  });
  migrateLegacyPaths();
  const configPath = resolveConfigPath();
  let configPlan: ConfigInitPlan | undefined;
  let vaultPath: string;
  if (!existsSync(configPath)) {
    const bootstrapVaultPath =
      requestedVaultPath ??
      (!options.isJson && isInteractive() ? "~/skills" : undefined);
    if (!bootstrapVaultPath) {
      throw new Error(
        `machine config does not exist: ${configPath}; re-run with --vault <path>`,
      );
    }
    configPlan = planConfigInit(configPath, expandHome(bootstrapVaultPath));
    vaultPath = configPlan.vaultPath;
    if (!options.isJson) {
      console.log(`config create: ${configPath}`);
    }
  } else {
    const config = await loadConfig();
    vaultPath = expandHome(config.vault_path);
    if (requestedVaultPath && expandHome(requestedVaultPath) !== vaultPath) {
      throw new Error(
        `machine config already uses vault_path ${vaultPath}; --vault does not overwrite existing config`,
      );
    }
  }

  const vaultHealth = inspectVault(vaultPath);
  if (!vaultHealth.ok) {
    throw new Error(vaultHealth.message);
  }

  let selectedAgents = requestedAgents;
  if (guided) {
    const detected = detectInstalledAgents({
      codexHome: process.env.CODEX_HOME
        ? expandHome(process.env.CODEX_HOME)
        : undefined,
    });
    const evidence = new Map(
      detected.map((item) => [item.agent, item.evidence]),
    );
    selectedAgents = await promptMultiSelect(
      "Which agents do you use?",
      SUPPORTED_AGENT_IDS.map((agent) => ({
        value: agent,
        label: agent,
        detail: evidence.has(agent)
          ? `detected: ${evidence.get(agent)}`
          : undefined,
        selected: evidence.has(agent) || requestedAgents.includes(agent),
      })),
    );
  }
  let selectedCoreSkillIds = coreSkillIds;
  if (guided) {
    selectedCoreSkillIds = parseCommaList(
      await promptText(
        "Core skill IDs to add, comma-separated",
        coreSkillIds.join(","),
      ),
    );
  }

  // Native pins and MCP registration are independent choices — this stays
  // opt-in and only offered for agents whose own CLI we've verified, so a
  // user who only wants native skill management sees nothing new here.
  const registrableAgents = selectedAgents.filter((agent) =>
    MCP_REGISTRABLE_AGENTS.includes(agent as AgentId),
  ) as AgentId[];
  let registerMcp = requestedRegisterMcp;
  if (guided && registrableAgents.length > 0) {
    registerMcp = await confirmAction(
      `Also register skillmux as an MCP server for ${registrableAgents.join(", ")}?`,
    );
  }

  const agentPlan = planAgentSurfaces(selectedAgents, {
    codexHome: process.env.CODEX_HOME
      ? expandHome(process.env.CODEX_HOME)
      : undefined,
  });
  const instructionPlan = planInstructionSetup(
    skipInstructions ? [] : agentPlan.agents.map((agent) => agent.id),
    {
      codexHome: process.env.CODEX_HOME
        ? expandHome(process.env.CODEX_HOME)
        : undefined,
    },
  );
  const instructionReadiness: Partial<Record<AgentId, ReadinessAxis>> = {};
  for (const change of instructionPlan.changes) {
    for (const agent of change.agents) {
      instructionReadiness[agent] = {
        status: change.status === "unchanged" ? "ready" : "planned",
        detail: change.path,
      };
    }
  }
  for (const manual of instructionPlan.manual) {
    instructionReadiness[manual.agent] = {
      status: "manual",
      detail: manual.reason,
    };
  }
  const existingManifestPath = resolveManifestPath(vaultPath);
  const existingManifest = existingManifestPath
    ? parseManifest(await Bun.file(existingManifestPath).text())
    : undefined;
  const targetByPath = new Map<string, string>();
  for (const surface of agentPlan.surfaces) {
    targetByPath.set(
      surface.path,
      existingManifest
        ? (configuredTargetForSurface(existingManifest, surface) ??
            surface.targetName)
        : surface.targetName,
    );
  }
  const candidatePaths = [
    ...new Set([
      ...surfaceCandidates().map(expandHome),
      ...targetByPath.keys(),
    ]),
  ];
  const candidates = detectSurfaces(candidatePaths, vaultPath);
  if (!options.isJson) {
    for (const candidate of candidates) {
      const name =
        targetByPath.get(candidate.path) ?? deriveTargetName(candidate.path);
      if (candidate.state === "missing") {
        console.log(`${name} (${candidate.path}): not found`);
        continue;
      }
      if (candidate.state === "broken-symlink") {
        console.log(`${name} (${candidate.path}): broken symlink`);
        continue;
      }
      if (candidate.state === "full-vault") {
        console.log(
          `${name} (${candidate.path}): full-vault -> ${candidate.canonicalPath}`,
        );
        continue;
      }
      if (candidate.state === "external-symlink") {
        console.log(
          `${name} (${candidate.path}): external symlink -> ${candidate.canonicalPath}`,
        );
        continue;
      }
      if (candidate.state === "unsupported") {
        console.log(
          `${name} (${candidate.path}): unsupported filesystem entry`,
        );
        continue;
      }
      const kind = "real dir";
      const marked = candidate.alreadyMarked
        ? ", already skillmux-managed"
        : "";
      console.log(
        `${name} (${candidate.path}): ${kind}, ${candidate.skillCount} skills${marked}`,
      );
    }
    for (const readiness of assessAgentReadiness(
      agentPlan,
      instructionReadiness,
    )) {
      console.log(`\n${readiness.agent} readiness:`);
      console.log(
        `  skill surface: ${readiness.skillSurface.status} — ${readiness.skillSurface.detail}`,
      );
      console.log(
        `  MCP registration: ${readiness.mcpRegistration.status} — ${readiness.mcpRegistration.detail}`,
      );
      console.log(
        `  instructions: ${readiness.instructionSetup.status} — ${readiness.instructionSetup.detail}`,
      );
    }
    for (const change of instructionPlan.changes) {
      console.log(
        `instructions ${change.status}: ${change.path} (${change.agents.join(", ")})`,
      );
    }
    for (const manual of instructionPlan.manual) {
      console.log(`instructions manual: ${manual.agent} — ${manual.reason}`);
    }
  }

  const requestedTargets = [...new Set(targetByPath.values())];
  const hasInstructionWrites = instructionPlan.changes.some(
    (change) => change.status !== "unchanged",
  );
  const hasConfigWrite = configPlan?.action === "create";
  const hasChanges = !(
    requestedTargets.length === 0 &&
    !hasInstructionWrites &&
    selectedCoreSkillIds.length === 0 &&
    !hasConfigWrite
  );

  const byName = new Map(
    candidates
      .filter(
        (candidate) =>
          candidate.deliveryMode === "managed-pins" ||
          (migrateFullVault && candidate.state === "full-vault"),
      )
      .map(
        (candidate) =>
          [
            targetByPath.get(candidate.path) ??
              deriveTargetName(candidate.path),
            candidate,
          ] as const,
      ),
  );
  const allCandidatesByName = new Map(
    candidates.map(
      (candidate) =>
        [
          targetByPath.get(candidate.path) ?? deriveTargetName(candidate.path),
          candidate,
        ] as const,
    ),
  );
  for (const name of requestedTargets) {
    if (!byName.has(name)) {
      if (allCandidatesByName.get(name)?.state === "full-vault") {
        throw new Error(
          `target "${name}" is a full-vault surface; re-run with --migrate-full-vault to convert it to managed pins`,
        );
      }
      throw new Error(
        `target "${name}" not among detected surfaces`,
      );
    }
  }

  const confirmedTargets = requestedTargets.map((name) => {
    const candidate = byName.get(name)!;
    return {
      name,
      dir: candidate.path,
      ...(candidate.state === "full-vault" ? { migrateFullVault: true } : {}),
    };
  });
  const plannedManifest = planInitManifest(
    vaultPath,
    confirmedTargets,
    selectedCoreSkillIds,
  );
  const serializedPlan = {
    vault_path: vaultPath,
    config: configPlan
      ? { path: configPlan.configPath, action: configPlan.action }
      : { path: configPath, action: "preserve" },
    agents: agentPlan.agents.map((agent) => agent.id),
    targets: confirmedTargets,
    core: plannedManifest.core.skills,
    instructions: instructionPlan.changes.map(({ path, agents, status }) => ({
      path,
      agents,
      status,
    })),
    manual: instructionPlan.manual,
    register_mcp_for: registerMcp ? registrableAgents : [],
  };
  if (!hasChanges) {
    if (options.isJson) {
      console.log(
        JSON.stringify({
          schema_version: 1,
          ok: true,
          command: "init",
          phase: "plan",
          dry_run: options.dryRun,
          applied: false,
          plan: serializedPlan,
        }),
      );
    } else {
      console.log("\nno managed-pins surface selected — nothing written.");
    }
    return;
  }
  if (!options.isJson) {
    for (const target of confirmedTargets.filter(
      (target) => target.migrateFullVault,
    )) {
      console.log(
        `full-vault migration ${target.name}: ${vaultHealth.skillCount} visible skills -> ` +
          `${plannedManifest.core.skills.length} core ${plannedManifest.core.skills.length === 1 ? "skill" : "skills"} after sync`,
      );
    }
  }
  if (options.dryRun) {
    if (options.isJson) {
      console.log(
        JSON.stringify({
          schema_version: 1,
          ok: true,
          command: "init",
          phase: "plan",
          dry_run: true,
          applied: false,
          plan: serializedPlan,
        }),
      );
    } else {
      console.log(
        `\ndry-run: ${confirmedTargets.length} target(s), ` +
          `${instructionPlan.changes.filter((change) => change.status !== "unchanged").length} instruction file(s), ` +
          `core: ${plannedManifest.core.skills.join(", ") || "(unchanged)"}, ` +
          `MCP registration: ${registerMcp ? registrableAgents.join(", ") || "(none)" : "(none)"}`,
      );
    }
    return;
  }

  if (!yes) {
    if (!options.isJson && isInteractive()) {
      if (guided) {
        console.log("\nReview");
        console.log(`  agents: ${selectedAgents.join(", ") || "(none)"}`);
        console.log(
          `  targets: ${confirmedTargets.map((target) => `${target.name} -> ${target.dir}`).join(", ") || "(none)"}`,
        );
        console.log(
          `  instructions: ${instructionPlan.changes.filter((change) => change.status !== "unchanged").length} file(s)`,
        );
        console.log(
          `  core: ${plannedManifest.core.skills.join(", ") || "(none)"}`,
        );
        console.log(
          `  MCP registration: ${registerMcp ? registrableAgents.join(", ") || "(none)" : "(none)"}`,
        );
        console.log(`  sync: ${sync ? "yes" : "no"}`);
        if (!(await confirmAction("apply this setup plan?"))) {
          console.log("init cancelled");
          return;
        }
      } else {
        const prompts = [
          ...confirmedTargets.map(
            (target) => `adopt ${target.name} at ${target.dir}?`,
          ),
          ...instructionPlan.changes
            .filter((change) => change.status !== "unchanged")
            .map(
              (change) => `${change.status} instruction file ${change.path}?`,
            ),
          ...(hasConfigWrite ? [`create machine config ${configPath}?`] : []),
          ...(selectedCoreSkillIds.length > 0
            ? [`pin core skills: ${selectedCoreSkillIds.join(", ")}?`]
            : []),
        ];
        for (const prompt of prompts) {
          if (!(await confirmAction(prompt))) {
            console.log("init cancelled; nothing written");
            return;
          }
        }
      }
    } else {
      throw new Error(
        "skillmux init requires --yes before applying target, instruction, or core changes non-interactively",
      );
    }
  }

  let configCreated = false;
  let instructionsApplied = false;
  const applyAdditional = () => {
    try {
      if (configPlan?.action === "create") {
        configCreated = applyConfigInit(configPlan) === "created";
      }
      if (hasInstructionWrites) {
        applyInstructionPlan(instructionPlan);
        instructionsApplied = true;
      }
    } catch (error) {
      if (configCreated && configPlan) rollbackConfigInit(configPlan);
      configCreated = false;
      throw error;
    }
  };
  const rollbackAdditional = () => {
    if (instructionsApplied) rollbackInstructionPlan(instructionPlan);
    if (configCreated && configPlan) rollbackConfigInit(configPlan);
  };

  if (confirmedTargets.length === 0 && selectedCoreSkillIds.length === 0) {
    applyAdditional();
  } else {
    applyInit(
      vaultPath,
      confirmedTargets,
      hasInstructionWrites || hasConfigWrite
        ? {
            apply: applyAdditional,
            rollback: rollbackAdditional,
          }
        : undefined,
      selectedCoreSkillIds,
    );
  }

  // Best-effort and outside the rollback above: this mutates another tool's
  // own config, not skillmux's, so a registration failure is reported, never
  // rolled back — the successful native setup above still stands either way.
  const mcpRegistrations: McpRegistrationResult[] = [];
  if (registerMcp) {
    for (const agent of registrableAgents) {
      mcpRegistrations.push(await registerMcpServer(agent));
    }
  }

  if (options.isJson) {
    console.log(
      JSON.stringify({
        schema_version: 1,
        ok: true,
        command: "init",
        phase: "result",
        dry_run: false,
        applied: true,
        plan: serializedPlan,
        result: {
          config_created: configCreated,
          targets_adopted: confirmedTargets.map((target) => target.name),
          instructions_changed: instructionPlan.changes
            .filter((change) => change.status !== "unchanged")
            .map((change) => change.path),
          core: plannedManifest.core.skills,
          mcp_registrations: mcpRegistrations,
        },
      }),
    );
    return;
  }
  if (configCreated) console.log(`created ${configPath}`);
  if (confirmedTargets.length > 0) {
    console.log(
      `\nwrote ${join(vaultPath, "skillmux.toml")}, adopted: ${confirmedTargets.map((t) => t.name).join(", ")}`,
    );
  } else if (selectedCoreSkillIds.length > 0) {
    console.log(`\nwrote ${join(vaultPath, "skillmux.toml")}`);
  }
  if (plannedManifest.core.skills.length === 0 && confirmedTargets.length > 0) {
    console.log("next: skillmux core pin <skill_id> --yes");
  }
  if (confirmedTargets.length > 0) console.log("next: skillmux sync");
  for (const registration of mcpRegistrations) {
    console.log(
      registration.ok
        ? `registered skillmux as an MCP server for ${registration.agent}`
        : `failed to register skillmux as an MCP server for ${registration.agent}: ${registration.error}`,
    );
  }
  if (selectedAgents.length === 0 || showMcpSetup) {
    console.log(`\n${printLastMile()}`);
  }
  // Reaching this point already required approval above (--yes, or an accepted
  // confirmAction naming these exact targets/dirs) — that approval covers whatever
  // new target directories this init just adopted, so runSync's own new-target
  // confirmation gate would just be a redundant (and non-interactively,
  // silently-skipping) re-ask.
  if (guided && sync && confirmedTargets.length > 0) await runSync(["--yes"]);
}
