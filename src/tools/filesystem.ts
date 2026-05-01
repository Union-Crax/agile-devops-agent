import * as fs from "fs/promises";
import * as path from "path";
import { glob } from "glob";
import type { ToolDefinition, ToolResult, AgentConfig } from "../agent/types";

/**
 * Filesystem tools for reading, writing, and searching files
 */

async function readFile(
  args: Record<string, unknown>,
  config: AgentConfig
): Promise<ToolResult> {
  const filePath = args.path as string;
  const absolutePath = path.isAbsolute(filePath)
    ? filePath
    : path.join(config.workingDirectory, filePath);

  try {
    const content = await fs.readFile(absolutePath, "utf-8");
    const lines = content.split("\n");
    const maxLines = (args.maxLines as number) || 500;

    if (lines.length > maxLines) {
      return {
        success: true,
        output: `File: ${filePath} (showing first ${maxLines} of ${lines.length} lines)\n\n${lines.slice(0, maxLines).join("\n")}\n\n... (${lines.length - maxLines} more lines)`,
        metadata: { totalLines: lines.length, truncated: true },
      };
    }

    return {
      success: true,
      output: `File: ${filePath}\n\n${content}`,
      metadata: { totalLines: lines.length, truncated: false },
    };
  } catch (error) {
    return {
      success: false,
      output: `Failed to read file: ${error instanceof Error ? error.message : "Unknown error"}`,
    };
  }
}

async function writeFile(
  args: Record<string, unknown>,
  config: AgentConfig
): Promise<ToolResult> {
  if (config.dryRun) {
    return {
      success: true,
      output: `[DRY RUN] Would write to ${args.path}:\n${(args.content as string).slice(0, 200)}...`,
    };
  }

  const filePath = args.path as string;
  const absolutePath = path.isAbsolute(filePath)
    ? filePath
    : path.join(config.workingDirectory, filePath);
  const content = args.content as string;

  try {
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content, "utf-8");
    return {
      success: true,
      output: `Successfully wrote ${content.length} bytes to ${filePath}`,
    };
  } catch (error) {
    return {
      success: false,
      output: `Failed to write file: ${error instanceof Error ? error.message : "Unknown error"}`,
    };
  }
}

async function searchFiles(
  args: Record<string, unknown>,
  config: AgentConfig
): Promise<ToolResult> {
  const pattern = args.pattern as string;
  const searchPath = (args.path as string) || config.workingDirectory;

  try {
    const files = await glob(pattern, {
      cwd: searchPath,
      ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/.next/**"],
      nodir: true,
    });

    if (files.length === 0) {
      return {
        success: true,
        output: `No files found matching pattern: ${pattern}`,
        metadata: { count: 0 },
      };
    }

    const maxFiles = 50;
    const displayFiles = files.slice(0, maxFiles);
    const output =
      displayFiles.join("\n") +
      (files.length > maxFiles
        ? `\n\n... and ${files.length - maxFiles} more files`
        : "");

    return {
      success: true,
      output: `Found ${files.length} files matching "${pattern}":\n\n${output}`,
      metadata: { count: files.length },
    };
  } catch (error) {
    return {
      success: false,
      output: `Search failed: ${error instanceof Error ? error.message : "Unknown error"}`,
    };
  }
}

async function grepSearch(
  args: Record<string, unknown>,
  config: AgentConfig
): Promise<ToolResult> {
  const searchPattern = args.pattern as string;
  const filePattern = (args.filePattern as string) || "**/*";
  const searchPath = (args.path as string) || config.workingDirectory;

  try {
    const files = await glob(filePattern, {
      cwd: searchPath,
      ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/.next/**"],
      nodir: true,
    });

    const results: { file: string; line: number; content: string }[] = [];
    const regex = new RegExp(searchPattern, "gi");

    for (const file of files.slice(0, 100)) {
      try {
        const content = await fs.readFile(path.join(searchPath, file), "utf-8");
        const lines = content.split("\n");

        lines.forEach((line, index) => {
          if (regex.test(line)) {
            results.push({
              file,
              line: index + 1,
              content: line.trim().slice(0, 200),
            });
          }
          regex.lastIndex = 0; // Reset regex state
        });
      } catch {
        // Skip files that can't be read (binary, etc.)
      }

      if (results.length >= 50) break;
    }

    if (results.length === 0) {
      return {
        success: true,
        output: `No matches found for pattern: ${searchPattern}`,
        metadata: { count: 0 },
      };
    }

    const output = results
      .map((r) => `${r.file}:${r.line}: ${r.content}`)
      .join("\n");

    return {
      success: true,
      output: `Found ${results.length} matches for "${searchPattern}":\n\n${output}`,
      metadata: { count: results.length },
    };
  } catch (error) {
    return {
      success: false,
      output: `Grep failed: ${error instanceof Error ? error.message : "Unknown error"}`,
    };
  }
}

async function listDirectory(
  args: Record<string, unknown>,
  config: AgentConfig
): Promise<ToolResult> {
  const dirPath = (args.path as string) || ".";
  const absolutePath = path.isAbsolute(dirPath)
    ? dirPath
    : path.join(config.workingDirectory, dirPath);

  try {
    const entries = await fs.readdir(absolutePath, { withFileTypes: true });
    const formatted = entries
      .map((entry) => {
        const type = entry.isDirectory() ? "[DIR]" : "[FILE]";
        return `${type} ${entry.name}`;
      })
      .sort()
      .join("\n");

    return {
      success: true,
      output: `Contents of ${dirPath}:\n\n${formatted}`,
      metadata: { count: entries.length },
    };
  } catch (error) {
    return {
      success: false,
      output: `Failed to list directory: ${error instanceof Error ? error.message : "Unknown error"}`,
    };
  }
}

export const filesystemTools: ToolDefinition[] = [
  {
    name: "read_file",
    description:
      "Read the contents of a file. Returns the full content for small files, or truncated content for large files. Use this to understand code, configs, or any text file.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the file (relative to project root or absolute)",
        },
        maxLines: {
          type: "number",
          description: "Maximum number of lines to return (default: 500)",
        },
      },
      required: ["path"],
    },
    execute: readFile,
  },
  {
    name: "write_file",
    description:
      "Write content to a file. Creates parent directories if needed. Use for creating or updating files.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to write to (relative to project root or absolute)",
        },
        content: {
          type: "string",
          description: "The content to write to the file",
        },
      },
      required: ["path", "content"],
    },
    execute: writeFile,
  },
  {
    name: "search_files",
    description:
      "Search for files matching a glob pattern. Returns a list of matching file paths. Use to find specific files in the project.",
    parameters: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Glob pattern to match (e.g., '**/*.ts', 'src/**/*.tsx')",
        },
        path: {
          type: "string",
          description: "Directory to search in (default: project root)",
        },
      },
      required: ["pattern"],
    },
    execute: searchFiles,
  },
  {
    name: "grep",
    description:
      "Search for a pattern in file contents. Returns matching lines with file paths and line numbers. Use to find specific code, text, or patterns.",
    parameters: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Regex pattern to search for in file contents",
        },
        filePattern: {
          type: "string",
          description: "Glob pattern to filter which files to search (default: **/*)",
        },
        path: {
          type: "string",
          description: "Directory to search in (default: project root)",
        },
      },
      required: ["pattern"],
    },
    execute: grepSearch,
  },
  {
    name: "list_directory",
    description:
      "List the contents of a directory. Shows files and subdirectories. Use to explore project structure.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Directory path to list (default: project root)",
        },
      },
      required: [],
    },
    execute: listDirectory,
  },
];
