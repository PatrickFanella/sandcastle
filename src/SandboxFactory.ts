import { Context, Effect, Exit, Layer } from "effect";
import { FileSystem } from "@effect/platform";
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
import * as WorkspaceManager from "./WorkspaceManager.js";
import { copyToWorkspace } from "./CopyToWorkspace.js";
import { Display } from "./Display.js";
import type {
  SandboxProvider,
  BranchStrategy,
  BindMountSandboxProvider,
  BindMountSandboxHandle,
  IsolatedSandboxHandle,
  NoSandboxHandle,
} from "./SandboxProvider.js";
import { startSandbox } from "./startSandbox.js";
import { syncOut } from "./syncOut.js";

export interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface SandboxService {
  readonly exec: (
    command: string,
    options?: { onLine?: (line: string) => void; cwd?: string; sudo?: boolean },
  ) => Effect.Effect<ExecResult, ExecError>;

  /** Copy a file or directory from the host into the sandbox. */
  readonly copyIn: (
    hostPath: string,
    sandboxPath: string,
  ) => Effect.Effect<void, CopyError>;

  /** Copy a single file from the sandbox to the host. */
  readonly copyFileOut: (
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
 * Works with both bind-mount handles (copyIn/copyFileOut unsupported) and
 * isolated handles (copyIn/copyFileOut delegated to the handle).
 */
export const makeSandboxLayerFromHandle = (
  handle: BindMountSandboxHandle | IsolatedSandboxHandle | NoSandboxHandle,
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
    copyFileOut:
      "copyFileOut" in handle
        ? (sandboxPath, hostPath) =>
            Effect.tryPromise({
              try: () => handle.copyFileOut(sandboxPath, hostPath),
              catch: (e) =>
                new CopyError({
                  message: `copyFileOut failed: ${e instanceof Error ? e.message : String(e)}`,
                }),
            })
        : () =>
            Effect.fail(
              new CopyError({
                message:
                  "copyFileOut is not supported for bind-mount sandbox providers",
              }),
            ),
  });

/** The mount point inside the sandbox where the project worktree is bound. */
export const SANDBOX_WORKSPACE_DIR = "/home/agent/workspace";

export interface SandboxInfo {
  /** Host-side path to the workspace directory (worktree/branch mode only). */
  readonly hostWorkspacePath?: string;
  /** Absolute path to the workspace inside the sandbox, as reported by the provider. */
  readonly sandboxWorkspacePath: string;
  /** Sync changes from the sandbox to the host worktree.
   *  For isolated providers, runs syncOut. For bind-mount providers, this is a no-op. */
  readonly applyToHost: () => Effect.Effect<void, SyncError>;
}

export interface WithSandboxResult<A> {
  readonly value: A;
  /** Host path to the preserved workspace, set when the workspace was left behind due to uncommitted changes. */
  readonly preservedWorkspacePath?: string;
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

export class SandboxConfig extends Context.Tag("SandboxConfig")<
  SandboxConfig,
  {
    readonly env: Record<string, string>;
    readonly hostRepoDir: string;
    /** Paths relative to the host repo root to copy into the worktree before sandbox start. */
    readonly copyToWorkspace?: string[];
    /** When specified, the run name is included in the auto-generated branch and worktree names. */
    readonly name?: string;
    /** Sandbox provider — delegates sandbox lifecycle to the provider. */
    readonly sandboxProvider: SandboxProvider;
    /** Branch strategy — controls how the agent's changes relate to branches. */
    readonly branchStrategy: BranchStrategy;
    /** When false, reuse an existing worktree instead of failing on collision. Default: true. */
    readonly throwOnDuplicateWorktree?: boolean;
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

/**
 * Check for uncommitted changes and either preserve or remove the worktree.
 * Returns the preserved path if preserved, undefined if removed.
 */
const cleanupWorktree = (
  worktreePath: string,
  exit: Exit.Exit<unknown, unknown>,
): Effect.Effect<string | undefined, WorktreeError> =>
  WorkspaceManager.hasUncommittedChanges(worktreePath).pipe(
    Effect.catchAll(() => Effect.succeed(false)),
    Effect.flatMap((isDirty) => {
      if (isDirty) {
        printWorktreePreservedMessage(
          worktreePath,
          Exit.isSuccess(exit)
            ? `Run succeeded but worktree has uncommitted changes at ${worktreePath}`
            : `Worktree preserved at ${worktreePath}`,
        );
        return Effect.succeed(worktreePath as string | undefined);
      }
      if (!Exit.isSuccess(exit)) {
        console.error(`\nWorktree removed (no uncommitted changes)`);
      }
      return WorkspaceManager.remove(worktreePath).pipe(
        Effect.map(() => undefined as string | undefined),
      );
    }),
  );

/**
 * Attach the preserved worktree path to TimeoutError and AgentError so
 * programmatic callers can build on top of the preserved worktree.
 */
const attachPreservedPath = <E>(
  path: string | undefined,
  e: E | DockerError | WorktreeError | SyncError,
): E | DockerError | WorktreeError | SyncError => {
  if (path !== undefined) {
    if (e instanceof TimeoutError) {
      return new TimeoutError({
        message: e.message,
        idleTimeoutSeconds: e.idleTimeoutSeconds,
        preservedWorkspacePath: path,
      }) as unknown as E | DockerError | WorktreeError | SyncError;
    }
    if (e instanceof AgentError) {
      return new AgentError({
        message: e.message,
        preservedWorkspacePath: path,
      }) as unknown as E | DockerError | WorktreeError | SyncError;
    }
  }
  return e;
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

/** Shared acquire result type for the worktree-mode acquireUseRelease. */
interface AcquireResult {
  worktreeInfo: WorkspaceManager.WorktreeInfo;
  handle: BindMountSandboxHandle | IsolatedSandboxHandle;
  sandboxLayer: Layer.Layer<Sandbox>;
  workspacePath: string;
}

export const WorktreeDockerSandboxFactory = {
  layer: Layer.effect(
    SandboxFactory,
    Effect.gen(function* () {
      const {
        env,
        hostRepoDir,
        copyToWorkspace: copyPaths,
        name,
        sandboxProvider,
        branchStrategy,
        throwOnDuplicateWorktree,
      } = yield* SandboxConfig;

      const isHeadMode = branchStrategy.type === "head";
      const branch =
        branchStrategy.type === "branch" ? branchStrategy.branch : undefined;
      const fileSystem = yield* FileSystem.FileSystem;
      const display = yield* Display;

      /** Prune stale worktrees (best-effort), then create a fresh one. */
      const pruneAndCreate = () =>
        WorkspaceManager.pruneStale(hostRepoDir).pipe(
          Effect.catchAll((e) =>
            Effect.sync(() => {
              console.error(
                "[sandcastle] Warning: failed to prune stale worktrees:",
                e.message,
              );
            }),
          ),
          Effect.andThen(
            branch
              ? WorkspaceManager.create(hostRepoDir, {
                  branch,
                  throwOnDuplicateWorktree,
                })
              : WorkspaceManager.create(hostRepoDir, { name }),
          ),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
        );

      return {
        withSandbox: <A, E, R>(
          makeEffect: (info: SandboxInfo) => Effect.Effect<A, E, R | Sandbox>,
        ): Effect.Effect<
          WithSandboxResult<A>,
          E | DockerError | WorktreeError | SyncError,
          Exclude<R, Sandbox>
        > => {
          // Isolated providers: create worktree, sync via git bundle
          if (sandboxProvider.tag === "isolated") {
            let preservedPath: string | undefined;

            return Effect.acquireUseRelease(
              // Acquire: prune stale worktrees, create worktree, then start sandbox
              pruneAndCreate().pipe(
                Effect.flatMap((worktreeInfo) =>
                  startSandbox({
                    provider: sandboxProvider,
                    hostRepoDir: worktreeInfo.path,
                    env,
                    copyPaths,
                  }).pipe(
                    Effect.map(({ handle, sandboxLayer, workspacePath }) => ({
                      worktreeInfo,
                      handle,
                      sandboxLayer,
                      workspacePath,
                    })),
                  ),
                ),
              ),
              // Use
              ({ worktreeInfo, sandboxLayer, workspacePath, handle }) =>
                makeEffect({
                  hostWorkspacePath: worktreeInfo.path,
                  sandboxWorkspacePath: workspacePath,
                  applyToHost: () =>
                    syncOut(worktreeInfo.path, handle as IsolatedSandboxHandle),
                }).pipe(Effect.provide(sandboxLayer)) as Effect.Effect<
                  A,
                  E | DockerError | SyncError,
                  Exclude<R, Sandbox>
                >,
              // Release: close handle, then cleanup worktree
              ({ worktreeInfo, handle }, exit) =>
                Effect.tryPromise({
                  try: () => handle.close(),
                  catch: () => undefined,
                }).pipe(
                  Effect.andThen(cleanupWorktree(worktreeInfo.path, exit)),
                  Effect.tap((p) => {
                    preservedPath = p;
                  }),
                  Effect.asVoid,
                  Effect.orDie,
                ),
            ).pipe(
              Effect.map((value) => ({
                value,
                preservedWorkspacePath: preservedPath,
              })),
              Effect.mapError(
                (e: E | DockerError | WorktreeError | SyncError) =>
                  attachPreservedPath(preservedPath, e),
              ),
            );
          }

          if (isHeadMode) {
            // Head mode: bind-mount host directory directly, no worktree
            const gitPath = join(hostRepoDir, ".git");
            return resolveGitMounts(gitPath).pipe(
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.mapError(
                (e) =>
                  new WorktreeError({
                    message: `Failed to resolve git mounts: ${e}`,
                  }) as E | DockerError | WorktreeError | SyncError,
              ),
              Effect.flatMap((gitMounts) =>
                Effect.acquireUseRelease(
                  startSandbox({
                    provider: sandboxProvider,
                    hostRepoDir,
                    env,
                    worktreeOrRepoPath: hostRepoDir,
                    gitMounts,
                    workspaceDir: SANDBOX_WORKSPACE_DIR,
                  }),
                  // Use
                  ({ sandboxLayer, workspacePath }) =>
                    makeEffect({
                      hostWorkspacePath: hostRepoDir,
                      sandboxWorkspacePath: workspacePath,
                      applyToHost: () => Effect.void,
                    }).pipe(Effect.provide(sandboxLayer)) as Effect.Effect<
                      A,
                      E | DockerError,
                      Exclude<R, Sandbox>
                    >,
                  // Release
                  ({ handle }) =>
                    Effect.tryPromise({
                      try: () => handle.close(),
                      catch: () => undefined,
                    }).pipe(Effect.orDie),
                ).pipe(
                  Effect.map((value) => ({
                    value,
                    preservedWorkspacePath: undefined,
                  })),
                ),
              ),
            );
          }

          // Worktree mode (merge-to-head or explicit branch)
          // Populated by the release phase when a worktree is preserved on failure,
          // so we can attach the path to recognized error types before they propagate.
          let preservedWorkspacePath: string | undefined;

          return Effect.acquireUseRelease(
            // Acquire: prune stale worktrees (best-effort), create worktree, then start sandbox
            pruneAndCreate().pipe(
              Effect.flatMap((worktreeInfo) =>
                (copyPaths && copyPaths.length > 0
                  ? display.spinner(
                      "Copying to workspace",
                      copyToWorkspace(
                        copyPaths,
                        hostRepoDir,
                        worktreeInfo.path,
                      ),
                    )
                  : Effect.succeed(undefined)
                ).pipe(Effect.map(() => worktreeInfo)),
              ),
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
                      DockerError | WorktreeError | SyncError,
                      never
                    > =>
                      // sandboxProvider is guaranteed bind-mount here
                      // (isolated providers return early above)
                      startSandbox({
                        provider: sandboxProvider as BindMountSandboxProvider,
                        hostRepoDir,
                        env,
                        worktreeOrRepoPath: worktreeInfo.path,
                        gitMounts,
                        workspaceDir: SANDBOX_WORKSPACE_DIR,
                      }).pipe(
                        Effect.map(
                          ({ handle, sandboxLayer, workspacePath }) => ({
                            worktreeInfo,
                            handle,
                            sandboxLayer,
                            workspacePath,
                          }),
                        ),
                      ),
                  ),
                );
              }),
            ),
            // Use
            ({ worktreeInfo, sandboxLayer, workspacePath }) =>
              makeEffect({
                hostWorkspacePath: worktreeInfo.path,
                sandboxWorkspacePath: workspacePath,
                applyToHost: () => Effect.void,
              }).pipe(Effect.provide(sandboxLayer)) as Effect.Effect<
                A,
                E | DockerError,
                Exclude<R, Sandbox>
              >,
            // Release: close provider handle, then remove/preserve worktree based on dirty state.
            ({ worktreeInfo, handle }, exit) =>
              Effect.tryPromise({
                try: () => handle.close(),
                catch: () => undefined,
              }).pipe(
                Effect.andThen(cleanupWorktree(worktreeInfo.path, exit)),
                Effect.tap((p) => {
                  preservedWorkspacePath = p;
                }),
                Effect.asVoid,
                Effect.orDie,
              ),
          ).pipe(
            Effect.map((value) => ({
              value,
              preservedWorkspacePath,
            })),
            Effect.mapError((e: E | DockerError | WorktreeError | SyncError) =>
              attachPreservedPath(preservedWorkspacePath, e),
            ),
          );
        },
      };
    }),
  ),
};
