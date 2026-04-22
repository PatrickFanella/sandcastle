---
"@ai-hero/sandcastle": patch
---

Thread AbortSignal to lifecycle hooks so aborting a run also cancels in-flight hook commands (host.onWorktreeReady, host.onSandboxReady, sandbox.onSandboxReady).
