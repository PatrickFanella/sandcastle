import { Command, Options } from "@effect/cli";
import { Console, Effect } from "effect";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readConfig } from "./Config.js";
import { DockerSandbox } from "./DockerSandbox.js";
import { FilesystemSandbox } from "./FilesystemSandbox.js";
import {
  buildImage,
  cleanupContainer,
  startContainer,
} from "./DockerLifecycle.js";
import { scaffold } from "./InitService.js";
import { orchestrate } from "./Orchestrator.js";
import { resolvePrompt } from "./PromptResolver.js";
import { SandboxError } from "./Sandbox.js";
import { DockerSandboxFactory, SandboxFactory } from "./SandboxFactory.js";
import { withSandboxLifecycle } from "./SandboxLifecycle.js";
import { syncIn, syncOut } from "./SyncService.js";
import { resolveTokens } from "./TokenResolver.js";

// --- Shared options ---

const sandboxDirOption = Options.directory("sandbox-dir").pipe(
  Options.withDescription("Path to the sandbox directory"),
);

const containerOption = Options.text("container").pipe(
  Options.withDescription("Docker container name"),
  Options.withDefault("claude-sandbox"),
);

const containerOptional = Options.text("container").pipe(
  Options.withDescription("Docker container name (use Docker layer)"),
  Options.optional,
);

const baseHeadOption = Options.text("base-head").pipe(
  Options.withDescription(
    "The HEAD commit SHA from sync-in (used to determine new commits)",
  ),
);

const imageNameOption = Options.text("image-name").pipe(
  Options.withDescription("Docker image name"),
  Options.withDefault("sandcastle:local"),
);

// --- Config directory check ---

const CONFIG_DIR = ".sandcastle";

const requireConfigDir = (cwd: string): Effect.Effect<void, SandboxError> =>
  Effect.tryPromise({
    try: () => access(join(cwd, CONFIG_DIR)),
    catch: () =>
      new SandboxError(
        "configDir",
        "No .sandcastle/ found. Run `sandcastle init` first.",
      ),
  });

// --- Init command ---

const initCommand = Command.make(
  "init",
  {
    container: containerOption,
    imageName: imageNameOption,
  },
  ({ container, imageName }) =>
    Effect.gen(function* () {
      const cwd = process.cwd();

      yield* Console.log("Scaffolding .sandcastle/ config directory...");
      yield* Effect.tryPromise({
        try: () => scaffold(cwd),
        catch: (e) =>
          new SandboxError("init", `${e instanceof Error ? e.message : e}`),
      });
      yield* Console.log("Config directory created.");

      // Resolve tokens
      const tokens = yield* Effect.tryPromise({
        try: () => resolveTokens(cwd),
        catch: (e) =>
          new SandboxError("init", `${e instanceof Error ? e.message : e}`),
      });

      // Build image from .sandcastle/ directory
      const dockerfileDir = join(cwd, CONFIG_DIR);
      yield* Console.log(`Building Docker image '${imageName}'...`);
      yield* buildImage(imageName, dockerfileDir);

      // Start container
      yield* Console.log(`Starting container '${container}'...`);
      yield* startContainer(
        container,
        imageName,
        tokens.oauthToken,
        tokens.ghToken,
      );

      yield* Console.log(`Init complete! Container '${container}' is running.`);
    }),
);

// --- Setup-sandbox command ---

const setupSandboxCommand = Command.make(
  "setup-sandbox",
  {
    container: containerOption,
    imageName: imageNameOption,
  },
  ({ container, imageName }) =>
    Effect.gen(function* () {
      const cwd = process.cwd();
      yield* requireConfigDir(cwd);

      // Resolve tokens
      const tokens = yield* Effect.tryPromise({
        try: () => resolveTokens(cwd),
        catch: (e) =>
          new SandboxError(
            "setup-sandbox",
            `${e instanceof Error ? e.message : e}`,
          ),
      });

      const dockerfileDir = join(cwd, CONFIG_DIR);
      yield* Console.log(`Building Docker image '${imageName}'...`);
      yield* buildImage(imageName, dockerfileDir);

      yield* Console.log(`Starting container '${container}'...`);
      yield* startContainer(
        container,
        imageName,
        tokens.oauthToken,
        tokens.ghToken,
      );

      yield* Console.log(
        `Setup complete! Container '${container}' is running.`,
      );
    }),
);

// --- Cleanup-sandbox command ---

