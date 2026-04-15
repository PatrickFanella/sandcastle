import { NodeContext, NodeFileSystem } from "@effect/platform-node";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import type { AgentProvider } from "./AgentProvider.js";
import { ClackDisplay, Display, FileDisplay } from "./Display.js";
import { preprocessPrompt } from "./PromptPreprocessor.js";
import { resolvePrompt } from "./PromptResolver.js";
import {
  SandboxFactory,
  makeSandboxLayerFromHandle,
  resolveGitMounts,
  SANDBOX_WORKSPACE_DIR,
} from "./SandboxFactory.js";
import { withSandboxLifecycle, type SandboxHooks } from "./SandboxLifecycle.js";
import type {
  AnySandboxProvider,
  SandboxProvider,
  MergeToHeadBranchStrategy,
  NamedBranchStrategy,
  BindMountSandboxHandle,
  IsolatedSandboxHandle,
  NoSandboxHandle,
} from "./SandboxProvider.js";
import type { CloseResult } from "./createSandbox.js";
import type { InteractiveResult } from "./interactive.js";
import { buildLogFilename, printFileDisplayStartup } from "./run.js";
import type { LoggingOption } from "./run.js";
import { orchestrate } from "./Orchestrator.js";
import { resolveEnv } from "./EnvResolver.js";
import { mergeProviderEnv } from "./mergeProviderEnv.js";
import { startSandbox } from "./startSandbox.js";
import { syncOut } from "./syncOut.js";
import * as WorkspaceManager from "./WorkspaceManager.js";
import { copyToWorkspace } from "./CopyToWorkspace.js";
import {
  type PromptArgs,
  substitutePromptArgs,
  validateNoBuiltInArgOverride,
  BUILT_IN_PROMPT_ARG_KEYS,
} from "./PromptArgumentSubstitution.js";
import { noSandbox } from "./sandboxes/no-sandbox.js";

/** Branch strategies valid for createWorkspace — head is excluded. */
export type WorkspaceBranchStrategy =
  | MergeToHeadBranchStrategy
  | NamedBranchStrategy;

export interface CreateWorkspaceOptions {
  /** Branch strategy — only 'branch' and 'merge-to-head' are allowed. */
  readonly branchStrategy: WorkspaceBranchStrategy;
  /** Paths relative to the host repo root to copy into the workspace at creation time. */
  readonly copyToWorkspace?: string[];
  /** @internal Test-only overrides. */
  readonly _test?: {
    readonly hostRepoDir?: string;
  };
}

export interface WorkspaceInteractiveOptions {
  /** Agent provider to use (e.g. claudeCode("claude-opus-4-6")) */
  readonly agent: AgentProvider;
  /** Sandbox provider (e.g. docker(), noSandbox()). Defaults to noSandbox(). */
  readonly sandbox?: AnySandboxProvider;
  /** Inline prompt string (mutually exclusive with promptFile). */
  readonly prompt?: string;
  /** Path to a prompt file (mutually exclusive with prompt). */
  readonly promptFile?: string;
  /** Optional name for the interactive session. */
  readonly name?: string;
  /** Hooks to run during sandbox lifecycle */
  readonly hooks?: SandboxHooks;
  /** Key-value map for {{KEY}} placeholder substitution in prompts */
  readonly promptArgs?: PromptArgs;
  /** Environment variables to inject into the sandbox. */
  readonly env?: Record<string, string>;
}

export interface WorkspaceRunOptions {
  /** Agent provider to use (e.g. claudeCode("claude-opus-4-6")) */
  readonly agent: AgentProvider;
  /** Sandbox provider (e.g. docker()). Required — AFK agents should always be sandboxed. */
  readonly sandbox: SandboxProvider;
  /** Inline prompt string (mutually exclusive with promptFile). */
  readonly prompt?: string;
  /** Path to a prompt file (mutually exclusive with prompt). */
  readonly promptFile?: string;
  /** Key-value map for {{KEY}} placeholder substitution in prompts */
  readonly promptArgs?: PromptArgs;
  /** Maximum iterations to run (default: 1). */
  readonly maxIterations?: number;
  /** Substring(s) the agent emits to stop the iteration loop early. */
  readonly completionSignal?: string | string[];
  /** Idle timeout in seconds. Default: 600. */
  readonly idleTimeoutSeconds?: number;
  /** Optional name for the run. */
  readonly name?: string;
  /** Logging mode. */
  readonly logging?: LoggingOption;
  /** Hooks to run during sandbox lifecycle */
  readonly hooks?: SandboxHooks;
  /** Environment variables to inject into the sandbox. */
  readonly env?: Record<string, string>;
}

