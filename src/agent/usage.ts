/**
 * Token Usage and Cost Tracking
 *
 * Tracks OpenAI API token usage and estimates cost across the agent's run.
 */

export interface UsageStats {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  apiCalls: number
  estimatedCostUSD: number
}

// Pricing per 1M tokens (USD) - approximate, updated periodically
// https://openai.com/api/pricing
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "gpt-4o": { input: 2.5, output: 10.0 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4-turbo": { input: 10.0, output: 30.0 },
  "gpt-4": { input: 30.0, output: 60.0 },
  "gpt-3.5-turbo": { input: 0.5, output: 1.5 },
  "o1-preview": { input: 15.0, output: 60.0 },
  "o1-mini": { input: 3.0, output: 12.0 },
  "gpt-5": { input: 5.0, output: 20.0 },
  "gpt-5-mini": { input: 0.5, output: 2.0 },
}

const DEFAULT_PRICING = { input: 2.5, output: 10.0 }

export class UsageTracker {
  private model: string
  private stats: UsageStats

  constructor(model: string) {
    this.model = model
    this.stats = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      apiCalls: 0,
      estimatedCostUSD: 0,
    }
  }

  /**
   * Record usage from an OpenAI API response.
   * Returns the cost delta for this single call.
   */
  record(usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }): {
    promptTokens: number
    completionTokens: number
    costUSD: number
  } {
    if (!usage) return { promptTokens: 0, completionTokens: 0, costUSD: 0 }

    const promptTokens = usage.prompt_tokens || 0
    const completionTokens = usage.completion_tokens || 0
    const totalTokens = usage.total_tokens || promptTokens + completionTokens

    this.stats.promptTokens += promptTokens
    this.stats.completionTokens += completionTokens
    this.stats.totalTokens += totalTokens
    this.stats.apiCalls += 1

    // Calculate cost
    const pricing = this.getPricing()
    const costUSD =
      (promptTokens / 1_000_000) * pricing.input + (completionTokens / 1_000_000) * pricing.output
    this.stats.estimatedCostUSD += costUSD

    return { promptTokens, completionTokens, costUSD }
  }

  private getPricing(): { input: number; output: number } {
    // Try exact match first
    if (MODEL_PRICING[this.model]) {
      return MODEL_PRICING[this.model]
    }
    // Try prefix match (e.g., "gpt-4o-2024-08-06" → "gpt-4o")
    for (const [key, value] of Object.entries(MODEL_PRICING)) {
      if (this.model.startsWith(key)) return value
    }
    return DEFAULT_PRICING
  }

  getStats(): UsageStats {
    return { ...this.stats }
  }

  /**
   * Format usage stats as a human-readable string
   */
  format(): string {
    const lines = [
      `API calls:        ${this.stats.apiCalls}`,
      `Prompt tokens:    ${this.stats.promptTokens.toLocaleString("en-US")}`,
      `Completion tokens: ${this.stats.completionTokens.toLocaleString("en-US")}`,
      `Total tokens:     ${this.stats.totalTokens.toLocaleString("en-US")}`,
      `Estimated cost:   $${this.stats.estimatedCostUSD.toFixed(4)} USD`,
      `Model:            ${this.model}`,
    ]
    return lines.join("\n")
  }

  reset(): void {
    this.stats = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      apiCalls: 0,
      estimatedCostUSD: 0,
    }
  }
}
