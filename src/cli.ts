#!/usr/bin/env node

import { Command } from "commander"
import chalk from "chalk"
import * as readline from "readline"
import * as fs from "fs"
import { parse as parseEnv } from "dotenv"
import {
  getCliConfigPath,
  loadCliConfig,
  maskApiKey,
  resolveModelSelection,
  saveCliConfig,
  type LifetimeUsage,
} from "./config/models"
import {
  createAgent,
  createInteractiveInputHandler,
  type AgentCallbacks,
  type UsageStats,
} from "./agent"
import packageJson from "../package.json"

// â”€â”€ Env Loading â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

type EnvSource = "shell" | ".env" | ".env.local" | "config" | "unset"
const _sourceByKey = new Map<string, string>()

function initEnv(): void {
  for (const key of Object.keys(process.env)) {
    _sourceByKey.set(key, "shell")
  }
  const files: Array<{ path: string; source: string }> = [
    { path: ".env", source: ".env" },
    { path: ".env.local", source: ".env.local" },
  ]
  for (const file of files) {
    if (!fs.existsSync(file.path)) continue
    try {
      const raw = fs.readFileSync(file.path, "utf-8")
      const parsed = parseEnv(raw)
      for (const [key, value] of Object.entries(parsed)) {
        const existing = _sourceByKey.get(key)
        if (!existing || (existing === ".env" && file.source === ".env.local")) {
          process.env[key] = value
          _sourceByKey.set(key, file.source)
        }
      }
    } catch {
      // ignore unreadable env files
    }
  }
}

initEnv()

// â”€â”€ Constants â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const VERSION = packageJson.version

// â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function rl_question(rl: readline.Interface, question: string): Promise<string> {
  return new Promise<string>((resolve) => rl.question(question, resolve))
}

async function resolveApiKey(): Promise<{ value?: string; source: EnvSource }> {
  const envKey = process.env.OPENAI_API_KEY
  if (envKey) {
    return { value: envKey, source: (_sourceByKey.get("OPENAI_API_KEY") as EnvSource) || "shell" }
  }
  const config = await loadCliConfig()
  if (config.apiKey) return { value: config.apiKey, source: "config" }
  return { source: "unset" }
}

function isBillingError(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase()
    return (
      msg.includes("insufficient_quota") ||
      msg.includes("exceeded your current quota") ||
      msg.includes("you exceeded your current quota")
    )
  }
  const apiErr = err as { status?: number; error?: { code?: string } }
  return apiErr?.status === 429 && apiErr?.error?.code === "insufficient_quota"
}

async function resolveModel(cliModel?: string): Promise<string> {
  const config = await loadCliConfig()
  const resolution = resolveModelSelection({
    cliModel,
    envModel: process.env.AGILE_MODEL,
    config,
    fallbackModel: "gpt-4o-mini",
  })
  return resolution.model
}

// -- Model Picker -------------------------------------------------------------

const KNOWN_MODELS = [
  { id: "gpt-4o-mini",  label: "GPT-4o mini",   desc: "Cheapest & fastest, great for most tasks",    price: "$0.15/1M in" },
  { id: "gpt-4o",       label: "GPT-4o",         desc: "Best overall, fast",                          price: "$2.50/1M in" },
  { id: "gpt-5-mini",   label: "GPT-5 mini",     desc: "Fast + very capable",                        price: "$0.50/1M in" },
  { id: "gpt-5",        label: "GPT-5",           desc: "Most capable",                               price: "$5.00/1M in" },
  { id: "o1-mini",      label: "o1-mini",         desc: "Chain-of-thought reasoning",                 price: "$3.00/1M in" },
  { id: "o1-preview",   label: "o1-preview",      desc: "Advanced reasoning",                        price: "$15.00/1M in" },
  { id: "gpt-4-turbo",  label: "GPT-4 Turbo",    desc: "High quality, long context",                 price: "$10.00/1M in" },
]

async function selectModel(rl: readline.Interface, currentModel: string): Promise<string> {
  console.log()
  console.log(chalk.bold("  Choose a model:"))
  console.log()
  KNOWN_MODELS.forEach((m, i) => {
    const active = m.id === currentModel
    const marker = active ? chalk.cyan("*") : " "
    const num = chalk.dim(`${i + 1}.`)
    const label = active ? chalk.cyan.bold(m.label.padEnd(14)) : chalk.white(m.label.padEnd(14))
    console.log(`  ${marker} ${num} ${label}  ${chalk.gray(m.desc.padEnd(42))}  ${chalk.dim(m.price)}`)
  })
  console.log()
  const ans = (await rl_question(rl, chalk.bold(`  [1-${KNOWN_MODELS.length}] or model ID: `))).trim()
  if (!ans) return currentModel
  const n = parseInt(ans, 10)
  if (!isNaN(n) && n >= 1 && n <= KNOWN_MODELS.length) return KNOWN_MODELS[n - 1].id
  return ans // allow typing a custom model ID
}

