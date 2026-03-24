import { Effect } from "effect";
import { exec } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { readConfig } from "./Config.js";
import { FilesystemSandbox } from "./FilesystemSandbox.js";
import { runHooks, syncIn, syncOut } from "./SyncService.js";

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

const getBranch = async (dir: string) => {
  const { stdout } = await execAsync("git rev-parse --abbrev-ref HEAD", {
    cwd: dir,
  });
  return stdout.trim();
};

const setup = async () => {
  const hostDir = await mkdtemp(join(tmpdir(), "host-"));
  const sandboxDir = await mkdtemp(join(tmpdir(), "sandbox-"));
  const sandboxRepoDir = join(sandboxDir, "repo");
  const layer = FilesystemSandbox.layer(sandboxDir);
  return { hostDir, sandboxDir, sandboxRepoDir, layer };
};

describe("syncIn", () => {
  it("clean repo syncs correctly — sandbox HEAD matches host HEAD", async () => {
    const { hostDir, sandboxRepoDir, layer } = await setup();
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    await Effect.runPromise(
      syncIn(hostDir, sandboxRepoDir).pipe(Effect.provide(layer)),
    );

    expect(await getHead(sandboxRepoDir)).toBe(await getHead(hostDir));

    const content = await readFile(join(sandboxRepoDir, "hello.txt"), "utf-8");
    expect(content).toBe("hello");
  });

  it("repo with unpushed commits — bundle captures them", async () => {
    const { hostDir, sandboxRepoDir, layer } = await setup();
    await initRepo(hostDir);
    await commitFile(hostDir, "a.txt", "a", "first");
    await commitFile(hostDir, "b.txt", "b", "second");
    await commitFile(hostDir, "c.txt", "c", "third");

    await Effect.runPromise(
      syncIn(hostDir, sandboxRepoDir).pipe(Effect.provide(layer)),
    );

    expect(await getHead(sandboxRepoDir)).toBe(await getHead(hostDir));
    expect(await readFile(join(sandboxRepoDir, "a.txt"), "utf-8")).toBe("a");
    expect(await readFile(join(sandboxRepoDir, "b.txt"), "utf-8")).toBe("b");
    expect(await readFile(join(sandboxRepoDir, "c.txt"), "utf-8")).toBe("c");

    // Verify commit history is preserved
    const { stdout } = await execAsync("git log --oneline", {
      cwd: sandboxRepoDir,
    });
    expect(stdout.trim().split("\n")).toHaveLength(3);
  });

  it("repo with uncommitted changes — sandbox gets committed state only", async () => {
    const { hostDir, sandboxRepoDir, layer } = await setup();
    await initRepo(hostDir);
    await commitFile(hostDir, "committed.txt", "committed", "initial");

    // Add uncommitted changes on host
    await writeFile(join(hostDir, "untracked.txt"), "untracked");
    await writeFile(join(hostDir, "committed.txt"), "modified but uncommitted");

    await Effect.runPromise(
      syncIn(hostDir, sandboxRepoDir).pipe(Effect.provide(layer)),
    );

    // Sandbox has committed state only
    const content = await readFile(
      join(sandboxRepoDir, "committed.txt"),
      "utf-8",
    );
    expect(content).toBe("committed");

    // Untracked file should not exist in sandbox
    const { stdout } = await execAsync("ls", { cwd: sandboxRepoDir });
    expect(stdout).not.toContain("untracked.txt");
  });

  it("re-sync after sandbox has diverged — sandbox resets to host state", async () => {
    const { hostDir, sandboxRepoDir, layer } = await setup();
    await initRepo(hostDir);
    await commitFile(hostDir, "original.txt", "original", "initial");

    // First sync
    await Effect.runPromise(
      syncIn(hostDir, sandboxRepoDir).pipe(Effect.provide(layer)),
    );

    // Configure git in sandbox for committing
    await execAsync('git config user.email "test@test.com"', {
      cwd: sandboxRepoDir,
    });
    await execAsync('git config user.name "Test"', { cwd: sandboxRepoDir });

    // Make divergent changes in sandbox
    await commitFile(
      sandboxRepoDir,
      "sandbox-only.txt",
      "sandbox",
      "sandbox commit",
    );
    await writeFile(join(sandboxRepoDir, "untracked.txt"), "untracked");

    // Add new commit on host
    await commitFile(hostDir, "host-new.txt", "new", "host new commit");

    // Re-sync
    await Effect.runPromise(
      syncIn(hostDir, sandboxRepoDir).pipe(Effect.provide(layer)),
    );

    // Sandbox HEAD matches host
    expect(await getHead(sandboxRepoDir)).toBe(await getHead(hostDir));

    // Host's new file is present
    expect(await readFile(join(sandboxRepoDir, "host-new.txt"), "utf-8")).toBe(
      "new",
    );

    // Sandbox-only file and untracked file are gone
    const { stdout: status } = await execAsync("git status --porcelain", {
      cwd: sandboxRepoDir,
    });
    expect(status.trim()).toBe("");

    const { stdout: files } = await execAsync("ls", { cwd: sandboxRepoDir });
    expect(files).not.toContain("sandbox-only.txt");
    expect(files).not.toContain("untracked.txt");
  });

  it("host on non-main branch — sandbox checks out that branch", async () => {
    const { hostDir, sandboxRepoDir, layer } = await setup();
    await initRepo(hostDir);
    await commitFile(hostDir, "base.txt", "base", "initial on main");

    // Create and switch to a feature branch
    await execAsync("git checkout -b feature-xyz", { cwd: hostDir });
    await commitFile(hostDir, "feature.txt", "feature", "feature commit");

    const result = await Effect.runPromise(
      syncIn(hostDir, sandboxRepoDir).pipe(Effect.provide(layer)),
    );

    expect(result.branch).toBe("feature-xyz");
    expect(await getBranch(sandboxRepoDir)).toBe("feature-xyz");
    expect(await getHead(sandboxRepoDir)).toBe(await getHead(hostDir));
    expect(await readFile(join(sandboxRepoDir, "feature.txt"), "utf-8")).toBe(
      "feature",
    );
  });

  it("branch with commits ahead of main — sandbox has divergent history", async () => {
    const { hostDir, sandboxRepoDir, layer } = await setup();
    await initRepo(hostDir);
    await commitFile(hostDir, "base.txt", "base", "initial on main");

    await execAsync("git checkout -b ahead-branch", { cwd: hostDir });
    await commitFile(hostDir, "one.txt", "one", "branch commit 1");
    await commitFile(hostDir, "two.txt", "two", "branch commit 2");

    const result = await Effect.runPromise(
      syncIn(hostDir, sandboxRepoDir).pipe(Effect.provide(layer)),
    );

    expect(result.branch).toBe("ahead-branch");
    expect(await getBranch(sandboxRepoDir)).toBe("ahead-branch");
    expect(await getHead(sandboxRepoDir)).toBe(await getHead(hostDir));

    // Both branch commits are present
    const { stdout } = await execAsync("git log --oneline", {
      cwd: sandboxRepoDir,
    });
    expect(stdout).toContain("branch commit 1");
    expect(stdout).toContain("branch commit 2");

    // Files from branch exist
    expect(await readFile(join(sandboxRepoDir, "one.txt"), "utf-8")).toBe(
      "one",
    );
    expect(await readFile(join(sandboxRepoDir, "two.txt"), "utf-8")).toBe(
      "two",
    );
  });

  it("re-sync after host switches branches — sandbox follows to new branch", async () => {
    const { hostDir, sandboxRepoDir, layer } = await setup();
    await initRepo(hostDir);
    await commitFile(hostDir, "base.txt", "base", "initial on main");

    // First sync on feature-a
    await execAsync("git checkout -b feature-a", { cwd: hostDir });
    await commitFile(hostDir, "a.txt", "a", "commit on a");

    await Effect.runPromise(
      syncIn(hostDir, sandboxRepoDir).pipe(Effect.provide(layer)),
    );
    expect(await getBranch(sandboxRepoDir)).toBe("feature-a");

    // Host switches to feature-b
    await execAsync("git checkout main", { cwd: hostDir });
    await execAsync("git checkout -b feature-b", { cwd: hostDir });
    await commitFile(hostDir, "b.txt", "b", "commit on b");

    // Re-sync
    const result = await Effect.runPromise(
      syncIn(hostDir, sandboxRepoDir).pipe(Effect.provide(layer)),
    );

    expect(result.branch).toBe("feature-b");
    expect(await getBranch(sandboxRepoDir)).toBe("feature-b");
    expect(await getHead(sandboxRepoDir)).toBe(await getHead(hostDir));
  });
});

