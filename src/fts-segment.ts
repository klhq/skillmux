// unicode61 treats a contiguous CJK run as one token, so "安全漏洞" never matches
// a sentence that merely contains it. Languages written without spaces get
// word boundaries inserted before indexing and before querying.
const UNSPACED_RUN =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}ー々]+/gu;

const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });

export function segmentForFts(text: string): string {
  return text.replace(UNSPACED_RUN, (run) =>
    [...segmenter.segment(run)].map((part) => part.segment).join(" "),
  );
}
