import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const dockerfile = readFileSync(join(import.meta.dir, "..", "Dockerfile"), "utf8");

test("separates the container executable from the default HTTP server command", () => {
  expect(dockerfile).toContain('ENTRYPOINT ["/usr/local/bin/skillmux"]');
  expect(dockerfile).toContain('CMD ["serve", "--transport", "http"]');
});

test("probes readiness without a JavaScript runtime in the image", () => {
  const healthcheck = dockerfile
    .split("\n")
    .find((line) => line.startsWith("HEALTHCHECK"));
  const probe = dockerfile.slice(dockerfile.indexOf("HEALTHCHECK")).split("\n").slice(0, 3).join("\n");

  expect(healthcheck).toBeDefined();
  expect(probe).toContain("/health/ready");
  expect(probe).not.toMatch(/\b(bun|node)\b/);
});

test("the model stage copies every source file the prefetch script imports", () => {
  const root = join(import.meta.dir, "..");
  const copied = dockerfile
    .split("\n")
    .filter((line) => line.startsWith("COPY src/") && !line.startsWith("COPY src/ "))
    .flatMap((line) => line.split(/\s+/).slice(1, -1));

  const needed = new Set<string>();
  const visit = (file: string) => {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/from\s+"(\.{1,2}\/[^"]+)"/g)) {
      const target = join(dirname(file), `${match[1]}.ts`);
      const path = relative(root, target);
      if (needed.has(path)) continue;
      needed.add(path);
      visit(target);
    }
  };
  visit(join(root, "scripts", "download-models.ts"));

  expect([...needed].sort()).toEqual([...copied].sort());
});
