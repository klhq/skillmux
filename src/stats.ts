export const SINCE_PATTERN = /^(\d+[hdwmy]|\d{4}-\d{2}-\d{2}([T ].+)?)$/;

const RELATIVE_WINDOW = /^(\d+)([hdwmy])$/;
const UNIT_MS: Record<string, number> = {
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
  m: 2_592_000_000,
  y: 31_536_000_000,
};

export function parseSince(since: string, now: Date = new Date()): Date {
  if (!SINCE_PATTERN.test(since)) throw new Error(`invalid --since window: ${since}`);

  const relative = RELATIVE_WINDOW.exec(since);
  if (relative) {
    const amount = Number(relative[1]);
    const unitMs = UNIT_MS[relative[2]!]!;
    return new Date(now.getTime() - amount * unitMs);
  }

  const parsed = new Date(since);
  if (Number.isNaN(parsed.getTime())) throw new Error(`invalid --since window: ${since}`);
  return parsed;
}
