import { Effect, Exit, Layer, Ref } from "effect";
import { NodeFileSystem } from "@effect/platform-node";
import { exec } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { AgentError, TimeoutError, WorktreeError } from "./errors.js";
import { SilentDisplay, type DisplayEntry } from "./Display.js";
import {
  createBindMountSandboxProvider,
  type SandboxProvider,
  type BindMountSandboxHandle,
  type BindMountBranchStrategy,
} from "./SandboxProvider.js";
import { testIsolated } from "./sandboxes/test-isolated.js";
import {
  createIsolatedSandboxProvider,
  type IsolatedSandboxHandle,
  type IsolatedBranchStrategy,
} from "./SandboxProvider.js";

vi.mock("./WorktreeManager.js", () => ({
  create: vi.fn(),
  remove: vi.fn(),
  pruneStale: vi.fn(),
  hasUncommittedChanges: vi.fn(),
}));

import * as WorktreeManager from "./WorktreeManager.js";
import {
  Sandbox,
  SandboxFactory,
  SandboxConfig,
  WorktreeDockerSandboxFactory,
  SANDBOX_WORKSPACE_DIR,
} from "./SandboxFactory.js";

const mockCreate = vi.mocked(WorktreeManager.create);
const mockRemove = vi.mocked(WorktreeManager.remove);
const mockPruneStale = vi.mocked(WorktreeManager.pruneStale);
const mockHasUncommittedChanges = vi.mocked(
  WorktreeManager.hasUncommittedChanges,
);

