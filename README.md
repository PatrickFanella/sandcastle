# Sandcastle

A TypeScript CLI for orchestrating AI coding agents in isolated Docker containers. Sandcastle handles the hard parts — syncing your repo into a container, invoking the agent, and extracting commits back — so you can run agents unattended against your project's open GitHub issues.

## Prerequisites

- [Node.js](https://nodejs.org/) v22+
- [Docker](https://www.docker.com/)
- [Git](https://git-scm.com/)
- [GitHub CLI](https://cli.github.com/) (`gh`) — authenticated with repo access

## Installation

```bash
npm install -g sandcastle
```

## Quick start

```bash
# 1. Initialize — scaffolds .sandcastle/ config directory, builds image, starts container
cd /path/to/your/repo
sandcastle init

# 2. Set up authentication tokens in .sandcastle/.env (or repo root .env)
cp .sandcastle/.env.example .sandcastle/.env
# Edit .sandcastle/.env and fill in your tokens

# 3. Run the agent against your repo's open issues (defaults to 5 iterations)
sandcastle run

# 4. Clean up when you're done
sandcastle cleanup-sandbox
```

## Authentication

Tokens are resolved automatically from environment files and process environment variables. No CLI flags needed.

| Variable                  | Purpose                                  |
| ------------------------- | ---------------------------------------- |
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude Code OAuth token                  |
| `ANTHROPIC_API_KEY`       | Anthropic API key (alternative to OAuth) |
| `GH_TOKEN`                | GitHub personal access token             |

You must set either `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` (or both). `GH_TOKEN` is always required.

**Precedence** (highest to lowest):

1. Repo root `.env`
2. `.sandcastle/.env`
3. Process environment variables

## CLI commands

### `sandcastle init`

Scaffolds the `.sandcastle/` config directory, builds the Docker image, and starts a container. This is the first command you run in a new repo.

| Option         | Required | Default            | Description           |
| -------------- | -------- | ------------------ | --------------------- |
| `--container`  | No       | `claude-sandbox`   | Docker container name |
| `--image-name` | No       | `sandcastle:local` | Docker image name     |

Creates the following files:

```
.sandcastle/
├── Dockerfile      # Sandbox environment (customize as needed)
├── prompt.md       # Agent instructions
├── .env.example    # Token placeholders
└── .gitignore      # Ignores .env
```

Errors if `.sandcastle/` already exists to prevent overwriting customizations.

### `sandcastle setup-sandbox`

Rebuilds the Docker image and restarts a container from an existing `.sandcastle/` directory. Use this after modifying the Dockerfile or when you need to recreate the container.

| Option         | Required | Default            | Description           |
| -------------- | -------- | ------------------ | --------------------- |
| `--container`  | No       | `claude-sandbox`   | Docker container name |
| `--image-name` | No       | `sandcastle:local` | Docker image name     |

### `sandcastle run`

Runs the orchestration loop: sync-in, invoke agent, sync-out, repeat.

| Option          | Required | Default                 | Description                                                  |
| --------------- | -------- | ----------------------- | ------------------------------------------------------------ |
| `--iterations`  | No       | `5`                     | Number of agent iterations to run                            |
| `--image-name`  | No       | `sandcastle:local`      | Docker image name                                            |
| `--prompt`      | No       | —                       | Inline prompt string (mutually exclusive with --prompt-file) |
| `--prompt-file` | No       | `.sandcastle/prompt.md` | Path to the agent prompt file                                |
| `--branch`      | No       | —                       | Target branch name for sandbox work                          |
| `--model`       | No       | `claude-opus-4-6`       | Model to use for the agent                                   |

Each iteration:

1. Syncs your host repo into the container (via git bundle)
2. Runs lifecycle hooks (`onSandboxReady`)
3. Preprocesses the prompt (executes any `` !`command` `` expressions inside the sandbox)
4. Invokes the agent (Claude Code) with streaming output
5. If the agent made commits, syncs them back to your host (via format-patch)
6. Stops early if the agent emits `<promise>COMPLETE</promise>`

### `sandcastle interactive`

Opens an interactive Claude Code session inside the sandbox. Syncs your repo in, launches Claude with TTY passthrough, and syncs changes back when you exit.

| Option         | Required | Default            | Description                |
| -------------- | -------- | ------------------ | -------------------------- |
| `--image-name` | No       | `sandcastle:local` | Docker image name          |
| `--model`      | No       | `claude-opus-4-6`  | Model to use for the agent |

### `sandcastle cleanup-sandbox`

Stops and removes the container and image.

| Option         | Required | Default            | Description           |
| -------------- | -------- | ------------------ | --------------------- |
| `--container`  | No       | `claude-sandbox`   | Docker container name |
| `--image-name` | No       | `sandcastle:local` | Docker image name     |

### `sandcastle sync-in`

Transfers your host repo state into the sandbox. Useful for debugging sync issues.

| Option          | Required | Default | Description                                 |
| --------------- | -------- | ------- | ------------------------------------------- |
| `--sandbox-dir` | Yes      | —       | Path to the sandbox directory               |
| `--container`   | No       | —       | Docker container name (omit for filesystem) |

Run from within your repo directory. Without `--container`, uses a local directory as the sandbox (filesystem layer).

### `sandcastle sync-out`

Extracts commits and uncommitted changes from the sandbox back to your host.

| Option          | Required | Default | Description                                    |
| --------------- | -------- | ------- | ---------------------------------------------- |
| `--sandbox-dir` | Yes      | —       | Path to the sandbox directory                  |
| `--base-head`   | Yes      | —       | HEAD SHA from sync-in (determines new commits) |
| `--container`   | No       | —       | Docker container name (omit for filesystem)    |

## Prompts

Sandcastle uses a flexible prompt system. You write the prompt, and the engine executes it — no opinions about workflow, task management, or context sources are imposed.

### Prompt resolution

The prompt is resolved from one of three sources (in order of precedence):

1. `--prompt "inline string"` — pass an inline prompt directly
2. `--prompt-file ./path/to/prompt.md` — point to a specific file
3. `.sandcastle/prompt.md` — default location (created by `sandcastle init`)

`--prompt` and `--prompt-file` are mutually exclusive — providing both is an error.

### Dynamic context with `` !`command` ``

Use `` !`command` `` expressions in your prompt to pull in dynamic context. Each expression is replaced with the command's stdout before the prompt is sent to the agent.

Commands run **inside the sandbox** after sync-in and `onSandboxReady` hooks, so they see the same repo state the agent sees (including installed dependencies).

```markdown
# Open issues

!`gh issue list --state open --json number,title,body,comments,labels --limit 20`

# Recent commits

!`git log --oneline -10`
```

If any command exits with a non-zero code, the run fails immediately with an error — broken context is surfaced early rather than silently producing a bad prompt.

### Early termination with `<promise>COMPLETE</promise>`

When the agent outputs `<promise>COMPLETE</promise>`, the orchestrator stops the iteration loop early. This is a convention you document in your prompt for the agent to follow — the engine never injects it.

This is useful for task-based workflows where the agent should stop once it has finished, rather than running all remaining iterations.

### Example prompt: GitHub Issue Backlog

This is a complete, copy-pasteable prompt for an agent that works through a repo's open GitHub issues:

```markdown
# Issues

!`gh issue list --state open --json number,title,body,comments,labels --limit 20`

# Recent work

!`git log --oneline -10`

# Task

Pick the highest-priority open issue and work on it. Follow this process:

1. Explore the codebase to understand the relevant code
2. Write a failing test for the expected behavior
3. Implement the fix or feature to make the test pass
4. Refactor if needed
5. Commit your changes with a descriptive message

When the task is complete, close the GitHub issue with `gh issue close <number>`
and output <promise>COMPLETE</promise> to signal you are done.

If the task is not complete, leave a comment on the issue describing progress.

Only work on a single issue per run.
```

Save this as `.sandcastle/prompt.md` and run `sandcastle run`.

## Node API

Sandcastle exports a programmatic `run()` function for use in Node.js scripts, CI pipelines, or custom tooling.

```typescript
import { run } from "sandcastle";

const result = await run({
  promptFile: "./my-prompt.md",
  maxIterations: 3,
  branch: "agent/fix-123",
});

console.log(result.iterationsRun); // number of iterations executed
console.log(result.complete); // true if agent emitted <promise>COMPLETE</promise>
```

### `RunOptions`

| Option          | Type   | Default                 | Description                                            |
| --------------- | ------ | ----------------------- | ------------------------------------------------------ |
| `prompt`        | string | —                       | Inline prompt (mutually exclusive with `promptFile`)   |
| `promptFile`    | string | `.sandcastle/prompt.md` | Path to prompt file (mutually exclusive with `prompt`) |
| `maxIterations` | number | `5`                     | Maximum iterations to run                              |
| `hooks`         | object | —                       | Lifecycle hooks (`onSandboxCreate`, `onSandboxReady`)  |
| `branch`        | string | —                       | Target branch for sandbox work                         |
| `model`         | string | `claude-opus-4-6`       | Model to use for the agent                             |

### `RunResult`

| Field           | Type    | Description                             |
| --------------- | ------- | --------------------------------------- |
| `iterationsRun` | number  | Number of iterations that were executed |
| `complete`      | boolean | Whether the agent signaled completion   |

Tokens (`CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY`, `GH_TOKEN`) are resolved automatically from `.env`, `.sandcastle/.env`, and `process.env` — no need to pass them to the API.

## Configuration

### Config directory (`.sandcastle/`)

All per-repo sandbox configuration lives in `.sandcastle/`. Run `sandcastle init` to create it.

### Custom Dockerfile

The `.sandcastle/Dockerfile` controls the sandbox environment. The default template installs:

- **Node.js 22** (base image)
- **git**, **curl**, **jq** (system dependencies)
- **GitHub CLI** (`gh`)
- **Claude Code CLI**
- A non-root `agent` user (required — Claude runs as this user)

When customizing the Dockerfile, ensure you keep:

- A non-root user (the default `agent` user) for Claude to run as
- `git` (required for sync-in/sync-out)
- `gh` (required for issue fetching)
- Claude Code CLI installed and on PATH

Add your project-specific dependencies (e.g., language runtimes, build tools) to the Dockerfile as needed.

### `config.json` (optional)

Place a `.sandcastle/config.json` file to configure advanced behavior:

```json
{
  "hooks": {
    "onSandboxCreate": [
      { "command": "apt-get update && apt-get install -y some-tool" }
    ],
    "onSandboxReady": [{ "command": "npm install" }]
  },
  "defaultMaxIterations": 10,
  "model": "claude-sonnet-4-6"
}
```

| Field                  | Type   | Description                                                                                                                  |
| ---------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `hooks`                | object | Lifecycle hooks that run commands inside the sandbox. See below.                                                             |
| `defaultMaxIterations` | number | Default number of agent iterations for `sandcastle run`. Overridden by the `--iterations` CLI flag. Defaults to 5 if unset.  |
| `model`                | string | Default model for the agent (e.g. `claude-sonnet-4-6`). Overridden by the `--model` CLI flag. Defaults to `claude-opus-4-6`. |

### Hooks

Hooks are arrays of `{ "command": "..." }` objects executed sequentially inside the sandbox. If any command exits with a non-zero code, execution stops immediately with an error.

| Hook              | When it runs                             | Working directory      |
| ----------------- | ---------------------------------------- | ---------------------- |
| `onSandboxCreate` | After container creation, before sync-in | Container default      |
| `onSandboxReady`  | After sync-in completes                  | Sandbox repo directory |

**`onSandboxCreate`** is useful for system-level setup that doesn't depend on repo files (e.g., installing OS packages).

**`onSandboxReady`** runs after the repo is synced in. Use it for dependency installation or build steps (e.g., `npm install`).

This file is not created by `init` — create it manually when needed.

## How it works

Sandcastle uses git primitives for reliable repo synchronization:

- **Sync-in**: Creates a `git bundle` on your host capturing all refs (including unpushed commits), copies it into the sandbox, and unpacks it. The sandbox always matches your host's committed state.
- **Sync-out**: Runs `git format-patch` inside the sandbox to extract new commits, copies the patches to your host, and applies them with `git am --3way`. Uncommitted changes (staged, unstaged, and untracked files) are also captured.

This approach avoids GitHub round-trips and produces clean, replayable commit history.

## Development

```bash
npm install
npm run build    # Build with tsgo
npm test         # Run tests with vitest
npm run check    # Type-check
```

## License

MIT
