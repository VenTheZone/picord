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
  return {
    extensions: base.extensions.filter((extension) => !isUnderRoot(extension.resolvedPath, picordRoot)),
    errors: base.errors.filter((entry) => !isUnderRoot(entry.path, picordRoot)),
    runtime: {
      ...base.runtime,
      pendingProviderRegistrations: base.runtime.pendingProviderRegistrations.filter((entry) => {
        return !isUnderRoot(entry.extensionPath, picordRoot);
      }),
    },
  };
}
