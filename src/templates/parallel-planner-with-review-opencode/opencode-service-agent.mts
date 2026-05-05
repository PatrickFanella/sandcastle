import { spawn, spawnSync } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const roles = ["planner", "implementer", "reviewer", "merger"] as const;

type Role = (typeof roles)[number];

type Args = {
  role?: Role;
  title?: string;
  model?: string;
  modelEnv?: string;
  healthcheckOnly: boolean;
  jsonl: boolean;
  help: boolean;
};

type OpenCodeModel = {
  providerID: string;
  modelID: string;
};

const baseUrl = "http://127.0.0.1:4096";
const stateDir = "/tmp/sandcastle-opencode";
const pidFile = path.join(stateDir, "opencode.pid");
const logFile = path.join(stateDir, "opencode.log");
const healthTimeoutMs = 30_000;

const modelEnvByRole: Record<Role, string> = {
  planner: "SANDCASTLE_OPENCODE_PLANNER_MODEL",
  implementer: "SANDCASTLE_OPENCODE_IMPLEMENTER_MODEL",
  reviewer: "SANDCASTLE_OPENCODE_REVIEWER_MODEL",
  merger: "SANDCASTLE_OPENCODE_MERGER_MODEL",
};

const usage = `Usage: npx tsx .sandcastle/opencode-service-agent.mts --role <planner|implementer|reviewer|merger> [--title <title>] [--model <provider/model>] [--model-env <ENV_NAME>] [--healthcheck-only] [--jsonl]

Reads prompt from stdin, starts/reuses a sandbox-local OpenCode service, and prints final assistant text to stdout.
Use --jsonl to emit heartbeat/result events for Sandcastle stream parsing.
`;

