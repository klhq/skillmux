/**
 * Rough token count for text, with no tokenizer dependency.
 *
 * ASCII characters count a quarter token each, the usual English average.
 * Every other character counts one token, which is closer to what CJK and
 * emoji cost on most tokenizers. Real counts differ by client and model, so
 * treat the result as an estimate within about 30 percent, not an exact number.
 */
export const TOKEN_ESTIMATE_METHOD =
  "ASCII characters / 4 plus 1 per non-ASCII character, rounded up; expect up to 30% error against a real tokenizer";

export function estimateTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (const char of text) {
    if (char.charCodeAt(0) < 128) ascii++;
    else other++;
  }
  return Math.ceil(ascii / 4) + other;
}
