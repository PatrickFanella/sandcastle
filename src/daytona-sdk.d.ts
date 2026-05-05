/** Minimal type declarations for @daytona/sdk (optional peer dependency). */
declare module "@daytona/sdk" {
  export interface DaytonaConfig {
    apiKey?: string;
    apiUrl?: string;
    target?: string;
  }

  export type CreateSandboxFromImageParams = Record<string, unknown>;
  export type CreateSandboxFromSnapshotParams = Record<string, unknown>;

  interface DaytonaProcess {
    createSession(sessionId: string): Promise<void>;
    executeSessionCommand(
      sessionId: string,
      options: { command: string; async?: boolean },
    ): Promise<{ cmdId?: string }>;
    getSessionCommandLogs(
      sessionId: string,
      cmdId: string,
      onStdout: (chunk: string) => void,
      onStderr: (chunk: string) => void,
    ): Promise<void>;
    getSessionCommand(
      sessionId: string,
      cmdId: string,
    ): Promise<{ exitCode?: number }>;
    deleteSession(sessionId: string): Promise<void>;
    executeCommand(
      command: string,
      cwd?: string,
    ): Promise<{ result: string; exitCode: number }>;
  }

  interface DaytonaFs {
    uploadFile(hostPath: string, sandboxPath: string): Promise<void>;
    downloadFile(sandboxPath: string, hostPath: string): Promise<void>;
  }

  interface DaytonaSandbox {
    getWorkDir(): Promise<string | undefined | null>;
    getUserHomeDir(): Promise<string | undefined | null>;
    process: DaytonaProcess;
    fs: DaytonaFs;
  }

  export class Daytona {
    constructor(config?: DaytonaConfig);
    create(
      params?: CreateSandboxFromImageParams | CreateSandboxFromSnapshotParams,
    ): Promise<DaytonaSandbox>;
    delete(sandbox: DaytonaSandbox): Promise<void>;
  }
}