const cleanupSandboxCommand = Command.make(
  "cleanup-sandbox",
  {
    container: containerOption,
    imageName: imageNameOption,
  },
  ({ container, imageName }) =>
    Effect.gen(function* () {
      yield* Console.log(`Cleaning up container '${container}'...`);
      yield* cleanupContainer(container, imageName);
      yield* Console.log("Cleanup complete.");
    }),
);

// --- Sync-in command ---

const SANDBOX_REPOS_DIR = "/home/agent/repos";

const syncInCommand = Command.make(
  "sync-in",
  { sandboxDir: sandboxDirOption, container: containerOptional },
  ({ sandboxDir, container }) =>
    Effect.gen(function* () {
      const hostRepoDir = process.cwd();
      const repoName = hostRepoDir.split("/").pop()!;

      const useDocker = container._tag === "Some";
      const sandboxRepoDir = useDocker
        ? `${SANDBOX_REPOS_DIR}/${repoName}`
        : `${sandboxDir}/repo`;

      yield* Console.log(`Syncing ${hostRepoDir} into ${sandboxRepoDir}...`);

      const layer = useDocker
        ? DockerSandbox.layer(container.value)
        : FilesystemSandbox.layer(sandboxDir);

      const { branch } = yield* syncIn(hostRepoDir, sandboxRepoDir).pipe(
        Effect.provide(layer),
      );

      yield* Console.log(`Sync-in complete. Branch: ${branch}`);
    }),
);

// --- Sync-out command ---

const syncOutCommand = Command.make(
  "sync-out",
  {
    sandboxDir: sandboxDirOption,
    baseHead: baseHeadOption,
    container: containerOptional,
  },
  ({ sandboxDir, baseHead, container }) =>
    Effect.gen(function* () {
      const hostRepoDir = process.cwd();
      const repoName = hostRepoDir.split("/").pop()!;

      const useDocker = container._tag === "Some";
      const sandboxRepoDir = useDocker
        ? `${SANDBOX_REPOS_DIR}/${repoName}`
        : `${sandboxDir}/repo`;

      yield* Console.log(
        `Syncing changes from ${sandboxRepoDir} back to ${hostRepoDir}...`,
      );

      const layer = useDocker
        ? DockerSandbox.layer(container.value)
        : FilesystemSandbox.layer(sandboxDir);

      yield* syncOut(hostRepoDir, sandboxRepoDir, baseHead).pipe(
        Effect.provide(layer),
      );

      yield* Console.log("Sync-out complete.");
    }),
);

// --- Run command ---

const iterationsOption = Options.integer("iterations").pipe(
  Options.withDescription("Number of agent iterations to run"),
  Options.optional,
);

const promptOption = Options.text("prompt").pipe(
  Options.withDescription("Inline prompt string for the agent"),
  Options.optional,
);

const promptFileOption = Options.file("prompt-file").pipe(
  Options.withDescription("Path to the prompt file for the agent"),
  Options.optional,
);

const branchOption = Options.text("branch").pipe(
  Options.withDescription("Target branch name for sandbox work"),
  Options.optional,
);

const runCommand = Command.make(
  "run",
  {
    iterations: iterationsOption,
    imageName: imageNameOption,
    prompt: promptOption,
    promptFile: promptFileOption,
    branch: branchOption,
  },
  ({ iterations, imageName, prompt, promptFile, branch }) =>
    Effect.gen(function* () {
      const hostRepoDir = process.cwd();
      yield* requireConfigDir(hostRepoDir);

      const repoName = hostRepoDir.split("/").pop()!;
      const sandboxRepoDir = `${SANDBOX_REPOS_DIR}/${repoName}`;

      // Resolve auth tokens
      const tokens = yield* Effect.tryPromise({
        try: () => resolveTokens(hostRepoDir),
        catch: (e) =>
          new SandboxError("run", `${e instanceof Error ? e.message : e}`),
      });

      // Resolve prompt via PromptResolver
      const resolvedPrompt = yield* resolvePrompt({
        prompt: prompt._tag === "Some" ? prompt.value : undefined,
        promptFile:
          promptFile._tag === "Some" ? resolve(promptFile.value) : undefined,
        cwd: hostRepoDir,
      });

      // Read config
      const config = yield* readConfig(hostRepoDir);

      // Resolve iterations: CLI flag > config > default (5)
      const resolvedIterations =
        iterations._tag === "Some"
          ? iterations.value
          : (config.defaultIterations ?? 5);

      const resolvedBranch = branch._tag === "Some" ? branch.value : undefined;

      yield* Console.log(`=== SANDCASTLE RUN ===`);
      yield* Console.log(`Image:      ${imageName}`);
      yield* Console.log(`Iterations: ${resolvedIterations}`);
      if (resolvedBranch) {
        yield* Console.log(`Branch:     ${resolvedBranch}`);
      }
      yield* Console.log(``);

      const factoryLayer = DockerSandboxFactory.layer(
        imageName,
        tokens.oauthToken,
        tokens.ghToken,
      );

      const result = yield* orchestrate({
        hostRepoDir,
        sandboxRepoDir,
        iterations: resolvedIterations,
        config,
        prompt: resolvedPrompt,
        branch: resolvedBranch,
      }).pipe(Effect.provide(factoryLayer));

      if (result.complete) {
        yield* Console.log(
          `\nRun complete: agent finished after ${result.iterationsRun} iteration(s).`,
        );
      } else {
        yield* Console.log(
          `\nRun complete: reached ${result.iterationsRun} iteration(s) without completion signal.`,
        );
      }
    }),
);

