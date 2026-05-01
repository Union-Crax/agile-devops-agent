import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import type { ToolDefinition, ToolResult, AgentConfig } from "../agent/types";

/**
 * Shell execution tools with sandboxing and safety features
 */

// Commands that are always blocked
const BLOCKED_COMMANDS = [
  "rm -rf /",
  "rm -rf /*",
  "mkfs",
  "dd if=",
  ":(){:|:&};:",
  "chmod -R 777 /",
  "chown -R",
  "> /dev/sda",
  "mv /* /dev/null",
];

// Commands that require confirmation in non-dry-run mode
const DANGEROUS_PATTERNS = [
  /^rm\s+-rf?\s/i,
  /^sudo\s/i,
  /^chmod\s/i,
  /^chown\s/i,
  />\s*\/etc\//i,
  /\|\s*sh$/i,
  /\|\s*bash$/i,
  /curl.*\|\s*(sh|bash)/i,
];

function isCommandSafe(command: string): { safe: boolean; reason?: string } {
  // Check for absolutely blocked commands
  for (const blocked of BLOCKED_COMMANDS) {
    if (command.includes(blocked)) {
      return { safe: false, reason: `Blocked command pattern: ${blocked}` };
    }
  }

  return { safe: true };
}

function isDangerous(command: string): boolean {
  return DANGEROUS_PATTERNS.some((pattern) => pattern.test(command));
}

