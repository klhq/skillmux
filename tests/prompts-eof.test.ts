import { describe, expect, test } from "bun:test";
import { PassThrough, Readable, Writable } from "node:stream";
import {
  askQuestion,
  NO_INPUT_ERROR,
  promptMultiSelect,
  promptText,
} from "../src/prompts";
import { confirmAction } from "../src/commands/shared";

/** Discards prompt text so tests don't write to the real terminal. */
function sink(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
}

/** A stream that delivers `answers` then ends, like piped stdin. */
function piped(...answers: string[]): Readable {
  return Readable.from([answers.map((line) => `${line}\n`).join("")]);
}

/** A stream that is already at EOF, like `< /dev/null`. */
function eof(): Readable {
  const stream = new PassThrough();
  stream.end();
  return stream;
}

// Every test here has an explicit timeout: the bug being guarded against is a
// hang, so a regression must fail fast rather than wedge the suite.
const TIMEOUT = 5_000;

describe("prompts with piped input still work", () => {
  test(
    "askQuestion resolves with the piped answer",
    async () => {
      const answer = await askQuestion("Question: ", {
        input: piped("hello"),
        output: sink(),
      });
      expect(answer).toBe("hello");
    },
    TIMEOUT,
  );

  test(
    "promptText falls back to its default on an empty answer",
    async () => {
      const answered = await promptText("Vault path", "~/skills", {
        input: piped("~/custom"),
        output: sink(),
      });
      expect(answered).toBe("~/custom");

      const defaulted = await promptText("Vault path", "~/skills", {
        input: piped(""),
        output: sink(),
      });
      expect(defaulted).toBe("~/skills");
    },
    TIMEOUT,
  );

  test(
    "confirmAction accepts a piped y and treats anything else as no",
    async () => {
      expect(
        await confirmAction("proceed?", { input: piped("y"), output: sink() }),
      ).toBe(true);
      expect(
        await confirmAction("proceed?", { input: piped("n"), output: sink() }),
      ).toBe(false);
      expect(
        await confirmAction("proceed?", { input: piped(""), output: sink() }),
      ).toBe(false);
    },
    TIMEOUT,
  );

  test(
    "promptMultiSelect honors a piped selection and its defaults",
    async () => {
      const options = [
        { value: "claude-code", label: "claude-code", selected: true },
        { value: "codex", label: "codex" },
      ] as const;

      expect(
        await promptMultiSelect("Which agents?", options, {
          input: piped("2"),
          output: sink(),
        }),
      ).toEqual(["codex"]);

      expect(
        await promptMultiSelect("Which agents?", options, {
          input: piped(""),
          output: sink(),
        }),
      ).toEqual(["claude-code"]);
    },
    TIMEOUT,
  );
});

describe("prompts fail fast instead of hanging when stdin is at EOF", () => {
  test(
    "askQuestion rejects with an actionable error",
    async () => {
      await expect(
        askQuestion("Question: ", { input: eof(), output: sink() }),
      ).rejects.toThrow(NO_INPUT_ERROR);
    },
    TIMEOUT,
  );

  test(
    "promptText rejects rather than silently taking its default",
    async () => {
      await expect(
        promptText("Vault path", "~/skills", { input: eof(), output: sink() }),
      ).rejects.toThrow(NO_INPUT_ERROR);
    },
    TIMEOUT,
  );

  test(
    "confirmAction rejects rather than hanging on a confirmation",
    async () => {
      await expect(
        confirmAction("proceed?", { input: eof(), output: sink() }),
      ).rejects.toThrow(NO_INPUT_ERROR);
    },
    TIMEOUT,
  );

  test(
    "promptMultiSelect rejects rather than hanging",
    async () => {
      await expect(
        promptMultiSelect(
          "Which agents?",
          [{ value: "codex", label: "codex" }] as const,
          { input: eof(), output: sink() },
        ),
      ).rejects.toThrow(NO_INPUT_ERROR);
    },
    TIMEOUT,
  );
});
