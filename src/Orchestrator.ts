import { Console, Effect } from "effect";
import type { SandcastleConfig } from "./Config.js";
import { Sandbox, SandboxError, type SandboxService } from "./Sandbox.js";
import { syncIn, syncOut } from "./SyncService.js";

const execOk = (
  sandbox: SandboxService,
  command: string,
  options?: { cwd?: string },
): Effect.Effect<string, SandboxError> =>
  Effect.flatMap(sandbox.exec(command, options), (result) =>
    result.exitCode !== 0
      ? Effect.fail(
          new SandboxError(
            "exec",
            `Command failed (exit ${result.exitCode}): ${command}\n${result.stderr}`,
          ),
        )
      : Effect.succeed(result.stdout),
  );

const getSandboxHead = (
  sandbox: SandboxService,
  sandboxRepoDir: string,
): Effect.Effect<string, SandboxError> =>
  Effect.map(
    execOk(sandbox, "git rev-parse HEAD", { cwd: sandboxRepoDir }),
    (s) => s.trim(),
  );

const fetchIssues = (
  sandbox: SandboxService,
  sandboxRepoDir: string,
  repoFullName: string,
): Effect.Effect<string, SandboxError> =>
  Effect.map(
    sandbox.exec(
      `gh issue list --repo "${repoFullName}" --state open --json number,title,body,comments`,
      { cwd: sandboxRepoDir },
    ),
    (result) => (result.exitCode === 0 ? result.stdout.trim() : "[]"),
  );

const fetchRalphCommits = (
  sandbox: SandboxService,
  sandboxRepoDir: string,
): Effect.Effect<string, SandboxError> =>
  Effect.map(
    sandbox.exec(
      'git log --grep="RALPH" -n 10 --format="%H%n%ad%n%B---" --date=short',
      { cwd: sandboxRepoDir },
    ),
    (result) =>
      result.exitCode === 0 && result.stdout.trim().length > 0
        ? result.stdout.trim()
        : "No RALPH commits found",
  );

/** Extract displayable text from a stream-json line */
export const parseStreamJsonLine = (
  line: string,
):
  | { type: "text"; text: string }
  | { type: "result"; result: string }
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
      return { type: "result", result: obj.result };
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
): Effect.Effect<string, SandboxError> =>
  Effect.gen(function* () {
    let resultText = "";

    const execResult = yield* sandbox.execStreaming(
      `claude --print --verbose --dangerously-skip-permissions --output-format stream-json --model claude-opus-4-6 -p ${shellEscape(prompt)}`,
      (line) => {
        const parsed = parseStreamJsonLine(line);
        if (parsed?.type === "text") {
          console.log(parsed.text);
        } else if (parsed?.type === "result") {
          resultText = parsed.result;
        }
      },
      { cwd: sandboxRepoDir },
    );

    if (execResult.exitCode !== 0) {
      return yield* Effect.fail(
        new SandboxError(
          "invokeAgent",
          `Claude exited with code ${execResult.exitCode}:\n${execResult.stderr}`,
        ),
      );
    }

    return resultText || execResult.stdout;
  });

const shellEscape = (s: string): string => "'" + s.replace(/'/g, "'\\''") + "'";

const COMPLETION_SIGNAL = "<promise>COMPLETE</promise>";

export interface OrchestrateOptions {
  readonly hostRepoDir: string;
  readonly sandboxRepoDir: string;
  readonly iterations: number;
  readonly config?: SandcastleConfig;
  readonly repoFullName: string;
  readonly prompt: string;
}

export interface OrchestrateResult {
  readonly iterationsRun: number;
  readonly complete: boolean;
}

export const orchestrate = (
  options: OrchestrateOptions,
): Effect.Effect<OrchestrateResult, SandboxError, Sandbox> =>
  Effect.gen(function* () {
    const sandbox = yield* Sandbox;
    const {
      hostRepoDir,
      sandboxRepoDir,
      iterations,
      config,
      repoFullName,
      prompt,
    } = options;

    // Initial sync-in
    yield* Console.log("Syncing repo into sandbox...");
    yield* syncIn(hostRepoDir, sandboxRepoDir, config);

    for (let i = 1; i <= iterations; i++) {
      yield* Console.log(`\n=== Iteration ${i}/${iterations} ===\n`);

      // Record HEAD before agent runs
      const baseHead = yield* getSandboxHead(sandbox, sandboxRepoDir);

      // Fetch context
      const issues = yield* fetchIssues(sandbox, sandboxRepoDir, repoFullName);
      const ralphCommits = yield* fetchRalphCommits(sandbox, sandboxRepoDir);

      // Build full prompt with context
      const fullPrompt = `ISSUES: ${issues}\n\nPrevious RALPH commits: ${ralphCommits}\n\n${prompt}`;

      // Invoke the agent
      yield* Console.log("Running agent...");
      const agentOutput = yield* invokeAgent(
        sandbox,
        sandboxRepoDir,
        fullPrompt,
      );

      // Check for new commits and sync out
      const newHead = yield* getSandboxHead(sandbox, sandboxRepoDir);
      if (newHead !== baseHead) {
        yield* Console.log("New commits detected. Syncing out...");
        yield* syncOut(hostRepoDir, sandboxRepoDir, baseHead);
      } else {
        yield* Console.log("No new commits in this iteration.");
      }

      // Check completion signal
      if (agentOutput.includes(COMPLETION_SIGNAL)) {
        yield* Console.log(
          `\nAgent signaled completion after ${i} iteration(s).`,
        );
        return { iterationsRun: i, complete: true };
      }

      // Re-sync for next iteration
      if (i < iterations) {
        yield* Console.log("Re-syncing sandbox for next iteration...");
        yield* syncIn(hostRepoDir, sandboxRepoDir, config);
      }
    }

    yield* Console.log(`\nCompleted ${iterations} iteration(s).`);
    return { iterationsRun: iterations, complete: false };
  });
