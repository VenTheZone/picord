import { join } from "node:path";
import { DEFAULT_CASCADE_CONFIG, type CascadeConfig } from "./types-cascade.js";
import {
	DEFAULT_HEALTH_CONFIG,
	DEFAULT_HEALTH_WEIGHTS,
	type HealthMetricsConfig,
} from "./types-health.js";
import { DEFAULT_OAUTH_CONFIG, type OAuthRefreshConfig } from "./types-oauth.js";
import {
	DEFAULT_STREAM_TIMEOUT_CONFIG,
	type StreamTimeoutConfig,
} from "./types-stream-timeout.js";

export const MULTI_AUTH_EXTENSION_ID = "picord-multi-auth";

export interface MultiAuthPicordConfig {
	debug: boolean;
	/** Providers to exclude from multi-auth rotation (handled by dedicated auth extensions). */
	excludeProviders: string[];
	cascade: CascadeConfig;
	health: HealthMetricsConfig;
	historyPersistence: HistoryPersistenceConfig;
	oauthRefresh: OAuthRefreshConfig;
	streamTimeouts: StreamTimeoutConfig;
}

export interface HistoryPersistenceConfig {
	enabled: boolean;
	healthFileName: string;
	cascadeFileName: string;
}

export const DEFAULT_HISTORY_PERSISTENCE_CONFIG: HistoryPersistenceConfig = {
	enabled: true,
	healthFileName: `${MULTI_AUTH_EXTENSION_ID}-health-history.json`,
	cascadeFileName: `${MULTI_AUTH_EXTENSION_ID}-cascade-history.json`,
};

export const DEFAULT_MULTI_AUTH_CONFIG: MultiAuthPicordConfig = {
	debug: false,
	excludeProviders: [],
	cascade: { ...DEFAULT_CASCADE_CONFIG },
	health: {
		...DEFAULT_HEALTH_CONFIG,
		weights: { ...DEFAULT_HEALTH_WEIGHTS },
	},
	historyPersistence: { ...DEFAULT_HISTORY_PERSISTENCE_CONFIG },
	oauthRefresh: { ...DEFAULT_OAUTH_CONFIG },
	streamTimeouts: { ...DEFAULT_STREAM_TIMEOUT_CONFIG },
};

export function cloneMultiAuthExtensionConfig(
	config: MultiAuthPicordConfig = DEFAULT_MULTI_AUTH_CONFIG,
): MultiAuthPicordConfig {
	return {
		debug: config.debug,
		excludeProviders: [...config.excludeProviders],
		cascade: { ...config.cascade },
		health: {
			...config.health,
			weights: { ...config.health.weights },
		},
		historyPersistence: cloneHistoryPersistenceConfig(config.historyPersistence),
		oauthRefresh: { ...config.oauthRefresh },
		streamTimeouts: cloneStreamTimeoutConfig(config.streamTimeouts),
	};
}

export function cloneHistoryPersistenceConfig(
	config: HistoryPersistenceConfig = DEFAULT_HISTORY_PERSISTENCE_CONFIG,
): HistoryPersistenceConfig {
	return {
		enabled: config.enabled,
		healthFileName: config.healthFileName,
		cascadeFileName: config.cascadeFileName,
	};
}

export function cloneStreamTimeoutConfig(
	config: StreamTimeoutConfig = DEFAULT_STREAM_TIMEOUT_CONFIG,
): StreamTimeoutConfig {
	return {
		attemptTimeoutMs: config.attemptTimeoutMs,
		idleTimeoutMs: config.idleTimeoutMs,
	};
}

function resolveExtensionRoot(moduleUrl = import.meta.url): string {
	const filePath = new URL(moduleUrl).pathname;
	const segments = filePath.split("/").filter(Boolean);
	if (segments[segments.length - 1] === "multi-auth-config.js" ||
		segments[segments.length - 1] === "multi-auth-config.ts") {
		return segments.slice(0, -1).join("/");
	}
	return segments.slice(0, -2).join("/");
}

// These will be overridden at runtime by initMultiAuthConfig()
let RUNTIME_EXT_ROOT = resolveExtensionRoot();
let RUNTIME_STATE_PATH: string | undefined = undefined;

export function RESOLVE_EXT_ROOT(): string {
	return RUNTIME_EXT_ROOT;
}

export function RESOLVE_EXT_DEBUG_DIR(): string {
	return join(RESOLVE_EXT_ROOT(), "debug");
}

export interface HistoryPersistencePaths {
	healthPath: string;
	cascadePath: string;
}

export function resolveStateHistoryPersistencePaths(
	config: HistoryPersistenceConfig,
	debugDir = RESOLVE_EXT_DEBUG_DIR(),
): HistoryPersistencePaths {
	return {
		healthPath: join(debugDir, config.healthFileName),
		cascadePath: join(debugDir, config.cascadeFileName),
	};
}

import { mkdirSync } from "node:fs";

export function ensureMultiAuthDebugDirectory(debugDir = RESOLVE_EXT_DEBUG_DIR()): string | undefined {
	try {
		mkdirSync(debugDir, { recursive: true });
		return undefined;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return `Failed to create picord-multi-auth debug directory '${debugDir}': ${message}`;
	}
}

/**
 * Initialize multi-auth config from a picord runtime state path.
 * This replaces the extension-root-based config loading from the original pi-multi-auth.
 */
export function initMultiAuthConfig(statePath: string, stateDir: string): void {
	RUNTIME_STATE_PATH = statePath;
	RUNTIME_EXT_ROOT = stateDir;
}

export function getMultiAuthStatePath(): string {
	if (RUNTIME_STATE_PATH) {
		return RUNTIME_STATE_PATH;
	}
	return join(RESOLVE_EXT_ROOT(), "multi-auth.json");
}

export function getAuthFilePath(): string {
	return join(RESOLVE_EXT_ROOT(), "auth.json");
}

export function getMultiAuthDebugDir(): string {
	return RESOLVE_EXT_DEBUG_DIR();
}
