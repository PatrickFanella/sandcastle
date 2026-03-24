import { Effect } from "effect";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolvePrompt } from "./PromptResolver.js";
import { SandboxError } from "./Sandbox.js";

describe("PromptResolver", () => {
  it("returns inline prompt when prompt is provided", async () => {
    const result = await Effect.runPromise(
      resolvePrompt({ prompt: "do some work" }),
    );
    expect(result).toBe("do some work");
  });

  it("reads prompt from promptFile when provided", async () => {
    const dir = await mkdtemp(join(tmpdir(), "prompt-resolver-"));
    const promptPath = join(dir, "custom-prompt.md");
    await writeFile(promptPath, "prompt from file");

    const result = await Effect.runPromise(
      resolvePrompt({ promptFile: promptPath }),
    );
    expect(result).toBe("prompt from file");
  });

  it("errors when both prompt and promptFile are provided", async () => {
    const error = await Effect.runPromise(
      resolvePrompt({ prompt: "inline", promptFile: "/some/file.md" }).pipe(
        Effect.flip,
      ),
    );
    expect(error).toBeInstanceOf(SandboxError);
    expect(error.message).toContain("both");
  });

  it("defaults to .sandcastle/prompt.md when neither is provided", async () => {
    const dir = await mkdtemp(join(tmpdir(), "prompt-resolver-"));
    await writeFile(
      join(dir, ".sandcastle", "prompt.md"),
      "default prompt",
    ).catch(() => null);
    // Create the directory structure
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(dir, ".sandcastle"), { recursive: true });
    await writeFile(join(dir, ".sandcastle", "prompt.md"), "default prompt");

    const result = await Effect.runPromise(resolvePrompt({ cwd: dir }));
    expect(result).toBe("default prompt");
  });

  it("errors when default prompt file does not exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "prompt-resolver-"));

    const error = await Effect.runPromise(
      resolvePrompt({ cwd: dir }).pipe(Effect.flip),
    );
    expect(error).toBeInstanceOf(SandboxError);
    expect(error.message).toContain("prompt");
  });
});
