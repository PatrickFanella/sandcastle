/**
 * User-facing mount configuration for bind-mount sandbox providers.
 *
 * Each entry describes a host directory to mount into the sandbox container.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";

/** A single bind-mount descriptor for docker()/podman() providers. */
export interface MountConfig {
  /** Absolute path on the host. Tilde (`~`) is expanded to the user's home directory. */
  readonly hostPath: string;
  /** Absolute path inside the sandbox container. Tilde is NOT expanded. */
  readonly sandboxPath: string;
  /** Mount as read-only. Defaults to `false`. */
  readonly readonly?: boolean;
}

/**
 * Resolve an array of user-provided MountConfig entries into internal mount format.
 *
 * - Expands leading `~` in `hostPath` to `os.homedir()`
 * - Does NOT expand `~` in `sandboxPath`
 * - Throws if the resolved `hostPath` does not exist on the host
 */
export const resolveUserMounts = (
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

/**
 * Expand a leading `~` or `~/` to the current user's home directory.
 * Does not touch paths without a leading tilde.
 */
export const expandTilde = (p: string): string => {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return homedir() + p.slice(1);
  return p;
};
