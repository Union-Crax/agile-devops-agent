import type { ToolDefinition, ToolResult, AgentConfig } from "../agent/types";

function validateHttpUrl(url: string): { ok: true; url: string } | { ok: false; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "Invalid URL." };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: "Only http/https URLs are allowed." };
  }

  const host = parsed.hostname.toLowerCase();
  // Block obvious local/metadata hosts by name.
  if (host === "localhost" || host === "localdomain" || host.endsWith(".local")) {
    return { ok: false, reason: "Local network hosts are not allowed." };
  }
  if (host === "169.254.169.254" || host === "metadata.google.internal") {
    return { ok: false, reason: "Metadata endpoints are not allowed." };
  }

  // NOTE: full private-range blocking requires DNS/IP resolution; keep this name-based guard + disallow common ranges.
  // If the hostname is a literal IP, block private ranges.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    const [a, b] = host.split(".").map((n) => parseInt(n, 10));
    // 10.0.0.0/8
    if (a === 10) return { ok: false, reason: "Private IP range blocked." };
    // 172.16.0.0/12
    if (a === 172 && b >= 16 && b <= 31) return { ok: false, reason: "Private IP range blocked." };
    // 192.168.0.0/16
    if (a === 192 && b === 168) return { ok: false, reason: "Private IP range blocked." };
    // 127.0.0.0/8
    if (a === 127) return { ok: false, reason: "Loopback blocked." };
    // 0.0.0.0/8
    if (a === 0) return { ok: false, reason: "Invalid/unspecified range blocked." };
  }

  return { ok: true, url: parsed.toString() };
}

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
    const safeUrl = validateHttpUrl(url);
    if (!safeUrl.ok) {
      return { success: false, output: `HTTP request blocked: ${safeUrl.reason}` };
    }

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

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 15000);
    const response = await fetch(safeUrl.url, { ...requestInit, signal: controller.signal });
    clearTimeout(t);
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
    const safeUrl = validateHttpUrl(url);
    if (!safeUrl.ok) {
      return { success: false, output: `Health check blocked: ${safeUrl.reason}`, metadata: { healthy: false } };
    }

    const startTime = Date.now();
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 10000);
    const response = await fetch(safeUrl.url, {
      method: "GET",
      headers: { "User-Agent": "Agile-DevOps-Agent/1.0" },
      signal: controller.signal,
      redirect: "follow",
    });
    clearTimeout(t);
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
    const safeUrl = validateHttpUrl(url);
    if (!safeUrl.ok) {
      return { success: false, output: `Fetch web page blocked: ${safeUrl.reason}` };
    }

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 15000);
    const response = await fetch(safeUrl.url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; Agile-DevOps-Agent/1.0; +https://github.com/agile)",
      },
      signal: controller.signal,
      redirect: "follow",
    });
    clearTimeout(t);

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
