import { Effect } from "effect";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookDefinition } from "./Config.js";
import {
  type ExecResult,
  Sandbox,
  SandboxError,
  type SandboxService,
} from "./Sandbox.js";

const execHost = (
  command: string,
  cwd: string,
): Effect.Effect<string, SandboxError> =>
  Effect.async<string, SandboxError>((resume) => {
    execFile(
      "sh",
      ["-c", command],
      { cwd, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          resume(
            Effect.fail(
              new SandboxError(
                "execHost",
                `${command}: ${stderr?.toString() || error.message}`,
              ),
            ),
          );
        } else {
          resume(Effect.succeed(stdout.toString()));
        }
      },
    );
  });

export const execOk = (
  sandbox: SandboxService,
  command: string,
  options?: { cwd?: string },
): Effect.Effect<ExecResult, SandboxError> =>
  Effect.flatMap(sandbox.exec(command, options), (result) =>
    result.exitCode !== 0
      ? Effect.fail(
          new SandboxError(
            "exec",
            `Command failed (exit ${result.exitCode}): ${command}\n${result.stderr}`,
          ),
        )
      : Effect.succeed(result),
  );

export const runHooks = (
  hooks: readonly HookDefinition[] | undefined,
  options?: { cwd?: string },
): Effect.Effect<void, SandboxError, Sandbox> =>
  Effect.gen(function* () {
    if (!hooks || hooks.length === 0) return;
    const sandbox = yield* Sandbox;
    for (const hook of hooks) {
      yield* execOk(sandbox, hook.command, options);
    }
  });