const initSandboxGit = async (sandboxRepoDir: string) => {
  await execAsync('git config user.email "test@test.com"', {
    cwd: sandboxRepoDir,
  });
  await execAsync('git config user.name "Test"', { cwd: sandboxRepoDir });
};

const syncInAndGetBase = async (
  hostDir: string,
  sandboxRepoDir: string,
  layer: ReturnType<typeof FilesystemSandbox.layer>,
) => {
  await Effect.runPromise(
    syncIn(hostDir, sandboxRepoDir).pipe(Effect.provide(layer)),
  );
  return await getHead(hostDir);
};

describe("syncOut", () => {
  it("single new commit — patch applies cleanly on host", async () => {
    const { hostDir, sandboxRepoDir, layer } = await setup();
    await initRepo(hostDir);
    await commitFile(hostDir, "initial.txt", "initial", "initial commit");

    const baseHead = await syncInAndGetBase(hostDir, sandboxRepoDir, layer);
    await initSandboxGit(sandboxRepoDir);

    await commitFile(
      sandboxRepoDir,
      "new-file.txt",
      "from sandbox",
      "sandbox commit",
    );

    await Effect.runPromise(
      syncOut(hostDir, sandboxRepoDir, baseHead).pipe(Effect.provide(layer)),
    );

    const content = await readFile(join(hostDir, "new-file.txt"), "utf-8");
    expect(content).toBe("from sandbox");

    const { stdout } = await execAsync("git log --oneline", { cwd: hostDir });
    expect(stdout).toContain("sandbox commit");
  });

  it("multiple new commits — all patches apply in order", async () => {
    const { hostDir, sandboxRepoDir, layer } = await setup();
    await initRepo(hostDir);
    await commitFile(hostDir, "initial.txt", "initial", "initial commit");

    const baseHead = await syncInAndGetBase(hostDir, sandboxRepoDir, layer);
    await initSandboxGit(sandboxRepoDir);

    await commitFile(sandboxRepoDir, "a.txt", "a", "first sandbox commit");
    await commitFile(sandboxRepoDir, "b.txt", "b", "second sandbox commit");
    await commitFile(sandboxRepoDir, "c.txt", "c", "third sandbox commit");

    await Effect.runPromise(
      syncOut(hostDir, sandboxRepoDir, baseHead).pipe(Effect.provide(layer)),
    );

    expect(await readFile(join(hostDir, "a.txt"), "utf-8")).toBe("a");
    expect(await readFile(join(hostDir, "b.txt"), "utf-8")).toBe("b");
    expect(await readFile(join(hostDir, "c.txt"), "utf-8")).toBe("c");

    const { stdout } = await execAsync("git log --oneline", { cwd: hostDir });
    const lines = stdout.trim().split("\n");
    expect(lines).toHaveLength(4); // initial + 3 sandbox commits
    expect(lines[0]).toContain("third sandbox commit");
    expect(lines[1]).toContain("second sandbox commit");
    expect(lines[2]).toContain("first sandbox commit");
  });

  it("uncommitted staged changes come back", async () => {
    const { hostDir, sandboxRepoDir, layer } = await setup();
    await initRepo(hostDir);
    await commitFile(hostDir, "file.txt", "original", "initial commit");

    const baseHead = await syncInAndGetBase(hostDir, sandboxRepoDir, layer);

    // Stage a change in sandbox (but don't commit)
    await writeFile(join(sandboxRepoDir, "file.txt"), "modified in sandbox");
    await execAsync("git add file.txt", { cwd: sandboxRepoDir });

    await Effect.runPromise(
      syncOut(hostDir, sandboxRepoDir, baseHead).pipe(Effect.provide(layer)),
    );

    const content = await readFile(join(hostDir, "file.txt"), "utf-8");
    expect(content).toBe("modified in sandbox");
  });

  it("uncommitted unstaged changes come back", async () => {
    const { hostDir, sandboxRepoDir, layer } = await setup();
    await initRepo(hostDir);
    await commitFile(hostDir, "file.txt", "original", "initial commit");

    const baseHead = await syncInAndGetBase(hostDir, sandboxRepoDir, layer);

    // Modify without staging
    await writeFile(join(sandboxRepoDir, "file.txt"), "unstaged change");

    await Effect.runPromise(
      syncOut(hostDir, sandboxRepoDir, baseHead).pipe(Effect.provide(layer)),
    );

    const content = await readFile(join(hostDir, "file.txt"), "utf-8");
    expect(content).toBe("unstaged change");
  });

  it("untracked files come back", async () => {
    const { hostDir, sandboxRepoDir, layer } = await setup();
    await initRepo(hostDir);
    await commitFile(hostDir, "file.txt", "original", "initial commit");

    const baseHead = await syncInAndGetBase(hostDir, sandboxRepoDir, layer);

    // Create untracked file in sandbox
    await writeFile(join(sandboxRepoDir, "untracked.txt"), "new file");

    await Effect.runPromise(
      syncOut(hostDir, sandboxRepoDir, baseHead).pipe(Effect.provide(layer)),
    );

    const content = await readFile(join(hostDir, "untracked.txt"), "utf-8");
    expect(content).toBe("new file");
  });

  it("no changes in sandbox — no-op, no error", async () => {
    const { hostDir, sandboxRepoDir, layer } = await setup();
    await initRepo(hostDir);
    await commitFile(hostDir, "file.txt", "original", "initial commit");

    const baseHead = await syncInAndGetBase(hostDir, sandboxRepoDir, layer);

    // No changes made in sandbox
    await Effect.runPromise(
      syncOut(hostDir, sandboxRepoDir, baseHead).pipe(Effect.provide(layer)),
    );

    // Host is unchanged
    expect(await getHead(hostDir)).toBe(baseHead);
    const content = await readFile(join(hostDir, "file.txt"), "utf-8");
    expect(content).toBe("original");
  });
});

