import { loadConfig } from "../config";
import { downloadLocalModels } from "../models";
import { emitSuccess } from "../output";

export async function runModelDownload(options: { isJson: boolean }): Promise<void> {
  const cacheDir = await downloadLocalModels(await loadConfig());
  emitSuccess({ isJson: options.isJson }, { cache_dir: cacheDir }, () =>
    console.log(`models ready in ${cacheDir}`),
  );
}
