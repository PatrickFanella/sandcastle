---
"@ai-hero/sandcastle": patch
---

Fix `PromptError: Prompt argument "{{TASK_ID}}" has no matching value in promptArgs` thrown on every iteration of the `simple-loop`, `sequential-reviewer`, and `parallel-planner*` merge flows after `sandcastle init`. The `VIEW_TASK_COMMAND` and `CLOSE_TASK_COMMAND` registry values used to embed `{{TASK_ID}}`, which got baked into prompts whose runtime promptArgs do not include `TASK_ID`. They now use a plain `<ID>` placeholder for the agent to fill in from surrounding context.
