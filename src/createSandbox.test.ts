import { exec } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { claudeCode, pi } from "./AgentProvider.js";
import { createSandbox } from "./createSandbox.js";
import { Sandbox } from "./SandboxFactory.js";
import type { BindMountSandboxHandle } from "./SandboxProvider.js";
import { createBindMountSandboxProvider } from "./SandboxProvider.js";
import { makeLocalSandboxLayer } from "./testSandbox.js";

/** Dummy sandbox provider used to satisfy the required `sandbox` field in test mode. */
const testSandbox = createBindMountSandboxProvider({
  name: "test",
  create: async () => ({
    workspacePath: "/home/agent/workspace",
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    execStreaming: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    close: async () => {},
  }),
});

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

const testProvider = claudeCode("test-model");
const testPiProvider = pi("test-model");

/** Format a mock pi agent result as stream-json lines */
const toPiStreamJson = (output: string): string => {
  const lines: string[] = [];
  lines.push(
    JSON.stringify({
      type: "message_update",
      content: [{ type: "text_delta", text: output }],
    }),
  );
  lines.push(
    JSON.stringify({ type: "agent_end", last_assistant_message: output }),
  );
  return lines.join("\n");
};

/** Known agent command prefixes and their stream formatters */
const AGENT_PREFIXES: { prefix: string; toStream: (o: string) => string }[] = [
  { prefix: "claude ", toStream: toStreamJson },
  { prefix: "pi ", toStream: toPiStreamJson },
];

/**
 * Create a mock sandbox layer that intercepts agent commands and runs a
 * mock script instead. All other commands pass through to the local sandbox.
 */
const makeMockAgentLayer = (
  sandboxDir: string,
  mockAgentBehavior: (sandboxRepoDir: string) => Promise<string>,
): Layer.Layer<Sandbox> => {
  const fsLayer = makeLocalSandboxLayer(sandboxDir);

  const matchAgent = (command: string) =>
    AGENT_PREFIXES.find((a) => command.startsWith(a.prefix));

  return Layer.succeed(Sandbox, {
    exec: (command, options) => {
      if (matchAgent(command)) {
        return Effect.gen(function* () {
          const cwd = options?.cwd ?? sandboxDir;
          const output = yield* Effect.promise(() => mockAgentBehavior(cwd));
          return { stdout: output, stderr: "", exitCode: 0 };
        });
      }
      return Effect.flatMap(Sandbox, (real) =>
        real.exec(command, options),
      ).pipe(Effect.provide(fsLayer));
    },
    execStreaming: (command, onStdoutLine, options) => {
      const agent = matchAgent(command);
      if (agent) {
        return Effect.gen(function* () {
          const cwd = options?.cwd ?? sandboxDir;
          const output = yield* Effect.promise(() => mockAgentBehavior(cwd));
          const streamOutput = agent.toStream(output);
          for (const line of streamOutput.split("\n")) {
            onStdoutLine(line);
          }
          return { stdout: streamOutput, stderr: "", exitCode: 0 };
        });
      }
      return Effect.flatMap(Sandbox, (real) =>
        real.execStreaming(command, onStdoutLine, options),
      ).pipe(Effect.provide(fsLayer));
    },
    copyIn: (hostPath, sandboxPath) =>
      Effect.flatMap(Sandbox, (real) =>
        real.copyIn(hostPath, sandboxPath),
      ).pipe(Effect.provide(fsLayer)),
    copyOut: (sandboxPath, hostPath) =>
      Effect.flatMap(Sandbox, (real) =>
        real.copyOut(sandboxPath, hostPath),
      ).pipe(Effect.provide(fsLayer)),
  });
};

