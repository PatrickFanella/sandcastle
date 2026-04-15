import { NodeContext, NodeFileSystem } from "@effect/platform-node";
import { join } from "node:path";
import * as clack from "@clack/prompts";
import { Effect } from "effect";
import type { AgentProvider } from "./AgentProvider.js";
import { ClackDisplay, Display } from "./Display.js";
import { preprocessPrompt } from "./PromptPreprocessor.js";
import { resolvePrompt } from "./PromptResolver.js";
import {
  makeSandboxLayerFromHandle,
  resolveGitMounts,
  SANDBOX_WORKSPACE_DIR,
} from "./SandboxFactory.js";
import { withSandboxLifecycle, type SandboxHooks } from "./SandboxLifecycle.js";
import type {
  AnySandboxProvider,
  BranchStrategy,
  BindMountSandboxHandle,
  IsolatedSandboxHandle,
  NoSandboxHandle,
} from "./SandboxProvider.js";
import { resolveEnv } from "./EnvResolver.js";
import { mergeProviderEnv } from "./mergeProviderEnv.js";
import { copyToWorkspace } from "./CopyToWorkspace.js";
import { startSandbox } from "./startSandbox.js";
import { syncOut } from "./syncOut.js";
import * as WorkspaceManager from "./WorkspaceManager.js";
import {
  generateTempBranchName,
  getCurrentBranch,
} from "./WorkspaceManager.js";
import {
  type PromptArgs,
  substitutePromptArgs,
  validateNoBuiltInArgOverride,
  findMissingPromptArgKeys,
  BUILT_IN_PROMPT_ARG_KEYS,
} from "./PromptArgumentSubstitution.js";
import { noSandbox } from "./sandboxes/no-sandbox.js";

export interface InteractiveOptions {
  /** Agent provider to use (e.g. claudeCode("claude-opus-4-6")) */
  readonly agent: AgentProvider;
  /** Sandbox provider (e.g. docker(), noSandbox()). */
  readonly sandbox?: AnySandboxProvider;
  /** Inline prompt string (mutually exclusive with promptFile). */
  readonly prompt?: string;
  /** Path to a prompt file (mutually exclusive with prompt). */
  readonly promptFile?: string;
  /** Optional name for the interactive session. */
  readonly name?: string;
  /** Branch strategy — controls how the agent's changes relate to branches.
   * Defaults to { type: "head" } for bind-mount providers and { type: "merge-to-head" } for isolated providers. */
  readonly branchStrategy?: BranchStrategy;
  /** Hooks to run during sandbox lifecycle */
  readonly hooks?: SandboxHooks;
  /** Paths relative to the host repo root to copy into the worktree before sandbox start. */
  readonly copyToWorkspace?: string[];
  /** Key-value map for {{KEY}} placeholder substitution in prompts */
  readonly promptArgs?: PromptArgs;
  /** Environment variables to inject into the sandbox. */
  readonly env?: Record<string, string>;
}

export interface InteractiveResult {
  /** List of commits made during the interactive session. */
  readonly commits: { sha: string }[];
  /** The branch name the agent worked on. */
  readonly branch: string;
  /** Host path to the preserved workspace, if workspace had uncommitted changes. */
  readonly preservedWorkspacePath?: string;
  /** Exit code of the interactive process. */
  readonly exitCode: number;
}

/**
 * Launch an interactive agent session inside a sandbox.
 *
 * The user sees the agent's TUI directly. When the session ends,
 * Sandcastle collects commits and handles branch merging, just like run().
 *
 * Full prompt preprocessing pipeline: PromptResolver -> PromptArgumentSubstitution
 * -> PromptPreprocessor (shell expressions inside sandbox).
 *
 * All three branch strategies are supported: head, merge-to-head, branch.
 */
