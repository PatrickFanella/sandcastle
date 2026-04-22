import { Effect, Layer, Ref } from "effect";
import { exec } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { type DisplayEntry, SilentDisplay } from "./Display.js";
import { Sandbox, type SandboxService } from "./SandboxFactory.js";
import { makeLocalSandboxLayer } from "./testSandbox.js";
import { ExecError, SyncError } from "./errors.js";
import { withSandboxLifecycle, runHostHooks } from "./SandboxLifecycle.js";

/**
 * Creates a sandbox that translates container paths to host paths,
 * simulating a bind-mount sandbox provider. When a command uses
 * `containerPath` as cwd, it's translated to `hostPath`.
 */
const makePathTranslatingSandbox = (
  hostPath: string,
  containerPath: string,
  _baseLayer: Layer.Layer<Sandbox>,
): SandboxService => {
  const translateCwd = (cwd?: string) =>
    cwd === containerPath ? hostPath : cwd;

  const baseSandbox = Effect.runSync(
    Effect.provide(Sandbox, makeLocalSandboxLayer(hostPath)),
  );

  return {
    exec: (command, options) =>
      baseSandbox.exec(command, {
        ...options,
        cwd: translateCwd(options?.cwd),
      }),
    copyIn: (hp, sp) => baseSandbox.copyIn(hp, sp),
    copyFileOut: (sp, hp) => baseSandbox.copyFileOut(sp, hp),
  };
};

const execAsync = promisify(exec);

const initRepo = async (dir: string) => {
  await execAsync("git init -b main", { cwd: dir });
  await execAsync('git config user.email "test@test.com"', { cwd: dir });
  await execAsync('git config user.name "Test"', { cwd: dir });
};

const commitFile = async (
  dir: string,
  name: string,
  content: string,
  message: string,
) => {
  await writeFile(join(dir, name), content);
  await execAsync(`git add "${name}"`, { cwd: dir });
  await execAsync(`git commit -m "${message}"`, { cwd: dir });
};

const getHead = async (dir: string) => {
  const { stdout } = await execAsync("git rev-parse HEAD", { cwd: dir });
  return stdout.trim();
};

const testDisplayLayer = SilentDisplay.layer(
  Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([]),
);

const setup = async () => {
  const hostDir = await mkdtemp(join(tmpdir(), "host-"));
  const sandboxDir = await mkdtemp(join(tmpdir(), "sandbox-"));
  const sandboxRepoDir = join(sandboxDir, "repo");
  const layer = makeLocalSandboxLayer(sandboxDir);
  return { hostDir, sandboxDir, sandboxRepoDir, layer };
};

