import { Context, Effect, Exit, Layer } from "effect";
import { FileSystem } from "@effect/platform";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { PlatformError } from "@effect/platform/Error";
import {
  AgentError,
  CopyError,
  ExecError,
  SyncError,
  TimeoutError,
  WorktreeError,
  type DockerError,
} from "./errors.js";
import * as WorktreeManager from "./WorktreeManager.js";
import { copyToSandbox } from "./CopyToSandbox.js";
import { Display } from "./Display.js";
import type {
  SandboxProvider,
  BindMountSandboxProvider,
  BindMountSandboxHandle,
  IsolatedSandboxProvider,
  IsolatedSandboxHandle,
} from "./SandboxProvider.js";
import { syncIn } from "./syncIn.js";
import { syncOut } from "./syncOut.js";

export interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface SandboxService {
  readonly exec: (
    command: string,
    options?: { cwd?: string },
  ) => Effect.Effect<ExecResult, ExecError>;

  readonly execStreaming: (
    command: string,
    onStdoutLine: (line: string) => void,
    options?: { cwd?: string },
  ) => Effect.Effect<ExecResult, ExecError>;

  readonly copyIn: (
    hostPath: string,
    sandboxPath: string,
  ) => Effect.Effect<void, CopyError>;

  readonly copyOut: (
    sandboxPath: string,
    hostPath: string,
  ) => Effect.Effect<void, CopyError>;
}

export class Sandbox extends Context.Tag("Sandbox")<
  Sandbox,
  SandboxService
>() {}

/**
 * Wrap a Promise-based sandbox handle into an Effect-based SandboxService layer.
 * Works with both bind-mount handles (copyIn/copyOut unsupported) and
 * isolated handles (copyIn/copyOut delegated to the handle).
 */
export const makeSandboxLayerFromHandle = (
  handle: BindMountSandboxHandle | IsolatedSandboxHandle,
): Layer.Layer<Sandbox> =>
  Layer.succeed(Sandbox, {
    exec: (command, options) =>
      Effect.tryPromise({
        try: () => handle.exec(command, options),
        catch: (e) =>
          new ExecError({
            command,
            message: `exec failed: ${e instanceof Error ? e.message : String(e)}`,
          }),
      }),
    execStreaming: (command, onStdoutLine, options) =>
      Effect.tryPromise({
        try: () => handle.execStreaming(command, onStdoutLine, options),
        catch: (e) =>
          new ExecError({
            command,
            message: `exec streaming failed: ${e instanceof Error ? e.message : String(e)}`,
          }),
      }),
    copyIn:
      "copyIn" in handle
        ? (hostPath, sandboxPath) =>
            Effect.tryPromise({
              try: () => handle.copyIn(hostPath, sandboxPath),
              catch: (e) =>
                new CopyError({
                  message: `copyIn failed: ${e instanceof Error ? e.message : String(e)}`,
                }),
            })
        : () =>
            Effect.fail(
              new CopyError({
                message:
                  "copyIn is not supported for bind-mount sandbox providers",
              }),
            ),
    copyOut:
      "copyOut" in handle
        ? (sandboxPath, hostPath) =>
            Effect.tryPromise({
              try: () => handle.copyOut(sandboxPath, hostPath),
              catch: (e) =>
                new CopyError({
                  message: `copyOut failed: ${e instanceof Error ? e.message : String(e)}`,
                }),
            })
        : () =>
            Effect.fail(
              new CopyError({
                message:
                  "copyOut is not supported for bind-mount sandbox providers",
              }),
            ),
  });

/** The mount point inside the container where the project worktree is bound. */
export const SANDBOX_WORKSPACE_DIR = "/home/agent/workspace";

export interface SandboxInfo {
  /** Host-side path to the worktree directory (worktree mode only). */
  readonly hostWorktreePath?: string;
}

export interface WithSandboxResult<A> {
  readonly value: A;
  /** Host path to the preserved worktree, set when the worktree was left behind due to uncommitted changes. */
  readonly preservedWorktreePath?: string;
}

export class SandboxFactory extends Context.Tag("SandboxFactory")<
  SandboxFactory,
  {
    readonly withSandbox: <A, E, R>(
      makeEffect: (info: SandboxInfo) => Effect.Effect<A, E, R | Sandbox>,
    ) => Effect.Effect<
      WithSandboxResult<A>,
      E | DockerError | WorktreeError | SyncError,
      Exclude<R, Sandbox>
    >;
  }
>() {}

