import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("separates the container executable from the default HTTP server command", () => {
  const dockerfile = readFileSync(join(import.meta.dir, "..", "Dockerfile"), "utf8");

  expect(dockerfile).toContain('ENTRYPOINT ["bun", "run", "src/cli.ts"]');
  expect(dockerfile).toContain('CMD ["serve", "--transport", "http"]');
});
