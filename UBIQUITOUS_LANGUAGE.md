# Ubiquitous Language

## Core concepts

| Term           | Definition                                                                                            | Aliases to avoid                                                                        |
| -------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **Sandcastle** | The TypeScript CLI tool that orchestrates AI coding agents inside isolated environments               | "the tool", "the CLI", "RALPH"                                                          |
| **Sandbox**    | An isolated environment where an agent executes code — either a Docker container or a local directory | "container" (too specific), "Docker sandbox" (ambiguous with Claude's built-in feature) |
| **Host**       | The developer's machine where Sandcastle runs and the real git repo lives                             | "local" (ambiguous — the sandbox also has a local filesystem)                           |
| **Agent**      | The AI coding tool invoked inside the sandbox (e.g. Claude Code, Codex)                               | "RALPH", "the bot", "Claude" (too specific — agent is swappable)                        |

## Environment

| Term             | Definition                                                                                                                           | Aliases to avoid                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| **Env resolver** | The module that loads environment variables from `.env` files and `process.env`, returning a generic key-value map                   | "token resolver" (too specific to auth tokens) |
| **Env manifest** | The agent provider's declaration of which environment variables it requires or supports, used to scaffold `.env.example`             | "env example", "env template", "env schema"    |
| **Env check**    | The agent provider's validation function that inspects the resolved env map and fails with a clear error if requirements are not met | "token validation", "env validation"           |

## Sync operations

| Term       | Definition                                                                                            | Aliases to avoid      |
| ---------- | ----------------------------------------------------------------------------------------------------- | --------------------- |
| **Bundle** | A git bundle file used to transfer repository state from host to sandbox without a network round-trip | "archive", "snapshot" |
| **Patch**  | A `git format-patch` output file representing a commit made inside the sandbox                        | "diff", "changeset"   |

## Execution

| Term                  | Definition                                                                                                                     | Aliases to avoid                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| **Iteration**         | A single invocation of the agent inside the sandbox, producing at most one commit against one task                             | "run" (ambiguous with the CLI command), "cycle", "loop"                                  |
| **Task**              | A GitHub issue that the agent selects and works on during an iteration                                                         | "job", "work item", "ticket"                                                             |
| **Completion signal** | The `<promise>COMPLETE</promise>` marker in the agent's output indicating all actionable tasks are finished                    | "done flag", "exit signal"                                                               |
| **Orchestrator**      | The module that drives the iteration loop: sync-in, invoke agent, check for commits, sync-out, check completion signal, repeat | "runner", "loop", "wrapper script"                                                       |
| **Prompt**            | The instruction text passed to the agent at the start of each iteration — may contain **shell expressions**                    | "system prompt" (too specific), "instructions" (too vague), "message"                    |
| **Prompt expansion**  | The preprocessing step that finds and evaluates all **shell expressions** in a **prompt** before passing it to the agent       | "prompt preprocessing" (too generic), "command expansion"                                |
| **Shell expression**  | A `` !`command` `` marker in a **prompt** that evaluates a shell command inside the sandbox and is replaced with its stdout    | "command" (overloaded — collides with hook commands), "inline command", "prompt command" |

## Project structure

| Term                 | Definition                                                                                                                 | Aliases to avoid                       |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| **Config directory** | The `.sandcastle/` directory in a host repo containing sandbox configuration: Dockerfile, prompt, config, and env settings | ".sandcastle folder", "sandcastle dir" |
| **Init**             | The CLI command that scaffolds the **config directory** in a host repo and builds the Docker image                         | "create", "bootstrap", "new"           |
| **Build-image**      | The CLI command that rebuilds the Docker image from an existing **config directory**                                       | "setup-sandbox" (old name)             |
| **Remove-image**     | The CLI command that removes the Docker image                                                                              | "cleanup-sandbox" (old name)           |

## Architecture

| Term                 | Definition                                                                                                          | Aliases to avoid                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| **Sandbox service**  | The Effect service interface exposing `exec`, `copyIn`, and `copyOut` operations against a sandbox                  | "adapter", "transport"               |
| **Docker layer**     | The `Sandbox` service implementation that uses `docker exec` and `docker cp`                                        | "Docker adapter", "Docker transport" |
| **Filesystem layer** | The `Sandbox` service implementation that uses local shell and `cp` against a separate directory — used for testing | "local adapter", "test adapter"      |
| **Sync service**     | The module built on top of `Sandbox` that implements sync-in and sync-out using git bundles and format-patch        | "sync layer", "git sync"             |

## Relationships

- **Sandcastle** orchestrates an **agent** inside a **sandbox**
- A **sandbox** is provided by either the **Docker layer** or the **filesystem layer**, both implementing the **Sandbox service** interface
- The **sync service** depends on the **Sandbox service** to transfer files and execute git commands
- **Sync-in** creates a **bundle** on the **host** and unpacks it in the **sandbox**
- **Sync-out** generates **patches** in the **sandbox** and applies them on the **host**
- Each **iteration** may produce one **patch**; iterations repeat until the **completion signal** fires or the max count is reached
- **Init** creates the **config directory** on the **host** and builds the Docker image
- **Build-image** requires the **config directory** to already exist on the **host**
- The **env resolver** loads env vars from: repo root `.env` > **config directory** `.env` > `process.env` — only keys declared in a `.env` file are resolved from `process.env`
- Each **agent provider** declares an **env manifest** and an **env check**
- The **agent provider** is selected via the `agent` field in config or `--agent` CLI flag
- At launch, Sandcastle resolves env vars via the **env resolver**, runs the active **agent provider**'s **env check**, then passes the full env map into the **sandbox**
- **Init** uses the **agent provider**'s **env manifest** to scaffold `.env.example` and its Dockerfile template to scaffold the Dockerfile
- **Prompt expansion** runs before each **iteration**, evaluating all **shell expressions** inside the **sandbox**
- A prompt may contain zero or more **shell expressions**; if none are found, **prompt expansion** is skipped entirely

## Example dialogue

> **Dev:** "How do I test the **sync service** without Docker?"

> **Domain expert:** "Provide the **filesystem layer** instead of the **Docker layer**. It implements the same **Sandbox service** interface but uses a local directory as the **sandbox**."

> **Dev:** "So **sync-in** still creates a **bundle** and unpacks it?"

> **Domain expert:** "Exactly. The **sync service** doesn't know which layer it's talking to. It calls `exec` and `copyIn` — the **filesystem layer** just runs those as local shell commands."

> **Dev:** "And when the **agent** makes a commit in the **sandbox**, **sync-out** extracts the **patch** the same way regardless?"

> **Domain expert:** "Right. The **sync service** calls `exec` to run `git format-patch` and `copyOut` to get the **patch** file back to the **host**."

> **Dev:** "What if I want to add support for OpenCode instead of Claude Code?"

> **Domain expert:** "Create a new **agent provider**. It declares its own **env manifest** — maybe it needs `OPEN_CODE_TOKEN` instead of `CLAUDE_CODE_OAUTH_TOKEN`. Its **env check** validates those requirements. And it provides its own Dockerfile template that installs the right binary."

> **Dev:** "How does Sandcastle know which **agent provider** to use?"

> **Domain expert:** "The `agent` field in `config.json`, or the `--agent` CLI flag. The **env resolver** loads all env vars generically — it doesn't know or care which **agent** is running. The **agent provider**'s **env check** is what enforces the tool-specific requirements."

> **Dev:** "I see `` !`gh issue list` `` in the **prompt** file — what happens with that?"

> **Domain expert:** "That's a **shell expression**. Before each **iteration**, **prompt expansion** finds all **shell expressions** in the **prompt**, executes them inside the **sandbox**, and replaces them with stdout. If there are no **shell expressions**, the step is skipped entirely."

> **Dev:** "So the **agent** never sees the `` !`...` `` syntax?"

> **Domain expert:** "Correct. By the time the **prompt** reaches the **agent**, every **shell expression** has been replaced with its output."

## Flagged ambiguities

- **"Docker sandbox"** — In this project, **sandbox** refers to our isolated environment concept. It is NOT Claude Code's built-in `docker sandbox` CLI feature. Use **sandbox** for ours; spell out "Claude's Docker sandbox CLI" for the built-in feature.
- **"Container"** vs **"Sandbox"** — "Container" is the Docker primitive; **sandbox** is our abstraction over it. Use **sandbox** when talking about the concept, "container" only when discussing Docker implementation details.
- **"Local"** vs **"Host"** — Both could mean the developer's machine, but "local" is ambiguous (the filesystem layer's sandbox is also local). Use **host** to mean the developer's machine. Reserve "local" for generic contexts.
- **"Run"** — Ambiguous between the CLI command (`sandcastle run`) and a single **iteration**. Use **iteration** for one agent invocation; use "run command" or "run session" for the CLI command that drives multiple iterations.
- **"Adapter"** vs **"Layer"** — We use **layer** (Effect terminology) for implementations of the **Sandbox service**. Avoid "adapter" and "transport" as they suggest different patterns. The new **agent provider** concept is NOT an adapter — it provides configuration and validation, not an alternative implementation of a service interface.
- **"Token"** vs **"Env var"** — The old `TokenResolver` name implied it only handled auth tokens. The **env resolver** handles all environment variables generically. Use "env var" for the general concept; "token" only when referring specifically to an auth credential value.
- **"Command"** — Heavily overloaded: hook commands, shell commands, CLI commands, **shell expressions**. Use **shell expression** for the `` !`...` `` syntax in **prompts**; use "hook" for lifecycle hooks; use "CLI command" for `sandcastle run`, `sandcastle init`, etc.
