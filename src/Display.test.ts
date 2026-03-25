import { readFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect, Layer, Ref } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Display,
  type DisplayEntry,
  FileDisplay,
  SilentDisplay,
  terminalStyle,
} from "./Display.js";

describe("SilentDisplay", () => {
  const setup = () => {
    const ref = Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([]);
    const layer = SilentDisplay.layer(ref);
    return { ref, layer };
  };

  const readEntries = (ref: Ref.Ref<ReadonlyArray<DisplayEntry>>) =>
    Ref.get(ref);

  describe("status", () => {
    it("captures status messages with severity", async () => {
      const { ref, layer } = setup();

      const entries = await Effect.runPromise(
        Effect.gen(function* () {
          const d = yield* Display;
          yield* d.status("Syncing files...", "info");
          return yield* readEntries(ref);
        }).pipe(Effect.provide(layer)),
      );

      expect(entries).toEqual([
        { _tag: "status", message: "Syncing files...", severity: "info" },
      ]);
    });

    it("captures multiple status messages in order", async () => {
      const { ref, layer } = setup();

      const entries = await Effect.runPromise(
        Effect.gen(function* () {
          const d = yield* Display;
          yield* d.status("Starting...", "info");
          yield* d.status("Done!", "success");
          yield* d.status("Something failed", "error");
          return yield* readEntries(ref);
        }).pipe(Effect.provide(layer)),
      );

      expect(entries).toEqual([
        { _tag: "status", message: "Starting...", severity: "info" },
        { _tag: "status", message: "Done!", severity: "success" },
        { _tag: "status", message: "Something failed", severity: "error" },
      ]);
    });

    it("captures all severity levels", async () => {
      const { ref, layer } = setup();

      const entries = await Effect.runPromise(
        Effect.gen(function* () {
          const d = yield* Display;
          yield* d.status("info msg", "info");
          yield* d.status("success msg", "success");
          yield* d.status("warn msg", "warn");
          yield* d.status("error msg", "error");
          return yield* readEntries(ref);
        }).pipe(Effect.provide(layer)),
      );

      expect(entries).toHaveLength(4);
      expect(entries.map((e) => (e as { severity: string }).severity)).toEqual([
        "info",
        "success",
        "warn",
        "error",
      ]);
    });
  });

  describe("spinner", () => {
    it("passes through the wrapped effect result", async () => {
      const { layer } = setup();

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const d = yield* Display;
          return yield* d.spinner("Loading...", Effect.succeed("hello"));
        }).pipe(Effect.provide(layer)),
      );

      expect(result).toBe("hello");
    });

    it("captures spinner entry with message", async () => {
      const { ref, layer } = setup();

      const entries = await Effect.runPromise(
        Effect.gen(function* () {
          const d = yield* Display;
          yield* d.spinner("Building image...", Effect.succeed(42));
          return yield* readEntries(ref);
        }).pipe(Effect.provide(layer)),
      );

      expect(entries).toEqual([
        { _tag: "spinner", message: "Building image..." },
      ]);
    });

    it("passes through the wrapped effect failure", async () => {
      const { layer } = setup();

      const result = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const d = yield* Display;
          return yield* d.spinner("Failing...", Effect.fail("boom"));
        }).pipe(Effect.provide(layer)),
      );

      expect(result._tag).toBe("Failure");
    });
  });

  describe("summary", () => {
    it("captures summary with title and rows", async () => {
      const { ref, layer } = setup();

      const entries = await Effect.runPromise(
        Effect.gen(function* () {
          const d = yield* Display;
          yield* d.summary("Token Usage", {
            "Input tokens": "1,234",
            "Output tokens": "567",
          });
          return yield* readEntries(ref);
        }).pipe(Effect.provide(layer)),
      );

      expect(entries).toEqual([
        {
          _tag: "summary",
          title: "Token Usage",
          rows: {
            "Input tokens": "1,234",
            "Output tokens": "567",
          },
        },
      ]);
    });
  });

  describe("mixed calls", () => {
    it("captures all entry types in order", async () => {
      const { ref, layer } = setup();

      const entries = await Effect.runPromise(
        Effect.gen(function* () {
          const d = yield* Display;
          yield* d.status("Starting run", "info");
          yield* d.spinner("Running agent...", Effect.succeed("done"));
          yield* d.summary("Results", { Iterations: "3" });
          yield* d.status("Run complete", "success");
          return yield* readEntries(ref);
        }).pipe(Effect.provide(layer)),
      );

      expect(entries).toHaveLength(4);
      expect(entries.map((e) => e._tag)).toEqual([
        "status",
        "spinner",
        "summary",
        "status",
      ]);
    });
  });
});

