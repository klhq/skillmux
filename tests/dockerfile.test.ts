import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