export interface WorkspaceRunResult {
  /** Number of iterations the agent completed during this run. */
  readonly iterationsRun: number;
  /** The matched completion signal string, or undefined if none fired. */
  readonly completionSignal?: string;
  /** Combined stdout output from all agent iterations. */
  readonly stdout: string;
  /** List of commits made by the agent during the run. */
  readonly commits: { sha: string }[];
  /** The branch name the agent worked on. */
  readonly branch: string;
  /** Path to the log file, if logging was drained to a file. */
  readonly logFilePath?: string;
}

export interface Workspace {
  /** The branch the workspace is on. */
  readonly branch: string;
  /** Host path to the workspace (worktree). */
  readonly workspacePath: string;
  /** Run an AFK agent in this workspace with a required sandbox. */
  run(options: WorkspaceRunOptions): Promise<WorkspaceRunResult>;
  /** Run an interactive agent session in this workspace. */
  interactive(options: WorkspaceInteractiveOptions): Promise<InteractiveResult>;
  /** Clean up the workspace. Preserves worktree if dirty. */
  close(): Promise<CloseResult>;
  /** Auto cleanup via `await using`. */
  [Symbol.asyncDispose](): Promise<void>;
}

/**
 * Creates a git worktree as an independent, first-class workspace.
 * Returns a Workspace handle with close() and [Symbol.asyncDispose]().
 *
 * Only accepts 'branch' and 'merge-to-head' strategies — 'head' is a
 * compile-time type error since head means no worktree.
 */
