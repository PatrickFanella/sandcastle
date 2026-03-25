import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentProvider } from "./AgentProvider.js";

const GITIGNORE = `.env
patches/
logs/
worktrees/
`;

export interface TemplateMetadata {
  name: string;
  description: string;
}

const TEMPLATES: TemplateMetadata[] = [
  {
    name: "blank",
    description: "Bare scaffold — write your own prompt and orchestration",
  },
  {
    name: "simple-loop",
    description: "Picks GitHub issues one by one and closes them",
  },
  {
    name: "sequential-reviewer",
    description:
      "Implements issues one by one, with a code review step after each",
  },
  {
    name: "parallel-planner",
    description:
      "Plans parallelizable issues, executes on separate branches, merges",
  },
];

export const listTemplates = (): TemplateMetadata[] => TEMPLATES;

export function getNextStepsLines(template: string): string[] {
  if (template === "blank") {
    return [
      "Next steps:",
      "1. Fill in .sandcastle/.env with your agent credentials",
      "2. Read and customize .sandcastle/prompt.md to describe what you want the agent to do",
      "3. Run `npx sandcastle run` to start the agent",
    ];
  } else {
    return [
      "Next steps:",
      "1. Fill in .sandcastle/.env with your agent credentials",
      `2. Add "sandcastle": "npx tsx .sandcastle/main.ts" to your package.json scripts`,
      "3. Customize the `npm install` command in the onSandboxReady hook if your project uses a different package manager",
      "4. Read and customize the prompt files in .sandcastle/ — they shape what the agent does",
      "5. Run `npm run sandcastle` to start the agent",
    ];
  }
}

function buildEnvExample(envManifest: Record<string, string>): string {
  return (
    Object.entries(envManifest)
      .map(([key, comment]) => `# ${comment}\n${key}=`)
      .join("\n") + "\n"
  );
}

function getTemplatesDir(): string {
  const thisFile = fileURLToPath(import.meta.url);
  return join(dirname(thisFile), "templates");
}

const getTemplateDir = (
  templateName: string,
): Effect.Effect<string, Error, never> =>
  Effect.gen(function* () {
    const template = TEMPLATES.find((t) => t.name === templateName);
    if (!template) {
      const names = TEMPLATES.map((t) => t.name).join(", ");
      yield* Effect.fail(
        new Error(`Unknown template: "${templateName}". Available: ${names}`),
      );
    }
    return join(getTemplatesDir(), templateName);
  });

const copyTemplateFiles = (
  templateDir: string,
  destDir: string,
): Effect.Effect<void, Error, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const files = yield* fs
      .readDirectory(templateDir)
      .pipe(Effect.mapError((e) => new Error(e.message)));
    yield* Effect.all(
      files
        .filter(
          (f) =>
            f !== "template.json" &&
            !f.endsWith(".js") &&
            !f.endsWith(".js.map") &&
            !f.endsWith(".d.ts") &&
            !f.endsWith(".d.ts.map"),
        )
        .map((f) =>
          fs
            .copyFile(join(templateDir, f), join(destDir, f))
            .pipe(Effect.mapError((e) => new Error(e.message))),
        ),
      { concurrency: "unbounded" },
    );
  });

export const scaffold = (
  repoDir: string,
  provider: AgentProvider,
  templateName = "blank",
): Effect.Effect<void, Error, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const configDir = join(repoDir, ".sandcastle");

    const exists = yield* fs
      .exists(configDir)
      .pipe(Effect.mapError((e) => new Error(e.message)));
    if (exists) {
      yield* Effect.fail(
        new Error(
          ".sandcastle/ directory already exists. Remove it first if you want to re-initialize.",
        ),
      );
    }

    yield* fs
      .makeDirectory(configDir, { recursive: false })
      .pipe(Effect.mapError((e) => new Error(e.message)));

    const templateDir = yield* getTemplateDir(templateName);

    yield* Effect.all(
      [
        fs
          .writeFileString(
            join(configDir, "Dockerfile"),
            provider.dockerfileTemplate,
          )
          .pipe(Effect.mapError((e) => new Error(e.message))),
        fs
          .writeFileString(
            join(configDir, ".env.example"),
            buildEnvExample(provider.envManifest),
          )
          .pipe(Effect.mapError((e) => new Error(e.message))),
        fs
          .writeFileString(join(configDir, ".gitignore"), GITIGNORE)
          .pipe(Effect.mapError((e) => new Error(e.message))),
        copyTemplateFiles(templateDir, configDir),
      ],
      { concurrency: "unbounded" },
    );
  });
