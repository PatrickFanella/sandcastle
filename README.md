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
# 1. Build the Docker image and start a container
sandcastle setup \
  --oauth-token "$CLAUDE_CODE_OAUTH_TOKEN" \
  --gh-token "$GH_TOKEN"

# 2. Run the agent for 5 iterations against your repo's open issues
cd /path/to/your/repo
sandcastle run --iterations 5

# 3. Clean up when you're done
sandcastle cleanup
```

## CLI commands

### `sandcastle setup`

Builds the Docker image and starts a container ready for agent execution.

| Option          | Required | Default            | Description                  |
| --------------- | -------- | ------------------ | ---------------------------- |
| `--oauth-token` | Yes      | —                  | Claude Code OAuth token      |
| `--gh-token`    | Yes      | —                  | GitHub personal access token |
| `--container`   | No       | `claude-sandbox`   | Docker container name        |
| `--image-name`  | No       | `sandcastle:local` | Docker image name            |

### `sandcastle run`

Runs the orchestration loop: sync-in, invoke agent, sync-out, repeat.

| Option          | Required | Default                                 | Description                       |
| --------------- | -------- | --------------------------------------- | --------------------------------- |
| `--iterations`  | Yes      | —                                       | Number of agent iterations to run |
| `--container`   | No       | `claude-sandbox`                        | Docker container name             |
| `--image-name`  | No       | `sandcastle:local`                      | Docker image name                 |
| `--prompt-file` | No       | `docker-container-experiment/prompt.md` | Path to the agent prompt file     |

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

### `sandcastle cleanup`

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

Place a `.sandcastle.json` file in your repo root to configure Sandcastle behavior:

```json
{
  "postSyncIn": "npm install"
}
```

| Field        | Type   | Description                                                                                                      |
| ------------ | ------ | ---------------------------------------------------------------------------------------------------------------- |
| `postSyncIn` | string | Shell command to run inside the sandbox after each sync-in. Use this for dependency installation or build steps. |

The config file is optional. If absent, no post-sync commands are run.

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
