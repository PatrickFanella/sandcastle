import * as sandcastle from "sandcastle";

await sandcastle.run({
  hooks: {
    onSandboxReady: [
      {
        command: "npm install && npm run build",
      },
    ],
  },
  maxIterations: 100,
  model: "claude-opus-4-6",
  promptFile: "./.sandcastle/prompt.md",
});
