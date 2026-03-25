import { Effect } from "effect";
import type { SandcastleConfig } from "./Config.js";
import { Display } from "./Display.js";
import type { SandboxError } from "./errors.js";
import { Sandbox, type SandboxService } from "./Sandbox.js";
import { execOk, syncIn, syncOut } from "./SyncService.js";

export interface SandboxLifecycleOptions {
  readonly hostRepoDir: string;
  readonly sandboxRepoDir: string;
  readonly hooks?: SandcastleConfig["hooks"];
  readonly branch?: string;
}

export interface SandboxContext {
  readonly sandbox: SandboxService;
  readonly sandboxRepoDir: string;
  readonly baseHead: string;
}

export const withSandboxLifecycle = <A>(
  options: SandboxLifecycleOptions,
  work: (
    ctx: SandboxContext,
  ) => Effect.Effect<A, SandboxError, Sandbox | Display>,
): Effect.Effect<A, SandboxError, Sandbox | Display> =>
  Effect.gen(function* () {
    const sandbox = yield* Sandbox;
    const display = yield* Display;
    const { hostRepoDir, sandboxRepoDir, hooks, branch } = options;

    // onSandboxCreate hooks
    if (hooks?.onSandboxCreate?.length) {
      for (const hook of hooks.onSandboxCreate) {
        yield* display.spinner(hook.command, execOk(sandbox, hook.command));
      }
    }

    // Sync-in
    yield* display.spinner(
      "Setting up sandbox...",
      syncIn(hostRepoDir, sandboxRepoDir, branch ? { branch } : undefined),
    );

    // onSandboxReady hooks
    if (hooks?.onSandboxReady?.length) {
      for (const hook of hooks.onSandboxReady) {
        yield* display.spinner(
          hook.command,
          execOk(sandbox, hook.command, { cwd: sandboxRepoDir }),
        );
      }
    }

    // Record base HEAD
    const baseHead = (yield* execOk(sandbox, "git rev-parse HEAD", {
      cwd: sandboxRepoDir,
    })).stdout.trim();

    // Run the caller's work
    const result = yield* work({ sandbox, sandboxRepoDir, baseHead });

    // Sync-out
    yield* display.spinner(
      "Syncing results...",
      syncOut(
        hostRepoDir,
        sandboxRepoDir,
        baseHead,
        branch ? { branch } : undefined,
      ),
    );

    return result;
  });
