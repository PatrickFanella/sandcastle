import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scaffold } from "./InitService.js";
import type { AgentProvider } from "./AgentProvider.js";
import { claudeCodeProvider } from "./AgentProvider.js";
import { SKELETON_PROMPT } from "./templates.js";

const makeDir = () => mkdtemp(join(tmpdir(), "init-service-"));

const fakeProvider: AgentProvider = {
  name: "fake-agent",
  envManifest: {
    FAKE_TOKEN: "Fake agent token",
    FAKE_SECRET: "Fake agent secret",
  },
  envCheck: () => {},
  dockerfileTemplate: "FROM ubuntu:latest\nRUN echo fake\n",
};

describe("InitService scaffold", () => {
  it("uses provider envManifest for .env.example", async () => {
    const dir = await makeDir();
    await scaffold(dir, fakeProvider);

    const envExample = await readFile(
      join(dir, ".sandcastle", ".env.example"),
      "utf-8",
    );
    expect(envExample).toContain("FAKE_TOKEN=");
    expect(envExample).toContain("FAKE_SECRET=");
    // Comments from manifest should be present
    expect(envExample).toContain("# Fake agent token");
    expect(envExample).toContain("# Fake agent secret");
    // Should NOT contain hardcoded claude-code keys
    expect(envExample).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
  });

  it("uses provider dockerfileTemplate for Dockerfile", async () => {
    const dir = await makeDir();
    await scaffold(dir, fakeProvider);

    const dockerfile = await readFile(
      join(dir, ".sandcastle", "Dockerfile"),
      "utf-8",
    );
    expect(dockerfile).toBe(fakeProvider.dockerfileTemplate);
  });

  it("writes agent name to config.json", async () => {
    const dir = await makeDir();
    await scaffold(dir, fakeProvider);

    const configJson = await readFile(
      join(dir, ".sandcastle", "config.json"),
      "utf-8",
    );
    const config = JSON.parse(configJson);
    expect(config).toEqual({ agent: "fake-agent" });
  });

  it("scaffolds claude-code provider correctly", async () => {
    const dir = await makeDir();
    await scaffold(dir, claudeCodeProvider);

    const configDir = join(dir, ".sandcastle");

    const dockerfile = await readFile(join(configDir, "Dockerfile"), "utf-8");
    expect(dockerfile).toBe(claudeCodeProvider.dockerfileTemplate);

    const envExample = await readFile(join(configDir, ".env.example"), "utf-8");
    expect(envExample).toContain("CLAUDE_CODE_OAUTH_TOKEN=");
    expect(envExample).toContain("GH_TOKEN=");

    const configJson = await readFile(join(configDir, "config.json"), "utf-8");
    expect(JSON.parse(configJson)).toEqual({ agent: "claude-code" });
  });

  it("errors if .sandcastle/ already exists", async () => {
    const dir = await makeDir();
    await mkdir(join(dir, ".sandcastle"));

    await expect(scaffold(dir, fakeProvider)).rejects.toThrow(
      ".sandcastle/ directory already exists",
    );
  });

  it("includes patches/ in .gitignore", async () => {
    const dir = await makeDir();
    await scaffold(dir, fakeProvider);

    const gitignore = await readFile(
      join(dir, ".sandcastle", ".gitignore"),
      "utf-8",
    );
    expect(gitignore).toContain("patches/");
    expect(gitignore).toContain("logs/");
  });

  it("skeleton prompt contains section headers and hints", async () => {
    const dir = await makeDir();
    await scaffold(dir, fakeProvider);

    const prompt = await readFile(
      join(dir, ".sandcastle", "prompt.md"),
      "utf-8",
    );
    expect(prompt).toContain("# ");
    expect(prompt).toContain("!`");
    expect(prompt).toContain("<promise>COMPLETE</promise>");
  });
});