export class WorktreeSandboxConfig extends Context.Tag("WorktreeSandboxConfig")<
  WorktreeSandboxConfig,
  {
    readonly env: Record<string, string>;
    readonly hostRepoDir: string;
    /** Worktree mode: none, temp-branch (default), or explicit branch. */
    readonly worktree?: import("./run.js").WorktreeMode;
    /** Paths relative to the host repo root to copy into the worktree before container start. */
    readonly copyToSandbox?: string[];
    /** When specified, the run name is included in the auto-generated branch and worktree names. */
    readonly name?: string;
    /** Sandbox provider — delegates container lifecycle to the provider. */
    readonly sandboxProvider: SandboxProvider;
  }
>() {}

/**
 * Print a message to stderr about a preserved worktree, with review and cleanup instructions.
 */
const printWorktreePreservedMessage = (
  worktreePath: string,
  reason: string,
): void => {
  console.error(`\n${reason}`);
  console.error(`  To review: cd ${worktreePath}`);
  console.error(`  To clean up: git worktree remove --force ${worktreePath}`);
};

export interface MountEntry {
  readonly hostPath: string;
  readonly sandboxPath: string;
}

/**
 * Resolves the git-related mounts needed for the sandbox.
 * Handles both normal repos (where .git is a directory) and worktrees
 * (where .git is a file pointing to the parent repo's .git/worktrees/<name>).
 */
export const resolveGitMounts = (
  gitPath: string,
): Effect.Effect<MountEntry[], PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const stat = yield* fs.stat(gitPath);
    if (stat.type === "Directory") {
      return [{ hostPath: gitPath, sandboxPath: gitPath }];
    }
    // Worktree: .git is a file with "gitdir: <path>"
    const content = (yield* fs.readFileString(gitPath)).trim();
    const match = content.match(/^gitdir:\s*(.+)$/);
    if (!match) {
      // Unrecognized format — fall back to mounting the file as-is
      return [{ hostPath: gitPath, sandboxPath: gitPath }];
    }
    const gitdirPath = match[1]!;
    // gitdirPath is like /path/to/repo/.git/worktrees/<name>
    // Mount both the .git file and the parent .git directory
    const parentGitDir = resolve(gitdirPath, "..", "..");
    return [
      { hostPath: gitPath, sandboxPath: gitPath },
      { hostPath: parentGitDir, sandboxPath: parentGitDir },
    ];
  });

/**
 * Start a sandbox using the provider abstraction.
 * Returns the handle, sandbox layer, and workspace path.
 */
const startProviderSandbox = (
  provider: BindMountSandboxProvider,
  worktreeOrRepoPath: string,
  hostRepoDir: string,
  env: Record<string, string>,
  gitMounts: MountEntry[],
  workspaceDir: string,
): Effect.Effect<
  {
    handle: BindMountSandboxHandle;
    sandboxLayer: Layer.Layer<Sandbox>;
    workspacePath: string;
  },
  DockerError | WorktreeError
> =>
  Effect.tryPromise({
    try: () => {
      const mounts = [
        {
          hostPath: worktreeOrRepoPath,
          sandboxPath: workspaceDir,
        },
        ...gitMounts,
      ];
      return provider.create({
        worktreePath: worktreeOrRepoPath,
        hostRepoPath: hostRepoDir,
        mounts,
        env,
      });
    },
    catch: (e) =>
      new WorktreeError({
        message: `Provider '${provider.name}' create failed: ${e instanceof Error ? e.message : String(e)}`,
      }),
  }).pipe(
    Effect.map((handle) => ({
      handle,
      sandboxLayer: makeSandboxLayerFromHandle(handle),
      workspacePath: handle.workspacePath,
    })),
  );

/**
 * Start an isolated sandbox: create handle, sync host repo via git bundle.
 * Returns the handle, sandbox layer, and workspace path.
 */
const startIsolatedProviderSandbox = (
  provider: IsolatedSandboxProvider,
  hostRepoDir: string,
  env: Record<string, string>,
  copyPaths?: string[],
): Effect.Effect<
  {
    handle: IsolatedSandboxHandle;
    sandboxLayer: Layer.Layer<Sandbox>;
    workspacePath: string;
  },
  DockerError | WorktreeError | SyncError
