/**
 * Sandbox provider types — the pluggable interface for sandbox runtimes.
 *
 * Provider authors implement a small Promise-based interface. Sandcastle
 * handles worktree creation, git mount resolution, and commit extraction.
 */

/** Result of executing a command inside a sandbox. */
export interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/** Handle to a running bind-mount sandbox. */
export interface BindMountSandboxHandle {
  /** Absolute path to the workspace inside the sandbox. */
  readonly workspacePath: string;
  /** Execute a command inside the sandbox. */
  exec(command: string, options?: { cwd?: string }): Promise<ExecResult>;
  /** Execute a command, streaming stdout line-by-line. */
  execStreaming(
    command: string,
    onLine: (line: string) => void,
    options?: { cwd?: string },
  ): Promise<ExecResult>;
  /** Tear down the sandbox. */
  close(): Promise<void>;
}

/** Options passed to a bind-mount provider's `create` function. */
export interface BindMountCreateOptions {
  /** Host-side path to the worktree directory. */
  readonly worktreePath: string;
  /** Host-side path to the original repo root. */
  readonly hostRepoPath: string;
  /** Volume mounts to apply (host:sandbox pairs). */
  readonly mounts: Array<{
    hostPath: string;
    sandboxPath: string;
    readonly?: boolean;
  }>;
  /** Environment variables to inject into the sandbox. */
  readonly env: Record<string, string>;
}

/** Configuration for createBindMountSandboxProvider. */
export interface BindMountSandboxProviderConfig {
  /** Human-readable name for this provider (e.g. "docker", "podman"). */
  readonly name: string;
  /** Branch strategy. Defaults to { type: "head" } if omitted. */
  readonly branchStrategy?: BindMountBranchStrategy;
  /** Create a sandbox handle from the given options. */
  readonly create: (
    options: BindMountCreateOptions,
  ) => Promise<BindMountSandboxHandle>;
}

/** Handle to a running isolated sandbox (extends bind-mount with file transfer). */
export interface IsolatedSandboxHandle {
  /** Absolute path to the workspace inside the sandbox. */
  readonly workspacePath: string;
  /** Execute a command inside the sandbox. */
  exec(command: string, options?: { cwd?: string }): Promise<ExecResult>;
  /** Execute a command, streaming stdout line-by-line. */
  execStreaming(
    command: string,
    onLine: (line: string) => void,
    options?: { cwd?: string },
  ): Promise<ExecResult>;
  /** Copy a file from the host into the sandbox. */
  copyIn(hostPath: string, sandboxPath: string): Promise<void>;
  /** Copy a file from the sandbox to the host. */
  copyOut(sandboxPath: string, hostPath: string): Promise<void>;
  /** Tear down the sandbox. */
  close(): Promise<void>;
}

/** Options passed to an isolated provider's `create` function. */
export interface IsolatedCreateOptions {
  /** Environment variables to inject into the sandbox. */
  readonly env: Record<string, string>;
}

/** Configuration for createIsolatedSandboxProvider. */
export interface IsolatedSandboxProviderConfig {
  /** Human-readable name for this provider (e.g. "daytona", "e2b"). */
  readonly name: string;
  /** Branch strategy. Defaults to { type: "merge-to-head" } if omitted. */
  readonly branchStrategy?: IsolatedBranchStrategy;
  /** Create an isolated sandbox handle from the given options. */
  readonly create: (
    options: IsolatedCreateOptions,
  ) => Promise<IsolatedSandboxHandle>;
}

/** A bind-mount sandbox provider. */
export interface BindMountSandboxProvider {
  /** @internal Discriminator for internal dispatch. */
  readonly tag: "bind-mount";
  /** Human-readable provider name. */
  readonly name: string;
  /** Branch strategy — controls how the agent's changes relate to branches. Defaults to head. */
  readonly branchStrategy: BindMountBranchStrategy;
  /** @internal Create a sandbox handle. */
  readonly create: (
    options: BindMountCreateOptions,
  ) => Promise<BindMountSandboxHandle>;
}

/** An isolated sandbox provider. */
export interface IsolatedSandboxProvider {
  /** @internal Discriminator for internal dispatch. */
  readonly tag: "isolated";
  /** Human-readable provider name. */
  readonly name: string;
  /** Branch strategy — controls how the agent's changes relate to branches. Defaults to merge-to-head. */
  readonly branchStrategy: IsolatedBranchStrategy;
  /** @internal Create an isolated sandbox handle. */
  readonly create: (
    options: IsolatedCreateOptions,
  ) => Promise<IsolatedSandboxHandle>;
}

// ---------- Branch strategy types ----------

/** Head strategy: agent writes directly to host working directory. Bind-mount only. */
export interface HeadBranchStrategy {
  readonly type: "head";
}

/** Merge-to-head strategy: temp branch, merge back to HEAD, delete temp branch. */
export interface MergeToHeadBranchStrategy {
  readonly type: "merge-to-head";
}

/** Branch strategy: commits land on an explicit named branch. */
export interface NamedBranchStrategy {
  readonly type: "branch";
  readonly branch: string;
}

/** Branch strategy for bind-mount providers (all three variants). */
export type BindMountBranchStrategy =
  | HeadBranchStrategy
  | MergeToHeadBranchStrategy
  | NamedBranchStrategy;

/** Branch strategy for isolated providers (no head — can't write to host). */
export type IsolatedBranchStrategy =
  | MergeToHeadBranchStrategy
  | NamedBranchStrategy;

/** Union of all branch strategy variants. */
export type BranchStrategy = BindMountBranchStrategy | IsolatedBranchStrategy;

/**
 * A sandbox provider — the pluggable unit that `run()` and `createSandbox()` accept.
 * Tagged for internal dispatch: "bind-mount" or "isolated".
 */
export type SandboxProvider =
  | BindMountSandboxProvider
  | IsolatedSandboxProvider;

/**
 * Create a bind-mount sandbox provider from a config object.
 * The returned provider can be passed to `run()` or `createSandbox()`.
 */
export const createBindMountSandboxProvider = (
  config: BindMountSandboxProviderConfig,
): BindMountSandboxProvider => ({
  tag: "bind-mount",
  name: config.name,
  branchStrategy: config.branchStrategy ?? { type: "head" },
  create: config.create,
});

/**
 * Create an isolated sandbox provider from a config object.
 * The returned provider can be passed to `run()` or `createSandbox()`.
 */
export const createIsolatedSandboxProvider = (
  config: IsolatedSandboxProviderConfig,
): IsolatedSandboxProvider => ({
  tag: "isolated",
  name: config.name,
  branchStrategy: config.branchStrategy ?? { type: "merge-to-head" },
  create: config.create,
});