async function executeCommand(
  command: string,
  cwd: string,
  timeout: number = 60000
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const isWindows = process.platform === "win32";
    const shell = isWindows ? "powershell.exe" : "sh";
    const shellArgs = isWindows
      ? ["-NoProfile", "-NonInteractive", "-Command", command]
      : ["-c", command];

    const proc = spawn(shell, shellArgs, {
      cwd,
      timeout,
      windowsHide: true,
      env: { ...process.env, FORCE_COLOR: "0" },
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
        stdout: stdout.slice(0, 10000),
        stderr: stderr.slice(0, 5000),
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

async function runCommand(
  args: Record<string, unknown>,
  config: AgentConfig
): Promise<ToolResult> {
  const command = args.command as string;
  const timeout = ((args.timeout as number) || 60) * 1000;

  // Safety check
  const safetyCheck = isCommandSafe(command);
  if (!safetyCheck.safe) {
    return {
      success: false,
      output: `Command blocked for safety: ${safetyCheck.reason}`,
    };
  }

  // Dry run mode
  if (config.dryRun) {
    const dangerous = isDangerous(command) ? " [DANGEROUS]" : "";
    return {
      success: true,
      output: `[DRY RUN]${dangerous} Would execute: ${command}`,
    };
  }

  // Warn about dangerous commands
  if (isDangerous(command) && config.verbose) {
    console.warn(`⚠️  Executing potentially dangerous command: ${command}`);
  }

  const result = await executeCommand(command, config.workingDirectory, timeout);

  const output = [
    `Command: ${command}`,
    `Exit Code: ${result.exitCode}`,
    "",
    result.stdout ? `STDOUT:\n${result.stdout}` : "STDOUT: (empty)",
    result.stderr ? `STDERR:\n${result.stderr}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    success: result.exitCode === 0,
    output,
    metadata: { exitCode: result.exitCode },
  };
}

async function runTests(
  args: Record<string, unknown>,
  config: AgentConfig
): Promise<ToolResult> {
  // Detect test runner
  const testCommands = [
    { check: "vitest", cmd: "npx vitest run" },
    { check: "jest", cmd: "npx jest" },
    { check: "mocha", cmd: "npx mocha" },
    { check: "test", cmd: "npm test" },
  ];

  const testCmd = (args.command as string) || "npm test";

  if (config.dryRun) {
    return {
      success: true,
      output: `[DRY RUN] Would run tests: ${testCmd}`,
    };
  }

  const result = await executeCommand(testCmd, config.workingDirectory, 300000);

  return {
    success: result.exitCode === 0,
    output: `Test Results:\n\n${result.stdout}\n${result.stderr}`,
    metadata: {
      exitCode: result.exitCode,
      passed: result.exitCode === 0,
    },
  };
}

async function buildProject(
  args: Record<string, unknown>,
  config: AgentConfig
): Promise<ToolResult> {
  const buildCmd = (args.command as string) || "npm run build";

  if (config.dryRun) {
    return {
      success: true,
      output: `[DRY RUN] Would build project: ${buildCmd}`,
    };
  }

  const result = await executeCommand(buildCmd, config.workingDirectory, 300000);

  return {
    success: result.exitCode === 0,
    output: `Build ${result.exitCode === 0 ? "succeeded" : "failed"}:\n\n${result.stdout}\n${result.stderr}`,
    metadata: {
      exitCode: result.exitCode,
    },
  };
}

async function installDependencies(
  args: Record<string, unknown>,
  config: AgentConfig
): Promise<ToolResult> {
  const packageManager =
    (args.packageManager as string | undefined) || detectPackageManager(config.workingDirectory);
  const packages = args.packages as string[] | undefined;

  let cmd: string;
  if (packages && packages.length > 0) {
    const pkgList = packages.join(" ");
    switch (packageManager) {
      case "pnpm":
        cmd = `pnpm add ${pkgList}`;
        break;
      case "yarn":
        cmd = `yarn add ${pkgList}`;
        break;
      case "bun":
        cmd = `bun add ${pkgList}`;
        break;
      default:
        cmd = `npm install ${pkgList}`;
    }
  } else {
    switch (packageManager) {
      case "pnpm":
        cmd = "pnpm install";
        break;
      case "yarn":
        cmd = "yarn install";
        break;
      case "bun":
        cmd = "bun install";
        break;
      default:
        cmd = "npm install";
    }
  }

  if (config.dryRun) {
    return {
      success: true,
      output: `[DRY RUN] Would install dependencies: ${cmd}`,
    };
  }

  const result = await executeCommand(cmd, config.workingDirectory, 300000);

  return {
    success: result.exitCode === 0,
    output: `Dependency installation ${result.exitCode === 0 ? "succeeded" : "failed"}:\n\n${result.stdout}\n${result.stderr}`,
  };
}

function detectPackageManager(cwd: string): "npm" | "yarn" | "pnpm" | "bun" {
  const has = (filename: string) => fs.existsSync(path.join(cwd, filename));

  if (has("pnpm-lock.yaml")) return "pnpm";
  if (has("yarn.lock")) return "yarn";
  if (has("bun.lockb") || has("bun.lock")) return "bun";
  if (has("package-lock.json") || has("npm-shrinkwrap.json")) return "npm";

  const packageJsonPath = path.join(cwd, "package.json");
  if (fs.existsSync(packageJsonPath)) {
    try {
      const packageJsonRaw = fs.readFileSync(packageJsonPath, "utf-8");
      const packageJson = JSON.parse(packageJsonRaw) as { packageManager?: string };
      const declared = packageJson.packageManager?.toLowerCase() || "";
      if (declared.startsWith("pnpm@")) return "pnpm";
      if (declared.startsWith("yarn@")) return "yarn";
      if (declared.startsWith("bun@")) return "bun";
      if (declared.startsWith("npm@")) return "npm";
    } catch {
      // Ignore malformed package.json and fall through to default.
    }
  }

  return "npm";
}

export const shellTools: ToolDefinition[] = [
  {
    name: "run_command",
    description:
      "Execute a shell command. Use for running scripts, checking status, or any CLI operations. Commands are sandboxed for safety.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The shell command to execute",
        },
        timeout: {
          type: "number",
          description: "Timeout in seconds (default: 60, max: 300)",
        },
      },
      required: ["command"],
    },
    execute: runCommand,
  },
  {
    name: "run_tests",
    description:
      "Run the project's test suite. Automatically detects the test framework (Jest, Vitest, Mocha, etc.) or uses the provided command.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Custom test command (default: auto-detect)",
        },
      },
      required: [],
    },
    execute: runTests,
  },
  {
    name: "build_project",
    description:
      "Build the project. Uses the standard build command or a custom one if specified.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Custom build command (default: npm run build)",
        },
      },
      required: [],
    },
    execute: buildProject,
  },
  {
    name: "install_dependencies",
    description:
      "Install project dependencies or add new packages. Automatically detects the package manager.",
    parameters: {
      type: "object",
      properties: {
        packageManager: {
          type: "string",
          enum: ["npm", "yarn", "pnpm", "bun"],
          description: "Package manager to use (default: auto-detect)",
        },
        packages: {
          type: "array",
          description: "Specific packages to install (empty for all dependencies)",
          items: { type: "string" },
        },
      },
      required: [],
    },
    execute: installDependencies,
  },
];
