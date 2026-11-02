import { z } from "zod";
import { SKILL_ID_PATTERN } from "./vault";

/**
 * The MCP tool definitions skillmux advertises. They live here so the server
 * registers exactly what the context-savings report measures.
 */
export const RESOLVE_SKILL_TOOL = {
  name: "resolve_skill",
  description:
    "Route a natural-language task description to candidate skills in the vault. " +
    "Returns a ranked shortlist of candidates. Use fetch_skill to retrieve a candidate's complete instructions.",
  inputSchema: z.object({
    query: z.string().min(1).describe("Natural-language task or prompt description to route."),
    top_k: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Optional maximum number of ranked candidates to return (subject to server max_top_k limit)."),
  }),
};

export const FETCH_SKILL_TOOL = {
  name: "fetch_skill",
  description:
    "Fetch a skill's SKILL.md verbatim by skill_id, with sha256 and supporting-file paths. " +
    "Pass path from that files list to read one supporting UTF-8 text file (at most 256 KiB). " +
    "Pass the main response's fetch_id as parent_fetch_id to link attachment audit. " +
    "Independent of any prior resolve_skill outcome. Pass the request_id from a prior " +
    "resolve_skill call to link this fetch to it for quality measurement.",
  inputSchema: z.object({
    skill_id: z.string().regex(SKILL_ID_PATTERN),
    request_id: z.string().min(1).max(128).optional(),
    path: z.string().min(1).optional().describe("Canonical relative path from the skill's files list; omit for SKILL.md."),
    parent_fetch_id: z.number().int().positive().optional().describe("Main-file fetch_id for this skill; use with path."),
  }),
};

/** The tools/list payload, serialised the way a client puts it in its context. */
export function describeToolsForEstimate(): string {
  return JSON.stringify(
    [RESOLVE_SKILL_TOOL, FETCH_SKILL_TOOL].map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: z.toJSONSchema(tool.inputSchema),
    })),
  );
}
