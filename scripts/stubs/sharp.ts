/**
 * Build-time replacement for `sharp` in the compiled binary.
 *
 * `@huggingface/transformers` requires sharp eagerly at import time for image
 * pipelines, and its native bindings cannot be embedded in a single-file
 * executable. Text embedding never touches it, so resolving the specifier here
 * is what lets `pipeline("feature-extraction", ...)` load at all. Anything that
 * genuinely needs image decoding throws instead of failing obscurely deeper in.
 */
function sharpUnavailable(): never {
  throw new Error(
    "Image processing is unavailable in the compiled Skillmux binary. " +
      "Run Skillmux from source with Bun if you need sharp.",
  );
}

export default sharpUnavailable;