/** Create a mock sandbox provider that records calls and delegates to a no-op handle. */
const makeMockProvider = (
  branchStrategy?: BindMountBranchStrategy,
): {
  provider: SandboxProvider;
  createCalls: any[];
  closeCalls: number;
} => {
  const createCalls: any[] = [];
  let closeCalls = 0;
  const provider = createBindMountSandboxProvider({
    name: "test-provider",
    branchStrategy,
    create: async (options) => {
      createCalls.push(options);
      const handle: BindMountSandboxHandle = {
        workspacePath: SANDBOX_WORKSPACE_DIR,
        exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
        execStreaming: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
        close: async () => {
          closeCalls++;
        },
      };
      return handle;
    },
  });
  return {
    provider,
    createCalls,
    get closeCalls() {
      return closeCalls;
    },
  };
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("WorktreeDockerSandboxFactory", () => {
  let hostRepoDir: string;
  const worktreePath = "/tmp/sandcastle-worktrees/sandcastle-123";
  const tempDirs: string[] = [];

  const makeTempRepo = async () => {
    const dir = await mkdtemp(join(tmpdir(), "sandcastle-test-"));
    tempDirs.push(dir);
    await mkdir(join(dir, ".git"));
    return dir;
  };

  let mockProvider: ReturnType<typeof makeMockProvider>;

  const makeLayer = (
    displayRef = Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([]),
  ) =>
    Layer.provide(
      WorktreeDockerSandboxFactory.layer,
      Layer.mergeAll(
        Layer.succeed(SandboxConfig, {
          env: { FOO: "bar" },
          hostRepoDir,
          sandboxProvider: mockProvider.provider,
        }),
        NodeFileSystem.layer,
        SilentDisplay.layer(displayRef),
      ),
    );

  beforeEach(async () => {
    hostRepoDir = await makeTempRepo();
    mockProvider = makeMockProvider({ type: "merge-to-head" });
    mockCreate.mockReturnValue(
      Effect.succeed({
        path: worktreePath,
        branch: "sandcastle/20240101-000000",
      }),
    );
    mockRemove.mockReturnValue(Effect.void);
    mockPruneStale.mockReturnValue(Effect.void);
    // Default: clean worktree (no uncommitted changes)
    mockHasUncommittedChanges.mockReturnValue(Effect.succeed(false));
  });

  afterEach(async () => {
    await Promise.all(
      tempDirs.map((d) => rm(d, { recursive: true, force: true })),
    );
    tempDirs.length = 0;
  });

  it("passes branch from provider's branchStrategy to WorktreeManager.create when branch is specified", async () => {
    const branchProvider = createBindMountSandboxProvider({
      name: "test-provider",
      branchStrategy: { type: "branch", branch: "feature/my-branch" },
      create: mockProvider.provider.create,
    });
    const layerWithBranch = Layer.provide(
      WorktreeDockerSandboxFactory.layer,
      Layer.mergeAll(
        Layer.succeed(SandboxConfig, {
          env: {},
          hostRepoDir,
          sandboxProvider: branchProvider,
        }),
        NodeFileSystem.layer,
        SilentDisplay.layer(Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([])),
      ),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        yield* factory.withSandbox(() => Effect.void);
      }).pipe(Effect.provide(layerWithBranch)),
    );

    expect(mockCreate).toHaveBeenCalledWith(hostRepoDir, {
      branch: "feature/my-branch",
    });
  });

  it("calls create without branch options when no branch in config", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        yield* factory.withSandbox(() => Effect.void);
      }).pipe(Effect.provide(makeLayer())),
    );

    expect(mockCreate).toHaveBeenCalledWith(hostRepoDir, {
      name: undefined,
    });
  });

  it("creates a worktree before calling the provider", async () => {
    const callOrder: string[] = [];
    mockCreate.mockImplementation(() =>
      Effect.sync(() => {
        callOrder.push("worktree-create");
        return { path: worktreePath, branch: "sandcastle/20240101-000000" };
      }),
    );
    const { provider } = makeMockProvider({ type: "merge-to-head" });
    const origCreate = provider.create;
    (provider as any).create = async (opts: any) => {
      callOrder.push("provider-create");
      return origCreate(opts);
    };

    const layer = Layer.provide(
      WorktreeDockerSandboxFactory.layer,
      Layer.mergeAll(
        Layer.succeed(SandboxConfig, {
          env: { FOO: "bar" },
          hostRepoDir,
          sandboxProvider: provider,
        }),
        NodeFileSystem.layer,
        SilentDisplay.layer(Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([])),
      ),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        yield* factory.withSandbox(() => Effect.void);
      }).pipe(Effect.provide(layer)),
    );

    expect(callOrder.indexOf("worktree-create")).toBeLessThan(
      callOrder.indexOf("provider-create"),
    );
  });

  it("passes worktree path and git mounts to provider.create", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        yield* factory.withSandbox(() => Effect.void);
      }).pipe(Effect.provide(makeLayer())),
    );

    expect(mockProvider.createCalls).toHaveLength(1);
    const opts = mockProvider.createCalls[0];
    // Should include worktree mount
    expect(opts.mounts).toContainEqual({
      hostPath: worktreePath,
      sandboxPath: SANDBOX_WORKSPACE_DIR,
    });
    // Should include git mount
    expect(opts.mounts).toContainEqual({
      hostPath: `${hostRepoDir}/.git`,
      sandboxPath: `${hostRepoDir}/.git`,
    });
  });

  it("removes worktree after the effect completes", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        yield* factory.withSandbox(() => Effect.void);
      }).pipe(Effect.provide(makeLayer())),
    );

    expect(mockRemove).toHaveBeenCalledWith(worktreePath);
  });

  it("prunes stale worktrees before creating a new worktree", async () => {
    const callOrder: string[] = [];
    mockPruneStale.mockImplementation(() =>
      Effect.sync(() => {
        callOrder.push("pruneStale");
      }),
    );
    mockCreate.mockImplementation(() =>
      Effect.sync(() => {
        callOrder.push("create");
        return { path: worktreePath, branch: "sandcastle/20240101-000000" };
      }),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        yield* factory.withSandbox(() => Effect.void);
      }).pipe(Effect.provide(makeLayer())),
    );

    expect(mockPruneStale).toHaveBeenCalledWith(hostRepoDir);
    expect(callOrder.indexOf("pruneStale")).toBeLessThan(
      callOrder.indexOf("create"),
    );
  });

  it("continues creating the worktree even if pruning fails", async () => {
    mockPruneStale.mockReturnValue(
      Effect.fail(new WorktreeError({ message: "prune failed" })),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        yield* factory.withSandbox(() => Effect.void);
      }).pipe(Effect.provide(makeLayer())),
    );

    expect(mockCreate).toHaveBeenCalledWith(hostRepoDir, {
      name: undefined,
    });
  });

  it("closes provider handle on release", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        yield* factory.withSandbox(() => Effect.void);
      }).pipe(Effect.provide(makeLayer())),
    );

    expect(mockProvider.closeCalls).toBe(1);
  });

  it("preserves worktree (does not remove) when the effect fails with dirty worktree", async () => {
    mockHasUncommittedChanges.mockReturnValue(Effect.succeed(true));
    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const factory = yield* SandboxFactory;
          yield* factory.withSandbox(() => Effect.die("boom"));
        }).pipe(Effect.provide(makeLayer())),
      ),
    ).rejects.toThrow();

    expect(mockRemove).not.toHaveBeenCalled();
  });

  it("closes provider handle but preserves worktree on typed failure with dirty worktree", async () => {
    mockHasUncommittedChanges.mockReturnValue(Effect.succeed(true));
    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const factory = yield* SandboxFactory;
          yield* factory.withSandbox(() =>
            Effect.fail(new WorktreeError({ message: "boom" })),
          );
        }).pipe(Effect.provide(makeLayer())),
      ),
    ).rejects.toThrow();

    // Worktree must NOT be removed
    expect(mockRemove).not.toHaveBeenCalled();
    // Provider handle must be closed
    expect(mockProvider.closeCalls).toBe(1);
  });

  it("attaches preservedWorktreePath to TimeoutError on failure with dirty worktree", async () => {
    mockHasUncommittedChanges.mockReturnValue(Effect.succeed(true));
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        yield* factory.withSandbox(() =>
          Effect.fail(
            new TimeoutError({ message: "timed out", idleTimeoutSeconds: 30 }),
          ),
        );
      }).pipe(Effect.provide(makeLayer())),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) throw new Error("unreachable");
    expect(exit.cause._tag).toBe("Fail");
    if (exit.cause._tag !== "Fail") throw new Error("unreachable");
    expect(exit.cause.error).toBeInstanceOf(TimeoutError);
    expect((exit.cause.error as TimeoutError).preservedWorktreePath).toBe(
      worktreePath,
    );
  });

  it("attaches preservedWorktreePath to AgentError on failure with dirty worktree", async () => {
    mockHasUncommittedChanges.mockReturnValue(Effect.succeed(true));
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        yield* factory.withSandbox(() =>
          Effect.fail(new AgentError({ message: "agent failed" })),
        );
      }).pipe(Effect.provide(makeLayer())),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) throw new Error("unreachable");
    expect(exit.cause._tag).toBe("Fail");
    if (exit.cause._tag !== "Fail") throw new Error("unreachable");
    expect(exit.cause.error).toBeInstanceOf(AgentError);
    expect((exit.cause.error as AgentError).preservedWorktreePath).toBe(
      worktreePath,
    );
  });

  it("logs copy-to-sandbox as a spinner when copyToSandbox paths are provided", async () => {
    const ref = Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([]);
    const layerWithCopy = Layer.provide(
      WorktreeDockerSandboxFactory.layer,
      Layer.mergeAll(
        Layer.succeed(SandboxConfig, {
          env: {},
          hostRepoDir,
          copyToSandbox: ["node_modules"],
          sandboxProvider: mockProvider.provider,
        }),
        NodeFileSystem.layer,
        SilentDisplay.layer(ref),
      ),
    );

    vi.mock("./CopyToSandbox.js", () => ({
      copyToSandbox: vi.fn(() => Effect.succeed(undefined)),
    }));

    await Effect.runPromise(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        yield* factory.withSandbox(() => Effect.void);
      }).pipe(Effect.provide(layerWithCopy)),
    );

    const entries = await Effect.runPromise(Ref.get(ref));
    const spinnerEntry = entries.find(
      (e) => e._tag === "spinner" && e.message === "Copying to sandbox",
    );
    expect(spinnerEntry).toBeDefined();
  });

  it("removes worktree silently on success with clean worktree", async () => {
    mockHasUncommittedChanges.mockReturnValue(Effect.succeed(false));
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await Effect.runPromise(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        yield* factory.withSandbox(() => Effect.void);
      }).pipe(Effect.provide(makeLayer())),
    );

    expect(mockRemove).toHaveBeenCalledWith(worktreePath);
    expect(stderrSpy).not.toHaveBeenCalled();
    stderrSpy.mockRestore();
  });

  it("preserves worktree and returns preservedWorktreePath on success with dirty worktree", async () => {
    mockHasUncommittedChanges.mockReturnValue(Effect.succeed(true));

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        return yield* factory.withSandbox(() => Effect.succeed("done"));
      }).pipe(Effect.provide(makeLayer())),
    );

    expect(mockRemove).not.toHaveBeenCalled();
    expect(result.preservedWorktreePath).toBe(worktreePath);
    expect(result.value).toBe("done");
  });

  it("prints uncommitted changes message on success with dirty worktree", async () => {
    mockHasUncommittedChanges.mockReturnValue(Effect.succeed(true));
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await Effect.runPromise(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        yield* factory.withSandbox(() => Effect.void);
      }).pipe(Effect.provide(makeLayer())),
    );

    const output = stderrSpy.mock.calls.map((c) => c[0]).join(" ");
    expect(output).toContain("uncommitted changes");
    expect(output).toContain(worktreePath);
    stderrSpy.mockRestore();
  });

  it("removes worktree on failure with clean worktree", async () => {
    mockHasUncommittedChanges.mockReturnValue(Effect.succeed(false));

    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const factory = yield* SandboxFactory;
          yield* factory.withSandbox(() =>
            Effect.fail(new AgentError({ message: "agent failed" })),
          );
        }).pipe(Effect.provide(makeLayer())),
      ),
    ).rejects.toThrow();

    expect(mockRemove).toHaveBeenCalledWith(worktreePath);
  });

  it("prints 'no uncommitted changes' message on failure with clean worktree", async () => {
    mockHasUncommittedChanges.mockReturnValue(Effect.succeed(false));
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const factory = yield* SandboxFactory;
          yield* factory.withSandbox(() =>
            Effect.fail(new AgentError({ message: "agent failed" })),
          );
        }).pipe(Effect.provide(makeLayer())),
      ),
    ).rejects.toThrow();

    const output = stderrSpy.mock.calls.map((c) => c[0]).join(" ");
    expect(output).toContain("no uncommitted changes");
    stderrSpy.mockRestore();
  });

  it("does not attach preservedWorktreePath to TimeoutError when worktree is clean on failure", async () => {
    mockHasUncommittedChanges.mockReturnValue(Effect.succeed(false));
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        yield* factory.withSandbox(() =>
          Effect.fail(
            new TimeoutError({ message: "timed out", idleTimeoutSeconds: 30 }),
          ),
        );
      }).pipe(Effect.provide(makeLayer())),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) throw new Error("unreachable");
    expect(exit.cause._tag).toBe("Fail");
    if (exit.cause._tag !== "Fail") throw new Error("unreachable");
    expect(exit.cause.error).toBeInstanceOf(TimeoutError);
    expect(
      (exit.cause.error as TimeoutError).preservedWorktreePath,
    ).toBeUndefined();
  });

  describe("head branch strategy", () => {
    const makeHeadProvider = () =>
      createBindMountSandboxProvider({
        name: "test-provider",
        branchStrategy: { type: "head" },
        create: mockProvider.provider.create,
      });

    const makeHeadLayer = (
      displayRef = Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([]),
    ) =>
      Layer.provide(
        WorktreeDockerSandboxFactory.layer,
        Layer.mergeAll(
          Layer.succeed(SandboxConfig, {
            env: { FOO: "bar" },
            hostRepoDir,
            sandboxProvider: makeHeadProvider(),
          }),
          NodeFileSystem.layer,
          SilentDisplay.layer(displayRef),
        ),
      );

    it("does not create or remove a worktree", async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const factory = yield* SandboxFactory;
          yield* factory.withSandbox(() => Effect.void);
        }).pipe(Effect.provide(makeHeadLayer())),
      );

      expect(mockCreate).not.toHaveBeenCalled();
      expect(mockRemove).not.toHaveBeenCalled();
      expect(mockPruneStale).not.toHaveBeenCalled();
    });

    it("passes host repo dir and git mounts to provider", async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const factory = yield* SandboxFactory;
          yield* factory.withSandbox(() => Effect.void);
        }).pipe(Effect.provide(makeHeadLayer())),
      );

      expect(mockProvider.createCalls).toHaveLength(1);
      const opts = mockProvider.createCalls[0];
      expect(opts.mounts).toContainEqual({
        hostPath: hostRepoDir,
        sandboxPath: SANDBOX_WORKSPACE_DIR,
      });
      expect(opts.mounts).toContainEqual({
        hostPath: `${hostRepoDir}/.git`,
        sandboxPath: `${hostRepoDir}/.git`,
      });
    });

    it("returns undefined preservedWorktreePath", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const factory = yield* SandboxFactory;
          return yield* factory.withSandbox(() => Effect.succeed("done"));
        }).pipe(Effect.provide(makeHeadLayer())),
      );

      expect(result.preservedWorktreePath).toBeUndefined();
      expect(result.value).toBe("done");
    });

    it("does not pass hostWorktreePath to the effect", async () => {
      let receivedInfo: { hostWorktreePath?: string } | undefined;
      await Effect.runPromise(
        Effect.gen(function* () {
          const factory = yield* SandboxFactory;
          yield* factory.withSandbox((info) => {
            receivedInfo = info;
            return Effect.void;
          });
        }).pipe(Effect.provide(makeHeadLayer())),
      );

      expect(receivedInfo?.hostWorktreePath).toBeUndefined();
    });
  });

  it("returns undefined preservedWorktreePath on success with clean worktree", async () => {
    mockHasUncommittedChanges.mockReturnValue(Effect.succeed(false));

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        return yield* factory.withSandbox(() => Effect.succeed("done"));
      }).pipe(Effect.provide(makeLayer())),
    );

    expect(result.preservedWorktreePath).toBeUndefined();
    expect(result.value).toBe("done");
  });
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

