import * as fs from "fs/promises";
import * as path from "path";
import type { AgentMemory, CodebaseContext, ActionRecord } from "./types";

/**
 * Memory Management
 *
 * Handles persistent memory for the agent, including:
 * - Codebase context (project structure, framework, etc.)
 * - Action history (what the agent has done)
 * - Discoveries (insights learned during execution)
 */

const MEMORY_FILE = ".agile-memory.json";

interface PersistedMemory {
  version: number;
  lastUpdated: string;
  codebaseContext: CodebaseContext;
  discoveries: string[];
  recentActions: ActionRecord[];
}

/**
 * Load memory from disk
 */
export async function loadMemory(workingDirectory: string): Promise<AgentMemory | null> {
  const memoryPath = path.join(workingDirectory, MEMORY_FILE);

  try {
    const content = await fs.readFile(memoryPath, "utf-8");
    const persisted: PersistedMemory = JSON.parse(content);

    return {
      codebaseContext: persisted.codebaseContext,
      previousActions: persisted.recentActions.map((a) => ({
        ...a,
        timestamp: new Date(a.timestamp),
      })),
      discoveries: persisted.discoveries,
    };
  } catch {
    return null;
  }
}

/**
 * Save memory to disk
 */
export async function saveMemory(
  workingDirectory: string,
  memory: AgentMemory
): Promise<void> {
  const memoryPath = path.join(workingDirectory, MEMORY_FILE);

  // Only keep recent actions (last 50)
  const recentActions = memory.previousActions.slice(-50);

  const persisted: PersistedMemory = {
    version: 1,
    lastUpdated: new Date().toISOString(),
    codebaseContext: memory.codebaseContext,
    discoveries: memory.discoveries.slice(-100), // Limit discoveries
    recentActions,
  };

  await fs.writeFile(memoryPath, JSON.stringify(persisted, null, 2));
}

/**
 * Detect codebase context by analyzing project files
 */
export async function detectCodebaseContext(
  workingDirectory: string
): Promise<CodebaseContext> {
  const context: CodebaseContext = {
    rootPath: workingDirectory,
    hasTests: false,
    hasDocker: false,
    hasVercelConfig: false,
    dependencies: {},
  };

  // Check for package manager
  const lockFiles = [
    { file: "pnpm-lock.yaml", manager: "pnpm" },
    { file: "yarn.lock", manager: "yarn" },
    { file: "bun.lockb", manager: "bun" },
    { file: "package-lock.json", manager: "npm" },
  ] as const;

  for (const { file, manager } of lockFiles) {
    try {
      await fs.access(path.join(workingDirectory, file));
      context.packageManager = manager;
      break;
    } catch {
      // File doesn't exist
    }
  }

  // Check for package.json
  try {
    const pkgContent = await fs.readFile(
      path.join(workingDirectory, "package.json"),
      "utf-8"
    );
    const pkg = JSON.parse(pkgContent);

    // Store dependencies
    context.dependencies = {
      ...(pkg.dependencies || {}),
      ...(pkg.devDependencies || {}),
    };

    // Detect framework
    if (context.dependencies.next) {
      context.framework = "Next.js";
    } else if (context.dependencies.nuxt) {
      context.framework = "Nuxt";
    } else if (context.dependencies.vue) {
      context.framework = "Vue";
    } else if (context.dependencies.react) {
      context.framework = "React";
    } else if (context.dependencies.svelte) {
      context.framework = "Svelte";
    } else if (context.dependencies.express) {
      context.framework = "Express";
    } else if (context.dependencies.fastify) {
      context.framework = "Fastify";
    }

    // Check for test setup
    const scripts = pkg.scripts || {};
    context.hasTests = !!(
      scripts.test ||
      context.dependencies.jest ||
      context.dependencies.vitest ||
      context.dependencies.mocha
    );
  } catch {
    // No package.json
  }

  // Check for Docker
  try {
    await fs.access(path.join(workingDirectory, "Dockerfile"));
    context.hasDocker = true;
  } catch {
    // No Dockerfile
  }

  // Check for Vercel config
  try {
    await fs.access(path.join(workingDirectory, "vercel.json"));
    context.hasVercelConfig = true;
  } catch {
    // No vercel.json
  }

  return context;
}

/**
 * Create a fresh memory instance
 */
export function createEmptyMemory(workingDirectory: string): AgentMemory {
  return {
    codebaseContext: {
      rootPath: workingDirectory,
      hasTests: false,
      hasDocker: false,
      hasVercelConfig: false,
      dependencies: {},
    },
    previousActions: [],
    discoveries: [],
  };
}

/**
 * Add a discovery to memory
 */
export function addDiscovery(memory: AgentMemory, discovery: string): void {
  if (!memory.discoveries.includes(discovery)) {
    memory.discoveries.push(discovery);
  }
}

/**
 * Format memory for inclusion in prompts
 */
export function formatMemoryForPrompt(memory: AgentMemory): string {
  const lines: string[] = ["## Project Context"];

  const ctx = memory.codebaseContext;
  lines.push(`- Root: ${ctx.rootPath}`);
  if (ctx.framework) lines.push(`- Framework: ${ctx.framework}`);
  if (ctx.packageManager) lines.push(`- Package Manager: ${ctx.packageManager}`);
  lines.push(`- Has Tests: ${ctx.hasTests}`);
  lines.push(`- Has Docker: ${ctx.hasDocker}`);
  lines.push(`- Has Vercel Config: ${ctx.hasVercelConfig}`);

  if (memory.discoveries.length > 0) {
    lines.push("\n## Discoveries");
    memory.discoveries.slice(-10).forEach((d) => {
      lines.push(`- ${d}`);
    });
  }

  if (memory.previousActions.length > 0) {
    lines.push("\n## Recent Actions");
    memory.previousActions.slice(-5).forEach((a) => {
      const status = a.success ? "OK" : "FAILED";
      lines.push(`- [${status}] ${a.tool}`);
    });
  }

  return lines.join("\n");
}
