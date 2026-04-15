import { Data } from "effect";

/** Command execution failed in the sandbox */
export class ExecError extends Data.TaggedError("ExecError")<{
  readonly message: string;
  readonly command: string;
}> {}

/** Command execution failed on the host */
export class ExecHostError extends Data.TaggedError("ExecHostError")<{
  readonly message: string;
  readonly command: string;
}> {}

/** File copy between host and sandbox failed */
export class CopyError extends Data.TaggedError("CopyError")<{
  readonly message: string;
}> {}

/** Docker infrastructure operation failed */
export class DockerError extends Data.TaggedError("DockerError")<{
  readonly message: string;
}> {}

/** Podman infrastructure operation failed */
export class PodmanError extends Data.TaggedError("PodmanError")<{
  readonly message: string;
}> {}

/** Git sync-in or sync-out operation failed */
export class SyncError extends Data.TaggedError("SyncError")<{
  readonly message: string;
}> {}

/** Git worktree operation failed */
export class WorktreeError extends Data.TaggedError("WorktreeError")<{
  readonly message: string;
}> {}

/** Prompt resolution or preprocessing failed */
export class PromptError extends Data.TaggedError("PromptError")<{
  readonly message: string;
}> {}

/** Agent invocation failed */
export class AgentError extends Data.TaggedError("AgentError")<{
  readonly message: string;
  /** Host path to the preserved workspace, set when the workspace was kept after failure. */
  readonly preservedWorkspacePath?: string;
}> {}

/** .sandcastle/ config directory missing */
export class ConfigDirError extends Data.TaggedError("ConfigDirError")<{
  readonly message: string;
}> {}

/** Initialization or setup operation failed */
export class InitError extends Data.TaggedError("InitError")<{
  readonly message: string;
}> {}

/** Run exceeded the configured idle timeout */
export class TimeoutError extends Data.TaggedError("TimeoutError")<{
  readonly message: string;
  readonly idleTimeoutSeconds: number;
  /** Host path to the preserved workspace, set when the workspace was kept after failure. */
  readonly preservedWorkspacePath?: string;
}> {}

/** Union of all sandbox-related errors */
export type SandboxError =
  | ExecError
  | ExecHostError
  | CopyError
  | DockerError
  | PodmanError
  | SyncError
  | WorktreeError
  | PromptError
  | AgentError
  | ConfigDirError
  | InitError
  | TimeoutError;
