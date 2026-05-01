#!/usr/bin/env node

import { Command } from "commander"
import chalk from "chalk"
import ora from "ora"
import * as readline from "readline"
import { config as loadEnv } from "dotenv"
import {
  createAgent,
  detectCodebaseContext,
  getTaskPrompt,
  createEmptyMemory,
  createInteractiveInputHandler,
  createAutoSkipHandler,
  type AgentCallbacks,
} from "./agent"
import { getToolList } from "./tools"

// Load environment variables
loadEnv()

const VERSION = "1.0.0"

/**
 * AGILE - Multi-step DevOps Agent CLI
 *
 * A real AI system that analyzes codebases, deploys applications,
 * monitors deployments, and fixes issues using OpenAI function calling.
 */

const program = new Command()

// ASCII art banner
function printBanner(): void {
  console.log(
    chalk.cyan(`
    ╔═══════════════════════════════════════════════════════════╗
    ║                                                           ║
    ║     █████╗  ██████╗ ██╗██╗     ███████╗                   ║
    ║    ██╔══██╗██╔════╝ ██║██║     ██╔════╝                   ║
    ║    ███████║██║  ███╗██║██║     █████╗                     ║
    ║    ██╔══██║██║   ██║██║██║     ██╔══╝                     ║
    ║    ██║  ██║╚██████╔╝██║███████╗███████╗                   ║
    ║    ╚═╝  ╚═╝ ╚═════╝ ╚═╝╚══════╝╚══════╝                   ║
    ║                                                           ║
    ║    Multi-step DevOps Agent powered by OpenAI              ║
    ╚═══════════════════════════════════════════════════════════╝
`),
  )
}

// Get API key from environment or throw
function getApiKey(): string {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    console.error(chalk.red("\nError: OPENAI_API_KEY environment variable is not set."))
    console.error(chalk.yellow("Set it with: export OPENAI_API_KEY=your-key"))
    console.error(chalk.gray("Or create a .env file (see .env.example).\n"))
    process.exit(1)
  }
  return apiKey
}

/**
 * Build callbacks for live agent feedback in the CLI
 */
function buildCallbacks(verbose: boolean, interactive = false): AgentCallbacks {
  return {
    onStep: (step, maxSteps) => {
      if (verbose) {
        console.log(chalk.gray(`\n--- Step ${step}/${maxSteps} ---`))
      }
    },
    onThinking: (thought, plan) => {
      console.log(chalk.magenta(`\n[Thinking] ${thought}`))
      if (plan && plan.length > 0) {
        plan.forEach((step, i) => {
          console.log(chalk.gray(`  ${i + 1}. ${step}`))
        })
      }
    },
    onToolCall: (name, args) => {
      const argsPreview = JSON.stringify(args).slice(0, 80)
      console.log(chalk.blue(`\n[Tool] ${name}`) + chalk.gray(` ${argsPreview}`))
    },
    onToolResult: (name, success, output) => {
      const icon = success ? chalk.green("ok") : chalk.red("fail")
      const preview = output.slice(0, 200).replace(/\n/g, " ")
      console.log(chalk.gray(`  [${icon}] ${preview}${output.length > 200 ? "..." : ""}`))
    },
    onUserQuestion: interactive ? createInteractiveInputHandler() : createAutoSkipHandler(),
  }
}

/**
 * Print task result with usage stats
 */
function printResult(
  result: { success: boolean; summary: string; details: string[]; errors?: string[]; artifacts?: string[] },
  agent: ReturnType<typeof createAgent>,
  successLabel = "Task Complete",
  failureLabel = "Task Failed",
): void {
  console.log("\n" + chalk.bold("═".repeat(60)))
  if (result.success) {
    console.log(chalk.green.bold(`\n[${successLabel}]\n`))
  } else {
    console.log(chalk.red.bold(`\n[${failureLabel}]\n`))
  }

  console.log(chalk.bold("Summary:"), result.summary)

  if (result.details && result.details.length > 0) {
    console.log(chalk.bold("\nDetails:"))
    result.details.forEach((detail) => {
      console.log(`  - ${detail}`)
    })
  }

  if (result.artifacts && result.artifacts.length > 0) {
    console.log(chalk.bold("\nArtifacts:"))
    result.artifacts.forEach((artifact) => {
      console.log(chalk.cyan(`  -> ${artifact}`))
    })
  }

  if (result.errors && result.errors.length > 0) {
    console.log(chalk.red.bold("\nErrors:"))
    result.errors.forEach((error) => {
      console.log(chalk.red(`  - ${error}`))
    })
  }

  // Always print usage stats
  const usage = agent.getUsage().getStats()
  console.log("\n" + chalk.bold("─".repeat(60)))
  console.log(chalk.bold("Usage:"))
  console.log(
    chalk.gray(
      `  ${usage.apiCalls} API calls | ` +
        `${usage.totalTokens.toLocaleString()} tokens | ` +
        `~$${usage.estimatedCostUSD.toFixed(4)} USD`,
    ),
  )
}

