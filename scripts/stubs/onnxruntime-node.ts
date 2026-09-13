/**
 * Build-time replacement for `onnxruntime-node` on targets that have no
 * published native binding.
 *
 * `onnxruntime-node` resolves its addon as
 * `../bin/napi-v6/<platform>/<arch>/onnxruntime_binding.node`, which the
 * bundler evaluates against the *target* platform. On a target the package
 * does not ship — `darwin-x64` today — that resolution fails and the whole
 * compile aborts. Throwing at import time reproduces the same signal a missing
 * native library produces, so retrieval degrades to its lexical lane instead.
 */
throw new Error(
  "Local ONNX inference is unavailable on this platform. Configure remote " +
    "embeddings, or run the Skillmux server image.",
);
