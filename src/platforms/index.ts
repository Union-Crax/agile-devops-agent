/**
 * Platform Adapters
 *
 * Each platform adapter provides deployment and management functionality
 * for a specific platform or deployment method.
 */

export { vercelPlatform } from "./vercel";
export { dockerPlatform } from "./docker";
export { genericPlatform } from "./generic";

import { vercelPlatform } from "./vercel";
import { dockerPlatform } from "./docker";
import { genericPlatform } from "./generic";

/**
 * Get a platform adapter by name
 */
export function getPlatform(name: "vercel" | "docker" | "generic") {
  switch (name) {
    case "vercel":
      return vercelPlatform;
    case "docker":
      return dockerPlatform;
    case "generic":
      return genericPlatform;
  }
}

/**
 * List all available platforms
 */
export function listPlatforms(): string[] {
  return ["vercel", "docker", "generic"];
}
