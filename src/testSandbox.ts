/**
 * Test helper: creates a local (filesystem-based) Sandbox layer for unit tests.
 * This replaces FilesystemSandbox which has been removed.
 */
import { Effect, Layer } from "effect";
import { spawn } from "node:child_process";
import { copyFile, mkdir } from "node:fs/promises";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { CopyError, ExecError } from "./errors.js";
import { type ExecResult, Sandbox } from "./SandboxFactory.js";

/**
 * Creates an isolated git global config env so that test sandbox
 * `git config --global` writes don't corrupt the developer's real ~/.gitconfig.
 */
const createIsolatedGitEnv = (): Record<string, string> => {
  const tmpDir = mkdtempSync(join(tmpdir(), "test-gitconfig-"));
  const globalConfigPath = join(tmpDir, ".gitconfig");
  writeFileSync(globalConfigPath, "");
  return { GIT_CONFIG_GLOBAL: globalConfigPath };
};

export const makeLocalSandboxLayer = (
  sandboxDir: string,
): Layer.Layer<Sandbox> => {
  const gitEnv = createIsolatedGitEnv();
  const env = { ...process.env, ...gitEnv };

  return Layer.succeed(Sandbox, {
    exec: (command, options) => {
      return Effect.async<ExecResult, ExecError>((resume) => {
        const proc = spawn("sh", ["-c", command], {
          cwd: options?.cwd ?? sandboxDir,
          stdio: [
            options?.stdin !== undefined ? "pipe" : "ignore",
            "pipe",
            "pipe",
          ],
          env,
        });

        if (options?.stdin !== undefined) {
          proc.stdin!.write(options.stdin);
          proc.stdin!.end();
        }

        const stdoutChunks: string[] = [];
        const stderrChunks: string[] = [];

        if (options?.onLine) {
          const onLine = options.onLine;
          const rl = createInterface({ input: proc.stdout! });
          rl.on("line", (line) => {
            stdoutChunks.push(line);
            onLine(line);
          });
        } else {
          proc.stdout!.on("data", (chunk: Buffer) => {
            stdoutChunks.push(chunk.toString());
          });
        }

        proc.stderr!.on("data", (chunk: Buffer) => {
          stderrChunks.push(chunk.toString());
        });

        proc.on("error", (error) => {
          resume(
            Effect.fail(
              new ExecError({
                command,
                message: `Failed to exec: ${error.message}`,
              }),
            ),
          );
        });

        proc.on("close", (code) => {
          resume(
            Effect.succeed({
              stdout: stdoutChunks.join(options?.onLine ? "\n" : ""),
              stderr: stderrChunks.join(""),
              exitCode: code ?? 0,
            }),
          );
        });
      });
    },

    copyIn: (hostPath, sandboxPath) =>
      Effect.tryPromise({
        try: async () => {
          await mkdir(dirname(sandboxPath), { recursive: true });
          await copyFile(hostPath, sandboxPath);
        },
        catch: (e) =>
          new CopyError({
            message: `Failed to copy ${hostPath} -> ${sandboxPath}: ${e}`,
          }),
      }),

    copyFileOut: (sandboxPath, hostPath) =>
      Effect.tryPromise({
        try: async () => {
          await mkdir(dirname(hostPath), { recursive: true });
          await copyFile(sandboxPath, hostPath);
        },
        catch: (e) =>
          new CopyError({
            message: `Failed to copy ${sandboxPath} -> ${hostPath}: ${e}`,
          }),
      }),
  });
};
