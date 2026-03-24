import { Effect } from "effect";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { SandboxError } from "./Sandbox.js";

export interface ResolvePromptOptions {
  readonly prompt?: string;
  readonly promptFile?: string;
  readonly cwd?: string;
}

export const resolvePrompt = (
  options: ResolvePromptOptions,
): Effect.Effect<string, SandboxError> => {
  const { prompt, promptFile, cwd = process.cwd() } = options;

  if (prompt !== undefined && promptFile !== undefined) {
    return Effect.fail(
      new SandboxError(
        "resolvePrompt",
        "Cannot provide both --prompt and --prompt-file",
      ),
    );
  }

  if (prompt !== undefined) {
    return Effect.succeed(prompt);
  }

  const path = promptFile ?? join(cwd, ".sandcastle", "prompt.md");

  return Effect.tryPromise({
    try: () => readFile(path, "utf-8"),
    catch: (e) =>
      new SandboxError(
        "resolvePrompt",
        `Failed to read prompt from ${path}: ${e}`,
      ),
  });
};
