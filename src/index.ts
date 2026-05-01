/**
 * AGILE - Multi-step DevOps Agent
 *
 * A real AI system that uses OpenAI function calling to:
 * - Analyze codebases for issues, vulnerabilities, and improvements
 * - Deploy applications to Vercel, Docker, and generic platforms
 * - Monitor deployments and check health
 * - Fix issues automatically
 *
 * This is a system, not just a prompt.
 */

// Export agent functionality
export {
  AgentCore,
  createAgent,
  loadMemory,
  saveMemory,
  detectCodebaseContext,
  createEmptyMemory,
  planAnalysis,
  planDeployment,
  planFix,
  planMonitoring,
  formatPlan,
  getTaskPrompt,
} from "./agent";

// Export types
export type {
  AgentConfig,
  AgentState,
  AgentMemory,
  CodebaseContext,
  ActionRecord,
  TaskResult,
  ToolDefinition,
  ToolResult,
  ToolCall,
  DeploymentConfig,
  AnalysisReport,
  Issue,
  DependencyInfo,
} from "./agent";

// Export tools
export {
  getAllTools,
  getTool,
  executeTool,
  getToolCategories,
  getToolList,
  filesystemTools,
  shellTools,
  gitTools,
  httpTools,
  analyzerTools,
} from "./tools";
