import { Effect, Layer, Ref } from "effect";
import { exec } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { Display, type DisplayEntry, SilentDisplay } from "./Display.js";
import { FilesystemSandbox } from "./FilesystemSandbox.js";
import {
  DEFAULT_MODEL,
  orchestrate,
  parseStreamJsonLine,
} from "./Orchestrator.js";
import { Sandbox } from "./Sandbox.js";
import type { DockerError, SandboxError } from "./errors.js";
import { SandboxFactory } from "./SandboxFactory.js";

const execAsync = promisify(exec);

const testDisplayLayer = SilentDisplay.layer(
  Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([]),
);

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

/**
 * Create a mock SandboxFactory that creates a fresh temp directory
 * and sandbox for each withSandbox call, then cleans it up after.
 *
 * Each iteration gets an isolated sandbox: the sandbox directory is
 * removed and recreated before each call, and cleaned up after.
 *
 * @param buildLayer - Given a fresh sandbox dir, return a Sandbox layer
 * @returns The factory layer and the sandboxRepoDir path to pass to orchestrate
 */
const makeTestSandboxFactory = (
  buildLayer: (sandboxDir: string) => Layer.Layer<Sandbox>,
): { factoryLayer: Layer.Layer<SandboxFactory>; sandboxRepoDir: string } => {
  const sandboxBaseDir = join(tmpdir(), `orch-factory-${randomUUID()}`);
  const sandboxRepoDir = join(sandboxBaseDir, "repo");

  const factoryLayer = Layer.succeed(SandboxFactory, {
    withSandbox: <A, E, R>(
      effect: Effect.Effect<A, E, R | Sandbox>,
    ): Effect.Effect<A, E | DockerError, Exclude<R, Sandbox>> =>
      Effect.acquireUseRelease(
        // Acquire: create fresh sandbox dir (removing any previous state)
        Effect.promise(async () => {
          await rm(sandboxBaseDir, { recursive: true, force: true });
          await mkdir(sandboxBaseDir, { recursive: true });
          return sandboxBaseDir;
        }),
        // Use: provide sandbox layer and run effect
        (dir) =>
          effect.pipe(Effect.provide(buildLayer(dir))) as Effect.Effect<
            A,
            E | DockerError,
            Exclude<R, Sandbox>
          >,
        // Release: clean up sandbox dir
        (dir) =>
          Effect.promise(() => rm(dir, { recursive: true, force: true })),
      ),
  });

  return { factoryLayer, sandboxRepoDir };
};

/**
 * Create a mock sandbox layer that intercepts `claude` commands
 * and runs a mock script instead. All other commands pass through
 * to the filesystem sandbox.
 */
