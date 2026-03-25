import { mkdirSync } from "node:fs";
import path, { dirname, join } from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { Effect, Layer } from "effect";
import { getAgentProvider } from "./AgentProvider.js";
import { readConfig } from "./Config.js";
import { ClackDisplay, Display, FileDisplay } from "./Display.js";
import { orchestrate } from "./Orchestrator.js";
import { resolvePrompt } from "./PromptResolver.js";
import { DockerSandboxFactory, SandboxConfig } from "./SandboxFactory.js";
import { resolveEnv } from "./EnvResolver.js";
import {
  type PromptArgs,
  substitutePromptArgs,
} from "./PromptArgumentSubstitution.js";

const execAsync = promisify(exec);

/** Replace characters that are invalid or problematic in file paths with dashes. */
export const sanitizeBranchForFilename = (branch: string): string =>
  branch.replace(/[/\\:*?"<>|]/g, "-");

export type LoggingOption =
  | { readonly type: "file"; readonly path: string }
  | { readonly type: "stdout" };

export interface RunOptions {
  /** Inline prompt string (mutually exclusive with promptFile) */
  readonly prompt?: string;
  /** Path to a prompt file (mutually exclusive with prompt) */
  readonly promptFile?: string;
  /** Maximum iterations to run (default: 5) */
  readonly maxIterations?: number;
  /** Hooks to run during sandbox lifecycle */
  readonly hooks?: {
    readonly onSandboxReady?: ReadonlyArray<{ command: string }>;
  };
  /** Target branch name for sandbox work */
  readonly branch?: string;
  /** Model to use for the agent (default: claude-opus-4-6) */
  readonly model?: string;
  /** Agent provider name (default: claude-code) */
  readonly agent?: string;
  /** Docker image name to use for the sandbox (default: sandcastle:local) */
  readonly imageName?: string;
  /** Key-value map for {{KEY}} placeholder substitution in prompts */
  readonly promptArgs?: PromptArgs;
  /** Logging mode (default: { type: 'file' } with auto-generated path under .sandcastle/logs/) */
  readonly logging?: LoggingOption;
  /** Custom completion signal string (default: "<promise>COMPLETE</promise>") */
  readonly completionSignal?: string;
}

export interface RunResult {
  readonly iterationsRun: number;
  readonly wasCompletionSignalDetected: boolean;
  readonly stdout: string;
  readonly commits: { sha: string }[];
  readonly branch: string;
  /** Path to the log file, if logging was drained to a file. */
  readonly logFilePath?: string;
}

const SANDBOX_REPOS_DIR = "/home/agent/repos";

export const run = async (options: RunOptions): Promise<RunResult> => {
  const {
    prompt,
    promptFile,
    maxIterations = 5,
    hooks,
    branch,
    model,
    agent,
  } = options;

  const hostRepoDir = process.cwd();
  const repoName = hostRepoDir.split("/").pop()!;
  const sandboxRepoDir = `${SANDBOX_REPOS_DIR}/${repoName}`;

  // Resolve prompt
  const rawPrompt = await Effect.runPromise(
    resolvePrompt({ prompt, promptFile, cwd: hostRepoDir }),
  );

  // Read config
  const config = await Effect.runPromise(readConfig(hostRepoDir));

  // Merge hooks: explicit hooks override config hooks
  const resolvedConfig = hooks ? { ...config, hooks } : config;

  // Resolve model: explicit option > config > default
  const resolvedModel = model ?? config.model;

  // Resolve agent provider: explicit option > config > default
  const agentName = agent ?? config.agent ?? "claude-code";
  const provider = getAgentProvider(agentName);

  // Resolve image name: explicit option > config > default
  const resolvedImageName =
    options.imageName ?? config.imageName ?? "sandcastle:local";

  // Resolve env vars and run agent provider's env check
  const env = await resolveEnv(hostRepoDir);
  provider.envCheck(env);

  // Resolve log file name from branch (explicit or current git branch)
  let logBranchName = branch;
  if (!logBranchName) {
    try {
      const { stdout } = await execAsync("git rev-parse --abbrev-ref HEAD", {
        cwd: hostRepoDir,
      });
      logBranchName = stdout.trim();
    } catch {
      logBranchName = "sandcastle";
    }
  }

  // Resolve logging option
  const resolvedLogging: LoggingOption = options.logging ?? {
    type: "file",
    path: join(
      hostRepoDir,
      ".sandcastle",
      "logs",
      `${sanitizeBranchForFilename(logBranchName)}.log`,
    ),
  };
  const displayLayer =
    resolvedLogging.type === "file"
      ? (() => {
          mkdirSync(dirname(resolvedLogging.path), { recursive: true });
          console.log(`Agent started`);
          console.log(`  Run this to see logs:`);
          console.log(
            `  tail -f ${path.relative(process.cwd(), resolvedLogging.path)}`,
          );
          return FileDisplay.layer(resolvedLogging.path);
        })()
      : ClackDisplay.layer;

  const sandboxConfigLayer = Layer.succeed(SandboxConfig, {
    imageName: resolvedImageName,
    env,
  });
  const factoryLayer = Layer.provide(
    DockerSandboxFactory.layer,
    sandboxConfigLayer,
  );
  const runLayer = Layer.merge(factoryLayer, displayLayer);

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const d = yield* Display;
      yield* d.intro("sandcastle");
      const rows: Record<string, string> = {
        Image: resolvedImageName,
        Iterations: String(maxIterations),
      };
      if (branch) rows["Branch"] = branch;
      if (resolvedModel) rows["Model"] = resolvedModel;
      yield* d.summary("Sandcastle Run", rows);

      // Substitute prompt arguments ({{KEY}} placeholders) before orchestration
      const resolvedPrompt = options.promptArgs
        ? yield* substitutePromptArgs(rawPrompt, options.promptArgs)
        : rawPrompt;

      return yield* orchestrate({
        hostRepoDir,
        sandboxRepoDir,
        iterations: maxIterations,
        config: resolvedConfig,
        prompt: resolvedPrompt,
        branch,
        model: resolvedModel,
        completionSignal: options.completionSignal,
      });
    }).pipe(Effect.provide(runLayer)),
  );

  return {
    ...result,
    logFilePath:
      resolvedLogging.type === "file" ? resolvedLogging.path : undefined,
  };
};
