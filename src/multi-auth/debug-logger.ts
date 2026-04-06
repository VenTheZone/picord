import { join } from "node:path";
import { AsyncBufferedLogWriter } from "./async-buffered-log-writer.js";
import {
	MULTI_AUTH_EXTENSION_ID,
	RESOLVE_EXT_DEBUG_DIR,
	ensureMultiAuthDebugDirectory,
} from "./multi-auth-config.js";

export interface MultiAuthDebugLoggerOptions {
	debugDir?: string;
	logPath?: string;
}

function safeJsonStringify(value: unknown): string {
	const seen = new WeakSet<object>();
	return JSON.stringify(value, (_key, currentValue) => {
		if (currentValue instanceof Error) {
			return {
				name: currentValue.name,
				message: currentValue.message,
				stack: currentValue.stack,
			};
		}

		if (typeof currentValue === "bigint") {
			return currentValue.toString();
		}

		if (typeof currentValue === "object" && currentValue !== null) {
			if (seen.has(currentValue)) {
				return "[Circular]";
			}
			seen.add(currentValue);
		}

		return currentValue;
	});
}

export class MultiAuthDebugLogger {
	private initialized = false;
	private debugEnabled = false;
	private readonly debugDir: string;
	private readonly logPath: string;
	private writer: AsyncBufferedLogWriter | null = null;

	constructor(options: MultiAuthDebugLoggerOptions = {}) {
		this.debugDir = options.debugDir ?? RESOLVE_EXT_DEBUG_DIR();
		this.logPath = options.logPath ?? join(this.debugDir, `${MULTI_AUTH_EXTENSION_ID}-debug.jsonl`);
	}

	/** Called during picord startup once the state path is known. */
	initialize(debugEnabled: boolean): void {
		if (this.initialized) {
			return;
		}
		this.initialized = true;
		this.debugEnabled = debugEnabled;
		if (!debugEnabled) return;

		ensureMultiAuthDebugDirectory(this.debugDir);
		this.writer = new AsyncBufferedLogWriter({
			enabled: true,
			logPath: this.logPath,
			ensureDirectory: () => ensureMultiAuthDebugDirectory(this.debugDir),
			createDroppedEntriesLine: (droppedEntries) =>
				`${safeJsonStringify({
					timestamp: new Date().toISOString(),
					level: "warn",
					extension: MULTI_AUTH_EXTENSION_ID,
					event: "debug_log_overflow",
					droppedEntries,
				})}\n`,
		});
	}

	log(event: string, payload: Record<string, unknown> = {}): void {
		try {
			if (!this.debugEnabled || !this.writer) return;
			this.writer.writeLine(
				`${safeJsonStringify({
					timestamp: new Date().toISOString(),
					level: "debug",
					extension: MULTI_AUTH_EXTENSION_ID,
					event,
					...payload,
				})}\n`,
			);
		} catch {
			// Debug log failures must never affect credential rotation.
		}
	}

	flush(): Promise<void> {
		return this.writer?.flush() ?? Promise.resolve();
	}
}

export const multiAuthDebugLogger = new MultiAuthDebugLogger();
