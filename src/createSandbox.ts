import { NodeContext, NodeFileSystem } from "@effect/platform-node";
import { join } from "node:path";
import { Effect, Layer, Ref } from "effect";
import type { AgentProvider } from "./AgentProvider.js";
import {
  ClackDisplay,
  Display,
  FileDisplay,
  SilentDisplay,
  type DisplayEntry,
} from "./Display.js";
import { resolveEnv } from "./EnvResolver.js";
import { mergeProviderEnv } from "./mergeProviderEnv.js";
import { orchestrate } from "./Orchestrator.js";
import {
  type PromptArgs,
  substitutePromptArgs,
  validateNoBuiltInArgOverride,
  BUILT_IN_PROMPT_ARG_KEYS,
} from "./PromptArgumentSubstitution.js";
import { resolvePrompt } from "./PromptResolver.js";
import { preprocessPrompt } from "./PromptPreprocessor.js";
import type { LoggingOption } from "./run.js";
import { buildLogFilename, printFileDisplayStartup } from "./run.js";
import { withSandboxLifecycle } from "./SandboxLifecycle.js";
import {
  Sandbox as SandboxTag,
  SandboxFactory,
  SANDBOX_WORKSPACE_DIR,
  resolveGitMounts,
} from "./SandboxFactory.js";
import type {
  SandboxProvider,
  BindMountSandboxHandle,
  IsolatedSandboxHandle,
} from "./SandboxProvider.js";
import { startSandbox } from "./startSandbox.js";
import { syncOut } from "./syncOut.js";
import * as WorkspaceManager from "./WorkspaceManager.js";
import { copyToWorkspace } from "./CopyToWorkspace.js";

export interface CreateSandboxOptions {
  /** Explicit branch for the worktree (required). */
  readonly branch: string;
  /** Sandbox provider (e.g. docker({ imageName: "sandcastle:myrepo" })). */
  readonly sandbox: SandboxProvider;
  /** One-time setup hooks to run when the sandbox is first created. */
  readonly hooks?: {
    readonly onSandboxReady?: ReadonlyArray<{
      command: string;
      sudo?: boolean;
    }>;
  };
  /** Paths relative to the host repo root to copy into the worktree at creation time. */
  readonly copyToWorkspace?: string[];
  /** When false, reuse an existing worktree instead of failing on collision. Default: true. */
  readonly throwOnDuplicateWorktree?: boolean;
  /** @internal Test-only overrides to bypass the sandbox provider. */
  readonly _test?: {
    readonly hostRepoDir?: string;
    readonly buildSandboxLayer?: (
      sandboxDir: string,
    ) => Layer.Layer<SandboxTag>;
  };
}

export interface SandboxRunOptions {
  /** Agent provider to use (e.g. claudeCode("claude-opus-4-6")). */
  readonly agent: AgentProvider;
  /** Inline prompt string (mutually exclusive with promptFile). */
  readonly prompt?: string;
  /** Path to a prompt file (mutually exclusive with prompt). */
  readonly promptFile?: string;
  /** Key-value map for {{KEY}} placeholder substitution in prompts. */
  readonly promptArgs?: PromptArgs;
  /** Maximum iterations to run (default: 1). */
  readonly maxIterations?: number;
  /** Substring(s) the agent emits to stop the iteration loop early. */
  readonly completionSignal?: string | string[];
  /** Idle timeout in seconds. Default: 600. */
  readonly idleTimeoutSeconds?: number;
  /** Display name for this run. */
  readonly name?: string;
  /** Logging mode. */
  readonly logging?: LoggingOption;
}

export interface SandboxRunResult {
  /** Number of iterations the agent completed during this run. */
  readonly iterationsRun: number;
  /** The matched completion signal string, or undefined if none fired. */
  readonly completionSignal?: string;
  /** Combined stdout output from all agent iterations. */
  readonly stdout: string;
  /** List of commits made by the agent during the run. */
  readonly commits: { sha: string }[];
  /** Path to the log file, if logging was drained to a file. */
  readonly logFilePath?: string;
}

