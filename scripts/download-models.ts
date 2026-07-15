import path from "node:path";

const cacheDir = path.resolve(process.env.SKILL_ROUTER_MODELS_DIR || "./.models");
process.env.HF_HUB_CACHE = cacheDir;
process.env.HF_HOME = cacheDir;

// Import after setting env vars
const { env, pipeline } = await import("@huggingface/transformers");
env.cacheDir = cacheDir;

console.log(`Downloading models to: ${cacheDir}`);

try {
  console.log("Downloading BAAI/bge-m3 (embeddings)...");
  await pipeline("feature-extraction", "Xenova/bge-m3", {
    device: "cpu",
    dtype: "q8",
  });
  console.log("BAAI/bge-m3 downloaded successfully.");

  console.log("Downloading BAAI/bge-reranker-v2-m3 (reranking)...");
  await pipeline("text-classification", "onnx-community/bge-reranker-v2-m3-ONNX", {
    device: "cpu",
    dtype: "q8",
  });
  console.log("BAAI/bge-reranker-v2-m3 downloaded successfully.");

  console.log("All models downloaded successfully.");
} catch (error) {
  console.error("Error downloading models:", error);
  process.exit(1);
}
