import { Effect, Layer } from "effect";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { SyncError, WorktreeError, type DockerError } from "./errors.js";
import type {
  SandboxProvider,
  BindMountSandboxProvider,
  BindMountSandboxHandle,
  IsolatedSandboxProvider,
  IsolatedSandboxHandle,
} from "./SandboxProvider.js";
import {
  type Sandbox,
  type MountEntry,
  makeSandboxLayerFromHandle,
} from "./SandboxFactory.js";
import { syncIn } from "./syncIn.js";

export interface StartSandboxBindMountOptions {
  provider: BindMountSandboxProvider;
  hostRepoDir: string;
  env: Record<string, string>;
  worktreeOrRepoPath: string;
  gitMounts: MountEntry[];
  workspaceDir: string;
  copyPaths?: undefined;
}

export interface StartSandboxIsolatedOptions {
  provider: IsolatedSandboxProvider;
  hostRepoDir: string;
  env: Record<string, string>;
  worktreeOrRepoPath?: undefined;
  gitMounts?: undefined;
  workspaceDir?: undefined;
  copyPaths?: string[];
}

export type StartSandboxOptions =
  | StartSandboxBindMountOptions
  | StartSandboxIsolatedOptions;

export interface StartSandboxResult {
  handle: BindMountSandboxHandle | IsolatedSandboxHandle;
  sandboxLayer: Layer.Layer<Sandbox>;
  workspacePath: string;
}

/**
 * Start a sandbox by dispatching on `provider.tag`.
 *
 * - `"bind-mount"`: creates mounts and delegates to the provider's `create()`.
 * - `"isolated"`: creates handle, syncs host repo via git bundle, then copies
 *   optional `copyPaths` via `handle.copyIn()`.
 *
 * Returns the handle, a `SandboxService` layer, and the workspace path.
 */
export const startSandbox = (
  options: StartSandboxOptions,
): Effect.Effect<
  StartSandboxResult,
  DockerError | WorktreeError | SyncError
> => {
  if (options.provider.tag === "bind-mount") {
    return startBindMountSandbox(options as StartSandboxBindMountOptions);
  }
  return startIsolatedSandbox(options as StartSandboxIsolatedOptions);
};

const startBindMountSandbox = (
  options: StartSandboxBindMountOptions,
): Effect.Effect<StartSandboxResult, DockerError | WorktreeError> =>
  Effect.tryPromise({
    try: () => {
      const mounts = [
        {
          hostPath: options.worktreeOrRepoPath,
          sandboxPath: options.workspaceDir,
        },
        ...options.gitMounts,
      ];
      return options.provider.create({
        workspacePath: options.worktreeOrRepoPath,
        hostRepoPath: options.hostRepoDir,
        mounts,
        env: options.env,
      });
    },
    catch: (e) =>
      new WorktreeError({
        message: `Provider '${options.provider.name}' create failed: ${e instanceof Error ? e.message : String(e)}`,
      }),
  }).pipe(
    Effect.map((handle) => ({
      handle,
      sandboxLayer: makeSandboxLayerFromHandle(handle),
      workspacePath: handle.workspacePath,
    })),
  );

const startIsolatedSandbox = (
  options: StartSandboxIsolatedOptions,
): Effect.Effect<StartSandboxResult, DockerError | WorktreeError | SyncError> =>
  Effect.gen(function* () {
    const handle = yield* Effect.tryPromise({
      try: () => options.provider.create({ env: options.env }),
      catch: (e) =>
        new WorktreeError({
          message: `Isolated provider '${options.provider.name}' setup failed: ${e instanceof Error ? e.message : String(e)}`,
        }),
    });

    yield* syncIn(options.hostRepoDir, handle);

    if (options.copyPaths && options.copyPaths.length > 0) {
      for (const relativePath of options.copyPaths) {
        const hostPath = join(options.hostRepoDir, relativePath);
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
