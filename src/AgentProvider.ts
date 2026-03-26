import { SANDBOX_WORKSPACE_DIR } from "./SandboxFactory.js";

export interface AgentProvider {
  readonly name: string;
  readonly envManifest: Record<string, string>;
  readonly dockerfileTemplate: string;
}

const CLAUDE_CODE_DOCKERFILE = `FROM node:22-bookworm

# Install system dependencies
RUN apt-get update && apt-get install -y \\
  git \\
  curl \\
  jq \\
  && rm -rf /var/lib/apt/lists/*

# Enable corepack (pnpm, yarn)
RUN corepack enable

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \\
  | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \\
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \\
  | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \\
  && apt-get update && apt-get install -y gh \\
  && rm -rf /var/lib/apt/lists/*

# Create a non-root user for Claude to run as
RUN useradd -m -s /bin/bash agent
USER agent

# Install Claude Code CLI
RUN curl -fsSL https://claude.ai/install.sh | bash

# Add Claude to PATH
ENV PATH="/home/agent/.local/bin:$PATH"

# Create repos directory
RUN mkdir -p /home/agent/repos

WORKDIR /home/agent

# In worktree sandbox mode, Sandcastle bind-mounts the git worktree at ${SANDBOX_WORKSPACE_DIR}
# and overrides the working directory to ${SANDBOX_WORKSPACE_DIR} at container start.
# Structure your Dockerfile so that ${SANDBOX_WORKSPACE_DIR} can serve as the project root.
ENTRYPOINT ["sleep", "infinity"]
`;

export const claudeCodeProvider: AgentProvider = {
  name: "claude-code",

  envManifest: {
    ANTHROPIC_API_KEY: "Anthropic API key",
    GH_TOKEN: "GitHub personal access token",
  },

  dockerfileTemplate: CLAUDE_CODE_DOCKERFILE,
};

const AGENT_REGISTRY: Record<string, AgentProvider> = {
  "claude-code": claudeCodeProvider,
};

export const getAgentProvider = (name: string): AgentProvider => {
  const provider = AGENT_REGISTRY[name];
  if (!provider) {
    throw new Error(
      `Unknown agent provider: "${name}". Available providers: ${Object.keys(AGENT_REGISTRY).join(", ")}`,
    );
  }
  return provider;
};