export const createWorkspace = async (
  options: CreateWorkspaceOptions,
): Promise<Workspace> => {
  const hostRepoDir = options._test?.hostRepoDir ?? process.cwd();

  const branch =
    options.branchStrategy.type === "branch"
      ? options.branchStrategy.branch
      : undefined;

  const worktreeInfo = await Effect.gen(function* () {
    yield* WorkspaceManager.pruneStale(hostRepoDir).pipe(
      Effect.catchAll(() => Effect.void),
    );
    const info = yield* WorkspaceManager.create(hostRepoDir, { branch });
    if (options.copyToWorkspace && options.copyToWorkspace.length > 0) {
      yield* copyToWorkspace(options.copyToWorkspace, hostRepoDir, info.path);
    }
    return info;
  }).pipe(Effect.provide(NodeContext.layer), Effect.runPromise);

  let closed = false;

  const close = async (): Promise<CloseResult> => {
    if (closed) return { preservedWorkspacePath: undefined };
    closed = true;

    return Effect.gen(function* () {
      const isDirty = yield* WorkspaceManager.hasUncommittedChanges(
        worktreeInfo.path,
      ).pipe(Effect.catchAll(() => Effect.succeed(false)));

      if (isDirty) {
        return { preservedWorkspacePath: worktreeInfo.path } as CloseResult;
      }

      yield* WorkspaceManager.remove(worktreeInfo.path).pipe(
        Effect.catchAll(() => Effect.void),
      );

      return { preservedWorkspacePath: undefined } as CloseResult;
    }).pipe(Effect.runPromise);
  };

  const workspaceInteractive = async (
    opts: WorkspaceInteractiveOptions,
  ): Promise<InteractiveResult> => {
    const { prompt, promptFile, hooks, agent: provider } = opts;
    const resolvedSandbox = opts.sandbox ?? noSandbox();

    // Validate buildInteractiveArgs is available
    if (!provider.buildInteractiveArgs) {
      throw new Error(
        `Agent provider "${provider.name}" does not support buildInteractiveArgs, required for interactive sessions.`,
      );
    }

    const inner = Effect.gen(function* () {
      const d = yield* Display;

      // 1. Resolve prompt (from string or file), or skip if neither provided
      const hasPromptSource = prompt !== undefined || promptFile !== undefined;
      const rawPrompt = hasPromptSource
        ? yield* resolvePrompt({ prompt, promptFile })
        : "";

      // 2. Resolve env vars
      const resolvedEnv = yield* resolveEnv(hostRepoDir);
      const env = mergeProviderEnv({
        resolvedEnv,
        agentProviderEnv: provider.env,
        sandboxProviderEnv: resolvedSandbox.env,
      });
      const effectiveEnv = { ...env, ...(opts.env ?? {}) };

      // 3. Prompt args substitution (skip when no prompt)
      let substitutedPrompt = rawPrompt;
      if (hasPromptSource) {
        const userArgs = opts.promptArgs ?? {};
        yield* validateNoBuiltInArgOverride(userArgs);

        const effectiveArgs = {
          SOURCE_BRANCH: worktreeInfo.branch,
          TARGET_BRANCH: worktreeInfo.branch,
          ...userArgs,
        };
        const builtInArgKeysSet = new Set<string>(BUILT_IN_PROMPT_ARG_KEYS);
        substitutedPrompt = yield* substitutePromptArgs(
          rawPrompt,
          effectiveArgs,
          builtInArgKeysSet,
        );
      }

      // Display intro
      yield* d.intro(opts.name ?? "sandcastle interactive");
      yield* d.summary("Interactive Session", {
        Agent: opts.name ?? provider.name,
        Sandbox: resolvedSandbox.name,
        Branch: worktreeInfo.branch,
      });

      // 4. Start sandbox
      let handle:
        | BindMountSandboxHandle
        | IsolatedSandboxHandle
        | NoSandboxHandle;

      if (resolvedSandbox.tag === "none") {
        handle = yield* Effect.promise(() =>
          resolvedSandbox.create({
            workspacePath: worktreeInfo.path,
            env: effectiveEnv,
          }),
        );
      } else if (resolvedSandbox.tag === "isolated") {
        const startResult = yield* d.taskLog("Starting sandbox", () =>
          startSandbox({
            provider: resolvedSandbox,
            hostRepoDir: worktreeInfo.path,
            env: effectiveEnv,
          }),
        );
        handle = startResult.handle;
      } else {
        const gitPath = join(hostRepoDir, ".git");
        const gitMounts = yield* resolveGitMounts(gitPath);
        const startResult = yield* d.taskLog("Starting sandbox", () =>
          startSandbox({
            provider: resolvedSandbox,
            hostRepoDir,
            env: effectiveEnv,
            worktreeOrRepoPath: worktreeInfo.path,
            gitMounts,
            workspaceDir: SANDBOX_WORKSPACE_DIR,
          }),
        );
        handle = startResult.handle;
      }

      // Run lifecycle — workspace owns worktree, so no worktree cleanup here
      return yield* Effect.gen(function* () {
        if (!handle.interactiveExec) {
          throw new Error(
            `Sandbox provider does not support interactiveExec. ` +
              `The provider must implement the optional interactiveExec method to use interactive().`,
          );
        }
        const interactiveExecFn = handle.interactiveExec.bind(handle);
        const sandboxLayer = makeSandboxLayerFromHandle(handle);
        const workspacePath = handle.workspacePath;

        const applyToHost =
          resolvedSandbox.tag === "isolated"
            ? () => syncOut(worktreeInfo.path, handle as IsolatedSandboxHandle)
            : () => Effect.void;

        const lifecycleEffect = withSandboxLifecycle(
          {
            hostRepoDir,
            sandboxRepoDir: workspacePath,
            hooks,
            branch: worktreeInfo.branch,
            hostWorkspacePath: worktreeInfo.path,
            applyToHost,
          },
          (ctx) =>
            Effect.gen(function* () {
              const fullPrompt = hasPromptSource
                ? yield* preprocessPrompt(
                    substitutedPrompt,
                    ctx.sandbox,
                    ctx.sandboxRepoDir,
                  )
                : "";

              const interactiveArgs = provider.buildInteractiveArgs!({
                prompt: fullPrompt,
                dangerouslySkipPermissions: resolvedSandbox.tag !== "none",
              });
              const result = yield* Effect.promise(() =>
                interactiveExecFn(interactiveArgs, {
                  stdin: process.stdin,
                  stdout: process.stdout,
                  stderr: process.stderr,
                  cwd: workspacePath,
                }),
              );

              return result.exitCode;
            }),
        );

        const lifecycleResult = yield* lifecycleEffect.pipe(
          Effect.provide(sandboxLayer),
        );

        const exitCode = lifecycleResult.result;

        // Summary
        yield* d.summary("Session Complete", {
          Commits: String(lifecycleResult.commits.length),
          Branch: lifecycleResult.branch,
          "Exit code": String(exitCode),
        });

        return {
          commits: lifecycleResult.commits,
          branch: lifecycleResult.branch,
          preservedWorkspacePath: undefined,
          exitCode,
        } satisfies InteractiveResult;
      }).pipe(
        // Always close sandbox handle
        Effect.ensuring(Effect.promise(() => handle.close().catch(() => {}))),
      );
    });

    return Effect.runPromise(
      inner.pipe(
        Effect.provide(ClackDisplay.layer),
        Effect.provide(NodeContext.layer),
        Effect.provide(NodeFileSystem.layer),
      ),
    );
  };

  const workspaceRun = async (
    opts: WorkspaceRunOptions,
  ): Promise<WorkspaceRunResult> => {
    const { prompt, promptFile, hooks, agent: provider } = opts;
    const sandboxProvider = opts.sandbox;
    const maxIterations = opts.maxIterations ?? 1;

    const inner = Effect.gen(function* () {
      // 1. Resolve prompt
      const rawPrompt = yield* resolvePrompt({ prompt, promptFile });

      // 2. Resolve env vars
      const resolvedEnv = yield* resolveEnv(hostRepoDir);
      const env = mergeProviderEnv({
        resolvedEnv,
        agentProviderEnv: provider.env,
        sandboxProviderEnv: sandboxProvider.env,
      });
      const effectiveEnv = { ...env, ...(opts.env ?? {}) };

      // 3. Prompt args substitution
      const userArgs = opts.promptArgs ?? {};
      yield* validateNoBuiltInArgOverride(userArgs);
      const effectiveArgs = {
        SOURCE_BRANCH: worktreeInfo.branch,
        TARGET_BRANCH: worktreeInfo.branch,
        ...userArgs,
      };
      const builtInArgKeysSet = new Set<string>(BUILT_IN_PROMPT_ARG_KEYS);
      const resolvedPrompt = yield* substitutePromptArgs(
        rawPrompt,
        effectiveArgs,
        builtInArgKeysSet,
      );

      // 4. Start sandbox
      let handle: BindMountSandboxHandle | IsolatedSandboxHandle;
      let sandboxRepoDir: string;

      if (sandboxProvider.tag === "isolated") {
        const startResult = yield* startSandbox({
          provider: sandboxProvider,
          hostRepoDir: worktreeInfo.path,
          env: effectiveEnv,
        });
        handle = startResult.handle;
        sandboxRepoDir = startResult.workspacePath;
      } else {
        const gitPath = join(hostRepoDir, ".git");
        const gitMounts = yield* resolveGitMounts(gitPath);
        const startResult = yield* startSandbox({
          provider: sandboxProvider,
          hostRepoDir,
          env: effectiveEnv,
          worktreeOrRepoPath: worktreeInfo.path,
          gitMounts,
          workspaceDir: SANDBOX_WORKSPACE_DIR,
        });
        handle = startResult.handle;
        sandboxRepoDir = startResult.workspacePath;
      }

      const sandboxLayer = makeSandboxLayerFromHandle(handle);
      const applyToHost =
        sandboxProvider.tag === "isolated"
          ? () => syncOut(worktreeInfo.path, handle as IsolatedSandboxHandle)
          : () => Effect.void;

      // 5. Resolve logging
      const resolvedLogging: LoggingOption = opts.logging ?? {
        type: "file",
        path: join(
          hostRepoDir,
          ".sandcastle",
          "logs",
          buildLogFilename(worktreeInfo.branch, undefined, opts.name),
        ),
      };

      const runDisplayLayer =
        resolvedLogging.type === "file"
          ? (() => {
              printFileDisplayStartup({
                logPath: resolvedLogging.path,
                agentName: opts.name,
                branch: worktreeInfo.branch,
              });
              return Layer.provide(
                FileDisplay.layer(resolvedLogging.path),
                NodeFileSystem.layer,
              );
            })()
          : ClackDisplay.layer;

      // 6. Build a SandboxFactory that reuses the started sandbox
      const reuseFactoryLayer = Layer.succeed(SandboxFactory, {
        withSandbox: (makeEffect) =>
          makeEffect({
            hostWorkspacePath: worktreeInfo.path,
            sandboxWorkspacePath: sandboxRepoDir,
            applyToHost,
          }).pipe(
            Effect.provide(sandboxLayer),
            Effect.map((value) => ({
              value,
              preservedWorkspacePath: undefined,
            })),
          ) as any,
      });

      const runLayer = Layer.merge(reuseFactoryLayer, runDisplayLayer);

      // 7. Run orchestration
      const result = yield* Effect.gen(function* () {
        const display = yield* Display;
        yield* display.intro(opts.name ?? "sandcastle");

        return yield* orchestrate({
          hostRepoDir,
          iterations: maxIterations,
          hooks,
          prompt: resolvedPrompt,
          branch: worktreeInfo.branch,
          provider,
          completionSignal: opts.completionSignal,
          idleTimeoutSeconds: opts.idleTimeoutSeconds,
          name: opts.name,
        });
      }).pipe(
        Effect.provide(runLayer),
        // Always close sandbox handle
        Effect.ensuring(Effect.promise(() => handle.close().catch(() => {}))),
      );

      return {
        iterationsRun: result.iterationsRun,
        completionSignal: result.completionSignal,
        stdout: result.stdout,
        commits: result.commits,
        branch: result.branch,
        logFilePath:
          resolvedLogging.type === "file" ? resolvedLogging.path : undefined,
      } satisfies WorkspaceRunResult;
    });

    return Effect.runPromise(
      inner.pipe(
        Effect.provide(ClackDisplay.layer),
        Effect.provide(NodeContext.layer),
        Effect.provide(NodeFileSystem.layer),
      ),
    );
  };

  return {
    branch: worktreeInfo.branch,
    workspacePath: worktreeInfo.path,
    run: workspaceRun,
    interactive: workspaceInteractive,
    close,
    async [Symbol.asyncDispose]() {
      await close();
    },
  };
};
