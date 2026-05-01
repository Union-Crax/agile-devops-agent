import type { DeploymentConfig, ToolResult, AgentConfig } from "../agent/types";
import { runProcess } from "../runtime/exec";

/**
 * Generic Platform Adapter
 *
 * Handles generic Git-based deployments.
 * This is for platforms that deploy when you push to a Git branch.
 */

async function executeCommand(
  command: string,
  args: string[],
  cwd: string,
  timeout: number = 120000
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return runProcess(command, args, {
    cwd,
    timeoutMs: timeout,
  });
}

/**
 * Check Git setup
 */
export async function checkGitSetup(cwd: string): Promise<ToolResult> {
  // Check if git is installed
  const versionResult = await executeCommand("git", ["--version"], cwd);

  if (versionResult.exitCode !== 0) {
    return {
      success: false,
      output: "Git is not installed or not in PATH.",
    };
  }

  // Check if we're in a git repo
  const statusResult = await executeCommand("git", ["status"], cwd);

  if (statusResult.exitCode !== 0) {
    return {
      success: false,
      output: "Not a Git repository. Initialize with: git init",
    };
  }

  // Get current branch
  const branchResult = await executeCommand(
    "git",
    ["rev-parse", "--abbrev-ref", "HEAD"],
    cwd
  );

  const branch = branchResult.stdout.trim();

  // Get remote info
  const remoteResult = await executeCommand("git", ["remote", "-v"], cwd);

  const hasRemote = remoteResult.stdout.trim().length > 0;

  return {
    success: true,
    output: [
      `Git: ${versionResult.stdout.trim()}`,
      `Branch: ${branch}`,
      `Remote configured: ${hasRemote ? "Yes" : "No"}`,
      hasRemote ? `\nRemotes:\n${remoteResult.stdout}` : "",
    ].join("\n"),
    metadata: { branch, hasRemote },
  };
}

/**
 * Deploy via Git push
 */
export async function deployViaGit(
  config: DeploymentConfig & {
    remote?: string;
    branch?: string;
    commitMessage?: string;
    addAll?: boolean;
  },
  agentConfig: AgentConfig
): Promise<ToolResult> {
  const cwd = agentConfig.workingDirectory;
  const remote = config.remote || "origin";
  const branch = config.branch || "main";
  const results: string[] = [];

  if (agentConfig.dryRun) {
    return {
      success: true,
      output: `[DRY RUN] Would deploy via Git push to ${remote}/${branch}`,
    };
  }

  // Check for uncommitted changes
  const statusResult = await executeCommand("git", ["status", "--porcelain"], cwd);
  const hasChanges = statusResult.stdout.trim().length > 0;

  if (hasChanges && config.addAll) {
    // Stage all changes
    const addResult = await executeCommand("git", ["add", "-A"], cwd);
    if (addResult.exitCode !== 0) {
      return {
        success: false,
        output: `Failed to stage changes:\n${addResult.stderr}`,
      };
    }
    results.push("Staged all changes");

    // Commit
    const commitMessage = config.commitMessage || "Deploy via agile CLI";
    const commitResult = await executeCommand(
      "git",
      ["commit", "-m", commitMessage],
      cwd
    );
    if (commitResult.exitCode !== 0) {
      return {
        success: false,
        output: `Failed to commit:\n${commitResult.stderr}`,
      };
    }
    results.push(`Committed: ${commitMessage}`);
  } else if (hasChanges) {
    results.push("Warning: Uncommitted changes detected but not staged");
  }

  // Push
  console.log(`Pushing to ${remote}/${branch}...`);
  const pushResult = await executeCommand(
    "git",
    ["push", remote, branch],
    cwd,
    120000
  );

  if (pushResult.exitCode !== 0) {
    return {
      success: false,
      output: `Push failed:\n${pushResult.stderr}\n${pushResult.stdout}`,
    };
  }

  results.push(`Pushed to ${remote}/${branch}`);

  return {
    success: true,
    output: `Git deployment complete!\n\n${results.join("\n")}\n\n${pushResult.stdout}${pushResult.stderr}`,
    metadata: { remote, branch },
  };
}

/**
 * Create a deployment tag
 */
export async function createDeploymentTag(
  tagName: string,
  message: string,
  agentConfig: AgentConfig
): Promise<ToolResult> {
  const cwd = agentConfig.workingDirectory;

  if (agentConfig.dryRun) {
    return {
      success: true,
      output: `[DRY RUN] Would create tag: ${tagName}`,
    };
  }

  // Create annotated tag
  const tagResult = await executeCommand(
    "git",
    ["tag", "-a", tagName, "-m", message],
    cwd
  );

  if (tagResult.exitCode !== 0) {
    return {
      success: false,
      output: `Failed to create tag:\n${tagResult.stderr}`,
    };
  }

  // Push tag
  const pushResult = await executeCommand(
    "git",
    ["push", "origin", tagName],
    cwd
  );

  if (pushResult.exitCode !== 0) {
    return {
      success: false,
      output: `Failed to push tag:\n${pushResult.stderr}`,
    };
  }

  return {
    success: true,
    output: `Created and pushed tag: ${tagName}\n\n${pushResult.stdout}`,
    metadata: { tag: tagName },
  };
}

/**
 * Get deployment history from Git tags
 */
export async function getDeploymentHistory(cwd: string): Promise<ToolResult> {
  const result = await executeCommand(
    "git",
    ["tag", "-l", "--sort=-creatordate", "-n1"],
    cwd
  );

  if (result.exitCode !== 0) {
    return {
      success: false,
      output: `Could not get tags:\n${result.stderr}`,
    };
  }

  if (!result.stdout.trim()) {
    return {
      success: true,
      output: "No deployment tags found.",
    };
  }

  return {
    success: true,
    output: `Deployment History (from tags):\n\n${result.stdout}`,
  };
}

/**
 * Rollback to a previous deployment
 */
export async function rollbackDeployment(
  target: string, // tag name or commit hash
  agentConfig: AgentConfig
): Promise<ToolResult> {
  const cwd = agentConfig.workingDirectory;

  if (agentConfig.dryRun) {
    return {
      success: true,
      output: `[DRY RUN] Would rollback to: ${target}`,
    };
  }

  // Get current branch
  const branchResult = await executeCommand(
    "git",
    ["rev-parse", "--abbrev-ref", "HEAD"],
    cwd
  );
  const currentBranch = branchResult.stdout.trim();

  // Reset to target
  const resetResult = await executeCommand(
    "git",
    ["reset", "--hard", target],
    cwd
  );

  if (resetResult.exitCode !== 0) {
    return {
      success: false,
      output: `Failed to reset to ${target}:\n${resetResult.stderr}`,
    };
  }

  // Force push
  const pushResult = await executeCommand(
    "git",
    ["push", "origin", currentBranch, "--force"],
    cwd
  );

  if (pushResult.exitCode !== 0) {
    return {
      success: false,
      output: `Failed to force push:\n${pushResult.stderr}`,
    };
  }

  return {
    success: true,
    output: `Rolled back to ${target} and force pushed to ${currentBranch}`,
    metadata: { target, branch: currentBranch },
  };
}

export const genericPlatform = {
  name: "generic" as const,
  checkSetup: checkGitSetup,
  deploy: deployViaGit,
  createTag: createDeploymentTag,
  getHistory: getDeploymentHistory,
  rollback: rollbackDeployment,
};
