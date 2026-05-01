import * as readline from "readline"

/**
 * User Input Handler
 *
 * Provides a way for the agent to actually ask the user questions
 * and get real answers from stdin.
 */

export type UserInputHandler = (question: string) => Promise<string>

/**
 * Default handler: prompts the user via stdin
 */
export function createInteractiveInputHandler(): UserInputHandler {
  return async (question: string): Promise<string> => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    })

    return new Promise((resolve) => {
      rl.question(`\n[Agent asks] ${question}\n> `, (answer) => {
        rl.close()
        resolve(answer.trim())
      })
    })
  }
}

/**
 * Auto-skip handler: returns a "no clarification" response.
 * Used in non-interactive modes (CI, scripts).
 */
export function createAutoSkipHandler(): UserInputHandler {
  return async (question: string): Promise<string> => {
    return `(Non-interactive mode - the user is not available to answer "${question}". Please proceed with your best judgment based on available information, or skip this step if it's not critical.)`
  }
}

/**
 * Confirmation handler: asks yes/no questions for risky operations
 */
export async function confirmAction(message: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  return new Promise((resolve) => {
    rl.question(`\n[Confirm] ${message} (y/N) `, (answer) => {
      rl.close()
      const normalized = answer.trim().toLowerCase()
      resolve(normalized === "y" || normalized === "yes")
    })
  })
}
