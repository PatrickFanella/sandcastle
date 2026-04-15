import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async () => {
  const actual =
    await vi.importActual<typeof import("node:child_process")>(
      "node:child_process",
    );

  return {
    ...actual,
    execFile: vi.fn(),
    execFileSync: vi.fn(),
    spawn: vi.fn(),
  };
});

import { execFile, execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { podman, defaultImageName } from "./podman.js";

const mockExecFile = vi.mocked(execFile);
const mockExecFileSync = vi.mocked(execFileSync);

afterEach(() => {
  mockExecFile.mockReset();
});

describe("podman()", () => {
  it("returns a SandboxProvider with tag 'bind-mount' and name 'podman'", () => {
    const provider = podman();
    expect(provider.tag).toBe("bind-mount");
    expect(provider.name).toBe("podman");
  });

  it("accepts an imageName option", () => {
    const provider = podman({ imageName: "my-image:latest" });
    expect(provider.tag).toBe("bind-mount");
    expect(provider.name).toBe("podman");
  });

  it("has a create function", () => {
    const provider = podman();
    expect(typeof provider.create).toBe("function");
  });

  it("accepts selinuxLabel option", () => {
    // Just verify construction succeeds with each option
    const withZ = podman({ selinuxLabel: "z" });
    const withBigZ = podman({ selinuxLabel: "Z" });
    const withFalse = podman({ selinuxLabel: false });
    expect(withZ.tag).toBe("bind-mount");
    expect(withBigZ.tag).toBe("bind-mount");
    expect(withFalse.tag).toBe("bind-mount");
  });

  it("accepts a mounts option with valid paths", () => {
    const provider = podman({
      mounts: [{ hostPath: "~", sandboxPath: "/mnt/home" }],
    });
    expect(provider.tag).toBe("bind-mount");
  });

  it("throws at construction time if a mount hostPath does not exist", () => {
    expect(() =>
      podman({
        mounts: [
          {
            hostPath: "/nonexistent/path/does/not/exist",
            sandboxPath: "/mnt/cache",
          },
        ],
      }),
    ).toThrow("Mount hostPath does not exist");
  });

  it("accepts an env option", () => {
    const provider = podman({ env: { MY_VAR: "hello" } });
    expect(provider.tag).toBe("bind-mount");
    expect(provider.env).toEqual({ MY_VAR: "hello" });
  });

  it("defaults env to empty object when not provided", () => {
    const provider = podman();
    expect(provider.env).toEqual({});
  });

  it("formats readonly SELinux mounts as :ro,z", async () => {
    mockExecFile.mockImplementation((_command, args, callback: any) => {
      callback(null, "", "");
      return undefined as any;
    });

    const provider = podman({
      selinuxLabel: "z",
      mounts: [{ hostPath: "~", sandboxPath: "/mnt/home", readonly: true }],
    });

    const handle = await provider.create({
      workspacePath: "/tmp/worktree",
      hostRepoPath: "/tmp/repo",
      mounts: [
        { hostPath: "/tmp/worktree", sandboxPath: "/home/agent/workspace" },
      ],
      env: {},
    });

    const runArgs = mockExecFile.mock.calls.find(
      ([, args]) => Array.isArray(args) && args[0] === "run",
    )?.[1];

    expect(runArgs).toContain(`${homedir()}:/mnt/home:ro,z`);

    await handle.close();
  });

  it("formats writable SELinux mounts as :z", async () => {
    mockExecFile.mockImplementation((_command, _args, callback: any) => {
      callback(null, "", "");
      return undefined as any;
    });

    const provider = podman({
      selinuxLabel: "z",
      mounts: [{ hostPath: "~", sandboxPath: "/mnt/home" }],
    });

    const handle = await provider.create({
      workspacePath: "/tmp/worktree",
      hostRepoPath: "/tmp/repo",
      mounts: [
        { hostPath: "/tmp/worktree", sandboxPath: "/home/agent/workspace" },
      ],
      env: {},
    });

    const runArgs = mockExecFile.mock.calls.find(
      ([, args]) => Array.isArray(args) && args[0] === "run",
    )?.[1];

    expect(runArgs).toContain(`${homedir()}:/mnt/home:z`);

    await handle.close();
  });

  it("formats readonly mounts without SELinux as :ro", async () => {
    mockExecFile.mockImplementation((_command, _args, callback: any) => {
      callback(null, "", "");
      return undefined as any;
    });

    const provider = podman({
      selinuxLabel: false,
      mounts: [{ hostPath: "~", sandboxPath: "/mnt/home", readonly: true }],
    });

    const handle = await provider.create({
      workspacePath: "/tmp/worktree",
      hostRepoPath: "/tmp/repo",
      mounts: [
        { hostPath: "/tmp/worktree", sandboxPath: "/home/agent/workspace" },
      ],
      env: {},
    });

    const runArgs = mockExecFile.mock.calls.find(
      ([, args]) => Array.isArray(args) && args[0] === "run",
    )?.[1];

    expect(runArgs).toContain(`${homedir()}:/mnt/home:ro`);

    await handle.close();
  });

  it("formats mounts with no options when writable and no SELinux", async () => {
    mockExecFile.mockImplementation((_command, _args, callback: any) => {
      callback(null, "", "");
      return undefined as any;
    });

    const provider = podman({
      selinuxLabel: false,
      mounts: [{ hostPath: "~", sandboxPath: "/mnt/home" }],
    });

    const handle = await provider.create({
      workspacePath: "/tmp/worktree",
      hostRepoPath: "/tmp/repo",
      mounts: [
        { hostPath: "/tmp/worktree", sandboxPath: "/home/agent/workspace" },
      ],
      env: {},
    });

    const runArgs = mockExecFile.mock.calls.find(
      ([, args]) => Array.isArray(args) && args[0] === "run",
    )?.[1];

    expect(runArgs).toContain(`${homedir()}:/mnt/home`);
    // Should NOT have any trailing options
    expect(runArgs).not.toContain(`${homedir()}:/mnt/home:`);

    await handle.close();
  });

  it("passes --userns=keep-id by default", async () => {
    mockExecFile.mockImplementation((_command, _args, callback: any) => {
      callback(null, "", "");
      return undefined as any;
    });

    const provider = podman();
    const handle = await provider.create({
      workspacePath: "/tmp/worktree",
      hostRepoPath: "/tmp/repo",
      mounts: [
        { hostPath: "/tmp/worktree", sandboxPath: "/home/agent/workspace" },
      ],
      env: {},
    });

    const runArgs = mockExecFile.mock.calls.find(
      ([, args]) => Array.isArray(args) && args[0] === "run",
    )?.[1] as string[];

    expect(runArgs).toContain("--userns=keep-id");

    await handle.close();
  });

  it("allows disabling userns via option", async () => {
    mockExecFile.mockImplementation((_command, _args, callback: any) => {
      callback(null, "", "");
      return undefined as any;
    });

    const provider = podman({ userns: false });
    const handle = await provider.create({
      workspacePath: "/tmp/worktree",
      hostRepoPath: "/tmp/repo",
      mounts: [
        { hostPath: "/tmp/worktree", sandboxPath: "/home/agent/workspace" },
      ],
      env: {},
    });

    const runArgs = mockExecFile.mock.calls.find(
      ([, args]) => Array.isArray(args) && args[0] === "run",
    )?.[1] as string[];

    expect(runArgs).not.toContain("--userns=keep-id");

    await handle.close();
  });

  it("throws a clear error when image is not found locally", async () => {
    // First call is podman image inspect — fail it
    mockExecFile.mockImplementationOnce((_command, _args, callback: any) => {
      callback(new Error("no such image"), "", "");
      return undefined as any;
    });

    const provider = podman({ imageName: "my-app:latest" });

    await expect(
      provider.create({
        workspacePath: "/tmp/worktree",
        hostRepoPath: "/tmp/repo",
        mounts: [
          { hostPath: "/tmp/worktree", sandboxPath: "/home/agent/workspace" },
        ],
        env: {},
      }),
    ).rejects.toThrow(
      "Image 'my-app:latest' not found locally. Build it first with 'podman build -t my-app:latest .'",
    );
  });

  it("checks for Podman Machine on macOS", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });

    try {
      // podman machine list returns no running machines
      mockExecFile.mockImplementationOnce((_command, _args, callback: any) => {
        callback(null, "[]", "");
        return undefined as any;
      });

      const provider = podman();

      await expect(
        provider.create({
          workspacePath: "/tmp/worktree",
          hostRepoPath: "/tmp/repo",
          mounts: [
            { hostPath: "/tmp/worktree", sandboxPath: "/home/agent/workspace" },
          ],
          env: {},
        }),
      ).rejects.toThrow("Podman Machine is not running");
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it("includes timeout on signal handler cleanup", async () => {
    // Allow image inspect + podman run to succeed
    mockExecFile.mockImplementation((_command, _args, callback: any) => {
      callback(null, "", "");
      return undefined as any;
    });

    const provider = podman();
    const handle = await provider.create({
      workspacePath: "/tmp/worktree",
      hostRepoPath: "/tmp/repo",
      mounts: [
        { hostPath: "/tmp/worktree", sandboxPath: "/home/agent/workspace" },
      ],
      env: {},
    });

    // Trigger a registered exit handler
    const exitListeners = process.listeners("exit");
    const sandcastleListener = exitListeners[exitListeners.length - 1];
    sandcastleListener!(0);

    // Check that execFileSync was called with timeout option
    const rmCall = mockExecFileSync.mock.calls.find(
      ([cmd, args]) =>
        cmd === "podman" && Array.isArray(args) && args[0] === "rm",
    );
    expect(rmCall).toBeDefined();
    expect(rmCall![2]).toMatchObject({ timeout: 5000 });

    await handle.close();
  });
});

describe("defaultImageName()", () => {
  it("derives image name from repo directory", () => {
    expect(defaultImageName("/home/user/my-repo")).toBe("sandcastle:my-repo");
  });

  it("lowercases and sanitizes the directory name", () => {
    expect(defaultImageName("/home/user/My Repo!")).toBe("sandcastle:my-repo-");
  });

  it("handles trailing slashes", () => {
    expect(defaultImageName("/home/user/repo/")).toBe("sandcastle:repo");
  });

  it("falls back to 'local' for empty path", () => {
    expect(defaultImageName("")).toBe("sandcastle:local");
  });
});
