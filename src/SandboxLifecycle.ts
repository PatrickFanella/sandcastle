import { exec } from "node:child_process";
import { promisify } from "node:util";
import { Effect } from "effect";
import { Display } from "./Display.js";
import {
  CommitCollectionTimeoutError,
  ExecError,
  GitSetupTimeoutError,
  HookTimeoutError,
  MergeToHostTimeoutError,
  SyncError,
  withTimeout,
  type SandboxError,
} from "./errors.js";
import {
  Sandbox,
  type ExecResult,
  type SandboxService,
} from "./SandboxFactory.js";

const GIT_SETUP_TIMEOUT_MS = 10_000;
const HOOK_TIMEOUT_MS = 60_000;
const COMMIT_COLLECTION_TIMEOUT_MS = 30_000;
const MERGE_TO_HOST_TIMEOUT_MS = 30_000;

const execOk = (
  sandbox: SandboxService,
  command: string,
  options?: { cwd?: string; sudo?: boolean },
): Effect.Effect<ExecResult, ExecError> =>
  Effect.flatMap(sandbox.exec(command, options), (result) =>
    result.exitCode !== 0
      ? Effect.fail(
          new ExecError({
            command,
            message: `Command failed (exit ${result.exitCode}): ${command}\n${result.stderr}`,
          }),
        )
      : Effect.succeed(result),
  );

const execOkWithGitTimeout = (
  sandbox: SandboxService,
  command: string,
  options?: { cwd?: string },
): Effect.Effect<ExecResult, ExecError | GitSetupTimeoutError> =>
  execOk(sandbox, command, options).pipe(
    withTimeout(
      GIT_SETUP_TIMEOUT_MS,
      () =>
        new GitSetupTimeoutError({
          message: `Git command timed out after ${GIT_SETUP_TIMEOUT_MS}ms: ${command}`,
          timeoutMs: GIT_SETUP_TIMEOUT_MS,
          command,
        }),
    ),
  );

const execAsync = promisify(exec);

export type SandboxHooks = {
  readonly onSandboxReady?: ReadonlyArray<{
    readonly command: string;
    readonly sudo?: boolean;
  }>;
};

export interface SandboxLifecycleOptions {
  readonly hostRepoDir: string;
  readonly sandboxRepoDir: string;
  readonly hooks?: SandboxHooks;
  readonly branch?: string;
  /** Host-side path to the workspace directory. Required when sandboxRepoDir
   *  is a sandbox path that doesn't exist on the host (e.g. /home/agent/workspace). */
  readonly hostWorkspacePath?: string;
  /** Called after agent work completes but before host-side git operations (merge, commit collection).
   *  For isolated providers, this syncs changes from the sandbox to the host worktree.
   *  For bind-mount providers, this is a no-op (filesystem is already shared). */
  readonly applyToHost?: () => Effect.Effect<void, SyncError>;
}

export interface SandboxContext {
  readonly sandbox: SandboxService;
  readonly sandboxRepoDir: string;
  readonly baseHead: string;
}

export interface SandboxLifecycleResult<A> {
  readonly result: A;
  readonly branch: string;
  readonly commits: { sha: string }[];
}