// â”€â”€ First-launch Setup Wizard â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function runSetupWizard(): Promise<{ apiKey: string; model: string }> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

  console.log()
  console.log(chalk.bold.cyan("  Welcome to agile!"))
  console.log()
  console.log(chalk.gray("  To get started, you need an OpenAI API key."))
  console.log(chalk.gray("  Get one at: ") + chalk.underline("https://platform.openai.com/api-keys"))
  console.log()

  let apiKey = ""
  while (!apiKey) {
    const raw = await rl_question(rl, chalk.bold("  API key: "))
    apiKey = raw.trim()
    if (!apiKey) console.log(chalk.red("  API key is required."))
  }

  const config = await loadCliConfig()
  const currentModel = config.defaultModelRef || "gpt-4o-mini"

  const model = await selectModel(rl, currentModel)

  rl.close()

  config.apiKey = apiKey
  config.defaultModelRef = model
  await saveCliConfig(config)

  console.log()
  console.log(chalk.green("  Setup complete!"))
  console.log(chalk.gray(`  Config saved to: ${getCliConfigPath()}`))
  console.log()

  return { apiKey, model }
}

// â”€â”€ Session Header â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function printWelcome(model: string, workDir: string): void {
  const home = process.env.HOME || process.env.USERPROFILE || ""
  const displayDir = workDir.startsWith(home) ? `~${workDir.slice(home.length)}` : workDir

  console.log()
  console.log(chalk.bold("  agile") + chalk.gray(` v${VERSION}`))
  console.log(chalk.gray(`  ${displayDir}`))
  console.log(chalk.gray(`  Model: ${model}`))
  console.log()
  console.log(chalk.dim("  /help for commands  |  /settings to configure"))
  console.log()
}

// â”€â”€ Agent Callbacks â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const TOOL_LABELS: Record<string, string> = {
  read_file: "Reading",
  write_file: "Writing",
  list_directory: "Listing",
  analyze_project: "Analyzing",
  execute_command: "Running",
  shell_command: "Running",
  git_command: "Git",
  http_request: "Fetching",
  search_files: "Searching",
  find_files: "Searching",
  delete_file: "Deleting",
  create_directory: "Creating",
  move_file: "Moving",
  copy_file: "Copying",
}

function buildCallbacks(verbose: boolean): AgentCallbacks {
  const warnedThresholds = new Set<number>()
  const COST_WARN_THRESHOLDS = [1, 5, 10]

  return {
    onStep: () => {},
    onThinking: (thought) => {
      if (verbose) console.log(chalk.dim(`\n  ~ ${thought}`))
    },
    onToolCall: (name, args) => {
      const label = TOOL_LABELS[name] || name
      let detail = ""
      if (typeof args.path === "string") detail = ` ${args.path}`
      else if (typeof args.command === "string") detail = ` ${String(args.command).slice(0, 60)}`
      else if (typeof args.url === "string") detail = ` ${args.url}`
      else if (typeof args.directory === "string") detail = ` ${args.directory}`
      else if (typeof args.query === "string") detail = ` ${args.query}`
      console.log(chalk.gray(`  > ${label}${detail}`))
    },
    onToolResult: (_name, success, output) => {
      if (!success) {
        const preview = output.replace(/\n/g, " ").slice(0, 120)
        console.log(chalk.red(`  ! ${preview}`))
      }
    },
    onApiCall: ({ costUSD, promptTokens, completionTokens, totalCostUSD }) => {
      const tokens = promptTokens + completionTokens
      if (tokens > 0) {
        const kTok = (tokens / 1000).toFixed(1)
        console.log(chalk.dim(`     $${costUSD.toFixed(5)}  ${kTok}k tokens`))
      }
      for (const threshold of COST_WARN_THRESHOLDS) {
        if (totalCostUSD >= threshold && !warnedThresholds.has(threshold)) {
          warnedThresholds.add(threshold)
          console.log(chalk.yellow(`\n  ! Session spend exceeded $${threshold}.00 — check /settings for usage.\n`))
        }
      }
    },
    onUserQuestion: createInteractiveInputHandler(),
  }
}