export interface SandboxInteractiveOptions {
  /** Agent provider to use (e.g. claudeCode("claude-opus-4-6")). */
  readonly agent: AgentProvider;
  /** Inline prompt string (mutually exclusive with promptFile). */
  readonly prompt?: string;
  /** Path to a prompt file (mutually exclusive with prompt). */
  readonly promptFile?: string;
  /** Key-value map for {{KEY}} placeholder substitution in prompts. */
  readonly promptArgs?: PromptArgs;
  /** Display name for this interactive session. */
  readonly name?: string;
}

export interface SandboxInteractiveResult {
  /** List of commits made during the interactive session. */
  readonly commits: { sha: string }[];
  /** Exit code of the interactive process. */
  readonly exitCode: number;
}

export interface CloseResult {
  /** Host path to the preserved workspace, set when the workspace had uncommitted changes. */
  readonly preservedWorkspacePath?: string;
}

export interface Sandbox {
  /** The branch the workspace is on. */
  readonly branch: string;
  /** Host path to the workspace. */
  readonly workspacePath: string;
  /** Invoke an agent inside the existing sandbox. */
  run(options: SandboxRunOptions): Promise<SandboxRunResult>;
  /** Launch an interactive agent session inside the existing sandbox. */
  interactive(
    options: SandboxInteractiveOptions,
  ): Promise<SandboxInteractiveResult>;
  /** Tear down the sandbox and worktree. */
  close(): Promise<CloseResult>;
  /** Auto teardown via `await using`. */
  [Symbol.asyncDispose](): Promise<void>;
}

/** @internal Options for createSandboxFromWorkspace — used by workspace.createSandbox(). */
export interface CreateSandboxFromWorkspaceOptions {
  readonly branch: string;
  readonly worktreePath: string;
  readonly hostRepoDir: string;
  readonly sandbox: SandboxProvider;
  readonly hooks?: {
    readonly onSandboxReady?: ReadonlyArray<{
      command: string;
      sudo?: boolean;
    }>;
  };
  readonly copyToWorkspace?: string[];
  readonly _test?: {
    readonly buildSandboxLayer?: (
      sandboxDir: string,
    ) => Layer.Layer<SandboxTag>;
  };
}

/**
 * @internal Creates a sandbox backed by an existing workspace worktree.
 * Split ownership: close() tears down the container only, leaving the worktree intact.
 * Used by Workspace.createSandbox().
 */