function parseArgs(argv: string[]): Args {
  const args: Args = { healthcheckOnly: false, jsonl: false, help: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--help" || arg === "-h") {
      args.help = true;
      continue;
    }

    if (arg === "--healthcheck-only") {
      args.healthcheckOnly = true;
      continue;
    }

    if (arg === "--jsonl") {
      args.jsonl = true;
      continue;
    }

    if (arg === "--role") {
      const value = argv[++i];
      if (!isRole(value)) {
        throw new Error(`Invalid --role: ${value ?? "<missing>"}`);
      }
      args.role = value;
      continue;
    }

    if (arg === "--title") {
      args.title = argv[++i] ?? "";
      continue;
    }

    if (arg === "--model") {
      args.model = argv[++i] ?? "";
      continue;
    }

    if (arg === "--model-env") {
      args.modelEnv = argv[++i] ?? "";
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function isRole(value: string | undefined): value is Role {
  return roles.includes(value as Role);
}

function authHeader(): Record<string, string> {
  const password = process.env.OPENCODE_SERVER_PASSWORD;
  if (!password) return {};

  const username = process.env.OPENCODE_SERVER_USERNAME || "opencode";
  const token = Buffer.from(`${username}:${password}`).toString("base64");
  return { Authorization: `Basic ${token}` };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8");
}

function validateRuntime(role: Role): void {
  if (typeof fetch !== "function") {
    throw new Error("This wrapper requires Node 22+ with global fetch.");
  }

  const opencode = spawnSync("opencode", ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (opencode.error || opencode.status !== 0) {
    const detail =
      opencode.error?.message || opencode.stderr || opencode.stdout;
    throw new Error(
      `OpenCode CLI is not available in this sandbox. ${detail}`.trim(),
    );
  }

  if (!isRole(role)) {
    throw new Error(`Invalid role: ${role}`);
  }
}

async function request(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  for (const [key, value] of Object.entries(authHeader())) {
    headers.set(key, value);
  }

  return fetch(url, { ...init, headers });
}

async function isHealthy(): Promise<boolean> {
  try {
    const response = await request(`${baseUrl}/global/health`);
    return response.ok;
  } catch {
    return false;
  }
}

async function ensureService(): Promise<void> {
  await mkdir(stateDir, { recursive: true });

  if (await isHealthy()) return;

  await killStalePid();
  await startService();

  if (await waitForHealth()) return;

  await failWithLogTail(
    "OpenCode service did not become healthy after startup.",
  );
}

async function killStalePid(): Promise<void> {
  let pidText: string;
  try {
    pidText = await readFile(pidFile, "utf8");
  } catch {
    return;
  }

  const pid = Number.parseInt(pidText.trim(), 10);
  if (!Number.isFinite(pid) || pid <= 0) return;

  try {
    process.kill(pid, "SIGTERM");
    await delay(1_000);
  } catch {
    // Already gone.
  }

  try {
    process.kill(pid, 0);
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

async function startService(): Promise<void> {
  console.error(
    `[sandcastle-opencode] starting OpenCode service at ${baseUrl}`,
  );
  await writeFile(
    logFile,
    `[sandcastle-opencode] starting OpenCode service at ${baseUrl}\n`,
    { flag: "a" },
  );

  const stdoutFd = openSync(logFile, "a");
  const stderrFd = openSync(logFile, "a");

  const child = spawn(
    "opencode",
    ["serve", "--hostname", "127.0.0.1", "--port", "4096"],
    {
      detached: true,
      stdio: ["ignore", stdoutFd, stderrFd],
      env: process.env,
    },
  );

  closeSync(stdoutFd);
  closeSync(stderrFd);

  child.unref();
  await writeFile(pidFile, String(child.pid), "utf8");
  await writeFile(logFile, `[sandcastle-opencode] started pid ${child.pid}\n`, {
    flag: "a",
  });
}

async function waitForHealth(): Promise<boolean> {
  const deadline = Date.now() + healthTimeoutMs;

  while (Date.now() < deadline) {
    if (await isHealthy()) return true;
    await delay(500);
  }

  return false;
}

async function createSession(role: Role, title?: string): Promise<string> {
  const sessionTitle = `sandcastle ${role}${title ? `: ${title}` : ""}`;
  const response = await request(`${baseUrl}/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: sessionTitle }),
  });

  if (!response.ok) {
    throw new Error(
      `Failed to create OpenCode session: ${response.status} ${await response.text()}`,
    );
  }

  const payload = await response.json();
  const id = findSessionId(payload);

  if (!id) {
    throw new Error(
      `OpenCode session response did not include an id: ${JSON.stringify(payload)}`,
    );
  }

  return id;
}

function findSessionId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;

  const record = payload as Record<string, unknown>;
  if (typeof record.id === "string") return record.id;

  const data = record.data;
  if (
    data &&
    typeof data === "object" &&
    typeof (data as Record<string, unknown>).id === "string"
  ) {
    return (data as Record<string, string>).id;
  }

  return undefined;
}

async function sendPrompt(
  sessionId: string,
  args: Required<Pick<Args, "role">> & Pick<Args, "model" | "modelEnv">,
  prompt: string,
): Promise<unknown> {
  const body: Record<string, unknown> = {
    parts: [{ type: "text", text: prompt }],
  };

  const model = parseModel(args);
  if (model) {
    body.model = model;
  }

  const response = await request(
    `${baseUrl}/session/${encodeURIComponent(sessionId)}/message`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );

  if (!response.ok) {
    throw new Error(
      `OpenCode prompt failed: ${response.status} ${await response.text()}`,
    );
  }

  const text = await response.text();
  if (!text.trim()) {
    throw new Error(
      "OpenCode prompt returned an empty response. Check the OpenCode service log.",
    );
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `OpenCode prompt returned invalid JSON: ${detail}. Body: ${text.slice(0, 500)}`,
    );
  }
}

function parseModel(
  args: Required<Pick<Args, "role">> & Pick<Args, "model" | "modelEnv">,
): OpenCodeModel | undefined {
  if (args.model?.trim()) return parseModelValue(args.model.trim(), "--model");

  if (args.modelEnv?.trim()) {
    const value = process.env[args.modelEnv]?.trim();
    if (value) return parseModelValue(value, args.modelEnv);
  }

  const envName = modelEnvByRole[args.role];
  const value = process.env[envName]?.trim();
  if (!value) return undefined;
  return parseModelValue(value, envName);
}

function parseModelValue(value: string, source: string): OpenCodeModel {
  const separatorIndex = value.indexOf("/");
  if (separatorIndex <= 0 || separatorIndex === value.length - 1) {
    throw new Error(
      `${source} must be an exact OpenCode model id in <provider>/<model> format.`,
    );
  }

  return {
    providerID: value.slice(0, separatorIndex),
    modelID: value.slice(separatorIndex + 1),
  };
}

function extractText(payload: unknown): string | undefined {
  const texts: string[] = [];

  function visit(value: unknown): void {
    if (!value || typeof value !== "object") return;

    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }

    const record = value as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") {
      texts.push(record.text);
      return;
    }

    for (const key of ["parts", "data", "message", "info"]) {
      if (key in record) visit(record[key]);
    }
  }

  visit(payload);
  const output = texts.join("\n").trim();
  return output.length > 0 ? output : undefined;
}

function findOpenCodeError(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;

  const record = payload as Record<string, unknown>;
  const direct = formatOpenCodeError(record.error);
  if (direct) return direct;

  const info = record.info;
  if (info && typeof info === "object") {
    const nested = formatOpenCodeError((info as Record<string, unknown>).error);
    if (nested) return nested;
  }

  const data = record.data;
  if (data && typeof data === "object") {
    const nested = findOpenCodeError(data);
    if (nested) return nested;
  }

  return undefined;
}

function formatOpenCodeError(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;

  const error = value as Record<string, unknown>;
  const name = typeof error.name === "string" ? error.name : "OpenCodeError";
  const data = error.data;

  if (data && typeof data === "object") {
    const dataRecord = data as Record<string, unknown>;
    const message =
      typeof dataRecord.message === "string" ? dataRecord.message : undefined;
    const statusCode =
      typeof dataRecord.statusCode === "number"
        ? ` (${dataRecord.statusCode})`
        : "";
    if (message) return `${name}${statusCode}: ${message}`;
  }

  return `${name}: ${JSON.stringify(error)}`;
}

async function failWithLogTail(message: string): Promise<never> {
  console.error(`[sandcastle-opencode] ${message}`);
  console.error(await logTail());
  process.exit(1);
}

async function logTail(): Promise<string> {
  try {
    const content = await readFile(logFile, "utf8");
    const lines = content.trimEnd().split("\n");
    return lines.slice(-80).join("\n");
  } catch (error) {
    return `[sandcastle-opencode] no log file at ${logFile}: ${(error as Error).message}`;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeJsonlEvent(event: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    process.stdout.write(usage);
    return;
  }

  if (!args.role) {
    throw new Error("Missing required --role.");
  }

  const role = args.role;

  validateRuntime(role);
  await ensureService();

  if (args.healthcheckOnly) {
    console.error(`[sandcastle-opencode] service healthy at ${baseUrl}`);
    return;
  }

  const prompt = await readStdin();
  const sessionId = await createSession(role, args.title);
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  if (args.jsonl) {
    writeJsonlEvent({
      type: "status",
      message: "opencode session created",
      sessionId,
    });
    heartbeat = setInterval(() => {
      writeJsonlEvent({ type: "heartbeat", message: "waiting for opencode" });
    }, 30_000);
  }

  let payload: unknown;

  try {
    payload = await sendPrompt(sessionId, { ...args, role }, prompt);
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }

  const opencodeError = findOpenCodeError(payload);

  if (opencodeError) {
    throw new Error(opencodeError);
  }

  const text = extractText(payload);

  if (args.jsonl) {
    writeJsonlEvent({
      type: "result",
      result: text || JSON.stringify(payload),
    });
    return;
  }

  process.stdout.write(text ? `${text}\n` : `${JSON.stringify(payload)}\n`);
}

main().catch(async (error) => {
  console.error(`[sandcastle-opencode] ${(error as Error).message}`);
  console.error(await logTail());
  process.exit(1);
});
