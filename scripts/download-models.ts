import path from "node:path";
import { loadConfig } from "../src/config";

// Resolve configuration
const config = await loadConfig();

const embedModel = config.embedding.model || "Xenova/bge-m3";
const embedDevice = config.embedding.device || "cpu";
const embedDtype = config.embedding.dtype || "q8";

const rerankModel = config.rerank.model || "onnx-community/bge-reranker-v2-m3-ONNX";
const rerankDevice = config.rerank.device || "cpu";
const rerankDtype = config.rerank.dtype || "q8";

if (process.env.MOCK_HF_DOWNLOAD === "true") {
  console.log(`[MOCK] Downloading ${embedModel} (embeddings)...`);
  console.log(`[MOCK] Downloading ${rerankModel} (reranking)...`);
  if (process.env.MOCK_HF_LOG_PATH) {
    const fs = await import("node:fs");
    fs.appendFileSync(
      process.env.MOCK_HF_LOG_PATH,
      JSON.stringify({
        embed: { model: embedModel, device: embedDevice, dtype: embedDtype },
        rerank: { model: rerankModel, device: rerankDevice, dtype: rerankDtype }
      }) + "\n"
    );
  }
  process.exit(0);
}

const cacheDir = path.resolve(
  process.env.SKILL_ROUTER_MODELS_DIR || config.state_dir || "./.models"
);
process.env.HF_HUB_CACHE = cacheDir;
process.env.HF_HOME = cacheDir;

// Import after setting env vars
const { env, pipeline } = await import("@huggingface/transformers");
env.cacheDir = cacheDir;

console.log(`Downloading models to: ${cacheDir}`);

try {
  console.log(`Downloading ${embedModel} (embeddings) [device: ${embedDevice}, dtype: ${embedDtype}]...`);
  await pipeline("feature-extraction", embedModel, {
    device: embedDevice as any,
    dtype: embedDtype as any,
  });
  console.log(`${embedModel} downloaded successfully.`);

  console.log(`Downloading ${rerankModel} (reranking) [device: ${rerankDevice}, dtype: ${rerankDtype}]...`);
  await pipeline("text-classification", rerankModel, {
    device: rerankDevice as any,
    dtype: rerankDtype as any,
  });
  console.log(`${rerankModel} downloaded successfully.`);

  console.log("All models downloaded successfully.");
} catch (error) {
  console.error("Error downloading models:", error);
  process.exit(1);
}
