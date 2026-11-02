import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expandHome } from "./config";
import { listSkills } from "./skill-list";
import { getStats, parseSince, queryAuditRows, queryFetchRows, type ContextSavings, type StatsResponse } from "./stats";
import { estimateTokens, TOKEN_ESTIMATE_METHOD } from "./token-estimate";
import { describeToolsForEstimate } from "./tool-defs";
import { resolveSkillRoot } from "./vault";
import type { Config } from "./types";

/** Name and description of each unpinned skill, the way a native client lists them. */
export function nativeListingLine(skillId: string, description: string): string {
  return `${skillId}: ${description}`;
}

export async function computeNativeBaseline(
  config: Config,
): Promise<{ unpinned_skill_count: number; baseline_tokens: number }> {
  const { skills } = await listSkills(config, { placement: "mcp-only" });
  let tokens = 0;
  for (const skill of skills) tokens += estimateTokens(nativeListingLine(skill.skill_id, skill.description));
  return { unpinned_skill_count: skills.length, baseline_tokens: tokens };
}

export type { ContextSavings };

export async function computeContextSavings(
  config: Config,
  auditDb: Database,
  since: string,
  now: Date = new Date(),
): Promise<ContextSavings> {
  const sinceIso = parseSince(since, now).toISOString();
  const { skills } = await listSkills(config);
  const descriptions = new Map(skills.map((skill) => [skill.skill_id, skill.description]));
  const baseline = await computeNativeBaseline(config);
  const toolTokens = estimateTokens(describeToolsForEstimate());

  const resolves = queryAuditRows(auditDb, sinceIso);
  let shortlistTokens = 0;
  for (const row of resolves) {
    // Rebuild the response the client received. Descriptions come from the vault
    // as it is now, so an edited description shifts the estimate slightly.
    shortlistTokens += estimateTokens(
      JSON.stringify({
        request_id: row.request_id,
        retrieval: row.retrieval,
        candidates: row.candidates.map((candidate, index) => ({
          rank: index + 1,
          skill_id: candidate.skill_id,
          description: descriptions.get(candidate.skill_id) ?? "",
          score: candidate.score,
        })),
      }),
    );
  }

  const fetchCounts = new Map<string, number>();
  for (const row of queryFetchRows(auditDb, sinceIso)) {
    fetchCounts.set(row.skill_id, (fetchCounts.get(row.skill_id) ?? 0) + 1);
  }
  const vaultPath = expandHome(config.vault_path);
  const localVaultPaths = config.local_vault_paths.map(expandHome);
  let fetchBodyTokens = 0;
  for (const [skillId, count] of fetchCounts) {
    const root = resolveSkillRoot(skillId, vaultPath, localVaultPaths);
    if (!root) continue; // the skill was removed since the fetch
    const file = join(root, skillId, "SKILL.md");
    if (!existsSync(file)) continue;
    fetchBodyTokens += estimateTokens(readFileSync(file, "utf-8")) * count;
  }

  return {
    method: TOKEN_ESTIMATE_METHOD,
    unpinned_skill_count: baseline.unpinned_skill_count,
    baseline_tokens: baseline.baseline_tokens,
    tool_definition_tokens: toolTokens,
    session_start_savings_tokens: baseline.baseline_tokens - toolTokens,
    resolve_calls: resolves.length,
    shortlist_tokens: shortlistTokens,
    average_shortlist_tokens: resolves.length === 0 ? 0 : Math.round(shortlistTokens / resolves.length),
    fetch_body_tokens: fetchBodyTokens,
  };
}

export async function getStatsWithSavings(
  config: Config,
  auditDb: Database,
  since: string,
  now: Date = new Date(),
): Promise<StatsResponse> {
  const stats = getStats(auditDb, since, now);
  try {
    return { ...stats, context_savings: await computeContextSavings(config, auditDb, since, now) };
  } catch (error) {
    // A vault that cannot be read must not take the routing statistics down with it.
    console.error(`skillmux: context savings unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return stats;
  }
}
