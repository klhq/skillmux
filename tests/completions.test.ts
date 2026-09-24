import { describe, expect, test } from "bun:test";
import { generateCompletions } from "../src/completions";
import { SUPPORTED_AGENT_IDS } from "../src/init-agents";

describe("shell completions", () => {
  test("every shell offers the agent command instead of the removed target command", () => {
    for (const shell of ["bash", "zsh", "fish"] as const) {
      const script = generateCompletions(shell);
      expect(script).toContain("agent");
      expect(script).not.toMatch(/\btarget\b/);
    }
  });

  test("bash completes agent ids after --agent and after agent add/remove", () => {
    const script = generateCompletions("bash");
    expect(script).toContain("--agent|add|remove)");
    expect(script).toContain(`compgen -W "${SUPPORTED_AGENT_IDS.join(" ")}"`);
  });

  test("zsh completes agent ids for init and project init", () => {
    const script = generateCompletions("zsh");
    expect(script).toContain(`agent:(${SUPPORTED_AGENT_IDS.join(" ")})`);
  });

  test("fish completes agent ids for --agent and agent add/remove", () => {
    const script = generateCompletions("fish");
    expect(script).toContain(`-a "${SUPPORTED_AGENT_IDS.join(" ")}" -d "Select an agent"`);
    expect(script).toContain(`__fish_seen_subcommand_from add remove" -a "${SUPPORTED_AGENT_IDS.join(" ")}"`);
  });
});
