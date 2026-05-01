import type { ToolDefinition, ToolResult, AgentConfig } from "../agent/types";
import { runProcess } from "../runtime/exec";

/**
 * Git tools for version control operations
 */

async function executeGit(
  args: string[],
  cwd: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return runProcess("git", args, {
    cwd,
    timeoutMs: 30000,
  });
}

async function gitStatus(
  _args: Record<string, unknown>,
  config: AgentConfig
): Promise<ToolResult> {
  const result = await executeGit(["status", "--porcelain", "-b"], config.workingDirectory);

  if (result.exitCode !== 0) {
    return {
      success: false,
      output: `Git status failed: ${result.stderr}`,
    };
  }

  const lines = result.stdout.trim().split("\n");
  const branchLine = lines[0] || "";
  const changes = lines.slice(1).filter(Boolean);

  const branch = branchLine.replace("## ", "").split("...")[0];
  const staged = changes.filter((l) => l[0] !== " " && l[0] !== "?").length;
  const unstaged = changes.filter((l) => l[1] !== " " && l[0] !== "?").length;
  const untracked = changes.filter((l) => l.startsWith("??")).length;

  return {
    success: true,
    output: [
      `Branch: ${branch}`,
      `Staged: ${staged} files`,
      `Unstaged: ${unstaged} files`,
      `Untracked: ${untracked} files`,
      "",
      "Changes:",
      ...changes.map((c) => `  ${c}`),
    ].join("\n"),
    metadata: { branch, staged, unstaged, untracked },
  };
}

async function gitDiff(
  args: Record<string, unknown>,
  config: AgentConfig
): Promise<ToolResult> {
  const staged = args.staged as boolean;
  const file = args.file as string | undefined;

  const gitArgs = ["diff"];
  if (staged) gitArgs.push("--staged");
  if (file) gitArgs.push("--", file);

  const result = await executeGit(gitArgs, config.workingDirectory);

  if (result.exitCode !== 0) {
    return {
      success: false,
      output: `Git diff failed: ${result.stderr}`,
    };
  }

  const diff = result.stdout.trim();
  if (!diff) {
    return {
      success: true,
      output: "No changes to display",
    };
  }

  // Truncate very long diffs
  const maxLength = 5000;
  const truncatedDiff =
    diff.length > maxLength
      ? diff.slice(0, maxLength) + "\n\n... (truncated, diff too long)"
      : diff;

  return {
    success: true,
    output: truncatedDiff,
  };
}

async function gitLog(
  args: Record<string, unknown>,
  config: AgentConfig
): Promise<ToolResult> {
  const count = (args.count as number) || 10;
  const oneline = args.oneline !== false;

  const gitArgs = [
    "log",
    `-${count}`,
    oneline ? "--oneline" : "--format=%h %s (%an, %ar)",
  ];

  const result = await executeGit(gitArgs, config.workingDirectory);

  if (result.exitCode !== 0) {
    return {
      success: false,
      output: `Git log failed: ${result.stderr}`,
    };
  }

  return {
    success: true,
    output: `Recent commits:\n\n${result.stdout}`,
  };
}

async function gitCommit(
  args: Record<string, unknown>,
  config: AgentConfig
): Promise<ToolResult> {
  const message = args.message as string;
  const addAll = args.addAll as boolean;

  if (config.dryRun) {
    return {
      success: true,
      output: `[DRY RUN] Would commit${addAll ? " (with -a)" : ""}: ${message}`,
    };
  }

  // First add if requested
  if (addAll) {
    const addResult = await executeGit(["add", "-A"], config.workingDirectory);
    if (addResult.exitCode !== 0) {
      return {
        success: false,
        output: `Git add failed: ${addResult.stderr}`,
      };
    }
  }

  const result = await executeGit(
    ["commit", "-m", message],
    config.workingDirectory
  );

  if (result.exitCode !== 0) {
    return {
      success: false,
      output: `Git commit failed: ${result.stderr}`,
    };
  }

  return {
    success: true,
    output: `Committed: ${message}\n\n${result.stdout}`,
  };
}

