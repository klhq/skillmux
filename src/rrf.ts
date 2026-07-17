export interface RankedItem {
  skill_id: string;
}

export function reciprocalRankFusion<T extends RankedItem>(lexical: T[], semantic: T[], rankConstant = 60): T[] {
  const byId = new Map<string, { item: T; score: number; lexical: number; semantic: number }>();
  const add = (items: T[], lane: "lexical" | "semantic") => {
    items.forEach((item, index) => {
      const current = byId.get(item.skill_id) ?? {
        item,
        score: 0,
        lexical: Number.POSITIVE_INFINITY,
        semantic: Number.POSITIVE_INFINITY,
      };
      current.score += 1 / (rankConstant + index + 1);
      current[lane] = index;
      byId.set(item.skill_id, current);
    });
  };
  add(lexical, "lexical");
  add(semantic, "semantic");
  return [...byId.values()]
    .sort((a, b) =>
      b.score - a.score
      || Number(a.semantic === Infinity) - Number(b.semantic === Infinity)
      || a.semantic - b.semantic
      || a.lexical - b.lexical
      || a.item.skill_id.localeCompare(b.item.skill_id),
    )
    .map((entry) => entry.item);
}
