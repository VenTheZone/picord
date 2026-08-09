import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LoadExtensionsResult } from "@mariozechner/pi-coding-agent";

export function getPicordPackageRoot(moduleUrl: string = import.meta.url): string {
  return path.resolve(path.dirname(fileURLToPath(moduleUrl)), "..");
}

function isUnderRoot(candidatePath: string, root: string): boolean {
  const resolvedCandidate = path.resolve(candidatePath);
  const resolvedRoot = path.resolve(root);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`);
}

export function filterOutPicordExtensions(
  base: LoadExtensionsResult,
  picordRoot: string = getPicordPackageRoot(),
): LoadExtensionsResult {
  // pi-mcp-access tries to connect MCP servers on session_start and throws
  // "Not connected" in picord's headless sessions; picord brings its own MCP.
  const excluded = (p: string) =>
    isUnderRoot(p, picordRoot) || p.includes("pi-mcp-access");
  return {
    extensions: base.extensions.filter((extension) => !excluded(extension.resolvedPath)),
    errors: base.errors.filter((entry) => !excluded(entry.path)),
    runtime: {
      ...base.runtime,
      pendingProviderRegistrations: base.runtime.pendingProviderRegistrations.filter((entry) => {
        return !excluded(entry.extensionPath);
      }),
    },
  };
}
