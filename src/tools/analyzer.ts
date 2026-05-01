import * as fs from "fs/promises";
import * as path from "path";
import type { ToolDefinition, ToolResult, AgentConfig } from "../agent/types";
import { runProcess } from "../runtime/exec";

/**
 * Code analysis tools for quality, security, and dependency checks
 */

async function executeCommand(
  command: string,
  args: string[],
  cwd: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return runProcess(command, args, {
    cwd,
    timeoutMs: 60000,
  });
}

async function analyzeProject(
  _args: Record<string, unknown>,
  config: AgentConfig
): Promise<ToolResult> {
  const cwd = config.workingDirectory;
  const findings: string[] = [];

  // Check for package.json
  let packageJson: Record<string, unknown> | null = null;
  try {
    const content = await fs.readFile(path.join(cwd, "package.json"), "utf-8");
    packageJson = JSON.parse(content);
    findings.push("Found package.json");

    // Check for scripts
    const scripts = ((packageJson?.scripts as Record<string, string>) || {});
    if (scripts.test) findings.push("Has test script");
    if (scripts.build) findings.push("Has build script");
    if (scripts.lint) findings.push("Has lint script");
  } catch {
    findings.push("No package.json found");
  }

  // Check for TypeScript
  try {
    await fs.access(path.join(cwd, "tsconfig.json"));
    findings.push("TypeScript project (tsconfig.json found)");
  } catch {
    // Not a TypeScript project
  }

  // Check for common config files
  const configFiles = [
    { file: ".eslintrc.json", name: "ESLint config" },
    { file: "eslint.config.js", name: "ESLint flat config" },
    { file: ".prettierrc", name: "Prettier config" },
    { file: "vercel.json", name: "Vercel config" },
    { file: "Dockerfile", name: "Dockerfile" },
    { file: "docker-compose.yml", name: "Docker Compose" },
    { file: ".github/workflows", name: "GitHub Actions" },
    { file: "next.config.js", name: "Next.js config" },
    { file: "next.config.mjs", name: "Next.js config (ESM)" },
    { file: "vite.config.ts", name: "Vite config" },
  ];

  for (const { file, name } of configFiles) {
    try {
      await fs.access(path.join(cwd, file));
      findings.push(`${name} found`);
    } catch {
      // File doesn't exist
    }
  }

  // Detect framework
  if (packageJson) {
    const deps = {
      ...((packageJson.dependencies as Record<string, string>) || {}),
      ...((packageJson.devDependencies as Record<string, string>) || {}),
    };

    if (deps.next) findings.push("Framework: Next.js");
    else if (deps.react) findings.push("Framework: React");
    else if (deps.vue) findings.push("Framework: Vue");
    else if (deps.svelte) findings.push("Framework: Svelte");
    else if (deps.express) findings.push("Framework: Express");
    else if (deps.fastify) findings.push("Framework: Fastify");
  }

  return {
    success: true,
    output: `Project Analysis:\n\n${findings.map((f) => `- ${f}`).join("\n")}`,
    metadata: { findings },
  };
}

async function checkDependencies(
  args: Record<string, unknown>,
  config: AgentConfig
): Promise<ToolResult> {
  const cwd = config.workingDirectory;

  // Try npm outdated first
  const result = await executeCommand("npm", ["outdated", "--json"], cwd);

  if (result.exitCode !== 0 && !result.stdout) {
    // No outdated packages or error
    if (result.stderr.includes("ELOCKVERIFY")) {
      return {
        success: false,
        output: "Lock file mismatch. Run npm install first.",
      };
    }
  }

  let outdated: Record<
    string,
    { current: string; wanted: string; latest: string }
  > = {};

  if (result.stdout) {
    try {
      outdated = JSON.parse(result.stdout);
    } catch {
      // JSON parse error
    }
  }

  if (Object.keys(outdated).length === 0) {
    return {
      success: true,
      output: "All dependencies are up to date!",
      metadata: { outdated: [] },
    };
  }

  const outdatedList = Object.entries(outdated).map(([pkg, info]) => ({
    name: pkg,
    current: info.current,
    wanted: info.wanted,
    latest: info.latest,
  }));

  const output = [
    "Outdated Dependencies:",
    "",
    "| Package | Current | Wanted | Latest |",
    "|---------|---------|--------|--------|",
    ...outdatedList.map(
      (p) => `| ${p.name} | ${p.current} | ${p.wanted} | ${p.latest} |`
    ),
  ].join("\n");

  return {
    success: true,
    output,
    metadata: { outdated: outdatedList },
  };
}

async function auditDependencies(
  _args: Record<string, unknown>,
  config: AgentConfig
): Promise<ToolResult> {
  const cwd = config.workingDirectory;

  const result = await executeCommand("npm", ["audit", "--json"], cwd);

  let auditData: {
    metadata?: { vulnerabilities: Record<string, number> };
    vulnerabilities?: Record<string, { severity: string; via: unknown[] }>;
  } = {};

  if (result.stdout) {
    try {
      auditData = JSON.parse(result.stdout);
    } catch {
      // JSON parse error
    }
  }

  const vulnCounts = auditData.metadata?.vulnerabilities || {};
  const total = Object.values(vulnCounts).reduce(
    (sum: number, count: number) => sum + count,
    0
  );

  if (total === 0) {
    return {
      success: true,
      output: "No security vulnerabilities found!",
      metadata: { vulnerabilities: 0 },
    };
  }

  const output = [
    "Security Audit Results:",
    "",
    `Total vulnerabilities: ${total}`,
    "",
    ...Object.entries(vulnCounts)
      .filter(([, count]) => count > 0)
      .map(([severity, count]) => `- ${severity}: ${count}`),
    "",
    "Run 'npm audit' for full details or 'npm audit fix' to attempt auto-fix.",
  ].join("\n");

  return {
    success: vulnCounts.critical === 0 && vulnCounts.high === 0,
    output,
    metadata: { vulnerabilities: total, breakdown: vulnCounts },
  };
}

