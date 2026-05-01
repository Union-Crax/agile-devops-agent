import type { ToolDefinition, ToolResult, AgentConfig } from "../agent/types";
import { filesystemTools } from "./filesystem";
import { shellTools } from "./shell";
import { gitTools } from "./git";
import { httpTools } from "./http";
import { analyzerTools } from "./analyzer";

/**
 * Tool Registry - Central registry for all available tools
 */

// Combine all tool definitions
const allTools: ToolDefinition[] = [
  ...filesystemTools,
  ...shellTools,
  ...gitTools,
  ...httpTools,
  ...analyzerTools,
];

// Create a map for quick lookup
const toolMap = new Map<string, ToolDefinition>();
for (const tool of allTools) {
  toolMap.set(tool.name, tool);
}

/**
 * Get all tool definitions for OpenAI function calling
 */
export function getAllTools(): ToolDefinition[] {
  return allTools;
}

/**
 * Get a specific tool by name
 */
export function getTool(name: string): ToolDefinition | undefined {
  return toolMap.get(name);
}

/**
 * Execute a tool by name with the given arguments
 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  config: AgentConfig
): Promise<ToolResult> {
  const tool = toolMap.get(name);

  if (!tool) {
    return {
      success: false,
      output: `Unknown tool: ${name}. Available tools: ${allTools.map((t) => t.name).join(", ")}`,
    };
  }

  try {
    const result = await tool.execute(args, config);
    return result;
  } catch (error) {
    return {
      success: false,
      output: `Tool execution error: ${error instanceof Error ? error.message : "Unknown error"}`,
    };
  }
}

/**
 * Get tool names grouped by category
 */
export function getToolCategories(): Record<string, string[]> {
  return {
    filesystem: filesystemTools.map((t) => t.name),
    shell: shellTools.map((t) => t.name),
    git: gitTools.map((t) => t.name),
    http: httpTools.map((t) => t.name),
    analyzer: analyzerTools.map((t) => t.name),
  };
}

/**
 * Get a formatted list of all tools for display
 */
export function getToolList(): string {
  const categories = getToolCategories();
  const lines: string[] = ["Available Tools:", ""];

  for (const [category, tools] of Object.entries(categories)) {
    lines.push(`${category.toUpperCase()}:`);
    for (const toolName of tools) {
      const tool = toolMap.get(toolName);
      if (tool) {
        lines.push(`  ${tool.name} - ${tool.description.slice(0, 60)}...`);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

// Re-export individual tool arrays for direct access
export { filesystemTools, shellTools, gitTools, httpTools, analyzerTools };
