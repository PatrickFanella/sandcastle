import { Context, Effect, Exit, Layer } from "effect";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { randomUUID } from "node:crypto";
import { execFile, execFileSync, spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import type { PlatformError } from "@effect/platform/Error";
import { createInterface } from "node:readline";
import {
  startContainer,
  removeContainer,
  chownInContainer,
} from "./DockerLifecycle.js";
import {
  AgentError,
  CopyError,
  ExecError,
  TimeoutError,
  WorktreeError,
  type DockerError,
} from "./errors.js";
import * as WorktreeManager from "./WorktreeManager.js";
import { copyToSandbox } from "./CopyToSandbox.js";
import { Display } from "./Display.js";
import type {
  SandboxProvider,
  BindMountSandboxHandle,
} from "./SandboxProvider.js";

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

const makeDockerSandbox = (
  containerName: string,
): Effect.Effect<SandboxService, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return {
      exec: (command, options) =>
        Effect.async((resume) => {
          const args = ["exec"];
          if (options?.cwd) {
            args.push("-w", options.cwd);
          }
          args.push(containerName, "sh", "-c", command);

          execFile(
            "docker",
            args,
            { maxBuffer: 10 * 1024 * 1024 },
            (error, stdout, stderr) => {
              if (error && error.code === undefined) {
                resume(
                  Effect.fail(
                    new ExecError({
                      command,
                      message: `docker exec failed: ${error.message}`,
                    }),
                  ),
                );
              } else {
                resume(
                  Effect.succeed({
                    stdout: stdout.toString(),
                    stderr: stderr.toString(),
                    exitCode:
                      typeof error?.code === "number"
                        ? error.code
                        : (0 as number),
                  }),
                );
              }
            },
          );
        }),

      execStreaming: (command, onStdoutLine, options) =>
        Effect.async((resume) => {
          const args = ["exec"];
          if (options?.cwd) {
            args.push("-w", options.cwd);
          }
          args.push(containerName, "sh", "-c", command);

          const proc = spawn("docker", args, {
            stdio: ["ignore", "pipe", "pipe"],
          });

          const stdoutChunks: string[] = [];
          const stderrChunks: string[] = [];

          const rl = createInterface({ input: proc.stdout! });
          rl.on("line", (line) => {
            stdoutChunks.push(line);
            onStdoutLine(line);
          });

          proc.stderr!.on("data", (chunk: Buffer) => {
            stderrChunks.push(chunk.toString());
          });

          proc.on("error", (error) => {
            resume(
              Effect.fail(
                new ExecError({
                  command,
                  message: `docker exec streaming failed: ${error.message}`,
                }),
              ),
            );
          });

          proc.on("close", (code) => {
            resume(
              Effect.succeed({
                stdout: stdoutChunks.join("\n"),
                stderr: stderrChunks.join(""),
                exitCode: code ?? 0,
              }),
            );
          });
        }),

      copyIn: (hostPath, sandboxPath) =>
        Effect.gen(function* () {
          const parentDir = dirname(sandboxPath);
          yield* Effect.async<void, CopyError>((resume) => {
            execFile(
              "docker",
              ["exec", containerName, "mkdir", "-p", parentDir],
              (error) => {
                if (error) {
                  resume(
                    Effect.fail(
                      new CopyError({
                        message: `Failed to create dir ${parentDir}: ${error.message}`,
                      }),
                    ),
                  );
                } else {
                  resume(Effect.succeed(undefined));
                }
              },
            );
          });

          yield* Effect.async<void, CopyError>((resume) => {
            execFile(
              "docker",
              ["cp", hostPath, `${containerName}:${sandboxPath}`],
              (error) => {
                if (error) {
                  resume(
                    Effect.fail(
                      new CopyError({
                        message: `Failed to copy ${hostPath} -> ${containerName}:${sandboxPath}: ${error.message}`,
                      }),
                    ),
                  );
                } else {
                  resume(Effect.succeed(undefined));
                }
              },
            );
          });
        }),

      copyOut: (sandboxPath, hostPath) =>
        Effect.gen(function* () {
          yield* fs.makeDirectory(dirname(hostPath), { recursive: true }).pipe(
            Effect.mapError(
              (error) =>
                new CopyError({
                  message: `Failed to create host dir ${dirname(hostPath)}: ${error}`,
                }),
            ),
          );

          yield* Effect.async<void, CopyError>((resume) => {
            execFile(
              "docker",
              ["cp", `${containerName}:${sandboxPath}`, hostPath],
              (error) => {
                if (error) {
                  resume(
                    Effect.fail(
                      new CopyError({
                        message: `Failed to copy ${containerName}:${sandboxPath} -> ${hostPath}: ${error.message}`,
                      }),
                    ),
                  );
                } else {
                  resume(Effect.succeed(undefined));
                }
              },
            );
          });
        }),
    };
  });

