/**
 * Podman sandbox provider — creates Podman containers with bind-mounts.
 *
 * Usage:
 *   import { podman } from "sandcastle/sandboxes/podman";
 *   await run({ agent: claudeCode("claude-opus-4-6"), sandbox: podman() });
 */

import { execFile, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import {
  createBindMountSandboxProvider,
  type SandboxProvider,
  type BindMountCreateOptions,
  type BindMountSandboxHandle,
  type ExecResult,
} from "../SandboxProvider.js";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import type { MountConfig } from "../MountConfig.js";

export interface PodmanOptions {
  /** Podman image name (default: derived from repo directory name). */
  readonly imageName?: string;
  /**
   * SELinux volume label suffix applied to bind mounts.
   *
   * - `"z"` — shared label (default). No-op on non-SELinux systems.
   * - `"Z"` — private label; only this container can access the mount.
   * - `false` — disable labeling entirely.
   */
  readonly selinuxLabel?: "z" | "Z" | false;
  /**
   * Additional host directories to bind-mount into the sandbox.
   *
   * Each entry specifies a `hostPath` (tilde-expanded) and `sandboxPath`.
   * If `hostPath` does not exist, sandbox creation fails with a clear error.
   */
  readonly mounts?: readonly MountConfig[];
  /** Environment variables injected by this provider. Merged at launch time with env resolver and agent provider env. */
  readonly env?: Record<string, string>;
}

/**
 * Create a Podman sandbox provider.
 *
 * The returned provider creates Podman containers with bind-mounts
 * for the worktree and git directories. Calls the `podman` binary
 * on PATH directly — no Podman Machine detection or special
 * macOS/Windows handling.
 */
export const podman = (options?: PodmanOptions): SandboxProvider => {
  const configuredImageName = options?.imageName;
  const selinuxLabel = options?.selinuxLabel ?? "z";
  const userMounts = options?.mounts ? resolveUserMounts(options.mounts) : [];

  return createBindMountSandboxProvider({
    name: "podman",
    env: options?.env,
    create: async (
      createOptions: BindMountCreateOptions,
    ): Promise<BindMountSandboxHandle> => {
      const containerName = `sandcastle-${randomUUID()}`;

      const workspacePath =
        createOptions.mounts.find(
          (m) => m.hostPath === createOptions.worktreePath,
        )?.sandboxPath ?? "/home/agent/workspace";

      // Build volume mount strings with optional SELinux label (internal + user mounts)
      const allMounts = [...createOptions.mounts, ...userMounts];
      const volumeMounts = allMounts.map((m) =>
        formatVolumeMount(m, selinuxLabel),
      );

      // Resolve image name
      const imageName =
        configuredImageName ?? defaultImageName(createOptions.hostRepoPath);

      const hostUid = process.getuid?.() ?? 1000;
      const hostGid = process.getgid?.() ?? 1000;

      const env = { ...createOptions.env, HOME: "/home/agent" };
      const envArgs = Object.entries(env).flatMap(([key, value]) => [
        "-e",
        `${key}=${value}`,
      ]);
      const volumeArgs = volumeMounts.flatMap((v) => ["-v", v]);

      // Start container via podman run
      await new Promise<void>((resolve, reject) => {
        execFile(
          "podman",
          [
            "run",
            "-d",
            "--name",
            containerName,
            "--user",
            `${hostUid}:${hostGid}`,
            "-w",
            workspacePath,
            ...envArgs,
            ...volumeArgs,
            imageName,
            "sleep",
            "infinity",
          ],
          (error) => {
            if (error) {
              reject(new Error(`podman run failed: ${error.message}`));
            } else {
              resolve();
            }
          },
        );
      });

      // Set up signal handlers for cleanup
      const onExit = () => {
        try {
          execFileSync("podman", ["rm", "-f", containerName], {
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

        exec: (
          command: string,
          opts?: {
            onLine?: (line: string) => void;
            cwd?: string;
            sudo?: boolean;
          },
        ): Promise<ExecResult> => {
          const effectiveCommand = opts?.sudo ? `sudo ${command}` : command;
          const args = ["exec"];
          if (opts?.cwd) args.push("-w", opts.cwd);
          args.push(containerName, "sh", "-c", effectiveCommand);

          if (opts?.onLine) {
            const onLine = opts.onLine;
            return new Promise((resolve, reject) => {
              const proc = spawn("podman", args, {
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
                reject(new Error(`podman exec failed: ${error.message}`));
              });

              proc.on("close", (code) => {
                resolve({
                  stdout: stdoutChunks.join("\n"),
                  stderr: stderrChunks.join(""),
                  exitCode: code ?? 0,
                });
              });
            });
          }

          return new Promise((resolve, reject) => {
            execFile(
              "podman",
              args,
              { maxBuffer: 10 * 1024 * 1024 },
              (error, stdout, stderr) => {
                if (error && error.code === undefined) {
                  reject(new Error(`podman exec failed: ${error.message}`));
                } else {
                  resolve({
                    stdout: stdout.toString(),
                    stderr: stderr.toString(),
                    exitCode: typeof error?.code === "number" ? error.code : 0,
                  });
                }
              },
            );
          });
        },

        close: async (): Promise<void> => {
          process.removeListener("exit", onExit);
          process.removeListener("SIGINT", onSignal);
          process.removeListener("SIGTERM", onSignal);
          await new Promise<void>((resolve, reject) => {
            execFile("podman", ["rm", "-f", containerName], (error) => {
              if (error) {
                reject(new Error(`podman rm failed: ${error.message}`));
              } else {
                resolve();
              }
            });
          });
        },
      };

      return handle;
    },
  });
};

/**
 * Derive the default Podman image name from the repo directory.
 * Returns `sandcastle:<dir-name>` where dir-name is the last path segment,
 * lowercased and sanitized for image tag rules.
 */
export const defaultImageName = (repoDir: string): string => {
  const dirName = repoDir.replace(/\/+$/, "").split("/").pop() || "local";
  const sanitized = dirName.toLowerCase().replace(/[^a-z0-9_.-]/g, "-");
  return `sandcastle:${sanitized}`;
};

const expandTilde = (p: string): string => {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return homedir() + p.slice(1);
  return p;
};

const resolveUserMounts = (
  mounts: readonly MountConfig[],
): Array<{ hostPath: string; sandboxPath: string; readonly?: boolean }> =>
  mounts.map((m) => {
    const resolvedHostPath = expandTilde(m.hostPath);

    if (!existsSync(resolvedHostPath)) {
      throw new Error(
        `Mount hostPath does not exist: ${m.hostPath}` +
          (m.hostPath !== resolvedHostPath
            ? ` (resolved to ${resolvedHostPath})`
            : ""),
      );
    }

    return {
      hostPath: resolvedHostPath,
      sandboxPath: m.sandboxPath,
      ...(m.readonly ? { readonly: true } : {}),
    };
  });

const formatVolumeMount = (
  mount: { hostPath: string; sandboxPath: string; readonly?: boolean },
  selinuxLabel: PodmanOptions["selinuxLabel"],
): string => {
  const base = `${mount.hostPath}:${mount.sandboxPath}`;
  const options = [mount.readonly ? "ro" : undefined, selinuxLabel || undefined]
    .filter((option): option is string => option !== undefined)
    .join(",");

  return options ? `${base}:${options}` : base;
};
