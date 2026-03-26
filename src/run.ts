import { NodeContext, NodeFileSystem } from "@effect/platform-node";
import path, { join } from "node:path";
import { styleText } from "node:util";
import { Effect, Layer } from "effect";
import { getAgentProvider } from "./AgentProvider.js";
import { readConfig } from "./Config.js";
import {
  ClackDisplay,
  Display,
  FileDisplay,
  type Severity,
} from "./Display.js";
import { orchestrate } from "./Orchestrator.js";
import { resolvePrompt } from "./PromptResolver.js";
import {
  WorktreeDockerSandboxFactory,
  WorktreeSandboxConfig,
  SANDBOX_WORKSPACE_DIR,
} from "./SandboxFactory.js";
import { resolveEnv } from "./EnvResolver.js";
import { generateTempBranchName, getCurrentBranch } from "./WorktreeManager.js";
import {
  type PromptArgs,
  substitutePromptArgs,
} from "./PromptArgumentSubstitution.js";

/** Default maximum number of iterations for a run. */
export const DEFAULT_MAX_ITERATIONS = 1;

/** Replace characters that are invalid or problematic in file paths with dashes. */
export const sanitizeBranchForFilename = (branch: string): string =>
  branch.replace(/[/\\:*?"<>|]/g, "-");

export interface FileDisplayStartupOptions {
  readonly logPath: string;
  readonly agentName?: string;
  readonly branch?: string;
}

/**
 * Print the startup message to the terminal when using file-based logging.
 * Uses styleText for lightweight bold/dim styling — does not use Clack.
 */
export const printFileDisplayStartup = (
  options: FileDisplayStartupOptions,
): void => {
  const name = options.agentName ?? "Agent";
  const label = styleText("bold", `[${name}]`);
  const branchPart = options.branch ? ` on branch ${options.branch}` : "";
  const relativeLogPath = path.relative(process.cwd(), options.logPath);
  console.log(`${label} Started${branchPart}`);
  console.log(styleText("dim", `  tail -f ${relativeLogPath}`));
};

/**
 * Derive the default Docker image name from the repo directory.
 * Returns `sandcastle:<dir-name>` where dir-name is the last path segment,
 * lowercased and sanitized for Docker image tag rules.
 */
export const defaultImageName = (repoDir: string): string => {
  const dirName = repoDir.replace(/\/+$/, "").split("/").pop() ?? "local";
  const sanitized = dirName.toLowerCase().replace(/[^a-z0-9_.-]/g, "-");
  return `sandcastle:${sanitized}`;
};

/**
 * Build the log filename for a run.
 * When a targetBranch is provided (temp branch mode), prefixes the filename
 * with the sanitized target branch name so developers can identify which
 * branch the run was targeting: `<targetBranch>-<resolvedBranch>.log`
 * When no targetBranch, uses just the resolved branch: `<resolvedBranch>.log`
 */
export const buildLogFilename = (
  resolvedBranch: string,
  targetBranch?: string,
): string => {
  const sanitized = sanitizeBranchForFilename(resolvedBranch);
  if (targetBranch) {
    return `${sanitizeBranchForFilename(targetBranch)}-${sanitized}.log`;
  }
  return `${sanitized}.log`;
};

/**
 * Build the completion status message for a run, used in both terminal mode
 * and log-to-file mode to record the final outcome.
 */
export const buildCompletionMessage = (
  wasCompletionSignalDetected: boolean,
  iterationsRun: number,
): { readonly message: string; readonly severity: Severity } => {
  if (wasCompletionSignalDetected) {
    return {
      message: `Run complete: agent finished after ${iterationsRun} iteration(s).`,
      severity: "success",
    };
  }
  return {
    message: `Run complete: reached ${iterationsRun} iteration(s) without completion signal.`,
    severity: "warn",
  };
};

export type LoggingOption =
  | { readonly type: "file"; readonly path: string }
  | { readonly type: "stdout" };

export interface RunOptions {
  /** Inline prompt string (mutually exclusive with promptFile) */
  readonly prompt?: string;
  /** Path to a prompt file (mutually exclusive with prompt) */
  readonly promptFile?: string;
  /** Maximum iterations to run (default: 1) */
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
  /** Docker image name to use for the sandbox (default: sandcastle:<repo-dir-name>) */
  readonly imageName?: string;
  /** Key-value map for {{KEY}} placeholder substitution in prompts */
  readonly promptArgs?: PromptArgs;
  /** Logging mode (default: { type: 'file' } with auto-generated path under .sandcastle/logs/) */
  readonly logging?: LoggingOption;
  /** Custom completion signal string (default: "<promise>COMPLETE</promise>") */
  readonly completionSignal?: string;
  /** Timeout in seconds. If the run exceeds this, it fails. Default: 1200 (20 minutes) */
  readonly timeoutSeconds?: number;
  /** Optional name for the run, shown as a prefix in log output */
  readonly name?: string;
  /** Paths relative to the host repo root to copy into the worktree before container start. */
  readonly copyToSandbox?: string[];
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

export const run = async (options: RunOptions): Promise<RunResult> => {
  const {
    prompt,
    promptFile,
    maxIterations = DEFAULT_MAX_ITERATIONS,
    hooks,
    branch,
    model,
    agent,
  } = options;

  const hostRepoDir = process.cwd();

  // Resolve prompt
  const rawPrompt = await Effect.runPromise(
    resolvePrompt({ prompt, promptFile, cwd: hostRepoDir }).pipe(
      Effect.provide(NodeContext.layer),
    ),
  );

  // Read config
  const config = await Effect.runPromise(
    readConfig(hostRepoDir).pipe(Effect.provide(NodeContext.layer)),
  );

  // Merge hooks: explicit hooks override config hooks
  const resolvedConfig = hooks ? { ...config, hooks } : config;

  // Resolve model: explicit option > config > default
  const resolvedModel = model ?? config.model;

  // Resolve agent provider: explicit option > config > default
  const agentName = agent ?? config.agent ?? "claude-code";
  const provider = getAgentProvider(agentName);

  // Resolve image name: explicit option > config > default
  const resolvedImageName =
    options.imageName ?? config.imageName ?? defaultImageName(hostRepoDir);

  // Resolve env vars
  const env = await Effect.runPromise(
    resolveEnv(hostRepoDir).pipe(Effect.provide(NodeContext.layer)),
  );

  // When no branch is provided, generate a temporary branch name.
  // This names the log file after the temp branch and also directs
  // the sandbox to work on that branch (instead of the current host branch).
  const resolvedBranch = branch ?? generateTempBranchName(agentName);

  // When using a temp branch, prefix the log filename with the target branch
  // (the host's current branch) so developers can tell which branch was targeted.
  const targetBranch =
    branch === undefined
      ? await Effect.runPromise(getCurrentBranch(hostRepoDir))
      : undefined;

  // Resolve logging option
  const resolvedLogging: LoggingOption = options.logging ?? {
    type: "file",
    path: join(
      hostRepoDir,
      ".sandcastle",
      "logs",
      buildLogFilename(resolvedBranch, targetBranch),
    ),
  };
  const displayLayer =
    resolvedLogging.type === "file"
      ? (() => {
          printFileDisplayStartup({
            logPath: resolvedLogging.path,
            agentName: options.name,
            branch: resolvedBranch,
          });
          return Layer.provide(
            FileDisplay.layer(resolvedLogging.path),
            NodeFileSystem.layer,
          );
        })()
      : ClackDisplay.layer;

  const factoryLayer = Layer.provide(
    WorktreeDockerSandboxFactory.layer,
    Layer.merge(
      Layer.succeed(WorktreeSandboxConfig, {
        imageName: resolvedImageName,
        env,
        hostRepoDir,
        // Pass explicit branch only — when undefined, WorktreeManager creates a temp branch
        // and SandboxLifecycle cherry-picks commits onto the host's current branch
        branch,
        copyToSandbox: options.copyToSandbox,
        agentName,
      }),
      NodeFileSystem.layer,
    ),
  );

  const runLayer = Layer.merge(factoryLayer, displayLayer);

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const d = yield* Display;
      yield* d.intro(options.name ?? "sandcastle");
      const rows: Record<string, string> = {
        Agent: agentName,
        Image: resolvedImageName,
        "Max iterations": String(maxIterations),
      };
      rows["Branch"] = resolvedBranch;
      if (resolvedModel) rows["Model"] = resolvedModel;
      yield* d.summary("Sandcastle Run", rows);

      // Substitute prompt arguments ({{KEY}} placeholders) before orchestration
      const resolvedPrompt = options.promptArgs
        ? yield* substitutePromptArgs(rawPrompt, options.promptArgs)
        : rawPrompt;

      const orchestrateResult = yield* orchestrate({
        hostRepoDir,
        sandboxRepoDir: SANDBOX_WORKSPACE_DIR,
        iterations: maxIterations,
        config: resolvedConfig,
        prompt: resolvedPrompt,
        branch,
        model: resolvedModel,
        completionSignal: options.completionSignal,
        timeoutSeconds: options.timeoutSeconds,
        name: options.name,
      });

      const completion = buildCompletionMessage(
        orchestrateResult.wasCompletionSignalDetected,
        orchestrateResult.iterationsRun,
      );
      yield* d.status(completion.message, completion.severity);

      return orchestrateResult;
    }).pipe(Effect.provide(runLayer)),
  );

  return {
    ...result,
    logFilePath:
      resolvedLogging.type === "file" ? resolvedLogging.path : undefined,
  };
};
