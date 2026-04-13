import { describe, expect, it } from "vitest";
import { podman, defaultImageName } from "./podman.js";

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
