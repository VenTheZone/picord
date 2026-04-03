import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CRITIQUE_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;
const CRITIQUE_RUNNER = ["npx", "-y", "critique"] as const;

export type CritiqueResult = {
  url: string;
  id?: string;
  error?: undefined;
} | {
  url?: undefined;
  id?: undefined;
  error: string;
};

export function parseCritiqueOutput(output: string): CritiqueResult | undefined {
  const lines = output.trim().split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }

    try {
      const parsed = JSON.parse(trimmed) as { url?: string; id?: string; error?: string };
      if (parsed.error) {
        return { error: parsed.error };
      }
      if (parsed.url) {
        return { url: parsed.url, id: parsed.id };
      }
    } catch {
      continue;
    }
  }

  const urlMatch = output.match(/https?:\/\/critique\.work\/[^\s]+/);
  if (urlMatch) {
    const url = urlMatch[0];
    const idMatch = url.match(/\/v\/([a-zA-Z0-9_-]+)/);
    return { url, id: idMatch?.[1] };
  }

  return undefined;
}

async function runCommand(command: string, args: string[], cwd: string, timeout: number = CRITIQUE_TIMEOUT_MS): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(command, args, {
    cwd,
    timeout,
    maxBuffer: DEFAULT_MAX_BUFFER,
    env: process.env,
  });
}

async function runCritique(args: string[], cwd: string, timeout: number = CRITIQUE_TIMEOUT_MS): Promise<CritiqueResult | undefined> {
  try {
    const { stdout, stderr } = await runCommand(CRITIQUE_RUNNER[0], [...CRITIQUE_RUNNER.slice(1), ...args], cwd, timeout);
    return parseCritiqueOutput(`${stdout}\n${stderr}`);
  } catch (error) {
    const execError = error as { stdout?: string; stderr?: string; message?: string };
    const output = `${execError.stdout ?? ""}\n${execError.stderr ?? ""}`.trim();
    const parsed = parseCritiqueOutput(output);
    if (parsed) {
      return parsed;
    }

    const message = execError.message ?? "Unknown critique error";
    return { error: message.slice(0, 300) };
  }
}

export async function isGitWorkspace(cwd: string): Promise<boolean> {
  try {
    const { stdout } = await runCommand("git", ["rev-parse", "--is-inside-work-tree"], cwd, 10_000);
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

export async function getGitStatusFingerprint(cwd: string): Promise<string | undefined> {
  if (!await isGitWorkspace(cwd)) {
    return undefined;
  }

  try {
    const { stdout } = await runCommand("git", ["status", "--porcelain", "--untracked-files=all"], cwd, 10_000);
    return stdout.trim();
  } catch {
    return undefined;
  }
}

export async function shareGitDiff(options: { cwd: string; title: string }): Promise<CritiqueResult | undefined> {
  return runCritique(["--web", options.title, "--json"], options.cwd);
}

export async function reviewGitDiff(options: { cwd: string }): Promise<CritiqueResult | undefined> {
  return runCritique(["review", "--web", "--json"], options.cwd);
}
