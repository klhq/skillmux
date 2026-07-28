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

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "is",
  "it", "of", "on", "or", "the", "this", "to", "use", "with",
]);

function words(value: string): string[] {
  return value
    .toLowerCase()
    .match(/[a-z0-9]+/g)
    ?.filter((word) => word.length > 2 && !STOP_WORDS.has(word)) ?? [];
}

function anchors(skill: VaultSkill): string[] {
  const preferred = [...skill.aliases.flatMap(words), ...words(skill.title)];
  const fallback = words(skill.description);
  return [...new Set([...preferred, ...fallback])].slice(0, 2);
}

function matchedQuery(skill: VaultSkill, variant: number): string {
  const [first = "specialized", second = "workflow"] = anchors(skill);
  const templates = [
    `I need practical guidance completing an unfamiliar ${first} ${second} task safely`,
    `Which available workflow can handle my unusual ${first} ${second} problem end to end`,
    `Please guide me through a difficult unfamiliar ${first} ${second} operation safely`,
  ];
  return templates[variant % templates.length]!;
}

function ambiguousQuery(first: VaultSkill, second: VaultSkill): string {
  const [firstAnchor = "first"] = anchors(first);
  const [secondAnchor = "second"] = anchors(second);
  return `Help with a workflow spanning both ${firstAnchor} and ${secondAnchor} responsibilities`;
}

function nearMissQuery(first: VaultSkill, second: VaultSkill): string {
  const [firstAnchor = "one"] = anchors(first);
  const [secondAnchor = "another"] = anchors(second);
  return `Explain the theory comparing ${firstAnchor} and ${secondAnchor} without performing either workflow`;
}

/**
 * Automatically generate a synthetic decision-policy calibration dataset
 * from local vault skill definitions. Runs 100% locally with zero data leaks.
 */
export function generateDataset(
  skills: VaultSkill[],
  options: GenerateDatasetOptions = {},
): RawDecisionCase[] {
  if (skills.length < 4) {
    throw new Error(
      "Dataset generation requires at least 4 vault skills so tune and test can each contain matched and ambiguous cases without skill leakage",
    );
  }

  const cases: RawDecisionCase[] = [];
  const sorted = [...skills].sort((a, b) => a.skill_id.localeCompare(b.skill_id));
  const splitAt = Math.ceil(sorted.length / 2);
  const bySplit: Record<DecisionSplit, VaultSkill[]> = {
    tune: sorted.slice(0, splitAt),
    test: sorted.slice(splitAt),
  };
  const targetPerSplit = Math.max(3, options.queriesPerSplit ?? 10);

  for (const split of ["tune", "test"] as const) {
    const splitSkills = bySplit[split];
    for (let i = 0; i < splitSkills.length; i++) {
      const skill = splitSkills[i]!;
      cases.push({
        query: matchedQuery(skill, i),
        split,
        expected_outcome: "matched",
        relevant_skill_ids: [skill.skill_id],
      });
    }

    const first = splitSkills[0]!;
    const second = splitSkills[1]!;
    cases.push({
      query: ambiguousQuery(first, second),
      split,
      expected_outcome: "ambiguous",
      relevant_skill_ids: [first.skill_id, second.skill_id],
    });
    cases.push({
      query: nearMissQuery(first, second),
      split,
      expected_outcome: "no_match",
      relevant_skill_ids: [],
    });

    for (let i = cases.filter((item) => item.split === split).length; i < targetPerSplit; i++) {
      const left = splitSkills[i % splitSkills.length]!;
      const right = splitSkills[(i + 1) % splitSkills.length]!;
      cases.push({
        query: i % 2 === 0 ? matchedQuery(left, i) : nearMissQuery(left, right),
        split,
        expected_outcome: i % 2 === 0 ? "matched" : "no_match",
        relevant_skill_ids: i % 2 === 0 ? [left.skill_id] : [],
      });
    }
  }

  return cases;
}
