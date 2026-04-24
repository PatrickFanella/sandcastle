import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { WorktreeLockError } from "./errors.js";

export { WorktreeLockError };

export interface LockData {
  pid: number;
  branch: string;
  acquiredAt: string;
}

/**
 * Check whether a process with the given PID is alive.
 * Uses `process.kill(pid, 0)` which sends no signal — it only checks existence.
 */
const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const CREATE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL;

/**
 * Remove a stale lock file, then retry atomic O_EXCL creation.
 * If the retry loses a race (another process created the file first),
 * throws a WorktreeLockError with the winner's diagnostic info.
 */
const removeStaleAndRetry = async (
  lockPath: string,
  worktreeName: string,
): Promise<FileHandle> => {
  await rm(lockPath, { force: true });
  try {
    return await open(lockPath, CREATE_FLAGS);
  } catch (retryErr: unknown) {
    if ((retryErr as NodeJS.ErrnoException).code !== "EEXIST") throw retryErr;
    // Another process raced us and won — re-read to report contention
    try {
      const raw = await readFile(lockPath, "utf-8");
      const winner = JSON.parse(raw) as LockData;
      throw new WorktreeLockError({
        message: `Worktree is in use by process ${winner.pid} (branch '${winner.branch}', acquired at ${winner.acquiredAt})`,
        owningPid: winner.pid,
        branch: winner.branch,
        timestamp: winner.acquiredAt,
      });
    } catch (readErr) {
      if (readErr instanceof WorktreeLockError) throw readErr;
      throw new Error(
        `Worktree lock already held for '${worktreeName}' (lock file: ${lockPath})`,
      );
    }
  }
};

/**
 * Acquires a lock for a worktree using O_EXCL atomic file creation.
 * Creates the lockDir on first use.
 *
 * When the lock file already exists:
 * - If the owning PID is alive → throws WorktreeLockError with diagnostic info
 * - If the owning PID is dead → removes stale lock and retries atomic creation
 */
export const acquire = async (
  lockDir: string,
  worktreeName: string,
  branch: string,
): Promise<void> => {
  await mkdir(lockDir, { recursive: true });
  const lockPath = join(lockDir, `${worktreeName}.lock`);

  let fd: FileHandle;
  try {
    fd = await open(lockPath, CREATE_FLAGS);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;

    // Lock file exists — read and check PID liveness
    let lockData: LockData | undefined;
    try {
      const raw = await readFile(lockPath, "utf-8");
      lockData = JSON.parse(raw) as LockData;
    } catch {
      // Corrupt or unreadable — treat as stale
    }

    if (lockData && isPidAlive(lockData.pid)) {
      throw new WorktreeLockError({
        message: `Worktree is in use by process ${lockData.pid} (branch '${lockData.branch}', acquired at ${lockData.acquiredAt})`,
        owningPid: lockData.pid,
        branch: lockData.branch,
        timestamp: lockData.acquiredAt,
      });
    }

    // Stale lock (corrupt, unreadable, or dead PID) — remove and retry
    fd = await removeStaleAndRetry(lockPath, worktreeName);
  }

  const data: LockData = {
    pid: process.pid,
    branch,
    acquiredAt: new Date().toISOString(),
  };

  try {
    await fd.writeFile(JSON.stringify(data, null, 2));
  } finally {
    await fd.close();
  }
};

/**
 * Releases a lock for a worktree by removing the lock file.
 * Idempotent: does not throw if the lock file does not exist.
 */
export const release = async (
  lockDir: string,
  worktreeName: string,
): Promise<void> => {
  const lockPath = join(lockDir, `${worktreeName}.lock`);
  try {
    await rm(lockPath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw err;
  }
};
