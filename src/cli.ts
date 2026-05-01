#!/usr/bin/env node

import { Command } from "commander"
import chalk from "chalk"
import * as readline from "readline"
import * as fs from "fs"
import OpenAI from "openai"
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

// -- Env Loading -------------------------------------------------------------

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

// -- Constants ---------------------------------------------------------------

const VERSION = packageJson.version

// -- Helpers -----------------------------------------------------------------

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

// -- Pricing hints (input / output per 1M tokens)  source: https://openai.com/api/pricing 
const MODEL_PRICE_HINT: Record<string, string> = {
  "gpt-3.5-turbo":                         "$0.50 / $1.50",
  "gpt-3.5-turbo-0125":                    "$0.50 / $1.50",
  "gpt-3.5-turbo-1106":                    "$0.50 / $1.50",
  "gpt-3.5-turbo-16k":                     "$3.00 / $4.00",
  "gpt-4":                                 "$30.00 / $60.00",
  "gpt-4-0613":                            "$30.00 / $60.00",
  "gpt-4-turbo":                           "$10.00 / $30.00",
  "gpt-4-turbo-2024-04-09":               "$10.00 / $30.00",
  "gpt-4.1":                               "$2.00 / $8.00",
  "gpt-4.1-2025-04-14":                    "$2.00 / $8.00",
  "gpt-4.1-mini":                          "$0.40 / $1.60",
  "gpt-4.1-mini-2025-04-14":               "$0.40 / $1.60",
  "gpt-4.1-nano":                          "$0.10 / $0.40",
  "gpt-4.1-nano-2025-04-14":               "$0.10 / $0.40",
  "gpt-4o":                                "$2.50 / $10.00",
  "gpt-4o-2024-05-13":                     "$2.50 / $10.00",
  "gpt-4o-2024-08-06":                     "$2.50 / $10.00",
  "gpt-4o-2024-11-20":                     "$2.50 / $10.00",
  "gpt-4o-mini":                           "$0.15 / $0.60",
  "gpt-4o-mini-2024-07-18":                "$0.15 / $0.60",
  "gpt-4o-search-preview":                 "$2.50 / $10.00",
  "gpt-4o-search-preview-2025-03-11":      "$2.50 / $10.00",
  "gpt-4o-mini-search-preview":            "$0.15 / $0.60",
  "gpt-4o-mini-search-preview-2025-03-11": "$0.15 / $0.60",
  "gpt-5":                                 "$5.00 / $20.00",
  "gpt-5-2025-08-07":                      "$5.00 / $20.00",
  "gpt-5-chat-latest":                     "$5.00 / $20.00",
  "gpt-5-mini":                            "$0.50 / $2.00",
  "gpt-5-mini-2025-08-07":                 "$0.50 / $2.00",
  "gpt-5-nano":                            "$0.20 / $1.00",
  "gpt-5-nano-2025-08-07":                 "$0.20 / $1.00",
  "gpt-5-pro":                             "$30.00 / $150.00",
  "gpt-5.3-chat-latest":                   "$1.75 / $14.00",
  "gpt-5.4":                               "$2.50 / $15.00",
  "gpt-5.4-2026-03-05":                    "$2.50 / $15.00",
  "gpt-5.4-mini":                          "$0.75 / $4.50",
  "gpt-5.4-mini-2026-03-17":               "$0.75 / $4.50",
  "gpt-5.4-nano":                          "$0.20 / $1.25",
  "gpt-5.4-nano-2026-03-17":               "$0.20 / $1.25",
  "gpt-5.4-pro":                           "$30.00 / $180.00",
  "gpt-5.5":                               "$5.00 / $30.00",
  "gpt-5.5-2026-04-23":                    "$5.00 / $30.00",
  "gpt-5.5-pro":                           "$30.00 / $180.00",
  "o1":                                    "$15.00 / $60.00",
  "o1-2024-12-17":                         "$15.00 / $60.00",
  "o1-mini":                               "$3.00 / $12.00",
  "o1-preview":                            "$15.00 / $60.00",
  "o1-pro":                                "$150.00 / $600.00",
  "o1-pro-2025-03-19":                     "$150.00 / $600.00",
  "o3":                                    "$10.00 / $40.00",
  "o3-2025-04-16":                         "$10.00 / $40.00",
  "o3-mini":                               "$1.10 / $4.40",
  "o3-mini-2025-01-31":                    "$1.10 / $4.40",
  "o4-mini":                               "$1.10 / $4.40",
  "o4-mini-2025-04-16":                    "$1.10 / $4.40",
}

// Substrings / prefixes that identify non-chat models to hide from the picker
const EXCLUDE_CONTAINS = ["-audio", "-realtime", "-transcribe", "-tts", "-instruct", "-codex", "-search-api"]
const EXCLUDE_PREFIXES = [
  "tts-", "whisper-", "dall-e", "text-embedding", "babbage", "davinci", "curie", "ada",
  "chatgpt-image", "gpt-audio", "gpt-image", "gpt-realtime", "sora", "omni-moderation",
]

