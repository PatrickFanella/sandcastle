import { exec, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Layer } from "effect";
import { describe, expect, it } from "vitest";
import { createWorkspace } from "./createWorkspace.js";
import type {
  CreateWorkspaceOptions,
  WorkspaceCreateSandboxOptions,
} from "./createWorkspace.js";
import { claudeCode } from "./AgentProvider.js";
import {
  createBindMountSandboxProvider,
  type BindMountSandboxHandle,
  type InteractiveExecOptions,
  type SandboxProvider,
} from "./SandboxProvider.js";
import { makeLocalSandboxLayer } from "./testSandbox.js";
import { Sandbox as SandboxTag } from "./SandboxFactory.js";

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

describe("createWorkspace", () => {
  it("creates a workspace with 'branch' strategy", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "ws-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const ws = await createWorkspace({
      branchStrategy: { type: "branch", branch: "test-branch" },
      _test: { hostRepoDir: hostDir },
    });

    try {
      expect(ws.workspacePath).toContain(".sandcastle/worktrees");
      expect(ws.branch).toBe("test-branch");
      expect(existsSync(ws.workspacePath)).toBe(true);
    } finally {
      await ws.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("creates a workspace with 'merge-to-head' strategy", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "ws-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const ws = await createWorkspace({
      branchStrategy: { type: "merge-to-head" },
      _test: { hostRepoDir: hostDir },
    });

    try {
      expect(ws.workspacePath).toContain(".sandcastle/worktrees");
      expect(ws.branch).toMatch(/^sandcastle\//);
      expect(existsSync(ws.workspacePath)).toBe(true);
    } finally {
      await ws.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("rejects 'head' branch strategy at the type level", () => {
    const _options: CreateWorkspaceOptions = {
      // @ts-expect-error - head strategy should be a compile-time error
      branchStrategy: { type: "head" },
    };
  });

  it("copies files into the workspace with copyToWorkspace", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "ws-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    // Create a file to copy
    await writeFile(join(hostDir, "node_modules.txt"), "deps");

    const ws = await createWorkspace({
      branchStrategy: { type: "branch", branch: "copy-test" },
      copyToWorkspace: ["node_modules.txt"],
      _test: { hostRepoDir: hostDir },
    });

    try {
      expect(existsSync(join(ws.workspacePath, "node_modules.txt"))).toBe(true);
    } finally {
      await ws.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("close() removes worktree when clean", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "ws-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const ws = await createWorkspace({
      branchStrategy: { type: "branch", branch: "clean-close" },
      _test: { hostRepoDir: hostDir },
    });

    const worktreePath = ws.workspacePath;
    const result = await ws.close();

    expect(result.preservedWorkspacePath).toBeUndefined();
    expect(existsSync(worktreePath)).toBe(false);
    await rm(hostDir, { recursive: true, force: true });
  });

  it("close() preserves worktree when dirty", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "ws-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const ws = await createWorkspace({
      branchStrategy: { type: "branch", branch: "dirty-close" },
      _test: { hostRepoDir: hostDir },
    });

    // Make workspace dirty
    await writeFile(join(ws.workspacePath, "dirty.txt"), "uncommitted");

    const result = await ws.close();

    expect(result.preservedWorkspacePath).toBe(ws.workspacePath);
    expect(existsSync(ws.workspacePath)).toBe(true);

    // Clean up manually
    await rm(ws.workspacePath, { recursive: true, force: true });
    await execAsync("git worktree prune", { cwd: hostDir });
    await rm(hostDir, { recursive: true, force: true });
  });

  it("Symbol.asyncDispose works via await using", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "ws-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    let worktreePath: string;
    {
      await using ws = await createWorkspace({
        branchStrategy: { type: "branch", branch: "dispose-test" },
        _test: { hostRepoDir: hostDir },
      });
      worktreePath = ws.workspacePath;
      expect(existsSync(worktreePath)).toBe(true);
    }
    expect(existsSync(worktreePath!)).toBe(false);
    await rm(hostDir, { recursive: true, force: true });
  });

  it("close() is idempotent", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "ws-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const ws = await createWorkspace({
      branchStrategy: { type: "branch", branch: "idempotent-close" },
      _test: { hostRepoDir: hostDir },
    });

    const result1 = await ws.close();
    const result2 = await ws.close();

    expect(result1.preservedWorkspacePath).toBeUndefined();
    expect(result2.preservedWorkspacePath).toBeUndefined();
    await rm(hostDir, { recursive: true, force: true });
  });
});

