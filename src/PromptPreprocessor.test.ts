import { Effect, Layer, Ref } from "effect";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type DisplayEntry, SilentDisplay } from "./Display.js";
import { FilesystemSandbox } from "./FilesystemSandbox.js";
import { preprocessPrompt } from "./PromptPreprocessor.js";
import { Sandbox } from "./Sandbox.js";
import { PromptError } from "./errors.js";

describe("PromptPreprocessor", () => {
  const setup = async () => {
    const sandboxDir = await mkdtemp(join(tmpdir(), "preprocess-test-"));
    const displayRef = Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([]);
    const layer = Layer.merge(
      FilesystemSandbox.layer(sandboxDir),
      SilentDisplay.layer(displayRef),
    );
    return { sandboxDir, layer, displayRef };
  };

  const run = (
    prompt: string,
    layer: Awaited<ReturnType<typeof setup>>["layer"],
    cwd: string,
  ) =>
    Effect.runPromise(
      Sandbox.pipe(
        Effect.flatMap((s) => preprocessPrompt(prompt, s, cwd)),
        Effect.provide(layer),
      ),
    );

  it("passes through prompts with no !`command` expressions unchanged", async () => {
    const { sandboxDir, layer } = await setup();
    const prompt = "This is a plain prompt with no commands.\n\nJust text.";
    const result = await run(prompt, layer, sandboxDir);
    expect(result).toBe(prompt);
  });

  it("replaces a single !`command` with its stdout", async () => {
    const { sandboxDir, layer } = await setup();
    const prompt = "Here is the date: !`echo 2026-03-24`";
    const result = await run(prompt, layer, sandboxDir);
    expect(result).toBe("Here is the date: 2026-03-24");
  });

  it("replaces multiple !`command` expressions", async () => {
    const { sandboxDir, layer } = await setup();
    const prompt = "First: !`echo hello`\nSecond: !`echo world`";
    const result = await run(prompt, layer, sandboxDir);
    expect(result).toBe("First: hello\nSecond: world");
  });

  it("fails with PromptError on non-zero exit code", async () => {
    const { sandboxDir, layer } = await setup();
    const prompt = "Output: !`exit 1`";
    const result = await Effect.runPromise(
      Sandbox.pipe(
        Effect.flatMap((s) => preprocessPrompt(prompt, s, sandboxDir)),
        Effect.flip,
        Effect.provide(layer),
      ),
    );
    expect(result).toBeInstanceOf(PromptError);
    expect(result._tag).toBe("PromptError");
    expect(result.message).toContain("exit 1");
    expect(result.message).toContain("exited with code 1");
  });

  it("runs commands with the provided cwd", async () => {
    const { sandboxDir, layer } = await setup();
    const prompt = "Dir: !`pwd`";
    const result = await run(prompt, layer, sandboxDir);
    expect(result).toBe(`Dir: ${sandboxDir}`);
  });

  it("does not show taskLog when prompt has no commands", async () => {
    const { sandboxDir, layer, displayRef } = await setup();
    const prompt = "Just a plain prompt with no commands.";
    await run(prompt, layer, sandboxDir);
    const entries = await Effect.runPromise(Ref.get(displayRef));
    expect(entries.filter((e) => e._tag === "taskLog")).toHaveLength(0);
  });
});
