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
  type BranchStrategy,
} from "./SandboxProvider.js";
import { testIsolated } from "./sandboxes/test-isolated.js";

vi.mock("./WorkspaceManager.js", () => ({
  create: vi.fn(),
  remove: vi.fn(),
  pruneStale: vi.fn(),
  hasUncommittedChanges: vi.fn(),
}));

import * as WorkspaceManager from "./WorkspaceManager.js";
import {
  Sandbox,
  SandboxFactory,
  SandboxConfig,
  WorktreeDockerSandboxFactory,
  SANDBOX_WORKSPACE_DIR,
} from "./SandboxFactory.js";

const mockCreate = vi.mocked(WorkspaceManager.create);
const mockRemove = vi.mocked(WorkspaceManager.remove);
const mockPruneStale = vi.mocked(WorkspaceManager.pruneStale);
const mockHasUncommittedChanges = vi.mocked(
  WorkspaceManager.hasUncommittedChanges,
);

/** Create a mock sandbox provider that records calls and delegates to a no-op handle. */
const makeMockProvider = (): {
  provider: SandboxProvider;
  createCalls: any[];
  closeCalls: number;
} => {
  const createCalls: any[] = [];
  let closeCalls = 0;
  const provider = createBindMountSandboxProvider({
    name: "test-provider",
    create: async (options) => {
      createCalls.push(options);
      const handle: BindMountSandboxHandle = {
        workspacePath: SANDBOX_WORKSPACE_DIR,
        exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
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
    branchStrategy: BranchStrategy = { type: "merge-to-head" },
  ) =>
    Layer.provide(
      WorktreeDockerSandboxFactory.layer,
      Layer.mergeAll(
        Layer.succeed(SandboxConfig, {
          env: { FOO: "bar" },
          hostRepoDir,
          sandboxProvider: mockProvider.provider,
          branchStrategy,
        }),
        NodeFileSystem.layer,
        SilentDisplay.layer(displayRef),
      ),
    );

  beforeEach(async () => {
    hostRepoDir = await makeTempRepo();
    mockProvider = makeMockProvider();
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

  it("passes branch from branchStrategy config to WorkspaceManager.create when branch is specified", async () => {
    const layerWithBranch = makeLayer(
      Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([]),
      { type: "branch", branch: "feature/my-branch" },
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
    const { provider } = makeMockProvider();
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
          branchStrategy: { type: "merge-to-head" },
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

  it("attaches preservedWorkspacePath to TimeoutError on failure with dirty worktree", async () => {
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
    expect((exit.cause.error as TimeoutError).preservedWorkspacePath).toBe(
      worktreePath,
    );
  });

  it("attaches preservedWorkspacePath to AgentError on failure with dirty worktree", async () => {
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
    expect((exit.cause.error as AgentError).preservedWorkspacePath).toBe(
      worktreePath,
    );
  });

  it("logs copy-to-sandbox as a spinner when copyToWorkspace paths are provided", async () => {
    const ref = Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([]);
    const layerWithCopy = Layer.provide(
      WorktreeDockerSandboxFactory.layer,
      Layer.mergeAll(
        Layer.succeed(SandboxConfig, {
          env: {},
          hostRepoDir,
          copyToWorkspace: ["node_modules"],
          sandboxProvider: mockProvider.provider,
          branchStrategy: { type: "merge-to-head" },
        }),
        NodeFileSystem.layer,
        SilentDisplay.layer(ref),
      ),
    );

    vi.mock("./CopyToWorkspace.js", () => ({
      copyToWorkspace: vi.fn(() => Effect.succeed(undefined)),
    }));

    await Effect.runPromise(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        yield* factory.withSandbox(() => Effect.void);
      }).pipe(Effect.provide(layerWithCopy)),
    );

    const entries = await Effect.runPromise(Ref.get(ref));
    const spinnerEntry = entries.find(
      (e) => e._tag === "spinner" && e.message === "Copying to workspace",
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

  it("preserves worktree and returns preservedWorkspacePath on success with dirty worktree", async () => {
    mockHasUncommittedChanges.mockReturnValue(Effect.succeed(true));

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        return yield* factory.withSandbox(() => Effect.succeed("done"));
      }).pipe(Effect.provide(makeLayer())),
    );

    expect(mockRemove).not.toHaveBeenCalled();
    expect(result.preservedWorkspacePath).toBe(worktreePath);
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

  it("does not attach preservedWorkspacePath to TimeoutError when worktree is clean on failure", async () => {
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
      (exit.cause.error as TimeoutError).preservedWorkspacePath,
    ).toBeUndefined();
  });

  describe("head branch strategy", () => {
    const makeHeadLayer = (
      displayRef = Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([]),
    ) => makeLayer(displayRef, { type: "head" });

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

    it("returns undefined preservedWorkspacePath", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const factory = yield* SandboxFactory;
          return yield* factory.withSandbox(() => Effect.succeed("done"));
        }).pipe(Effect.provide(makeHeadLayer())),
      );

      expect(result.preservedWorkspacePath).toBeUndefined();
      expect(result.value).toBe("done");
    });

    it("passes hostWorkspacePath pointing to host repo dir", async () => {
      let receivedInfo: { hostWorkspacePath?: string } | undefined;
      await Effect.runPromise(
        Effect.gen(function* () {
          const factory = yield* SandboxFactory;
          yield* factory.withSandbox((info) => {
            receivedInfo = info;
            return Effect.void;
          });
        }).pipe(Effect.provide(makeHeadLayer())),
      );

      expect(receivedInfo?.hostWorkspacePath).toBe(hostRepoDir);
    });
  });

  it("returns undefined preservedWorkspacePath on success with clean worktree", async () => {
    mockHasUncommittedChanges.mockReturnValue(Effect.succeed(false));

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        return yield* factory.withSandbox(() => Effect.succeed("done"));
      }).pipe(Effect.provide(makeLayer())),
    );

    expect(result.preservedWorkspacePath).toBeUndefined();
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

  const makeIsolatedLayer = (hostRepoDir: string, copyToWorkspace?: string[]) =>
    Layer.provide(
      WorktreeDockerSandboxFactory.layer,
      Layer.mergeAll(
        Layer.succeed(SandboxConfig, {
          env: {},
          hostRepoDir,
          copyToWorkspace,
          sandboxProvider: testIsolated(),
          branchStrategy: { type: "merge-to-head" },
        }),
        NodeFileSystem.layer,
        SilentDisplay.layer(Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([])),
      ),
    );

  /** Set up WorkspaceManager mocks so the worktree path points at the real repo. */
  const setupWorktreeMocks = (hostDir: string) => {
    mockCreate.mockReturnValue(
      Effect.succeed({ path: hostDir, branch: "sandcastle/20240101-000000" }),
    );
    mockRemove.mockReturnValue(Effect.void);
    mockPruneStale.mockReturnValue(Effect.void);
    mockHasUncommittedChanges.mockReturnValue(Effect.succeed(false));
  };

  afterEach(async () => {
    await Promise.all(
      tempDirs.map((d) => rm(d, { recursive: true, force: true })),
    );
    tempDirs.length = 0;
  });

  it("copies copyToWorkspace files into the isolated sandbox via copyIn", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandcastle-test-"));
    tempDirs.push(hostDir);
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial");
    setupWorktreeMocks(hostDir);

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

  it("copies nested copyToWorkspace paths, creating parent directories", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandcastle-test-"));
    tempDirs.push(hostDir);
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial");
    setupWorktreeMocks(hostDir);

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

  it("works without copyToWorkspace (no regression)", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandcastle-test-"));
    tempDirs.push(hostDir);
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello world", "initial");
    setupWorktreeMocks(hostDir);

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

  it("copies copyToWorkspace directories into the isolated sandbox via copyIn", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandcastle-test-"));
    tempDirs.push(hostDir);
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial");
    setupWorktreeMocks(hostDir);

    // Create a directory to copy (not tracked by git)
    await mkdir(join(hostDir, "config", "nested"), { recursive: true });
    await writeFile(join(hostDir, "config", "a.json"), '{"a":1}');
    await writeFile(join(hostDir, "config", "nested", "b.json"), '{"b":2}');

    let contentA = "";
    let contentB = "";
    await Effect.runPromise(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        yield* factory.withSandbox(() =>
          Effect.gen(function* () {
            const sandbox = yield* Sandbox;
            contentA = (yield* sandbox.exec("cat config/a.json")).stdout.trim();
            contentB = (yield* sandbox.exec(
              "cat config/nested/b.json",
            )).stdout.trim();
          }),
        );
      }).pipe(Effect.provide(makeIsolatedLayer(hostDir, ["config"]))),
    );

    expect(contentA).toBe('{"a":1}');
    expect(contentB).toBe('{"b":2}');
  });

  it("skips missing copyToWorkspace paths without error", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandcastle-test-"));
    tempDirs.push(hostDir);
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial");
    setupWorktreeMocks(hostDir);

    // Request a file that doesn't exist — should not fail
    await Effect.runPromise(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        yield* factory.withSandbox(() => Effect.void);
      }).pipe(Effect.provide(makeIsolatedLayer(hostDir, ["nonexistent.txt"]))),
    );
  });

  it("isolated provider does not have a branchStrategy property", () => {
    const provider = testIsolated();
    expect("branchStrategy" in provider).toBe(false);
  });

  it("creates a worktree before starting the isolated sandbox", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandcastle-test-"));
    tempDirs.push(hostDir);
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial");

    mockCreate.mockReturnValue(
      Effect.succeed({ path: hostDir, branch: "sandcastle/20240101-000000" }),
    );
    mockRemove.mockReturnValue(Effect.void);
    mockPruneStale.mockReturnValue(Effect.void);
    mockHasUncommittedChanges.mockReturnValue(Effect.succeed(false));

    await Effect.runPromise(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        yield* factory.withSandbox(() => Effect.void);
      }).pipe(Effect.provide(makeIsolatedLayer(hostDir))),
    );

    expect(mockCreate).toHaveBeenCalledWith(hostDir, { name: undefined });
  });

  it("creates a worktree with a named branch for branch strategy", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandcastle-test-"));
    tempDirs.push(hostDir);
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial");

    mockCreate.mockReturnValue(
      Effect.succeed({ path: hostDir, branch: "feature/my-branch" }),
    );
    mockRemove.mockReturnValue(Effect.void);
    mockPruneStale.mockReturnValue(Effect.void);
    mockHasUncommittedChanges.mockReturnValue(Effect.succeed(false));

    const layer = Layer.provide(
      WorktreeDockerSandboxFactory.layer,
      Layer.mergeAll(
        Layer.succeed(SandboxConfig, {
          env: {},
          hostRepoDir: hostDir,
          sandboxProvider: testIsolated(),
          branchStrategy: { type: "branch", branch: "feature/my-branch" },
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

    expect(mockCreate).toHaveBeenCalledWith(hostDir, {
      branch: "feature/my-branch",
    });
  });

  it("provides hostWorkspacePath in SandboxInfo", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandcastle-test-"));
    tempDirs.push(hostDir);
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial");

    const fakeWorktreePath = hostDir;
    mockCreate.mockReturnValue(
      Effect.succeed({
        path: fakeWorktreePath,
        branch: "sandcastle/20240101-000000",
      }),
    );
    mockRemove.mockReturnValue(Effect.void);
    mockPruneStale.mockReturnValue(Effect.void);
    mockHasUncommittedChanges.mockReturnValue(Effect.succeed(false));

    let receivedInfo: { hostWorkspacePath?: string } | undefined;
    await Effect.runPromise(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        yield* factory.withSandbox((info) => {
          receivedInfo = info;
          return Effect.void;
        });
      }).pipe(Effect.provide(makeIsolatedLayer(hostDir))),
    );

    expect(receivedInfo?.hostWorkspacePath).toBe(fakeWorktreePath);
  });

  it("removes worktree on success with clean worktree", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandcastle-test-"));
    tempDirs.push(hostDir);
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial");

    mockCreate.mockReturnValue(
      Effect.succeed({ path: hostDir, branch: "sandcastle/20240101-000000" }),
    );
    mockRemove.mockReturnValue(Effect.void);
    mockPruneStale.mockReturnValue(Effect.void);
    mockHasUncommittedChanges.mockReturnValue(Effect.succeed(false));

    await Effect.runPromise(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        yield* factory.withSandbox(() => Effect.void);
      }).pipe(Effect.provide(makeIsolatedLayer(hostDir))),
    );

    expect(mockRemove).toHaveBeenCalledWith(hostDir);
  });

  it("preserves worktree on failure with dirty worktree", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandcastle-test-"));
    tempDirs.push(hostDir);
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial");

    mockCreate.mockReturnValue(
      Effect.succeed({ path: hostDir, branch: "sandcastle/20240101-000000" }),
    );
    mockRemove.mockReturnValue(Effect.void);
    mockPruneStale.mockReturnValue(Effect.void);
    mockHasUncommittedChanges.mockReturnValue(Effect.succeed(true));

    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const factory = yield* SandboxFactory;
          yield* factory.withSandbox(() => Effect.die("boom"));
        }).pipe(Effect.provide(makeIsolatedLayer(hostDir))),
      ),
    ).rejects.toThrow();

    expect(mockRemove).not.toHaveBeenCalled();
  });

  it("prunes stale worktrees before creating a new one", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandcastle-test-"));
    tempDirs.push(hostDir);
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial");

    const callOrder: string[] = [];
    mockPruneStale.mockImplementation(() =>
      Effect.sync(() => {
        callOrder.push("pruneStale");
      }),
    );
    mockCreate.mockImplementation(() =>
      Effect.sync(() => {
        callOrder.push("create");
        return { path: hostDir, branch: "sandcastle/20240101-000000" };
      }),
    );
    mockRemove.mockReturnValue(Effect.void);
    mockHasUncommittedChanges.mockReturnValue(Effect.succeed(false));

    await Effect.runPromise(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        yield* factory.withSandbox(() => Effect.void);
      }).pipe(Effect.provide(makeIsolatedLayer(hostDir))),
    );

    expect(callOrder.indexOf("pruneStale")).toBeLessThan(
      callOrder.indexOf("create"),
    );
  });

  it("provides applyToHost callback that syncs commits to worktree", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandcastle-test-"));
    tempDirs.push(hostDir);
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial");

    // Use hostDir as worktree path — applyToHost runs syncOut targeting the worktree
    mockCreate.mockReturnValue(
      Effect.succeed({ path: hostDir, branch: "sandcastle/20240101-000000" }),
    );
    mockRemove.mockReturnValue(Effect.void);
    mockPruneStale.mockReturnValue(Effect.void);
    mockHasUncommittedChanges.mockReturnValue(Effect.succeed(false));

    // The sandbox makes a commit inside the sandbox. Calling applyToHost should
    // run syncOut which lands the commit on the worktree (hostDir in this test).
    let commitMade = false;
    await Effect.runPromise(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        yield* factory.withSandbox((info) =>
          Effect.gen(function* () {
            const sandbox = yield* Sandbox;
            yield* sandbox.exec(
              'git config user.email "test@test.com" && git config user.name "Test"',
            );
            yield* sandbox.exec(
              'echo "new content" > new-file.txt && git add new-file.txt && git commit -m "sandbox commit"',
            );
            commitMade = true;
            // Caller (lifecycle) is responsible for calling applyToHost
            yield* info.applyToHost();
          }),
        );
      }).pipe(Effect.provide(makeIsolatedLayer(hostDir))),
    );

    expect(commitMade).toBe(true);
    // Verify the commit landed on the worktree (hostDir)
    const { stdout } = await execAsync("git log --oneline -1", {
      cwd: hostDir,
    });
    expect(stdout).toContain("sandbox commit");
  });
});
