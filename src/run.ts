import { Effect, Layer } from "effect";
import { getAgentProvider } from "./AgentProvider.js";
import { readConfig } from "./Config.js";
import { ClackDisplay } from "./Display.js";
import { orchestrate } from "./Orchestrator.js";
import { resolvePrompt } from "./PromptResolver.js";
import { DockerSandboxFactory } from "./SandboxFactory.js";
import { resolveEnv } from "./EnvResolver.js";

export interface RunOptions {
  /** Inline prompt string (mutually exclusive with promptFile) */
  readonly prompt?: string;
  /** Path to a prompt file (mutually exclusive with prompt) */
  readonly promptFile?: string;
  /** Maximum iterations to run (default: 5) */
  readonly maxIterations?: number;
  /** Hooks to run during sandbox lifecycle */
  readonly hooks?: {
    readonly onSandboxCreate?: ReadonlyArray<{ command: string }>;
    readonly onSandboxReady?: ReadonlyArray<{ command: string }>;
  };
  /** Target branch name for sandbox work */
  readonly branch?: string;
  /** Model to use for the agent (default: claude-opus-4-6) */
  readonly model?: string;
  /** Agent provider name (default: claude-code) */
  readonly agent?: string;
  /** @internal */
  readonly _imageName?: string;
}

export interface RunResult {
  readonly iterationsRun: number;
  readonly complete: boolean;
}

const SANDBOX_REPOS_DIR = "/home/agent/repos";

export const run = async (options: RunOptions): Promise<RunResult> => {
  const {
    prompt,
    promptFile,
    maxIterations = 5,
    hooks,
    branch,
    model,
    agent,
    _imageName = "sandcastle:local",
  } = options;

  const hostRepoDir = process.cwd();
  const repoName = hostRepoDir.split("/").pop()!;
  const sandboxRepoDir = `${SANDBOX_REPOS_DIR}/${repoName}`;

  // Resolve prompt
  const resolvedPrompt = await Effect.runPromise(
    resolvePrompt({ prompt, promptFile, cwd: hostRepoDir }),
  );

  // Read config
  const config = await Effect.runPromise(readConfig(hostRepoDir));

  // Merge hooks: explicit hooks override config hooks
  const resolvedConfig = hooks ? { ...config, hooks } : config;

  // Resolve model: explicit option > config > default
  const resolvedModel = model ?? config.model;

  // Resolve agent provider: explicit option > config > default
  const agentName = agent ?? config.agent ?? "claude-code";
  const provider = getAgentProvider(agentName);

  // Resolve env vars and run agent provider's env check
  const env = await resolveEnv(hostRepoDir);
  provider.envCheck(env);

  const factoryLayer = DockerSandboxFactory.layer(_imageName, env);
  const runLayer = Layer.merge(factoryLayer, ClackDisplay.layer);

  const result = await Effect.runPromise(
    orchestrate({
      hostRepoDir,
      sandboxRepoDir,
      iterations: maxIterations,
      config: resolvedConfig,
      prompt: resolvedPrompt,
      branch,
      model: resolvedModel,
    }).pipe(Effect.provide(runLayer)),
  );

  return { iterationsRun: result.iterationsRun, complete: result.complete };
};
