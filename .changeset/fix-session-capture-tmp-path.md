---
"@ai-hero/sandcastle": patch
---

Fix session capture, which always failed with "Could not find the file". Sandcastle was looking for session JSONLs under a `sessions/` subdirectory that Claude Code does not actually use.