export const syncIn = (
  hostRepoDir: string,
  sandboxRepoDir: string,
  options?: { branch?: string },
): Effect.Effect<{ branch: string }, SandboxError, Sandbox> =>
  Effect.gen(function* () {
    const sandbox = yield* Sandbox;

    // Get current branch from host
    const hostBranch = (yield* execHost(
      "git rev-parse --abbrev-ref HEAD",
      hostRepoDir,
    )).trim();

    // The branch to check out in the sandbox
    const branch = options?.branch ?? hostBranch;

    // Create git bundle on host
    const bundleDir = yield* Effect.promise(() =>
      mkdtemp(join(tmpdir(), "sandcastle-bundle-")),
    );
    const bundleHostPath = join(bundleDir, "repo.bundle");
    yield* execHost(`git bundle create "${bundleHostPath}" --all`, hostRepoDir);

    // Detect if --branch target exists on the host
    const branchExistsOnHost =
      branch !== hostBranch
        ? yield* Effect.map(
            Effect.either(
              execHost(
                `git rev-parse --verify "refs/heads/${branch}"`,
                hostRepoDir,
              ),
            ),
            (either) => either._tag === "Right",
          )
        : true; // hostBranch always exists

    // Create temp dir in sandbox for the bundle
    const sandboxTmpDir = (yield* execOk(
      sandbox,
      "mktemp -d -t sandcastle-XXXXXX",
    )).stdout.trim();
    const bundleSandboxPath = `${sandboxTmpDir}/repo.bundle`;

    // Copy bundle into sandbox
    yield* sandbox.copyIn(bundleHostPath, bundleSandboxPath);

    // Check if sandbox repo already initialized
    const gitCheck = yield* sandbox.exec(
      `test -d "${sandboxRepoDir}/.git" && echo yes || echo no`,
    );
    const repoExists = gitCheck.stdout.trim() === "yes";

    // Determine the ref to fetch and sync to
    const fetchRef = branchExistsOnHost ? branch : hostBranch;
    const isNewBranch = !branchExistsOnHost;

    if (repoExists) {
      // Fetch bundle into temp ref, reset to match host
      yield* execOk(
        sandbox,
        `git fetch "${bundleSandboxPath}" "${fetchRef}:refs/sandcastle/sync" --force`,
        { cwd: sandboxRepoDir },
      );
      if (isNewBranch) {
        // Create new branch from host HEAD
        yield* execOk(
          sandbox,
          `git checkout -B "${branch}" refs/sandcastle/sync`,
          { cwd: sandboxRepoDir },
        );
      } else {
        yield* execOk(
          sandbox,
          `git checkout -B "${branch}" refs/sandcastle/sync`,
          { cwd: sandboxRepoDir },
        );
        yield* execOk(sandbox, "git reset --hard refs/sandcastle/sync", {
          cwd: sandboxRepoDir,
        });
      }
      yield* execOk(sandbox, "git clean -fdx -e node_modules", {
        cwd: sandboxRepoDir,
      });
    } else {
      // Clone from bundle
      yield* execOk(
        sandbox,
        `git clone "${bundleSandboxPath}" "${sandboxRepoDir}"`,
      );
      if (branchExistsOnHost) {
        yield* execOk(sandbox, `git checkout "${branch}"`, {
          cwd: sandboxRepoDir,
        });
      } else {
        yield* execOk(sandbox, `git checkout "${hostBranch}"`, {
          cwd: sandboxRepoDir,
        });
        // Create new branch from host HEAD
        yield* execOk(sandbox, `git checkout -b "${branch}"`, {
          cwd: sandboxRepoDir,
        });
      }
    }

    // Configure remotes from host
    const hostRemotes = (yield* execHost("git remote -v", hostRepoDir)).trim();
    if (hostRemotes.length > 0) {
      // Parse unique remote names and their fetch URLs
      const remotes = new Map<string, string>();
      for (const line of hostRemotes.split("\n")) {
        const match = line.match(/^(\S+)\t(\S+)\s+\(fetch\)$/);
        if (match) {
          remotes.set(match[1]!, match[2]!);
        }
      }

      // Get existing sandbox remotes
      const sandboxRemotes = (yield* execOk(sandbox, "git remote", {
        cwd: sandboxRepoDir,
      })).stdout
        .trim()
        .split("\n")
        .filter((r) => r.length > 0);

      for (const [name, url] of remotes) {
        if (sandboxRemotes.includes(name)) {
          yield* execOk(sandbox, `git remote set-url "${name}" "${url}"`, {
            cwd: sandboxRepoDir,
          });
        } else {
          yield* execOk(sandbox, `git remote add "${name}" "${url}"`, {
            cwd: sandboxRepoDir,
          });
        }
      }

      // Remove sandbox remotes that don't exist on host
      for (const name of sandboxRemotes) {
        if (!remotes.has(name)) {
          yield* execOk(sandbox, `git remote remove "${name}"`, {
            cwd: sandboxRepoDir,
          });
        }
      }
    }

    // Clean up temp files
    yield* sandbox.exec(`rm -rf "${sandboxTmpDir}"`);
    yield* Effect.promise(() => rm(bundleDir, { recursive: true }));

    // Verify sync succeeded — compare against the ref we synced to
    const expectedHead = (yield* execHost(
      `git rev-parse "refs/heads/${fetchRef}"`,
      hostRepoDir,
    )).trim();
    const sandboxHead = (yield* execOk(sandbox, "git rev-parse HEAD", {
      cwd: sandboxRepoDir,
    })).stdout.trim();

    if (expectedHead !== sandboxHead) {
      yield* Effect.fail(
        new SandboxError(
          "syncIn",
          `HEAD mismatch after sync: host=${expectedHead} sandbox=${sandboxHead}`,
        ),
      );
    }

    return { branch };
  });

export const syncOut = (
  hostRepoDir: string,
  sandboxRepoDir: string,
  baseHead: string,
  options?: { branch?: string },
): Effect.Effect<void, SandboxError, Sandbox> =>
  Effect.gen(function* () {
    const sandbox = yield* Sandbox;

    // Determine if we need worktree-based sync
    const targetBranch = options?.branch;
    const hostBranch = targetBranch
      ? (yield* execHost("git rev-parse --abbrev-ref HEAD", hostRepoDir)).trim()
      : undefined;
    const useWorktree = targetBranch != null && targetBranch !== hostBranch;

    if (useWorktree) {
      yield* syncOutViaWorktree(
        sandbox,
        hostRepoDir,
        sandboxRepoDir,
        baseHead,
        targetBranch,
      );
    } else {
      yield* syncOutDirect(sandbox, hostRepoDir, sandboxRepoDir, baseHead);
    }
  });