const makeMockAgentLayer = (
  sandboxDir: string,
  mockAgentBehavior: (sandboxRepoDir: string) => Promise<string>,
): Layer.Layer<Sandbox> => {
  const fsLayer = FilesystemSandbox.layer(sandboxDir);

  return Layer.succeed(Sandbox, {
    exec: (command, options) => {
      // Intercept claude invocations
      if (command.startsWith("claude ")) {
        return Effect.gen(function* () {
          const cwd = options?.cwd ?? sandboxDir;
          const output = yield* Effect.promise(() => mockAgentBehavior(cwd));
          return { stdout: output, stderr: "", exitCode: 0 };
        });
      }
      // Pass through to real filesystem sandbox
      return Effect.flatMap(Sandbox, (real) =>
        real.exec(command, options),
      ).pipe(Effect.provide(fsLayer));
    },
    execStreaming: (command, onStdoutLine, options) => {
      // Intercept claude invocations
      if (command.startsWith("claude ")) {
        return Effect.gen(function* () {
          const cwd = options?.cwd ?? sandboxDir;
          const output = yield* Effect.promise(() => mockAgentBehavior(cwd));
          const streamOutput = toStreamJson(output);
          // Emit each line to the callback
          for (const line of streamOutput.split("\n")) {
            onStdoutLine(line);
          }
          return { stdout: streamOutput, stderr: "", exitCode: 0 };
        });
      }
      // Pass through to real filesystem sandbox
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

describe("Orchestrator", () => {
  it("runs a single iteration: sync-in, agent, sync-out", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-host-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    // Mock agent: creates a commit in the sandbox repo
    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory((dir) =>
      makeMockAgentLayer(dir, async (repoDir) => {
        await writeFile(join(repoDir, "agent-output.txt"), "agent was here");
        await execAsync("git add -A", { cwd: repoDir });
        await execAsync('git config user.email "agent@test.com"', {
          cwd: repoDir,
        });
        await execAsync('git config user.name "Agent"', { cwd: repoDir });
        await execAsync('git commit -m "RALPH: agent commit"', {
          cwd: repoDir,
        });
        return "Done with iteration.";
      }),
    );

    const result = await Effect.runPromise(
      orchestrate({
        hostRepoDir: hostDir,
        sandboxRepoDir,
        iterations: 1,

        prompt: "do some work",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(result.iterationsRun).toBe(1);
    expect(result.complete).toBe(false);

    // Verify the agent's commit was synced back to host
    const content = await readFile(join(hostDir, "agent-output.txt"), "utf-8");
    expect(content).toBe("agent was here");
  });

  it("stops early on completion signal", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-host-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    // Mock agent: emits completion signal
    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory((dir) =>
      makeMockAgentLayer(dir, async () => {
        return "All done. <promise>COMPLETE</promise>";
      }),
    );

    const result = await Effect.runPromise(
      orchestrate({
        hostRepoDir: hostDir,
        sandboxRepoDir,
        iterations: 5,

        prompt: "do some work",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(result.iterationsRun).toBe(1);
    expect(result.complete).toBe(true);
  });

  it("runs multiple iterations with re-sync between them", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-host-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    let iterationCount = 0;

    // Mock agent: creates a commit each iteration, completes on iteration 3
    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory((dir) =>
      makeMockAgentLayer(dir, async (repoDir) => {
        iterationCount++;
        const filename = `iter-${iterationCount}.txt`;
        await writeFile(join(repoDir, filename), `iteration ${iterationCount}`);
        await execAsync("git add -A", { cwd: repoDir });
        await execAsync('git config user.email "agent@test.com"', {
          cwd: repoDir,
        });
        await execAsync('git config user.name "Agent"', { cwd: repoDir });
        await execAsync(`git commit -m "RALPH: iteration ${iterationCount}"`, {
          cwd: repoDir,
        });

        if (iterationCount === 3) {
          return "All tasks done. <promise>COMPLETE</promise>";
        }
        return `Finished iteration ${iterationCount}.`;
      }),
    );

    const result = await Effect.runPromise(
      orchestrate({
        hostRepoDir: hostDir,
        sandboxRepoDir,
        iterations: 5,

        prompt: "do some work",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(result.iterationsRun).toBe(3);
    expect(result.complete).toBe(true);

    // Verify all 3 iteration files arrived on host
    for (let i = 1; i <= 3; i++) {
      const content = await readFile(join(hostDir, `iter-${i}.txt`), "utf-8");
      expect(content).toBe(`iteration ${i}`);
    }
  });

  it("handles iteration with no agent commits gracefully", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-host-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    // Mock agent: doesn't make any commits
    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory((dir) =>
      makeMockAgentLayer(dir, async () => {
        return "Nothing to do.";
      }),
    );

    const result = await Effect.runPromise(
      orchestrate({
        hostRepoDir: hostDir,
        sandboxRepoDir,
        iterations: 2,

        prompt: "do some work",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(result.iterationsRun).toBe(2);
    expect(result.complete).toBe(false);

    // Host should still be at the original commit
    const hostHead = await getHead(hostDir);
    const { stdout } = await execAsync("git log --oneline", { cwd: hostDir });
    expect(stdout.trim().split("\n")).toHaveLength(1);
  });

  it("each iteration gets an isolated sandbox (no state leaks)", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-iso-host-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    let iteration = 0;
    let markerExistedInIter2 = true;

    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory((dir) =>
      makeMockAgentLayer(dir, async (repoDir) => {
        iteration++;
        if (iteration === 1) {
          // Create an untracked marker file — should NOT leak to iteration 2
          await writeFile(join(repoDir, ".sandbox-marker"), "iter1");
          return "Done iter 1";
        }
        // Iteration 2: check if marker leaked from iteration 1
        markerExistedInIter2 = existsSync(join(repoDir, ".sandbox-marker"));
        return "Done iter 2. <promise>COMPLETE</promise>";
      }),
    );

    const result = await Effect.runPromise(
      orchestrate({
        hostRepoDir: hostDir,
        sandboxRepoDir,
        iterations: 3,

        prompt: "test isolation",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(result.iterationsRun).toBe(2);
    expect(result.complete).toBe(true);
    // Untracked file from iteration 1 must not exist in iteration 2's sandbox
    expect(markerExistedInIter2).toBe(false);
  });
});

describe("parseStreamJsonLine", () => {
  it("extracts text from assistant message", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "Hello world" }] },
    });
    expect(parseStreamJsonLine(line)).toEqual({
      type: "text",
      text: "Hello world",
    });
  });

  it("extracts result from result message", () => {
    const line = JSON.stringify({
      type: "result",
      result: "Final answer <promise>COMPLETE</promise>",
    });
    expect(parseStreamJsonLine(line)).toEqual({
      type: "result",
      result: "Final answer <promise>COMPLETE</promise>",
      usage: null,
    });
  });

  it("returns null for non-JSON lines", () => {
    expect(parseStreamJsonLine("not json")).toBeNull();
    expect(parseStreamJsonLine("")).toBeNull();
  });

  it("returns null for malformed JSON starting with {", () => {
    expect(parseStreamJsonLine("{bad json")).toBeNull();
    expect(parseStreamJsonLine('{"type": "assistant", broken')).toBeNull();
  });

  it("returns null for unrecognized JSON types", () => {
    const line = JSON.stringify({ type: "system", data: "something" });
    expect(parseStreamJsonLine(line)).toBeNull();
  });

  it("handles multiple text content blocks", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Hello " },
          { type: "text", text: "world" },
        ],
      },
    });
    expect(parseStreamJsonLine(line)).toEqual({
      type: "text",
      text: "Hello world",
    });
  });

  it("skips non-text content blocks", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "123" },
          { type: "text", text: "result" },
        ],
      },
    });
    expect(parseStreamJsonLine(line)).toEqual({ type: "text", text: "result" });
  });

  it("extracts usage data from result message", () => {
    const line = JSON.stringify({
      type: "result",
      result: "Done.",
      total_cost_usd: 0.14,
      num_turns: 3,
      duration_ms: 12000,
      usage: {
        input_tokens: 52340,
        output_tokens: 3201,
        cache_read_input_tokens: 10000,
        cache_creation_input_tokens: 5000,
      },
    });
    const parsed = parseStreamJsonLine(line);
    expect(parsed).toEqual({
      type: "result",
      result: "Done.",
      usage: {
        input_tokens: 52340,
        output_tokens: 3201,
        cache_read_input_tokens: 10000,
        cache_creation_input_tokens: 5000,
        total_cost_usd: 0.14,
        num_turns: 3,
        duration_ms: 12000,
      },
    });
  });

  it("returns null usage when result message has no usage data", () => {
    const line = JSON.stringify({
      type: "result",
      result: "Done.",
    });
    const parsed = parseStreamJsonLine(line);
    expect(parsed).toEqual({
      type: "result",
      result: "Done.",
      usage: null,
    });
  });

  it("returns null usage when usage fields are partial", () => {
    const line = JSON.stringify({
      type: "result",
      result: "Done.",
      usage: { input_tokens: 100 },
    });
    const parsed = parseStreamJsonLine(line);
    expect(parsed).toEqual({
      type: "result",
      result: "Done.",
      usage: null,
    });
  });
});

