/**
 * Filesystem-based test isolated sandbox provider.
 *
 * Uses a temp directory on the local filesystem as the "sandbox".
 * Intended for testing the isolated provider abstraction without
 * requiring a real remote environment.
 */

import { execFile, spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import {
  createIsolatedSandboxProvider,
  type ExecResult,
  type IsolatedBranchStrategy,
  type IsolatedSandboxHandle,
  type IsolatedSandboxProvider,
} from "../SandboxProvider.js";

export interface TestIsolatedOptions {
  /** Branch strategy for this provider. Defaults to { type: "merge-to-head" }. */
  readonly branchStrategy?: IsolatedBranchStrategy;
}

/**
 * Create a filesystem-based test isolated sandbox provider.
 *
 * The "sandbox" is a temp directory. `exec` runs shell commands in it,
 * `copyIn`/`copyOut` copy files between host and the temp dir,
 * and `close` removes the temp dir.
 */
export const testIsolated = (
  options?: TestIsolatedOptions,
): IsolatedSandboxProvider =>
  createIsolatedSandboxProvider({
    name: "test-isolated",
    branchStrategy: options?.branchStrategy,
    create: async (): Promise<IsolatedSandboxHandle> => {
      const sandboxRoot = await mkdtemp(join(tmpdir(), "sandcastle-test-"));
      const workspacePath = join(sandboxRoot, "workspace");
      await mkdir(workspacePath, { recursive: true });

      return {
        workspacePath,

        exec: (
          command: string,
          options?: { cwd?: string },
        ): Promise<ExecResult> =>
          new Promise((resolve, reject) => {
            execFile(
              "sh",
              ["-c", command],
              {
                cwd: options?.cwd ?? workspacePath,
                maxBuffer: 10 * 1024 * 1024,
              },
              (error, stdout, stderr) => {
                if (error && error.code === undefined) {
                  reject(new Error(`exec failed: ${error.message}`));
                } else {
                  resolve({
                    stdout: stdout.toString(),
                    stderr: stderr.toString(),
                    exitCode: typeof error?.code === "number" ? error.code : 0,
                  });
                }
              },
            );
          }),

        execStreaming: (
          command: string,
          onLine: (line: string) => void,
          options?: { cwd?: string },
        ): Promise<ExecResult> =>
          new Promise((resolve, reject) => {
            const proc = spawn("sh", ["-c", command], {
              cwd: options?.cwd ?? workspacePath,
              stdio: ["ignore", "pipe", "pipe"],
            });

            const stdoutChunks: string[] = [];
            const stderrChunks: string[] = [];

            const rl = createInterface({ input: proc.stdout! });
            rl.on("line", (line) => {
              stdoutChunks.push(line);
              onLine(line);
            });

            proc.stderr!.on("data", (chunk: Buffer) => {
              stderrChunks.push(chunk.toString());
            });

            proc.on("error", (error) => {
              reject(new Error(`exec streaming failed: ${error.message}`));
            });

            proc.on("close", (code) => {
              resolve({
                stdout: stdoutChunks.join("\n"),
                stderr: stderrChunks.join(""),
                exitCode: code ?? 0,
              });
            });
          }),

        copyIn: async (
          hostPath: string,
          sandboxPath: string,
        ): Promise<void> => {
          await mkdir(dirname(sandboxPath), { recursive: true });
          await copyFile(hostPath, sandboxPath);
        },

        copyOut: async (
          sandboxPath: string,
          hostPath: string,
        ): Promise<void> => {
          await mkdir(dirname(hostPath), { recursive: true });
          await copyFile(sandboxPath, hostPath);
        },

        close: async (): Promise<void> => {
          await rm(sandboxRoot, { recursive: true, force: true });
        },
      };
    },
  });
