---
"@ai-hero/sandcastle": patch
---

Reset idle timer on any stdout line from the sandbox, not just parsed structured events. This prevents false idle timeouts for providers that emit non-JSON output (e.g. TUI-based agents).