describe("workspace.interactive()", () => {
  /**
   * Create a test bind-mount provider with a fake interactiveExec.
   */
  const makeTestProvider = (
    fakeInteractiveExec: (
      args: string[],
      opts: InteractiveExecOptions,
    ) => Promise<{ exitCode: number }>,
  ) =>
    createBindMountSandboxProvider({
      name: "test-interactive",
      create: async (options) => {
        const handle: BindMountSandboxHandle = {
          workspacePath: options.workspacePath,
          exec: async (command) => {
            const result = execSync(command, {
              cwd: options.workspacePath,
              encoding: "utf-8",
              stdio: ["pipe", "pipe", "pipe"],
            });
            return { stdout: result, stderr: "", exitCode: 0 };
          },
          interactiveExec: fakeInteractiveExec,
          close: async () => {},
        };
        return handle;
      },
    });

  it("runs interactive session and returns result shape", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "ws-interactive-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const provider = makeTestProvider(async (_args, _opts) => {
      return { exitCode: 0 };
    });

    const ws = await createWorkspace({
      branchStrategy: { type: "branch", branch: "interactive-test" },
      _test: { hostRepoDir: hostDir },
    });

    try {
      const result = await ws.interactive({
        agent: claudeCode("claude-opus-4-6"),
        sandbox: provider,
        prompt: "test prompt",
      });

      expect(result).toHaveProperty("exitCode");
      expect(result).toHaveProperty("branch");
      expect(result).toHaveProperty("commits");
      expect(typeof result.branch).toBe("string");
    } finally {
      await ws.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("accepts explicit sandbox parameter", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "ws-interactive-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const receivedArgs: string[] = [];
    const provider = makeTestProvider(async (args, _opts) => {
      receivedArgs.push(...args);
      return { exitCode: 0 };
    });

    const ws = await createWorkspace({
      branchStrategy: { type: "branch", branch: "sandbox-test" },
      _test: { hostRepoDir: hostDir },
    });

    try {
      const result = await ws.interactive({
        agent: claudeCode("claude-opus-4-6"),
        sandbox: provider,
        prompt: "fix the bug",
      });

      expect(result.exitCode).toBe(0);
      expect(receivedArgs).toContain("fix the bug");
    } finally {
      await ws.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("workspace persists after interactive session completes", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "ws-interactive-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const provider = makeTestProvider(async (_args, opts) => {
      // Make a commit during the session
      const cwd = opts.cwd!;
      execSync('echo "new content" > newfile.txt', { cwd });
      execSync("git add newfile.txt", { cwd });
      execSync('git commit -m "agent commit"', { cwd });
      return { exitCode: 0 };
    });

    const ws = await createWorkspace({
      branchStrategy: { type: "branch", branch: "persist-test" },
      _test: { hostRepoDir: hostDir },
    });

    try {
      await ws.interactive({
        agent: claudeCode("claude-opus-4-6"),
        sandbox: provider,
        prompt: "add a file",
      });

      // Workspace should still exist after interactive session
      expect(existsSync(ws.workspacePath)).toBe(true);
      // The commit should be in the worktree
      const log = execSync("git log --oneline -1", {
        cwd: ws.workspacePath,
        encoding: "utf-8",
      });
      expect(log).toContain("agent commit");
    } finally {
      await ws.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("returns InteractiveResult with commits from the session", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "ws-interactive-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const provider = makeTestProvider(async (_args, opts) => {
      const cwd = opts.cwd!;
      execSync('echo "content" > file.txt', { cwd });
      execSync("git add file.txt", { cwd });
      execSync('git commit -m "a commit"', { cwd });
      return { exitCode: 42 };
    });

    const ws = await createWorkspace({
      branchStrategy: { type: "branch", branch: "result-test" },
      _test: { hostRepoDir: hostDir },
    });

    try {
      const result = await ws.interactive({
        agent: claudeCode("claude-opus-4-6"),
        sandbox: provider,
        prompt: "test",
      });

      expect(result.exitCode).toBe(42);
      expect(result.commits.length).toBe(1);
      expect(result.commits[0]!.sha).toMatch(/^[0-9a-f]{40}$/);
      expect(result.branch).toBe("result-test");
    } finally {
      await ws.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });
});