describe("WorktreeDockerSandboxFactory — isolated providers", () => {
  const tempDirs: string[] = [];

  const makeIsolatedLayer = (hostRepoDir: string, copyToSandbox?: string[]) =>
    Layer.provide(
      WorktreeDockerSandboxFactory.layer,
      Layer.mergeAll(
        Layer.succeed(SandboxConfig, {
          env: {},
          hostRepoDir,
          copyToSandbox,
          sandboxProvider: testIsolated(),
        }),
        NodeFileSystem.layer,
        SilentDisplay.layer(Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([])),
      ),
    );

  afterEach(async () => {
    await Promise.all(
      tempDirs.map((d) => rm(d, { recursive: true, force: true })),
    );
    tempDirs.length = 0;
  });

  it("copies copyToSandbox files into the isolated sandbox via copyIn", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandcastle-test-"));
    tempDirs.push(hostDir);
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial");

    // Create a file to copy (not tracked by git)
    await writeFile(join(hostDir, "extra.txt"), "extra content");

    let fileContent = "";
    await Effect.runPromise(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        yield* factory.withSandbox(() =>
          Effect.gen(function* () {
            const sandbox = yield* Sandbox;
            const result = yield* sandbox.exec("cat extra.txt");
            fileContent = result.stdout.trim();
          }),
        );
      }).pipe(Effect.provide(makeIsolatedLayer(hostDir, ["extra.txt"]))),
    );

    expect(fileContent).toBe("extra content");
  });

  it("copies nested copyToSandbox paths, creating parent directories", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandcastle-test-"));
    tempDirs.push(hostDir);
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial");

    // Create a nested file to copy
    await mkdir(join(hostDir, "subdir"), { recursive: true });
    await writeFile(join(hostDir, "subdir", "config.json"), '{"key":"value"}');

    let fileContent = "";
    await Effect.runPromise(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        yield* factory.withSandbox(() =>
          Effect.gen(function* () {
            const sandbox = yield* Sandbox;
            const result = yield* sandbox.exec("cat subdir/config.json");
            fileContent = result.stdout.trim();
          }),
        );
      }).pipe(
        Effect.provide(makeIsolatedLayer(hostDir, ["subdir/config.json"])),
      ),
    );

    expect(fileContent).toBe('{"key":"value"}');
  });

  it("works without copyToSandbox (no regression)", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandcastle-test-"));
    tempDirs.push(hostDir);
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello world", "initial");

    let fileContent = "";
    await Effect.runPromise(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        yield* factory.withSandbox(() =>
          Effect.gen(function* () {
            const sandbox = yield* Sandbox;
            const result = yield* sandbox.exec("cat hello.txt");
            fileContent = result.stdout.trim();
          }),
        );
      }).pipe(Effect.provide(makeIsolatedLayer(hostDir))),
    );

    expect(fileContent).toBe("hello world");
  });

  it("skips missing copyToSandbox paths without error", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandcastle-test-"));
    tempDirs.push(hostDir);
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial");

    // Request a file that doesn't exist — should not fail
    await Effect.runPromise(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        yield* factory.withSandbox(() => Effect.void);
      }).pipe(Effect.provide(makeIsolatedLayer(hostDir, ["nonexistent.txt"]))),
    );
  });

  it("reads branchStrategy from isolated provider (defaults to merge-to-head)", () => {
    const provider = testIsolated();
    expect(provider.branchStrategy).toEqual({ type: "merge-to-head" });
  });

  it("accepts explicit branchStrategy on testIsolated()", () => {
    const provider = testIsolated({
      branchStrategy: { type: "branch", branch: "feature/foo" },
    });
    expect(provider.branchStrategy).toEqual({
      type: "branch",
      branch: "feature/foo",
    });
  });
});
