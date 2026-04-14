---
"@ai-hero/sandcastle": patch
---

Fix Podman readonly bind mounts so SELinux-labeled volumes use `:ro,z` syntax that `podman run -v` accepts.
