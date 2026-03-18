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

| Variable                   | Purpose                      |
| -------------------------- | ---------------------------- |
| `CLAUDE_CODE_OAUTH_TOKEN`  | Claude Code OAuth token      |
| `ANTHROPIC_API_KEY`        | Anthropic API key (alternative to OAuth) |
| `GH_TOKEN`                 | GitHub personal access token |

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

| Option          | Required | Default                  | Description                       |
| --------------- | -------- | ------------------------ | --------------------------------- |
| `--iterations`  | No       | `5`                      | Number of agent iterations to run |
| `--container`   | No       | `claude-sandbox`         | Docker container name             |
| `--image-name`  | No       | `sandcastle:local`       | Docker image name                 |
| `--prompt-file` | No       | `.sandcastle/prompt.md`  | Path to the agent prompt file     |

The agent runs inside the container, working on open GitHub issues. Each iteration:

1. Syncs your host repo into the container (via git bundle)
2. Fetches open issues and prior agent commits for context
3. Invokes the agent (Claude Code) with streaming output
4. If the agent made commits, syncs them back to your host (via format-patch)
5. Stops early if the agent emits a completion signal

### `sandcastle interactive`

Opens an interactive Claude Code session inside the sandbox. Syncs your repo in, launches Claude with TTY passthrough, and syncs changes back when you exit.

| Option        | Required | Default          | Description           |
| ------------- | -------- | ---------------- | --------------------- |
| `--container` | No       | `claude-sandbox` | Docker container name |

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
  "postSyncIn": "npm install",
  "defaultIterations": 10
}
```

| Field               | Type   | Description                                                                                                                 |
| ------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------- |
| `postSyncIn`        | string | Shell command to run inside the sandbox after each sync-in. Use this for dependency installation or build steps.            |
| `defaultIterations` | number | Default number of agent iterations for `sandcastle run`. Overridden by the `--iterations` CLI flag. Defaults to 5 if unset. |

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
