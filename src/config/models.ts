import * as fs from "fs/promises"
import * as path from "path"
import * as os from "os"

const CONFIG_DIR = path.join(os.homedir(), ".agile")
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json")
const NAME_PATTERN = /^[A-Za-z0-9._-]+$/

export interface ModelProfile {
  model: string
  description?: string
  updatedAt: string
}

export interface LifetimeUsage {
  sessions: number
  totalTokens: number
  estimatedCostUSD: number
}

export interface AgileCliConfig {
  version: 1
  apiKey?: string
  defaultModelRef?: string
  defaultProfile?: string
  profiles: Record<string, ModelProfile>
  aliases: Record<string, string>
  lifetimeUsage?: LifetimeUsage
}

export interface ModelResolution {
  model: string
  source:
    | "cli-model"
    | "cli-profile"
    | "env-model"
    | "env-profile"
    | "default-model"
    | "default-profile"
    | "fallback"
  modelRef?: string
  profileName?: string
  aliasName?: string
}

export function createDefaultConfig(): AgileCliConfig {
  return {
    version: 1,
    profiles: {},
    aliases: {},
  }
}

export async function loadCliConfig(): Promise<AgileCliConfig> {
  try {
    const raw = await fs.readFile(CONFIG_FILE, "utf-8")
    const parsed = JSON.parse(raw) as Partial<AgileCliConfig>

    return {
      version: 1,
      apiKey: parsed.apiKey,
      defaultModelRef: parsed.defaultModelRef,
      defaultProfile: parsed.defaultProfile,
      profiles: parsed.profiles || {},
      aliases: parsed.aliases || {},
      lifetimeUsage: parsed.lifetimeUsage,
    }
  } catch {
    return createDefaultConfig()
  }
}

export async function saveCliConfig(config: AgileCliConfig): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true })
  await fs.writeFile(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, "utf-8")
}

export function getCliConfigPath(): string {
  return CONFIG_FILE
}

export function maskApiKey(apiKey?: string): string {
  if (!apiKey) return "(missing)"
  if (apiKey.length <= 8) return "(set)"
  return `${apiKey.slice(0, 3)}...${apiKey.slice(-4)}`
}

export function validateName(name: string, kind: "profile" | "alias"): string | null {
  if (!NAME_PATTERN.test(name)) {
    return `Invalid ${kind} name: ${name}. Use only letters, numbers, dot, underscore, or dash.`
  }
  return null
}

export function resolveModelRef(modelRef: string, config: AgileCliConfig): { model: string; aliasName?: string } {
  const aliasTarget = config.aliases[modelRef]
  if (aliasTarget) {
    return { model: aliasTarget, aliasName: modelRef }
  }
  return { model: modelRef }
}

export function resolveModelSelection(input: {
  cliModel?: string
  cliProfile?: string
  envModel?: string
  envProfile?: string
  config: AgileCliConfig
  fallbackModel?: string
}): ModelResolution {
  const fallbackModel = input.fallbackModel || "gpt-4o-mini"

  if (input.cliModel) {
    const resolved = resolveModelRef(input.cliModel, input.config)
    return {
      model: resolved.model,
      source: "cli-model",
      modelRef: input.cliModel,
      aliasName: resolved.aliasName,
    }
  }

  if (input.cliProfile) {
    const profile = input.config.profiles[input.cliProfile]
    if (!profile) {
      throw new Error(`Unknown model profile: ${input.cliProfile}`)
    }
    return {
      model: profile.model,
      source: "cli-profile",
      profileName: input.cliProfile,
    }
  }

  if (input.envModel) {
    const resolved = resolveModelRef(input.envModel, input.config)
    return {
      model: resolved.model,
      source: "env-model",
      modelRef: input.envModel,
      aliasName: resolved.aliasName,
    }
  }

  if (input.envProfile) {
    const profile = input.config.profiles[input.envProfile]
    if (!profile) {
      throw new Error(`Unknown model profile in AGILE_MODEL_PROFILE: ${input.envProfile}`)
    }
    return {
      model: profile.model,
      source: "env-profile",
      profileName: input.envProfile,
    }
  }

  if (input.config.defaultModelRef) {
    const resolved = resolveModelRef(input.config.defaultModelRef, input.config)
    return {
      model: resolved.model,
      source: "default-model",
      modelRef: input.config.defaultModelRef,
      aliasName: resolved.aliasName,
    }
  }

  if (input.config.defaultProfile) {
    const profile = input.config.profiles[input.config.defaultProfile]
    if (!profile) {
      throw new Error(
        `Default profile is set but missing: ${input.config.defaultProfile}. Run \"agile model clear-default\" or recreate the profile.`,
      )
    }
    return {
      model: profile.model,
      source: "default-profile",
      profileName: input.config.defaultProfile,
    }
  }

  return {
    model: fallbackModel,
    source: "fallback",
  }
}

export function describeResolution(resolution: ModelResolution): string {
  switch (resolution.source) {
    case "cli-model":
      return resolution.aliasName
        ? `CLI --model alias ${resolution.aliasName} -> ${resolution.model}`
        : `CLI --model ${resolution.model}`
    case "cli-profile":
      return `CLI --profile ${resolution.profileName} -> ${resolution.model}`
    case "env-model":
      return resolution.aliasName
        ? `AGILE_MODEL alias ${resolution.aliasName} -> ${resolution.model}`
        : `AGILE_MODEL ${resolution.model}`
    case "env-profile":
      return `AGILE_MODEL_PROFILE ${resolution.profileName} -> ${resolution.model}`
    case "default-model":
      return resolution.aliasName
        ? `Default model alias ${resolution.aliasName} -> ${resolution.model}`
        : `Default model ${resolution.model}`
    case "default-profile":
      return `Default profile ${resolution.profileName} -> ${resolution.model}`
    default:
      return `Built-in fallback ${resolution.model}`
  }
}
