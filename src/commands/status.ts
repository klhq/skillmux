import { unknownOptionError } from "../arg-errors";
import { loadConfig } from "../config";
import { emitSuccess, green, red, yellow } from "../output";
import { buildStatus } from "../status";

export async function runStatus(args: string[], options: { isJson: boolean }): Promise<void> {
  for (const arg of args) {
    if (arg !== "--json") throw unknownOptionError("status", arg);
  }
  const report = buildStatus(await loadConfig());
  emitSuccess({ isJson: options.isJson }, report, () => {
    console.log(`vault: ${report.vault.path}${report.vault.exists ? "" : red(" (missing)")}`);
    console.log(`core: ${report.core.count} of ${report.core.limit} skills`);
    for (const group of report.project_groups) {
      console.log(`project ${group.name}: ${group.skills} skills (${group.agents.join(", ") || "no agents"})`);
    }
    if (report.agents.length === 0) console.log("agents: none configured");
    for (const agent of report.agents) {
      const state = agent.state === "managed" ? green(agent.state) : yellow(agent.state);
      console.log(`agent ${agent.agent}: ${agent.dir} ${state}`);
    }
    for (const check of report.checks.filter((c) => !c.ok)) {
      console.log(`${red("problem")} ${check.name}: ${check.detail}`);
    }
    console.log(report.ok ? green("ok") : 'run "skillmux doctor" for deeper checks');
  });
}
