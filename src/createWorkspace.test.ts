import { exec, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createWorkspace } from "./createWorkspace.js";
import type {
  CreateWorkspaceOptions,
  WorkspaceRunOptions,
} from "./createWorkspace.js";
import { claudeCode } from "./AgentProvider.js";
import {
  createBindMountSandboxProvider,
  type BindMountSandboxHandle,
  type InteractiveExecOptions,
  type ExecResult,
} from "./SandboxProvider.js";

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

/** Format a mock agent result as stream-json lines (mimicking Claude's output) */
const toStreamJson = (output: string): string => {
  const lines: string[] = [];
  lines.push(
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: output }] },
    }),
  );
  lines.push(JSON.stringify({ type: "result", result: output }));
  return lines.join("\n");
};

describe("workspace.run()", () => {
  /**
   * Create a test bind-mount provider that intercepts agent commands
   * and runs a mock behavior, while passing other commands through.
   */
  const makeRunTestProvider = (
    mockAgentBehavior: (cwd: string) => Promise<string> = async () =>
      "mock output",
  ) =>
    createBindMountSandboxProvider({
      name: "test-run",
      create: async (options) => {
        const handle: BindMountSandboxHandle = {
          workspacePath: options.workspacePath,
          exec: async (
            command: string,
            execOptions?: {
              cwd?: string;
              onLine?: (line: string) => void;
              sudo?: boolean;
            },
          ): Promise<ExecResult> => {
            const cwd = execOptions?.cwd ?? options.workspacePath;
            // Intercept agent commands
            if (command.startsWith("claude ")) {
              const output = await mockAgentBehavior(cwd);
              const streamOutput = toStreamJson(output);
              if (execOptions?.onLine) {
                for (const line of streamOutput.split("\n")) {
                  execOptions.onLine(line);
                }
              }
              return { stdout: streamOutput, stderr: "", exitCode: 0 };
            }
            // Pass through other commands
            const result = execSync(command, {
              cwd,
              encoding: "utf-8",
              stdio: ["pipe", "pipe", "pipe"],
            });
            return { stdout: result, stderr: "", exitCode: 0 };
          },
          close: async () => {},
        };
        return handle;
      },
    });

  it("runs agent and returns WorkspaceRunResult", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "ws-run-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const sandbox = makeRunTestProvider();

    const ws = await createWorkspace({
      branchStrategy: { type: "branch", branch: "run-test" },
      _test: { hostRepoDir: hostDir },
    });

    try {
      const result = await ws.run({
        agent: claudeCode("claude-opus-4-6"),
        sandbox,
        prompt: "do something",
        maxIterations: 1,
      });

      expect(result.iterationsRun).toBe(1);
      expect(typeof result.stdout).toBe("string");
      expect(Array.isArray(result.commits)).toBe(true);
      expect(result.branch).toBe("run-test");
    } finally {
      await ws.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("workspace persists after run completes", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "ws-run-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const sandbox = makeRunTestProvider(async (cwd) => {
      execSync('echo "agent file" > agent.txt', { cwd });
      execSync("git add agent.txt", { cwd });
      execSync('git commit -m "agent commit"', { cwd });
      return "done";
    });

    const ws = await createWorkspace({
      branchStrategy: { type: "branch", branch: "persist-run-test" },
      _test: { hostRepoDir: hostDir },
    });

    try {
      await ws.run({
        agent: claudeCode("claude-opus-4-6"),
        sandbox,
        prompt: "create a file",
        maxIterations: 1,
      });

      // Workspace should still exist after run
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

  it("returns commits made during the run", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "ws-run-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const sandbox = makeRunTestProvider(async (cwd) => {
      execSync('echo "new file" > created.txt', { cwd });
      execSync("git add created.txt", { cwd });
      execSync('git commit -m "test commit"', { cwd });
      return "done";
    });

    const ws = await createWorkspace({
      branchStrategy: { type: "branch", branch: "commits-run-test" },
      _test: { hostRepoDir: hostDir },
    });

    try {
      const result = await ws.run({
        agent: claudeCode("claude-opus-4-6"),
        sandbox,
        prompt: "create a file",
        maxIterations: 1,
      });

      expect(result.commits.length).toBeGreaterThanOrEqual(1);
      expect(result.commits[0]!.sha).toMatch(/^[0-9a-f]{40}$/);
      expect(result.branch).toBe("commits-run-test");
    } finally {
      await ws.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("sandbox is required (type error if omitted)", () => {
    // This test validates at the type level — sandbox is required in WorkspaceRunOptions
    const _options = {
      agent: claudeCode("claude-opus-4-6"),
      prompt: "test",
      // @ts-expect-error — sandbox is required
    } satisfies WorkspaceRunOptions;
  });
});