> =>
  Effect.gen(function* () {
    const handle = yield* Effect.tryPromise({
      try: () => provider.create({ env }),
      catch: (e) =>
        new WorktreeError({
          message: `Isolated provider '${provider.name}' setup failed: ${e instanceof Error ? e.message : String(e)}`,
        }),
    });

    yield* syncIn(hostRepoDir, handle);

    if (copyPaths && copyPaths.length > 0) {
      for (const relativePath of copyPaths) {
        const hostPath = join(hostRepoDir, relativePath);
        if (!existsSync(hostPath)) {
          continue;
        }
        const sandboxPath = join(handle.workspacePath, relativePath);
        yield* Effect.tryPromise({
          try: () => handle.copyIn(hostPath, sandboxPath),
          catch: (e) =>
            new WorktreeError({
              message: `Failed to copy ${relativePath} into sandbox: ${e instanceof Error ? e.message : String(e)}`,
            }),
        });
      }
    }

    return {
      handle,
      sandboxLayer: makeSandboxLayerFromHandle(handle),
      workspacePath: handle.workspacePath,
    };
  });

/** Shared acquire result type for the worktree-mode acquireUseRelease. */
interface AcquireResult {
  worktreeInfo: WorktreeManager.WorktreeInfo;
  handle: BindMountSandboxHandle;
  sandboxLayer: Layer.Layer<Sandbox>;
}

