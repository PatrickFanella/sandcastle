import { NodeContext, NodeFileSystem } from "@effect/platform-node";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Effect, Layer, Ref } from "effect";
import type { AgentProvider } from "./AgentProvider.js";
import {
  Display,
  FileDisplay,
  SilentDisplay,
  type DisplayEntry,
} from "./Display.js";
import {
  startContainer,
  removeContainer,
  chownInContainer,
} from "./DockerLifecycle.js";
import { resolveEnv } from "./EnvResolver.js";
import { orchestrate } from "./Orchestrator.js";
import {
  type PromptArgs,
  substitutePromptArgs,
  validateNoBuiltInArgOverride,
  BUILT_IN_PROMPT_ARG_KEYS,
} from "./PromptArgumentSubstitution.js";
import { resolvePrompt } from "./PromptResolver.js";
import type { LoggingOption } from "./run.js";
import {
  buildLogFilename,
  defaultImageName,
  printFileDisplayStartup,
} from "./run.js";
import {
  Sandbox as SandboxTag,
  SandboxFactory,
  SANDBOX_WORKSPACE_DIR,
  makeDockerSandboxLayer,
  makeSandboxLayerFromHandle,
  resolveGitVolumeMounts,
} from "./SandboxFactory.js";
import type {
  SandboxProvider,
  BindMountSandboxHandle,
} from "./SandboxProvider.js";
import * as WorktreeManager from "./WorktreeManager.js";
import { copyToSandbox } from "./CopyToSandbox.js";

