import { constants } from "node:fs";
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

  const tryCreate = async (): Promise<
    import("node:fs/promises").FileHandle
  > => {
    return await open(
      lockPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    );
  };

  let fd;
  try {
    fd = await tryCreate();
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      // Lock file exists — check PID liveness
      let lockData: LockData;
      try {
        const raw = await readFile(lockPath, "utf-8");
        lockData = JSON.parse(raw) as LockData;
      } catch {
        // Lock file is corrupt or unreadable — treat as stale
        await rm(lockPath, { force: true });
        try {
          fd = await tryCreate();
        } catch (retryErr: unknown) {
          if ((retryErr as NodeJS.ErrnoException).code === "EEXIST") {
            throw new Error(
              `Worktree lock already held for '${worktreeName}' (lock file: ${lockPath})`,
            );
          }
          throw retryErr;
        }
        // fd acquired after stale removal — fall through to write
        lockData = undefined as unknown as LockData;
      }

      if (lockData) {
        if (isPidAlive(lockData.pid)) {
          // Active contention — throw diagnostic error
          throw new WorktreeLockError({
            message: `Worktree is in use by process ${lockData.pid} (branch '${lockData.branch}', acquired at ${lockData.acquiredAt})`,
            owningPid: lockData.pid,
            branch: lockData.branch,
            timestamp: lockData.acquiredAt,
          });
        }

        // PID is dead — remove stale lock and retry
        await rm(lockPath, { force: true });
        try {
          fd = await tryCreate();
        } catch (retryErr: unknown) {
          if ((retryErr as NodeJS.ErrnoException).code === "EEXIST") {
            // Another process raced us and won — re-read to report contention
            try {
              const raw = await readFile(lockPath, "utf-8");
              const newLock = JSON.parse(raw) as LockData;
              throw new WorktreeLockError({
                message: `Worktree is in use by process ${newLock.pid} (branch '${newLock.branch}', acquired at ${newLock.acquiredAt})`,
                owningPid: newLock.pid,
                branch: newLock.branch,
                timestamp: newLock.acquiredAt,
              });
            } catch (readErr) {
              if (readErr instanceof WorktreeLockError) throw readErr;
              throw new Error(
                `Worktree lock already held for '${worktreeName}' (lock file: ${lockPath})`,
              );
            }
          }
          throw retryErr;
        }
      }
    } else {
      throw err;
    }
  }

  const data: LockData = {
    pid: process.pid,
    branch,
    acquiredAt: new Date().toISOString(),
  };

  try {
    await fd!.writeFile(JSON.stringify(data, null, 2));
  } finally {
    await fd!.close();
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