// Configure the program
program
  .name("agile")
  .description("Multi-step DevOps Agent - Analyze, Deploy, Monitor, Fix")
  .version(VERSION)
  .option("-v, --verbose", "Enable verbose output", false)
  .option("--dry-run", "Show what would be done without executing", false)
  .option("-d, --directory <path>", "Working directory", process.cwd())
  .option("-m, --model <model>", "OpenAI model to use", "gpt-4o-mini")
  .option("--max-steps <number>", "Maximum agent steps", "30")
  .option("--no-interactive", "Disable interactive prompts (auto-skip questions)")

/**
 * ANALYZE command
 */
program
  .command("analyze")
  .description("Analyze a codebase for issues, security vulnerabilities, and improvements")
  .argument("[path]", "Path to analyze", ".")
  .action(async (targetPath: string) => {
    printBanner()
    const opts = program.opts()
    const spinner = ora("Initializing agent...").start()

    try {
      const apiKey = getApiKey()
      const workDir = opts.directory || process.cwd()

      spinner.text = "Analyzing project structure..."
      const context = await detectCodebaseContext(workDir)
      const memory = createEmptyMemory(workDir)
      memory.codebaseContext = context

      const callbacks = buildCallbacks(opts.verbose, opts.interactive !== false)
      const agent = createAgent(
        apiKey,
        {
          model: opts.model,
          maxSteps: Number.parseInt(opts.maxSteps, 10),
          verbose: opts.verbose,
          dryRun: opts.dryRun,
          workingDirectory: workDir,
        },
        callbacks,
      )

      spinner.succeed("Agent initialized")
      console.log(chalk.gray(`Framework: ${context.framework || "Unknown"}`))
      console.log(chalk.gray(`Package Manager: ${context.packageManager || "Unknown"}`))
      console.log(chalk.gray(`Model: ${opts.model}`))
      console.log()

      const taskPrompt = getTaskPrompt("analyze", { path: targetPath }, memory)

      console.log(chalk.cyan("Starting analysis...\n"))

      const result = await agent.executeTask(taskPrompt)
      printResult(result, agent, "Analysis Complete", "Analysis Failed")

      process.exit(result.success ? 0 : 1)
    } catch (error) {
      spinner.fail("Agent failed")
      console.error(chalk.red(`\nError: ${error instanceof Error ? error.message : "Unknown error"}`))
      process.exit(1)
    }
  })

/**
 * DEPLOY command
 */