export interface CreateSandboxOptions {
  /** Explicit branch for the worktree (required). */
  readonly branch: string;
  /** Sandbox provider (e.g. docker()). When omitted, defaults to Docker internally. */
  readonly sandbox?: SandboxProvider;
  /** Docker image name to use for the sandbox (default: sandcastle:<repo-dir-name>). */
  readonly imageName?: string;
  /** One-time setup hooks to run when the sandbox is first created. */
  readonly hooks?: {
    readonly onSandboxReady?: ReadonlyArray<{ command: string }>;
  };
  /** Paths relative to the host repo root to copy into the worktree at creation time. */
  readonly copyToSandbox?: string[];
  /** @internal Test-only overrides to bypass Docker. */
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

export interface CloseResult {
  /** Host path to the preserved worktree, set when the worktree had uncommitted changes. */
  readonly preservedWorktreePath?: string;
}

export interface Sandbox {
  /** The branch the worktree is on. */
  readonly branch: string;
  /** Host path to the worktree. */
  readonly worktreePath: string;
  /** Invoke an agent inside the existing sandbox. */
  run(options: SandboxRunOptions): Promise<SandboxRunResult>;
  /** Tear down the container and worktree. */
  close(): Promise<CloseResult>;
  /** Auto teardown via `await using`. */
  [Symbol.asyncDispose](): Promise<void>;
}

/**
 * Eagerly creates a git worktree on the provided explicit branch and starts
 * a Docker container (or local sandbox in test mode) with the worktree
 * bind-mounted. Returns a Sandbox handle that can be reused across multiple
 * `run()` calls.
 */
export const createSandbox = async (
  options: CreateSandboxOptions,
): Promise<Sandbox> => {
  const hostRepoDir = options._test?.hostRepoDir ?? process.cwd();
  const { branch } = options;
  const isTestMode = !!options._test?.buildSandboxLayer;

  // 1. Prune stale worktrees + create worktree on the explicit branch
  const worktreeInfo = await Effect.runPromise(
    WorktreeManager.pruneStale(hostRepoDir)
      .pipe(Effect.catchAll(() => Effect.void))
      .pipe(Effect.andThen(WorktreeManager.create(hostRepoDir, { branch })))
      .pipe(Effect.provide(NodeContext.layer)),
  );

  const worktreePath = worktreeInfo.path;

  // 2. Copy files if requested
  if (options.copyToSandbox && options.copyToSandbox.length > 0) {
    await Effect.runPromise(
      copyToSandbox(options.copyToSandbox, hostRepoDir, worktreePath),
    );
  }

  // 3. Start container (Docker mode), provider mode, or local sandbox layer (test mode)
  let containerName: string | undefined;
  let providerHandle: BindMountSandboxHandle | undefined;
  let sandboxLayer: Layer.Layer<SandboxTag>;
  let sandboxRepoDir: string;

  if (isTestMode) {
    sandboxLayer = options._test!.buildSandboxLayer!(worktreePath);
    sandboxRepoDir = worktreePath;
  } else if (options.sandbox) {
    // Provider mode: delegate to the sandbox provider
    const env = await Effect.runPromise(
      resolveEnv(hostRepoDir).pipe(Effect.provide(NodeContext.layer)),
    );

    const gitPath = join(hostRepoDir, ".git");
    const gitMounts = await Effect.runPromise(
      resolveGitVolumeMounts(gitPath).pipe(
        Effect.provide(NodeFileSystem.layer),
      ),
    );

    const mounts = [
      { hostPath: worktreePath, sandboxPath: SANDBOX_WORKSPACE_DIR },
      ...gitMounts.map((m) => {
        const [hostPath, sandboxPath] = m.split(":");
        return { hostPath: hostPath!, sandboxPath: sandboxPath! };
      }),
    ];

    providerHandle = await options.sandbox.create({
      worktreePath,
      hostRepoPath: hostRepoDir,
      mounts,
      env,
    });

    sandboxLayer = makeSandboxLayerFromHandle(providerHandle);
    sandboxRepoDir = providerHandle.workspacePath;
  } else {
    containerName = `sandcastle-${randomUUID()}`;
    const resolvedImageName =
      options.imageName ?? defaultImageName(hostRepoDir);

    const env = await Effect.runPromise(
      resolveEnv(hostRepoDir).pipe(Effect.provide(NodeContext.layer)),
    );

    const gitPath = join(hostRepoDir, ".git");
    const gitMounts = await Effect.runPromise(
      resolveGitVolumeMounts(gitPath).pipe(
        Effect.provide(NodeFileSystem.layer),
      ),
    );
    const volumeMounts = [
      `${worktreePath}:${SANDBOX_WORKSPACE_DIR}`,
      ...gitMounts,
    ];

    const hostUid = process.getuid?.() ?? 1000;
    const hostGid = process.getgid?.() ?? 1000;

    await Effect.runPromise(
      startContainer(
        containerName,
        resolvedImageName,
        { ...env, HOME: "/home/agent" },
        {
          volumeMounts,
          workdir: SANDBOX_WORKSPACE_DIR,
          user: `${hostUid}:${hostGid}`,
        },
      ).pipe(
        Effect.andThen(
          chownInContainer(
            containerName,
            `${hostUid}:${hostGid}`,
            "/home/agent",
          ),
        ),
      ),
    );

    sandboxLayer = makeDockerSandboxLayer(containerName);
    sandboxRepoDir = SANDBOX_WORKSPACE_DIR;
  }

  // 4. Run onSandboxReady hooks
  if (options.hooks?.onSandboxReady?.length) {
    await Effect.runPromise(
      Effect.gen(function* () {
        const sandbox = yield* SandboxTag;
        yield* sandbox.exec(
          `git config --global --add safe.directory "${sandboxRepoDir}"`,
        );
        for (const hook of options.hooks!.onSandboxReady!) {
          yield* sandbox.exec(hook.command, { cwd: sandboxRepoDir });
        }
      }).pipe(Effect.provide(sandboxLayer)),
    );
  }

  // 5. Set up signal handlers
  let closed = false;

  const forceCleanup = () => {
    if (containerName) {
      try {
        execFileSync("docker", ["rm", "-f", containerName], {
          stdio: "ignore",
        });
      } catch {}
    }
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

  // 6. Build close function
  const doClose = async (): Promise<CloseResult> => {
    if (closed) return { preservedWorktreePath: undefined };
    closed = true;

    // Remove container / close provider handle
    if (providerHandle) {
      await providerHandle.close();
    } else if (containerName) {
      await Effect.runPromise(
        removeContainer(containerName).pipe(Effect.orDie),
      );
    }

    // Check for uncommitted changes
    const isDirty = await Effect.runPromise(
      WorktreeManager.hasUncommittedChanges(worktreePath).pipe(
        Effect.catchAll(() => Effect.succeed(false)),
      ),
    );

    if (isDirty) {
      return { preservedWorktreePath: worktreePath };
    }

    // Remove worktree
    await Effect.runPromise(
      WorktreeManager.remove(worktreePath).pipe(
        Effect.catchAll(() => Effect.void),
      ),
    );

    return { preservedWorktreePath: undefined };
  };

  // 7. Return the Sandbox handle
  const sandboxHandle: Sandbox = {
    branch,
    worktreePath,

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
        WorktreeManager.getCurrentBranch(hostRepoDir),
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

      // Build a SandboxFactory that reuses the existing container/sandbox
      const reuseFactoryLayer = Layer.succeed(SandboxFactory, {
        withSandbox: (makeEffect) =>
          makeEffect({ hostWorktreePath: worktreePath }).pipe(
            Effect.provide(sandboxLayer),
            Effect.map((value) => ({
              value,
              preservedWorktreePath: undefined,
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
            sandboxRepoDir,
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
