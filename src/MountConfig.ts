/**
 * User-facing mount configuration for bind-mount sandbox providers.
 *
 * Each entry describes a host directory to mount into the sandbox container.
 */

/** A single bind-mount descriptor for docker()/podman() providers. */
export interface MountConfig {
  /** Absolute path on the host. Tilde (`~`) is expanded to the user's home directory. */
  readonly hostPath: string;
  /** Absolute path inside the sandbox container. Tilde is NOT expanded. */
  readonly sandboxPath: string;
  /** Mount as read-only. Defaults to `false`. */
  readonly readonly?: boolean;
}