export const interactive = async (
  options: InteractiveOptions,
): Promise<InteractiveResult> => {
  const { prompt, promptFile, hooks, agent: provider } = options;

  const resolvedSandbox = options.sandbox ?? noSandbox();

  // Derive branch strategy
  const branchStrategy: BranchStrategy =
    options.branchStrategy ??
    (resolvedSandbox.tag === "isolated"
      ? { type: "merge-to-head" }
      : { type: "head" }); // "bind-mount" and "none" both default to head

  // Validate: head strategy is not supported with isolated providers
  if (branchStrategy.type === "head" && resolvedSandbox.tag === "isolated") {
    throw new Error(
      "head branch strategy is not supported with isolated providers",
    );
  }

  // Validate: copyToWorkspace is incompatible with head strategy
  if (
    branchStrategy.type === "head" &&
    options.copyToWorkspace &&
    options.copyToWorkspace.length > 0
  ) {
    throw new Error(
      "copyToWorkspace is not supported with head branch strategy. " +
        "In head mode the host working directory is bind-mounted directly.",
    );
  }

  // Validate buildInteractiveArgs is available
  if (!provider.buildInteractiveArgs) {
    throw new Error(
      `Agent provider "${provider.name}" does not support buildInteractiveArgs, required for interactive sessions.`,
    );
  }

  const branch: string | undefined =
    branchStrategy.type === "branch" ? branchStrategy.branch : undefined;

  const hostRepoDir = process.cwd();
  const isHeadMode = branchStrategy.type === "head";
  const sandboxProvider = resolvedSandbox;

  const inner = Effect.gen(function* () {
    const d = yield* Display;

    // 1. Resolve prompt (from string or file), or skip if neither provided
    const hasPromptSource = prompt !== undefined || promptFile !== undefined;
    const rawPrompt = hasPromptSource
      ? yield* resolvePrompt({ prompt, promptFile })
      : "";

    // 2. Resolve env vars
    const resolvedEnv = yield* resolveEnv(hostRepoDir);
    const env = mergeProviderEnv({
      resolvedEnv,
      agentProviderEnv: provider.env,
      sandboxProviderEnv: sandboxProvider.env,
    });
    const effectiveEnv = { ...env, ...(options.env ?? {}) };

    // 3. Capture host's current branch
    const currentHostBranch = yield* getCurrentBranch(hostRepoDir);

    const resolvedBranch =
      branchStrategy.type === "head"
        ? currentHostBranch
        : (branch ?? generateTempBranchName(options.name));

    // 4. Validate prompt args and collect missing ones interactively (skip when no prompt)
    let substitutedPrompt = rawPrompt;
    if (hasPromptSource) {
      const userArgs = options.promptArgs ?? {};
      yield* validateNoBuiltInArgOverride(userArgs);

      // Scan for missing keys and prompt the user for each one
      const missingKeys = findMissingPromptArgKeys(rawPrompt, userArgs);
      const collectedArgs: Record<string, string> = {};
      for (const key of missingKeys) {
        const value = yield* Effect.promise(() =>
          clack.text({
            message: `Enter value for {{${key}}}`,
            validate: (v) => {
              if (!v) return `A value is required for {{${key}}}`;
            },
          }),
        );
        if (clack.isCancel(value)) {
          clack.cancel("Prompt arg collection cancelled.");
          return yield* Effect.fail(
            new Error("User cancelled prompt arg collection"),
          );
        }
        collectedArgs[key] = value;
      }

      const mergedUserArgs = { ...userArgs, ...collectedArgs };
      const effectiveArgs = {
        SOURCE_BRANCH: resolvedBranch,
        TARGET_BRANCH: currentHostBranch,
        ...mergedUserArgs,
      };
      const builtInArgKeysSet = new Set<string>(BUILT_IN_PROMPT_ARG_KEYS);
      substitutedPrompt = yield* substitutePromptArgs(
        rawPrompt,
        effectiveArgs,
        builtInArgKeysSet,
      );
    }

    // In head mode, pass the host branch so SandboxLifecycle skips the merge step.
    const lifecycleBranch = isHeadMode ? currentHostBranch : branch;

    // Display intro and summary
    yield* d.intro(options.name ?? "sandcastle interactive");
    yield* d.summary("Interactive Session", {
      Agent: options.name ?? provider.name,
      Sandbox: sandboxProvider.name,
      Branch: resolvedBranch,
    });

    // 5. Create worktree (unless head mode)
    let worktreeInfo: WorkspaceManager.WorktreeInfo | undefined;

    if (!isHeadMode) {
      worktreeInfo = yield* d.taskLog("Creating worktree", () =>
        WorkspaceManager.pruneStale(hostRepoDir).pipe(
          Effect.catchAll(() => Effect.void),
          Effect.andThen(
            branch
              ? WorkspaceManager.create(hostRepoDir, { branch })
              : WorkspaceManager.create(hostRepoDir, { name: options.name }),
          ),
        ),
      );

      // Copy files to worktree (bind-mount and no-sandbox, non-head)
      if (
        (sandboxProvider.tag === "bind-mount" ||
          sandboxProvider.tag === "none") &&
        options.copyToWorkspace &&
        options.copyToWorkspace.length > 0
      ) {
        yield* d.taskLog("Copying files to workspace", () =>
          copyToWorkspace(
            options.copyToWorkspace!,
            hostRepoDir,
            worktreeInfo!.path,
          ),
        );
      }
    }

    // 6. Start sandbox
    let handle:
      | BindMountSandboxHandle
      | IsolatedSandboxHandle
      | NoSandboxHandle;

    if (sandboxProvider.tag === "none") {
      // No-sandbox: run directly on the host, no container
      const workspacePath = isHeadMode ? hostRepoDir : worktreeInfo!.path;
      handle = yield* Effect.promise(() =>
        sandboxProvider.create({
          workspacePath,
          env: effectiveEnv,
        }),
      );
    } else if (sandboxProvider.tag === "isolated") {
      const startResult = yield* d.taskLog("Starting sandbox", () =>
        startSandbox({
          provider: sandboxProvider,
          hostRepoDir: worktreeInfo!.path,
          env: effectiveEnv,
          copyPaths: options.copyToWorkspace,
        }),
      );
      handle = startResult.handle;
    } else {
      const gitPath = join(hostRepoDir, ".git");
      const gitMounts = yield* resolveGitMounts(gitPath);
      const startResult = yield* d.taskLog("Starting sandbox", () =>
        startSandbox({
          provider: sandboxProvider,
          hostRepoDir,
          env: effectiveEnv,
          worktreeOrRepoPath: isHeadMode ? hostRepoDir : worktreeInfo!.path,
          gitMounts,
          workspaceDir: SANDBOX_WORKSPACE_DIR,
        }),
      );
      handle = startResult.handle;
    }

    // Run lifecycle with guaranteed cleanup of handle and worktree
    return yield* Effect.gen(function* () {
      // Check interactiveExec is available (no-sandbox always has it; bind-mount/isolated it's optional)
      if (!handle.interactiveExec) {
        throw new Error(
          `Sandbox provider does not support interactiveExec. ` +
            `The provider must implement the optional interactiveExec method to use interactive().`,
        );
      }
      const interactiveExecFn = handle.interactiveExec.bind(handle);

      // Build sandbox layer and run withSandboxLifecycle
      const sandboxLayer = makeSandboxLayerFromHandle(handle);
      const workspacePath = handle.workspacePath;

      const applyToHost =
        sandboxProvider.tag === "isolated" && worktreeInfo
          ? () => syncOut(worktreeInfo!.path, handle as IsolatedSandboxHandle)
          : () => Effect.void; // bind-mount and no-sandbox don't need sync

      const lifecycleEffect = withSandboxLifecycle(
        {
          hostRepoDir,
          sandboxRepoDir: workspacePath,
          hooks,
          branch: lifecycleBranch,
          hostWorkspacePath: isHeadMode ? hostRepoDir : worktreeInfo?.path,
          applyToHost,
        },
        (ctx) =>
          Effect.gen(function* () {
            // Preprocess prompt (expand !`command` shell expressions inside sandbox)
            // Skip when no prompt source was provided
            const fullPrompt = hasPromptSource
              ? yield* preprocessPrompt(
                  substitutedPrompt,
                  ctx.sandbox,
                  ctx.sandboxRepoDir,
                )
              : "";

            // Build interactive args and run the session
            const interactiveArgs = provider.buildInteractiveArgs!({
              prompt: fullPrompt,
              dangerouslySkipPermissions: sandboxProvider.tag !== "none",
            });
            const result = yield* Effect.promise(() =>
              interactiveExecFn(interactiveArgs, {
                stdin: process.stdin,
                stdout: process.stdout,
                stderr: process.stderr,
                cwd: workspacePath,
              }),
            );

            return result.exitCode;
          }),
      );

      const lifecycleResult = yield* lifecycleEffect.pipe(
        Effect.provide(sandboxLayer),
      );

      const exitCode = lifecycleResult.result;

      // Check for uncommitted changes (worktree mode only)
      let preservedWorkspacePath: string | undefined;
      if (worktreeInfo) {
        const hasUncommitted = yield* WorkspaceManager.hasUncommittedChanges(
          worktreeInfo.path,
        ).pipe(Effect.catchAll(() => Effect.succeed(false)));
        if (hasUncommitted) {
          preservedWorkspacePath = worktreeInfo.path;
        }
      }

      // Clean up worktree if not preserved
      if (worktreeInfo && !preservedWorkspacePath) {
        yield* WorkspaceManager.remove(worktreeInfo.path).pipe(
          Effect.catchAll(() => Effect.void),
        );
      }

      // Final summary
      yield* d.summary("Session Complete", {
        Commits: String(lifecycleResult.commits.length),
        Branch: lifecycleResult.branch,
        "Exit code": String(exitCode),
        ...(preservedWorkspacePath
          ? { "Preserved worktree": preservedWorkspacePath }
          : {}),
      });

      return {
        commits: lifecycleResult.commits,
        branch: lifecycleResult.branch,
        preservedWorkspacePath,
        exitCode,
      };
    }).pipe(
      // On error, always clean up worktree (on success, handled above with preserve check)
      Effect.tapError(() =>
        worktreeInfo
          ? WorkspaceManager.remove(worktreeInfo.path).pipe(
              Effect.catchAll(() => Effect.void),
            )
          : Effect.void,
      ),
      // Always close sandbox handle
      Effect.ensuring(Effect.promise(() => handle.close().catch(() => {}))),
    );
  });

  return Effect.runPromise(
    inner.pipe(
      Effect.provide(ClackDisplay.layer),
      Effect.provide(NodeContext.layer),
      Effect.provide(NodeFileSystem.layer),
    ),
  );
};
