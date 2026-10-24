// unicode61 treats a contiguous CJK run as one token, so "安全漏洞" never matches
// a sentence that merely contains it. Languages written without spaces get
// word boundaries inserted before indexing and before querying.
const UNSPACED_RUN =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}ー々]+/gu;

const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });

export function segmentForFts(text: string): string {
  // Pad each run: unicode61 treats Latin and CJK letters alike, so "PDFから"
  // would otherwise stay one token and never match "PDF".
  return text.replace(UNSPACED_RUN, (run) =>
    ` ${[...segmenter.segment(run)].map((part) => part.segment).join(" ")} `,
  );
}

/**
 * Segment boundaries come from the runtime's ICU dictionaries, and the segmented
 * text is stored in the index. When this value changes, queries could split
 * differently from what was indexed, so the index must be rebuilt.
 */
export const SEGMENTER_VERSION = `icu-${process.versions.icu ?? "unknown"}`;
