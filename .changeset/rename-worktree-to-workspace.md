---
"@ai-hero/sandcastle": patch
---

Rename WorktreeManager to WorkspaceManager and rename public API properties to use "workspace" terminology instead of "worktree". Breaking changes: `Sandbox.worktreePath` -> `workspacePath`, `CloseResult.preservedWorktreePath` -> `preservedWorkspacePath`, `RunResult.preservedWorktreePath` -> `preservedWorkspacePath`, `InteractiveResult.preservedWorktreePath` -> `preservedWorkspacePath`, `SandboxInfo.hostWorktreePath` -> `hostWorkspacePath`, `BindMountCreateOptions.worktreePath` -> `workspacePath`, `AgentError.preservedWorktreePath` -> `preservedWorkspacePath`, `TimeoutError.preservedWorktreePath` -> `preservedWorkspacePath`. Removed deprecated `WorktreeSandboxConfig` alias.
