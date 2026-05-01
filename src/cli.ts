#!/usr/bin/env node

import { Command } from "commander"
import chalk from "chalk"
import ora from "ora"
import * as readline from "readline"
import * as fs from "fs"
import { parse as parseEnv } from "dotenv"
import {
  describeResolution,
  getCliConfigPath,
  loadCliConfig,
  maskApiKey,
  resolveModelSelection,
  saveCliConfig,
  validateName,
  type ModelResolution,
} from "./config/models"
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
import packageJson from "../package.json"

type EnvSource = "shell" | ".env" | ".env.local" | "config"
type TrackedEnvKey = "OPENAI_API_KEY" | "AGILE_MODEL" | "AGILE_MODEL_PROFILE"

const TRACKED_ENV_KEYS: TrackedEnvKey[] = ["OPENAI_API_KEY", "AGILE_MODEL", "AGILE_MODEL_PROFILE"]

type EnvFileStatus = {
  path: ".env" | ".env.local"
  exists: boolean
  parsedKeys: number
}

type EnvLoadState = {
  files: EnvFileStatus[]
  sourceByKey: Partial<Record<TrackedEnvKey, EnvSource>>
}

function initializeEnv(): EnvLoadState {
  const sourceByName = new Map<string, EnvSource>()

  for (const key of Object.keys(process.env)) {
    sourceByName.set(key, "shell")
  }

  const files: EnvFileStatus[] = []
  const envFiles: Array<{ path: ".env" | ".env.local"; source: EnvSource }> = [
    { path: ".env", source: ".env" },
    { path: ".env.local", source: ".env.local" },
  ]

  for (const file of envFiles) {
    if (!fs.existsSync(file.path)) {
      files.push({ path: file.path, exists: false, parsedKeys: 0 })
      continue
    }

    let entries: Array<[string, string]> = []
    try {
      const raw = fs.readFileSync(file.path, "utf-8")
      const parsed = parseEnv(raw)
      entries = Object.entries(parsed)
    } catch {
      files.push({ path: file.path, exists: true, parsedKeys: 0 })
      continue
    }

    for (const [key, value] of entries) {
      const existingSource = sourceByName.get(key)

      if (!existingSource) {
        process.env[key] = value
        sourceByName.set(key, file.source)
        continue
      }

      // Allow .env.local to override .env while preserving shell env priority.
      if (existingSource === ".env" && file.source === ".env.local") {
        process.env[key] = value
        sourceByName.set(key, file.source)
      }
    }

    files.push({ path: file.path, exists: true, parsedKeys: entries.length })
  }

  const sourceByKey: Partial<Record<TrackedEnvKey, EnvSource>> = {}
  for (const key of TRACKED_ENV_KEYS) {
    const source = sourceByName.get(key)
    if (source) {
      sourceByKey[key] = source
    }
  }

  return { files, sourceByKey }
}

const envLoadState = initializeEnv()

const VERSION = packageJson.version

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

async function resolveApiKey(): Promise<{ value?: string; source: EnvSource | "unset" }> {
  const envApiKey = process.env.OPENAI_API_KEY
  if (envApiKey) {
    return {
      value: envApiKey,
      source: envLoadState.sourceByKey.OPENAI_API_KEY || "shell",
    }
  }

  const config = await loadCliConfig()
  if (config.apiKey) {
    return {
      value: config.apiKey,
      source: "config",
    }
  }

  return { source: "unset" }
}

// Get API key from environment/config or throw
async function getApiKey(): Promise<string> {
  const resolved = await resolveApiKey()
  if (!resolved.value) {
    console.error(chalk.red("\nError: OPENAI_API_KEY environment variable is not set."))
    console.error(chalk.yellow("Run 'agile setup' once to store your API key securely in AGILE config."))
    console.error(chalk.gray("Run 'agile auth doctor' for env diagnostics.\n"))
    process.exit(1)
  }
  return resolved.value
}

function formatEnvSource(source?: EnvSource): string {
  if (!source) {
    return "unset"
  }
  if (source === "shell") {
    return "shell environment"
  }
  return source
}

type GlobalOpts = {
  verbose: boolean
  dryRun: boolean
  directory: string
  model?: string
  profile?: string
  maxSteps: string
  interactive?: boolean
}

