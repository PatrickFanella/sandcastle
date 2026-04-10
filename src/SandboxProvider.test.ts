import { describe, expect, it, vi } from "vitest";
import {
  createBindMountSandboxProvider,
  createIsolatedSandboxProvider,
  type BindMountSandboxHandle,
  type IsolatedSandboxHandle,
  type SandboxProvider,
} from "./SandboxProvider.js";

describe("createBindMountSandboxProvider", () => {
  const makeMockHandle = (): BindMountSandboxHandle => ({
    workspacePath: "/workspace",
    exec: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
    execStreaming: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
    close: vi.fn(async () => {}),
  });

  it("returns a SandboxProvider with tag 'bind-mount'", () => {
    const provider = createBindMountSandboxProvider({
      name: "test-provider",
      create: async () => makeMockHandle(),
    });

    expect(provider.tag).toBe("bind-mount");
    expect(provider.name).toBe("test-provider");
  });

  it("delegates create() to the config's create function", async () => {
    const handle = makeMockHandle();
    const createFn = vi.fn(async () => handle);
    const provider = createBindMountSandboxProvider({
      name: "test-provider",
      create: createFn,
    });

    const options = {
      worktreePath: "/tmp/worktree",
      hostRepoPath: "/home/user/repo",
      mounts: [{ hostPath: "/a", sandboxPath: "/b" }],
      env: { FOO: "bar" },
    };

    const result = await provider.create(options);

    expect(createFn).toHaveBeenCalledWith(options);
    expect(result).toBe(handle);
  });

  it("satisfies the SandboxProvider type", () => {
    const provider: SandboxProvider = createBindMountSandboxProvider({
      name: "typed",
      create: async () => makeMockHandle(),
    });

    expect(provider.tag).toBe("bind-mount");
  });

  it("defaults branchStrategy to head when omitted", () => {
    const provider = createBindMountSandboxProvider({
      name: "test-provider",
      create: async () => makeMockHandle(),
    });

    expect(provider.branchStrategy).toEqual({ type: "head" });
  });

  it("stores explicit branchStrategy on the instance", () => {
    const provider = createBindMountSandboxProvider({
      name: "test-provider",
      branchStrategy: { type: "merge-to-head" },
      create: async () => makeMockHandle(),
    });

    expect(provider.branchStrategy).toEqual({ type: "merge-to-head" });
  });

  it("stores branch strategy with named branch", () => {
    const provider = createBindMountSandboxProvider({
      name: "test-provider",
      branchStrategy: { type: "branch", branch: "feature/foo" },
      create: async () => makeMockHandle(),
    });

    expect(provider.branchStrategy).toEqual({
      type: "branch",
      branch: "feature/foo",
    });
  });
});

describe("createIsolatedSandboxProvider", () => {
  const makeMockHandle = (): IsolatedSandboxHandle => ({
    workspacePath: "/workspace",
    exec: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
    execStreaming: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
    copyIn: vi.fn(async () => {}),
    copyOut: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  });

  it("returns a SandboxProvider with tag 'isolated'", () => {
    const provider = createIsolatedSandboxProvider({
      name: "test-isolated",
      create: async () => makeMockHandle(),
    });

    expect(provider.tag).toBe("isolated");
    expect(provider.name).toBe("test-isolated");
  });

  it("delegates create() to the config's create function", async () => {
    const handle = makeMockHandle();
    const createFn = vi.fn(async () => handle);
    const provider = createIsolatedSandboxProvider({
      name: "test-isolated",
      create: createFn,
    });

    const options = { env: { FOO: "bar" } };
    const result = await provider.create(options);

    expect(createFn).toHaveBeenCalledWith(options);
    expect(result).toBe(handle);
  });

  it("satisfies the SandboxProvider type", () => {
    const provider: SandboxProvider = createIsolatedSandboxProvider({
      name: "typed",
      create: async () => makeMockHandle(),
    });

    expect(provider.tag).toBe("isolated");
  });

  it("defaults branchStrategy to merge-to-head when omitted", () => {
    const provider = createIsolatedSandboxProvider({
      name: "test-isolated",
      create: async () => makeMockHandle(),
    });

    expect(provider.branchStrategy).toEqual({ type: "merge-to-head" });
  });

  it("stores explicit branchStrategy on the instance", () => {
    const provider = createIsolatedSandboxProvider({
      name: "test-isolated",
      branchStrategy: { type: "branch", branch: "feature/foo" },
      create: async () => makeMockHandle(),
    });

    expect(provider.branchStrategy).toEqual({
      type: "branch",
      branch: "feature/foo",
    });
  });

  it("stores merge-to-head branchStrategy on the instance", () => {
    const provider = createIsolatedSandboxProvider({
      name: "test-isolated",
      branchStrategy: { type: "merge-to-head" },
      create: async () => makeMockHandle(),
    });

    expect(provider.branchStrategy).toEqual({ type: "merge-to-head" });
  });
});
