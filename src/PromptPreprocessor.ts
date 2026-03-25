import { Effect } from "effect";
import { Display } from "./Display.js";
import { PromptError } from "./errors.js";
import type { ExecError } from "./errors.js";
import type { SandboxService } from "./Sandbox.js";

export const preprocessPrompt = (
  prompt: string,
  sandbox: SandboxService,
  cwd: string,
): Effect.Effect<string, ExecError | PromptError, Display> => {
  const pattern = /!`([^`]+)`/g;
  const matches = [...prompt.matchAll(pattern)];

  if (matches.length === 0) {
    return Effect.succeed(prompt);
  }

  return Effect.gen(function* () {
    const display = yield* Display;
    return yield* display.taskLog("Expanding commands in prompt", (message) =>
      Effect.gen(function* () {
        let result = prompt;
        // Process matches in reverse order to preserve indices
        for (const match of [...matches].reverse()) {
          const command = match[1]!;
          const index = match.index!;
          message(command);
          const execResult = yield* sandbox.exec(command, { cwd });
          if (execResult.exitCode !== 0) {
            return yield* Effect.fail(
              new PromptError({
                message: `Command \`${command}\` exited with code ${execResult.exitCode}: ${execResult.stderr}`,
              }),
            );
          }
          result =
            result.slice(0, index) +
            execResult.stdout.trimEnd() +
            result.slice(index + match[0].length);
        }
        return result;
      }),
    );
  });
};