describe("round-trip", () => {
  it("sync-in, make commit in sandbox, sync-out — host has the new commit", async () => {
    const { hostDir, sandboxRepoDir, layer } = await setup();
    await initRepo(hostDir);
    await commitFile(hostDir, "file.txt", "original", "initial commit");

    const baseHead = await syncInAndGetBase(hostDir, sandboxRepoDir, layer);
    await initSandboxGit(sandboxRepoDir);

    // Make a commit in sandbox
    await commitFile(
      sandboxRepoDir,
      "feature.txt",
      "new feature",
      "add feature",
    );

    // Sync out
    await Effect.runPromise(
      syncOut(hostDir, sandboxRepoDir, baseHead).pipe(Effect.provide(layer)),
    );

    // Host should have the new commit and file
    const content = await readFile(join(hostDir, "feature.txt"), "utf-8");
    expect(content).toBe("new feature");

    const { stdout } = await execAsync("git log --oneline", { cwd: hostDir });
    expect(stdout).toContain("add feature");

    // Original file still intact
    const original = await readFile(join(hostDir, "file.txt"), "utf-8");
    expect(original).toBe("original");
  });

  it("sync-in, sync-out, sync-in again — stable, no drift", async () => {
    const { hostDir, sandboxRepoDir, layer } = await setup();
    await initRepo(hostDir);
    await commitFile(hostDir, "file.txt", "original", "initial commit");

    // First round-trip: sync-in, then sync-out with no changes
    const baseHead1 = await syncInAndGetBase(hostDir, sandboxRepoDir, layer);
    await Effect.runPromise(
      syncOut(hostDir, sandboxRepoDir, baseHead1).pipe(Effect.provide(layer)),
    );

    // Second sync-in
    await Effect.runPromise(
      syncIn(hostDir, sandboxRepoDir).pipe(Effect.provide(layer)),
    );

    // Sandbox should still match host exactly
    expect(await getHead(sandboxRepoDir)).toBe(await getHead(hostDir));

    const content = await readFile(join(sandboxRepoDir, "file.txt"), "utf-8");
    expect(content).toBe("original");

    // Working tree should be clean
    const { stdout } = await execAsync("git status --porcelain", {
      cwd: sandboxRepoDir,
    });
    expect(stdout.trim()).toBe("");
  });

  it("round-trip on non-main branch — patches apply to correct branch on host", async () => {
    const { hostDir, sandboxRepoDir, layer } = await setup();
    await initRepo(hostDir);
    await commitFile(hostDir, "base.txt", "base", "initial on main");

    // Host switches to feature branch
    await execAsync("git checkout -b feature-round-trip", { cwd: hostDir });
    await commitFile(hostDir, "on-branch.txt", "branch", "branch commit");

    const result = await Effect.runPromise(
      syncIn(hostDir, sandboxRepoDir).pipe(Effect.provide(layer)),
    );
    const baseHead = await getHead(sandboxRepoDir);
    expect(result.branch).toBe("feature-round-trip");

    // Agent makes a commit in the sandbox
    await initSandboxGit(sandboxRepoDir);
    await commitFile(
      sandboxRepoDir,
      "agent-work.txt",
      "agent output",
      "agent commit",
    );

    // Sync out
    await Effect.runPromise(
      syncOut(hostDir, sandboxRepoDir, baseHead).pipe(Effect.provide(layer)),
    );

    // Host should still be on the feature branch
    expect(await getBranch(hostDir)).toBe("feature-round-trip");

    // Agent's commit landed on the feature branch
    const content = await readFile(join(hostDir, "agent-work.txt"), "utf-8");
    expect(content).toBe("agent output");

    const { stdout: log } = await execAsync("git log --oneline", {
      cwd: hostDir,
    });
    expect(log).toContain("agent commit");
    expect(log).toContain("branch commit");
  });
});