async function runLinter(
  args: Record<string, unknown>,
  config: AgentConfig
): Promise<ToolResult> {
  const cwd = config.workingDirectory;
  const fix = args.fix as boolean;

  // Try to detect the linter
  let linterCommand: string[] = [];

  try {
    const pkgContent = await fs.readFile(path.join(cwd, "package.json"), "utf-8");
    const pkg = JSON.parse(pkgContent);
    const scripts = pkg.scripts || {};

    if (scripts.lint) {
      linterCommand = ["npm", "run", "lint"];
    }
  } catch {
    // No package.json
  }

  if (linterCommand.length === 0) {
    // Default to trying eslint directly
    linterCommand = ["npx", "eslint", ".", "--ext", ".js,.jsx,.ts,.tsx"];
  }

  if (fix && linterCommand[0] === "npx") {
    linterCommand.push("--fix");
  }

  if (config.dryRun) {
    return {
      success: true,
      output: `[DRY RUN] Would run: ${linterCommand.join(" ")}`,
    };
  }

  const result = await executeCommand(linterCommand[0], linterCommand.slice(1), cwd);

  return {
    success: result.exitCode === 0,
    output: `Linter Results:\n\n${result.stdout}${result.stderr}`,
    metadata: { exitCode: result.exitCode },
  };
}

async function analyzeCodeQuality(
  args: Record<string, unknown>,
  config: AgentConfig
): Promise<ToolResult> {
  const cwd = config.workingDirectory;
  const targetPath = (args.path as string) || ".";
  const issues: { type: string; message: string; file?: string }[] = [];

  // Simple code quality checks by reading files
  const { glob } = await import("glob");
  const files = await glob("**/*.{ts,tsx,js,jsx}", {
    cwd,
    ignore: ["**/node_modules/**", "**/dist/**", "**/.next/**"],
  });

  for (const file of files.slice(0, 50)) {
    try {
      const content = await fs.readFile(path.join(cwd, file), "utf-8");
      const lines = content.split("\n");

      // Check for common issues
      lines.forEach((line, index) => {
        // Console.log in non-dev files
        if (
          line.includes("console.log") &&
          !file.includes("test") &&
          !file.includes("spec")
        ) {
          issues.push({
            type: "warning",
            message: `console.log found at line ${index + 1}`,
            file,
          });
        }

        // TODO comments
        if (line.includes("TODO") || line.includes("FIXME")) {
          issues.push({
            type: "info",
            message: `TODO/FIXME at line ${index + 1}`,
            file,
          });
        }

        // Very long lines
        if (line.length > 200) {
          issues.push({
            type: "warning",
            message: `Line ${index + 1} exceeds 200 characters`,
            file,
          });
        }
      });

      // Very large files
      if (lines.length > 500) {
        issues.push({
          type: "warning",
          message: `File has ${lines.length} lines (consider splitting)`,
          file,
        });
      }
    } catch {
      // Skip files that can't be read
    }
  }

  if (issues.length === 0) {
    return {
      success: true,
      output: "Code quality check passed. No issues found!",
    };
  }

  const grouped = {
    warning: issues.filter((i) => i.type === "warning"),
    info: issues.filter((i) => i.type === "info"),
  };

  const output = [
    "Code Quality Analysis:",
    "",
    `Warnings: ${grouped.warning.length}`,
    `Info: ${grouped.info.length}`,
    "",
    ...issues.slice(0, 30).map((i) => `[${i.type.toUpperCase()}] ${i.file}: ${i.message}`),
    issues.length > 30 ? `\n... and ${issues.length - 30} more issues` : "",
  ].join("\n");

  return {
    success: true,
    output,
    metadata: { issues: issues.length },
  };
}

export const analyzerTools: ToolDefinition[] = [
  {
    name: "analyze_project",
    description:
      "Analyze the project structure and configuration. Detects framework, build tools, test setup, and other project characteristics.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
    execute: analyzeProject,
  },
  {
    name: "check_dependencies",
    description:
      "Check for outdated dependencies in the project. Shows current version, wanted version, and latest version.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
    execute: checkDependencies,
  },
  {
    name: "audit_dependencies",
    description:
      "Run a security audit on project dependencies. Identifies known vulnerabilities in packages.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
    execute: auditDependencies,
  },
  {
    name: "run_linter",
    description:
      "Run the project's linter to check for code style issues. Can optionally auto-fix issues.",
    parameters: {
      type: "object",
      properties: {
        fix: {
          type: "boolean",
          description: "Attempt to auto-fix issues (default: false)",
        },
      },
      required: [],
    },
    execute: runLinter,
  },
  {
    name: "analyze_code_quality",
    description:
      "Perform a code quality analysis looking for common issues like console.logs, TODO comments, long lines, and large files.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to analyze (default: entire project)",
        },
      },
      required: [],
    },
    execute: analyzeCodeQuality,
  },
];