describe("withSandboxLifecycle (worktree mode)", () => {
  const setupWorktree = async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "host-"));
    await execAsync("git init -b main", { cwd: hostDir });
    await execAsync('git config user.email "test@test.com"', { cwd: hostDir });
    await execAsync('git config user.name "Test"', { cwd: hostDir });
    await writeFile(join(hostDir, "file.txt"), "original");
    await execAsync("git add file.txt", { cwd: hostDir });
    await execAsync('git commit -m "initial commit"', { cwd: hostDir });

    // Create a real git worktree from the host repo
    const worktreesDir = join(hostDir, ".sandcastle", "worktrees");
    await mkdir(worktreesDir, { recursive: true });
    const worktreeDir = join(worktreesDir, "test-worktree");
    await execAsync(
      `git worktree add -b "sandcastle/test" "${worktreeDir}" HEAD`,
      { cwd: hostDir },
    );

    const layer = makeLocalSandboxLayer(worktreeDir);
    return { hostDir, worktreeDir, layer };
  };

  it("skips sync-in — worktree files are already accessible", async () => {
    const { hostDir, worktreeDir, layer } = await setupWorktree();

    await Effect.runPromise(
      withSandboxLifecycle(
        {
          hostRepoDir: hostDir,
          sandboxRepoDir: worktreeDir,
        },
        (ctx) =>
          Effect.gen(function* () {
            // Files from the host repo are already visible — no sync-in needed
            const result = yield* ctx.sandbox.exec("cat file.txt", {
              cwd: ctx.sandboxRepoDir,
            });
            expect(result.stdout.trim()).toBe("original");
          }),
      ).pipe(Effect.provide(Layer.merge(layer, testDisplayLayer))),
    );
  });

  it("commits in worktree are cherry-picked onto host's current branch", async () => {
    const { hostDir, worktreeDir, layer } = await setupWorktree();

    await Effect.runPromise(
      withSandboxLifecycle(
        {
          hostRepoDir: hostDir,
          sandboxRepoDir: worktreeDir,
        },
        (ctx) =>
          Effect.gen(function* () {
            yield* ctx.sandbox.exec('git config user.email "test@test.com"', {
              cwd: ctx.sandboxRepoDir,
            });
            yield* ctx.sandbox.exec('git config user.name "Test"', {
              cwd: ctx.sandboxRepoDir,
            });
            yield* ctx.sandbox.exec(
              'sh -c "echo worktree-content > worktree-file.txt && git add worktree-file.txt && git commit -m \\"worktree commit\\""',
              { cwd: ctx.sandboxRepoDir },
            );
          }),
      ).pipe(Effect.provide(Layer.merge(layer, testDisplayLayer))),
    );

    // Commit is cherry-picked onto host's current branch (main)
    const { stdout: log } = await execAsync("git log --oneline main", {
      cwd: hostDir,
    });
    expect(log).toContain("worktree commit");

    // File is readable from the host's main branch
    const content = await readFile(join(hostDir, "worktree-file.txt"), "utf-8");
    expect(content.trim()).toBe("worktree-content");
  });

  it("onSandboxReady hooks still run in worktree mode", async () => {
    const { hostDir, worktreeDir, layer } = await setupWorktree();

    await Effect.runPromise(
      withSandboxLifecycle(
        {
          hostRepoDir: hostDir,
          sandboxRepoDir: worktreeDir,

          hooks: {
            sandbox: {
              onSandboxReady: [{ command: "echo ready > ready-marker.txt" }],
            },
          },
        },
        (ctx) =>
          Effect.gen(function* () {
            const result = yield* ctx.sandbox.exec("cat ready-marker.txt", {
              cwd: ctx.sandboxRepoDir,
            });
            expect(result.stdout.trim()).toBe("ready");
          }),
      ).pipe(Effect.provide(Layer.merge(layer, testDisplayLayer))),
    );
  });

  it("onSandboxReady hooks pass sudo option through to exec", async () => {
    const { hostDir, worktreeDir } = await setupWorktree();

    const execCalls: Array<{
      command: string;
      options?: { sudo?: boolean; cwd?: string };
    }> = [];

    // Custom sandbox layer that records exec calls
    const spySandboxLayer = Layer.succeed(Sandbox, {
      exec: (command, options) => {
        execCalls.push({ command, options });
        return Effect.succeed({ stdout: "", stderr: "", exitCode: 0 });
      },
      copyIn: () => Effect.succeed(undefined as never),
      copyFileOut: () => Effect.succeed(undefined as never),
    });

    await Effect.runPromise(
      withSandboxLifecycle(
        {
          hostRepoDir: hostDir,
          sandboxRepoDir: worktreeDir,
          branch: "sandcastle/test",
          hooks: {
            sandbox: {
              onSandboxReady: [
                { command: "npm install" },
                { command: "apt-get install -y ffmpeg", sudo: true },
              ],
            },
          },
        },
        () => Effect.succeed("ok"),
      ).pipe(Effect.provide(Layer.merge(spySandboxLayer, testDisplayLayer))),
    );

    // Find the hook exec calls (after git config calls)
    const hookCalls = execCalls.filter(
      (c) =>
        c.command === "npm install" ||
        c.command === "apt-get install -y ffmpeg",
    );
    expect(hookCalls).toHaveLength(2);
    expect(hookCalls[0]).toEqual(
      expect.objectContaining({ command: "npm install" }),
    );
    expect(hookCalls[0]!.options?.sudo).toBeUndefined();
    expect(hookCalls[1]).toEqual(
      expect.objectContaining({ command: "apt-get install -y ffmpeg" }),
    );
    expect(hookCalls[1]!.options?.sudo).toBe(true);
  });

  it("onSandboxReady hooks run in parallel", async () => {
    const { hostDir, worktreeDir } = await setupWorktree();

    // Track the order of start/end events to verify parallel execution
    const events: string[] = [];

    const spySandboxLayer = Layer.succeed(Sandbox, {
      exec: (command, options) => {
        if (command === "slow-hook-a" || command === "slow-hook-b") {
          events.push(`start:${command}`);
          return Effect.gen(function* () {
            // Yield to allow the other hook to start
            yield* Effect.yieldNow();
            events.push(`end:${command}`);
            return { stdout: "", stderr: "", exitCode: 0 };
          });
        }
        return Effect.succeed({ stdout: "", stderr: "", exitCode: 0 });
      },
      copyIn: () => Effect.succeed(undefined as never),
      copyFileOut: () => Effect.succeed(undefined as never),
    });

    await Effect.runPromise(
      withSandboxLifecycle(
        {
          hostRepoDir: hostDir,
          sandboxRepoDir: worktreeDir,
          branch: "sandcastle/test",
          hooks: {
            sandbox: {
              onSandboxReady: [
                { command: "slow-hook-a" },
                { command: "slow-hook-b" },
              ],
            },
          },
        },
        () => Effect.succeed("ok"),
      ).pipe(Effect.provide(Layer.merge(spySandboxLayer, testDisplayLayer))),
    );

    // With parallel execution, both hooks should start before either ends
    expect(events).toEqual([
      "start:slow-hook-a",
      "start:slow-hook-b",
      "end:slow-hook-a",
      "end:slow-hook-b",
    ]);
  });

  it("returns commits made in the worktree", async () => {
    const { hostDir, worktreeDir, layer } = await setupWorktree();

    const result = await Effect.runPromise(
      withSandboxLifecycle(
        {
          hostRepoDir: hostDir,
          sandboxRepoDir: worktreeDir,
        },
        (ctx) =>
          Effect.gen(function* () {
            yield* ctx.sandbox.exec('git config user.email "test@test.com"', {
              cwd: ctx.sandboxRepoDir,
            });
            yield* ctx.sandbox.exec('git config user.name "Test"', {
              cwd: ctx.sandboxRepoDir,
            });
            yield* ctx.sandbox.exec(
              'sh -c "echo new > new-file.txt && git add new-file.txt && git commit -m \\"new commit\\""',
              { cwd: ctx.sandboxRepoDir },
            );
          }),
      ).pipe(Effect.provide(Layer.merge(layer, testDisplayLayer))),
    );

    expect(result.commits).toHaveLength(1);
    // Commits are cherry-picked onto host's current branch (main)
    expect(result.branch).toBe("main");
  });

  it("returns empty commits when no work is done in worktree mode", async () => {
    const { hostDir, worktreeDir, layer } = await setupWorktree();

    const result = await Effect.runPromise(
      withSandboxLifecycle(
        {
          hostRepoDir: hostDir,
          sandboxRepoDir: worktreeDir,
        },
        () => Effect.succeed("no-op"),
      ).pipe(Effect.provide(Layer.merge(layer, testDisplayLayer))),
    );

    expect(result.commits).toHaveLength(0);
    expect(result.result).toBe("no-op");
  });

  it("temp branch is deleted after cherry-pick", async () => {
    const { hostDir, worktreeDir, layer } = await setupWorktree();

    await Effect.runPromise(
      withSandboxLifecycle(
        {
          hostRepoDir: hostDir,
          sandboxRepoDir: worktreeDir,
        },
        (ctx) =>
          Effect.gen(function* () {
            yield* ctx.sandbox.exec('git config user.email "test@test.com"', {
              cwd: ctx.sandboxRepoDir,
            });
            yield* ctx.sandbox.exec('git config user.name "Test"', {
              cwd: ctx.sandboxRepoDir,
            });
            yield* ctx.sandbox.exec(
              'sh -c "echo content > new-file.txt && git add new-file.txt && git commit -m \\"temp commit\\""',
              { cwd: ctx.sandboxRepoDir },
            );
          }),
      ).pipe(Effect.provide(Layer.merge(layer, testDisplayLayer))),
    );

    // The temp branch should no longer exist
    const { stdout } = await execAsync('git branch --list "sandcastle/test"', {
      cwd: hostDir,
    });
    expect(stdout.trim()).toBe("");
  });

  it("temp branch is deleted even when no commits were made", async () => {
    const { hostDir, worktreeDir, layer } = await setupWorktree();

    await Effect.runPromise(
      withSandboxLifecycle(
        {
          hostRepoDir: hostDir,
          sandboxRepoDir: worktreeDir,
        },
        () => Effect.succeed("no-op"),
      ).pipe(Effect.provide(Layer.merge(layer, testDisplayLayer))),
    );

    // Temp branch deleted even with no commits
    const { stdout } = await execAsync('git branch --list "sandcastle/test"', {
      cwd: hostDir,
    });
    expect(stdout.trim()).toBe("");
  });

  it("preserves temp branch and throws on merge conflict", async () => {
    const { hostDir, worktreeDir, layer } = await setupWorktree();

    await expect(
      Effect.runPromise(
        withSandboxLifecycle(
          {
            hostRepoDir: hostDir,
            sandboxRepoDir: worktreeDir,
          },
          (ctx) =>
            Effect.gen(function* () {
              // Commit a change to file.txt in the worktree
              yield* ctx.sandbox.exec('git config user.email "test@test.com"', {
                cwd: ctx.sandboxRepoDir,
              });
              yield* ctx.sandbox.exec('git config user.name "Test"', {
                cwd: ctx.sandboxRepoDir,
              });
              yield* ctx.sandbox.exec(
                'sh -c "echo worktree-version > file.txt && git add file.txt && git commit -m \\"worktree change\\""',
                { cwd: ctx.sandboxRepoDir },
              );
              // Also commit a conflicting change to file.txt on main directly
              yield* Effect.promise(async () => {
                await execAsync(
                  'sh -c "echo main-version > file.txt && git add file.txt && git commit -m \\"main conflict\\""',
                  { cwd: hostDir },
                );
              });
            }),
        ).pipe(Effect.provide(Layer.merge(layer, testDisplayLayer))),
      ),
    ).rejects.toThrow(/merge.*failed/i);

    // Temp branch should still exist for recovery
    const { stdout } = await execAsync('git branch --list "sandcastle/test"', {
      cwd: hostDir,
    });
    expect(stdout.trim()).toBeTruthy();
  });

  it("succeeds with merge commit when host branch has diverged (non-conflicting)", async () => {
    const { hostDir, worktreeDir, layer } = await setupWorktree();

    await Effect.runPromise(
      withSandboxLifecycle(
        {
          hostRepoDir: hostDir,
          sandboxRepoDir: worktreeDir,
        },
        (ctx) =>
          Effect.gen(function* () {
            yield* ctx.sandbox.exec('git config user.email "test@test.com"', {
              cwd: ctx.sandboxRepoDir,
            });
            yield* ctx.sandbox.exec('git config user.name "Test"', {
              cwd: ctx.sandboxRepoDir,
            });
            // Commit a change to a new file in the worktree
            yield* ctx.sandbox.exec(
              'sh -c "echo worktree-content > worktree-file.txt && git add worktree-file.txt && git commit -m \\"worktree change\\""',
              { cwd: ctx.sandboxRepoDir },
            );
            // Commit a non-conflicting change to a different file on main directly
            yield* Effect.promise(async () => {
              await execAsync(
                'sh -c "echo main-content > main-file.txt && git add main-file.txt && git commit -m \\"main change\\""',
                { cwd: hostDir },
              );
            });
          }),
      ).pipe(Effect.provide(Layer.merge(layer, testDisplayLayer))),
    );

    // Both files should exist on main after the merge
    const worktreeFile = await readFile(
      join(hostDir, "worktree-file.txt"),
      "utf8",
    );
    const mainFile = await readFile(join(hostDir, "main-file.txt"), "utf8");
    expect(worktreeFile.trim()).toBe("worktree-content");
    expect(mainFile.trim()).toBe("main-content");

    // Temp branch should be deleted
    const { stdout } = await execAsync('git branch --list "sandcastle/test"', {
      cwd: hostDir,
    });
    expect(stdout.trim()).toBe("");
  });

  it("cherry-pick works when sandboxRepoDir differs from host worktree path", async () => {
    const { hostDir, worktreeDir, layer } = await setupWorktree();

    // Simulate a bind-mount provider: sandboxRepoDir is the container mount point,
    // which differs from the actual host worktree path. In production the sandbox
    // sees /home/agent/workspace while the host sees .sandcastle/worktrees/<name>.
    //
    // We use a PathTranslating sandbox that maps the container path to the real
    // worktree path — exactly what a bind-mount provider does.
    const containerPath = "/home/agent/workspace";
    const translatingLayer = Layer.succeed(
      Sandbox,
      makePathTranslatingSandbox(worktreeDir, containerPath, layer),
    );

    const result = await Effect.runPromise(
      withSandboxLifecycle(
        {
          hostRepoDir: hostDir,
          sandboxRepoDir: containerPath,

          hostWorktreePath: worktreeDir,
        },
        (ctx) =>
          Effect.gen(function* () {
            yield* ctx.sandbox.exec('git config user.email "test@test.com"', {
              cwd: ctx.sandboxRepoDir,
            });
            yield* ctx.sandbox.exec('git config user.name "Test"', {
              cwd: ctx.sandboxRepoDir,
            });
            yield* ctx.sandbox.exec(
              'sh -c "echo docker-content > docker-file.txt && git add docker-file.txt && git commit -m \\"docker worktree commit\\""',
              { cwd: ctx.sandboxRepoDir },
            );
          }),
      ).pipe(Effect.provide(Layer.merge(translatingLayer, testDisplayLayer))),
    );

    // Commit should be cherry-picked onto host's current branch (main)
    const { stdout: log } = await execAsync("git log --oneline main", {
      cwd: hostDir,
    });
    expect(log).toContain("docker worktree commit");
    expect(result.commits).toHaveLength(1);
    expect(result.branch).toBe("main");

    // Temp branch should be deleted
    const { stdout: branches } = await execAsync(
      'git branch --list "sandcastle/test"',
      { cwd: hostDir },
    );
    expect(branches.trim()).toBe("");
  });

  it("cherry-pick succeeds when worktree commits include a merge commit", async () => {
    const { hostDir, worktreeDir, layer } = await setupWorktree();

    const result = await Effect.runPromise(
      withSandboxLifecycle(
        {
          hostRepoDir: hostDir,
          sandboxRepoDir: worktreeDir,
        },
        (ctx) =>
          Effect.gen(function* () {
            yield* ctx.sandbox.exec('git config user.email "test@test.com"', {
              cwd: ctx.sandboxRepoDir,
            });
            yield* ctx.sandbox.exec('git config user.name "Test"', {
              cwd: ctx.sandboxRepoDir,
            });

            // Create a feature branch off the worktree, make a commit, then merge it back
            // This produces a merge commit — exactly what caused the production failure
            yield* ctx.sandbox.exec(
              'sh -c "git checkout -b feature/merge-test && echo feat > feat.txt && git add feat.txt && git commit -m \\"feature commit\\""',
              { cwd: ctx.sandboxRepoDir },
            );
            yield* ctx.sandbox.exec(
              'sh -c "git checkout sandcastle/test && git merge --no-ff feature/merge-test -m \\"Merge feature/merge-test\\""',
              { cwd: ctx.sandboxRepoDir },
            );
          }),
      ).pipe(Effect.provide(Layer.merge(layer, testDisplayLayer))),
    );

    // The feature commit should be cherry-picked onto main
    const { stdout: log } = await execAsync("git log --oneline main", {
      cwd: hostDir,
    });
    expect(log).toContain("feature commit");

    // Should report the cherry-picked (non-merge) commit
    expect(result.commits.length).toBeGreaterThanOrEqual(1);
    expect(result.branch).toBe("main");
  });

  it("merging multiple independent branches on temp branch lands all changes on host", async () => {
    // Reproduces the parallel planner bug: the merge agent works on a temp branch,
    // merges N branches that each independently modified files from the same main base.
    // git rev-list --no-merges walks into the merged branches and collects all original
    // commits, then cherry-picking them sequentially onto main fails because they
    // touch overlapping files from the same base.
    const { hostDir, worktreeDir, layer } = await setupWorktree();

    const result = await Effect.runPromise(
      withSandboxLifecycle(
        {
          hostRepoDir: hostDir,
          sandboxRepoDir: worktreeDir,
        },
        (ctx) =>
          Effect.gen(function* () {
            yield* ctx.sandbox.exec('git config user.email "test@test.com"', {
              cwd: ctx.sandboxRepoDir,
            });
            yield* ctx.sandbox.exec('git config user.name "Test"', {
              cwd: ctx.sandboxRepoDir,
            });

            // Create two independent branches from main, each modifying the shared file
            yield* ctx.sandbox.exec(
              'sh -c "git checkout -b branch-a main && echo line-a >> file.txt && git add file.txt && git commit -m \\"branch-a change\\""',
              { cwd: ctx.sandboxRepoDir },
            );
            yield* ctx.sandbox.exec(
              'sh -c "git checkout -b branch-b main && echo line-b >> file.txt && git add file.txt && git commit -m \\"branch-b change\\""',
              { cwd: ctx.sandboxRepoDir },
            );

            // Back to temp branch — merge both (resolving the conflict on file.txt)
            yield* ctx.sandbox.exec(
              'sh -c "git checkout sandcastle/test && git merge --no-ff branch-a -m \\"Merge branch-a\\""',
              { cwd: ctx.sandboxRepoDir },
            );
            // branch-b will conflict on file.txt — resolve it manually
            yield* ctx.sandbox.exec(
              `sh -c "git merge --no-ff branch-b -m \\"Merge branch-b\\" || (printf 'original\\nline-a\\nline-b\\n' > file.txt && git add file.txt && git commit --no-edit -m \\"Merge branch-b\\")"`,
              { cwd: ctx.sandboxRepoDir },
            );
          }),
      ).pipe(Effect.provide(Layer.merge(layer, testDisplayLayer))),
    );

    // Both changes should be on the host's main branch
    const content = await readFile(join(hostDir, "file.txt"), "utf-8");
    expect(content).toContain("line-a");
    expect(content).toContain("line-b");

    expect(result.commits.length).toBeGreaterThanOrEqual(1);
    expect(result.branch).toBe("main");
  });

  it("sets host git user.name and user.email as global config in the sandbox", async () => {
    const { hostDir, worktreeDir, layer } = await setupWorktree();

    // setupWorktree sets user.email "test@test.com" and user.name "Test" locally in hostDir.
    // Verify these are propagated as --global config inside the sandbox.

    const result = await Effect.runPromise(
      withSandboxLifecycle(
        {
          hostRepoDir: hostDir,
          sandboxRepoDir: worktreeDir,
          branch: "sandcastle/test",
        },
        (ctx) =>
          Effect.gen(function* () {
            // Read the globally-set git config (--global) to confirm auto-propagation
            const emailResult = yield* ctx.sandbox.exec(
              "git config --global user.email",
            );
            const nameResult = yield* ctx.sandbox.exec(
              "git config --global user.name",
            );
            return {
              email: emailResult.stdout.trim(),
              name: nameResult.stdout.trim(),
            };
          }),
      ).pipe(Effect.provide(Layer.merge(layer, testDisplayLayer))),
    );

    expect(result.result.email).toBe("test@test.com");
    expect(result.result.name).toBe("Test");
  });

  it("gracefully skips git identity propagation when host has no git config", async () => {
    const { hostDir, worktreeDir, layer } = await setupWorktree();

    // Unset local user config so git config user.name/email returns nothing
    await execAsync("git config --unset user.email", { cwd: hostDir }).catch(
      () => {},
    );
    await execAsync("git config --unset user.name", { cwd: hostDir }).catch(
      () => {},
    );

    // Should not throw even when host has no git identity configured
    await expect(
      Effect.runPromise(
        withSandboxLifecycle(
          {
            hostRepoDir: hostDir,
            sandboxRepoDir: worktreeDir,
          },
          () => Effect.succeed("ok"),
        ).pipe(Effect.provide(Layer.merge(layer, testDisplayLayer))),
      ),
    ).resolves.toBeDefined();
  });

  it("no cherry-pick when explicit branch is given", async () => {
    const { hostDir, worktreeDir, layer } = await setupWorktree();

    const result = await Effect.runPromise(
      withSandboxLifecycle(
        {
          hostRepoDir: hostDir,
          sandboxRepoDir: worktreeDir,
          // explicit branch — commits stay on that branch, no cherry-pick
          branch: "sandcastle/test",
        },
        (ctx) =>
          Effect.gen(function* () {
            yield* ctx.sandbox.exec('git config user.email "test@test.com"', {
              cwd: ctx.sandboxRepoDir,
            });
            yield* ctx.sandbox.exec('git config user.name "Test"', {
              cwd: ctx.sandboxRepoDir,
            });
            yield* ctx.sandbox.exec(
              'sh -c "echo explicit > explicit-file.txt && git add explicit-file.txt && git commit -m \\"explicit branch commit\\""',
              { cwd: ctx.sandboxRepoDir },
            );
          }),
      ).pipe(Effect.provide(Layer.merge(layer, testDisplayLayer))),
    );

    // Branch stays as the explicit branch
    expect(result.branch).toBe("sandcastle/test");
    expect(result.commits).toHaveLength(1);

    // Commit is on sandcastle/test, NOT cherry-picked to main
    const { stdout: mainLog } = await execAsync("git log --oneline main", {
      cwd: hostDir,
    });
    expect(mainLog).not.toContain("explicit branch commit");

    const { stdout: branchLog } = await execAsync(
      'git log --oneline "sandcastle/test"',
      { cwd: hostDir },
    );
    expect(branchLog).toContain("explicit branch commit");
  });

  it("calls applyToHost after work completes but before merge operations", async () => {
    const { hostDir, worktreeDir, layer } = await setupWorktree();

    const callOrder: string[] = [];

    const result = await Effect.runPromise(
      withSandboxLifecycle(
        {
          hostRepoDir: hostDir,
          sandboxRepoDir: worktreeDir,
          applyToHost: () =>
            Effect.sync(() => {
              callOrder.push("applyToHost");
            }) as Effect.Effect<void, SyncError>,
        },
        (ctx) =>
          Effect.gen(function* () {
            callOrder.push("work");
            yield* ctx.sandbox.exec('git config user.email "test@test.com"', {
              cwd: ctx.sandboxRepoDir,
            });
            yield* ctx.sandbox.exec('git config user.name "Test"', {
              cwd: ctx.sandboxRepoDir,
            });
            yield* ctx.sandbox.exec(
              'sh -c "echo content > new.txt && git add new.txt && git commit -m \\"test commit\\""',
              { cwd: ctx.sandboxRepoDir },
            );
          }),
      ).pipe(Effect.provide(Layer.merge(layer, testDisplayLayer))),
    );

    // applyToHost should be called after work but before the merge
    expect(callOrder).toEqual(["work", "applyToHost"]);
    // Commits should still be collected properly
    expect(result.commits).toHaveLength(1);
  });

  it("records baseHead from the host worktree, not from inside the sandbox", async () => {
    const { hostDir, worktreeDir, layer } = await setupWorktree();

    // Use a container path that differs from the host worktree path
    const containerPath = "/home/agent/workspace";
    const translatingLayer = Layer.succeed(
      Sandbox,
      makePathTranslatingSandbox(worktreeDir, containerPath, layer),
    );

    let capturedBaseHead = "";
    await Effect.runPromise(
      withSandboxLifecycle(
        {
          hostRepoDir: hostDir,
          sandboxRepoDir: containerPath,
          hostWorktreePath: worktreeDir,
        },
        (ctx) =>
          Effect.gen(function* () {
            capturedBaseHead = ctx.baseHead;
          }),
      ).pipe(Effect.provide(Layer.merge(translatingLayer, testDisplayLayer))),
    );

    // baseHead should match the host worktree HEAD, not some sandbox-internal value
    const hostHead = await getHead(worktreeDir);
    expect(capturedBaseHead).toBe(hostHead);
  });

  it("applyToHost error propagates as SyncError", async () => {
    const { hostDir, worktreeDir, layer } = await setupWorktree();

    await expect(
      Effect.runPromise(
        withSandboxLifecycle(
          {
            hostRepoDir: hostDir,
            sandboxRepoDir: worktreeDir,
            applyToHost: () =>
              Effect.fail(new SyncError({ message: "sync failed" })),
          },
          () => Effect.succeed("ok"),
        ).pipe(Effect.provide(Layer.merge(layer, testDisplayLayer))),
      ),
    ).rejects.toThrow("sync failed");
  });

  it("logs 'Syncing changes to host' taskLog when applyToHost is provided", async () => {
    const { hostDir, worktreeDir, layer } = await setupWorktree();
    const displayRef = Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([]);
    const displayLayer = SilentDisplay.layer(displayRef);

    const entries = await Effect.runPromise(
      Effect.gen(function* () {
        yield* withSandboxLifecycle(
          {
            hostRepoDir: hostDir,
            sandboxRepoDir: worktreeDir,
            branch: "sandcastle/test",
            applyToHost: () => Effect.void,
          },
          () => Effect.succeed("ok"),
        );
        return yield* Ref.get(displayRef);
      }).pipe(Effect.provide(Layer.merge(layer, displayLayer))),
    );

    const syncLog = entries.find(
      (e) => e._tag === "taskLog" && e.title === "Syncing changes to host",
    );
    expect(syncLog).toBeDefined();
  });

  it("does not log 'Syncing changes to host' when applyToHost is not provided", async () => {
    const { hostDir, worktreeDir, layer } = await setupWorktree();
    const displayRef = Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([]);
    const displayLayer = SilentDisplay.layer(displayRef);

    const entries = await Effect.runPromise(
      Effect.gen(function* () {
        yield* withSandboxLifecycle(
          {
            hostRepoDir: hostDir,
            sandboxRepoDir: worktreeDir,
            branch: "sandcastle/test",
          },
          () => Effect.succeed("ok"),
        );
        return yield* Ref.get(displayRef);
      }).pipe(Effect.provide(Layer.merge(layer, displayLayer))),
    );

    const syncLog = entries.find(
      (e) => e._tag === "taskLog" && e.title === "Syncing changes to host",
    );
    expect(syncLog).toBeUndefined();
  });

  it("logs 'Merging to {branch}' taskLog in temp branch mode with commits", async () => {
    const { hostDir, worktreeDir, layer } = await setupWorktree();
    const displayRef = Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([]);
    const displayLayer = SilentDisplay.layer(displayRef);

    const entries = await Effect.runPromise(
      Effect.gen(function* () {
        yield* withSandboxLifecycle(
          {
            hostRepoDir: hostDir,
            sandboxRepoDir: worktreeDir,
          },
          (ctx) =>
            Effect.gen(function* () {
              yield* ctx.sandbox.exec('git config user.email "test@test.com"', {
                cwd: ctx.sandboxRepoDir,
              });
              yield* ctx.sandbox.exec('git config user.name "Test"', {
                cwd: ctx.sandboxRepoDir,
              });
              yield* ctx.sandbox.exec(
                'sh -c "echo content > merge-file.txt && git add merge-file.txt && git commit -m \\"merge test\\""',
                { cwd: ctx.sandboxRepoDir },
              );
            }),
        );
        return yield* Ref.get(displayRef);
      }).pipe(Effect.provide(Layer.merge(layer, displayLayer))),
    );

    const mergeLog = entries.find(
      (e) => e._tag === "taskLog" && e.title === "Merging to main",
    );
    expect(mergeLog).toBeDefined();
  });

  it("logs 'Collecting commits' taskLog after agent work", async () => {
    const { hostDir, worktreeDir, layer } = await setupWorktree();
    const displayRef = Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([]);
    const displayLayer = SilentDisplay.layer(displayRef);

    const entries = await Effect.runPromise(
      Effect.gen(function* () {
        yield* withSandboxLifecycle(
          {
            hostRepoDir: hostDir,
            sandboxRepoDir: worktreeDir,
            branch: "sandcastle/test",
          },
          () => Effect.succeed("ok"),
        );
        return yield* Ref.get(displayRef);
      }).pipe(Effect.provide(Layer.merge(layer, displayLayer))),
    );

    const commitLog = entries.find(
      (e) => e._tag === "taskLog" && e.title === "Collecting commits",
    );
    expect(commitLog).toBeDefined();
  });

  it("host.onSandboxReady hooks run on the host with worktree cwd", async () => {
    const { hostDir, worktreeDir, layer } = await setupWorktree();

    await Effect.runPromise(
      withSandboxLifecycle(
        {
          hostRepoDir: hostDir,
          sandboxRepoDir: worktreeDir,
          branch: "sandcastle/test",
          hooks: {
            host: {
              onSandboxReady: [
                { command: "echo host-hook-ran > host-marker.txt" },
              ],
            },
          },
        },
        () => Effect.succeed("ok"),
      ).pipe(Effect.provide(Layer.merge(layer, testDisplayLayer))),
    );

    // The marker should exist on the host worktree (cwd = worktreeDir)
    const content = await readFile(
      join(worktreeDir, "host-marker.txt"),
      "utf-8",
    );
    expect(content.trim()).toBe("host-hook-ran");
  });

  it("host.onSandboxReady and sandbox.onSandboxReady run in parallel", async () => {
    const { hostDir, worktreeDir, layer } = await setupWorktree();

    await Effect.runPromise(
      withSandboxLifecycle(
        {
          hostRepoDir: hostDir,
          sandboxRepoDir: worktreeDir,
          branch: "sandcastle/test",
          hooks: {
            host: {
              onSandboxReady: [{ command: "echo host-ready > host-ready.txt" }],
            },
            sandbox: {
              onSandboxReady: [
                { command: "echo sandbox-ready > sandbox-ready.txt" },
              ],
            },
          },
        },
        () => Effect.succeed("ok"),
      ).pipe(Effect.provide(Layer.merge(layer, testDisplayLayer))),
    );

    // Both markers should exist
    const hostContent = await readFile(
      join(worktreeDir, "host-ready.txt"),
      "utf-8",
    );
    expect(hostContent.trim()).toBe("host-ready");

    const sandboxContent = await readFile(
      join(worktreeDir, "sandbox-ready.txt"),
      "utf-8",
    );
    expect(sandboxContent.trim()).toBe("sandbox-ready");
  });

  it("host.onSandboxReady hook is killed when signal fires", async () => {
    const { hostDir, worktreeDir, layer } = await setupWorktree();
    const ac = new AbortController();

    const promise = Effect.runPromise(
      withSandboxLifecycle(
        {
          hostRepoDir: hostDir,
          sandboxRepoDir: worktreeDir,
          branch: "sandcastle/test",
          signal: ac.signal,
          hooks: {
            host: {
              onSandboxReady: [{ command: "sleep 60" }],
            },
          },
        },
        () => Effect.succeed("ok"),
      ).pipe(Effect.provide(Layer.merge(layer, testDisplayLayer))),
    );

    setTimeout(() => ac.abort("cancelled"), 50);
    await expect(promise).rejects.toThrow();
  });

  it("sandbox.onSandboxReady hook is killed when signal fires", async () => {
    const { hostDir, worktreeDir, layer } = await setupWorktree();
    const ac = new AbortController();

    const promise = Effect.runPromise(
      withSandboxLifecycle(
        {
          hostRepoDir: hostDir,
          sandboxRepoDir: worktreeDir,
          branch: "sandcastle/test",
          signal: ac.signal,
          hooks: {
            sandbox: {
              onSandboxReady: [{ command: "sleep 60" }],
            },
          },
        },
        () => Effect.succeed("ok"),
      ).pipe(Effect.provide(Layer.merge(layer, testDisplayLayer))),
    );

    setTimeout(() => ac.abort("cancelled"), 50);
    await expect(promise).rejects.toThrow();
  });

  it("hooks receive never-aborted signal when no signal is provided", async () => {
    const { hostDir, worktreeDir, layer } = await setupWorktree();

    // Should work normally — hooks complete without issues
    await Effect.runPromise(
      withSandboxLifecycle(
        {
          hostRepoDir: hostDir,
          sandboxRepoDir: worktreeDir,
          branch: "sandcastle/test",
          hooks: {
            host: {
              onSandboxReady: [{ command: "echo ok > host-signal-test.txt" }],
            },
            sandbox: {
              onSandboxReady: [
                { command: "echo ok > sandbox-signal-test.txt" },
              ],
            },
          },
        },
        () => Effect.succeed("ok"),
      ).pipe(Effect.provide(Layer.merge(layer, testDisplayLayer))),
    );

    const content = await readFile(
      join(worktreeDir, "host-signal-test.txt"),
      "utf-8",
    );
    expect(content.trim()).toBe("ok");
  });

  it("host.onSandboxReady hook failure propagates error", async () => {
    const { hostDir, worktreeDir, layer } = await setupWorktree();

    await expect(
      Effect.runPromise(
        withSandboxLifecycle(
          {
            hostRepoDir: hostDir,
            sandboxRepoDir: worktreeDir,
            branch: "sandcastle/test",
            hooks: {
              host: {
                onSandboxReady: [{ command: "exit 1" }],
              },
            },
          },
          () => Effect.succeed("ok"),
        ).pipe(Effect.provide(Layer.merge(layer, testDisplayLayer))),
      ),
    ).rejects.toThrow(/Host hook failed/);
  });
});