// â”€â”€ Settings Panel â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function showSettings(rl: readline.Interface, sessionUsage: UsageStats): Promise<void> {
  const config = await loadCliConfig()
  const apiResolved = await resolveApiKey()
  const model = config.defaultModelRef || "gpt-4o-mini"
  const lifetime = config.lifetimeUsage

  const sep = chalk.gray("  " + "-".repeat(46))

  console.log()
  console.log(chalk.bold("  Settings"))
  console.log(sep)
  console.log(`  Model      ${chalk.cyan(model)}`)
  console.log(
    `  API Key    ${chalk.dim(maskApiKey(apiResolved.value))}  ${chalk.gray(`(${apiResolved.source})`)}`,
  )
  console.log(`  Config     ${chalk.gray(getCliConfigPath())}`)

  console.log()
  console.log(chalk.bold("  Session usage"))
  console.log(
    `  ${sessionUsage.apiCalls} calls  ${sessionUsage.totalTokens.toLocaleString("en-US")} tokens  ~$${sessionUsage.estimatedCostUSD.toFixed(4)}`,

  )

  if (lifetime && (lifetime.sessions > 0 || lifetime.totalTokens > 0)) {
    // Merge saved lifetime with current session so the display is up-to-date
    const liveSessions = lifetime.sessions + 1
    const liveTokens = lifetime.totalTokens + sessionUsage.totalTokens
    const liveCost = lifetime.estimatedCostUSD + sessionUsage.estimatedCostUSD
    console.log()
    console.log(chalk.bold("  Lifetime usage"))
    console.log(
      `  ${liveSessions} sessions  ${liveTokens.toLocaleString("en-US")} tokens  ~$${liveCost.toFixed(4)}`,
    )
  }

  console.log(sep)
  console.log()
  console.log(chalk.dim("  [m] Change model    [k] Change API key    [enter] Back"))
  console.log()

  const choice = (await rl_question(rl, chalk.bold("  > "))).trim().toLowerCase()

  if (choice === "m") {
    const newModel = await selectModel(rl, model)
    if (newModel !== model) {
      config.defaultModelRef = newModel
      await saveCliConfig(config)
      console.log(chalk.green(`  Model set to ${newModel}  (takes effect next session)`))
    }
  } else if (choice === "k") {
    const raw = (await rl_question(rl, "  New API key: ")).trim()
    if (raw) {
      config.apiKey = raw
      process.env.OPENAI_API_KEY = raw
      await saveCliConfig(config)
      console.log(chalk.green("  API key updated"))
    }
  }

  console.log()
}

// â”€â”€ Help â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function printHelp(): void {
  console.log()
  console.log(chalk.bold("  Commands"))
  console.log(chalk.gray("  " + "-".repeat(36)))
  console.log(`  ${chalk.cyan("/settings")}    Model, API key, usage stats`)
  console.log(`  ${chalk.cyan("/clear")}       Clear conversation history`)
  console.log(`  ${chalk.cyan("/usage")}       Token usage for this session`)
  console.log(`  ${chalk.cyan("/help")}        Show this message`)
  console.log(`  ${chalk.cyan("exit")}         Quit`)
  console.log()
  console.log(chalk.dim("  Just type naturally - no special commands needed for tasks."))
  console.log()
}

// â”€â”€ Print one-shot result â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function printResult(
  result: { success: boolean; summary: string; details?: string[]; errors?: string[] },
  usage: UsageStats,
): void {
  console.log()
  if (result.success) {
    console.log(chalk.bold.green("  ok  ") + result.summary)
  } else {
    console.log(chalk.bold.red("  fail  ") + result.summary)
  }
  if (result.details?.length) {
    result.details.forEach((d) => console.log(chalk.gray(`    ${d}`)))
  }
  if (result.errors?.length) {
    result.errors.forEach((e) => console.log(chalk.red(`    ${e}`)))
  }
  console.log(
    chalk.dim(
      `\n  ${usage.apiCalls} calls  ${usage.totalTokens.toLocaleString("en-US")} tokens  ~$${usage.estimatedCostUSD.toFixed(4)}\n`,

    ),
  )
}

// â”€â”€ Save lifetime usage â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function saveLifetimeUsage(usage: UsageStats): Promise<void> {
  if (usage.totalTokens === 0) return
  try {
    const config = await loadCliConfig()
    const prev: LifetimeUsage = config.lifetimeUsage || { sessions: 0, totalTokens: 0, estimatedCostUSD: 0 }
    config.lifetimeUsage = {
      sessions: prev.sessions + 1,
      totalTokens: prev.totalTokens + usage.totalTokens,
      estimatedCostUSD: prev.estimatedCostUSD + usage.estimatedCostUSD,
    }
    await saveCliConfig(config)
  } catch {
    // non-fatal
  }
}

