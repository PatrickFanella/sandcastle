import { Effect } from "effect";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandcastleConfig } from "./Config.js";
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

const execOk = (
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

export const syncIn = (
  hostRepoDir: string,
  sandboxRepoDir: string,
  config?: SandcastleConfig,
): Effect.Effect<{ branch: string }, SandboxError, Sandbox> =>
  Effect.gen(function* () {
    const sandbox = yield* Sandbox;

    // Get current branch from host
    const branch = (yield* execHost(
      "git rev-parse --abbrev-ref HEAD",
      hostRepoDir,
    )).trim();

    // Create git bundle on host
    const bundleDir = yield* Effect.promise(() =>
      mkdtemp(join(tmpdir(), "sandcastle-bundle-")),
    );
    const bundleHostPath = join(bundleDir, "repo.bundle");
    yield* execHost(`git bundle create "${bundleHostPath}" --all`, hostRepoDir);

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

    if (repoExists) {
      // Fetch bundle into temp ref, reset to match host
      yield* execOk(
        sandbox,
        `git fetch "${bundleSandboxPath}" "${branch}:refs/sandcastle/sync" --force`,
        { cwd: sandboxRepoDir },
      );
      yield* execOk(sandbox, `git checkout -f "${branch}"`, {
        cwd: sandboxRepoDir,
      });
      yield* execOk(sandbox, "git reset --hard refs/sandcastle/sync", {
        cwd: sandboxRepoDir,
      });
      yield* execOk(sandbox, "git clean -fdx -e node_modules", {
        cwd: sandboxRepoDir,
      });
    } else {
      // Clone from bundle
      yield* execOk(
        sandbox,
        `git clone "${bundleSandboxPath}" "${sandboxRepoDir}"`,
      );
      yield* execOk(sandbox, `git checkout "${branch}"`, {
        cwd: sandboxRepoDir,
      });
    }

    // Clean up temp files
    yield* sandbox.exec(`rm -rf "${sandboxTmpDir}"`);
    yield* Effect.promise(() => rm(bundleDir, { recursive: true }));

    // Verify sync succeeded
    const hostHead = (yield* execHost(
      "git rev-parse HEAD",
      hostRepoDir,
    )).trim();
    const sandboxHead = (yield* execOk(sandbox, "git rev-parse HEAD", {
      cwd: sandboxRepoDir,
    })).stdout.trim();

    if (hostHead !== sandboxHead) {
      yield* Effect.fail(
        new SandboxError(
          "syncIn",
          `HEAD mismatch after sync: host=${hostHead} sandbox=${sandboxHead}`,
        ),
      );
    }

    // Run postSyncIn command if configured
    if (config?.postSyncIn) {
      yield* execOk(sandbox, config.postSyncIn, { cwd: sandboxRepoDir });
    }

    return { branch };
  });

export const syncOut = (
  hostRepoDir: string,
  sandboxRepoDir: string,
  baseHead: string,
): Effect.Effect<void, SandboxError, Sandbox> =>
  Effect.gen(function* () {
    const sandbox = yield* Sandbox;

    // --- 1. Sync commits via format-patch / git am ---
    const sandboxHead = (yield* execOk(sandbox, "git rev-parse HEAD", {
      cwd: sandboxRepoDir,
    })).stdout.trim();

    if (sandboxHead !== baseHead) {
      // Count new commits
      const countResult = yield* execOk(
        sandbox,
        `git rev-list "${baseHead}..HEAD" --count`,
        { cwd: sandboxRepoDir },
      );
      const commitCount = parseInt(countResult.stdout.trim(), 10);

      if (commitCount > 0) {
        // Generate patches in sandbox
        const sandboxPatchDir = (yield* execOk(
          sandbox,
          "mktemp -d -t sandcastle-patches-XXXXXX",
        )).stdout.trim();

        yield* execOk(
          sandbox,
          `git format-patch "${baseHead}..HEAD" -o "${sandboxPatchDir}"`,
          { cwd: sandboxRepoDir },
        );

        // Create host-side temp dir for patches
        const hostPatchDir = yield* Effect.promise(() =>
          mkdtemp(join(tmpdir(), "sandcastle-patches-")),
        );

        // List patch files and copy them out
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

        // Clean up
        yield* sandbox.exec(`rm -rf "${sandboxPatchDir}"`);
        yield* Effect.promise(() => rm(hostPatchDir, { recursive: true }));
      }
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
