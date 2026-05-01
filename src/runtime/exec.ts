import { spawn } from "child_process";

export interface ExecOptions {
  cwd: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  maxStdoutChars?: number;
  maxStderrChars?: number;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const WINDOWS_CMD_SHIMS = new Set(["npm", "npx", "pnpm", "yarn", "bun", "tsx"]);

function resolveExecutable(command: string): string {
  if (process.platform !== "win32") {
    return command;
  }

  const hasExtension = /\.[a-z0-9]+$/i.test(command);
  if (hasExtension) {
    return command;
  }

  const lower = command.toLowerCase();
  if (WINDOWS_CMD_SHIMS.has(lower)) {
    return `${command}.cmd`;
  }

  return command;
}

function truncate(text: string, maxChars?: number): string {
  if (!maxChars || maxChars <= 0 || text.length <= maxChars) {
    return text;
  }
  return text.slice(0, maxChars);
}

export async function runProcess(
  command: string,
  args: string[],
  options: ExecOptions,
): Promise<ExecResult> {
  const executable = resolveExecutable(command);
  const timeoutMs = options.timeoutMs ?? 60000;

  return new Promise((resolve) => {
    const proc = spawn(executable, args, {
      cwd: options.cwd,
      timeout: timeoutMs,
      env: { ...process.env, ...(options.env || {}) },
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout?.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      resolve({
        stdout: truncate(stdout, options.maxStdoutChars),
        stderr: truncate(stderr, options.maxStderrChars),
        exitCode: code ?? 1,
      });
    });

    proc.on("error", (err) => {
      resolve({
        stdout: "",
        stderr: err.message,
        exitCode: 1,
      });
    });
  });
}