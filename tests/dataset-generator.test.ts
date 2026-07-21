import { describe, expect, test } from "bun:test";
import { generateDataset } from "../src/dataset-generator";
import { loadDecisionCases } from "../src/calibrate";
import type { VaultSkill } from "../src/vault";

const sampleSkills: VaultSkill[] = [
  {
    skill_id: "docker-manager",
    title: "Docker Container Manager",
    description: "Inspect, debug, and manage running Docker containers and compose stacks.",
    aliases: ["docker", "container status", "docker logs"],
    body: "Use this skill to restart containers and check logs.",
    content_sha256: "hash1",
  },
  {
    skill_id: "e2e-test",
    title: "Playwright E2E Testing",
    description: "Author and run Playwright end-to-end browser tests for web applications.",
    aliases: ["playwright", "e2e", "browser test"],
    body: "Creates automated browser test specs.",
    content_sha256: "hash2",
  },
  {
    skill_id: "agent-browser",
    title: "Agent Browser Automation",
    description: "Browser automation CLI for web interaction, clicks, forms, and client state.",
    aliases: ["browser interaction", "web click"],
    body: "Drives headless browser actions.",
    content_sha256: "hash3",
  },
  {
    skill_id: "security-review",
    title: "Security Audit and Review",
    description: "Audit diffs for OWASP vulnerabilities, injection risks, and auth flaws.",
    aliases: ["security audit", "vulnerability scan"],
    body: "Analyzes code for security flaws.",
    content_sha256: "hash4",
  },
];

describe("generateDataset (AC2)", () => {
  test("should generate a valid decision-policy dataset that passes loadDecisionCases schema validation", () => {
    const raw = generateDataset(sampleSkills);
    expect(raw.length).toBeGreaterThan(0);

    // Validate that loadDecisionCases does not throw
    const cases = loadDecisionCases(raw);
    expect(cases.length).toBe(raw.length);
  });

  test("should generate cases for tune and test splits with matched, ambiguous, and no_match outcomes", () => {
    const cases = generateDataset(sampleSkills);
    const tuneCases = cases.filter((c) => c.split === "tune");
    const testCases = cases.filter((c) => c.split === "test");

    expect(tuneCases.length).toBeGreaterThan(0);
    expect(testCases.length).toBeGreaterThan(0);

    const tuneOutcomes = new Set(tuneCases.map((c) => c.expected_outcome));
    const testOutcomes = new Set(testCases.map((c) => c.expected_outcome));

    expect(tuneOutcomes.has("matched")).toBe(true);
    expect(tuneOutcomes.has("ambiguous")).toBe(true);
    expect(tuneOutcomes.has("no_match")).toBe(true);

    expect(testOutcomes.has("matched")).toBe(true);
    expect(testOutcomes.has("ambiguous")).toBe(true);
    expect(testOutcomes.has("no_match")).toBe(true);
  });

  test("matched cases should have exactly 1 relevant_skill_id, ambiguous >= 2, no_match == 0", () => {
    const cases = generateDataset(sampleSkills);

    for (const c of cases) {
      if (c.expected_outcome === "matched") {
        expect(c.relevant_skill_ids.length).toBe(1);
      } else if (c.expected_outcome === "ambiguous") {
        expect(c.relevant_skill_ids.length).toBeGreaterThanOrEqual(2);
      } else if (c.expected_outcome === "no_match") {
        expect(c.relevant_skill_ids.length).toBe(0);
      }
    }
  });

  test("should generate dataset even with empty skills array (uses generic fallback queries)", () => {
    const cases = generateDataset([]);
    expect(cases.length).toBeGreaterThan(0);
    expect(() => loadDecisionCases(cases)).not.toThrow();
  });
});