describe("parallel host commits", () => {
  it("non-conflicting host commit between sync-in and sync-out — both changes present", async () => {
    const { hostDir, sandboxRepoDir, layer } = await setup();
    await initRepo(hostDir);
    await commitFile(hostDir, "initial.txt", "initial", "initial commit");

    const baseHead = await syncInAndGetBase(hostDir, sandboxRepoDir, layer);
    await initSandboxGit(sandboxRepoDir);

    // Sandbox commits to a new file
    await commitFile(
      sandboxRepoDir,
      "sandbox-feature.txt",
      "sandbox work",
      "sandbox feature commit",
    );

    // Meanwhile, host commits to a different file
    await commitFile(
      hostDir,
      "host-feature.txt",
      "host work",
      "host feature commit",
    );

    // syncOut should succeed — changes don't conflict
    await Effect.runPromise(
      syncOut(hostDir, sandboxRepoDir, baseHead).pipe(Effect.provide(layer)),
    );

    // Both files should be present on host
    const sandboxContent = await readFile(
      join(hostDir, "sandbox-feature.txt"),
      "utf-8",
    );
    expect(sandboxContent).toBe("sandbox work");

    const hostContent = await readFile(
      join(hostDir, "host-feature.txt"),
      "utf-8",
    );
    expect(hostContent).toBe("host work");

    // Both commits should be in history
    const { stdout } = await execAsync("git log --oneline", { cwd: hostDir });
    expect(stdout).toContain("sandbox feature commit");
    expect(stdout).toContain("host feature commit");
  });

  it("host commit + sandbox uncommitted changes to different files — both present", async () => {
    const { hostDir, sandboxRepoDir, layer } = await setup();
    await initRepo(hostDir);
    await commitFile(hostDir, "initial.txt", "initial", "initial commit");

    const baseHead = await syncInAndGetBase(hostDir, sandboxRepoDir, layer);

    // Sandbox makes uncommitted changes (no commit)
    await writeFile(join(sandboxRepoDir, "initial.txt"), "modified in sandbox");

    // Host commits to a different file
    await commitFile(
      hostDir,
      "host-feature.txt",
      "host work",
      "host feature commit",
    );

    // syncOut should succeed
    await Effect.runPromise(
      syncOut(hostDir, sandboxRepoDir, baseHead).pipe(Effect.provide(layer)),
    );

    // Both changes should be present
    const sandboxContent = await readFile(
      join(hostDir, "initial.txt"),
      "utf-8",
    );
    expect(sandboxContent).toBe("modified in sandbox");

    const hostContent = await readFile(
      join(hostDir, "host-feature.txt"),
      "utf-8",
    );
    expect(hostContent).toBe("host work");
  });

  it("host commit + sandbox untracked files — both present", async () => {
    const { hostDir, sandboxRepoDir, layer } = await setup();
    await initRepo(hostDir);
    await commitFile(hostDir, "initial.txt", "initial", "initial commit");

    const baseHead = await syncInAndGetBase(hostDir, sandboxRepoDir, layer);

    // Sandbox creates untracked file
    await writeFile(
      join(sandboxRepoDir, "sandbox-untracked.txt"),
      "untracked content",
    );

    // Host commits to a different file
    await commitFile(
      hostDir,
      "host-feature.txt",
      "host work",
      "host feature commit",
    );

    // syncOut should succeed
    await Effect.runPromise(
      syncOut(hostDir, sandboxRepoDir, baseHead).pipe(Effect.provide(layer)),
    );

    // Both should be present
    const untrackedContent = await readFile(
      join(hostDir, "sandbox-untracked.txt"),
      "utf-8",
    );
    expect(untrackedContent).toBe("untracked content");

    const hostContent = await readFile(
      join(hostDir, "host-feature.txt"),
      "utf-8",
    );
    expect(hostContent).toBe("host work");
  });
});