export const WorktreeDockerSandboxFactory = {
  layer: Layer.effect(
    SandboxFactory,
    Effect.gen(function* () {
      const {
        env,
        hostRepoDir,
        worktree: worktreeMode,
        copyToSandbox: copyPaths,
        name,
        sandboxProvider,
      } = yield* WorktreeSandboxConfig;
      const isNoneMode = worktreeMode?.mode === "none";
      const branch =
        worktreeMode?.mode === "branch" ? worktreeMode.branch : undefined;
      const fileSystem = yield* FileSystem.FileSystem;
      const display = yield* Display;
      return {
        withSandbox: <A, E, R>(
          makeEffect: (info: SandboxInfo) => Effect.Effect<A, E, R | Sandbox>,
        ): Effect.Effect<
          WithSandboxResult<A>,
          E | DockerError | WorktreeError | SyncError,
          Exclude<R, Sandbox>
        > => {
          // Isolated providers: skip worktree, sync via git bundle
          if (sandboxProvider.tag === "isolated") {
            return Effect.acquireUseRelease(
              startIsolatedProviderSandbox(
                sandboxProvider,
                hostRepoDir,
                env,
                copyPaths,
              ),
              // Use
              ({ sandboxLayer }) =>
                makeEffect({}).pipe(
                  Effect.provide(sandboxLayer),
                ) as Effect.Effect<A, E | DockerError, Exclude<R, Sandbox>>,
              // Release: sync commits back to host, then close
              ({ handle }) =>
                syncOut(hostRepoDir, handle).pipe(
                  Effect.catchAll((e) =>
                    Effect.sync(() => {
                      console.error(
                        `[sandcastle] Warning: syncOut failed: ${e.message}`,
                      );
                    }),
                  ),
                  Effect.andThen(
                    Effect.tryPromise({
                      try: () => handle.close(),
                      catch: () => undefined,
                    }),
                  ),
                  Effect.orDie,
                ),
            ).pipe(
              Effect.map((value) => ({
                value,
                preservedWorktreePath: undefined,
              })),
            );
          }

          if (isNoneMode) {
            // None mode: bind-mount host directory directly, no worktree
            const gitPath = join(hostRepoDir, ".git");
            return resolveGitMounts(gitPath).pipe(
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.mapError(
                (e) =>
                  new WorktreeError({
                    message: `Failed to resolve git mounts: ${e}`,
                  }) as E | DockerError | WorktreeError,
              ),
              Effect.flatMap((gitMounts) =>
                Effect.acquireUseRelease(
                  startProviderSandbox(
                    sandboxProvider,
                    hostRepoDir,
                    hostRepoDir,
                    env,
                    gitMounts,
                    SANDBOX_WORKSPACE_DIR,
                  ),
                  // Use
                  ({ sandboxLayer }) =>
                    makeEffect({}).pipe(
                      Effect.provide(sandboxLayer),
                    ) as Effect.Effect<A, E | DockerError, Exclude<R, Sandbox>>,
                  // Release
                  ({ handle }) =>
                    Effect.tryPromise({
                      try: () => handle.close(),
                      catch: () => undefined,
                    }).pipe(Effect.orDie),
                ).pipe(
                  Effect.map((value) => ({
                    value,
                    preservedWorktreePath: undefined,
                  })),
                ),
              ),
            );
          }

          // Worktree mode (temp-branch or explicit branch)
          // Populated by the release phase when a worktree is preserved on failure,
          // so we can attach the path to recognized error types before they propagate.
          let preservedWorktreePath: string | undefined;

          return Effect.acquireUseRelease(
            // Acquire: prune stale worktrees (best-effort), create worktree, then start sandbox
            WorktreeManager.pruneStale(hostRepoDir)
              .pipe(
                Effect.catchAll((e) =>
                  Effect.sync(() => {
                    console.error(
                      "[sandcastle] Warning: failed to prune stale worktrees:",
                      e.message,
                    );
                  }),
                ),
              )
              .pipe(
                Effect.andThen(
                  branch
                    ? WorktreeManager.create(hostRepoDir, { branch })
                    : WorktreeManager.create(hostRepoDir, { name }),
                ),
              )
              .pipe(Effect.provideService(FileSystem.FileSystem, fileSystem))
              .pipe(
                Effect.flatMap((worktreeInfo) =>
                  (copyPaths && copyPaths.length > 0
                    ? display.spinner(
                        "Copying to sandbox",
                        copyToSandbox(
                          copyPaths,
                          hostRepoDir,
                          worktreeInfo.path,
                        ),
                      )
                    : Effect.succeed(undefined)
                  ).pipe(Effect.map(() => worktreeInfo)),
                ),
              )
              .pipe(
                Effect.flatMap((worktreeInfo) => {
                  const gitPath = join(hostRepoDir, ".git");
                  return resolveGitMounts(gitPath).pipe(
                    Effect.provideService(FileSystem.FileSystem, fileSystem),
                    Effect.mapError(
                      (e) =>
                        new WorktreeError({
                          message: `Failed to resolve git mounts: ${e}`,
                        }),
                    ),
                    Effect.flatMap(
                      (
                        gitMounts,
                      ): Effect.Effect<
                        AcquireResult,
                        DockerError | WorktreeError,
                        never
                      > =>
                        // sandboxProvider is guaranteed bind-mount here
                        // (isolated providers return early above)
                        startProviderSandbox(
                          sandboxProvider as BindMountSandboxProvider,
                          worktreeInfo.path,
                          hostRepoDir,
                          env,
                          gitMounts,
                          SANDBOX_WORKSPACE_DIR,
                        ).pipe(
                          Effect.map(({ handle, sandboxLayer }) => ({
                            worktreeInfo,
                            handle,
                            sandboxLayer,
                          })),
                        ),
                    ),
                  );
                }),
              ),
            // Use
            ({ worktreeInfo, sandboxLayer }) =>
              makeEffect({ hostWorktreePath: worktreeInfo.path }).pipe(
                Effect.provide(sandboxLayer),
              ) as Effect.Effect<A, E | DockerError, Exclude<R, Sandbox>>,
            // Release: close provider handle, then remove/preserve worktree based on dirty state.
            ({ worktreeInfo, handle }, exit) =>
              Effect.tryPromise({
                try: () => handle.close(),
                catch: () => undefined,
              }).pipe(
                Effect.asVoid,
                Effect.andThen(
                  WorktreeManager.hasUncommittedChanges(worktreeInfo.path).pipe(
                    Effect.catchAll(() => Effect.succeed(false)),
                    Effect.flatMap((isDirty) => {
                      if (isDirty) {
                        preservedWorktreePath = worktreeInfo.path;
                        printWorktreePreservedMessage(
                          worktreeInfo.path,
                          Exit.isSuccess(exit)
                            ? `Run succeeded but worktree has uncommitted changes at ${worktreeInfo.path}`
                            : `Worktree preserved at ${worktreeInfo.path}`,
                        );
                        return Effect.void;
                      } else {
                        if (!Exit.isSuccess(exit)) {
                          console.error(
                            `\nWorktree removed (no uncommitted changes)`,
                          );
                        }
                        return WorktreeManager.remove(worktreeInfo.path);
                      }
                    }),
                  ),
                ),
                Effect.orDie,
              ),
          ).pipe(
            Effect.map((value) => ({
              value,
              preservedWorktreePath,
            })),
            // Attach the preserved worktree path to TimeoutError and AgentError so
            // programmatic callers can build on top of the preserved worktree.
            Effect.mapError((e: E | DockerError | WorktreeError) => {
              const path = preservedWorktreePath;
              if (path !== undefined) {
                if (e instanceof TimeoutError) {
                  return new TimeoutError({
                    message: e.message,
                    idleTimeoutSeconds: e.idleTimeoutSeconds,
                    preservedWorktreePath: path,
                  }) as unknown as E | DockerError | WorktreeError;
                }
                if (e instanceof AgentError) {
                  return new AgentError({
                    message: e.message,
                    preservedWorktreePath: path,
                  }) as unknown as E | DockerError | WorktreeError;
                }
              }
              return e;
            }),
          );
        },
      };
    }),
  ),
};
