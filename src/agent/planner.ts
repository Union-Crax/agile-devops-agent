import type { AgentMemory, CodebaseContext } from "./types";

/**
 * Task Planner
 *
 * Helps decompose high-level tasks into concrete steps based on:
 * - The task type (analyze, deploy, fix, etc.)
 * - The codebase context (framework, platform, etc.)
 * - Previous discoveries and actions
 */

export interface TaskPlan {
  task: string;
  steps: PlanStep[];
  preconditions: string[];
  estimatedSteps: number;
}

export interface PlanStep {
  description: string;
  tools: string[];
  optional?: boolean;
}

/**
 * Generate an analysis plan
 */
export function planAnalysis(context: CodebaseContext): TaskPlan {
  const steps: PlanStep[] = [
    {
      description: "Analyze project structure and configuration",
      tools: ["analyze_project", "list_directory"],
    },
    {
      description: "Check dependencies for issues",
      tools: ["check_dependencies", "audit_dependencies"],
    },
    {
      description: "Run code quality analysis",
      tools: ["analyze_code_quality"],
    },
  ];

  if (context.hasTests) {
    steps.push({
      description: "Run test suite",
      tools: ["run_tests"],
      optional: true,
    });
  }

  steps.push({
    description: "Run linter if available",
    tools: ["run_linter"],
    optional: true,
  });

  return {
    task: "Analyze codebase",
    steps,
    preconditions: [],
    estimatedSteps: steps.length * 2,
  };
}

/**
 * Generate a deployment plan
 */
export function planDeployment(
  context: CodebaseContext,
  platform: "vercel" | "docker" | "generic"
): TaskPlan {
  const steps: PlanStep[] = [
    {
      description: "Check project readiness",
      tools: ["analyze_project", "git_status"],
    },
  ];

  if (context.hasTests) {
    steps.push({
      description: "Run tests to ensure quality",
      tools: ["run_tests"],
    });
  }

  steps.push({
    description: "Build the project",
    tools: ["build_project"],
  });

  switch (platform) {
    case "vercel":
      steps.push({
        description: "Deploy to Vercel",
        tools: ["run_command"], // vercel deploy command
      });
      steps.push({
        description: "Verify deployment",
        tools: ["check_health"],
      });
      break;

    case "docker":
      steps.push({
        description: "Build Docker image",
        tools: ["run_command"], // docker build
      });
      steps.push({
        description: "Push to registry (if configured)",
        tools: ["run_command"], // docker push
        optional: true,
      });
      break;

    case "generic":
      steps.push({
        description: "Commit changes if any",
        tools: ["git_status", "git_commit"],
        optional: true,
      });
      steps.push({
        description: "Push to remote",
        tools: ["git_push"],
      });
      break;
  }

  return {
    task: `Deploy to ${platform}`,
    steps,
    preconditions: [
      "Project must build successfully",
      platform === "vercel" ? "Vercel CLI must be installed and configured" : "",
      platform === "docker" ? "Docker must be installed and running" : "",
    ].filter(Boolean),
    estimatedSteps: steps.length * 2,
  };
}

/**
 * Generate a fix plan based on the issue type
 */
export function planFix(issueType: string, context: CodebaseContext): TaskPlan {
  const steps: PlanStep[] = [
    {
      description: "Understand the current state",
      tools: ["analyze_project", "git_status"],
    },
  ];

  switch (issueType) {
    case "dependencies":
      steps.push({
        description: "Check outdated dependencies",
        tools: ["check_dependencies"],
      });
      steps.push({
        description: "Update dependencies",
        tools: ["run_command"], // npm update or similar
      });
      steps.push({
        description: "Verify project still works",
        tools: ["build_project"],
      });
      if (context.hasTests) {
        steps.push({
          description: "Run tests",
          tools: ["run_tests"],
        });
      }
      break;

    case "security":
      steps.push({
        description: "Run security audit",
        tools: ["audit_dependencies"],
      });
      steps.push({
        description: "Apply security fixes",
        tools: ["run_command"], // npm audit fix
      });
      steps.push({
        description: "Verify fixes",
        tools: ["audit_dependencies"],
      });
      break;

    case "lint":
      steps.push({
        description: "Run linter with auto-fix",
        tools: ["run_linter"],
      });
      steps.push({
        description: "Review changes",
        tools: ["git_diff"],
      });
      break;

    default:
      steps.push({
        description: "Search for related files",
        tools: ["grep", "search_files"],
      });
      steps.push({
        description: "Read and analyze files",
        tools: ["read_file"],
      });
      steps.push({
        description: "Apply fixes",
        tools: ["write_file"],
      });
  }

  return {
    task: `Fix ${issueType} issues`,
    steps,
    preconditions: [],
    estimatedSteps: steps.length * 2,
  };
}

