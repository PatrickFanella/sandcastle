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

import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { podman, defaultImageName } from "./podman.js";

const mockExecFile = vi.mocked(execFile);

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

  it("formats readonly SELinux mounts using podman volume syntax", async () => {
    mockExecFile.mockImplementation((_command, args, callback: any) => {
      callback(null, "", "");
      return undefined as any;
    });

    const provider = podman({
      selinuxLabel: "z",
      mounts: [{ hostPath: "~", sandboxPath: "/mnt/home", readonly: true }],
    });

    const handle = await provider.create({
      worktreePath: "/tmp/worktree",
      hostRepoPath: "/tmp/repo",
      mounts: [
        { hostPath: "/tmp/worktree", sandboxPath: "/home/agent/workspace" },
      ],
      env: {},
    });

    const runArgs = mockExecFile.mock.calls.find(
      ([, args]) => Array.isArray(args) && args[0] === "run",
    )?.[1];

    expect(runArgs).toContain("-v");
    expect(runArgs).toContain(`${homedir()}:/mnt/home:ro,z`);

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