describe("Orchestrator error handling", () => {
  it("propagates SandboxError when agent exits with non-zero code", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-err-host-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    // Layer where agent invocation returns non-zero exit code
    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory((dir) => {
      const fsLayer = FilesystemSandbox.layer(dir);
      return Layer.succeed(Sandbox, {
        exec: (command, options) =>
          Effect.flatMap(Sandbox, (real) => real.exec(command, options)).pipe(
            Effect.provide(fsLayer),
          ),
        execStreaming: (command, onStdoutLine, options) => {
          if (command.startsWith("claude ")) {
            return Effect.succeed({
              stdout: "",
              stderr: "Agent crashed",
              exitCode: 1,
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
    });

    const exit = await Effect.runPromiseExit(
      orchestrate({
        hostRepoDir: hostDir,
        sandboxRepoDir,
        iterations: 1,

        prompt: "do some work",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(exit._tag).toBe("Failure");
  });

  it("falls back to stdout when stream has no result line", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-fallback-host-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    // Layer where agent stream emits only assistant lines, no result line.
    // stdout contains the completion signal so the fallback path picks it up.
    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory((dir) => {
      const fsLayer = FilesystemSandbox.layer(dir);
      return Layer.succeed(Sandbox, {
        exec: (command, options) =>
          Effect.flatMap(Sandbox, (real) => real.exec(command, options)).pipe(
            Effect.provide(fsLayer),
          ),
        execStreaming: (command, onStdoutLine, options) => {
          if (command.startsWith("claude ")) {
            // Only emit an assistant line, no result line
            const assistantLine = JSON.stringify({
              type: "assistant",
              message: { content: [{ type: "text", text: "working..." }] },
            });
            onStdoutLine(assistantLine);
            return Effect.succeed({
              stdout: "All done. <promise>COMPLETE</promise>",
              stderr: "",
              exitCode: 0,
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
    });

    const result = await Effect.runPromise(
      orchestrate({
        hostRepoDir: hostDir,
        sandboxRepoDir,
        iterations: 5,

        prompt: "do some work",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    // Should detect COMPLETE from the stdout fallback
    expect(result.iterationsRun).toBe(1);
    expect(result.complete).toBe(true);
  });

  it("preserves iteration 1 work when agent fails on iteration 2", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-partial-host-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    let callCount = 0;

    // Layer: iteration 1 succeeds with a commit, iteration 2 agent crashes
    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory((dir) => {
      const fsLayer = FilesystemSandbox.layer(dir);
      return Layer.succeed(Sandbox, {
        exec: (command, options) =>
          Effect.flatMap(Sandbox, (real) => real.exec(command, options)).pipe(
            Effect.provide(fsLayer),
          ),
        execStreaming: (command, onStdoutLine, options) => {
          if (command.startsWith("claude ")) {
            callCount++;
            if (callCount === 1) {
              // Iteration 1: make a commit
              return Effect.gen(function* () {
                const cwd = options?.cwd ?? dir;
                yield* Effect.promise(async () => {
                  await writeFile(join(cwd, "iter1.txt"), "iteration 1 data");
                  await execAsync("git add -A", { cwd });
                  await execAsync('git config user.email "agent@test.com"', {
                    cwd,
                  });
                  await execAsync('git config user.name "Agent"', { cwd });
                  await execAsync('git commit -m "RALPH: iteration 1"', {
                    cwd,
                  });
                });
                const output = "Finished iteration 1.";
                const streamOutput = toStreamJson(output);
                for (const line of streamOutput.split("\n")) {
                  onStdoutLine(line);
                }
                return { stdout: streamOutput, stderr: "", exitCode: 0 };
              });
            }
            // Iteration 2: agent crashes
            return Effect.succeed({
              stdout: "",
              stderr: "Agent segfault",
              exitCode: 1,
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
    });

    const exit = await Effect.runPromiseExit(
      orchestrate({
        hostRepoDir: hostDir,
        sandboxRepoDir,
        iterations: 3,

        prompt: "do some work",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    // Should have failed on iteration 2
    expect(exit._tag).toBe("Failure");

    // But iteration 1's commit should be preserved on host
    const content = await readFile(join(hostDir, "iter1.txt"), "utf-8");
    expect(content).toBe("iteration 1 data");
  });

  it("propagates error when syncIn fails (invalid host repo)", async () => {
    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory((dir) =>
      makeMockAgentLayer(dir, async () => "done"),
    );

    const exit = await Effect.runPromiseExit(
      orchestrate({
        hostRepoDir: "/nonexistent/repo",
        sandboxRepoDir,
        iterations: 1,

        prompt: "do some work",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(exit._tag).toBe("Failure");
  });

  it("propagates error when getSandboxHead fails (empty repo)", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-nohead-host-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    // Layer that makes syncIn succeed but sabotages HEAD resolution
    // by making git rev-parse HEAD fail in sandbox after sync
    let syncDone = false;

    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory((dir) => {
      const fsLayer = FilesystemSandbox.layer(dir);
      return Layer.succeed(Sandbox, {
        exec: (command, options) => {
          // After syncIn, make git rev-parse HEAD fail
          if (syncDone && command === "git rev-parse HEAD") {
            return Effect.succeed({
              stdout: "",
              stderr: "fatal: ambiguous argument 'HEAD'",
              exitCode: 128,
            });
          }
          return Effect.flatMap(Sandbox, (real) =>
            real.exec(command, options),
          ).pipe(Effect.provide(fsLayer));
        },
        execStreaming: (command, onStdoutLine, options) => {
          if (command.includes("git rev-parse HEAD")) {
            syncDone = true;
          }
          return Effect.flatMap(Sandbox, (real) =>
            real.execStreaming(command, onStdoutLine, options),
          ).pipe(Effect.provide(fsLayer));
        },
        copyIn: (hostPath, sandboxPath) => {
          // Mark sync as done after copyIn (which happens during syncIn)
          syncDone = true;
          return Effect.flatMap(Sandbox, (real) =>
            real.copyIn(hostPath, sandboxPath),
          ).pipe(Effect.provide(fsLayer));
        },
        copyOut: (sandboxPath, hostPath) =>
          Effect.flatMap(Sandbox, (real) =>
            real.copyOut(sandboxPath, hostPath),
          ).pipe(Effect.provide(fsLayer)),
      });
    });

    const exit = await Effect.runPromiseExit(
      orchestrate({
        hostRepoDir: hostDir,
        sandboxRepoDir,
        iterations: 1,

        prompt: "do some work",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(exit._tag).toBe("Failure");
  });
});

describe("Orchestrator streaming", () => {
  it("invokes claude with stream-json and verbose flags", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-stream-host-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    let capturedCommand = "";

    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory((dir) => {
      const fsLayer = FilesystemSandbox.layer(dir);
      return Layer.succeed(Sandbox, {
        exec: (command, options) =>
          Effect.flatMap(Sandbox, (real) => real.exec(command, options)).pipe(
            Effect.provide(fsLayer),
          ),
        execStreaming: (command, onStdoutLine, options) => {
          if (command.startsWith("claude ")) {
            capturedCommand = command;
            const output = "Test output";
            const streamOutput = toStreamJson(output);
            for (const line of streamOutput.split("\n")) {
              onStdoutLine(line);
            }
            return Effect.succeed({
              stdout: streamOutput,
              stderr: "",
              exitCode: 0,
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
    });

    await Effect.runPromise(
      orchestrate({
        hostRepoDir: hostDir,
        sandboxRepoDir,
        iterations: 1,

        prompt: "do some work",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(capturedCommand).toContain("--output-format stream-json");
    expect(capturedCommand).toContain("--verbose");
    expect(capturedCommand).not.toContain("--output-format text");
  });

  it("extracts completion signal from stream-json result line", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-result-host-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    // Mock agent that emits completion via stream-json result type
    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory((dir) =>
      makeMockAgentLayer(dir, async () => {
        return "All done. <promise>COMPLETE</promise>";
      }),
    );

    const result = await Effect.runPromise(
      orchestrate({
        hostRepoDir: hostDir,
        sandboxRepoDir,
        iterations: 5,

        prompt: "do some work",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(result.iterationsRun).toBe(1);
    expect(result.complete).toBe(true);
  });

  it("uses DEFAULT_MODEL when no model is specified", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-defmodel-host-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    let capturedCommand = "";

    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory((dir) => {
      const fsLayer = FilesystemSandbox.layer(dir);
      return Layer.succeed(Sandbox, {
        exec: (command, options) =>
          Effect.flatMap(Sandbox, (real) => real.exec(command, options)).pipe(
            Effect.provide(fsLayer),
          ),
        execStreaming: (command, onStdoutLine, options) => {
          if (command.startsWith("claude ")) {
            capturedCommand = command;
            const output = "Done.";
            const streamOutput = toStreamJson(output);
            for (const line of streamOutput.split("\n")) {
              onStdoutLine(line);
            }
            return Effect.succeed({
              stdout: streamOutput,
              stderr: "",
              exitCode: 0,
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
    });

    await Effect.runPromise(
      orchestrate({
        hostRepoDir: hostDir,
        sandboxRepoDir,
        iterations: 1,
        prompt: "do some work",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(capturedCommand).toContain(`--model ${DEFAULT_MODEL}`);
  });

  it("uses custom model when specified in options", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-custmodel-host-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    let capturedCommand = "";

    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory((dir) => {
      const fsLayer = FilesystemSandbox.layer(dir);
      return Layer.succeed(Sandbox, {
        exec: (command, options) =>
          Effect.flatMap(Sandbox, (real) => real.exec(command, options)).pipe(
            Effect.provide(fsLayer),
          ),
        execStreaming: (command, onStdoutLine, options) => {
          if (command.startsWith("claude ")) {
            capturedCommand = command;
            const output = "Done.";
            const streamOutput = toStreamJson(output);
            for (const line of streamOutput.split("\n")) {
              onStdoutLine(line);
            }
            return Effect.succeed({
              stdout: streamOutput,
              stderr: "",
              exitCode: 0,
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
    });

    await Effect.runPromise(
      orchestrate({
        hostRepoDir: hostDir,
        sandboxRepoDir,
        iterations: 1,
        prompt: "do some work",
        model: "claude-sonnet-4-6",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    expect(capturedCommand).toContain("--model claude-sonnet-4-6");
    expect(capturedCommand).not.toContain(DEFAULT_MODEL);
  });
});

describe("Orchestrator prompt preprocessing", () => {
  it("preprocesses !`command` expressions in the prompt before invoking agent", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-preproc-host-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    let capturedPrompt = "";

    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory((dir) => {
      const fsLayer = FilesystemSandbox.layer(dir);
      return Layer.succeed(Sandbox, {
        exec: (command, options) =>
          Effect.flatMap(Sandbox, (real) => real.exec(command, options)).pipe(
            Effect.provide(fsLayer),
          ),
        execStreaming: (command, onStdoutLine, options) => {
          if (command.startsWith("claude ")) {
            // Capture the prompt passed to claude
            capturedPrompt = command;
            const output = "Done.";
            const streamOutput = toStreamJson(output);
            for (const line of streamOutput.split("\n")) {
              onStdoutLine(line);
            }
            return Effect.succeed({
              stdout: streamOutput,
              stderr: "",
              exitCode: 0,
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
    });

    await Effect.runPromise(
      orchestrate({
        hostRepoDir: hostDir,
        sandboxRepoDir,
        iterations: 1,
        prompt: "Context: !`echo hello-from-sandbox`\n\nDo the work.",
      }).pipe(Effect.provide(Layer.merge(factoryLayer, testDisplayLayer))),
    );

    // The prompt should have !`echo hello-from-sandbox` replaced with "hello-from-sandbox"
    expect(capturedPrompt).toContain("hello-from-sandbox");
    expect(capturedPrompt).not.toContain("!`echo");
  });

  it("passes prompt through unchanged when no !`command` expressions", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-nopreproc-host-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    let capturedPrompt = "";

    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory((dir) =>
      makeMockAgentLayer(dir, async () => {
        return "Done.";
      }),
    );

    // Intercept to capture prompt — use the simpler mock that captures command
    const { factoryLayer: fl2, sandboxRepoDir: sr2 } = makeTestSandboxFactory(
      (dir) => {
        const fsLayer = FilesystemSandbox.layer(dir);
        return Layer.succeed(Sandbox, {
          exec: (command, options) =>
            Effect.flatMap(Sandbox, (real) => real.exec(command, options)).pipe(
              Effect.provide(fsLayer),
            ),
          execStreaming: (command, onStdoutLine, options) => {
            if (command.startsWith("claude ")) {
              capturedPrompt = command;
              const output = "Done.";
              const streamOutput = toStreamJson(output);
              for (const line of streamOutput.split("\n")) {
                onStdoutLine(line);
              }
              return Effect.succeed({
                stdout: streamOutput,
                stderr: "",
                exitCode: 0,
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
      },
    );

    await Effect.runPromise(
      orchestrate({
        hostRepoDir: hostDir,
        sandboxRepoDir: sr2,
        iterations: 1,
        prompt: "Just a plain prompt with no commands.",
      }).pipe(Effect.provide(Layer.merge(fl2, testDisplayLayer))),
    );

    expect(capturedPrompt).toContain("Just a plain prompt with no commands.");
  });
});

describe("Orchestrator Display integration", () => {
  it("emits iteration header, spinner, usage summary, and completion status", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "orch-display-"));

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    const ref = Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([]);
    const displayLayer = SilentDisplay.layer(ref);

    const { factoryLayer, sandboxRepoDir } = makeTestSandboxFactory((dir) =>
      makeMockAgentLayer(dir, async () => {
        return "All done. <promise>COMPLETE</promise>";
      }),
    );

    // Override toStreamJson to include usage data
    const mockLayer = makeTestSandboxFactory((dir) => {
      const fsLayer = FilesystemSandbox.layer(dir);
      return Layer.succeed(Sandbox, {
        exec: (command, options) =>
          Effect.flatMap(Sandbox, (real) => real.exec(command, options)).pipe(
            Effect.provide(fsLayer),
          ),
        execStreaming: (command, onStdoutLine, options) => {
          if (command.startsWith("claude ")) {
            const output = "All done. <promise>COMPLETE</promise>";
            const lines = [
              JSON.stringify({
                type: "assistant",
                message: { content: [{ type: "text", text: output }] },
              }),
              JSON.stringify({
                type: "result",
                result: output,
                total_cost_usd: 0.14,
                num_turns: 3,
                duration_ms: 12000,
                usage: {
                  input_tokens: 52340,
                  output_tokens: 3201,
                  cache_read_input_tokens: 10000,
                  cache_creation_input_tokens: 5000,
                },
              }),
            ];
            for (const line of lines) {
              onStdoutLine(line);
            }
            return Effect.succeed({
              stdout: lines.join("\n"),
              stderr: "",
              exitCode: 0,
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
    });

    await Effect.runPromise(
      orchestrate({
        hostRepoDir: hostDir,
        sandboxRepoDir: mockLayer.sandboxRepoDir,
        iterations: 5,
        prompt: "do some work",
      }).pipe(
        Effect.provide(Layer.merge(mockLayer.factoryLayer, displayLayer)),
      ),
    );

    const entries = await Effect.runPromise(Ref.get(ref));

    // Iteration header
    const statusEntries = entries.filter((e) => e._tag === "status");
    expect(statusEntries.some((e) => e.message.includes("Iteration 1/5"))).toBe(
      true,
    );

    // Task log for sandbox setup
    const taskLogEntries = entries.filter((e) => e._tag === "taskLog");
    expect(
      taskLogEntries.some((e) => e.title.includes("Setting up sandbox")),
    ).toBe(true);

    // Spinner for sync-out
    const spinnerEntries = entries.filter((e) => e._tag === "spinner");
    expect(
      spinnerEntries.some((e) => e.message.includes("Syncing results")),
    ).toBe(true);

    // Usage summary
    const summaryEntries = entries.filter((e) => e._tag === "summary");
    expect(summaryEntries.length).toBeGreaterThanOrEqual(1);
    const usageSummary = summaryEntries[0] as {
      _tag: "summary";
      title: string;
      rows: Record<string, string>;
    };
    expect(usageSummary.rows).toHaveProperty("Tokens");
    expect(usageSummary.rows).toHaveProperty("Cost");

    // Completion status
    expect(
      statusEntries.some(
        (e) =>
          e.message.includes("completion") || e.message.includes("complete"),
      ),
    ).toBe(true);
  });
});