describe("createSandbox", () => {
  it("creates a sandbox with branch and worktreePath properties", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const sandbox = await createSandbox({
      branch: "test-branch",
      sandbox: testSandbox,
      _test: {
        hostRepoDir: hostDir,
        buildSandboxLayer: (sandboxDir) => makeLocalSandboxLayer(sandboxDir),
      },
    });

    try {
      expect(sandbox.branch).toBe("test-branch");
      expect(sandbox.worktreePath).toContain(".sandcastle/worktrees");
      expect(existsSync(sandbox.worktreePath)).toBe(true);
    } finally {
      await sandbox.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("sandbox.run() invokes agent and returns SandboxRunResult", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const sandbox = await createSandbox({
      branch: "test-run-branch",
      sandbox: testSandbox,
      _test: {
        hostRepoDir: hostDir,
        buildSandboxLayer: (sandboxDir) =>
          makeMockAgentLayer(sandboxDir, async () => "agent output"),
      },
    });

    try {
      const result = await sandbox.run({
        agent: testProvider,
        prompt: "do something",
        maxIterations: 1,
      });

      expect(result.iterationsRun).toBe(1);
      expect(typeof result.stdout).toBe("string");
      expect(Array.isArray(result.commits)).toBe(true);
    } finally {
      await sandbox.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("sandbox.close() removes worktree when clean, returns no preservedWorktreePath", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const sandbox = await createSandbox({
      branch: "test-clean-close",
      sandbox: testSandbox,
      _test: {
        hostRepoDir: hostDir,
        buildSandboxLayer: (sandboxDir) => makeLocalSandboxLayer(sandboxDir),
      },
    });

    const worktreePath = sandbox.worktreePath;
    const closeResult = await sandbox.close();

    expect(closeResult.preservedWorktreePath).toBeUndefined();
    expect(existsSync(worktreePath)).toBe(false);
    await rm(hostDir, { recursive: true, force: true });
  });

  it("sandbox.close() preserves worktree when dirty, returns preservedWorktreePath", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const sandbox = await createSandbox({
      branch: "test-dirty-close",
      sandbox: testSandbox,
      _test: {
        hostRepoDir: hostDir,
        buildSandboxLayer: (sandboxDir) => makeLocalSandboxLayer(sandboxDir),
      },
    });

    // Make the worktree dirty
    await writeFile(join(sandbox.worktreePath, "dirty.txt"), "uncommitted");

    const closeResult = await sandbox.close();

    expect(closeResult.preservedWorktreePath).toBe(sandbox.worktreePath);
    expect(existsSync(sandbox.worktreePath)).toBe(true);

    // Clean up manually
    await rm(sandbox.worktreePath, { recursive: true, force: true });
    await execAsync(`git worktree prune`, { cwd: hostDir });
    await rm(hostDir, { recursive: true, force: true });
  });

  it("Symbol.asyncDispose works via await using", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    let worktreePath: string;
    {
      await using sandbox = await createSandbox({
        branch: "test-dispose-branch",
        sandbox: testSandbox,
        _test: {
          hostRepoDir: hostDir,
          buildSandboxLayer: (sandboxDir) => makeLocalSandboxLayer(sandboxDir),
        },
      });
      worktreePath = sandbox.worktreePath;
      expect(existsSync(worktreePath)).toBe(true);
    }
    // After block exit, worktree should be cleaned up
    expect(existsSync(worktreePath!)).toBe(false);
    await rm(hostDir, { recursive: true, force: true });
  });

  it("errors when branch is already checked out in another worktree", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const sandbox1 = await createSandbox({
      branch: "collision-branch",
      sandbox: testSandbox,
      _test: {
        hostRepoDir: hostDir,
        buildSandboxLayer: (sandboxDir) => makeLocalSandboxLayer(sandboxDir),
      },
    });

    try {
      await expect(
        createSandbox({
          branch: "collision-branch",
          sandbox: testSandbox,
          _test: {
            hostRepoDir: hostDir,
            buildSandboxLayer: (sandboxDir) =>
              makeLocalSandboxLayer(sandboxDir),
          },
        }),
      ).rejects.toThrow(/already checked out/);
    } finally {
      await sandbox1.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("sandbox.run() returns commits made during the run", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const sandbox = await createSandbox({
      branch: "test-commits-branch",
      sandbox: testSandbox,
      _test: {
        hostRepoDir: hostDir,
        buildSandboxLayer: (sandboxDir) =>
          makeMockAgentLayer(sandboxDir, async (cwd) => {
            await writeFile(join(cwd, "agent-created.txt"), "new file");
            await execAsync("git add agent-created.txt", { cwd });
            await execAsync('git commit -m "agent commit"', { cwd });
            return "done";
          }),
      },
    });

    try {
      const result = await sandbox.run({
        agent: testProvider,
        prompt: "create a file",
        maxIterations: 1,
      });

      expect(result.commits.length).toBeGreaterThanOrEqual(1);
    } finally {
      await sandbox.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("sandbox.close() is idempotent", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const sandbox = await createSandbox({
      branch: "test-idempotent-close",
      sandbox: testSandbox,
      _test: {
        hostRepoDir: hostDir,
        buildSandboxLayer: (sandboxDir) => makeLocalSandboxLayer(sandboxDir),
      },
    });

    const result1 = await sandbox.close();
    const result2 = await sandbox.close();

    expect(result1.preservedWorktreePath).toBeUndefined();
    expect(result2.preservedWorktreePath).toBeUndefined();
    await rm(hostDir, { recursive: true, force: true });
  });

  it("two sequential runs with different agents and prompts succeed on the same sandbox", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const sandbox = await createSandbox({
      branch: "test-multi-run",
      sandbox: testSandbox,
      _test: {
        hostRepoDir: hostDir,
        buildSandboxLayer: (sandboxDir) =>
          makeMockAgentLayer(sandboxDir, async () => "mock output"),
      },
    });

    try {
      const result1 = await sandbox.run({
        agent: testProvider,
        prompt: "implement feature",
        maxIterations: 1,
        name: "Implementer",
      });

      const result2 = await sandbox.run({
        agent: testPiProvider,
        prompt: "review the code",
        maxIterations: 1,
        name: "Reviewer",
      });

      expect(result1.iterationsRun).toBe(1);
      expect(result2.iterationsRun).toBe(1);
    } finally {
      await sandbox.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("commits from multiple runs accumulate on the branch", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    let runCount = 0;
    const sandbox = await createSandbox({
      branch: "test-commit-accumulation",
      sandbox: testSandbox,
      _test: {
        hostRepoDir: hostDir,
        buildSandboxLayer: (sandboxDir) =>
          makeMockAgentLayer(sandboxDir, async (cwd) => {
            runCount++;
            const fname = `file-${runCount}.txt`;
            await writeFile(join(cwd, fname), `content ${runCount}`);
            await execAsync(`git add ${fname}`, { cwd });
            await execAsync(`git commit -m "commit from run ${runCount}"`, {
              cwd,
            });
            return `done run ${runCount}`;
          }),
      },
    });

    try {
      const result1 = await sandbox.run({
        agent: testProvider,
        prompt: "first run",
        maxIterations: 1,
      });

      const result2 = await sandbox.run({
        agent: testProvider,
        prompt: "second run",
        maxIterations: 1,
      });

      expect(result1.commits.length).toBeGreaterThanOrEqual(1);
      expect(result2.commits.length).toBeGreaterThanOrEqual(1);

      // Verify both commits exist on the branch
      const { stdout: log } = await execAsync(
        `git log --oneline test-commit-accumulation`,
        { cwd: hostDir },
      );
      expect(log).toContain("commit from run 1");
      expect(log).toContain("commit from run 2");
    } finally {
      await sandbox.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("onSandboxReady hooks execute once at creation time", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const sandbox = await createSandbox({
      branch: "test-hooks",
      sandbox: testSandbox,
      hooks: {
        onSandboxReady: [
          { command: "touch /tmp/hook-marker.txt" },
          { command: "echo 'hook-ran' > hook-output.txt" },
        ],
      },
      _test: {
        hostRepoDir: hostDir,
        buildSandboxLayer: (sandboxDir) => makeLocalSandboxLayer(sandboxDir),
      },
    });

    try {
      // The hook wrote a file into the worktree (cwd is sandboxRepoDir = worktreePath in test mode)
      const hookOutput = await readFile(
        join(sandbox.worktreePath, "hook-output.txt"),
        "utf-8",
      );
      expect(hookOutput.trim()).toBe("hook-ran");
    } finally {
      await sandbox.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("provider's create() is called exactly once across multiple .run() calls", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    let createCallCount = 0;
    let closeCallCount = 0;
    let capturedHandle: BindMountSandboxHandle | undefined;

    // Isolated git config so global writes don't pollute developer config
    const gitTmpDir = mkdtempSync(join(tmpdir(), "test-gitconfig-"));
    const globalConfigPath = join(gitTmpDir, ".gitconfig");
    writeFileSync(globalConfigPath, "");
    const isolatedEnv = {
      ...process.env,
      GIT_CONFIG_GLOBAL: globalConfigPath,
    };

    const spyProvider = createBindMountSandboxProvider({
      name: "spy",
      create: async (opts) => {
        createCallCount++;
        const workDir = opts.worktreePath;
        const handle: BindMountSandboxHandle = {
          workspacePath: workDir,
          exec: async (cmd, execOpts) => {
            const cwd = execOpts?.cwd ?? workDir;
            // Short-circuit agent commands
            if (cmd.startsWith("claude ")) {
              return { stdout: "mock", stderr: "", exitCode: 0 };
            }
            const result = await execAsync(cmd, { cwd, env: isolatedEnv });
            return {
              stdout: result.stdout,
              stderr: result.stderr,
              exitCode: 0,
            };
          },
          execStreaming: async (cmd, onLine, execOpts) => {
            const cwd = execOpts?.cwd ?? workDir;
            if (cmd.startsWith("claude ")) {
              const output = toStreamJson("mock output");
              for (const line of output.split("\n")) onLine(line);
              return { stdout: output, stderr: "", exitCode: 0 };
            }
            const result = await execAsync(cmd, { cwd, env: isolatedEnv });
            for (const line of result.stdout.split("\n")) onLine(line);
            return {
              stdout: result.stdout,
              stderr: result.stderr,
              exitCode: 0,
            };
          },
          close: async () => {
            closeCallCount++;
          },
        };
        capturedHandle = handle;
        return handle;
      },
    });

    const sandbox = await createSandbox({
      branch: "test-create-once",
      sandbox: spyProvider,
      _test: { hostRepoDir: hostDir },
    });

    try {
      expect(createCallCount).toBe(1);

      await sandbox.run({
        agent: testProvider,
        prompt: "first run",
        maxIterations: 1,
      });
      expect(createCallCount).toBe(1);

      await sandbox.run({
        agent: testProvider,
        prompt: "second run",
        maxIterations: 1,
      });
      expect(createCallCount).toBe(1);
    } finally {
      await sandbox.close();
      expect(closeCallCount).toBe(1);
      await rm(hostDir, { recursive: true, force: true });
      await rm(gitTmpDir, { recursive: true, force: true });
    }
  });

  it("close() delegates to the provider handle's close()", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    let providerClosed = false;

    const gitTmpDir = mkdtempSync(join(tmpdir(), "test-gitconfig-"));
    const globalConfigPath = join(gitTmpDir, ".gitconfig");
    writeFileSync(globalConfigPath, "");
    const isolatedEnv = {
      ...process.env,
      GIT_CONFIG_GLOBAL: globalConfigPath,
    };

    const spyProvider = createBindMountSandboxProvider({
      name: "spy-close",
      create: async (opts) => ({
        workspacePath: opts.worktreePath,
        exec: async (cmd, execOpts) => {
          const cwd = execOpts?.cwd ?? opts.worktreePath;
          if (cmd.startsWith("claude "))
            return { stdout: "mock", stderr: "", exitCode: 0 };
          const result = await execAsync(cmd, { cwd, env: isolatedEnv });
          return {
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: 0,
          };
        },
        execStreaming: async (cmd, onLine, execOpts) => {
          const cwd = execOpts?.cwd ?? opts.worktreePath;
          if (cmd.startsWith("claude ")) {
            const output = toStreamJson("mock");
            for (const line of output.split("\n")) onLine(line);
            return { stdout: output, stderr: "", exitCode: 0 };
          }
          const result = await execAsync(cmd, { cwd, env: isolatedEnv });
          return {
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: 0,
          };
        },
        close: async () => {
          providerClosed = true;
        },
      }),
    });

    const sandbox = await createSandbox({
      branch: "test-close-delegates",
      sandbox: spyProvider,
      _test: { hostRepoDir: hostDir },
    });

    expect(providerClosed).toBe(false);
    await sandbox.close();
    expect(providerClosed).toBe(true);

    await rm(hostDir, { recursive: true, force: true });
    await rm(gitTmpDir, { recursive: true, force: true });
  });

  it("state persists between runs — file created in run 1 exists in run 2", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    let runNumber = 0;
    const sandbox = await createSandbox({
      branch: "test-state-persistence",
      sandbox: testSandbox,
      _test: {
        hostRepoDir: hostDir,
        buildSandboxLayer: (sandboxDir) =>
          makeMockAgentLayer(sandboxDir, async (cwd) => {
            runNumber++;
            if (runNumber === 1) {
              // Run 1: create a file (non-committed state)
              await writeFile(join(cwd, "persistent-state.txt"), "from-run-1");
              return "created file";
            }
            // Run 2: verify the file still exists
            const content = await readFile(
              join(cwd, "persistent-state.txt"),
              "utf-8",
            );
            if (content !== "from-run-1") {
              throw new Error("State did not persist between runs!");
            }
            return "verified file exists";
          }),
      },
    });

    try {
      await sandbox.run({
        agent: testProvider,
        prompt: "create file",
        maxIterations: 1,
      });

      // Verify file exists on host between runs
      const content = await readFile(
        join(sandbox.worktreePath, "persistent-state.txt"),
        "utf-8",
      );
      expect(content).toBe("from-run-1");

      // Run 2 — the mock agent verifies the file persists inside the sandbox
      await sandbox.run({
        agent: testProvider,
        prompt: "verify file",
        maxIterations: 1,
      });
    } finally {
      await sandbox.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("copyToSandbox copies files into the worktree at creation time", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    // Create untracked files in the host repo that should be copied
    await writeFile(join(hostDir, "config.json"), '{"key": "value"}');

    const sandbox = await createSandbox({
      branch: "test-copy",
      sandbox: testSandbox,
      copyToSandbox: ["config.json"],
      _test: {
        hostRepoDir: hostDir,
        buildSandboxLayer: (sandboxDir) => makeLocalSandboxLayer(sandboxDir),
      },
    });

    try {
      const copied = await readFile(
        join(sandbox.worktreePath, "config.json"),
        "utf-8",
      );
      expect(JSON.parse(copied)).toEqual({ key: "value" });
    } finally {
      await sandbox.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });
});