/**
 * Generate a monitoring plan
 */
export function planMonitoring(url: string): TaskPlan {
  return {
    task: `Monitor deployment at ${url}`,
    steps: [
      {
        description: "Check endpoint health",
        tools: ["check_health"],
      },
      {
        description: "Fetch homepage content",
        tools: ["fetch_web_page"],
      },
      {
        description: "Check common API endpoints",
        tools: ["http_request"],
        optional: true,
      },
    ],
    preconditions: ["URL must be accessible"],
    estimatedSteps: 6,
  };
}

/**
 * Format a plan for display
 */
export function formatPlan(plan: TaskPlan): string {
  const lines: string[] = [
    `Task: ${plan.task}`,
    `Estimated steps: ${plan.estimatedSteps}`,
    "",
  ];

  if (plan.preconditions.length > 0) {
    lines.push("Preconditions:");
    plan.preconditions.forEach((p) => lines.push(`  - ${p}`));
    lines.push("");
  }

  lines.push("Steps:");
  plan.steps.forEach((step, i) => {
    const optional = step.optional ? " (optional)" : "";
    lines.push(`  ${i + 1}. ${step.description}${optional}`);
    lines.push(`     Tools: ${step.tools.join(", ")}`);
  });

  return lines.join("\n");
}

/**
 * Get initial prompt based on task type
 */
export function getTaskPrompt(
  taskType: "analyze" | "deploy" | "fix" | "monitor" | "interactive",
  args: Record<string, string>,
  memory: AgentMemory
): string {
  const ctx = memory.codebaseContext;

  switch (taskType) {
    case "analyze":
      return `Analyze this codebase thoroughly. Check the project structure, code quality, 
dependencies (outdated and vulnerable), and provide actionable recommendations.
${ctx.framework ? `This appears to be a ${ctx.framework} project.` : ""}
${ctx.hasTests ? "The project has tests - run them as part of the analysis." : ""}`;

    case "deploy":
      const platform = args.platform || "vercel";
      return `Deploy this project to ${platform}.
${ctx.framework ? `This is a ${ctx.framework} project.` : ""}
${ctx.hasTests ? "Run tests before deploying." : ""}
${ctx.hasDocker && platform === "docker" ? "Dockerfile is present." : ""}
${ctx.hasVercelConfig && platform === "vercel" ? "vercel.json is present." : ""}
Build the project, then deploy. Verify the deployment is working after.`;

    case "fix":
      const issue = args.issue || "general";
      return `Fix ${issue} issues in this codebase.
${ctx.framework ? `This is a ${ctx.framework} project.` : ""}
Identify the issues, apply fixes, and verify the fixes work.
${ctx.hasTests ? "Run tests after making changes." : ""}`;

    case "monitor":
      const url = args.url;
      return `Monitor the deployment at ${url}.
Check if the site is healthy, look for any errors, and report the status.
If there are issues, suggest how to fix them.`;

    case "interactive":
      return `You are in interactive mode. The user will provide requests one at a time.
${ctx.framework ? `This is a ${ctx.framework} project.` : ""}
Help them with DevOps tasks like deployment, analysis, fixing issues, etc.`;

    default:
      return "";
  }
}
