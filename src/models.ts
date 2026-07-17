import { expandHome } from "./config";
import type { Config } from "./types";

export async function downloadLocalModels(config: Config): Promise<string> {
  if (config.inference.mode !== "local") {
    throw new Error("models download is only available for inference.mode = \"local\".");
  }

  const cacheDir = expandHome(config.inference.models_dir);
  process.env.HF_HUB_CACHE = cacheDir;
  process.env.HF_HOME = cacheDir;
  const { env, pipeline } = await import("@huggingface/transformers");
  env.cacheDir = cacheDir;

  await pipeline("feature-extraction", config.inference.embedding.model, {
    device: config.inference.embedding.device ?? "cpu",
    dtype: config.inference.embedding.dtype ?? "q8",
  });
  await pipeline("text-classification", config.inference.reranker.model, {
    device: config.inference.reranker.device ?? "cpu",
    dtype: config.inference.reranker.dtype ?? "q8",
  });
  return cacheDir;
}
