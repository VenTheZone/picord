import crypto from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const ITERATIONS = 100_000;

let cachedKey: { key: Buffer; envVar: string } | null = null;

/**
 * Gets the encryption key from PICORD_ENCRYPTION_KEY env var.
 * Returns null if not set.
 */
export function getEncryptionKey(): Buffer | null {
	const envKey = process.env.PICORD_ENCRYPTION_KEY;
	if (!envKey) {
		return null;
	}

	// Cache the derived key to avoid re-deriving on every operation
	if (cachedKey && cachedKey.envVar === envKey) {
		return cachedKey.key;
	}

	// Derive a proper key from the env var using PBKDF2
	const salt = crypto
		.createHash("sha256")
		.update("picord-encryption-salt")
		.digest();
	const key = crypto.pbkdf2Sync(envKey, salt, ITERATIONS, KEY_LENGTH, "sha256");

	cachedKey = { key, envVar: envKey };
	return key;
}

/**
 * Checks if encryption is configured.
 */
export function isEncryptionAvailable(): boolean {
	return getEncryptionKey() !== null;
}

/**
 * Encrypts a string value using AES-256-GCM.
 * Returns null if encryption key is not available.
 */
export function encryptString(plaintext: string): string | null {
	const key = getEncryptionKey();
	if (!key) {
		return null;
	}

	const iv = crypto.randomBytes(IV_LENGTH);
	const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

	const encrypted = Buffer.concat([
		cipher.update(plaintext, "utf8"),
		cipher.final(),
	]);

	const authTag = cipher.getAuthTag();

	// Format: base64(iv):base64(authTag):base64(encrypted)
	return `${iv.toString("base64")}:${authTag.toString("base64")}:${encrypted.toString("base64")}`;
}

/**
 * Decrypts an encrypted string.
 * Returns null if decryption fails or key is not available.
 */
export function decryptString(encrypted: string): string | null {
	const key = getEncryptionKey();
	if (!key) {
		return null;
	}

	try {
		const parts = encrypted.split(":");
		if (parts.length !== 3) {
			return null;
		}

		const [ivB64, authTagB64, dataB64] = parts;
		const iv = Buffer.from(ivB64!, "base64");
		const authTag = Buffer.from(authTagB64!, "base64");
		const data = Buffer.from(dataB64!, "base64");

		const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
		decipher.setAuthTag(authTag);

		const decrypted = Buffer.concat([
			decipher.update(data),
			decipher.final(),
		]);

		return decrypted.toString("utf8");
	} catch {
		return null;
	}
}

/**
 * Checks if a string looks like an encrypted value.
 */
export function isEncryptedString(value: string): boolean {
	const parts = value.split(":");
	if (parts.length !== 3) {
		return false;
	}
	// Each part should be valid base64
	try {
		Buffer.from(parts[0]!, "base64");
		Buffer.from(parts[1]!, "base64");
		Buffer.from(parts[2]!, "base64");
		return true;
	} catch {
		return false;
	}
}

/**
 * Generates a random encryption key suitable for PICORD_ENCRYPTION_KEY.
 * Run this and store the result securely.
 */
export function generateEncryptionKey(): string {
	return crypto.randomBytes(32).toString("base64");
}
