import { Effect } from "effect";
import { Display } from "./Display.js";
import {
  PromptError,
  PromptExpansionTimeoutError,
  withTimeout,
} from "./errors.js";
import type { ExecError } from "./errors.js";
import type { SandboxService } from "./SandboxFactory.js";

const PROMPT_EXPANSION_TIMEOUT_MS = 30_000;

export const preprocessPrompt = (
  prompt: string,
  sandbox: SandboxService,
  cwd: string,
): Effect.Effect<
  string,
  ExecError | PromptError | PromptExpansionTimeoutError,
  Display
> => {
  const pattern = /!`([^`]+)`/g;
  const matches = [...prompt.matchAll(pattern)];

  if (matches.length === 0) {
    return Effect.succeed(prompt);
  }

  return Effect.gen(function* () {
    const display = yield* Display;
    return yield* display.taskLog("Expanding shell expressions", (message) =>
      Effect.gen(function* () {
        // Execute all commands in parallel
        const results = yield* Effect.all(
          matches.map((match) => {
            const command = match[1]!;
            return Effect.flatMap(
              sandbox.exec(command, { cwd }),
              (execResult) =>
                execResult.exitCode !== 0
                  ? Effect.fail(
                      new PromptError({
                        message: `Command \`${command}\` exited with code ${execResult.exitCode}: ${execResult.stderr}`,
                      }),
                    )
                  : Effect.succeed(execResult.stdout.trimEnd()),
            ).pipe(
              withTimeout(
                PROMPT_EXPANSION_TIMEOUT_MS,
                () =>
                  new PromptExpansionTimeoutError({
                    message: `Shell expression \`${command}\` timed out after ${PROMPT_EXPANSION_TIMEOUT_MS}ms`,
                    timeoutMs: PROMPT_EXPANSION_TIMEOUT_MS,
                    expression: command,
                  }),
              ),
            );
          }),
          { concurrency: "unbounded" },
        );

        // Log per-command token counts
        for (let i = 0; i < matches.length; i++) {
          const command = matches[i]![1]!;
          const tokens = Math.ceil(results[i]!.length / 4);
          message(`${command} \u2192 ~${tokens} tokens`);
        }

        // Replace all matches using original indices (process in reverse to preserve positions)
        let result = prompt;
        for (let i = matches.length - 1; i >= 0; i--) {
          const match = matches[i]!;
          const index = match.index!;
          result =
            result.slice(0, index) +
            results[i] +
            result.slice(index + match[0].length);
        }
        return result;
      }),
    );
  });
};