program
  .command("deploy")
  .description("Deploy the project to a platform")
  .argument("[platform]", "Deployment platform (vercel, docker, generic)", "vercel")
  .option("-e, --env <environment>", "Environment (preview, production)", "preview")
  .option("-p, --project <name>", "Project name override")
  .action(async (platform: string, cmdOpts: { env: string; project?: string }) => {
    printBanner()
    const opts = program.opts()
    const spinner = ora("Initializing deployment...").start()

    try {
      const apiKey = getApiKey()
      const workDir = opts.directory || process.cwd()

      if (!["vercel", "docker", "generic"].includes(platform)) {
        spinner.fail(`Unknown platform: ${platform}`)
        console.error(chalk.yellow("Valid platforms: vercel, docker, generic"))
        process.exit(1)
      }

      spinner.text = "Checking project..."
      const context = await detectCodebaseContext(workDir)
      const memory = createEmptyMemory(workDir)
      memory.codebaseContext = context

      const callbacks = buildCallbacks(opts.verbose, opts.interactive !== false)
      const agent = createAgent(
        apiKey,
        {
          model: opts.model,
          maxSteps: Number.parseInt(opts.maxSteps, 10),
          verbose: opts.verbose,
          dryRun: opts.dryRun,
          workingDirectory: workDir,
          platform: platform as "vercel" | "docker" | "generic",
        },
        callbacks,
      )

      spinner.succeed("Ready to deploy")
      console.log(chalk.gray(`Platform: ${platform}`))
      console.log(chalk.gray(`Environment: ${cmdOpts.env}`))
      console.log(chalk.gray(`Framework: ${context.framework || "Unknown"}`))

      if (opts.dryRun) {
        console.log(chalk.yellow.bold("\n[DRY RUN MODE]\n"))
      }

      const taskPrompt = getTaskPrompt(
        "deploy",
        {
          platform,
          environment: cmdOpts.env,
          project: cmdOpts.project || "",
        },
        memory,
      )

      console.log(chalk.cyan("\nStarting deployment...\n"))

      const result = await agent.executeTask(taskPrompt)
      printResult(result, agent, "Deployment Complete", "Deployment Failed")

      process.exit(result.success ? 0 : 1)
    } catch (error) {
      spinner.fail("Deployment failed")
      console.error(chalk.red(`\nError: ${error instanceof Error ? error.message : "Unknown error"}`))
      process.exit(1)
    }
  })

/**
 * MONITOR command
 */
program
  .command("monitor")
  .description("Monitor a deployment URL for health and issues")
  .argument("<url>", "URL to monitor")
  .option("-i, --interval <seconds>", "Check interval in seconds", "0")
  .action(async (url: string, cmdOpts: { interval: string }) => {
    printBanner()
    const opts = program.opts()

    try {
      const apiKey = getApiKey()
      const workDir = opts.directory || process.cwd()
      const memory = createEmptyMemory(workDir)

      const callbacks = buildCallbacks(opts.verbose, opts.interactive !== false)
      const agent = createAgent(
        apiKey,
        {
          model: opts.model,
          maxSteps: Number.parseInt(opts.maxSteps, 10),
          verbose: opts.verbose,
          dryRun: opts.dryRun,
          workingDirectory: workDir,
        },
        callbacks,
      )

      console.log(chalk.cyan(`Monitoring: ${url}\n`))

      const interval = Number.parseInt(cmdOpts.interval, 10)

      const runCheck = async () => {
        const taskPrompt = getTaskPrompt("monitor", { url }, memory)
        const result = await agent.executeTask(taskPrompt)
        printResult(result, agent, "Site is Healthy", "Issues Detected")
        return result
      }

      if (interval > 0) {
        console.log(chalk.gray(`Continuous monitoring every ${interval}s. Press Ctrl+C to stop.\n`))
        // Initial check
        await runCheck()
        // Recurring checks
        setInterval(async () => {
          console.log(chalk.gray(`\n[${new Date().toISOString()}] Running check...`))
          await runCheck()
        }, interval * 1000)
      } else {
        const result = await runCheck()
        process.exit(result.success ? 0 : 1)
      }
    } catch (error) {
      console.error(chalk.red(`\nError: ${error instanceof Error ? error.message : "Unknown error"}`))
      process.exit(1)
    }
  })

/**
 * FIX command
 */
program
  .command("fix")
  .description("Automatically fix issues in the codebase")
  .argument("[issue]", "Type of issue to fix (dependencies, security, lint, or describe the issue)", "general")
  .action(async (issue: string) => {
    printBanner()
    const opts = program.opts()
    const spinner = ora("Analyzing issues...").start()

    try {
      const apiKey = getApiKey()
      const workDir = opts.directory || process.cwd()

      const context = await detectCodebaseContext(workDir)
      const memory = createEmptyMemory(workDir)
      memory.codebaseContext = context

      const callbacks = buildCallbacks(opts.verbose, opts.interactive !== false)
      const agent = createAgent(
        apiKey,
        {
          model: opts.model,
          maxSteps: Number.parseInt(opts.maxSteps, 10),
          verbose: opts.verbose,
          dryRun: opts.dryRun,
          workingDirectory: workDir,
        },
        callbacks,
      )

      spinner.succeed("Ready to fix issues")

      if (opts.dryRun) {
        console.log(chalk.yellow.bold("\n[DRY RUN MODE]\n"))
      }

      const taskPrompt = getTaskPrompt("fix", { issue }, memory)

      console.log(chalk.cyan(`\nFixing: ${issue}\n`))

      const result = await agent.executeTask(taskPrompt)
      printResult(result, agent, "Fixes Applied", "Fix Failed")

      process.exit(result.success ? 0 : 1)
    } catch (error) {
      spinner.fail("Fix failed")
      console.error(chalk.red(`\nError: ${error instanceof Error ? error.message : "Unknown error"}`))
      process.exit(1)
    }
  })

