# Adding an agent provider

This document is for contributors adding support for a new **agent** (e.g. Claude Code, Codex, gemini-cli) as a built-in **agent provider**. It covers:

1. [Evaluating a new agent](#evaluating-a-new-agent) — the questionnaire used to decide whether an agent's CLI can be supported.
2. [The `AgentProvider` interface](#the-agentprovider-interface) — what you implement.
3. [Scaffold integration](#scaffold-integration) — what `sandcastle init` needs to offer the agent.
4. [Implementation checklist](#implementation-checklist) — every file to touch.

For terminology (**agent**, **agent provider**, **sandbox**, etc.), see [`CONTEXT.md`](../../CONTEXT.md).

## Evaluating a new agent

Before implementing, confirm the agent's CLI satisfies the must-haves below. If a must-have is missing, the agent likely cannot be supported until its CLI changes.

### Must-have CLI capabilities

- **Non-interactive run mode.** A flag (often `--print`, `exec`, `run`) that takes a prompt, runs the agent to completion, and exits. Without this, Sandcastle cannot drive the agent unattended.
- **Prompt input via argv or stdin.** stdin is strongly preferred — Linux caps `argv` at ~128 KB, which large prompts blow past.
- **Auto-approval / bypass-permissions flag.** The agent runs inside a **sandbox**, so any "are you sure?" prompts will hang it. Examples: Claude Code's `--dangerously-skip-permissions`, Codex's `--dangerously-bypass-approvals-and-sandbox`.
- **Model selection.** A flag that picks the model (e.g. `--model`, `-m`).
- **Env-based authentication.** Auth via environment variables (API key) — no interactive login required at first run.
- **Exit codes reflect success/failure.** Non-zero on error so the orchestrator can detect failures.

### Must-have output capabilities

- **Streaming output.** The CLI must stream output to stdout as the agent runs; we surface it live in [`Display`](../../src/Display.ts).
- **Structured (JSON) stream events.** Required — line-delimited JSON (one event per line). This is what `parseStreamLine` in [`AgentProvider.ts`](../../src/AgentProvider.ts) consumes; without it, tool calls and partial text cannot render in the UI.

For a JSON stream, we want to extract:

- **Assistant text** — the agent's natural-language output, ideally as deltas.
- **Tool calls** — name + a single display arg (we currently show `Bash`, `WebSearch`, `WebFetch`, `Agent`; see `TOOL_ARG_FIELDS`).
- **Final result** — the agent's last message, used for orchestration.
- **Errors** — note whether the CLI emits errors on stdout vs. stderr. Codex and Pi emit auth/rate-limit errors as JSON events on stdout; we capture those as `result` events so they surface to the user.
- **Session ID** (optional) — only needed if the agent supports resume.

### Optional capabilities

These unlock extra Sandcastle features but are not required:

- **Resume by session ID.** A `--resume <id>` flag that lets the agent continue a previous session. Today only Claude Code uses this; it powers session continuation in `run()`.
- **Per-iteration token usage.** Tokens reported in the session log (input, output, cache create, cache read). Today only Claude Code; powers the usage display.
- **Interactive mode.** A separate invocation form for human use (`interactive()`). If the agent has a TUI, expose it via `buildInteractiveArgs`.

### Scaffold prerequisites

For `sandcastle init` to offer the agent:

- A reproducible install command (npm package, install script, etc.) that works inside a Debian-based Docker image.
- A documented set of env vars for auth.
- A sensible default model string.

## The `AgentProvider` interface

Defined in [`src/AgentProvider.ts`](../../src/AgentProvider.ts).

```ts
interface AgentProvider {
  name: string;
  env: Record<string, string>;
  captureSessions: boolean;
  buildPrintCommand(options: AgentCommandOptions): PrintCommand;
  buildInteractiveArgs?(options: AgentCommandOptions): string[];
  parseStreamLine(line: string): ParsedStreamEvent[];
  parseSessionUsage?(content: string): IterationUsage | undefined;
}
```

Field by field:

- `name` — short identifier (e.g. `"claude-code"`, `"codex"`). Used in logs and config.
- `env` — environment variables injected into the **sandbox** when this agent runs. Auth keys live here. Merged with the env resolver and **sandbox provider** env at launch.
- `captureSessions` — when `true`, Sandcastle records the agent's session log. Default: `true` for Claude Code, `false` for everything else. Only set `true` if the agent writes a parseable session file we can read back.
- `buildPrintCommand({ prompt, dangerouslySkipPermissions, resumeSession })` — returns the shell command to run the agent non-interactively. Return `{ command, stdin }` when piping the prompt via stdin (preferred for large prompts).
- `buildInteractiveArgs(options)` — optional. Returns the argv array for `interactive()`. Omit if the agent has no TUI.
- `parseStreamLine(line)` — given one line of stdout, return zero or more `ParsedStreamEvent`s. Event types: `text`, `result`, `tool_call`, `session_id`. Return `[]` for lines you can't or don't need to parse.
- `parseSessionUsage(content)` — optional. Given the session log content, return token usage for the most recent iteration. Currently only Claude Code implements this.

### Patterns to follow

- **Shell-escape every interpolated value** in `buildPrintCommand` using the `shellEscape` helper at the top of `AgentProvider.ts`.
- **Prefer stdin for the prompt** to dodge the argv size limit.
- **Be defensive when parsing JSON.** Wrap `JSON.parse` in try/catch and tolerate unknown event types — CLIs add fields over time.
- **Surface errors as `result` events** when the CLI emits them on stdout (see Codex/Pi). The Orchestrator's stderr-empty fallback uses these to show the user something useful.

## Scaffold integration

For the agent to appear in `sandcastle init`, add an entry to `AGENT_REGISTRY` in [`src/InitService.ts`](../../src/InitService.ts):

```ts
{
  name: "gemini",
  label: "Gemini",
  defaultModel: "gemini-2.5-pro",
  factoryImport: "gemini",          // matches the export from index.ts
  dockerfileTemplate: GEMINI_DOCKERFILE,
  envExample: `# Google AI API key
GOOGLE_API_KEY=`,
}
```

And a Dockerfile constant alongside the existing ones. Use `CLAUDE_CODE_DOCKERFILE` as a structural reference — keep the `usermod` block, the `{{BACKLOG_MANAGER_TOOLS}}` placeholder, the `USER agent` line, and the `ENTRYPOINT ["sleep", "infinity"]`. Only the install line should differ.

## Implementation checklist

For a new agent provider `foo`:

- [ ] Factory `foo()` in [`src/AgentProvider.ts`](../../src/AgentProvider.ts), with options interface `FooOptions`.
- [ ] Stream-parsing helper `parseFooStreamLine`.
- [ ] Tests in `src/AgentProvider.test.ts` covering `buildPrintCommand`, `buildInteractiveArgs`, and stream parsing — including error events on stdout if applicable.
- [ ] Public export from [`src/index.ts`](../../src/index.ts): the `foo` factory and the `FooOptions` type.
- [ ] `AGENT_REGISTRY` entry in [`src/InitService.ts`](../../src/InitService.ts).
- [ ] `FOO_DOCKERFILE` constant in `src/InitService.ts`.
- [ ] Changeset in `.changeset/` (patch, since pre-1.0). See [`CLAUDE.md`](../../CLAUDE.md).
- [ ] `README.md` update if the public-facing list of supported agents is mentioned there.