// --- Interactive command ---

const interactiveSession = (options: {
  hostRepoDir: string;
  sandboxRepoDir: string;
  config: import("./Config.js").SandcastleConfig;
}): Effect.Effect<void, SandboxError, SandboxFactory> =>
  Effect.gen(function* () {
    const { hostRepoDir, sandboxRepoDir, config } = options;
    const factory = yield* SandboxFactory;

    yield* factory.withSandbox(
      withSandboxLifecycle(
        { hostRepoDir, sandboxRepoDir, hooks: config?.hooks },
        (ctx) =>
          Effect.gen(function* () {
            // Get container ID for docker exec -it
            const hostnameResult = yield* ctx.sandbox.exec("hostname");
            const containerId = hostnameResult.stdout.trim();

            // Launch interactive Claude session with TTY passthrough
            yield* Console.log("Launching interactive Claude session...");
            yield* Console.log("");

            const exitCode = yield* Effect.async<number, SandboxError>(
              (resume) => {
                const proc = spawn(
                  "docker",
                  [
                    "exec",
                    "-it",
                    "-w",
                    ctx.sandboxRepoDir,
                    containerId,
                    "claude",
                    "--dangerously-skip-permissions",
                    "--model",
                    "claude-opus-4-6",
                  ],
                  { stdio: "inherit" },
                );

                proc.on("error", (error) => {
                  resume(
                    Effect.fail(
                      new SandboxError(
                        "interactive",
                        `Failed to launch Claude: ${error.message}`,
                      ),
                    ),
                  );
                });

                proc.on("close", (code) => {
                  resume(Effect.succeed(code ?? 0));
                });
              },
            );

            yield* Console.log("");
            yield* Console.log(
              `Session ended (exit code ${exitCode}). Syncing changes back...`,
            );
          }),
      ),
    );
  });

const interactiveCommand = Command.make(
  "interactive",
  {
    imageName: imageNameOption,
  },
  ({ imageName }) =>
    Effect.gen(function* () {
      const hostRepoDir = process.cwd();
      yield* requireConfigDir(hostRepoDir);

      const repoName = hostRepoDir.split("/").pop()!;
      const sandboxRepoDir = `${SANDBOX_REPOS_DIR}/${repoName}`;

      // Resolve auth tokens
      const tokens = yield* Effect.tryPromise({
        try: () => resolveTokens(hostRepoDir),
        catch: (e) =>
          new SandboxError(
            "interactive",
            `${e instanceof Error ? e.message : e}`,
          ),
      });

      const config = yield* readConfig(hostRepoDir);

      yield* Console.log("=== SANDCASTLE (Interactive) ===");
      yield* Console.log(`Image: ${imageName}`);
      yield* Console.log("");

      const factoryLayer = DockerSandboxFactory.layer(
        imageName,
        tokens.oauthToken,
        tokens.ghToken,
      );

      yield* interactiveSession({
        hostRepoDir,
        sandboxRepoDir,
        config,
      }).pipe(Effect.provide(factoryLayer));
    }),
);

// --- Root command ---

const rootCommand = Command.make("sandcastle", {}, () =>
  Effect.gen(function* () {
    yield* Console.log("Sandcastle v0.0.1");
    yield* Console.log("Use --help to see available commands.");
  }),
);

export const sandcastle = rootCommand.pipe(
  Command.withSubcommands([
    syncInCommand,
    syncOutCommand,
    initCommand,
    setupSandboxCommand,
    cleanupSandboxCommand,
    runCommand,
    interactiveCommand,
  ]),
);

export const cli = Command.run(sandcastle, {
  name: "sandcastle",
  version: "0.0.1",
});