describe("failure cases", () => {
  it("patch conflict — host changed between sync-in and sync-out", async () => {
    const { hostDir, sandboxRepoDir, layer } = await setup();
    await initRepo(hostDir);
    await commitFile(hostDir, "shared.txt", "original", "initial commit");

    const baseHead = await syncInAndGetBase(hostDir, sandboxRepoDir, layer);
    await initSandboxGit(sandboxRepoDir);

    // Sandbox modifies shared.txt
    await writeFile(join(sandboxRepoDir, "shared.txt"), "sandbox version");
    await execAsync("git add shared.txt", { cwd: sandboxRepoDir });
    await execAsync('git commit -m "sandbox edit"', { cwd: sandboxRepoDir });

    // Host also modifies shared.txt (creating a conflict)
    await writeFile(join(hostDir, "shared.txt"), "host version");
    await execAsync("git add shared.txt", { cwd: hostDir });
    await execAsync('git commit -m "host edit"', { cwd: hostDir });

    // syncOut should fail due to patch conflict
    const result = Effect.runPromise(
      syncOut(hostDir, sandboxRepoDir, baseHead).pipe(Effect.provide(layer)),
    );
    await expect(result).rejects.toThrow();
  });

  it("empty repo / initial commit edge case", async () => {
    const { hostDir, sandboxRepoDir, layer } = await setup();
    await initRepo(hostDir);

    // Create a single initial commit (minimal repo)
    await commitFile(hostDir, "readme.txt", "hello", "initial commit");

    // Sync-in should work
    await Effect.runPromise(
      syncIn(hostDir, sandboxRepoDir).pipe(Effect.provide(layer)),
    );

    expect(await getHead(sandboxRepoDir)).toBe(await getHead(hostDir));

    // Sync-out with no changes should be a no-op
    const baseHead = await getHead(hostDir);
    await Effect.runPromise(
      syncOut(hostDir, sandboxRepoDir, baseHead).pipe(Effect.provide(layer)),
    );

    // Host unchanged
    expect(await getHead(hostDir)).toBe(baseHead);
    const content = await readFile(join(hostDir, "readme.txt"), "utf-8");
    expect(content).toBe("hello");
  });
});