async function resolveRuntimeModel(opts: GlobalOpts): Promise<ModelResolution> {
  const cliConfig = await loadCliConfig()
  return resolveModelSelection({
    cliModel: opts.model,
    cliProfile: opts.profile,
    envModel: process.env.AGILE_MODEL,
    envProfile: process.env.AGILE_MODEL_PROFILE,
    config: cliConfig,
    fallbackModel: "gpt-4o-mini",
  })
}

async function getRuntimeSettings(opts: GlobalOpts): Promise<{
  workDir: string
  model: string
  modelSource: string
}> {
  const workDir = opts.directory || process.cwd()
  const resolution = await resolveRuntimeModel(opts)
  return {
    workDir,
    model: resolution.model,
    modelSource: describeResolution(resolution),
  }
}

async function promptLine(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })
  try {
    return await new Promise<string>((resolve) => rl.question(question, resolve))
  } finally {
    rl.close()
  }
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
  .version(VERSION, "-v, --version", "output the version number")
  .option("--verbose", "Enable verbose output", false)
  .option("--dry-run", "Show what would be done without executing", false)
  .option("-d, --directory <path>", "Working directory", process.cwd())
  .option("-m, --model <model>", "OpenAI model or alias to use")
  .option("--profile <name>", "Named model profile to use")
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
    const opts = program.opts() as GlobalOpts
    const spinner = ora("Initializing agent...").start()

    try {
      const apiKey = await getApiKey()
      const { workDir, model, modelSource } = await getRuntimeSettings(opts)

      spinner.text = "Analyzing project structure..."
      const context = await detectCodebaseContext(workDir)
      const memory = createEmptyMemory(workDir)
      memory.codebaseContext = context

      const callbacks = buildCallbacks(opts.verbose, opts.interactive !== false)
      const agent = createAgent(
        apiKey,
        {
          model,
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
      console.log(chalk.gray(`Model: ${model}`))
      console.log(chalk.gray(`Model Source: ${modelSource}`))
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
    const opts = program.opts() as GlobalOpts
    const spinner = ora("Initializing deployment...").start()

    try {
      const apiKey = await getApiKey()
      const { workDir, model, modelSource } = await getRuntimeSettings(opts)

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
          model,
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
      console.log(chalk.gray(`Model: ${model}`))
      console.log(chalk.gray(`Model Source: ${modelSource}`))

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
    const opts = program.opts() as GlobalOpts

    try {
      const apiKey = await getApiKey()
      const { workDir, model, modelSource } = await getRuntimeSettings(opts)
      const memory = createEmptyMemory(workDir)

      const callbacks = buildCallbacks(opts.verbose, opts.interactive !== false)
      const agent = createAgent(
        apiKey,
        {
          model,
          maxSteps: Number.parseInt(opts.maxSteps, 10),
          verbose: opts.verbose,
          dryRun: opts.dryRun,
          workingDirectory: workDir,
        },
        callbacks,
      )

      console.log(chalk.gray(`Model: ${model}`))
      console.log(chalk.gray(`Model Source: ${modelSource}`))
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
    const opts = program.opts() as GlobalOpts
    const spinner = ora("Analyzing issues...").start()

    try {
      const apiKey = await getApiKey()
      const { workDir, model, modelSource } = await getRuntimeSettings(opts)

      const context = await detectCodebaseContext(workDir)
      const memory = createEmptyMemory(workDir)
      memory.codebaseContext = context

      const callbacks = buildCallbacks(opts.verbose, opts.interactive !== false)
      const agent = createAgent(
        apiKey,
        {
          model,
          maxSteps: Number.parseInt(opts.maxSteps, 10),
          verbose: opts.verbose,
          dryRun: opts.dryRun,
          workingDirectory: workDir,
        },
        callbacks,
      )

      spinner.succeed("Ready to fix issues")
      console.log(chalk.gray(`Model: ${model}`))
      console.log(chalk.gray(`Model Source: ${modelSource}`))

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
    const opts = program.opts() as GlobalOpts

    try {
      const apiKey = await getApiKey()
      const { workDir, model, modelSource } = await getRuntimeSettings(opts)

      console.log(chalk.gray("Analyzing project...\n"))
      const context = await detectCodebaseContext(workDir)

      console.log(chalk.gray(`Framework: ${context.framework || "Unknown"}`))
      console.log(chalk.gray(`Package Manager: ${context.packageManager || "Unknown"}`))
      console.log(chalk.gray(`Model: ${model}`))
      console.log(chalk.gray(`Model Source: ${modelSource}`))
      console.log()

      const callbacks = buildCallbacks(opts.verbose, true)
      const agent = createAgent(
        apiKey,
        {
          model,
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
    const opts = program.opts() as GlobalOpts
    const spinner = ora("Starting task...").start()

    try {
      const apiKey = await getApiKey()
      const { workDir, model, modelSource } = await getRuntimeSettings(opts)

      const context = await detectCodebaseContext(workDir)

      const callbacks = buildCallbacks(opts.verbose, opts.interactive !== false)
      const agent = createAgent(
        apiKey,
        {
          model,
          maxSteps: Number.parseInt(opts.maxSteps, 10),
          verbose: opts.verbose,
          dryRun: opts.dryRun,
          workingDirectory: workDir,
        },
        callbacks,
      )

      spinner.succeed("Agent ready")
      console.log(chalk.gray(`Framework: ${context.framework || "Unknown"}`))
      console.log(chalk.gray(`Model: ${model}`))
      console.log(chalk.gray(`Model Source: ${modelSource}`))

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

/**
 * SETUP command
 */
program
  .command("setup")
  .description("Set API key and optional default model in one command")
  .option("--api-key <key>", "OpenAI API key to store in AGILE config")
  .option("--model <model>", "Default model id to store")
  .action(async (cmdOpts: { apiKey?: string; model?: string }) => {
    printBanner()
    const config = await loadCliConfig()

    let apiKey = cmdOpts.apiKey?.trim()
    if (!apiKey) {
      const typed = (await promptLine("OpenAI API key (starts with sk-): ")).trim()
      if (typed) {
        apiKey = typed
      }
    }

    if (!apiKey && !config.apiKey) {
      console.error(chalk.red("No API key provided. Run again with --api-key or enter a value at the prompt."))
      process.exit(1)
    }

    if (apiKey) {
      config.apiKey = apiKey
    }

    if (cmdOpts.model) {
      config.defaultModelRef = cmdOpts.model
      config.defaultProfile = undefined
    }

    await saveCliConfig(config)

    console.log(chalk.green("Setup saved."))
    console.log(chalk.gray(`Config: ${getCliConfigPath()}`))
    console.log(chalk.gray(`API Key: ${maskApiKey(config.apiKey)}`))
    if (config.defaultModelRef) {
      console.log(chalk.gray(`Default Model: ${config.defaultModelRef}`))
    }
  })

/**
 * USE command
 */
program
  .command("use")
  .description("Set default model in one command")
  .argument("<model>", "Model id (or alias)")
  .action(async (model: string) => {
    printBanner()
    const config = await loadCliConfig()
    config.defaultModelRef = model
    config.defaultProfile = undefined
    await saveCliConfig(config)
    console.log(chalk.green(`Default model set to ${model}`))
  })

/**
 * AUTH command
 */
const authCommand = program
  .command("auth")
  .description("Inspect env-based authentication and model env settings")

authCommand
  .command("status")
  .description("Show current auth and env source status")
  .action(async () => {
    printBanner()

    const resolvedApiKey = await resolveApiKey()
    const envModel = process.env.AGILE_MODEL
    const envProfile = process.env.AGILE_MODEL_PROFILE

    console.log(chalk.cyan.bold("Auth Status\n"))
    console.log(chalk.gray("API key precedence: shell > .env.local > .env > AGILE config"))
    console.log()
    const keySourceLabel =
      resolvedApiKey.source === "config"
        ? "AGILE config"
        : resolvedApiKey.source === "unset"
          ? "unset"
          : formatEnvSource(resolvedApiKey.source)
    console.log(`OPENAI_API_KEY: ${resolvedApiKey.value ? chalk.green("set") : chalk.red("missing")}`)
    console.log(`  Value: ${maskApiKey(resolvedApiKey.value)}`)
    console.log(`  Source: ${keySourceLabel}`)
    console.log(`AGILE_MODEL: ${envModel || "(unset)"}`)
    console.log(`  Source: ${formatEnvSource(envLoadState.sourceByKey.AGILE_MODEL)}`)
    console.log(`AGILE_MODEL_PROFILE: ${envProfile || "(unset)"}`)
    console.log(`  Source: ${formatEnvSource(envLoadState.sourceByKey.AGILE_MODEL_PROFILE)}`)

    const fileSummary = envLoadState.files
      .map((file) => `${file.path}: ${file.exists ? `found (${file.parsedKeys} keys)` : "not found"}`)
      .join("\n")

    console.log(`\nEnv Files:\n${fileSummary}`)
    console.log(chalk.gray(`Model config file: ${getCliConfigPath()}`))
  })

authCommand
  .command("doctor")
  .description("Run auth and env diagnostics with actionable guidance")
  .action(async () => {
    printBanner()
    const opts = program.opts() as GlobalOpts
    const checks: Array<{ level: "ok" | "warn" | "error"; message: string }> = []

    const apiKey = await resolveApiKey()
    if (!apiKey.value) {
      checks.push({ level: "error", message: "OPENAI_API_KEY is missing." })
    } else {
      checks.push({
        level: "ok",
        message: `OPENAI_API_KEY is set via ${
          apiKey.source === "config" ? "AGILE config" : apiKey.source === "unset" ? "unset" : formatEnvSource(apiKey.source)
        }.`,
      })
      if (apiKey.value.length < 20) {
        checks.push({ level: "warn", message: "OPENAI_API_KEY looks unusually short. Verify the value." })
      }
    }

    if (process.env.AGILE_MODEL && process.env.AGILE_MODEL_PROFILE) {
      checks.push({
        level: "warn",
        message: "Both AGILE_MODEL and AGILE_MODEL_PROFILE are set; AGILE_MODEL takes precedence.",
      })
    }

    try {
      const resolution = await resolveRuntimeModel(opts)
      checks.push({
        level: "ok",
        message: `Effective model resolves to ${resolution.model} (${describeResolution(resolution)}).`,
      })
    } catch (error) {
      checks.push({
        level: "error",
        message: `Model resolution failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      })
    }

    checks.push({ level: "ok", message: `AGILE config path: ${getCliConfigPath()}` })

    console.log(chalk.cyan.bold("Auth Doctor\n"))

    checks.forEach((check) => {
      const icon = check.level === "ok" ? chalk.green("[OK]") : check.level === "warn" ? chalk.yellow("[WARN]") : chalk.red("[ERROR]")
      console.log(`${icon} ${check.message}`)
    })

    const hasErrors = checks.some((c) => c.level === "error")
    if (hasErrors) {
      console.log(chalk.red("\nDoctor found blocking issues."))
      process.exit(1)
    }

    console.log(chalk.green("\nDoctor checks passed."))
  })

/**
 * MODEL command
 */
const modelCommand = program
  .command("model")
  .description("Manage model profiles, aliases, and defaults")

modelCommand
  .command("list")
  .description("List model defaults, profiles, and aliases")
  .action(async () => {
    printBanner()
    const config = await loadCliConfig()

    console.log(chalk.cyan.bold("Model Configuration\n"))
    console.log(chalk.gray(`Config File: ${getCliConfigPath()}`))
    console.log(chalk.gray(`Default Profile: ${config.defaultProfile || "(none)"}`))
    console.log(chalk.gray(`Default Model: ${config.defaultModelRef || "(none)"}`))

    const profileNames = Object.keys(config.profiles).sort()
    if (profileNames.length === 0) {
      console.log(chalk.yellow("\nNo profiles configured."))
    } else {
      console.log(chalk.cyan("\nProfiles:"))
      profileNames.forEach((name) => {
        const profile = config.profiles[name]
        const marker = config.defaultProfile === name ? " (default)" : ""
        const desc = profile.description ? ` - ${profile.description}` : ""
        console.log(`  - ${name}${marker}: ${profile.model}${desc}`)
      })
    }

    const aliasNames = Object.keys(config.aliases).sort()
    if (aliasNames.length === 0) {
      console.log(chalk.yellow("\nNo aliases configured."))
    } else {
      console.log(chalk.cyan("\nAliases:"))
      aliasNames.forEach((name) => {
        console.log(`  - ${name} -> ${config.aliases[name]}`)
      })
    }
  })

modelCommand
  .command("inspect")
  .description("Inspect active model resolution or a specific profile/alias")
  .argument("[target]", "Profile or alias name to inspect")
  .action(async (target?: string) => {
    printBanner()
    const opts = program.opts() as GlobalOpts
    const config = await loadCliConfig()

    if (target) {
      if (config.profiles[target]) {
        const profile = config.profiles[target]
        console.log(chalk.cyan.bold("Profile\n"))
        console.log(`Name: ${target}`)
        console.log(`Model: ${profile.model}`)
        console.log(`Description: ${profile.description || "(none)"}`)
        console.log(`Updated: ${profile.updatedAt}`)
        return
      }

      if (config.aliases[target]) {
        console.log(chalk.cyan.bold("Alias\n"))
        console.log(`Name: ${target}`)
        console.log(`Model: ${config.aliases[target]}`)
        return
      }

      console.error(chalk.red(`Unknown profile or alias: ${target}`))
      process.exit(1)
    }

    const resolution = await resolveRuntimeModel(opts)
    console.log(chalk.cyan.bold("Active Model Resolution\n"))
    console.log(`Model: ${resolution.model}`)
    console.log(`Source: ${describeResolution(resolution)}`)
  })

modelCommand
  .command("set-default")
  .description("Set default model ref (model/alias) or profile")
  .argument("<target>", "Model, alias, or profile name")
  .option("--profile", "Treat target as profile name")
  .action(async (target: string, cmdOpts: { profile?: boolean }) => {
    printBanner()
    const config = await loadCliConfig()

    if (cmdOpts.profile) {
      if (!config.profiles[target]) {
        console.error(chalk.red(`Unknown profile: ${target}`))
        process.exit(1)
      }
      config.defaultProfile = target
      config.defaultModelRef = undefined
      await saveCliConfig(config)
      console.log(chalk.green(`Default profile set to ${target}`))
      return
    }

    config.defaultModelRef = target
    config.defaultProfile = undefined
    await saveCliConfig(config)
    console.log(chalk.green(`Default model ref set to ${target}`))
  })

modelCommand
  .command("clear-default")
  .description("Clear model/profile defaults")
  .action(async () => {
    printBanner()
    const config = await loadCliConfig()
    config.defaultModelRef = undefined
    config.defaultProfile = undefined
    await saveCliConfig(config)
    console.log(chalk.green("Cleared default model/profile."))
  })

const profileCommand = modelCommand.command("profile").description("Manage model profiles")

profileCommand
  .command("set")
  .description("Create or update a model profile")
  .argument("<name>", "Profile name")
  .argument("<model>", "Model id")
  .option("-d, --description <text>", "Optional profile description")
  .action(async (name: string, model: string, cmdOpts: { description?: string }) => {
    printBanner()
    const validationError = validateName(name, "profile")
    if (validationError) {
      console.error(chalk.red(validationError))
      process.exit(1)
    }

    const config = await loadCliConfig()
    config.profiles[name] = {
      model,
      description: cmdOpts.description,
      updatedAt: new Date().toISOString(),
    }
    await saveCliConfig(config)
    console.log(chalk.green(`Profile ${name} -> ${model} saved.`))
  })

profileCommand
  .command("remove")
  .description("Remove a model profile")
  .argument("<name>", "Profile name")
  .action(async (name: string) => {
    printBanner()
    const config = await loadCliConfig()

    if (!config.profiles[name]) {
      console.error(chalk.red(`Unknown profile: ${name}`))
      process.exit(1)
    }

    delete config.profiles[name]
    if (config.defaultProfile === name) {
      config.defaultProfile = undefined
    }
    await saveCliConfig(config)
    console.log(chalk.green(`Profile ${name} removed.`))
  })

const aliasCommand = modelCommand.command("alias").description("Manage model aliases")

aliasCommand
  .command("set")
  .description("Create or update a model alias")
  .argument("<name>", "Alias name")
  .argument("<model>", "Model id target")
  .action(async (name: string, model: string) => {
    printBanner()
    const validationError = validateName(name, "alias")
    if (validationError) {
      console.error(chalk.red(validationError))
      process.exit(1)
    }

    const config = await loadCliConfig()
    config.aliases[name] = model
    await saveCliConfig(config)
    console.log(chalk.green(`Alias ${name} -> ${model} saved.`))
  })

aliasCommand
  .command("remove")
  .description("Remove a model alias")
  .argument("<name>", "Alias name")
  .action(async (name: string) => {
    printBanner()
    const config = await loadCliConfig()

    if (!config.aliases[name]) {
      console.error(chalk.red(`Unknown alias: ${name}`))
      process.exit(1)
    }

    delete config.aliases[name]
    await saveCliConfig(config)
    console.log(chalk.green(`Alias ${name} removed.`))
  })

// Parse arguments and run
program.parse()
