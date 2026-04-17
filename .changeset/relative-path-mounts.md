---
"@ai-hero/sandcastle": patch
---

Support relative paths in MountConfig for bind-mount sandbox providers. `hostPath` relative paths resolve from `process.cwd()`, and `sandboxPath` relative paths resolve from the sandbox repo directory.