/** Apply patches directly to the host's current branch (existing behavior) */
const syncOutDirect = (
  sandbox: SandboxService,
  hostRepoDir: string,
  sandboxRepoDir: string,
  baseHead: string,
): Effect.Effect<void, SandboxError> =>
  Effect.gen(function* () {
    // --- 1. Sync commits via format-patch / git am ---
    const sandboxHead = (yield* execOk(sandbox, "git rev-parse HEAD", {
      cwd: sandboxRepoDir,
    })).stdout.trim();

    if (sandboxHead !== baseHead) {
      yield* applyPatches(sandbox, hostRepoDir, sandboxRepoDir, baseHead);
    }

    // --- 2. Sync uncommitted changes ---

    // Staged + unstaged changes via git diff HEAD
    const diffCheck = yield* sandbox.exec("git diff HEAD --quiet", {
      cwd: sandboxRepoDir,
    });
    if (diffCheck.exitCode !== 0) {
      const sandboxDiffDir = (yield* execOk(
        sandbox,
        "mktemp -d -t sandcastle-diff-XXXXXX",
      )).stdout.trim();
      const sandboxDiffFile = `${sandboxDiffDir}/changes.patch`;
      const hostDiffDir = yield* Effect.promise(() =>
        mkdtemp(join(tmpdir(), "sandcastle-diff-")),
      );
      const hostDiffFile = join(hostDiffDir, "changes.patch");

      yield* execOk(sandbox, `git diff HEAD > "${sandboxDiffFile}"`, {
        cwd: sandboxRepoDir,
      });
      yield* sandbox.copyOut(sandboxDiffFile, hostDiffFile);
      yield* execHost(`git apply "${hostDiffFile}"`, hostRepoDir);

      yield* sandbox.exec(`rm -rf "${sandboxDiffDir}"`);
      yield* Effect.promise(() => rm(hostDiffDir, { recursive: true }));
    }

    // Untracked files
    const untrackedResult = yield* sandbox.exec(
      "git ls-files --others --exclude-standard",
      { cwd: sandboxRepoDir },
    );
    if (
      untrackedResult.exitCode === 0 &&
      untrackedResult.stdout.trim().length > 0
    ) {
      const untrackedFiles = untrackedResult.stdout
        .trim()
        .split("\n")
        .filter((f) => f.length > 0);

      for (const file of untrackedFiles) {
        const sandboxFilePath = `${sandboxRepoDir}/${file}`;
        const hostFilePath = join(hostRepoDir, file);
        yield* sandbox.copyOut(sandboxFilePath, hostFilePath);
      }
    }
  });

/** Apply committed patches to a target branch via a temporary git worktree */
const syncOutViaWorktree = (
  sandbox: SandboxService,
  hostRepoDir: string,
  sandboxRepoDir: string,
  baseHead: string,
  targetBranch: string,
): Effect.Effect<void, SandboxError> =>
  Effect.gen(function* () {
    // Check if there are new commits to apply
    const sandboxHead = (yield* execOk(sandbox, "git rev-parse HEAD", {
      cwd: sandboxRepoDir,
    })).stdout.trim();

    if (sandboxHead === baseHead) {
      // No commits — nothing to do
      return;
    }

    const countResult = yield* execOk(
      sandbox,
      `git rev-list "${baseHead}..HEAD" --count`,
      { cwd: sandboxRepoDir },
    );
    const commitCount = parseInt(countResult.stdout.trim(), 10);
    if (commitCount === 0) return;

    // Generate and copy patches
    const hostPatchDir = yield* generateAndCopyPatches(
      sandbox,
      sandboxRepoDir,
      baseHead,
    );

    // Create worktree, apply patches, clean up
    const worktreeDir = yield* Effect.promise(() =>
      mkdtemp(join(tmpdir(), "sandcastle-worktree-")),
    );

    yield* Effect.ensuring(
      // Try: create worktree and apply patches
      Effect.gen(function* () {
        // Check if target branch already exists on host
        const branchExists = yield* Effect.map(
          Effect.either(
            execHost(
              `git rev-parse --verify "refs/heads/${targetBranch}"`,
              hostRepoDir,
            ),
          ),
          (either) => either._tag === "Right",
        );

        if (branchExists) {
          // Check out existing branch into worktree
          yield* execHost(
            `git worktree add "${worktreeDir}/wt" "${targetBranch}"`,
            hostRepoDir,
          );
        } else {
          // Create worktree with a new branch from the current HEAD
          yield* execHost(
            `git worktree add "${worktreeDir}/wt" -b "${targetBranch}" HEAD`,
            hostRepoDir,
          );
        }

        // Abort any leftover git am session
        yield* Effect.ignore(execHost("git am --abort", `${worktreeDir}/wt`));

        // Apply patches in the worktree
        const sortedFiles = (yield* Effect.promise(() => readdir(hostPatchDir)))
          .filter((f) => f.endsWith(".patch"))
          .sort();

        for (const file of sortedFiles) {
          yield* execHost(
            `git am --3way "${join(hostPatchDir, file)}"`,
            `${worktreeDir}/wt`,
          );
        }
      }),
      // Finally: always clean up worktree
      Effect.gen(function* () {
        yield* Effect.ignore(
          execHost(
            `git worktree remove "${worktreeDir}/wt" --force`,
            hostRepoDir,
          ),
        );
        yield* Effect.promise(() =>
          rm(worktreeDir, { recursive: true, force: true }),
        );
        yield* Effect.promise(() =>
          rm(hostPatchDir, { recursive: true, force: true }),
        );
      }),
    );
  });

