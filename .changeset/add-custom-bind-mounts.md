---
"@ai-hero/sandcastle": patch
---

Add optional `mounts` config to `docker()` and `podman()` providers for mounting host directories (e.g. package manager caches) into sandbox containers. Each mount supports `hostPath` (with `~` expansion), `sandboxPath`, and optional `readonly` flag. Throws a clear error if a host path does not exist.
