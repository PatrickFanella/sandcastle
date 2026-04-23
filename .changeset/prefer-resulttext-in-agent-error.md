---
"@ai-hero/sandcastle": patch
---

When an agent exits with a non-zero exit code, prefer stderr in the error message but fall back to resultText when stderr is empty. Always include the exit code.
