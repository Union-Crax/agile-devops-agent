import type { DeploymentConfig, ToolResult, AgentConfig } from "../agent/types";
import { runProcess } from "../runtime/exec";

/**
 * Vercel Platform Adapter
 *
 * Handles deployment to Vercel using the Vercel CLI.
 */

async function executeCommand(
  command: string,
  args: string[],
  cwd: string,
  timeout: number = 300000
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return runProcess(command, args, {
    cwd,
    timeoutMs: timeout,
    env: { FORCE_COLOR: "0" },
  });
}

/**
 * Check if Vercel CLI is installed and authenticated
 */
export async function checkVercelSetup(cwd: string): Promise<ToolResult> {
  // Check if vercel CLI exists
  const versionResult = await executeCommand("npx", ["vercel", "--version"], cwd);

  if (versionResult.exitCode !== 0) {
    return {
      success: false,
      output: "Vercel CLI is not installed. Install with: npm i -g vercel",
    };
  }

  // Check if authenticated
  const whoamiResult = await executeCommand("npx", ["vercel", "whoami"], cwd);

  if (whoamiResult.exitCode !== 0) {
    return {
      success: false,
      output: "Not logged in to Vercel. Run: vercel login",
    };
  }

  return {
    success: true,
    output: `Vercel CLI ${versionResult.stdout.trim()}\nLogged in as: ${whoamiResult.stdout.trim()}`,
  };
}

/**
 * Deploy to Vercel
 */
export async function deployToVercel(
  config: DeploymentConfig,
  agentConfig: AgentConfig
): Promise<ToolResult> {
  const cwd = agentConfig.workingDirectory;

  if (agentConfig.dryRun) {
    return {
      success: true,
      output: `[DRY RUN] Would deploy to Vercel (${config.environment || "preview"})`,
    };
  }

  const args = ["vercel"];

  if (config.environment === "production") {
    args.push("--prod");
  }

  if (config.projectName) {
    args.push("--name", config.projectName);
  }

  // Add --yes to skip prompts
  args.push("--yes");

  console.log(`Deploying with: npx ${args.join(" ")}`);

  const result = await executeCommand("npx", args, cwd, 600000);

  if (result.exitCode !== 0) {
    return {
      success: false,
      output: `Deployment failed:\n${result.stderr}\n${result.stdout}`,
    };
  }

  // Extract deployment URL from output
  const urlMatch = result.stdout.match(/https:\/\/[^\s]+\.vercel\.app/);
  const deploymentUrl = urlMatch ? urlMatch[0] : "URL not found in output";

  return {
    success: true,
    output: `Deployment successful!\n\nURL: ${deploymentUrl}\n\nFull output:\n${result.stdout}`,
    metadata: {
      url: deploymentUrl,
      environment: config.environment,
    },
  };
}

/**
 * Get deployment status
 */
export async function getVercelDeploymentStatus(
  deploymentUrl: string,
  cwd: string
): Promise<ToolResult> {
  // Use vercel inspect to get deployment details
  const result = await executeCommand(
    "npx",
    ["vercel", "inspect", deploymentUrl],
    cwd
  );

  if (result.exitCode !== 0) {
    return {
      success: false,
      output: `Could not get deployment status:\n${result.stderr}`,
    };
  }

  return {
    success: true,
    output: `Deployment Status:\n\n${result.stdout}`,
  };
}

/**
 * List recent Vercel deployments
 */
export async function listVercelDeployments(cwd: string): Promise<ToolResult> {
  const result = await executeCommand("npx", ["vercel", "ls", "--limit", "10"], cwd);

  if (result.exitCode !== 0) {
    return {
      success: false,
      output: `Could not list deployments:\n${result.stderr}`,
    };
  }

  return {
    success: true,
    output: `Recent Deployments:\n\n${result.stdout}`,
  };
}

/**
 * Get Vercel project environment variables
 */
export async function getVercelEnvVars(
  cwd: string,
  environment: "production" | "preview" | "development" = "production"
): Promise<ToolResult> {
  const result = await executeCommand(
    "npx",
    ["vercel", "env", "ls", environment],
    cwd
  );

  if (result.exitCode !== 0) {
    return {
      success: false,
      output: `Could not list environment variables:\n${result.stderr}`,
    };
  }

  return {
    success: true,
    output: `Environment Variables (${environment}):\n\n${result.stdout}`,
  };
}

export const vercelPlatform = {
  name: "vercel" as const,
  checkSetup: checkVercelSetup,
  deploy: deployToVercel,
  getStatus: getVercelDeploymentStatus,
  listDeployments: listVercelDeployments,
  getEnvVars: getVercelEnvVars,
};
