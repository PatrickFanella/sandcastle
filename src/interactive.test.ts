import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { interactive, type InteractiveOptions } from "./interactive.js";
import {
  createBindMountSandboxProvider,
  type BindMountSandboxHandle,
  type InteractiveExecOptions,
} from "./SandboxProvider.js";
import { claudeCode, pi, codex, opencode } from "./AgentProvider.js";

// --- buildInteractiveArgs prompt tests ---

describe("buildInteractiveArgs with prompts", () => {
  it("claudeCode includes prompt as positional argument", () => {
    const provider = claudeCode("claude-opus-4-6");
    const args = provider.buildInteractiveArgs!("fix the bug");
    expect(args[0]).toBe("claude");
    expect(args[args.length - 1]).toBe("fix the bug");
  });

  it("claudeCode omits prompt when empty string", () => {
    const provider = claudeCode("claude-opus-4-6");
    const args = provider.buildInteractiveArgs!("");
    expect(args[args.length - 1]).not.toBe("");
    expect(args).toContain("--model");
  });

  it("pi includes prompt as positional argument", () => {
    const provider = pi("claude-sonnet-4-6");
    const args = provider.buildInteractiveArgs!("fix the bug");
    expect(args[0]).toBe("pi");
    expect(args[args.length - 1]).toBe("fix the bug");
  });

  it("pi omits prompt when empty string", () => {
    const provider = pi("claude-sonnet-4-6");
    const args = provider.buildInteractiveArgs!("");
    expect(args).not.toContain("");
  });

  it("codex includes prompt as positional argument", () => {
    const provider = codex("gpt-5.4-mini");
    const args = provider.buildInteractiveArgs!("fix the bug");
    expect(args[0]).toBe("codex");
    expect(args[args.length - 1]).toBe("fix the bug");
  });

  it("codex omits prompt when empty string", () => {
    const provider = codex("gpt-5.4-mini");
    const args = provider.buildInteractiveArgs!("");
    expect(args).not.toContain("");
  });

  it("opencode passes prompt via -p flag", () => {
    const provider = opencode("opencode/big-pickle");
    const args = provider.buildInteractiveArgs!("fix the bug");
    expect(args[0]).toBe("opencode");
    const pIdx = args.indexOf("-p");
    expect(pIdx).toBeGreaterThan(-1);
    expect(args[pIdx + 1]).toBe("fix the bug");
  });

  it("opencode omits -p flag when prompt is empty", () => {
    const provider = opencode("opencode/big-pickle");
    const args = provider.buildInteractiveArgs!("");
    expect(args).not.toContain("-p");
  });
});

// --- interactive() function tests ---

