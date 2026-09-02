import { describe, expect, test } from "bun:test";
import { generateCompletions } from "../src/completions";
import { MANAGED_PINS_AGENT_IDS, SUPPORTED_AGENT_IDS } from "../src/init-agents";

describe("shell completions agent lists", () => {
  test("managed-pins agent list excludes full-vault-only agents", () => {
    expect(MANAGED_PINS_AGENT_IDS).not.toContain("goose");
    expect(MANAGED_PINS_AGENT_IDS).not.toContain("hermes");
  });

  test("bash scopes --agent completion per subcommand instead of always offering every agent", () => {
    const script = generateCompletions("bash");
    expect(script).toContain(`compgen -W "${SUPPORTED_AGENT_IDS.join(" ")}"`);
    expect(script).toContain(`compgen -W "${MANAGED_PINS_AGENT_IDS.join(" ")}"`);
    expect(script).toContain('if [ "${COMP_WORDS[1]}" = "project" ]');
  });

  test("zsh restricts project init --agent to managed-pins agents", () => {
    const script = generateCompletions("zsh");
    expect(script).toContain(`agent:(${SUPPORTED_AGENT_IDS.join(" ")})`);
    expect(script).toContain(`agent:(${MANAGED_PINS_AGENT_IDS.join(" ")})`);
  });

  test("fish restricts project --agent to managed-pins agents", () => {
    const script = generateCompletions("fish");
    expect(script).toContain(`-a "${SUPPORTED_AGENT_IDS.join(" ")}" -d "Select an agent"`);
    expect(script).toContain(`-a "${MANAGED_PINS_AGENT_IDS.join(" ")}" -d "Select an agent"`);
  });
});