/** Generate format-patch files in sandbox and copy them to host temp dir */
const generateAndCopyPatches = (
  sandbox: SandboxService,
  sandboxRepoDir: string,
  baseHead: string,
): Effect.Effect<string, SandboxError> =>
  Effect.gen(function* () {
    const sandboxPatchDir = (yield* execOk(
      sandbox,
      "mktemp -d -t sandcastle-patches-XXXXXX",
    )).stdout.trim();

    yield* execOk(
      sandbox,
      `git format-patch "${baseHead}..HEAD" -o "${sandboxPatchDir}"`,
      { cwd: sandboxRepoDir },
    );

    const hostPatchDir = yield* Effect.promise(() =>
      mkdtemp(join(tmpdir(), "sandcastle-patches-")),
    );

    const patchListResult = yield* execOk(
      sandbox,
      `ls "${sandboxPatchDir}"/*.patch`,
    );
    const patchFiles = patchListResult.stdout
      .trim()
      .split("\n")
      .filter((f) => f.length > 0);

    for (const sandboxPatchPath of patchFiles) {
      const filename = sandboxPatchPath.split("/").pop()!;
      const hostPatchPath = join(hostPatchDir, filename);
      yield* sandbox.copyOut(sandboxPatchPath, hostPatchPath);
    }

    yield* sandbox.exec(`rm -rf "${sandboxPatchDir}"`);

    return hostPatchDir;
  });

/** Apply patches directly to a host repo dir */
const applyPatches = (
  sandbox: SandboxService,
  hostRepoDir: string,
  sandboxRepoDir: string,
  baseHead: string,
): Effect.Effect<void, SandboxError> =>
  Effect.gen(function* () {
    const countResult = yield* execOk(
      sandbox,
      `git rev-list "${baseHead}..HEAD" --count`,
      { cwd: sandboxRepoDir },
    );
    const commitCount = parseInt(countResult.stdout.trim(), 10);

    if (commitCount > 0) {
      const hostPatchDir = yield* generateAndCopyPatches(
        sandbox,
        sandboxRepoDir,
        baseHead,
      );

      // Abort any leftover git am session
      yield* Effect.ignore(execHost("git am --abort", hostRepoDir));

      // Apply patches in order
      const sortedFiles = (yield* Effect.promise(() => readdir(hostPatchDir)))
        .filter((f) => f.endsWith(".patch"))
        .sort();

      for (const file of sortedFiles) {
        yield* execHost(
          `git am --3way "${join(hostPatchDir, file)}"`,
          hostRepoDir,
        );
      }

      yield* Effect.promise(() => rm(hostPatchDir, { recursive: true }));
    }
  });
