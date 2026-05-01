import * as fs from "fs/promises";
import * as path from "path";
import type { DeploymentConfig, ToolResult, AgentConfig } from "../agent/types";
import { runProcess } from "../runtime/exec";

/**
 * Docker Platform Adapter
 *
 * Handles building and deploying Docker containers.
 */

async function executeCommand(
  command: string,
  args: string[],
  cwd: string,
  timeout: number = 600000
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return runProcess(command, args, {
    cwd,
    timeoutMs: timeout,
  });
}

/**
 * Check if Docker is installed and running
 */
export async function checkDockerSetup(cwd: string): Promise<ToolResult> {
  // Check if docker CLI exists
  const versionResult = await executeCommand("docker", ["--version"], cwd);

  if (versionResult.exitCode !== 0) {
    return {
      success: false,
      output: "Docker is not installed or not in PATH.",
    };
  }

  // Check if Docker daemon is running
  const infoResult = await executeCommand("docker", ["info"], cwd);

  if (infoResult.exitCode !== 0) {
    return {
      success: false,
      output: "Docker daemon is not running. Start Docker Desktop or the Docker service.",
    };
  }

  // Check for Dockerfile
  let hasDockerfile = false;
  try {
    await fs.access(path.join(cwd, "Dockerfile"));
    hasDockerfile = true;
  } catch {
    // No Dockerfile
  }

  return {
    success: true,
    output: [
      `Docker: ${versionResult.stdout.trim()}`,
      `Dockerfile: ${hasDockerfile ? "Found" : "Not found"}`,
    ].join("\n"),
    metadata: { hasDockerfile },
  };
}

/**
 * Build a Docker image
 */
export async function buildDockerImage(
  imageName: string,
  tag: string = "latest",
  agentConfig: AgentConfig
): Promise<ToolResult> {
  const cwd = agentConfig.workingDirectory;
  const fullTag = `${imageName}:${tag}`;

  if (agentConfig.dryRun) {
    return {
      success: true,
      output: `[DRY RUN] Would build Docker image: ${fullTag}`,
    };
  }

  console.log(`Building Docker image: ${fullTag}`);

  const result = await executeCommand(
    "docker",
    ["build", "-t", fullTag, "."],
    cwd,
    900000 // 15 minute timeout for builds
  );

  if (result.exitCode !== 0) {
    return {
      success: false,
      output: `Docker build failed:\n${result.stderr}\n${result.stdout}`,
    };
  }

  return {
    success: true,
    output: `Successfully built image: ${fullTag}\n\n${result.stdout.slice(-1000)}`,
    metadata: { image: fullTag },
  };
}

/**
 * Push a Docker image to a registry
 */
export async function pushDockerImage(
  imageName: string,
  tag: string = "latest",
  registry: string,
  agentConfig: AgentConfig
): Promise<ToolResult> {
  const fullTag = registry ? `${registry}/${imageName}:${tag}` : `${imageName}:${tag}`;

  if (agentConfig.dryRun) {
    return {
      success: true,
      output: `[DRY RUN] Would push Docker image: ${fullTag}`,
    };
  }

  // First tag the image with the registry prefix if needed
  if (registry) {
    const tagResult = await executeCommand(
      "docker",
      ["tag", `${imageName}:${tag}`, fullTag],
      agentConfig.workingDirectory
    );

    if (tagResult.exitCode !== 0) {
      return {
        success: false,
        output: `Failed to tag image:\n${tagResult.stderr}`,
      };
    }
  }

  console.log(`Pushing Docker image: ${fullTag}`);

  const result = await executeCommand(
    "docker",
    ["push", fullTag],
    agentConfig.workingDirectory,
    600000
  );

  if (result.exitCode !== 0) {
    return {
      success: false,
      output: `Docker push failed:\n${result.stderr}\n${result.stdout}`,
    };
  }

  return {
    success: true,
    output: `Successfully pushed image: ${fullTag}\n\n${result.stdout}`,
    metadata: { image: fullTag, registry },
  };
}

/**
 * Run a Docker container
 */
