import OpenAI from "openai"
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionToolMessageParam,
} from "openai/resources/chat/completions"
import type { AgentConfig, AgentState, TaskResult, ToolDefinition } from "./types"
import { toOpenAITools } from "./types"
import { getAllTools, executeTool } from "../tools"
import { UsageTracker } from "./usage"
import { type UserInputHandler, createAutoSkipHandler } from "./prompt"
import { formatMemoryForPrompt, loadMemory, saveMemory, createEmptyMemory } from "./memory"

/**
 * Agent Core Engine
 *
 * The heart of the multi-step DevOps agent. It manages:
 * - Conversation state and history
 * - OpenAI function calling loop with parallel tool execution
 * - Persistent memory across runs
 * - Token usage and cost tracking
 * - Tool execution with reflection and self-correction
 */

const SYSTEM_PROMPT = `You are an expert DevOps agent called "agile". You help developers with:
- Analyzing codebases for issues, security vulnerabilities, and improvements
- Deploying applications to various platforms (Vercel, Docker, generic Git-based workflows)
- Monitoring deployments and checking health
- Running tests and builds
- Managing Git operations
- Fixing issues in code and configuration

You have access to a set of tools that let you read/write files, execute commands, make HTTP requests,
and interact with Git. Use these tools to accomplish the user's request.

IMPORTANT GUIDELINES:
1. Start by understanding the project structure using analyze_project and list_directory
2. Before making changes, read the relevant files to understand the current state
3. When deploying, ensure tests pass and the build succeeds first
4. Use the think tool to plan complex multi-step operations BEFORE acting
5. Run independent operations in parallel by calling multiple tools at once
6. After significant work, use the reflect tool to verify your progress
7. When you've completed the task, use task_complete to signal you're done
8. If you need clarification, use ask_user
9. Be careful with destructive operations - verify before executing
10. Provide clear feedback about what you're doing at each step
11. Save important findings using add_discovery so future runs benefit

You are running in the context of a CLI tool. Be concise but informative.`

export interface AgentCallbacks {
  onThinking?: (thought: string, plan?: string[]) => void
  onToolCall?: (name: string, args: Record<string, unknown>) => void
  onToolResult?: (name: string, success: boolean, output: string) => void
  onStep?: (step: number, maxSteps: number) => void
  onUserQuestion?: UserInputHandler
}

export class AgentCore {
  private openai: OpenAI
  private config: AgentConfig
  private tools: ToolDefinition[]
  private openaiTools: ChatCompletionTool[]
  private callbacks: AgentCallbacks
  private usage: UsageTracker
  private userInputHandler: UserInputHandler

  constructor(apiKey: string, config: AgentConfig, callbacks: AgentCallbacks = {}) {
    this.openai = new OpenAI({ apiKey })
    this.config = config
    this.tools = getAllTools()
    this.openaiTools = this.buildOpenAITools()
    this.callbacks = callbacks
    this.usage = new UsageTracker(config.model)
    this.userInputHandler = callbacks.onUserQuestion || createAutoSkipHandler()
  }

  getUsage(): UsageTracker {
    return this.usage
  }

