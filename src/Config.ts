import { Effect } from "effect";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface HookDefinition {
  readonly command: string;
}

export interface SandcastleConfig {
  readonly hooks?: {
    readonly onSandboxCreate?: readonly HookDefinition[];
    readonly onSandboxReady?: readonly HookDefinition[];
  };
  readonly defaultIterations?: number;
}

export const readConfig = (repoDir: string): Effect.Effect<SandcastleConfig> =>
  Effect.promise(() =>
    readFile(join(repoDir, ".sandcastle", "config.json"), "utf-8")
      .then((content) => JSON.parse(content) as SandcastleConfig)
      .catch(() => ({})),
  );
