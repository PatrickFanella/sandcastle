import { NodeContext, NodeFileSystem } from "@effect/platform-node";
import path, { join } from "node:path";
import { styleText } from "node:util";
import { Effect, Layer } from "effect";
import type { AgentProvider } from "./AgentProvider.js";
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
  SandboxConfig,
} from "./SandboxFactory.js";
import type { SandboxProvider, BranchStrategy } from "./SandboxProvider.js";
import { resolveEnv } from "./EnvResolver.js";
import { formatErrorMessage } from "./ErrorHandler.js";
import type { SandboxError } from "./errors.js";
import { mergeProviderEnv } from "./mergeProviderEnv.js";
import {
  generateTempBranchName,
  getCurrentBranch,
} from "./WorkspaceManager.js";
import {
  type PromptArgs,
  substitutePromptArgs,
  validateNoBuiltInArgOverride,
  BUILT_IN_PROMPT_ARG_KEYS,
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
 * Build the log filename for a run.
 * When a targetBranch is provided (temp branch mode), prefixes the filename
 * with the sanitized target branch name so developers can identify which
 * branch the run was targeting: `<targetBranch>-<resolvedBranch>.log`
 * When no targetBranch, uses just the resolved branch: `<resolvedBranch>.log`
 * When a name is provided, appends it to avoid collisions in multi-agent workflows.
 */
export const buildLogFilename = (
  resolvedBranch: string,
  targetBranch?: string,
  name?: string,
): string => {
  const sanitized = sanitizeBranchForFilename(resolvedBranch);
  const nameSuffix = name
    ? `-${name.toLowerCase().replace(/[^a-z0-9_.-]/g, "-")}`
    : "";
  if (targetBranch) {
    return `${sanitizeBranchForFilename(targetBranch)}-${sanitized}${nameSuffix}.log`;
  }
  return `${sanitized}${nameSuffix}.log`;
};

export interface RunSummaryRowsOptions {
  readonly name?: string;
  readonly agentName: string;
  readonly sandboxName: string;
  readonly maxIterations: number;
  readonly branch: string;
}

/**
 * Build the summary rows for a run, used in both terminal mode and
 * log-to-file mode. When a custom name is provided it appears as the
 * Agent value instead of the internal provider name.
 */
export const buildRunSummaryRows = (
  options: RunSummaryRowsOptions,
): Record<string, string> => ({
  Agent: options.name ?? options.agentName,
  Sandbox: options.sandboxName,
  "Max iterations": String(options.maxIterations),
  Branch: options.branch,
});

/**
 * Build the completion status message for a run, used in both terminal mode
 * and log-to-file mode to record the final outcome.
 */
export const buildCompletionMessage = (
  completionSignal: string | undefined,
  iterationsRun: number,
): { readonly message: string; readonly severity: Severity } => {
  if (completionSignal !== undefined) {
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

/**
 * Controls where Sandcastle writes iteration progress and agent output.
 * Use `"file"` (log-to-file mode) to write to a log file on disk, or
 * `"stdout"` (terminal mode) to render an interactive UI in the terminal.
 */
export type LoggingOption =
  /** Write progress and agent output to a log file at the given path (log-to-file mode). */
  | { readonly type: "file"; readonly path: string }
  /** Render progress and agent output as an interactive UI in the terminal (terminal mode). */
  | { readonly type: "stdout" };

export interface RunOptions {
  /** Agent provider to use (e.g. claudeCode("claude-opus-4-6")) */
  readonly agent: AgentProvider;
  /** Sandbox provider (e.g. docker({ imageName: "sandcastle:myrepo" })). */
  readonly sandbox: SandboxProvider;
  /** Inline prompt string (mutually exclusive with promptFile) */
  readonly prompt?: string;
  /** Path to a prompt file (mutually exclusive with prompt) */
  readonly promptFile?: string;
  /** Maximum iterations to run (default: 1) */
  readonly maxIterations?: number;
  /** Hooks to run during sandbox lifecycle */
  readonly hooks?: {
    readonly onSandboxReady?: ReadonlyArray<{
      command: string;
      sudo?: boolean;
    }>;
  };
  /** Key-value map for {{KEY}} placeholder substitution in prompts */
  readonly promptArgs?: PromptArgs;
  /** Logging mode (default: { type: 'file' } with auto-generated path under .sandcastle/logs/) */
  readonly logging?: LoggingOption;
  /** Substring(s) the agent emits to stop the iteration loop early. Matched via `includes` against agent output. (default: `"<promise>COMPLETE</promise>"`) */
  readonly completionSignal?: string | string[];
  /** Idle timeout in seconds. If the agent produces no output for this long, it fails. Default: 600 (10 minutes) */
  readonly idleTimeoutSeconds?: number;
  /** Optional name for the run, shown as a prefix in log output */
  readonly name?: string;
  /** Paths relative to the host repo root to copy into the worktree before sandbox start. */
  readonly copyToWorkspace?: string[];
  /** Branch strategy — controls how the agent's changes relate to branches.
   * Defaults to { type: "head" } for bind-mount providers and { type: "merge-to-head" } for isolated providers. */
  readonly branchStrategy?: BranchStrategy;
  /** When false, reuse an existing worktree for the target branch instead of failing on collision. Default: true. */
  readonly throwOnDuplicateWorktree?: boolean;
}

export interface RunResult {
  /** Number of iterations the agent completed during this run. */
  readonly iterationsRun: number;
  /** The matched completion signal string, or undefined if no signal fired before the iteration limit. */
  readonly completionSignal?: string;
  /** Combined stdout output from all agent iterations. */
  readonly stdout: string;
  /** List of commits made by the agent during the run, each identified by its SHA. */
  readonly commits: { sha: string }[];
  /** The branch name the agent worked on inside the sandbox. */
  readonly branch: string;
  /** Path to the log file, if logging was drained to a file. */
  readonly logFilePath?: string;
  /** Host path to the preserved workspace, set when the run succeeded but the workspace had uncommitted changes. */
  readonly preservedWorkspacePath?: string;
}

export const run = async (options: RunOptions): Promise<RunResult> => {
  const {
    prompt,
    promptFile,
    maxIterations = DEFAULT_MAX_ITERATIONS,
    hooks,
    agent: provider,
  } = options;

  // Derive branch strategy: explicit option > default based on provider tag
  const branchStrategy: BranchStrategy =
    options.branchStrategy ??
    (options.sandbox.tag === "isolated"
      ? { type: "merge-to-head" }
      : { type: "head" });
  const effectiveBranchType = branchStrategy.type;

  // Validate: head strategy is not supported with isolated providers
  if (effectiveBranchType === "head" && options.sandbox.tag === "isolated") {
    throw new Error(
      "head branch strategy is not supported with isolated providers",
    );
  }

  // Validate: copyToWorkspace is incompatible with head strategy
  if (
    effectiveBranchType === "head" &&
    options.copyToWorkspace &&
    options.copyToWorkspace.length > 0
  ) {
    throw new Error(
      "copyToWorkspace is not supported with head branch strategy. " +
        "In head mode the host working directory is bind-mounted directly.",
    );
  }

  // Extract explicit branch when in branch mode
  const branch: string | undefined =
    branchStrategy.type === "branch" ? branchStrategy.branch : undefined;

  const hostRepoDir = process.cwd();

  // Resolve prompt
  const rawPrompt = await Effect.runPromise(
    resolvePrompt({ prompt, promptFile }).pipe(
      Effect.provide(NodeContext.layer),
    ),
  );

  const agentName = provider.name;

  // Resolve env vars and merge with provider env
  const resolvedEnv = await Effect.runPromise(
    resolveEnv(hostRepoDir).pipe(Effect.provide(NodeContext.layer)),
  );
  const env = mergeProviderEnv({
    resolvedEnv,
    agentProviderEnv: provider.env,
    sandboxProviderEnv: options.sandbox.env,
  });

  // Always capture the host's current branch for the TARGET_BRANCH built-in
  // prompt argument. When using a temp branch, it also prefixes the log filename.
  const currentHostBranch = await Effect.runPromise(
    getCurrentBranch(hostRepoDir),
  );

  // When in merge-to-head mode, generate a temporary branch name.
  // In head mode, use the host's current branch directly (no worktree).
  const resolvedBranch =
    effectiveBranchType === "head"
      ? currentHostBranch
      : (branch ?? generateTempBranchName(options.name));

  // When using a temp branch, prefix the log filename with the target branch
  // (the host's current branch) so developers can tell which branch was targeted.
  const targetBranch =
    effectiveBranchType === "merge-to-head" ? currentHostBranch : undefined;

  // Resolve logging option
  const resolvedLogging: LoggingOption = options.logging ?? {
    type: "file",
    path: join(
      hostRepoDir,
      ".sandcastle",
      "logs",
      buildLogFilename(resolvedBranch, targetBranch, options.name),
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
    Layer.mergeAll(
      Layer.succeed(SandboxConfig, {
        env,
        hostRepoDir,
        copyToWorkspace: options.copyToWorkspace,
        name: options.name,
        sandboxProvider: options.sandbox,
        branchStrategy,
        throwOnDuplicateWorktree: options.throwOnDuplicateWorktree,
      }),
      NodeFileSystem.layer,
      displayLayer,
    ),
  );

  const runLayer = Layer.merge(factoryLayer, displayLayer);

  const baseEffect = Effect.gen(function* () {
    const d = yield* Display;
    yield* d.intro(options.name ?? "sandcastle");
    const rows = buildRunSummaryRows({
      name: options.name,
      agentName,
      sandboxName: options.sandbox.name,
      maxIterations,
      branch: resolvedBranch,
    });
    yield* d.summary("Sandcastle Run", rows);

    // Validate that the user has not provided built-in prompt argument keys
    const userArgs = options.promptArgs ?? {};
    yield* validateNoBuiltInArgOverride(userArgs);

    // Build effective args: built-in args merged with user-provided args.
    // In none mode, resolvedBranch is already currentHostBranch, so
    // SOURCE_BRANCH and TARGET_BRANCH both resolve to the host's current branch.
    const effectiveArgs = {
      SOURCE_BRANCH: resolvedBranch,
      TARGET_BRANCH: currentHostBranch,
      ...userArgs,
    };
    const builtInArgKeysSet = new Set<string>(BUILT_IN_PROMPT_ARG_KEYS);
    const resolvedPrompt = yield* substitutePromptArgs(
      rawPrompt,
      effectiveArgs,
      builtInArgKeysSet,
    );

    // In head mode, pass the host branch so SandboxLifecycle skips the merge step.
    // In merge-to-head mode, branch is undefined (triggers merge). In branch mode, it's the explicit branch.
    const orchestrateBranch =
      effectiveBranchType === "head" ? currentHostBranch : branch;

    const orchestrateResult = yield* orchestrate({
      hostRepoDir,
      iterations: maxIterations,
      hooks,
      prompt: resolvedPrompt,
      branch: orchestrateBranch,
      provider,
      completionSignal: options.completionSignal,
      idleTimeoutSeconds: options.idleTimeoutSeconds,
      name: options.name,
    });

    const completion = buildCompletionMessage(
      orchestrateResult.completionSignal,
      orchestrateResult.iterationsRun,
    );
    yield* d.status(completion.message, completion.severity);

    return orchestrateResult;
  });

  // In file-logging mode, write errors to the log before they propagate.
  // In stdout mode (ClackDisplay), errors are already shown by withFriendlyErrors
  // in main.ts, so we skip to avoid duplicate terminal output.
  const withErrorLog =
    resolvedLogging.type === "file"
      ? baseEffect.pipe(
          Effect.tapError((error) =>
            Effect.gen(function* () {
              const d = yield* Display;
              yield* d.status(
                formatErrorMessage(error as SandboxError),
                "error",
              );
            }),
          ),
        )
      : baseEffect;

  const result = await Effect.runPromise(
    withErrorLog.pipe(Effect.provide(runLayer)),
  );

  return {
    ...result,
    logFilePath:
      resolvedLogging.type === "file" ? resolvedLogging.path : undefined,
  };
};
