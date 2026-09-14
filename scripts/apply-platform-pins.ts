/**
 * Writes the platform packages into package.json as optionalDependencies,
 * pinned to the manifest's own version, immediately before publishing.
 *
 * They deliberately do not live in the committed manifest. The root package
 * depends on artifacts that this repository itself produces, so declaring them
 * in the working tree makes the dependency graph circular: `bun install` pulls
 * down the previous release's compiled binary, roughly 100MB of it, to build
 * the next one.
 *
 * That circularity is also what kept breaking `bun install --frozen-lockfile`.
 * Release Please bumped the pins through its extra-files updater, which edits
 * the manifest but never re-runs the package manager, so the lockfile went
 * stale on every release. It stayed hidden until 1.13.0 because an optional
 * dependency that cannot be resolved is skipped, and the platform packages did
 * not exist on npm yet. Once they were published the lockfile no longer
 * matched, and CI failed on every branch.
 *
 * Injecting at publish time removes the cycle instead of papering over it: the
 * repository never installs its own binaries, the lockfile never records them,
 * and the published manifest is unchanged from what it has always been.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { BINARY_TARGETS } from "./build-binaries";
import { platformPackageName } from "./package-npm-binaries";

export function platformPins(version: string): Record<string, string> {
  return Object.fromEntries(BINARY_TARGETS.map((target) => [platformPackageName(target), version]));
}

export function applyPlatformPins(manifestPath: string): Record<string, string> {
  const source = readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(source) as { version?: string; optionalDependencies?: unknown };

  if (!manifest.version) throw new Error(`${manifestPath} has no version to pin against`);

  const pins = platformPins(manifest.version);
  manifest.optionalDependencies = pins;

  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  // Publishing a root package whose platform packages are missing leaves every
  // user with a launcher and no executable, so prove the write landed rather
  // than trusting it.
  const written = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    optionalDependencies?: Record<string, string>;
  };
  for (const [name, expected] of Object.entries(pins)) {
    if (written.optionalDependencies?.[name] !== expected) {
      throw new Error(`failed to pin ${name} to ${expected} in ${manifestPath}`);
    }
  }

  return pins;
}

if (import.meta.main) {
  const manifestPath = process.argv[2] ?? join(import.meta.dir, "..", "package.json");
  const pins = applyPlatformPins(manifestPath);
  for (const [name, version] of Object.entries(pins)) console.log(`pinned ${name}@${version}`);
}
