import { NodeContext } from "@effect/platform-node";
import path, { join } from "node:path";
import { Effect, Layer } from "effect";
import { getAgentProvider } from "./AgentProvider.js";
import { readConfig } from "./Config.js";
import { NodeFileSystem } from "@effect/platform-node";
import { ClackDisplay, Display, FileDisplay } from "./Display.js";
import { orchestrate } from "./Orchestrator.js";
import { resolvePrompt } from "./PromptResolver.js";
import {
  DockerSandboxFactory,
  SandboxConfig,
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

/** Replace characters that are invalid or problematic in file paths with dashes. */
export const sanitizeBranchForFilename = (branch: string): string =>
  branch.replace(/[/\\:*?"<>|]/g, "-");

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

/**
 * When true, use worktree-based sandbox mode: the host git worktree is
 * bind-mounted into the container, giving real-time file visibility in the IDE.
 * When false, use isolated (bundle/patch) mode. Toggle in code during development.
 */
export const USE_WORKTREE_MODE = true;

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

  // Resolve env vars and run agent provider's env check
  const env = await Effect.runPromise(
    resolveEnv(hostRepoDir).pipe(Effect.provide(NodeContext.layer)),
  );
  provider.envCheck(env);

  // When no branch is provided, generate a temporary branch name.
  // This names the log file after the temp branch and also directs
  // the sandbox to work on that branch (instead of the current host branch).
  const resolvedBranch = branch ?? generateTempBranchName();

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
          console.log(`Agent started`);
          console.log(`  Run this to see logs:`);
          console.log(
            `  tail -f ${path.relative(process.cwd(), resolvedLogging.path)}`,
          );
          return Layer.provide(
            FileDisplay.layer(resolvedLogging.path),
            NodeFileSystem.layer,
          );
        })()
      : ClackDisplay.layer;

  const factoryLayer = USE_WORKTREE_MODE
    ? Layer.provide(
        WorktreeDockerSandboxFactory.layer,
        Layer.succeed(WorktreeSandboxConfig, {
          imageName: resolvedImageName,
          env,
          hostRepoDir,
          // Pass explicit branch only — when undefined, WorktreeManager creates a temp branch
          // and SandboxLifecycle cherry-picks commits onto the host's current branch
          branch,
        }),
      )
    : Layer.provide(
        DockerSandboxFactory.layer,
        Layer.succeed(SandboxConfig, { imageName: resolvedImageName, env }),
      );

  // In worktree mode the container mounts the worktree at SANDBOX_WORKSPACE_DIR.
  // In isolated mode the repo is synced into SANDBOX_REPOS_DIR/<repoName>.
  const resolvedSandboxRepoDir = USE_WORKTREE_MODE
    ? SANDBOX_WORKSPACE_DIR
    : sandboxRepoDir;

  const runLayer = Layer.merge(factoryLayer, displayLayer);

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const d = yield* Display;
      yield* d.intro(options.name ?? "sandcastle");
      const rows: Record<string, string> = {
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

      return yield* orchestrate({
        hostRepoDir,
        sandboxRepoDir: resolvedSandboxRepoDir,
        iterations: maxIterations,
        config: resolvedConfig,
        prompt: resolvedPrompt,
        // In worktree mode: pass original branch (possibly undefined) so SandboxLifecycle
        // triggers cherry-pick for temp branches. In isolated mode: always pass resolvedBranch.
        branch: USE_WORKTREE_MODE ? branch : resolvedBranch,
        model: resolvedModel,
        completionSignal: options.completionSignal,
        timeoutSeconds: options.timeoutSeconds,
        name: options.name,
      });
    }).pipe(Effect.provide(runLayer)),
  );

  return {
    ...result,
    logFilePath:
      resolvedLogging.type === "file" ? resolvedLogging.path : undefined,
  };
};
