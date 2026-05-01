import type { ToolDefinition } from "../agent/types";

/**
 * OpenAI Function Calling Tool Schemas
 * These define the tools the agent can use during multi-step execution
 */

// Re-export for convenience - implementations are in separate files
export { filesystemTools } from "./filesystem";
export { shellTools } from "./shell";
export { gitTools } from "./git";
export { analyzerTools } from "./analyzer";
export { httpTools } from "./http";

/**
 * System tools for agent control flow
 */
export const systemTools: Omit<ToolDefinition, "execute">[] = [
  {
    name: "task_complete",
    description:
      "Mark the current task as complete. Call this when you have successfully finished the user's request. Provide a summary of what was accomplished.",
    parameters: {
      type: "object",
      properties: {
        success: {
          type: "boolean",
          description: "Whether the task was completed successfully",
        },
        summary: {
          type: "string",
          description: "A concise summary of what was accomplished",
        },
        details: {
          type: "array",
          description: "List of specific actions taken or findings",
          items: { type: "string" },
        },
      },
      required: ["success", "summary"],
    },
  },
  {
    name: "ask_user",
    description:
      "Ask the user for clarification or input when you need more information to proceed. Use this when requirements are ambiguous or you need to confirm a destructive action.",
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "The question to ask the user",
        },
        options: {
          type: "array",
          description: "Optional list of suggested answers",
          items: { type: "string" },
        },
      },
      required: ["question"],
    },
  },
  {
    name: "think",
    description:
      "Use this to reason through a complex problem step by step. Write out your thought process to plan your next actions. This helps with multi-step reasoning.",
    parameters: {
      type: "object",
      properties: {
        thought: {
          type: "string",
          description: "Your reasoning and analysis of the current situation",
        },
        plan: {
          type: "array",
          description: "List of planned next steps",
          items: { type: "string" },
        },
      },
      required: ["thought"],
    },
  },
];

/**
 * Deployment tools for various platforms
 */
export const deploymentToolSchemas: Omit<ToolDefinition, "execute">[] = [
  {
    name: "deploy_vercel",
    description:
      "Deploy the project to Vercel. Requires Vercel CLI to be installed and authenticated. Supports both preview and production deployments.",
    parameters: {
      type: "object",
      properties: {
        environment: {
          type: "string",
          enum: ["preview", "production"],
          description: "The deployment environment",
        },
        projectName: {
          type: "string",
          description: "Optional project name override",
        },
      },
      required: ["environment"],
    },
  },
  {
    name: "deploy_docker",
    description:
      "Build and deploy using Docker. Can build image, tag it, and optionally push to a registry.",
    parameters: {
      type: "object",
      properties: {
        imageName: {
          type: "string",
          description: "Name for the Docker image",
        },
        tag: {
          type: "string",
          description: "Tag for the image (default: latest)",
        },
        push: {
          type: "boolean",
          description: "Whether to push to the configured registry",
        },
        registry: {
          type: "string",
          description: "Docker registry URL (e.g., ghcr.io/username)",
        },
      },
      required: ["imageName"],
    },
  },
  {
    name: "check_deployment_status",
    description:
      "Check the status of a deployment. Can check Vercel deployments or Docker container status.",
    parameters: {
      type: "object",
      properties: {
        platform: {
          type: "string",
          enum: ["vercel", "docker"],
          description: "The platform to check",
        },
        deploymentId: {
          type: "string",
          description: "The deployment or container ID to check",
        },
      },
      required: ["platform"],
    },
  },
];