  private buildOpenAITools(): ChatCompletionTool[] {
    const systemTools: ChatCompletionTool[] = [
      {
        type: "function",
        function: {
          name: "task_complete",
          description:
            "Mark the current task as complete. Call this when you have successfully finished the user's request. Be specific in the summary about what was accomplished.",
          parameters: {
            type: "object",
            properties: {
              success: {
                type: "boolean",
                description: "Whether the task was completed successfully",
              },
              summary: {
                type: "string",
                description: "A concise summary of what was accomplished",
              },
              details: {
                type: "array",
                description: "List of specific actions taken or findings",
                items: { type: "string" },
              },
            },
            required: ["success", "summary"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "think",
          description:
            "Use this to reason through a complex problem step by step. Write out your thought process to plan your next actions. Use this BEFORE running tools when the path forward is unclear.",
          parameters: {
            type: "object",
            properties: {
              thought: {
                type: "string",
                description: "Your reasoning and analysis of the current situation",
              },
              plan: {
                type: "array",
                description: "List of planned next steps",
                items: { type: "string" },
              },
            },
            required: ["thought"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "reflect",
          description:
            "Reflect on the work done so far. Evaluate whether you're on track, identify any errors, and decide whether to continue or change course. Call this after completing significant subtasks.",
          parameters: {
            type: "object",
            properties: {
              progress_assessment: {
                type: "string",
                description: "Honest assessment of progress toward the goal",
              },
              issues_identified: {
                type: "array",
                description: "Any problems, errors, or concerns noticed",
                items: { type: "string" },
              },
              next_action: {
                type: "string",
                description: "What to do next: continue, change_course, or complete",
                enum: ["continue", "change_course", "complete"],
              },
            },
            required: ["progress_assessment", "next_action"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "ask_user",
          description:
            "Ask the user for clarification or input when you need more information to proceed. Only use when truly necessary.",
          parameters: {
            type: "object",
            properties: {
              question: {
                type: "string",
                description: "The question to ask the user",
              },
            },
            required: ["question"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "add_discovery",
          description:
            "Save an important finding or insight discovered during this run. Discoveries persist across runs in agent memory.",
          parameters: {
            type: "object",
            properties: {
              discovery: {
                type: "string",
                description: "The insight or finding to remember",
              },
            },
            required: ["discovery"],
          },
        },
      },
    ]

    return [...toOpenAITools(this.tools), ...systemTools]
  }

  /**
   * Execute a task with the agent
   */
  async executeTask(taskDescription: string): Promise<TaskResult> {
    // Try to load persisted memory
    const persistedMemory = await loadMemory(this.config.workingDirectory)
    const memory = persistedMemory || createEmptyMemory(this.config.workingDirectory)

    // Build context-aware system prompt
    const memoryContext = formatMemoryForPrompt(memory)
    const fullSystemPrompt = `${SYSTEM_PROMPT}\n\n${memoryContext}`

    const state: AgentState = {
      taskDescription,
      conversationHistory: [
        { role: "system", content: fullSystemPrompt },
        { role: "user", content: taskDescription },
      ],
      stepCount: 0,
      isComplete: false,
      memory,
    }

    while (!state.isComplete && state.stepCount < this.config.maxSteps) {
      state.stepCount++
      this.callbacks.onStep?.(state.stepCount, this.config.maxSteps)

      const response = await this.openai.chat.completions.create({
        model: this.config.model,
        messages: state.conversationHistory,
        tools: this.openaiTools,
        tool_choice: "auto",
        parallel_tool_calls: true,
      })

      // Track token usage
      this.usage.record(response.usage)

      const message = response.choices[0]?.message
      if (!message) {
        throw new Error("No response from OpenAI")
      }

      state.conversationHistory.push(message as ChatCompletionMessageParam)

      if (message.content && this.config.verbose) {
        console.log(`\n[Agent]: ${message.content}`)
      }

      if (message.tool_calls && message.tool_calls.length > 0) {
        const toolResults = await this.handleToolCallsParallel(message.tool_calls, state)

        for (const result of toolResults) {
          if (result.isCompletion) {
            state.isComplete = true
            state.result = result.taskResult
          }
          state.conversationHistory.push(result.message)
        }
      } else if (!message.tool_calls && !message.content) {
        console.warn("Agent returned empty response")
        break
      } else if (!message.tool_calls && message.content) {
        // Agent gave a final answer without calling task_complete
        state.isComplete = true
        state.result = {
          success: true,
          summary: message.content,
          details: [],
        }
      }
    }

    // Persist memory at end of run
    try {
      await saveMemory(this.config.workingDirectory, state.memory)
    } catch (err) {
      // Non-fatal - memory persistence is best-effort
      if (this.config.verbose) {
        console.warn("Failed to save memory:", err)
      }
    }

    if (!state.isComplete) {
      return {
        success: false,
        summary: `Task did not complete within ${this.config.maxSteps} steps`,
        details: [`Completed ${state.stepCount} steps before stopping`],
        errors: ["Max steps reached without task completion"],
      }
    }

    return (
      state.result || {
        success: true,
        summary: "Task completed",
        details: [],
      }
    )
  }

  /**
   * Handle tool calls in parallel where possible
   */
  private async handleToolCallsParallel(
    toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[],
    state: AgentState,
  ): Promise<
    {
      message: ChatCompletionToolMessageParam
      isCompletion: boolean
      taskResult?: TaskResult
    }[]
  > {
    // Execute all tool calls in parallel - the agent core handles state safely
    const promises = toolCalls.map((toolCall) => this.executeToolCall(toolCall, state))
    return Promise.all(promises)
  }

  /**
   * Execute a single tool call
   */
  private async executeToolCall(
    toolCall: OpenAI.Chat.Completions.ChatCompletionMessageToolCall,
    state: AgentState,
  ): Promise<{
    message: ChatCompletionToolMessageParam
    isCompletion: boolean
    taskResult?: TaskResult
  }> {
    // Narrow to function tool calls (we don't use custom tools)
    if (toolCall.type !== "function" || !("function" in toolCall)) {
      return {
        message: {
          role: "tool",
          tool_call_id: toolCall.id,
          content: "Unsupported tool call type",
        },
        isCompletion: false,
      }
    }

    const functionName = toolCall.function.name
    let args: Record<string, unknown> = {}

    try {
      args = JSON.parse(toolCall.function.arguments || "{}")
    } catch {
      args = {}
    }

    this.callbacks.onToolCall?.(functionName, args)

    // Handle system tools
    if (functionName === "task_complete") {
      const taskResult: TaskResult = {
        success: args.success as boolean,
        summary: args.summary as string,
        details: (args.details as string[]) || [],
      }

      this.callbacks.onToolResult?.(functionName, true, `Task completed: ${taskResult.summary}`)

      return {
        message: {
          role: "tool",
          tool_call_id: toolCall.id,
          content: "Task marked as complete",
        },
        isCompletion: true,
        taskResult,
      }
    }

    if (functionName === "think") {
      const thought = args.thought as string
      const plan = args.plan as string[] | undefined

      this.callbacks.onThinking?.(thought, plan)

      return {
        message: {
          role: "tool",
          tool_call_id: toolCall.id,
          content: "Thought recorded. Continue with your plan.",
        },
        isCompletion: false,
      }
    }

    if (functionName === "reflect") {
      const assessment = args.progress_assessment as string
      const issues = (args.issues_identified as string[]) || []
      const nextAction = args.next_action as string

      if (this.config.verbose) {
        console.log(`\n[Reflection] ${assessment}`)
        if (issues.length > 0) {
          console.log("Issues:")
          issues.forEach((i) => console.log(`  - ${i}`))
        }
        console.log(`Next action: ${nextAction}`)
      }

      const feedback =
        nextAction === "complete"
          ? "Reflection complete. You may now call task_complete."
          : nextAction === "change_course"
            ? "Reflection noted. Adjust your approach based on the issues identified."
            : "Reflection noted. Continue with the next steps."

      return {
        message: {
          role: "tool",
          tool_call_id: toolCall.id,
          content: feedback,
        },
        isCompletion: false,
      }
    }

    if (functionName === "ask_user") {
      const question = args.question as string
      const answer = await this.userInputHandler(question)

      return {
        message: {
          role: "tool",
          tool_call_id: toolCall.id,
          content: `User responded: ${answer}`,
        },
        isCompletion: false,
      }
    }

    if (functionName === "add_discovery") {
      const discovery = args.discovery as string
      if (!state.memory.discoveries.includes(discovery)) {
        state.memory.discoveries.push(discovery)
      }

      return {
        message: {
          role: "tool",
          tool_call_id: toolCall.id,
          content: "Discovery saved to persistent memory.",
        },
        isCompletion: false,
      }
    }

    // Execute regular tools
    const result = await executeTool(functionName, args, this.config)

    state.memory.previousActions.push({
      tool: functionName,
      input: args,
      output: result.output.slice(0, 500), // Truncate for memory storage
      timestamp: new Date(),
      success: result.success,
    })

    this.callbacks.onToolResult?.(functionName, result.success, result.output)

    return {
      message: {
        role: "tool",
        tool_call_id: toolCall.id,
        content: result.output,
      },
      isCompletion: false,
    }
  }

  /**
   * Run an interactive session
   */
  async interactiveSession(readlineIterator: AsyncIterable<string>): Promise<void> {
    // Load memory for context
    const persistedMemory = await loadMemory(this.config.workingDirectory)
    const memory = persistedMemory || createEmptyMemory(this.config.workingDirectory)

    const memoryContext = formatMemoryForPrompt(memory)
    const history: ChatCompletionMessageParam[] = [
      { role: "system", content: `${SYSTEM_PROMPT}\n\n${memoryContext}` },
    ]

    for await (const input of readlineIterator) {
      const trimmed = input.trim()

      if (!trimmed) continue
      if (trimmed === "exit" || trimmed === "quit") {
        // Save memory before exit
        try {
          await saveMemory(this.config.workingDirectory, memory)
        } catch {
          // ignore
        }
        console.log("\n  Goodbye!\n")
        break
      }

      if (trimmed === "/usage") {
        console.log("\n  Usage: " + this.usage.format().replace(/\n/g, "\n  ") + "\n")
        continue
      }

      if (trimmed === "/clear") {
        history.length = 1 // Keep system prompt
        console.log("\n  History cleared.\n")
        continue
      }

      history.push({ role: "user", content: trimmed })

      let continueLoop = true
      let stepCount = 0

      while (continueLoop && stepCount < this.config.maxSteps) {
        stepCount++

        const response = await this.openai.chat.completions.create({
          model: this.config.model,
          messages: history,
          tools: this.openaiTools,
          tool_choice: "auto",
          parallel_tool_calls: true,
        })

        this.usage.record(response.usage)

        const message = response.choices[0]?.message
        if (!message) break

        history.push(message as ChatCompletionMessageParam)

        if (message.content) {
          console.log(`\n  ${message.content}`)
        }

        if (message.tool_calls && message.tool_calls.length > 0) {
          // Execute in parallel
          const tempState: AgentState = {
            taskDescription: trimmed,
            conversationHistory: history,
            stepCount,
            isComplete: false,
            memory,
          }

          const results = await this.handleToolCallsParallel(message.tool_calls, tempState)

          for (const result of results) {
            history.push(result.message)
            if (result.isCompletion) {
              continueLoop = false
              if (result.taskResult) {
                console.log(`\n  ${result.taskResult.summary}\n`)
              }
            }
          }
        } else {
          continueLoop = false
        }
      }
    }
  }
}

/**
 * Create a new agent instance
 */
export function createAgent(
  apiKey: string,
  config: Partial<AgentConfig> = {},
  callbacks: AgentCallbacks = {},
): AgentCore {
  const fullConfig: AgentConfig = {
    model: config.model || "gpt-4o-mini",
    maxSteps: config.maxSteps || 30,
    verbose: config.verbose ?? false,
    dryRun: config.dryRun ?? false,
    workingDirectory: config.workingDirectory || process.cwd(),
    platform: config.platform,
  }

  return new AgentCore(apiKey, fullConfig, callbacks)
}