describe("interactive()", () => {
  let hostDir: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    hostDir = mkdtempSync(join(tmpdir(), "sandcastle-interactive-test-"));
    // Initialize a git repo
    execSync("git init", { cwd: hostDir, stdio: "ignore" });
    execSync('git config user.email "test@test.com"', {
      cwd: hostDir,
      stdio: "ignore",
    });
    execSync('git config user.name "Test"', {
      cwd: hostDir,
      stdio: "ignore",
    });
    // Create initial commit
    writeFileSync(join(hostDir, "README.md"), "# Test\n");
    execSync("git add .", { cwd: hostDir, stdio: "ignore" });
    execSync('git commit -m "initial"', { cwd: hostDir, stdio: "ignore" });
    process.chdir(hostDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
  });

  /**
   * Create a test bind-mount provider with a fake interactiveExec.
   * The fakeInteractiveExec callback simulates an interactive session.
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
          workspacePath: options.worktreePath,
          exec: async (command) => {
            const result = execSync(command, {
              cwd: options.worktreePath,
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

  it("returns InteractiveResult with exitCode, branch, and commits", async () => {
    const provider = makeTestProvider(async (_args, _opts) => {
      return { exitCode: 0 };
    });

    const result = await interactive({
      agent: claudeCode("claude-opus-4-6"),
      sandbox: provider,
      prompt: "test prompt",
      name: "test-session",
    });

    expect(result).toHaveProperty("exitCode");
    expect(result).toHaveProperty("branch");
    expect(result).toHaveProperty("commits");
    expect(result.exitCode).toBe(0);
    expect(typeof result.branch).toBe("string");
    expect(Array.isArray(result.commits)).toBe(true);
  });

  it("passes prompt through buildInteractiveArgs to interactiveExec", async () => {
    const receivedArgs: string[] = [];

    const provider = makeTestProvider(async (args, _opts) => {
      receivedArgs.push(...args);
      return { exitCode: 0 };
    });

    await interactive({
      agent: claudeCode("claude-opus-4-6"),
      sandbox: provider,
      prompt: "fix the login bug",
    });

    // Claude Code's buildInteractiveArgs should include the prompt
    expect(receivedArgs).toContain("fix the login bug");
    expect(receivedArgs[0]).toBe("claude");
  });

  it("collects commits made during the interactive session", async () => {
    const provider = makeTestProvider(async (_args, opts) => {
      // Simulate the agent making a commit inside the sandbox
      const cwd = opts.cwd!;
      execSync('echo "new content" > newfile.txt', { cwd });
      execSync("git add newfile.txt", { cwd });
      execSync('git commit -m "agent commit"', { cwd });
      return { exitCode: 0 };
    });

    const result = await interactive({
      agent: claudeCode("claude-opus-4-6"),
      sandbox: provider,
      prompt: "add a file",
    });

    expect(result.commits.length).toBe(1);
    expect(result.commits[0]!.sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("returns non-zero exitCode from the interactive session", async () => {
    const provider = makeTestProvider(async () => {
      return { exitCode: 42 };
    });

    const result = await interactive({
      agent: claudeCode("claude-opus-4-6"),
      sandbox: provider,
      prompt: "test",
    });

    expect(result.exitCode).toBe(42);
  });

  it("throws when provider does not implement interactiveExec", async () => {
    const provider = createBindMountSandboxProvider({
      name: "no-interactive",
      create: async (options) => ({
        workspacePath: options.worktreePath,
        exec: async (command) => {
          const result = execSync(command, {
            cwd: options.worktreePath,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
          });
          return { stdout: result, stderr: "", exitCode: 0 };
        },
        // No interactiveExec
        close: async () => {},
      }),
    });

    await expect(
      interactive({
        agent: claudeCode("claude-opus-4-6"),
        sandbox: provider,
        prompt: "test",
      }),
    ).rejects.toThrow("interactiveExec");
  });

  it("throws when provider is isolated (not bind-mount)", async () => {
    const { createIsolatedSandboxProvider } =
      await import("./SandboxProvider.js");
    const isolatedProvider = createIsolatedSandboxProvider({
      name: "test-isolated",
      create: async () => ({
        workspacePath: "/workspace",
        exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
        copyIn: async () => {},
        copyFileOut: async () => {},
        close: async () => {},
      }),
    });

    await expect(
      interactive({
        agent: claudeCode("claude-opus-4-6"),
        sandbox: isolatedProvider,
        prompt: "test",
      }),
    ).rejects.toThrow("bind-mount");
  });

  it("receives stdin/stdout/stderr streams in interactiveExec options", async () => {
    let receivedOpts: InteractiveExecOptions | undefined;

    const provider = makeTestProvider(async (_args, opts) => {
      receivedOpts = opts;
      return { exitCode: 0 };
    });

    await interactive({
      agent: claudeCode("claude-opus-4-6"),
      sandbox: provider,
      prompt: "test",
    });

    expect(receivedOpts).toBeDefined();
    expect(receivedOpts!.stdin).toBe(process.stdin);
    expect(receivedOpts!.stdout).toBe(process.stdout);
    expect(receivedOpts!.stderr).toBe(process.stderr);
    expect(receivedOpts!.cwd).toBeDefined();
  });
});