export const createSandboxFromWorkspace = async (
  options: CreateSandboxFromWorkspaceOptions,
): Promise<Sandbox> => {
  const { branch, worktreePath, hostRepoDir } = options;
  const isTestMode = !!options._test?.buildSandboxLayer;

  // 1. Copy files if requested (bind-mount only)
  if (
    options.copyToWorkspace &&
    options.copyToWorkspace.length > 0 &&
    options.sandbox.tag !== "isolated"
  ) {
    await Effect.runPromise(
      copyToWorkspace(options.copyToWorkspace, hostRepoDir, worktreePath),
    );
  }

  // 2. Start sandbox via provider or local sandbox layer (test mode)
  let providerHandle:
    | BindMountSandboxHandle
    | IsolatedSandboxHandle
    | undefined;
  let sandboxLayer: Layer.Layer<SandboxTag>;
  let sandboxRepoDir: string;
  const isIsolated = options.sandbox.tag === "isolated";

  if (isTestMode) {
    sandboxLayer = options._test!.buildSandboxLayer!(worktreePath);
    sandboxRepoDir = worktreePath;
  } else {
    const resolvedEnv = await Effect.runPromise(
      resolveEnv(hostRepoDir).pipe(Effect.provide(NodeContext.layer)),
    );
    const env = mergeProviderEnv({
      resolvedEnv,
      agentProviderEnv: {},
      sandboxProviderEnv: options.sandbox.env,
    });

    const provider = options.sandbox;

    let startEffect;
    if (provider.tag === "isolated") {
      startEffect = startSandbox({
        provider,
        hostRepoDir: worktreePath,
        env,
        copyPaths: options.copyToWorkspace,
      });
    } else {
      startEffect = resolveGitMounts(join(hostRepoDir, ".git")).pipe(
        Effect.provide(NodeFileSystem.layer),
        Effect.catchAll(() => Effect.succeed([])),
        Effect.flatMap((gitMounts) =>
          startSandbox({
            provider,
            hostRepoDir,
            env,
            worktreeOrRepoPath: worktreePath,
            gitMounts,
            workspaceDir: SANDBOX_WORKSPACE_DIR,
          }),
        ),
      );
    }

    const startResult = await Effect.runPromise(startEffect);

    providerHandle = startResult.handle;
    sandboxLayer = startResult.sandboxLayer;
    sandboxRepoDir = startResult.workspacePath;
  }

  // 3. Run onSandboxReady hooks
  if (options.hooks?.onSandboxReady?.length) {
    await Effect.runPromise(
      Effect.gen(function* () {
        const sandbox = yield* SandboxTag;
        yield* sandbox.exec(
          `git config --global --add safe.directory "${sandboxRepoDir}"`,
        );
        yield* Effect.all(
          options.hooks!.onSandboxReady!.map((hook) =>
            sandbox.exec(hook.command, {
              cwd: sandboxRepoDir,
              sudo: hook.sudo,
            }),
          ),
          { concurrency: "unbounded" },
        );
      }).pipe(Effect.provide(sandboxLayer)),
    );
  }

  // 4. Build applyToHost callback
  const applyToHost =
    isIsolated && providerHandle
      ? () => syncOut(worktreePath, providerHandle as IsolatedSandboxHandle)
      : () => Effect.void;

  // 5. Build close function — container only, no worktree cleanup
  let closed = false;

  const doClose = async (): Promise<CloseResult> => {
    if (closed) return { preservedWorkspacePath: undefined };
    closed = true;

    if (providerHandle) {
      await providerHandle.close();
    }

    // Split ownership: do NOT check dirty / remove worktree — workspace owns that
    return { preservedWorkspacePath: undefined };
  };

  // 6. Return the Sandbox handle
  const sandboxHandle: Sandbox = {
    branch,
    workspacePath: worktreePath,

    run: async (runOptions: SandboxRunOptions): Promise<SandboxRunResult> => {
      const {
        agent: provider,
        prompt,
        promptFile,
        maxIterations = 1,
      } = runOptions;

      const rawPrompt = await Effect.runPromise(
        resolvePrompt({ prompt, promptFile }).pipe(
          Effect.provide(NodeContext.layer),
        ),
      );

      const userArgs = runOptions.promptArgs ?? {};
      const currentHostBranch = await Effect.runPromise(
        WorkspaceManager.getCurrentBranch(hostRepoDir),
      );

      const displayRef = Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([]);
      const silentDisplayLayer = SilentDisplay.layer(displayRef);

      const resolvedPrompt = await Effect.runPromise(
        Effect.gen(function* () {
          yield* validateNoBuiltInArgOverride(userArgs);
          const effectiveArgs = {
            SOURCE_BRANCH: branch,
            TARGET_BRANCH: currentHostBranch,
            ...userArgs,
          };
          const builtInArgKeysSet = new Set<string>(BUILT_IN_PROMPT_ARG_KEYS);
          return yield* substitutePromptArgs(
            rawPrompt,
            effectiveArgs,
            builtInArgKeysSet,
          );
        }).pipe(Effect.provide(silentDisplayLayer)),
      );

      const resolvedLogging: LoggingOption = runOptions.logging ?? {
        type: "file",
        path: join(
          hostRepoDir,
          ".sandcastle",
          "logs",
          buildLogFilename(branch, undefined, runOptions.name),
        ),
      };

      const runDisplayLayer =
        resolvedLogging.type === "file"
          ? (() => {
              printFileDisplayStartup({
                logPath: resolvedLogging.path,
                agentName: runOptions.name,
                branch,
              });
              return Layer.provide(
                FileDisplay.layer(resolvedLogging.path),
                NodeFileSystem.layer,
              );
            })()
          : silentDisplayLayer;

      const reuseFactoryLayer = Layer.succeed(SandboxFactory, {
        withSandbox: (makeEffect) =>
          makeEffect({
            hostWorkspacePath: worktreePath,
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

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const display = yield* Display;
          yield* display.intro(runOptions.name ?? "sandcastle");

          return yield* orchestrate({
            hostRepoDir,
            iterations: maxIterations,
            prompt: resolvedPrompt,
            branch,
            provider,
            completionSignal: runOptions.completionSignal,
            idleTimeoutSeconds: runOptions.idleTimeoutSeconds,
            name: runOptions.name,
          });
        }).pipe(Effect.provide(runLayer)),
      );

      return {
        iterationsRun: result.iterationsRun,
        completionSignal: result.completionSignal,
        stdout: result.stdout,
        commits: result.commits,
        logFilePath:
          resolvedLogging.type === "file" ? resolvedLogging.path : undefined,
      };
    },

    interactive: async (
      interactiveOptions: SandboxInteractiveOptions,
    ): Promise<SandboxInteractiveResult> => {
      const { agent: provider, prompt, promptFile } = interactiveOptions;

      if (!provider.buildInteractiveArgs) {
        throw new Error(
          `Agent provider "${provider.name}" does not support buildInteractiveArgs, required for interactive sessions.`,
        );
      }

      if (!providerHandle?.interactiveExec) {
        throw new Error(
          `Sandbox provider does not support interactiveExec. ` +
            `The provider must implement the optional interactiveExec method to use interactive().`,
        );
      }
      const interactiveExecFn =
        providerHandle.interactiveExec.bind(providerHandle);

      const lifecycleResult = await Effect.runPromise(
        Effect.gen(function* () {
          const rawPrompt = yield* resolvePrompt({ prompt, promptFile });

          const userArgs = interactiveOptions.promptArgs ?? {};
          const currentHostBranch =
            yield* WorkspaceManager.getCurrentBranch(hostRepoDir);

          yield* validateNoBuiltInArgOverride(userArgs);
          const effectiveArgs = {
            SOURCE_BRANCH: branch,
            TARGET_BRANCH: currentHostBranch,
            ...userArgs,
          };
          const builtInArgKeysSet = new Set<string>(BUILT_IN_PROMPT_ARG_KEYS);
          const resolvedPrompt = yield* substitutePromptArgs(
            rawPrompt,
            effectiveArgs,
            builtInArgKeysSet,
          );

          return yield* withSandboxLifecycle(
            {
              hostRepoDir,
              sandboxRepoDir,
              branch,
              hostWorkspacePath: worktreePath,
              applyToHost,
            },
            (ctx) =>
              Effect.gen(function* () {
                const fullPrompt = yield* preprocessPrompt(
                  resolvedPrompt,
                  ctx.sandbox,
                  ctx.sandboxRepoDir,
                );

                const interactiveArgs = provider.buildInteractiveArgs!({
                  prompt: fullPrompt,
                  dangerouslySkipPermissions: true,
                });
                const result = yield* Effect.promise(() =>
                  interactiveExecFn(interactiveArgs, {
                    stdin: process.stdin,
                    stdout: process.stdout,
                    stderr: process.stderr,
                    cwd: sandboxRepoDir,
                  }),
                );

                return result.exitCode;
              }),
          );
        }).pipe(
          Effect.provide(sandboxLayer),
          Effect.provide(ClackDisplay.layer),
          Effect.provide(NodeContext.layer),
        ),
      );

      return {
        commits: lifecycleResult.commits,
        exitCode: lifecycleResult.result,
      };
    },

    close: async (): Promise<CloseResult> => {
      return doClose();
    },

    [Symbol.asyncDispose]: async (): Promise<void> => {
      await sandboxHandle.close();
    },
  };

  return sandboxHandle;
};

/**
 * Eagerly creates a git worktree on the provided explicit branch and starts
 * a sandbox with the worktree bind-mounted. Returns a Sandbox handle that
 * can be reused across multiple `run()` calls.
 */
export const createSandbox = async (
  options: CreateSandboxOptions,
): Promise<Sandbox> => {
  const hostRepoDir = options._test?.hostRepoDir ?? process.cwd();
  const { branch } = options;
  const isTestMode = !!options._test?.buildSandboxLayer;

  // 1. Prune stale worktrees + create worktree on the explicit branch
  const worktreeInfo = await Effect.runPromise(
    WorkspaceManager.pruneStale(hostRepoDir)
      .pipe(Effect.catchAll(() => Effect.void))
      .pipe(
        Effect.andThen(
          WorkspaceManager.create(hostRepoDir, {
            branch,
            throwOnDuplicateWorktree: options.throwOnDuplicateWorktree,
          }),
        ),
      )
      .pipe(Effect.provide(NodeContext.layer)),
  );

  const worktreePath = worktreeInfo.path;

  // 2. Copy files if requested (bind-mount only; isolated providers handle this in startSandbox)
  if (
    options.copyToWorkspace &&
    options.copyToWorkspace.length > 0 &&
    options.sandbox.tag !== "isolated"
  ) {
    await Effect.runPromise(
      copyToWorkspace(options.copyToWorkspace, hostRepoDir, worktreePath),
    );
  }

  // 3. Start sandbox via provider or local sandbox layer (test mode)
  let providerHandle:
    | BindMountSandboxHandle
    | IsolatedSandboxHandle
    | undefined;
  let sandboxLayer: Layer.Layer<SandboxTag>;
  let sandboxRepoDir: string;
  const isIsolated = options.sandbox.tag === "isolated";

  if (isTestMode) {
    sandboxLayer = options._test!.buildSandboxLayer!(worktreePath);
    sandboxRepoDir = worktreePath;
  } else {
    // Provider mode: delegate to the shared startSandbox helper
    const resolvedEnv = await Effect.runPromise(
      resolveEnv(hostRepoDir).pipe(Effect.provide(NodeContext.layer)),
    );
    const env = mergeProviderEnv({
      resolvedEnv,
      agentProviderEnv: {},
      sandboxProviderEnv: options.sandbox.env,
    });

    const provider = options.sandbox;

    let startEffect;
    if (provider.tag === "isolated") {
      startEffect = startSandbox({
        provider,
        hostRepoDir: worktreePath,
        env,
        copyPaths: options.copyToWorkspace,
      });
    } else {
      startEffect = resolveGitMounts(join(hostRepoDir, ".git")).pipe(
        Effect.provide(NodeFileSystem.layer),
        Effect.catchAll(() => Effect.succeed([])),
        Effect.flatMap((gitMounts) =>
          startSandbox({
            provider,
            hostRepoDir,
            env,
            worktreeOrRepoPath: worktreePath,
            gitMounts,
            workspaceDir: SANDBOX_WORKSPACE_DIR,
          }),
        ),
      );
    }

    const startResult = await Effect.runPromise(startEffect);

    providerHandle = startResult.handle;
    sandboxLayer = startResult.sandboxLayer;
    sandboxRepoDir = startResult.workspacePath;
  }

  // 4. Run onSandboxReady hooks
  if (options.hooks?.onSandboxReady?.length) {
    await Effect.runPromise(
      Effect.gen(function* () {
        const sandbox = yield* SandboxTag;
        yield* sandbox.exec(
          `git config --global --add safe.directory "${sandboxRepoDir}"`,
        );
        yield* Effect.all(
          options.hooks!.onSandboxReady!.map((hook) =>
            sandbox.exec(hook.command, {
              cwd: sandboxRepoDir,
              sudo: hook.sudo,
            }),
          ),
          { concurrency: "unbounded" },
        );
      }).pipe(Effect.provide(sandboxLayer)),
    );
  }

  // 5. Build applyToHost callback (once, reused across runs)
  const applyToHost =
    isIsolated && providerHandle
      ? () => syncOut(worktreePath, providerHandle as IsolatedSandboxHandle)
      : () => Effect.void;

  // 6. Set up signal handlers
  let closed = false;

  const forceCleanup = () => {
    console.error(`\nWorktree preserved at ${worktreePath}`);
    console.error(`  To review: cd ${worktreePath}`);
    console.error(`  To clean up: git worktree remove --force ${worktreePath}`);
  };

  const onSignal = () => {
    forceCleanup();
    process.exit(1);
  };

  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  // 7. Build close function
  const doClose = async (): Promise<CloseResult> => {
    if (closed) return { preservedWorkspacePath: undefined };
    closed = true;

    // Close provider handle
    if (providerHandle) {
      await providerHandle.close();
    }

    // Check for uncommitted changes
    const isDirty = await Effect.runPromise(
      WorkspaceManager.hasUncommittedChanges(worktreePath).pipe(
        Effect.catchAll(() => Effect.succeed(false)),
      ),
    );

    if (isDirty) {
      return { preservedWorkspacePath: worktreePath };
    }

    // Remove worktree
    await Effect.runPromise(
      WorkspaceManager.remove(worktreePath).pipe(
        Effect.catchAll(() => Effect.void),
      ),
    );

    return { preservedWorkspacePath: undefined };
  };

  // 8. Return the Sandbox handle
  const sandboxHandle: Sandbox = {
    branch,
    workspacePath: worktreePath,

    run: async (runOptions: SandboxRunOptions): Promise<SandboxRunResult> => {
      const {
        agent: provider,
        prompt,
        promptFile,
        maxIterations = 1,
      } = runOptions;

      // Resolve prompt
      const rawPrompt = await Effect.runPromise(
        resolvePrompt({ prompt, promptFile }).pipe(
          Effect.provide(NodeContext.layer),
        ),
      );

      // Resolve prompt arguments
      const userArgs = runOptions.promptArgs ?? {};
      const currentHostBranch = await Effect.runPromise(
        WorkspaceManager.getCurrentBranch(hostRepoDir),
      );

      const displayRef = Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([]);
      const silentDisplayLayer = SilentDisplay.layer(displayRef);

      const resolvedPrompt = await Effect.runPromise(
        Effect.gen(function* () {
          yield* validateNoBuiltInArgOverride(userArgs);
          const effectiveArgs = {
            SOURCE_BRANCH: branch,
            TARGET_BRANCH: currentHostBranch,
            ...userArgs,
          };
          const builtInArgKeysSet = new Set<string>(BUILT_IN_PROMPT_ARG_KEYS);
          return yield* substitutePromptArgs(
            rawPrompt,
            effectiveArgs,
            builtInArgKeysSet,
          );
        }).pipe(Effect.provide(silentDisplayLayer)),
      );

      // Resolve logging
      const resolvedLogging: LoggingOption = runOptions.logging ?? {
        type: "file",
        path: join(
          hostRepoDir,
          ".sandcastle",
          "logs",
          buildLogFilename(branch, undefined, runOptions.name),
        ),
      };

      const runDisplayLayer =
        resolvedLogging.type === "file"
          ? (() => {
              printFileDisplayStartup({
                logPath: resolvedLogging.path,
                agentName: runOptions.name,
                branch,
              });
              return Layer.provide(
                FileDisplay.layer(resolvedLogging.path),
                NodeFileSystem.layer,
              );
            })()
          : silentDisplayLayer;

      // Build a SandboxFactory that reuses the existing sandbox
      const reuseFactoryLayer = Layer.succeed(SandboxFactory, {
        withSandbox: (makeEffect) =>
          makeEffect({
            hostWorkspacePath: worktreePath,
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

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const display = yield* Display;
          yield* display.intro(runOptions.name ?? "sandcastle");

          return yield* orchestrate({
            hostRepoDir,
            iterations: maxIterations,
            prompt: resolvedPrompt,
            branch,
            provider,
            completionSignal: runOptions.completionSignal,
            idleTimeoutSeconds: runOptions.idleTimeoutSeconds,
            name: runOptions.name,
          });
        }).pipe(Effect.provide(runLayer)),
      );

      return {
        iterationsRun: result.iterationsRun,
        completionSignal: result.completionSignal,
        stdout: result.stdout,
        commits: result.commits,
        logFilePath:
          resolvedLogging.type === "file" ? resolvedLogging.path : undefined,
      };
    },

    interactive: async (
      interactiveOptions: SandboxInteractiveOptions,
    ): Promise<SandboxInteractiveResult> => {
      const { agent: provider, prompt, promptFile } = interactiveOptions;

      // Validate buildInteractiveArgs is available
      if (!provider.buildInteractiveArgs) {
        throw new Error(
          `Agent provider "${provider.name}" does not support buildInteractiveArgs, required for interactive sessions.`,
        );
      }

      // Validate interactiveExec is available on the handle
      if (!providerHandle?.interactiveExec) {
        throw new Error(
          `Sandbox provider does not support interactiveExec. ` +
            `The provider must implement the optional interactiveExec method to use interactive().`,
        );
      }
      const interactiveExecFn =
        providerHandle.interactiveExec.bind(providerHandle);

      const lifecycleResult = await Effect.runPromise(
        Effect.gen(function* () {
          // Resolve prompt
          const rawPrompt = yield* resolvePrompt({ prompt, promptFile });

          // Resolve prompt arguments
          const userArgs = interactiveOptions.promptArgs ?? {};
          const currentHostBranch =
            yield* WorkspaceManager.getCurrentBranch(hostRepoDir);

          yield* validateNoBuiltInArgOverride(userArgs);
          const effectiveArgs = {
            SOURCE_BRANCH: branch,
            TARGET_BRANCH: currentHostBranch,
            ...userArgs,
          };
          const builtInArgKeysSet = new Set<string>(BUILT_IN_PROMPT_ARG_KEYS);
          const resolvedPrompt = yield* substitutePromptArgs(
            rawPrompt,
            effectiveArgs,
            builtInArgKeysSet,
          );

          // Run interactive session using withSandboxLifecycle for commit collection
          return yield* withSandboxLifecycle(
            {
              hostRepoDir,
              sandboxRepoDir,
              branch,
              hostWorkspacePath: worktreePath,
              applyToHost,
            },
            (ctx) =>
              Effect.gen(function* () {
                // Preprocess prompt (expand !`command` shell expressions inside sandbox)
                const fullPrompt = yield* preprocessPrompt(
                  resolvedPrompt,
                  ctx.sandbox,
                  ctx.sandboxRepoDir,
                );

                // Build interactive args and run the session
                const interactiveArgs = provider.buildInteractiveArgs!({
                  prompt: fullPrompt,
                  dangerouslySkipPermissions: true,
                });
                const result = yield* Effect.promise(() =>
                  interactiveExecFn(interactiveArgs, {
                    stdin: process.stdin,
                    stdout: process.stdout,
                    stderr: process.stderr,
                    cwd: sandboxRepoDir,
                  }),
                );

                return result.exitCode;
              }),
          );
        }).pipe(
          Effect.provide(sandboxLayer),
          Effect.provide(ClackDisplay.layer),
          Effect.provide(NodeContext.layer),
        ),
      );

      return {
        commits: lifecycleResult.commits,
        exitCode: lifecycleResult.result,
      };
    },

    close: async (): Promise<CloseResult> => {
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
      return doClose();
    },

    [Symbol.asyncDispose]: async (): Promise<void> => {
      await sandboxHandle.close();
    },
  };

  return sandboxHandle;
};
