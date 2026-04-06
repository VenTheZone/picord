/**
 * Adapter that converts picord config into the multi-auth internal config shape.
 * This replaces the standalone config.json from pi-multi-auth with picord's config system.
 */
import type { MultiAuthPicordConfig } from "../types.js";
import {
	DEFAULT_MULTI_AUTH_CONFIG,
	type MultiAuthPicordConfig as MAConfig,
} from "./multi-auth-config.js";

function mergeStreamTimeouts(
	user: MultiAuthPicordConfig["streamTimeouts"] = {},
): MAConfig["streamTimeouts"] {
	const defaults = DEFAULT_MULTI_AUTH_CONFIG.streamTimeouts;
	return {
		attemptTimeoutMs: user.attemptTimeoutMs ?? defaults.attemptTimeoutMs,
		idleTimeoutMs: user.idleTimeoutMs ?? defaults.idleTimeoutMs,
	};
}

function mergeOAuthRefresh(
	user: MultiAuthPicordConfig["oauthRefresh"] = {},
): MAConfig["oauthRefresh"] {
	const defaults = DEFAULT_MULTI_AUTH_CONFIG.oauthRefresh;
	return {
		safetyWindowMs: user.safetyWindowMs ?? defaults.safetyWindowMs,
		minRefreshWindowMs: defaults.minRefreshWindowMs,
		checkIntervalMs: user.checkIntervalMs ?? defaults.checkIntervalMs,
		maxConcurrentRefreshes: user.maxConcurrentRefreshes ?? defaults.maxConcurrentRefreshes,
		requestTimeoutMs: defaults.requestTimeoutMs,
		enabled: user.enabled ?? defaults.enabled,
	};
}

function mergeHealth(
	user: MultiAuthPicordConfig["health"] = {},
): MAConfig["health"] {
	const defaults = DEFAULT_MULTI_AUTH_CONFIG.health;
	return {
		windowSize: user.windowSize ?? defaults.windowSize,
		maxLatencyMs: user.maxLatencyMs ?? defaults.maxLatencyMs,
		uptimeWindowMs: defaults.uptimeWindowMs,
		minRequests: defaults.minRequests,
		staleThresholdMs: defaults.staleThresholdMs,
		weights: defaults.weights,
	};
}

function mergeCascade(
	user: MultiAuthPicordConfig["cascade"] = {},
): MAConfig["cascade"] {
	const defaults = DEFAULT_MULTI_AUTH_CONFIG.cascade;
	return {
		initialBackoffMs: user.initialBackoffMs ?? defaults.initialBackoffMs,
		maxBackoffMs: user.maxBackoffMs ?? defaults.maxBackoffMs,
		backoffMultiplier: user.backoffMultiplier ?? defaults.backoffMultiplier,
		maxHistoryEntries: defaults.maxHistoryEntries,
	};
}

export function buildMultiAuthExtensionConfig(
	picordConfig: MultiAuthPicordConfig,
): MAConfig {
	return {
		debug: picordConfig.debug ?? DEFAULT_MULTI_AUTH_CONFIG.debug,
		excludeProviders: [...(picordConfig.excludeProviders ?? DEFAULT_MULTI_AUTH_CONFIG.excludeProviders)],
		cascade: mergeCascade(picordConfig.cascade),
		health: mergeHealth(picordConfig.health),
		historyPersistence: DEFAULT_MULTI_AUTH_CONFIG.historyPersistence,
		oauthRefresh: mergeOAuthRefresh(picordConfig.oauthRefresh),
		streamTimeouts: mergeStreamTimeouts(picordConfig.streamTimeouts),
	};
}
