import { Effect } from "effect";
import { exec } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { readConfig } from "./Config.js";
import { FilesystemSandbox } from "./FilesystemSandbox.js";
import { syncIn, syncOut } from "./SyncService.js";

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

describe("readConfig", () => {
  it("reads .sandcastle.json with postSyncIn", async () => {
    const dir = await mkdtemp(join(tmpdir(), "config-"));
    await writeFile(
      join(dir, ".sandcastle.json"),
      JSON.stringify({ postSyncIn: "npm install" }),
    );

    const config = await Effect.runPromise(readConfig(dir));
    expect(config.postSyncIn).toBe("npm install");
  });

  it("returns empty config when file is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "config-"));

    const config = await Effect.runPromise(readConfig(dir));
    expect(config.postSyncIn).toBeUndefined();
  });

  it("returns empty config when file has no postSyncIn", async () => {
    const dir = await mkdtemp(join(tmpdir(), "config-"));
    await writeFile(join(dir, ".sandcastle.json"), JSON.stringify({}));

    const config = await Effect.runPromise(readConfig(dir));
    expect(config.postSyncIn).toBeUndefined();
  });
});

describe("postSyncIn", () => {
  it("postSyncIn command runs after sync-in and its effects are visible", async () => {
    const { hostDir, sandboxRepoDir, layer } = await setup();
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    const config = { postSyncIn: "echo done > setup-marker.txt" };

    await Effect.runPromise(
      syncIn(hostDir, sandboxRepoDir, config).pipe(Effect.provide(layer)),
    );

    const marker = await readFile(
      join(sandboxRepoDir, "setup-marker.txt"),
      "utf-8",
    );
    expect(marker.trim()).toBe("done");
  });

  it("sync-in works without config (no postSyncIn)", async () => {
    const { hostDir, sandboxRepoDir, layer } = await setup();
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    await Effect.runPromise(
      syncIn(hostDir, sandboxRepoDir).pipe(Effect.provide(layer)),
    );

    expect(await getHead(sandboxRepoDir)).toBe(await getHead(hostDir));
  });
});
