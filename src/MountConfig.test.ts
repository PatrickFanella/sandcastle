import { describe, expect, it } from "vitest";
import {
  expandTilde,
  resolveUserMounts,
  type MountConfig,
} from "./MountConfig.js";
import { homedir } from "node:os";

describe("expandTilde()", () => {
  it("expands ~ alone to home directory", () => {
    expect(expandTilde("~")).toBe(homedir());
  });

  it("expands ~/ prefix to home directory", () => {
    expect(expandTilde("~/.npm")).toBe(`${homedir()}/.npm`);
  });

  it("does not expand tilde in the middle of a path", () => {
    expect(expandTilde("/home/~user")).toBe("/home/~user");
  });

  it("returns absolute paths unchanged", () => {
    expect(expandTilde("/tmp/cache")).toBe("/tmp/cache");
  });
});

describe("resolveUserMounts()", () => {
  it("resolves valid mounts with tilde expansion", () => {
    // Use a path we know exists — the home directory itself
    const mounts: MountConfig[] = [
      { hostPath: "~", sandboxPath: "/home/agent" },
    ];
    const resolved = resolveUserMounts(mounts);
    expect(resolved).toEqual([
      { hostPath: homedir(), sandboxPath: "/home/agent" },
    ]);
  });

  it("does not expand tilde in sandboxPath", () => {
    const mounts: MountConfig[] = [
      { hostPath: "~", sandboxPath: "~/inside-container" },
    ];
    const resolved = resolveUserMounts(mounts);
    expect(resolved[0]!.sandboxPath).toBe("~/inside-container");
  });

  it("preserves readonly flag", () => {
    const mounts: MountConfig[] = [
      { hostPath: "~", sandboxPath: "/mnt/home", readonly: true },
    ];
    const resolved = resolveUserMounts(mounts);
    expect(resolved[0]!.readonly).toBe(true);
  });

  it("omits readonly when false/undefined", () => {
    const mounts: MountConfig[] = [{ hostPath: "~", sandboxPath: "/mnt/home" }];
    const resolved = resolveUserMounts(mounts);
    expect(resolved[0]).not.toHaveProperty("readonly");
  });

  it("throws if hostPath does not exist", () => {
    const mounts: MountConfig[] = [
      {
        hostPath: "/nonexistent/path/that/does/not/exist",
        sandboxPath: "/mnt/cache",
      },
    ];
    expect(() => resolveUserMounts(mounts)).toThrow(
      "Mount hostPath does not exist: /nonexistent/path/that/does/not/exist",
    );
  });

  it("throws with resolved path in error when tilde is expanded", () => {
    const mounts: MountConfig[] = [
      {
        hostPath: "~/.nonexistent-sandcastle-test-dir",
        sandboxPath: "/mnt/cache",
      },
    ];
    expect(() => resolveUserMounts(mounts)).toThrow(/resolved to/);
  });

  it("resolves multiple mounts", () => {
    const mounts: MountConfig[] = [
      { hostPath: "~", sandboxPath: "/mnt/a" },
      { hostPath: "~", sandboxPath: "/mnt/b", readonly: true },
    ];
    const resolved = resolveUserMounts(mounts);
    expect(resolved).toHaveLength(2);
    expect(resolved[0]!.sandboxPath).toBe("/mnt/a");
    expect(resolved[1]!.sandboxPath).toBe("/mnt/b");
    expect(resolved[1]!.readonly).toBe(true);
  });

  it("returns empty array for empty input", () => {
    expect(resolveUserMounts([])).toEqual([]);
  });
});
