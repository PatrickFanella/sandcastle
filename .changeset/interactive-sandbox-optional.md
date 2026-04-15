---
"@ai-hero/sandcastle": patch
---

Make `sandbox` optional in `InteractiveOptions`, defaulting to `noSandbox()`. Make `prompt`/`promptFile` optional in `interactive()` — when neither is provided, the agent TUI launches with no initial prompt (the full prompt pipeline is skipped).
