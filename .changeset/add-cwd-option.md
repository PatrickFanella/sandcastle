---
"@ai-hero/sandcastle": patch
---

Add a `cwd` option to `createSandbox()`, `createWorktree()`, `run()`, and `interactive()`. When provided, `cwd` replaces `process.cwd()` as the host repo directory used for worktrees, `.sandcastle/.env`, logs, patches, and git operations, letting you drive Sandcastle from outside the target repo. Relative paths resolve against `process.cwd()`; absolute paths pass through. A `CwdError` is raised when the path does not exist or is not a directory.
