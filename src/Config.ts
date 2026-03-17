import { Effect } from "effect";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface SandcastleConfig {
  readonly postSyncIn?: string;
}

export const readConfig = (repoDir: string): Effect.Effect<SandcastleConfig> =>
  Effect.promise(() =>
    readFile(join(repoDir, ".sandcastle.json"), "utf-8")
      .then((content) => JSON.parse(content) as SandcastleConfig)
      .catch(() => ({})),
  );
