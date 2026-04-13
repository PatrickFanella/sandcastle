/**
 * Docker sandbox provider — wraps DockerLifecycle into a SandboxProvider.
 *
 * Usage:
 *   import { docker } from "sandcastle/sandboxes/docker";
 *   await run({ agent: claudeCode("claude-opus-4-6"), sandbox: docker() });
 */

import { execFile, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { Effect } from "effect";
import {
  startContainer,
  removeContainer,
  chownInContainer,
} from "../DockerLifecycle.js";
import {
  createBindMountSandboxProvider,
  type SandboxProvider,
  type BindMountCreateOptions,
  type BindMountSandboxHandle,
  type ExecResult,
} from "../SandboxProvider.js";
import { resolveUserMounts, type MountConfig } from "../MountConfig.js";

export interface DockerOptions {
  /** Docker image name (default: derived from repo directory name). */
  readonly imageName?: string;
  /**
   * Additional host directories to bind-mount into the sandbox.
   *
   * Each entry specifies a `hostPath` (tilde-expanded) and `sandboxPath`.
   * If `hostPath` does not exist, sandbox creation fails with a clear error.
   */
  readonly mounts?: readonly MountConfig[];
}

/**
 * Create a Docker sandbox provider.
 *
 * The returned provider creates Docker containers with bind-mounts
 * for the worktree and git directories.
 */
export const docker = (options?: DockerOptions): SandboxProvider => {
  const configuredImageName = options?.imageName;
  const userMounts = options?.mounts ? resolveUserMounts(options.mounts) : [];

  return createBindMountSandboxProvider({
    name: "docker",
    create: async (
      createOptions: BindMountCreateOptions,
    ): Promise<BindMountSandboxHandle> => {
      const containerName = `sandcastle-${randomUUID()}`;

      const workspacePath =
        createOptions.mounts.find(
          (m) => m.hostPath === createOptions.worktreePath,
        )?.sandboxPath ?? "/home/agent/workspace";

      // Build volume mount strings (internal mounts + user-provided mounts)
      const allMounts = [...createOptions.mounts, ...userMounts];
      const volumeMounts = allMounts.map((m) => {
        const base = `${m.hostPath}:${m.sandboxPath}`;
        return m.readonly ? `${base}:ro` : base;
      });

      // Resolve image name
      const imageName =
        configuredImageName ?? defaultImageName(createOptions.hostRepoPath);

      const hostUid = process.getuid?.() ?? 1000;
      const hostGid = process.getgid?.() ?? 1000;

      // Start container
      await Effect.runPromise(
        startContainer(
          containerName,
          imageName,
          {
            ...createOptions.env,
            HOME: "/home/agent",
          },
          {
            volumeMounts,
            workdir: workspacePath,
            user: `${hostUid}:${hostGid}`,
          },
        ).pipe(
          Effect.andThen(
            chownInContainer(
              containerName,
              `${hostUid}:${hostGid}`,
              "/home/agent",
            ),
          ),
        ),
      );

      // Set up signal handlers for cleanup
      const onExit = () => {
        try {
          execFileSync("docker", ["rm", "-f", containerName], {
            stdio: "ignore",
          });
        } catch {
          /* best-effort */
        }
      };
      const onSignal = () => {
        onExit();
        process.exit(1);
      };
      process.on("exit", onExit);
      process.on("SIGINT", onSignal);
      process.on("SIGTERM", onSignal);

      const handle: BindMountSandboxHandle = {
        workspacePath,

        exec: (command: string, opts?: { cwd?: string }): Promise<ExecResult> =>
          new Promise((resolve, reject) => {
            const args = ["exec"];
            if (opts?.cwd) args.push("-w", opts.cwd);
            args.push(containerName, "sh", "-c", command);

            execFile(
              "docker",
              args,
              { maxBuffer: 10 * 1024 * 1024 },
              (error, stdout, stderr) => {
                if (error && error.code === undefined) {
                  reject(new Error(`docker exec failed: ${error.message}`));
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
          opts?: { cwd?: string },
        ): Promise<ExecResult> =>
          new Promise((resolve, reject) => {
            const args = ["exec"];
            if (opts?.cwd) args.push("-w", opts.cwd);
            args.push(containerName, "sh", "-c", command);

            const proc = spawn("docker", args, {
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
              reject(
                new Error(`docker exec streaming failed: ${error.message}`),
              );
            });

            proc.on("close", (code) => {
              resolve({
                stdout: stdoutChunks.join("\n"),
                stderr: stderrChunks.join(""),
                exitCode: code ?? 0,
              });
            });
          }),

        close: async (): Promise<void> => {
          process.removeListener("exit", onExit);
          process.removeListener("SIGINT", onSignal);
          process.removeListener("SIGTERM", onSignal);
          await Effect.runPromise(removeContainer(containerName));
        },
      };

      return handle;
    },
  });
};

/**
 * Derive the default Docker image name from the repo directory.
 * Returns `sandcastle:<dir-name>` where dir-name is the last path segment,
 * lowercased and sanitized for Docker image tag rules.
 */
export const defaultImageName = (repoDir: string): string => {
  const dirName = repoDir.replace(/\/+$/, "").split("/").pop() ?? "local";
  const sanitized = dirName.toLowerCase().replace(/[^a-z0-9_.-]/g, "-");
  return `sandcastle:${sanitized}`;
};
