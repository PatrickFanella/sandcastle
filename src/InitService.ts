import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentProvider } from "./AgentProvider.js";
import { SKELETON_PROMPT } from "./templates.js";

const GITIGNORE = `.env
patches/
logs/
`;

function buildEnvExample(envManifest: Record<string, string>): string {
  return (
    Object.entries(envManifest)
      .map(([key, comment]) => `# ${comment}\n${key}=`)
      .join("\n") + "\n"
  );
}

export async function scaffold(
  repoDir: string,
  provider: AgentProvider,
): Promise<void> {
  const configDir = join(repoDir, ".sandcastle");

  try {
    await mkdir(configDir, { recursive: false });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        ".sandcastle/ directory already exists. Remove it first if you want to re-initialize.",
      );
    }
    throw err;
  }

  await Promise.all([
    writeFile(join(configDir, "Dockerfile"), provider.dockerfileTemplate),
    writeFile(join(configDir, "prompt.md"), SKELETON_PROMPT),
    writeFile(
      join(configDir, ".env.example"),
      buildEnvExample(provider.envManifest),
    ),
    writeFile(join(configDir, ".gitignore"), GITIGNORE),
    writeFile(
      join(configDir, "config.json"),
      JSON.stringify({ agent: provider.name }, null, 2) + "\n",
    ),
  ]);
}