export const makeDockerSandboxLayer = (
  containerName: string,
): Layer.Layer<Sandbox> =>
  Layer.effect(Sandbox, makeDockerSandbox(containerName)).pipe(
    Layer.provide(NodeFileSystem.layer),
  );

/**
 * Wrap a Promise-based BindMountSandboxHandle into an Effect-based SandboxService layer.
 */
export const makeSandboxLayerFromHandle = (
  handle: BindMountSandboxHandle,
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
    copyIn: (hostPath, sandboxPath) =>
      Effect.fail(
        new CopyError({
          message: "copyIn is not supported for bind-mount sandbox providers",
        }),
      ),
    copyOut: (sandboxPath, hostPath) =>
      Effect.fail(
        new CopyError({
          message: "copyOut is not supported for bind-mount sandbox providers",
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
      E | DockerError | WorktreeError,
      Exclude<R, Sandbox>
    >;
  }
>() {}

/**
 * Synchronously force-remove a Docker container.
 * Used in process exit handlers where async operations are not possible.
 */
const forceRemoveContainerSync = (containerName: string): void => {
  try {
    execFileSync("docker", ["rm", "-f", containerName], { stdio: "ignore" });
  } catch {
    // Best-effort — container may already be gone
  }
};

export class WorktreeSandboxConfig extends Context.Tag("WorktreeSandboxConfig")<
  WorktreeSandboxConfig,
  {
    readonly imageName: string;
    readonly env: Record<string, string>;
    readonly hostRepoDir: string;
    /** Worktree mode: none, temp-branch (default), or explicit branch. */
    readonly worktree?: import("./run.js").WorktreeMode;
    /** Paths relative to the host repo root to copy into the worktree before container start. */
    readonly copyToSandbox?: string[];
    /** When specified, the run name is included in the auto-generated branch and worktree names. */
    readonly name?: string;
    /** Optional sandbox provider — when set, delegates container lifecycle to the provider. */
    readonly sandboxProvider?: SandboxProvider;
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
 * Start a Docker container with the given volume mounts and return cleanup helpers.
 * Shared between worktree and none modes.
 */
const startSandboxContainer = (
  containerName: string,
  imageName: string,
  env: Record<string, string>,
  volumeMounts: string[],
) => {
  const cleanupContainerOnly = () => {
    forceRemoveContainerSync(containerName);
  };
  const onSignal = () => {
    cleanupContainerOnly();
    process.exit(1);
  };

  const hostUid = process.getuid?.() ?? 1000;
  const hostGid = process.getgid?.() ?? 1000;

  return startContainer(
    containerName,
    imageName,
    { ...env, HOME: "/home/agent" },
    {
      volumeMounts,
      workdir: SANDBOX_WORKSPACE_DIR,
      user: `${hostUid}:${hostGid}`,
    },
  ).pipe(
    Effect.andThen(
      chownInContainer(containerName, `${hostUid}:${hostGid}`, "/home/agent"),
    ),
    Effect.tap(() =>
      Effect.sync(() => {
        process.on("exit", cleanupContainerOnly);
        process.on("SIGINT", onSignal);
        process.on("SIGTERM", onSignal);
      }),
    ),
    Effect.map(() => ({ cleanupContainerOnly, onSignal })),
  );
};

/**
 * Resolves the git-related volume mounts needed for the Docker container.
 * Handles both normal repos (where .git is a directory) and worktrees
 * (where .git is a file pointing to the parent repo's .git/worktrees/<name>).
 */
export const resolveGitVolumeMounts = (
  gitPath: string,
): Effect.Effect<string[], PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const stat = yield* fs.stat(gitPath);
    if (stat.type === "Directory") {
      return [`${gitPath}:${gitPath}`];
    }
    // Worktree: .git is a file with "gitdir: <path>"
    const content = (yield* fs.readFileString(gitPath)).trim();
    const match = content.match(/^gitdir:\s*(.+)$/);
    if (!match) {
      // Unrecognized format — fall back to mounting the file as-is
      return [`${gitPath}:${gitPath}`];
    }
    const gitdirPath = match[1]!;
    // gitdirPath is like /path/to/repo/.git/worktrees/<name>
    // Mount both the .git file and the parent .git directory
    const parentGitDir = resolve(gitdirPath, "..", "..");
    return [`${gitPath}:${gitPath}`, `${parentGitDir}:${parentGitDir}`];
  });

/**
 * Convert git mount strings ("host:container") into the provider's mounts format.
 */
const gitMountsToProviderMounts = (
  gitMountStrings: string[],
): Array<{ hostPath: string; sandboxPath: string; readonly?: boolean }> =>
  gitMountStrings.map((m) => {
    const [hostPath, sandboxPath] = m.split(":");
    return { hostPath: hostPath!, sandboxPath: sandboxPath! };
  });

/**
 * Start a sandbox using the provider abstraction.
 * Returns the handle, sandbox layer, and workspace path.
 */
const startProviderSandbox = (
  provider: SandboxProvider,
  worktreeOrRepoPath: string,
  hostRepoDir: string,
  env: Record<string, string>,
  gitMountStrings: string[],
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
        ...gitMountsToProviderMounts(gitMountStrings),
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

/** Shared acquire result type for the worktree-mode acquireUseRelease. */
interface AcquireResult {
  worktreeInfo: WorktreeManager.WorktreeInfo;
  handle: BindMountSandboxHandle | undefined;
  sandboxLayer: Layer.Layer<Sandbox> | undefined;
  cleanupContainerOnly: () => void;
  onSignal: () => void;
}

export const WorktreeDockerSandboxFactory = {
  layer: Layer.effect(
    SandboxFactory,
    Effect.gen(function* () {
      const {
        imageName,
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
          E | DockerError | WorktreeError,
          Exclude<R, Sandbox>
        > => {
          const containerName = `sandcastle-${randomUUID()}`;

          if (isNoneMode) {
            // None mode: bind-mount host directory directly, no worktree
            const gitPath = join(hostRepoDir, ".git");
            return resolveGitVolumeMounts(gitPath).pipe(
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.mapError(
                (e) =>
                  new WorktreeError({
                    message: `Failed to resolve git mounts: ${e}`,
                  }) as E | DockerError | WorktreeError,
              ),
              Effect.flatMap((gitMounts) => {
                if (sandboxProvider) {
                  // Provider mode: delegate to the sandbox provider
                  return Effect.acquireUseRelease(
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
                      ) as Effect.Effect<
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
                      preservedWorktreePath: undefined,
                    })),
                  );
                }

                // Legacy Docker mode
                const volumeMounts = [
                  `${hostRepoDir}:${SANDBOX_WORKSPACE_DIR}`,
                  ...gitMounts,
                ];
                return Effect.acquireUseRelease(
                  startSandboxContainer(
                    containerName,
                    imageName,
                    env,
                    volumeMounts,
                  ),
                  // Use
                  () =>
                    makeEffect({}).pipe(
                      Effect.provide(makeDockerSandboxLayer(containerName)),
                    ) as Effect.Effect<A, E | DockerError, Exclude<R, Sandbox>>,
                  // Release: remove container only (no worktree to clean up)
                  ({ cleanupContainerOnly, onSignal }) =>
                    Effect.sync(() => {
                      process.removeListener("exit", cleanupContainerOnly);
                      process.removeListener("SIGINT", onSignal);
                      process.removeListener("SIGTERM", onSignal);
                    }).pipe(
                      Effect.andThen(removeContainer(containerName)),
                      Effect.orDie,
                    ),
                ).pipe(
                  Effect.map((value) => ({
                    value,
                    preservedWorktreePath: undefined,
                  })),
                );
              }),
            );
          }

          // Worktree mode (temp-branch or explicit branch)
          // Populated by the release phase when a worktree is preserved on failure,
          // so we can attach the path to recognized error types before they propagate.
          let preservedWorktreePath: string | undefined;

          return Effect.acquireUseRelease(
            // Acquire: prune stale worktrees (best-effort), create worktree, then start container
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
                  return resolveGitVolumeMounts(gitPath).pipe(
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
                      > => {
                        if (sandboxProvider) {
                          // Provider mode: delegate to the sandbox provider
                          return startProviderSandbox(
                            sandboxProvider,
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
                              cleanupContainerOnly: () => {},
                              onSignal: () => {},
                            })),
                          );
                        }

                        // Legacy Docker mode
                        const volumeMounts = [
                          `${worktreeInfo.path}:${SANDBOX_WORKSPACE_DIR}`,
                          ...gitMounts,
                        ];

                        return startSandboxContainer(
                          containerName,
                          imageName,
                          env,
                          volumeMounts,
                        ).pipe(
                          Effect.tap(({ cleanupContainerOnly, onSignal }) =>
                            Effect.sync(() => {
                              // Override the default signal handler to also preserve the worktree
                              process.removeListener("SIGINT", onSignal);
                              process.removeListener("SIGTERM", onSignal);
                              const onSignalWithWorktree = () => {
                                cleanupContainerOnly();
                                printWorktreePreservedMessage(
                                  worktreeInfo.path,
                                  `Worktree preserved at ${worktreeInfo.path}`,
                                );
                                process.exit(1);
                              };
                              process.on("SIGINT", onSignalWithWorktree);
                              process.on("SIGTERM", onSignalWithWorktree);
                            }),
                          ),
                          Effect.map(({ cleanupContainerOnly, onSignal }) => ({
                            worktreeInfo,
                            handle: undefined,
                            sandboxLayer: undefined,
                            cleanupContainerOnly,
                            onSignal,
                          })),
                        );
                      },
                    ),
                  );
                }),
              ),
            // Use
            ({ worktreeInfo, sandboxLayer }) =>
              makeEffect({ hostWorktreePath: worktreeInfo.path }).pipe(
                Effect.provide(
                  sandboxLayer ?? makeDockerSandboxLayer(containerName),
                ),
              ) as Effect.Effect<A, E | DockerError, Exclude<R, Sandbox>>,
            // Release: always remove container; remove/preserve worktree based on dirty state.
            ({ worktreeInfo, handle, cleanupContainerOnly, onSignal }, exit) =>
              Effect.sync(() => {
                process.removeListener("exit", cleanupContainerOnly);
                process.removeListener("SIGINT", onSignal);
                process.removeListener("SIGTERM", onSignal);
              }).pipe(
                Effect.andThen(
                  handle
                    ? Effect.tryPromise({
                        try: () => handle.close(),
                        catch: () => undefined,
                      }).pipe(Effect.asVoid)
                    : removeContainer(containerName),
                ),
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