/**
 * INTERACTIVE command
 */
program
  .command("interactive")
  .alias("i")
  .description("Start an interactive session with the agent")
  .action(async () => {
    printBanner()
    const opts = program.opts()

    try {
      const apiKey = getApiKey()
      const workDir = opts.directory || process.cwd()

      console.log(chalk.gray("Analyzing project...\n"))
      const context = await detectCodebaseContext(workDir)

      console.log(chalk.gray(`Framework: ${context.framework || "Unknown"}`))
      console.log(chalk.gray(`Package Manager: ${context.packageManager || "Unknown"}`))
      console.log(chalk.gray(`Model: ${opts.model}`))
      console.log()

      const callbacks = buildCallbacks(opts.verbose, true)
      const agent = createAgent(
        apiKey,
        {
          model: opts.model,
          maxSteps: Number.parseInt(opts.maxSteps, 10),
          verbose: opts.verbose,
          dryRun: opts.dryRun,
          workingDirectory: workDir,
        },
        callbacks,
      )

      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      })

      console.log(
        chalk.gray("Special commands: ") +
          chalk.cyan("/usage") +
          chalk.gray(" - show token usage | ") +
          chalk.cyan("/clear") +
          chalk.gray(" - clear history | ") +
          chalk.cyan("exit") +
          chalk.gray(" - quit\n"),
      )

      async function* readlineIterator(): AsyncGenerator<string> {
        const prompt = chalk.cyan("agile> ")
        while (true) {
          const line = await new Promise<string>((resolve) => {
            rl.question(prompt, resolve)
          })
          yield line
        }
      }

      await agent.interactiveSession(readlineIterator())

      // Print final usage stats
      console.log("\n" + chalk.bold("─".repeat(60)))
      console.log(chalk.bold("Final Usage:"))
      console.log(agent.getUsage().format())

      rl.close()
      process.exit(0)
    } catch (error) {
      console.error(chalk.red(`\nError: ${error instanceof Error ? error.message : "Unknown error"}`))
      process.exit(1)
    }
  })

/**
 * TOOLS command
 */
program
  .command("tools")
  .description("List all available tools the agent can use")
  .action(() => {
    printBanner()
    console.log(chalk.cyan.bold("Available Tools\n"))
    console.log(getToolList())
  })

/**
 * RUN command
 */
program
  .command("run")
  .description("Run a custom task described in natural language")
  .argument("<task>", "Task description")
  .action(async (task: string) => {
    printBanner()
    const opts = program.opts()
    const spinner = ora("Starting task...").start()

    try {
      const apiKey = getApiKey()
      const workDir = opts.directory || process.cwd()

      const context = await detectCodebaseContext(workDir)

      const callbacks = buildCallbacks(opts.verbose, opts.interactive !== false)
      const agent = createAgent(
        apiKey,
        {
          model: opts.model,
          maxSteps: Number.parseInt(opts.maxSteps, 10),
          verbose: opts.verbose,
          dryRun: opts.dryRun,
          workingDirectory: workDir,
        },
        callbacks,
      )

      spinner.succeed("Agent ready")
      console.log(chalk.gray(`Framework: ${context.framework || "Unknown"}`))
      console.log(chalk.gray(`Model: ${opts.model}`))

      if (opts.dryRun) {
        console.log(chalk.yellow.bold("\n[DRY RUN MODE]\n"))
      }

      console.log(chalk.cyan(`\nTask: ${task}\n`))

      const result = await agent.executeTask(task)
      printResult(result, agent)

      process.exit(result.success ? 0 : 1)
    } catch (error) {
      spinner.fail("Task failed")
      console.error(chalk.red(`\nError: ${error instanceof Error ? error.message : "Unknown error"}`))
      process.exit(1)
    }
  })

// Parse arguments and run
program.parse()