/** Dummy sandbox provider used to satisfy the required `sandbox` field in test mode. */
const testSandbox: SandboxProvider = createBindMountSandboxProvider({
  name: "test",
  create: async (options) => ({
    workspacePath: options.workspacePath,
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    close: async () => {},
  }),
});

describe("workspace.createSandbox()", () => {
  it("creates a sandbox with branch and workspacePath from the workspace", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "ws-sandbox-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const ws = await createWorkspace({
      branchStrategy: { type: "branch", branch: "ws-sandbox-test" },
      _test: { hostRepoDir: hostDir },
    });

    try {
      const sandbox = await ws.createSandbox({
        sandbox: testSandbox,
        _test: {
          buildSandboxLayer: (sandboxDir) => makeLocalSandboxLayer(sandboxDir),
        },
      });

      try {
        expect(sandbox.branch).toBe("ws-sandbox-test");
        expect(sandbox.workspacePath).toBe(ws.workspacePath);
      } finally {
        await sandbox.close();
      }
    } finally {
      await ws.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("sandbox.close() tears down container but leaves worktree intact", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "ws-sandbox-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const ws = await createWorkspace({
      branchStrategy: { type: "branch", branch: "split-ownership" },
      _test: { hostRepoDir: hostDir },
    });

    try {
      const sandbox = await ws.createSandbox({
        sandbox: testSandbox,
        _test: {
          buildSandboxLayer: (sandboxDir) => makeLocalSandboxLayer(sandboxDir),
        },
      });

      const closeResult = await sandbox.close();

      // Sandbox close should NOT report preserved workspace (it doesn't own it)
      expect(closeResult.preservedWorkspacePath).toBeUndefined();
      // Worktree should still exist — workspace owns it
      expect(existsSync(ws.workspacePath)).toBe(true);
    } finally {
      await ws.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("ws.close() cleans up worktree after sandbox.close()", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "ws-sandbox-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const ws = await createWorkspace({
      branchStrategy: { type: "branch", branch: "ws-close-after-sandbox" },
      _test: { hostRepoDir: hostDir },
    });

    const worktreePath = ws.workspacePath;

    const sandbox = await ws.createSandbox({
      sandbox: testSandbox,
      _test: {
        buildSandboxLayer: (sandboxDir) => makeLocalSandboxLayer(sandboxDir),
      },
    });

    await sandbox.close();
    expect(existsSync(worktreePath)).toBe(true);

    const wsCloseResult = await ws.close();
    expect(wsCloseResult.preservedWorkspacePath).toBeUndefined();
    expect(existsSync(worktreePath)).toBe(false);

    await rm(hostDir, { recursive: true, force: true });
  });

  it("multiple sandboxes can be created sequentially from the same workspace", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "ws-sandbox-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const ws = await createWorkspace({
      branchStrategy: { type: "branch", branch: "sequential-sandbox" },
      _test: { hostRepoDir: hostDir },
    });

    try {
      // First sandbox
      const sandbox1 = await ws.createSandbox({
        sandbox: testSandbox,
        _test: {
          buildSandboxLayer: (sandboxDir) => makeLocalSandboxLayer(sandboxDir),
        },
      });
      expect(sandbox1.branch).toBe("sequential-sandbox");
      await sandbox1.close();

      // Second sandbox — should work on same worktree
      const sandbox2 = await ws.createSandbox({
        sandbox: testSandbox,
        _test: {
          buildSandboxLayer: (sandboxDir) => makeLocalSandboxLayer(sandboxDir),
        },
      });
      expect(sandbox2.branch).toBe("sequential-sandbox");
      expect(sandbox2.workspacePath).toBe(ws.workspacePath);
      await sandbox2.close();

      expect(existsSync(ws.workspacePath)).toBe(true);
    } finally {
      await ws.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("does not accept branch options", () => {
    const _options: WorkspaceCreateSandboxOptions = {
      sandbox: testSandbox,
      // @ts-expect-error - branch should not be accepted
      branch: "should-not-work",
    };
  });
});