// â”€â”€ Interactive REPL â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function startRepl(
  apiKey: string,
  model: string,
  workDir: string,
  verbose: boolean,
  dryRun: boolean,
): Promise<void> {
  const callbacks = buildCallbacks(verbose)
  const agent = createAgent(
    apiKey,
    { model, maxSteps: 30, verbose, dryRun, workingDirectory: workDir },
    callbacks,
  )

  printWelcome(model, workDir)
  if (dryRun) console.log(chalk.yellow.bold("  [DRY RUN]\n"))

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

  // Generator that intercepts /help and /settings before the agent sees them
  async function* sessionIterator(): AsyncGenerator<string> {
    while (true) {
      const line = await new Promise<string | null>((resolve) => {
        rl.question(chalk.bold(chalk.cyan("  > ")), resolve)
        rl.once("close", () => resolve(null))
      })

      if (line === null) break
      const trimmed = line.trim()
      if (!trimmed) continue

      if (trimmed === "/help") {
        printHelp()
        continue
      }

      if (trimmed === "/settings") {
        await showSettings(rl, agent.getUsage().getStats())
        continue
      }

      // Pass /clear, /usage, exit, quit, and real tasks to agent
      yield trimmed
    }
  }

  try {
    await agent.interactiveSession(sessionIterator())
  } catch (err) {
    if (isBillingError(err)) {
      console.log(chalk.red.bold("\n  Insufficient API credits."))
      console.log(chalk.gray("  Add credits at: https://platform.openai.com/settings/organization/billing\n"))
    } else {
      throw err
    }
  } finally {
    await saveLifetimeUsage(agent.getUsage().getStats())
    rl.close()
  }
}

// â”€â”€ One-shot Task â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function runTask(
  task: string,
  apiKey: string,
  model: string,
  workDir: string,
  verbose: boolean,
  dryRun: boolean,
): Promise<void> {
  const callbacks = buildCallbacks(verbose)
  const agent = createAgent(
    apiKey,
    { model, maxSteps: 30, verbose, dryRun, workingDirectory: workDir },
    callbacks,
  )

  console.log()
  if (verbose) console.log(chalk.gray(`  Model: ${model}\n`))
  if (dryRun) console.log(chalk.yellow.bold("  [DRY RUN]\n"))

  let result
  try {
    result = await agent.executeTask(task)
  } catch (err) {
    if (isBillingError(err)) {
      console.log(chalk.red.bold("\n  Insufficient API credits."))
      console.log(chalk.gray("  Add credits at: https://platform.openai.com/settings/organization/billing\n"))
      process.exit(1)
    }
    throw err
  }
  const usage = agent.getUsage().getStats()

  printResult(result, usage)
  await saveLifetimeUsage(usage)

  process.exit(result.success ? 0 : 1)
}

// â”€â”€ CLI â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const program = new Command()

program
  .name("agile")
  .description("AI DevOps Agent")
  .version(VERSION, "-v, --version", "print version")
  .option("--verbose", "Show detailed output", false)
  .option("--dry-run", "Preview without executing", false)
  .option("-d, --directory <path>", "Working directory", process.cwd())
  .option("-m, --model <model>", "Model to use (overrides config)")

// â”€â”€ setup subcommand â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

program
  .command("setup")
  .description("Configure API key and default model")
  .action(async () => {
    await runSetupWizard()
  })

// â”€â”€ Default: REPL or one-shot â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

program
  .argument("[task...]", "Task to run (omit for interactive mode)")
  .action(async (taskParts: string[]) => {
    const opts = program.opts() as {
      verbose: boolean
      dryRun: boolean
      directory: string
      model?: string
    }

    const workDir = opts.directory

    // Ensure API key - auto-trigger setup wizard if missing
    let apiResolved = await resolveApiKey()
    if (!apiResolved.value) {
      const result = await runSetupWizard()
      apiResolved = { value: result.apiKey, source: "config" }
    }

    const apiKey = apiResolved.value!
    const model = await resolveModel(opts.model)
    const task = taskParts.join(" ").trim()

    if (task) {
      await runTask(task, apiKey, model, workDir, opts.verbose, opts.dryRun)
    } else {
      await startRepl(apiKey, model, workDir, opts.verbose, opts.dryRun)
    }
  })

program.parse()
