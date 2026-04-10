---
"@ai-hero/sandcastle": patch
---

Add `branchStrategy` support to isolated sandbox providers. `IsolatedSandboxProvider` now exposes `branchStrategy` on the instance, defaulting to `{ type: "merge-to-head" }`. `testIsolated()` accepts a `branchStrategy` option. TypeScript prevents `{ type: "head" }` on isolated providers at compile time.
