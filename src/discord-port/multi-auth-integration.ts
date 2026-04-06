/**
 * Thin integration wrapper that re-exports the multi-auth pieces picord needs,
 * initialised from picord's runtime config (statePath / config).
 *
 * This file sits between picord's index.ts and the multi-auth src tree.
 */
export { AccountManager } from "../multi-auth/account-manager.js";
export { registerGlobalKeyDistributor, unregisterGlobalKeyDistributor } from "../multi-auth/balancer/global-distributor.js";
export { registerMultiAuthProviders } from "../multi-auth/provider.js";
export {
	initMultiAuthConfig,
	RESOLVE_EXT_ROOT,
	RESOLVE_EXT_DEBUG_DIR,
} from "../multi-auth/multi-auth-config.js";
export { multiAuthDebugLogger } from "../multi-auth/debug-logger.js";