async function gitPush(
  args: Record<string, unknown>,
  config: AgentConfig
): Promise<ToolResult> {
  const remote = (args.remote as string) || "origin";
  const branch = args.branch as string | undefined;
  const force = args.force as boolean;

  if (config.dryRun) {
    return {
      success: true,
      output: `[DRY RUN] Would push to ${remote}${branch ? `/${branch}` : ""}${force ? " (force)" : ""}`,
    };
  }

  const gitArgs = ["push", remote];
  if (branch) gitArgs.push(branch);
  if (force) gitArgs.push("--force");

  const result = await executeGit(gitArgs, config.workingDirectory);

  if (result.exitCode !== 0) {
    return {
      success: false,
      output: `Git push failed: ${result.stderr}`,
    };
  }

  return {
    success: true,
    output: `Pushed successfully:\n${result.stdout}${result.stderr}`,
  };
}

async function gitBranch(
  args: Record<string, unknown>,
  config: AgentConfig
): Promise<ToolResult> {
  const action = (args.action as string) || "list";
  const name = args.name as string | undefined;

  let gitArgs: string[];

  switch (action) {
    case "create":
      if (!name) {
        return { success: false, output: "Branch name required for create" };
      }
      if (config.dryRun) {
        return { success: true, output: `[DRY RUN] Would create branch: ${name}` };
      }
      gitArgs = ["checkout", "-b", name];
      break;
    case "switch":
      if (!name) {
        return { success: false, output: "Branch name required for switch" };
      }
      if (config.dryRun) {
        return { success: true, output: `[DRY RUN] Would switch to branch: ${name}` };
      }
      gitArgs = ["checkout", name];
      break;
    case "delete":
      if (!name) {
        return { success: false, output: "Branch name required for delete" };
      }
      if (config.dryRun) {
        return { success: true, output: `[DRY RUN] Would delete branch: ${name}` };
      }
      gitArgs = ["branch", "-d", name];
      break;
    default:
      gitArgs = ["branch", "-a"];
  }

  const result = await executeGit(gitArgs, config.workingDirectory);

  if (result.exitCode !== 0) {
    return {
      success: false,
      output: `Git branch operation failed: ${result.stderr}`,
    };
  }

  return {
    success: true,
    output: result.stdout || "Operation completed",
  };
}

export const gitTools: ToolDefinition[] = [
  {
    name: "git_status",
    description:
      "Get the current Git status including branch, staged/unstaged changes, and untracked files.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
    execute: gitStatus,
  },
  {
    name: "git_diff",
    description:
      "Show the diff of changes. Can show staged changes, unstaged changes, or changes to a specific file.",
    parameters: {
      type: "object",
      properties: {
        staged: {
          type: "boolean",
          description: "Show staged changes only",
        },
        file: {
          type: "string",
          description: "Specific file to diff",
        },
      },
      required: [],
    },
    execute: gitDiff,
  },
  {
    name: "git_log",
    description: "Show recent commit history.",
    parameters: {
      type: "object",
      properties: {
        count: {
          type: "number",
          description: "Number of commits to show (default: 10)",
        },
        oneline: {
          type: "boolean",
          description: "Use oneline format (default: true)",
        },
      },
      required: [],
    },
    execute: gitLog,
  },
  {
    name: "git_commit",
    description: "Create a new commit with the specified message.",
    parameters: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description: "Commit message",
        },
        addAll: {
          type: "boolean",
          description: "Stage all changes before committing (git add -A)",
        },
      },
      required: ["message"],
    },
    execute: gitCommit,
  },
  {
    name: "git_push",
    description: "Push commits to a remote repository.",
    parameters: {
      type: "object",
      properties: {
        remote: {
          type: "string",
          description: "Remote name (default: origin)",
        },
        branch: {
          type: "string",
          description: "Branch to push (default: current branch)",
        },
        force: {
          type: "boolean",
          description: "Force push (use with caution)",
        },
      },
      required: [],
    },
    execute: gitPush,
  },
  {
    name: "git_branch",
    description: "List, create, switch, or delete branches.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "create", "switch", "delete"],
          description: "Branch action to perform (default: list)",
        },
        name: {
          type: "string",
          description: "Branch name (required for create/switch/delete)",
        },
      },
      required: [],
    },
    execute: gitBranch,
  },
];
