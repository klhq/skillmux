import { loadConfig } from "../src/config";
import { downloadLocalModels } from "../src/models";

// Resolve configuration
const config = await loadConfig();

if (config.inference.mode !== "local") throw new Error("Model prefetch requires inference.mode = \"local\".");
const embedModel = config.inference.embedding.model;
const embedDevice = config.inference.embedding.device || "cpu";
const embedDtype = config.inference.embedding.dtype || "q8";

if (process.env.MOCK_HF_DOWNLOAD === "true") {
  console.log(`[MOCK] Downloading ${embedModel} (embeddings)...`);
  if (process.env.MOCK_HF_LOG_PATH) {
    const fs = await import("node:fs");
    fs.appendFileSync(
      process.env.MOCK_HF_LOG_PATH,
      JSON.stringify({
        embed: { model: embedModel, device: embedDevice, dtype: embedDtype }
      }) + "\n"
    );
  }
  process.exit(0);
}

try {
  console.log(`Downloading ${embedModel} (${embedDevice}, ${embedDtype})...`);
  const cacheDir = await downloadLocalModels(config);
  console.log(`Models ready in ${cacheDir}.`);
} catch (error) {
  console.error("Error downloading models:", error);
  process.exit(1);
}