async function fetchChatModels(apiKey: string): Promise<string[]> {
  try {
    const oai = new OpenAI({ apiKey })
    const page = await oai.models.list()
    return page.data
      .map((m) => m.id)
      .filter((id) => {
        if (EXCLUDE_PREFIXES.some((p) => id.startsWith(p))) return false
        if (EXCLUDE_CONTAINS.some((s) => id.includes(s))) return false
        return true
      })
      .sort()
  } catch {
    return []
  }
}

async function selectModel(rl: readline.Interface, currentModel: string, apiKey?: string): Promise<string> {
  console.log()
  console.log(chalk.dim("  Fetching models..."))

  const key = apiKey || (await resolveApiKey()).value
  const models = key ? await fetchChatModels(key) : []

  if (models.length === 0) {
    // Fallback: plain text input
    const ans = (await rl_question(rl, chalk.bold(`  Model ID [${currentModel}]: `))).trim()
    return ans || currentModel
  }

  process.stdout.write("\x1B[1A\x1B[2K") // clear "Fetching..." line

  console.log(chalk.bold("  Choose a model:"))
  console.log()

  models.forEach((id, i) => {
    const active = id === currentModel
    const marker = active ? chalk.cyan("*") : " "
    const num = chalk.dim(`${(i + 1).toString().padStart(3)}.`)
    const label = active ? chalk.cyan.bold(id.padEnd(44)) : chalk.white(id.padEnd(44))
    const price = chalk.dim(MODEL_PRICE_HINT[id] || "")
    console.log(`  ${marker} ${num} ${label}  ${price}`)
  })

  console.log()
  const ans = (await rl_question(rl, chalk.bold(`  [1-${models.length}] or model ID: `))).trim()
  if (!ans) return currentModel
  const n = parseInt(ans, 10)
  if (!isNaN(n) && n >= 1 && n <= models.length) return models[n - 1]
  return ans
}

// -- First-launch Setup Wizard -----------------------------------------------

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

  const model = await selectModel(rl, currentModel, apiKey)

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

// -- Session Header ----------------------------------------------------------

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

// -- Agent Callbacks ---------------------------------------------------------

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

