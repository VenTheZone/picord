/**
 * Barrel re-export for picord's multi-auth integration.
 * Import from here instead of drilling into individual multi-auth files.
 */
export { AccountManager } from "./account-manager.js";
export type {
	SupportedProviderId,
	ProviderStatus,
	CredentialStatus,
	CredentialType,
	RotationMode,
} from "./types.js";