describe("runHostHooks", () => {
  it("runs hooks sequentially in declared order", async () => {
    const dir = await mkdtemp(join(tmpdir(), "host-hooks-"));

    await Effect.runPromise(
      runHostHooks(
        [
          { command: "echo first > order.txt" },
          { command: "echo second >> order.txt" },
        ],
        dir,
      ),
    );

    const content = await readFile(join(dir, "order.txt"), "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toEqual(["first", "second"]);
  });

  it("fails fast on non-zero exit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "host-hooks-"));

    await expect(
      Effect.runPromise(
        runHostHooks(
          [
            { command: "exit 1" },
            { command: "echo should-not-run > unreachable.txt" },
          ],
          dir,
        ),
      ),
    ).rejects.toThrow(/Host hook failed/);
  });

  it("uses the provided cwd", async () => {
    const dir = await mkdtemp(join(tmpdir(), "host-hooks-"));

    await Effect.runPromise(runHostHooks([{ command: "pwd > cwd.txt" }], dir));

    const content = await readFile(join(dir, "cwd.txt"), "utf-8");
    expect(content.trim()).toBe(dir);
  });

  it("aborts a running hook when signal fires", async () => {
    const dir = await mkdtemp(join(tmpdir(), "host-hooks-"));
    const ac = new AbortController();

    // Start a long-running hook then abort after a short delay
    const promise = Effect.runPromise(
      runHostHooks([{ command: "sleep 60" }], dir, ac.signal),
    );

    // Give the process time to start, then abort
    setTimeout(() => ac.abort("cancelled"), 50);

    await expect(promise).rejects.toThrow();
  });

  it("works normally when signal is not provided", async () => {
    const dir = await mkdtemp(join(tmpdir(), "host-hooks-"));

    // No signal arg — should work as before
    await Effect.runPromise(
      runHostHooks([{ command: "echo ok > result.txt" }], dir),
    );

    const content = await readFile(join(dir, "result.txt"), "utf-8");
    expect(content.trim()).toBe("ok");
  });
});