function buildCallbacks(verbose: boolean, rl?: readline.Interface): AgentCallbacks {
  const warnedThresholds = new Set<number>()
  const COST_WARN_THRESHOLDS = [1, 5, 10]

  // ---- file-change tracking ------------------------------------------------
  type FileDelta = { op: "edited" | "created" | "deleted"; added: number; removed: number }
  const fileChanges = new Map<string, FileDelta>()

  function recordFileChange(path: string, op: "edited" | "created" | "deleted", added: number, removed: number) {
    const prev = fileChanges.get(path)
    if (prev) {
      // Merge: keep "created" if it was already created in this task
      fileChanges.set(path, { op: prev.op === "created" ? "created" : op, added: prev.added + added, removed: prev.removed + removed })
    } else {
      fileChanges.set(path, { op, added, removed })
    }
  }
  // --------------------------------------------------------------------------

  // Track whether a dim "..." waiting indicator is on the current line
  let waitingShown = false
  function clearWaiting() {
    if (waitingShown) {
      process.stdout.write("\r\x1b[2K")
      waitingShown = false
    }
  }

  return {
    onStep: () => {},
    onApiStart: () => {
      process.stdout.write(chalk.dim("  ..."))
      waitingShown = true
    },
    onThinking: (thought, plan) => {
      clearWaiting()
      console.log(chalk.dim("  ~ " + thought))
      if (plan && plan.length > 0) {
        plan.forEach((step, i) => console.log(chalk.dim(`    ${i + 1}. ${step}`)))
      }
    },
    onStreamStart: () => {
      clearWaiting()
      process.stdout.write("  ")
    },
    onStreamChunk: (text) => {
      process.stdout.write(text)
    },
    onStreamEnd: () => {
      process.stdout.write("\n")
    },
    onToolCall: (name, args) => {
      clearWaiting()
      const label = TOOL_LABELS[name] || name
      let detail = ""
      if (typeof args.path === "string") detail = ` ${args.path}`
      else if (typeof args.command === "string") detail = ` ${String(args.command).slice(0, 60)}`
      else if (typeof args.url === "string") detail = ` ${args.url}`
      else if (typeof args.directory === "string") detail = ` ${args.directory}`
      else if (typeof args.query === "string") detail = ` ${args.query}`
      console.log(chalk.gray(`  > ${label}${detail}`))
    },
    onToolResult: (name, success, output, args) => {
      if (!success) {
        const preview = output.replace(/\n/g, " ").slice(0, 120)
        console.log(chalk.red(`  ! ${preview}`))
        return
      }

      // File-edit: show inline line delta and record for summary
      if (name === "replace_in_file" && typeof args.path === "string") {
        const oldStr = typeof args.old_str === "string" ? args.old_str : ""
        const newStr = typeof args.new_str === "string" ? args.new_str : ""
        const removed = oldStr ? oldStr.split("\n").length : 0
        const added = newStr ? newStr.split("\n").length : 0
        const parts: string[] = []
        if (added > 0) parts.push(chalk.green(`+${added}`))
        if (removed > 0) parts.push(chalk.red(`-${removed}`))
        if (parts.length > 0) console.log(chalk.dim(`    ↳ ${parts.join("  ")} lines`))
        recordFileChange(args.path, "edited", added, removed)

      } else if (name === "write_file" && typeof args.path === "string") {
        const content = typeof args.content === "string" ? args.content : ""
        const lines = content.split("\n").length
        console.log(chalk.dim(`    ↳ ${lines} lines`))
        // Treat as "created" initially; if later replaced it'll stay "edited"
        recordFileChange(args.path, "created", lines, 0)

      } else if (name === "delete_file" && typeof args.path === "string") {
        recordFileChange(args.path, "deleted", 0, 0)

      } else if ((name === "execute_command" || name === "shell_command" || name === "run_command") && output) {
        // Show first non-empty output line for command success feedback
        const firstLine = output.split("\n").find((l) => l.trim().length > 0)
        if (firstLine && firstLine.length < 100) {
          console.log(chalk.dim(`    ↳ ${firstLine.trim()}`))
        }
      }
    },
    onApiCall: ({ costUSD, promptTokens, completionTokens, totalCostUSD }) => {
      clearWaiting()
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
    onTaskEnd: () => {
      if (fileChanges.size === 0) return
      console.log()
      const pathWidth = Math.min(50, Math.max(...Array.from(fileChanges.keys()).map((p) => p.length)))
      for (const [p, change] of fileChanges) {
        const opLabel =
          change.op === "created" ? chalk.green("created") :
          change.op === "deleted" ? chalk.red("deleted") :
          chalk.yellow("edited ")
        let detail = ""
        if (change.op === "edited") {
          const parts: string[] = []
          if (change.added > 0) parts.push(chalk.green(`+${change.added}`))
          if (change.removed > 0) parts.push(chalk.red(`-${change.removed}`))
          detail = parts.length > 0 ? `  ${parts.join("  ")}` : ""
        } else if (change.op === "created") {
          detail = chalk.dim(`  ${change.added} lines`)
        }
        console.log(`  ${opLabel}  ${chalk.cyan(p.padEnd(pathWidth))}${detail}`)
      }
      console.log()
      fileChanges.clear()
    },
    onUserQuestion: rl
      ? async (question: string) => {
          const ans = await rl_question(rl, `\n[Agent asks] ${question}\n> `)
          return ans.trim()
        }
      : createInteractiveInputHandler(),
  }
}

// -- Settings Panel ----------------------------------------------------------

async function showSettings(rl: readline.Interface, sessionUsage: UsageStats, agent?: { setModel(m: string): void }): Promise<void> {
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
    const newModel = await selectModel(rl, model, config.apiKey)
    if (newModel !== model) {
      config.defaultModelRef = newModel
      await saveCliConfig(config)
      agent?.setModel(newModel)
      console.log(chalk.green(`  Model switched to ${newModel}`))
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

// -- Help --------------------------------------------------------------------

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

// -- Print one-shot result ---------------------------------------------------

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

// -- Save lifetime usage -----------------------------------------------------

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

// -- Interactive REPL --------------------------------------------------------

async function startRepl(
  apiKey: string,
  model: string,
  workDir: string,
  verbose: boolean,
  dryRun: boolean,
): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const callbacks = buildCallbacks(verbose, rl)
  const agent = createAgent(apiKey, { model, workingDirectory: workDir, verbose, dryRun }, callbacks)

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
        await showSettings(rl, agent.getUsage().getStats(), agent)
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

// -- One-shot Task -----------------------------------------------------------

async function runTask(
  task: string,
  apiKey: string,
  model: string,
  workDir: string,
  verbose: boolean,
  dryRun: boolean,
): Promise<void> {
  const callbacks = buildCallbacks(verbose)
  const agent = createAgent(apiKey, { model, workingDirectory: workDir, verbose, dryRun }, callbacks)
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

// -- CLI ---------------------------------------------------------------------

const program = new Command()

program
  .name("agile")
  .description("AI DevOps Agent")
  .version(VERSION, "-v, --version", "print version")
  .option("--verbose", "Show detailed output", false)
  .option("--dry-run", "Preview without executing", false)
  .option("-d, --directory <path>", "Working directory", process.cwd())
  .option("-m, --model <model>", "Model to use (overrides config)")

// -- setup subcommand --------------------------------------------------------

program
  .command("setup")
  .description("Configure API key and default model")
  .action(async () => {
    await runSetupWizard()
  })

// -- Default: REPL or one-shot -----------------------------------------------

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
