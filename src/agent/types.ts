import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";

/**
 * Core types for the multi-step DevOps agent
 */

export interface AgentConfig {
  model: string;
  maxSteps: number;
  verbose: boolean;
  dryRun: boolean;
  workingDirectory: string;
  platform?: "vercel" | "docker" | "generic";
}

export interface AgentState {
  taskDescription: string;
  conversationHistory: ChatCompletionMessageParam[];
  stepCount: number;
  isComplete: boolean;
  result?: TaskResult;
  memory: AgentMemory;
}

export interface AgentMemory {
  codebaseContext: CodebaseContext;
  previousActions: ActionRecord[];
  discoveries: string[];
}

export interface CodebaseContext {
  rootPath: string;
  packageManager?: "npm" | "yarn" | "pnpm" | "bun";
  framework?: string;
  hasTests: boolean;
  hasDocker: boolean;
  hasVercelConfig: boolean;
  dependencies: Record<string, string>;
}

export interface ActionRecord {
  tool: string;
  input: Record<string, unknown>;
  output: string;
  timestamp: Date;
  success: boolean;
}

export interface TaskResult {
  success: boolean;
  summary: string;
  details: string[];
  artifacts?: string[];
  errors?: string[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, ToolParameter>;
    required: string[];
  };
  execute: (args: Record<string, unknown>, config: AgentConfig) => Promise<ToolResult>;
}

export interface ToolParameter {
  type: string;
  description: string;
  enum?: string[];
  items?: { type: string };
}

export interface ToolResult {
  success: boolean;
  output: string;
  metadata?: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * Convert our tool definitions to OpenAI format
 */
export function toOpenAITools(tools: ToolDefinition[]): ChatCompletionTool[] {
  return tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

/**
 * Platform-specific deployment configuration
 */
export interface DeploymentConfig {
  platform: "vercel" | "docker" | "generic";
  projectName?: string;
  environment?: "production" | "preview" | "development";
  buildCommand?: string;
  outputDirectory?: string;
  envVars?: Record<string, string>;
}

/**
 * Analysis report structure
 */
export interface AnalysisReport {
  summary: string;
  codeQuality: {
    score: number;
    issues: Issue[];
  };
  dependencies: {
    outdated: DependencyInfo[];
    vulnerable: DependencyInfo[];
  };
  security: {
    issues: Issue[];
  };
  recommendations: string[];
}

export interface Issue {
  severity: "error" | "warning" | "info";
  message: string;
  file?: string;
  line?: number;
}

export interface DependencyInfo {
  name: string;
  currentVersion: string;
  latestVersion?: string;
  severity?: string;
}
