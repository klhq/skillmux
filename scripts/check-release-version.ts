const tag = process.env.GITHUB_REF_NAME;
if (!tag) throw new Error("GITHUB_REF_NAME is required");

const pkg = await Bun.file("package.json").json() as { version?: string };
if (!pkg.version) throw new Error("package.json version is missing");
if (tag !== `v${pkg.version}`) {
  throw new Error(`Tag ${tag} does not match package.json version ${pkg.version}`);
}

console.log(`release version ${pkg.version} matches ${tag}`);
