import type { DecisionSplit, DecisionOutcome } from "./calibrate";
import type { VaultSkill } from "./vault";

export interface RawDecisionCase {
  query: string;
  split: DecisionSplit;
  expected_outcome: DecisionOutcome;
  relevant_skill_ids: string[];
}

export interface GenerateDatasetOptions {
  /** Target number of queries per split. Default: 10. */
  queriesPerSplit?: number;
}

const GENERIC_NO_MATCH_QUERIES = [
  "what is the weather in Paris today",
  "recipe for baking sourdough bread at home",
  "what is the distance from Earth to Mars",
  "explain quantum entanglement simply",
  "how do I solve a quadratic equation",
  "who won the 1998 World Cup",
];

/**
 * Automatically generate a synthetic decision-policy calibration dataset
 * from local vault skill definitions. Runs 100% locally with zero data leaks.
 */
export function generateDataset(
  skills: VaultSkill[],
  options: GenerateDatasetOptions = {},
): RawDecisionCase[] {
  const cases: RawDecisionCase[] = [];

  // --- 1. Matched Cases ---
  for (const skill of skills) {
    // Primary query from title + description
    cases.push({
      query: `how do I ${skill.title.toLowerCase()}: ${skill.description.toLowerCase()}`,
      split: "tune",
      expected_outcome: "matched",
      relevant_skill_ids: [skill.skill_id],
    });

    // Secondary query from aliases
    if (skill.aliases.length > 0) {
      cases.push({
        query: `help me with ${skill.aliases[0]}`,
        split: "test",
        expected_outcome: "matched",
        relevant_skill_ids: [skill.skill_id],
      });
    } else {
      cases.push({
        query: `execute task related to ${skill.title}`,
        split: "test",
        expected_outcome: "matched",
        relevant_skill_ids: [skill.skill_id],
      });
    }
  }

  // --- 2. Ambiguous Cases ---
  if (skills.length >= 2) {
    // Pair skills for ambiguous multi-match
    for (let i = 0; i < skills.length - 1; i += 2) {
      const s1 = skills[i]!;
      const s2 = skills[i + 1]!;
      const split: DecisionSplit = i % 4 === 0 ? "tune" : "test";
      cases.push({
        query: `automated task using ${s1.title} and ${s2.title}`,
        split,
        expected_outcome: "ambiguous",
        relevant_skill_ids: [s1.skill_id, s2.skill_id],
      });
    }
  } else {
    // Fallback ambiguous cases if fewer than 2 skills
    cases.push({
      query: "automate browser workflow testing",
      split: "tune",
      expected_outcome: "ambiguous",
      relevant_skill_ids: ["mock-e2e", "mock-browser"],
    });
    cases.push({
      query: "extract and fetch clean web text",
      split: "test",
      expected_outcome: "ambiguous",
      relevant_skill_ids: ["mock-fetch", "mock-extract"],
    });
  }

  // Ensure both tune and test have ambiguous cases
  if (!cases.some((c) => c.split === "tune" && c.expected_outcome === "ambiguous")) {
    const sIds = skills.length >= 2 ? [skills[0]!.skill_id, skills[1]!.skill_id] : ["mock-a", "mock-b"];
    cases.push({
      query: "integrated workflow multi skill query",
      split: "tune",
      expected_outcome: "ambiguous",
      relevant_skill_ids: sIds,
    });
  }
  if (!cases.some((c) => c.split === "test" && c.expected_outcome === "ambiguous")) {
    const sIds = skills.length >= 2 ? [skills[0]!.skill_id, skills[1]!.skill_id] : ["mock-a", "mock-b"];
    cases.push({
      query: "combined operations multi skill query",
      split: "test",
      expected_outcome: "ambiguous",
      relevant_skill_ids: sIds,
    });
  }

  // --- 3. No Match Cases ---
  GENERIC_NO_MATCH_QUERIES.forEach((q, idx) => {
    cases.push({
      query: q,
      split: idx % 2 === 0 ? "tune" : "test",
      expected_outcome: "no_match",
      relevant_skill_ids: [],
    });
  });

  // Ensure both splits have at least 1 matched case if skills were empty
  if (skills.length === 0) {
    cases.push({
      query: "run mock container action",
      split: "tune",
      expected_outcome: "matched",
      relevant_skill_ids: ["mock-container"],
    });
    cases.push({
      query: "search mock API docs",
      split: "test",
      expected_outcome: "matched",
      relevant_skill_ids: ["mock-docs"],
    });
  }

  return cases;
}
