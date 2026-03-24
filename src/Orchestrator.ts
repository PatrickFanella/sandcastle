import { Effect } from "effect";
import type { SandcastleConfig } from "./Config.js";
import { Display } from "./Display.js";
import { preprocessPrompt } from "./PromptPreprocessor.js";
import { AgentError } from "./errors.js";
import type { SandboxError } from "./errors.js";
import type { SandboxService } from "./Sandbox.js";
import { SandboxFactory } from "./SandboxFactory.js";
import { withSandboxLifecycle } from "./SandboxLifecycle.js";

export interface TokenUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_read_input_tokens: number;
  readonly cache_creation_input_tokens: number;
  readonly total_cost_usd: number;
  readonly num_turns: number;
  readonly duration_ms: number;
}

export const DEFAULT_MODEL = "claude-opus-4-6";

export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "claude-opus-4-6": 200_000,
  "claude-sonnet-4-6": 200_000,
  "claude-haiku-4-5-20251001": 200_000,
};

const extractUsage = (obj: Record<string, unknown>): TokenUsage | null => {
  const usage = obj.usage as Record<string, unknown> | undefined;
  if (
    !usage ||
    typeof usage.input_tokens !== "number" ||
    typeof usage.output_tokens !== "number"
  ) {
    return null;
  }
  return {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_read_input_tokens:
      typeof usage.cache_read_input_tokens === "number"
        ? usage.cache_read_input_tokens
        : 0,
    cache_creation_input_tokens:
      typeof usage.cache_creation_input_tokens === "number"
        ? usage.cache_creation_input_tokens
        : 0,
    total_cost_usd:
      typeof obj.total_cost_usd === "number" ? obj.total_cost_usd : 0,
    num_turns: typeof obj.num_turns === "number" ? obj.num_turns : 0,
    duration_ms: typeof obj.duration_ms === "number" ? obj.duration_ms : 0,
  };
};

/** Extract displayable text from a stream-json line */
export const parseStreamJsonLine = (
  line: string,
):
  | { type: "text"; text: string }
  | { type: "result"; result: string; usage: TokenUsage | null }
  | null => {
  if (!line.startsWith("{")) return null;
  try {
    const obj = JSON.parse(line);
    if (obj.type === "assistant" && Array.isArray(obj.message?.content)) {
      const texts = obj.message.content
        .filter((c: { type: string }) => c.type === "text")
        .map((c: { text: string }) => c.text);
      if (texts.length > 0) return { type: "text", text: texts.join("") };
    }
    if (obj.type === "result" && typeof obj.result === "string") {
      return { type: "result", result: obj.result, usage: extractUsage(obj) };
    }
  } catch {
    // Not valid JSON — skip
  }
  return null;
};

const invokeAgent = (
  sandbox: SandboxService,
  sandboxRepoDir: string,
  prompt: string,
  model: string,
  onText: (text: string) => void,
): Effect.Effect<{ result: string; usage: TokenUsage | null }, SandboxError> =>
  Effect.gen(function* () {
    let resultText = "";
    let tokenUsage: TokenUsage | null = null;

    const execResult = yield* sandbox.execStreaming(
      `claude --print --verbose --dangerously-skip-permissions --output-format stream-json --model ${model} -p ${shellEscape(prompt)}`,
      (line) => {
        const parsed = parseStreamJsonLine(line);
        if (parsed?.type === "text") {
          onText(parsed.text);
        } else if (parsed?.type === "result") {
          resultText = parsed.result;
          tokenUsage = parsed.usage;
        }
      },
      { cwd: sandboxRepoDir },
    );

    if (execResult.exitCode !== 0) {
      return yield* Effect.fail(
        new AgentError({
          message: `Claude exited with code ${execResult.exitCode}:\n${execResult.stderr}`,
        }),
      );
    }

    return { result: resultText || execResult.stdout, usage: tokenUsage };
  });

const shellEscape = (s: string): string => "'" + s.replace(/'/g, "'\\''") + "'";

const formatNumber = (n: number): string => n.toLocaleString("en-US");

const formatUsageRows = (
  usage: TokenUsage,
  model: string,
): Record<string, string> => {
  const rows: Record<string, string> = {
    Tokens: `${formatNumber(usage.input_tokens)} in / ${formatNumber(usage.output_tokens)} out`,
  };

  const contextWindow = MODEL_CONTEXT_WINDOWS[model];
  if (contextWindow) {
    rows.Context = `${((usage.input_tokens / contextWindow) * 100).toFixed(1)}%`;
  }

  rows.Cost = `$${usage.total_cost_usd.toFixed(2)}`;
  rows.Turns = `${usage.num_turns}`;

  return rows;
};

const COMPLETION_SIGNAL = "<promise>COMPLETE</promise>";

export interface OrchestrateOptions {
  readonly hostRepoDir: string;
  readonly sandboxRepoDir: string;
  readonly iterations: number;
  readonly config?: SandcastleConfig;
  readonly prompt: string;
  readonly branch?: string;
  readonly model?: string;
}

export interface OrchestrateResult {
  readonly iterationsRun: number;
  readonly complete: boolean;
}

export const orchestrate = (
  options: OrchestrateOptions,
): Effect.Effect<OrchestrateResult, SandboxError, SandboxFactory | Display> =>
  Effect.gen(function* () {
    const factory = yield* SandboxFactory;
    const display = yield* Display;
    const { hostRepoDir, sandboxRepoDir, iterations, config, prompt, branch } =
      options;
    const resolvedModel = options.model ?? DEFAULT_MODEL;

    for (let i = 1; i <= iterations; i++) {
      yield* display.status(`Iteration ${i}/${iterations}`, "info");

      const iterationResult = yield* factory.withSandbox(
        withSandboxLifecycle(
          { hostRepoDir, sandboxRepoDir, hooks: config?.hooks, branch },
          (ctx) =>
            Effect.gen(function* () {
              // Preprocess prompt (run !`command` expressions inside sandbox)
              const fullPrompt = yield* preprocessPrompt(
                prompt,
                ctx.sandbox,
                ctx.sandboxRepoDir,
              );

              // Invoke the agent
              const onText = (text: string) =>
                Effect.runSync(display.text(text));
              const { result: agentOutput, usage } = yield* display.spinner(
                "Running agent...",
                invokeAgent(
                  ctx.sandbox,
                  ctx.sandboxRepoDir,
                  fullPrompt,
                  resolvedModel,
                  onText,
                ),
              );

              // Log usage summary
              if (usage) {
                yield* display.summary(
                  "Token Usage",
                  formatUsageRows(usage, resolvedModel),
                );
              }

              // Check completion signal
              if (agentOutput.includes(COMPLETION_SIGNAL)) {
                return { complete: true } as const;
              }
              return { complete: false } as const;
            }),
        ),
      );

      if (iterationResult.complete) {
        yield* display.status(
          `Agent signaled completion after ${i} iteration(s).`,
          "success",
        );
        return { iterationsRun: i, complete: true };
      }
    }

    yield* display.status(`Completed ${iterations} iteration(s).`, "info");
    return { iterationsRun: iterations, complete: false };
  });
