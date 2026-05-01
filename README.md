# AGILE - Multi-step DevOps Agent

<div align="center">

[![npm version](https://img.shields.io/npm/v/agile-devops-agent?color=cb3837&logo=npm&logoColor=white)](https://www.npmjs.com/package/agile-devops-agent)
[![npm downloads](https://img.shields.io/npm/dm/agile-devops-agent?color=cb3837&logo=npm&logoColor=white)](https://www.npmjs.com/package/agile-devops-agent)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![OpenAI](https://img.shields.io/badge/Powered%20by-OpenAI-412991?logo=openai&logoColor=white)](https://openai.com)
[![GitHub stars](https://img.shields.io/github/stars/Union-Crax/agile-devops-agent?style=social)](https://github.com/Union-Crax/agile-devops-agent/stargazers)

A real AI system that uses OpenAI's function calling to analyze codebases, deploy applications, monitor deployments, and fix issues automatically.

**This is a system, not just a prompt.**

```text
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║      █████╗  ██████╗ ██╗██╗     ███████╗                  ║
║     ██╔══██╗██╔════╝ ██║██║     ██╔════╝                  ║
║     ███████║██║  ███╗██║██║     █████╗                    ║
║     ██╔══██║██║   ██║██║██║     ██╔══╝                    ║
║     ██║  ██║╚██████╔╝██║███████╗███████╗                  ║
║     ╚═╝  ╚═╝ ╚═════╝ ╚═╝╚══════╝╚══════╝                  ║
║                                                           ║
║         Multi-step DevOps Agent powered by OpenAI         ║
╚═══════════════════════════════════════════════════════════╝
```

</div>

---

## What is AGILE?

AGILE is a multi-step AI agent that acts as your DevOps assistant. Unlike simple chatbots that just respond to prompts, AGILE:

- **Breaks down complex tasks** into multiple steps
- **Uses tools** to read files, execute commands, make HTTP requests, and interact with Git
- **Maintains state** across steps to reason about the codebase
- **Makes decisions** about what actions to take next
- **Deploys** to multiple platforms (Vercel, Docker, generic Git)

## Why AI is Necessary

Traditional DevOps automation requires you to write specific scripts for each task. AGILE uses AI to:

1. **Understand natural language requests** – "deploy this to production" or "why is the build failing?"
2. **Adapt to any codebase** – Automatically detects frameworks, package managers, and configurations.
3. **Reason through problems** – Analyzes code, identifies issues, and plans fixes.
4. **Handle unexpected situations** – When something fails, it can diagnose and suggest solutions.

## How It Uses OpenAI APIs

AGILE uses **OpenAI Function Calling** (tool use) to create a true agentic system:

```text
┌─────────────────────────────────────────────────────────────┐
│                       CLI Interface                         │
│  (commander + chalk + ora for beautiful terminal output)    │
└─────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                    Agent Core Engine                        │
│  - Task planning & decomposition                            │
│  - Multi-step execution loop                                │
│  - State management & memory                                │
│  - Tool orchestration                                       │
└─────────────────────────────────────────────────────────────┘
                               │
         ┌─────────────────────┼─────────────────────┐
         ▼                     ▼                     ▼
┌─────────────────┐   ┌─────────────────┐   ┌─────────────────┐
│   File Tools    │   │   Shell Tools   │   │    API Tools    │
│ - read/write    │   │ - execute cmds  │   │ - HTTP requests │
│ - search/glob   │   │ - run tests     │   │ - Vercel API    │
│ - analyze code  │   │ - build project │   │ - Docker API    │
└─────────────────┘   └─────────────────┘   └─────────────────┘
```

### The Multi-Step Execution Loop

```typescript
while (!task.isComplete && steps < maxSteps) {
  // 1. Send conversation to OpenAI with available tools
  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: conversationHistory,
    tools: toolDefinitions, // 20+ tools available
    tool_choice: "auto"
  });

  // 2. Execute any tool calls the model requests
  if (response.tool_calls) {
    for (const call of response.tool_calls) {
      const result = await executeTool(call.name, call.arguments);
      conversationHistory.push({ role: "tool", content: result });
    }
  }

  // 3. Check if the agent decided the task is complete
  task.isComplete = checkCompletion(response);
}
```

### Available Tools

| Category | Tools |
| :--- | :--- |
| **Filesystem** | `read_file`, `write_file`, `search_files`, `grep`, `list_directory` |
| **Shell** | `run_command`, `run_tests`, `build_project`, `install_dependencies` |
| **Git** | `git_status`, `git_diff`, `git_log`, `git_commit`, `git_push`, `git_branch` |
| **HTTP** | `http_request`, `check_health`, `fetch_web_page` |
| **Analysis** | `analyze_project`, `check_dependencies`, `audit_dependencies`, `run_linter`, `analyze_code_quality` |
| **System** | `task_complete`, `think`, `ask_user` |

---

## Installation

### From npm (recommended)

```bash
npm install -g agile-devops-agent
```

### From source

```bash
# Clone the repository
git clone https://github.com/Union-Crax/agile-devops-agent.git
cd agile-devops-agent

# Install dependencies
npm install

# Build
npm run build
```

## Requirements

- **Node.js** >= 18.0.0
- **npm** >= 8.0.0
- An **OpenAI API key**

## Configuration

```bash
# Set your OpenAI API key
export OPENAI_API_KEY=your-api-key-here
```

Or create a `.env` file in the project root:

```env
OPENAI_API_KEY=your-api-key-here
```

## Usage

```bash
# Run a task
agile "deploy this project to Vercel"

# Analyze a codebase
agile "why is my build failing?"

# Fix issues automatically
agile "find and fix all TypeScript errors"
```

---

## License

MIT © [Union-Crax](https://github.com/Union-Crax)