export async function runDockerContainer(
  imageName: string,
  tag: string = "latest",
  options: {
    port?: string;
    detach?: boolean;
    name?: string;
    envVars?: Record<string, string>;
  },
  agentConfig: AgentConfig
): Promise<ToolResult> {
  const fullTag = `${imageName}:${tag}`;

  if (agentConfig.dryRun) {
    return {
      success: true,
      output: `[DRY RUN] Would run Docker container: ${fullTag}`,
    };
  }

  const args = ["run"];

  if (options.detach) {
    args.push("-d");
  }

  if (options.name) {
    args.push("--name", options.name);
  }

  if (options.port) {
    args.push("-p", options.port);
  }

  if (options.envVars) {
    for (const [key, value] of Object.entries(options.envVars)) {
      args.push("-e", `${key}=${value}`);
    }
  }

  args.push(fullTag);

  console.log(`Running: docker ${args.join(" ")}`);

  const result = await executeCommand(
    "docker",
    args,
    agentConfig.workingDirectory,
    60000
  );

  if (result.exitCode !== 0) {
    return {
      success: false,
      output: `Failed to run container:\n${result.stderr}\n${result.stdout}`,
    };
  }

  const containerId = result.stdout.trim().slice(0, 12);

  return {
    success: true,
    output: `Container started: ${containerId}\n\n${result.stdout}`,
    metadata: { containerId },
  };
}

/**
 * List running Docker containers
 */
export async function listDockerContainers(cwd: string): Promise<ToolResult> {
  const result = await executeCommand(
    "docker",
    ["ps", "--format", "table {{.ID}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}"],
    cwd
  );

  if (result.exitCode !== 0) {
    return {
      success: false,
      output: `Could not list containers:\n${result.stderr}`,
    };
  }

  return {
    success: true,
    output: `Running Containers:\n\n${result.stdout}`,
  };
}

/**
 * Get Docker container logs
 */
export async function getDockerLogs(
  containerId: string,
  cwd: string,
  tail: number = 100
): Promise<ToolResult> {
  const result = await executeCommand(
    "docker",
    ["logs", "--tail", tail.toString(), containerId],
    cwd
  );

  if (result.exitCode !== 0) {
    return {
      success: false,
      output: `Could not get logs:\n${result.stderr}`,
    };
  }

  return {
    success: true,
    output: `Container Logs (${containerId}):\n\n${result.stdout}${result.stderr}`,
  };
}

/**
 * Stop a Docker container
 */
export async function stopDockerContainer(
  containerId: string,
  cwd: string
): Promise<ToolResult> {
  const result = await executeCommand("docker", ["stop", containerId], cwd);

  if (result.exitCode !== 0) {
    return {
      success: false,
      output: `Could not stop container:\n${result.stderr}`,
    };
  }

  return {
    success: true,
    output: `Container stopped: ${containerId}`,
  };
}

/**
 * Full deploy workflow: build, optionally push, optionally run
 */
export async function deployDocker(
  config: DeploymentConfig & {
    imageName: string;
    tag?: string;
    push?: boolean;
    registry?: string;
    run?: boolean;
    port?: string;
  },
  agentConfig: AgentConfig
): Promise<ToolResult> {
  const results: string[] = [];

  // Build
  const buildResult = await buildDockerImage(
    config.imageName,
    config.tag || "latest",
    agentConfig
  );

  results.push(`BUILD: ${buildResult.success ? "SUCCESS" : "FAILED"}`);
  if (!buildResult.success) {
    return {
      success: false,
      output: `Deployment failed at build step:\n${buildResult.output}`,
    };
  }

  // Push (optional)
  if (config.push && config.registry) {
    const pushResult = await pushDockerImage(
      config.imageName,
      config.tag || "latest",
      config.registry,
      agentConfig
    );

    results.push(`PUSH: ${pushResult.success ? "SUCCESS" : "FAILED"}`);
    if (!pushResult.success) {
      return {
        success: false,
        output: `Deployment failed at push step:\n${pushResult.output}`,
      };
    }
  }

  // Run (optional)
  if (config.run) {
    const runResult = await runDockerContainer(
      config.imageName,
      config.tag || "latest",
      {
        port: config.port,
        detach: true,
        name: config.projectName,
      },
      agentConfig
    );

    results.push(`RUN: ${runResult.success ? "SUCCESS" : "FAILED"}`);
    if (!runResult.success) {
      return {
        success: false,
        output: `Deployment failed at run step:\n${runResult.output}`,
      };
    }
  }

  return {
    success: true,
    output: `Docker deployment complete!\n\n${results.join("\n")}`,
    metadata: {
      image: `${config.imageName}:${config.tag || "latest"}`,
    },
  };
}

export const dockerPlatform = {
  name: "docker" as const,
  checkSetup: checkDockerSetup,
  build: buildDockerImage,
  push: pushDockerImage,
  run: runDockerContainer,
  deploy: deployDocker,
  listContainers: listDockerContainers,
  getLogs: getDockerLogs,
  stop: stopDockerContainer,
};