describe("FileDisplay", () => {
  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), "sandcastle-display-"));
    const logPath = join(dir, "test.log");
    const layer = Layer.provide(
      FileDisplay.layer(logPath),
      NodeFileSystem.layer,
    );
    return { logPath, layer };
  };

  const readLog = (logPath: string) => readFileSync(logPath, "utf-8");

  it("intro is a no-op", async () => {
    const { logPath, layer } = setup();

    await Effect.runPromise(
      Effect.gen(function* () {
        const d = yield* Display;
        yield* d.intro("sandcastle");
      }).pipe(Effect.provide(layer)),
    );

    const log = readLog(logPath);
    expect(log).toBe("");
  });

  it("writes status messages to file", async () => {
    const { logPath, layer } = setup();

    await Effect.runPromise(
      Effect.gen(function* () {
        const d = yield* Display;
        yield* d.status("Syncing files...", "info");
        yield* d.status("Done!", "success");
      }).pipe(Effect.provide(layer)),
    );

    const log = readLog(logPath);
    expect(log).toContain("Syncing files...");
    expect(log).toContain("Done!");
    expect(log).not.toContain("[INFO]");
    expect(log).not.toContain("[SUCCESS]");
  });

  it("writes spinner messages to file and passes through result", async () => {
    const { logPath, layer } = setup();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const d = yield* Display;
        return yield* d.spinner("Loading...", Effect.succeed("hello"));
      }).pipe(Effect.provide(layer)),
    );

    expect(result).toBe("hello");
    const log = readLog(logPath);
    expect(log).toContain("Loading...");
    expect(log).toContain("Loading... done");
  });

  it("writes summary to file", async () => {
    const { logPath, layer } = setup();

    await Effect.runPromise(
      Effect.gen(function* () {
        const d = yield* Display;
        yield* d.summary("Token Usage", {
          "Input tokens": "1,234",
          "Output tokens": "567",
        });
      }).pipe(Effect.provide(layer)),
    );

    const log = readLog(logPath);
    expect(log).toContain("Token Usage");
    expect(log).toContain("Input tokens: 1,234");
    expect(log).toContain("Output tokens: 567");
  });

  it("writes taskLog messages to file", async () => {
    const { logPath, layer } = setup();

    await Effect.runPromise(
      Effect.gen(function* () {
        const d = yield* Display;
        yield* d.taskLog("Sync in", (msg) =>
          Effect.sync(() => {
            msg("Cloning repo...");
            msg("Running hooks...");
          }),
        );
      }).pipe(Effect.provide(layer)),
    );

    const log = readLog(logPath);
    expect(log).toContain("Sync in\n");
    expect(log).toContain("Cloning repo...");
    expect(log).toContain("Running hooks...");
    expect(log).toContain("Sync in done");
  });

  it("writes text messages to file", async () => {
    const { logPath, layer } = setup();

    await Effect.runPromise(
      Effect.gen(function* () {
        const d = yield* Display;
        yield* d.text("Some agent output here");
      }).pipe(Effect.provide(layer)),
    );

    const log = readLog(logPath);
    expect(log).toContain("Some agent output here");
  });

  it("creates an empty log file on initialization", async () => {
    const { logPath, layer } = setup();

    await Effect.runPromise(
      Effect.gen(function* () {
        const d = yield* Display;
        yield* d.intro("sandcastle");
      }).pipe(Effect.provide(layer)),
    );

    const log = readLog(logPath);
    expect(log).toBe("");
  });

  it("writes status messages without ANSI escape codes", async () => {
    const { logPath, layer } = setup();

    await Effect.runPromise(
      Effect.gen(function* () {
        const d = yield* Display;
        yield* d.status("Agent started", "success");
        yield* d.status("Iteration 1/3", "info");
      }).pipe(Effect.provide(layer)),
    );

    const log = readLog(logPath);
    expect(log).not.toContain("\u001b[");
  });

  it("writes summary without ANSI escape codes", async () => {
    const { logPath, layer } = setup();

    await Effect.runPromise(
      Effect.gen(function* () {
        const d = yield* Display;
        yield* d.summary("Token Usage", {
          Tokens: "1,234 in / 567 out",
          Turns: "3",
        });
      }).pipe(Effect.provide(layer)),
    );

    const log = readLog(logPath);
    expect(log).not.toContain("\u001b[");
  });
});

describe("terminalStyle", () => {
  beforeEach(() => {
    process.env.FORCE_COLOR = "1";
  });
  afterEach(() => {
    delete process.env.FORCE_COLOR;
  });

  it("wraps status messages with bold ANSI codes", () => {
    const styled = terminalStyle.status("Agent started");
    expect(styled).toBe("\u001b[1mAgent started\u001b[22m");
  });

  it("wraps summary title with bold ANSI codes", () => {
    const styled = terminalStyle.summaryTitle("Token Usage");
    expect(styled).toBe("\u001b[1mToken Usage\u001b[22m");
  });

  it("formats summary row with bold key and dim value", () => {
    const styled = terminalStyle.summaryRow("Tokens", "1,234 in / 567 out");
    expect(styled).toContain("\u001b[1mTokens\u001b[22m");
    expect(styled).toContain("\u001b[2m1,234 in / 567 out\u001b[22m");
    expect(styled).toContain(": ");
  });
});
