import type { ToolDefinition, ToolResult, AgentConfig } from "../agent/types";

/**
 * HTTP tools for API calls and web scraping
 */

async function httpRequest(
  args: Record<string, unknown>,
  config: AgentConfig
): Promise<ToolResult> {
  const url = args.url as string;
  const method = ((args.method as string) || "GET").toUpperCase();
  const headers = (args.headers as Record<string, string>) || {};
  const body = args.body as string | object | undefined;

  if (config.dryRun) {
    return {
      success: true,
      output: `[DRY RUN] Would make ${method} request to ${url}`,
    };
  }

  try {
    const requestInit: RequestInit = {
      method,
      headers: {
        "User-Agent": "Agile-DevOps-Agent/1.0",
        ...headers,
      },
    };

    if (body && method !== "GET") {
      if (typeof body === "object") {
        requestInit.body = JSON.stringify(body);
        requestInit.headers = {
          ...requestInit.headers,
          "Content-Type": "application/json",
        };
      } else {
        requestInit.body = body;
      }
    }

    const response = await fetch(url, requestInit);
    const contentType = response.headers.get("content-type") || "";

    let responseBody: string;
    if (contentType.includes("application/json")) {
      const json = await response.json();
      responseBody = JSON.stringify(json, null, 2);
    } else {
      responseBody = await response.text();
    }

    // Truncate very long responses
    const maxLength = 10000;
    const truncatedBody =
      responseBody.length > maxLength
        ? responseBody.slice(0, maxLength) + "\n\n... (truncated)"
        : responseBody;

    return {
      success: response.ok,
      output: [
        `${method} ${url}`,
        `Status: ${response.status} ${response.statusText}`,
        "",
        "Response:",
        truncatedBody,
      ].join("\n"),
      metadata: {
        status: response.status,
        contentType,
      },
    };
  } catch (error) {
    return {
      success: false,
      output: `HTTP request failed: ${error instanceof Error ? error.message : "Unknown error"}`,
    };
  }
}

async function checkHealth(
  args: Record<string, unknown>,
  config: AgentConfig
): Promise<ToolResult> {
  const url = args.url as string;
  const expectedStatus = (args.expectedStatus as number) || 200;

  if (config.dryRun) {
    return {
      success: true,
      output: `[DRY RUN] Would check health at ${url}`,
    };
  }

  try {
    const startTime = Date.now();
    const response = await fetch(url, {
      method: "GET",
      headers: { "User-Agent": "Agile-DevOps-Agent/1.0" },
    });
    const responseTime = Date.now() - startTime;

    const isHealthy = response.status === expectedStatus;

    return {
      success: isHealthy,
      output: [
        `Health Check: ${url}`,
        `Status: ${response.status} (expected: ${expectedStatus})`,
        `Response Time: ${responseTime}ms`,
        `Result: ${isHealthy ? "HEALTHY" : "UNHEALTHY"}`,
      ].join("\n"),
      metadata: {
        status: response.status,
        responseTime,
        healthy: isHealthy,
      },
    };
  } catch (error) {
    return {
      success: false,
      output: `Health check failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      metadata: { healthy: false },
    };
  }
}

async function fetchWebPage(
  args: Record<string, unknown>,
  config: AgentConfig
): Promise<ToolResult> {
  const url = args.url as string;
  const selector = args.selector as string | undefined;

  if (config.dryRun) {
    return {
      success: true,
      output: `[DRY RUN] Would fetch web page: ${url}`,
    };
  }

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; Agile-DevOps-Agent/1.0; +https://github.com/agile)",
      },
    });

    if (!response.ok) {
      return {
        success: false,
        output: `Failed to fetch page: ${response.status} ${response.statusText}`,
      };
    }

    let html = await response.text();

    // Basic HTML to text conversion (without DOM parser)
    // Remove scripts and styles
    html = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
    html = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
    html = html.replace(/<[^>]+>/g, " ");
    html = html.replace(/\s+/g, " ").trim();

    // Truncate
    const maxLength = 8000;
    const truncatedContent =
      html.length > maxLength
        ? html.slice(0, maxLength) + "\n\n... (truncated)"
        : html;

    return {
      success: true,
      output: `Page content from ${url}:\n\n${truncatedContent}`,
    };
  } catch (error) {
    return {
      success: false,
      output: `Failed to fetch page: ${error instanceof Error ? error.message : "Unknown error"}`,
    };
  }
}

export const httpTools: ToolDefinition[] = [
  {
    name: "http_request",
    description:
      "Make an HTTP request to an API endpoint. Supports GET, POST, PUT, DELETE, and other methods.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The URL to request",
        },
        method: {
          type: "string",
          enum: ["GET", "POST", "PUT", "DELETE", "PATCH"],
          description: "HTTP method (default: GET)",
        },
        headers: {
          type: "object",
          description: "Request headers as key-value pairs",
        },
        body: {
          type: "string",
          description: "Request body (for POST/PUT/PATCH)",
        },
      },
      required: ["url"],
    },
    execute: httpRequest,
  },
  {
    name: "check_health",
    description:
      "Check if a URL is responding with an expected status code. Useful for verifying deployments.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The URL to check",
        },
        expectedStatus: {
          type: "number",
          description: "Expected HTTP status code (default: 200)",
        },
      },
      required: ["url"],
    },
    execute: checkHealth,
  },
  {
    name: "fetch_web_page",
    description:
      "Fetch and extract text content from a web page. Useful for reading documentation or scraping content.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The URL of the web page to fetch",
        },
        selector: {
          type: "string",
          description: "CSS selector to extract specific content (optional)",
        },
      },
      required: ["url"],
    },
    execute: fetchWebPage,
  },
];