export const withSandboxLifecycle = <A>(
  options: SandboxLifecycleOptions,
  work: (
    ctx: SandboxContext,
  ) => Effect.Effect<A, SandboxError, Sandbox | Display>,
): Effect.Effect<SandboxLifecycleResult<A>, SandboxError, Sandbox | Display> =>
  Effect.gen(function* () {
    const sandbox = yield* Sandbox;
    const display = yield* Display;
    const { hostRepoDir, sandboxRepoDir, hooks, branch, hostWorkspacePath } =
      options;

    // Without an explicit branch, record host's current branch for cherry-pick
    const hostCurrentBranch: string | null = !branch
      ? yield* Effect.promise(async () => {
          const { stdout } = await execAsync(
            "git rev-parse --abbrev-ref HEAD",
            { cwd: hostRepoDir },
          );
          return stdout.trim();
        })
      : null;

    // Read host git identity before entering the sandbox
    const [hostGitName, hostGitEmail] = yield* Effect.promise(async () => {
      const [nameResult, emailResult] = await Promise.all([
        execAsync("git config user.name", { cwd: hostRepoDir })
          .then((r) => r.stdout.trim())
          .catch(() => ""),
        execAsync("git config user.email", { cwd: hostRepoDir })
          .then((r) => r.stdout.trim())
          .catch(() => ""),
      ]);
      return [nameResult, emailResult] as const;
    });

    // Setup: onSandboxReady hooks
    let resolvedBranch = "";
    yield* display.taskLog("Setting up sandbox", (message) =>
      Effect.gen(function* () {
        // The bind-mounted worktree may be owned by a different UID (host user
        // vs sandbox user). Mark it safe so git doesn't reject it with
        // "dubious ownership".
        yield* execOkWithGitTimeout(
          sandbox,
          `git config --global --add safe.directory "${sandboxRepoDir}"`,
        );

        // Propagate host git identity into the sandbox so commits are attributed
        // to the actual developer without requiring manual setup.
        if (hostGitName) {
          yield* execOkWithGitTimeout(
            sandbox,
            `git config --global user.name "${hostGitName.replace(/"/g, '\\"')}"`,
          );
        }
        if (hostGitEmail) {
          yield* execOkWithGitTimeout(
            sandbox,
            `git config --global user.email "${hostGitEmail.replace(/"/g, '\\"')}"`,
          );
        }

        // Repo is bind-mounted — discover branch directly
        resolvedBranch = (yield* execOkWithGitTimeout(
          sandbox,
          "git rev-parse --abbrev-ref HEAD",
          { cwd: sandboxRepoDir },
        )).stdout.trim();

        if (hooks?.onSandboxReady?.length) {
          for (const hook of hooks.onSandboxReady) {
            message(hook.command);
          }
          yield* Effect.all(
            hooks.onSandboxReady.map((hook) =>
              execOk(sandbox, hook.command, {
                cwd: sandboxRepoDir,
                sudo: hook.sudo,
              }).pipe(
                withTimeout(
                  HOOK_TIMEOUT_MS,
                  () =>
                    new HookTimeoutError({
                      message: `Hook '${hook.command}' timed out after ${HOOK_TIMEOUT_MS}ms`,
                      timeoutMs: HOOK_TIMEOUT_MS,
                      command: hook.command,
                    }),
                ),
              ),
            ),
            { concurrency: "unbounded" },
          );
        }
      }),
    );

    const targetBranch = branch ?? resolvedBranch;

    // For host-side git operations in worktree mode, use hostWorkspacePath
    // (the real path on the host) instead of sandboxRepoDir (which may be a sandbox path
    // like /home/agent/workspace that doesn't exist on the host).
    const hostSideWorktreePath = hostWorkspacePath ?? sandboxRepoDir;

    // Record base HEAD from the host worktree (not the sandbox).
    // For bind-mount providers, these are the same. For isolated providers,
    // the host-side SHA is the correct baseline for git rev-list after applyToHost
    // syncs commits back (syncOut creates new SHAs via format-patch/am).
    const baseHead = yield* Effect.promise(async () => {
      const { stdout } = await execAsync("git rev-parse HEAD", {
        cwd: hostSideWorktreePath,
      });
      return stdout.trim();
    });

    // Run the caller's work
    const result = yield* work({ sandbox, sandboxRepoDir, baseHead });

    // Sync changes from sandbox to host worktree (no-op for bind-mount providers)
    if (options.applyToHost) {
      yield* display.taskLog("Syncing changes to host", () =>
        options.applyToHost!(),
      );
    }

    // Collect commits and handle cherry-pick for temp branches
    let commits: { sha: string }[];
    let finalBranch: string;

    if (hostCurrentBranch !== null) {
      // Temp branch mode: merge temp branch into host branch, then delete temp branch.
      // We use merge instead of cherry-pick because cherry-pick breaks when the
      // temp branch contains merge commits (e.g. a merge agent merging multiple parallel
      // branches). A regular merge handles both the fast-forward case (host branch hasn't
      // moved) and the diverged case (host branch has new commits since the worktree started).

      // Check if there are any new commits on the temp branch
      const hasNewCommits = yield* Effect.promise(async () => {
        try {
          const { stdout } = await execAsync(
            `git rev-list "${baseHead}..HEAD" --count`,
            { cwd: hostSideWorktreePath },
          );
          return parseInt(stdout.trim(), 10) > 0;
        } catch {
          return false;
        }
      });

      // Detach the worktree from the temp branch so the branch can be deleted
      yield* execOk(sandbox, "git checkout --detach", { cwd: sandboxRepoDir });

      if (hasNewCommits) {
        // Fast-forward host's current branch to the temp branch
        yield* display.taskLog(`Merging to ${hostCurrentBranch}`, () =>
          Effect.tryPromise({
            try: async () => {
              try {
                await execAsync(`git merge "${resolvedBranch}"`, {
                  cwd: hostRepoDir,
                });
              } catch {
                throw new Error(
                  `Merge of '${resolvedBranch}' onto '${hostCurrentBranch}' failed. ` +
                    `The temporary branch '${resolvedBranch}' has been preserved. ` +
                    `To retry: git merge ${resolvedBranch}, ` +
                    `then clean up: git branch -D ${resolvedBranch}`,
                );
              }
            },
            catch: (e) =>
              new SyncError({
                message: String(e instanceof Error ? e.message : e),
              }),
          }).pipe(
            withTimeout(
              MERGE_TO_HOST_TIMEOUT_MS,
              () =>
                new MergeToHostTimeoutError({
                  message: `Merge of '${resolvedBranch}' to '${hostCurrentBranch}' timed out after ${MERGE_TO_HOST_TIMEOUT_MS}ms`,
                  timeoutMs: MERGE_TO_HOST_TIMEOUT_MS,
                  sourceBranch: resolvedBranch,
                  targetBranch: hostCurrentBranch,
                }),
            ),
          ),
        );
      }

      // Delete the temp branch (now merged into host branch)
      yield* Effect.promise(() =>
        execAsync(`git branch -D "${resolvedBranch}"`, {
          cwd: hostRepoDir,
        }).catch(() => {}),
      );

      // Collect the commits now on the host branch
      commits = yield* display.taskLog("Collecting commits", () =>
        Effect.promise(async () => {
          try {
            const { stdout } = await execAsync(
              `git rev-list "${baseHead}..HEAD" --reverse`,
              { cwd: hostRepoDir },
            );
            const lines = stdout.trim();
            if (!lines) return [];
            return lines.split("\n").map((sha) => ({ sha }));
          } catch {
            return [];
          }
        }).pipe(
          withTimeout(
            COMMIT_COLLECTION_TIMEOUT_MS,
            () =>
              new CommitCollectionTimeoutError({
                message: `Commit collection timed out after ${COMMIT_COLLECTION_TIMEOUT_MS}ms`,
                timeoutMs: COMMIT_COLLECTION_TIMEOUT_MS,
              }),
          ),
        ),
      );

      finalBranch = hostCurrentBranch;
    } else {
      // Explicit branch: commits stay on that branch
      commits = yield* display.taskLog("Collecting commits", () =>
        Effect.promise(async () => {
          try {
            const { stdout } = await execAsync(
              `git rev-list "${baseHead}..refs/heads/${targetBranch}" --reverse`,
              { cwd: hostRepoDir },
            );
            const lines = stdout.trim();
            if (!lines) return [];
            return lines.split("\n").map((sha) => ({ sha }));
          } catch {
            // Branch doesn't exist on host (no commits were produced)
            return [];
          }
        }).pipe(
          withTimeout(
            COMMIT_COLLECTION_TIMEOUT_MS,
            () =>
              new CommitCollectionTimeoutError({
                message: `Commit collection timed out after ${COMMIT_COLLECTION_TIMEOUT_MS}ms`,
                timeoutMs: COMMIT_COLLECTION_TIMEOUT_MS,
              }),
          ),
        ),
      );

      finalBranch = targetBranch;
    }

    return { result, branch: finalBranch, commits };
  });
