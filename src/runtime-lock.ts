import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

interface LockFilePayload {
  pid: number;
  createdAt: string;
  cwd: string;
}

function isPidRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/ESRCH/i.test(message)) {
      return false;
    }
    return true;
  }
}

function readExistingPid(lockPath: string): number | undefined {
  if (!existsSync(lockPath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as Partial<LockFilePayload>;
    return typeof parsed.pid === "number" ? parsed.pid : undefined;
  } catch {
    return undefined;
  }
}

export class RuntimeLock {
  private constructor(
    readonly lockPath: string,
    private readonly fd: number,
  ) {}

  static acquire(lockPath: string): { acquired: true; lock: RuntimeLock } | { acquired: false; reason: string } {
    mkdirSync(path.dirname(lockPath), { recursive: true });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fd = openSync(lockPath, "wx");
        const payload: LockFilePayload = {
          pid: process.pid,
          createdAt: new Date().toISOString(),
          cwd: process.cwd(),
        };
        writeFileSync(fd, JSON.stringify(payload, null, 2) + "\n", "utf8");
        return { acquired: true, lock: new RuntimeLock(lockPath, fd) };
      } catch (error) {
        const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : undefined;
        if (code !== "EEXIST") {
          throw error;
        }

        const existingPid = readExistingPid(lockPath);
        if (existingPid && isPidRunning(existingPid)) {
          return {
            acquired: false,
            reason: `picord runtime already running under PID ${existingPid}.`,
          };
        }

        try {
          rmSync(lockPath, { force: true });
        } catch {
          return {
            acquired: false,
            reason: "picord runtime lock exists and could not be removed.",
          };
        }
      }
    }

    return {
      acquired: false,
      reason: "picord runtime lock could not be acquired.",
    };
  }

  release(): void {
    try {
      closeSync(this.fd);
    } catch {}

    try {
      unlinkSync(this.lockPath);
    } catch {}
  }
}
