/**
 * E2E tests for init templates — scaffolds the template, dynamically imports
 * the generated main.mts with @ai-hero/sandcastle aliased (via vitest.config.ts)
 * to the internal testSupport module, and asserts the recorded agent invocations.
 *
 * No Docker, no real agent, no network.
 */
import { NodeFileSystem } from "@effect/platform-node";
import { exec } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  scaffold,
  getAgent,
  getBacklogManager,
  listAgents,
  listBacklogManagers,
} from "./InitService.js";
import {
  clearRecordedInvocations,
  getRecordedInvocations,
  setStdoutByRunName,
} from "./testSupport.js";

const execAsync = promisify(exec);

describe("init-template e2e", () => {
  let scaffoldDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    scaffoldDir = await mkdtemp(join(tmpdir(), "init-template-e2e-"));

    // Create a git repo in the scaffold dir so that branch resolution works
    await execAsync("git init -b main", { cwd: scaffoldDir });
    await execAsync('git config user.email "test@sandcastle.local"', {
      cwd: scaffoldDir,
    });
    await execAsync('git config user.name "Sandcastle Test"', {
      cwd: scaffoldDir,
    });
    // Need at least one commit for git branch operations
    await execAsync("git commit --allow-empty -m 'initial commit'", {
      cwd: scaffoldDir,
    });

    clearRecordedInvocations();
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    try {
      await rm(scaffoldDir, { recursive: true, force: true });
    } catch {}
  });

  describe("blank template", () => {
    it("scaffolds and executes with claudeCode agent, github-issues backlog manager", async () => {
      const agent = getAgent("claude-code")!;
      const backlogManager = getBacklogManager("github-issues")!;

      // Scaffold the blank template
      const result = await Effect.runPromise(
        scaffold(scaffoldDir, {
          agent,
          model: "claude-opus-4-6",
          templateName: "blank",
          createLabel: true,
          backlogManager,
        }).pipe(Effect.provide(NodeFileSystem.layer)),
      );

      // Verify the main file was created
      const mainFilePath = join(
        scaffoldDir,
        ".sandcastle",
        result.mainFilename,
      );
      const mainContent = await readFile(mainFilePath, "utf-8");
      expect(mainContent).toContain("run");
      expect(mainContent).toContain("claudeCode");

      // Read the expected prompt content
      const promptPath = join(scaffoldDir, ".sandcastle", "prompt.md");
      const expectedPrompt = await readFile(promptPath, "utf-8");

      // chdir to the scaffold dir so relative prompt file paths resolve
      process.chdir(scaffoldDir);

      // Dynamically import the scaffolded main file.
      // The vitest alias rewrites @ai-hero/sandcastle → testSupport.ts
      // which exports runForTest as run, so the template runs unchanged.
      await import(mainFilePath);

      // Assert the recorded invocation
      const invocations = getRecordedInvocations();
      expect(invocations).toHaveLength(1);

      const invocation = invocations[0]!;
      expect(invocation.agentProvider).toBe("claude-code");
      expect(invocation.model).toBe("claude-opus-4-6");
      expect(invocation.prompt).toBe(expectedPrompt);
      expect(invocation.branchStrategy).toEqual({ type: "head" });
      expect(invocation.maxIterations).toBe(1);
      expect(invocation.iterationIndex).toBe(1);
    });
  });

  const agents = listAgents();
  const backlogManagers = listBacklogManagers();

  const combinations = agents.flatMap((agent) =>
    backlogManagers.map((bm) => ({
      agentName: agent.name,
      bmName: bm.name,
    })),
  );

  /** Shell expression substrings expected per backlog manager. */
  const shellExpressionsByBm: Record<string, string[]> = {
    "github-issues": ["gh issue list", "gh issue close"],
    beads: ["bd ready", "bd close"],
  };

  describe("simple-loop template", () => {
    describe.each(combinations)(
      "agent=$agentName, backlog-manager=$bmName",
      ({ agentName, bmName }) => {
        it("scaffolds and executes with iterate-until-COMPLETE wiring", async () => {
          const agent = getAgent(agentName)!;
          const backlogManager = getBacklogManager(bmName)!;

          // Scaffold the simple-loop template
          const result = await Effect.runPromise(
            scaffold(scaffoldDir, {
              agent,
              model: agent.defaultModel,
              templateName: "simple-loop",
              createLabel: true,
              backlogManager,
            }).pipe(Effect.provide(NodeFileSystem.layer)),
          );

          // Read the expected prompt content
          const promptPath = join(scaffoldDir, ".sandcastle", "prompt.md");
          const expectedPrompt = await readFile(promptPath, "utf-8");

          // Assert the prompt contains the backlog-manager's shell expressions
          for (const expr of shellExpressionsByBm[bmName]!) {
            expect(expectedPrompt).toContain(expr);
          }

          // chdir to the scaffold dir so relative prompt file paths resolve
          process.chdir(scaffoldDir);

          // Dynamically import the scaffolded main file.
          const mainFilePath = join(
            scaffoldDir,
            ".sandcastle",
            result.mainFilename,
          );
          await import(mainFilePath);

          // Assert: only one recorded invocation (completion signal stops loop)
          const invocations = getRecordedInvocations();
          expect(invocations).toHaveLength(1);

          const invocation = invocations[0]!;

          // Assert: agent provider matches the --agent choice
          expect(invocation.agentProvider).toBe(agentName);

          // Assert: model matches the agent's defaultModel
          expect(invocation.model).toBe(agent.defaultModel);

          // Assert: recorded prompt matches the scaffolded prompt
          expect(invocation.prompt).toBe(expectedPrompt);

          // Assert: branch strategy from the template (merge-to-head)
          expect(invocation.branchStrategy).toEqual({
            type: "merge-to-head",
          });

          // Assert: maxIterations from the template (3)
          expect(invocation.maxIterations).toBe(3);

          // Assert: only first iteration ran (completion signal on iteration 1)
          expect(invocation.iterationIndex).toBe(1);
        });
      },
    );
  });

  describe("sequential-reviewer template", () => {
    describe.each(combinations)(
      "agent=$agentName, backlog-manager=$bmName",
      ({ agentName, bmName }) => {
        it("scaffolds and executes implement→review cycle", async () => {
          const agent = getAgent(agentName)!;
          const backlogManager = getBacklogManager(bmName)!;

          // Scaffold the sequential-reviewer template
          const result = await Effect.runPromise(
            scaffold(scaffoldDir, {
              agent,
              model: agent.defaultModel,
              templateName: "sequential-reviewer",
              createLabel: true,
              backlogManager,
            }).pipe(Effect.provide(NodeFileSystem.layer)),
          );

          const mainFilePath = join(
            scaffoldDir,
            ".sandcastle",
            result.mainFilename,
          );

          // Patch MAX_ITERATIONS to 1 so only one implement→review cycle runs.
          // The template uses a for-loop; without this patch it would run 10
          // cycles, each producing 2 recorded invocations.
          let mainContent = await readFile(mainFilePath, "utf-8");
          mainContent = mainContent.replace(
            /const MAX_ITERATIONS = \d+;/,
            "const MAX_ITERATIONS = 1;",
          );
          await writeFile(mainFilePath, mainContent);

          // Read expected prompts from the scaffolded template files
          const implementPromptPath = join(
            scaffoldDir,
            ".sandcastle",
            "implement-prompt.md",
          );
          const reviewPromptPath = join(
            scaffoldDir,
            ".sandcastle",
            "review-prompt.md",
          );
          const expectedImplementPrompt = await readFile(
            implementPromptPath,
            "utf-8",
          );
          const expectedReviewPromptRaw = await readFile(
            reviewPromptPath,
            "utf-8",
          );

          // Assert the implement prompt contains the backlog-manager's shell
          // expressions (pre-expansion, since IdentityPromptPreprocessor is used)
          for (const expr of shellExpressionsByBm[bmName]!) {
            expect(expectedImplementPrompt).toContain(expr);
          }

          // chdir to the scaffold dir so relative prompt file paths resolve
          process.chdir(scaffoldDir);

          // Dynamically import the scaffolded main file.
          await import(mainFilePath);

          // Assert: exactly 2 recorded invocations (implement + review)
          const invocations = getRecordedInvocations();
          expect(invocations).toHaveLength(2);

          // -----------------------------------------------------------------
          // First invocation: implement phase
          // -----------------------------------------------------------------
          const implement = invocations[0]!;

          // Agent provider matches the --agent choice
          expect(implement.agentProvider).toBe(agentName);

          // Model matches the agent's defaultModel
          expect(implement.model).toBe(agent.defaultModel);

          // Recorded prompt matches the scaffolded implement-prompt.md
          expect(implement.prompt).toBe(expectedImplementPrompt);

          // Branch strategy from the template (merge-to-head)
          expect(implement.branchStrategy).toEqual({
            type: "merge-to-head",
          });

          // maxIterations from the template (100)
          expect(implement.maxIterations).toBe(100);

          // Run name from the template
          expect(implement.runName).toBe("implementer");

          // No user-provided prompt args for the implement phase
          expect(implement.promptArgs).toEqual({});

          // -----------------------------------------------------------------
          // Second invocation: review phase
          // -----------------------------------------------------------------
          const review = invocations[1]!;

          // Agent provider matches the --agent choice
          expect(review.agentProvider).toBe(agentName);

          // Model matches the agent's defaultModel
          expect(review.model).toBe(agent.defaultModel);

          // Review prompt has {{BRANCH}} substituted with the branch name.
          // The implement result branch is "main" (the scaffoldDir's branch).
          const expectedReviewPrompt = expectedReviewPromptRaw.replace(
            /\{\{BRANCH\}\}/g,
            "main",
          );
          expect(review.prompt).toBe(expectedReviewPrompt);

          // Branch strategy: explicit branch targeting the implement branch
          expect(review.branchStrategy).toEqual({
            type: "branch",
            branch: "main",
          });

          // maxIterations from the template (1)
          expect(review.maxIterations).toBe(1);

          // Run name from the template
          expect(review.runName).toBe("reviewer");

          // Prompt args: BRANCH is passed through
          expect(review.promptArgs).toEqual({ BRANCH: "main" });
        });
      },
    );
  });

  describe("parallel-planner template", () => {
    // Plan data returned by the planner agent — one issue to exercise all
    // three phases (plan → implement → merge).
    const planIssue = {
      id: "42",
      title: "Fix auth bug",
      branch: "sandcastle/issue-42-fix-auth-bug",
    };
    const planResponse = [
      `<plan>${JSON.stringify({ issues: [planIssue] })}</plan>`,
      "<promise>COMPLETE</promise>",
    ].join("\n");

    describe.each(combinations)(
      "agent=$agentName, backlog-manager=$bmName",
      ({ agentName, bmName }) => {
        it("scaffolds and executes plan→implement→merge pipeline", async () => {
          const agent = getAgent(agentName)!;
          const backlogManager = getBacklogManager(bmName)!;

          // Scaffold the parallel-planner template
          const result = await Effect.runPromise(
            scaffold(scaffoldDir, {
              agent,
              model: agent.defaultModel,
              templateName: "parallel-planner",
              createLabel: true,
              backlogManager,
            }).pipe(Effect.provide(NodeFileSystem.layer)),
          );

          const mainFilePath = join(
            scaffoldDir,
            ".sandcastle",
            result.mainFilename,
          );

          // Patch MAX_ITERATIONS to 1 so only one plan→execute→merge cycle runs.
          let mainContent = await readFile(mainFilePath, "utf-8");
          mainContent = mainContent.replace(
            /const MAX_ITERATIONS = \d+;/,
            "const MAX_ITERATIONS = 1;",
          );
          await writeFile(mainFilePath, mainContent);

          // Read expected prompts from the scaffolded template files
          const planPromptPath = join(
            scaffoldDir,
            ".sandcastle",
            "plan-prompt.md",
          );
          const implementPromptPath = join(
            scaffoldDir,
            ".sandcastle",
            "implement-prompt.md",
          );
          const mergePromptPath = join(
            scaffoldDir,
            ".sandcastle",
            "merge-prompt.md",
          );
          const expectedPlanPrompt = await readFile(planPromptPath, "utf-8");
          const expectedImplementPromptRaw = await readFile(
            implementPromptPath,
            "utf-8",
          );
          const expectedMergePromptRaw = await readFile(
            mergePromptPath,
            "utf-8",
          );

          // Assert the prompts contain backlog-manager shell expressions
          // (pre-expansion, since IdentityPromptPreprocessor is used)
          const allPromptText = [
            expectedPlanPrompt,
            expectedImplementPromptRaw,
            expectedMergePromptRaw,
          ].join("\n");
          for (const expr of shellExpressionsByBm[bmName]!) {
            expect(allPromptText).toContain(expr);
          }

          // Configure the planner to return a valid plan so the template
          // proceeds through all three phases.
          setStdoutByRunName({ planner: planResponse });

          // chdir to the scaffold dir so relative prompt file paths resolve
          process.chdir(scaffoldDir);

          try {
            await import(mainFilePath);
          } finally {
            setStdoutByRunName(undefined);
          }

          // Assert: 3 recorded invocations (plan + implement + merge)
          const invocations = getRecordedInvocations();
          expect(invocations).toHaveLength(3);

          // -----------------------------------------------------------
          // Phase 1: Plan
          // -----------------------------------------------------------
          const plan = invocations[0]!;

          // Agent provider matches the --agent choice
          expect(plan.agentProvider).toBe(agentName);

          // Model matches the agent's defaultModel (scaffold rewrites all
          // factory calls to the same model)
          expect(plan.model).toBe(agent.defaultModel);

          // Recorded prompt matches the scaffolded plan-prompt.md
          expect(plan.prompt).toBe(expectedPlanPrompt);

          // No explicit branchStrategy → default head
          expect(plan.branchStrategy).toEqual({ type: "head" });

          // maxIterations from the template (1)
          expect(plan.maxIterations).toBe(1);

          // Run name from the template
          expect(plan.runName).toBe("planner");

          // No user-provided prompt args for the plan phase
          expect(plan.promptArgs).toEqual({});

          // -----------------------------------------------------------
          // Phase 2: Implement (one issue from the plan)
          // -----------------------------------------------------------
          const implement = invocations[1]!;

          // Agent provider matches the --agent choice
          expect(implement.agentProvider).toBe(agentName);

          // Model matches the agent's defaultModel
          expect(implement.model).toBe(agent.defaultModel);

          // Implement prompt has {{TASK_ID}}, {{ISSUE_TITLE}}, {{BRANCH}}
          // substituted with the plan issue's values.
          const expectedImplementPrompt = expectedImplementPromptRaw
            .replace(/\{\{TASK_ID\}\}/g, planIssue.id)
            .replace(/\{\{ISSUE_TITLE\}\}/g, planIssue.title)
            .replace(/\{\{BRANCH\}\}/g, planIssue.branch);
          expect(implement.prompt).toBe(expectedImplementPrompt);

          // Branch strategy: explicit branch targeting the plan issue's branch
          expect(implement.branchStrategy).toEqual({
            type: "branch",
            branch: planIssue.branch,
          });

          // maxIterations from the template (100)
          expect(implement.maxIterations).toBe(100);

          // Run name from the template
          expect(implement.runName).toBe("implementer");

          // Prompt args: TASK_ID, ISSUE_TITLE, BRANCH from the plan issue
          expect(implement.promptArgs).toEqual({
            TASK_ID: planIssue.id,
            ISSUE_TITLE: planIssue.title,
            BRANCH: planIssue.branch,
          });

          // -----------------------------------------------------------
          // Phase 3: Merge
          // -----------------------------------------------------------
          const merge = invocations[2]!;

          // Agent provider matches the --agent choice
          expect(merge.agentProvider).toBe(agentName);

          // Model matches the agent's defaultModel
          expect(merge.model).toBe(agent.defaultModel);

          // Merge prompt has {{BRANCHES}} and {{ISSUES}} substituted
          const expectedBranches = `- ${planIssue.branch}`;
          const expectedIssues = `- ${planIssue.id}: ${planIssue.title}`;
          const expectedMergePrompt = expectedMergePromptRaw
            .replace(/\{\{BRANCHES\}\}/g, expectedBranches)
            .replace(/\{\{ISSUES\}\}/g, expectedIssues);
          expect(merge.prompt).toBe(expectedMergePrompt);

          // No explicit branchStrategy → default head
          expect(merge.branchStrategy).toEqual({ type: "head" });

          // maxIterations from the template (1)
          expect(merge.maxIterations).toBe(1);

          // Run name from the template
          expect(merge.runName).toBe("merger");

          // Prompt args: BRANCHES and ISSUES lists
          expect(merge.promptArgs).toEqual({
            BRANCHES: expectedBranches,
            ISSUES: expectedIssues,
          });
        });
      },
    );
  });
});