describe("readConfig", () => {
  it("reads .sandcastle/config.json with hooks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "config-"));
    await mkdir(join(dir, ".sandcastle"), { recursive: true });
    await writeFile(
      join(dir, ".sandcastle", "config.json"),
      JSON.stringify({
        hooks: { onSandboxReady: [{ command: "npm install" }] },
      }),
    );

    const config = await Effect.runPromise(readConfig(dir));
    expect(config.hooks?.onSandboxReady?.[0]?.command).toBe("npm install");
  });

  it("returns empty config when file is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "config-"));

    const config = await Effect.runPromise(readConfig(dir));
    expect(config.hooks).toBeUndefined();
  });

  it("returns empty config when file has no hooks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "config-"));
    await mkdir(join(dir, ".sandcastle"), { recursive: true });
    await writeFile(
      join(dir, ".sandcastle", "config.json"),
      JSON.stringify({}),
    );

    const config = await Effect.runPromise(readConfig(dir));
    expect(config.hooks).toBeUndefined();
  });
});

describe("git remotes", () => {
  it("single remote — sandbox has the same remote as host", async () => {
    const { hostDir, sandboxRepoDir, layer } = await setup();
    await initRepo(hostDir);
    await execAsync("git remote add origin https://github.com/foo/bar.git", {
      cwd: hostDir,
    });
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    await Effect.runPromise(
      syncIn(hostDir, sandboxRepoDir).pipe(Effect.provide(layer)),
    );

    const { stdout } = await execAsync("git remote -v", {
      cwd: sandboxRepoDir,
    });
    const lines = stdout.trim().split("\n");
    const fetchLine = lines.find((l) => l.includes("(fetch)"));
    const pushLine = lines.find((l) => l.includes("(push)"));
    expect(fetchLine).toContain("origin");
    expect(fetchLine).toContain("https://github.com/foo/bar.git");
    expect(pushLine).toContain("origin");
    expect(pushLine).toContain("https://github.com/foo/bar.git");
  });

  it("multiple remotes — sandbox has all host remotes", async () => {
    const { hostDir, sandboxRepoDir, layer } = await setup();
    await initRepo(hostDir);
    await execAsync("git remote add origin https://github.com/foo/bar.git", {
      cwd: hostDir,
    });
    await execAsync(
      "git remote add upstream https://github.com/upstream/bar.git",
      { cwd: hostDir },
    );
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    await Effect.runPromise(
      syncIn(hostDir, sandboxRepoDir).pipe(Effect.provide(layer)),
    );

    const { stdout } = await execAsync("git remote -v", {
      cwd: sandboxRepoDir,
    });

    // Parse into a map of remote name -> fetch URL
    const remotes = new Map<string, string>();
    for (const line of stdout.trim().split("\n")) {
      const match = line.match(/^(\S+)\t(\S+)\s+\(fetch\)$/);
      if (match) remotes.set(match[1]!, match[2]!);
    }

    expect(remotes.get("origin")).toBe("https://github.com/foo/bar.git");
    expect(remotes.get("upstream")).toBe("https://github.com/upstream/bar.git");
    expect(remotes.size).toBe(2);
  });
});

