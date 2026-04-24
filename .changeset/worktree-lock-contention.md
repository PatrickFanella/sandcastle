---
"@ai-hero/sandcastle": patch
---

Enhance WorktreeLock.acquire() with PID-based contention detection and stale lock recovery. Add WorktreeLockError type for diagnostic lock contention errors. Move lock acquisition before worktree creation for named branches to serialize concurrent access.