describe("hooks", () => {
  it("onSandboxReady hooks run after sync-in and effects are visible", async () => {
    const { hostDir, sandboxRepoDir, layer } = await setup();
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    await Effect.runPromise(
      syncIn(hostDir, sandboxRepoDir).pipe(Effect.provide(layer)),
    );

    const hooks = [{ command: "echo done > setup-marker.txt" }];
    await Effect.runPromise(
      runHooks(hooks, { cwd: sandboxRepoDir }).pipe(Effect.provide(layer)),
    );

    const marker = await readFile(
      join(sandboxRepoDir, "setup-marker.txt"),
      "utf-8",
    );
    expect(marker.trim()).toBe("done");
  });

  it("runHooks is a no-op when hooks is undefined", async () => {
    const { layer } = await setup();

    await Effect.runPromise(runHooks(undefined).pipe(Effect.provide(layer)));
  });

  it("runHooks is a no-op when hooks is empty array", async () => {
    const { layer } = await setup();

    await Effect.runPromise(
      runHooks([], { cwd: "/tmp" }).pipe(Effect.provide(layer)),
    );
  });

  it("runHooks fails on non-zero exit code", async () => {
    const { hostDir, sandboxRepoDir, layer } = await setup();
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    await Effect.runPromise(
      syncIn(hostDir, sandboxRepoDir).pipe(Effect.provide(layer)),
    );

    const hooks = [{ command: "exit 1" }];
    await expect(
      Effect.runPromise(
        runHooks(hooks, { cwd: sandboxRepoDir }).pipe(Effect.provide(layer)),
      ),
    ).rejects.toThrow();
  });

  it("runHooks executes sequentially in order", async () => {
    const { hostDir, sandboxRepoDir, layer } = await setup();
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    await Effect.runPromise(
      syncIn(hostDir, sandboxRepoDir).pipe(Effect.provide(layer)),
    );

    const hooks = [
      { command: "echo first > order.txt" },
      { command: "echo second >> order.txt" },
    ];
    await Effect.runPromise(
      runHooks(hooks, { cwd: sandboxRepoDir }).pipe(Effect.provide(layer)),
    );

    const content = await readFile(join(sandboxRepoDir, "order.txt"), "utf-8");
    expect(content.trim()).toBe("first\nsecond");
  });
});
