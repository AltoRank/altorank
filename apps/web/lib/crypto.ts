import crypto from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function getKey(): Buffer {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) throw new Error("ENCRYPTION_KEY env var is required");
  // Key must be 32 bytes — if provided as hex (64 chars), decode it
  if (key.length === 64) return Buffer.from(key, "hex");
  // Otherwise, derive a 32-byte key via SHA-256
  return crypto.createHash("sha256").update(key).digest();
}

/**
 * Encrypt a string using AES-256-GCM.
 * Returns a base64-encoded string: iv + ciphertext + authTag.
 */
export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  // iv (12) + encrypted + tag (16) → base64
  return Buffer.concat([iv, encrypted, authTag]).toString("base64");
}

/**
 * Decrypt a base64-encoded AES-256-GCM string.
 */
export function decrypt(encoded: string): string {
  const key = getKey();
  const data = Buffer.from(encoded, "base64");

  const iv = data.subarray(0, IV_LENGTH);
  const authTag = data.subarray(data.length - TAG_LENGTH);
  const ciphertext = data.subarray(IV_LENGTH, data.length - TAG_LENGTH);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  return decipher.update(ciphertext) + decipher.final("utf8");
}

// ─── Config-level encryption helpers ──────────────────────────────────────────

/**
 * Fields that contain secrets and should be encrypted at rest.
 *
 * Versioned, because the set is part of the stored format: `decryptConfig`
 * decrypts every listed field it finds, so a field added to the list is
 * decrypted on rows written before it was there - and those hold plaintext,
 * which GCM rejects. Rows record the version they were written with
 * (`__encrypted: true` is version 1) and are read with that version's list.
 *
 *   v1  the original set. `token` was missing, so the git adapter's GitHub
 *       token sat in the clear in workspace_integrations.config.
 *   v2  adds `token` (git, wordpress-plugin).
 *   v3  adds `clientSecret` (shopify client-credentials apps). `clientId` is
 *       not listed: Shopify treats it as public, and it is the cache key.
 */
const SENSITIVE_CONFIG_FIELDS_V1 = new Set([
  "applicationPassword",
  "accessToken",
  "adminToken",
  "apiToken",
  "adminApiKey",
  "apiKey",
  "integrationToken",
  "secret",
  "username",
]);
const SENSITIVE_CONFIG_FIELDS_V2 = new Set([...SENSITIVE_CONFIG_FIELDS_V1, "token"]);
const SENSITIVE_CONFIG_FIELDS_V3 = new Set([...SENSITIVE_CONFIG_FIELDS_V2, "clientSecret"]);
const CURRENT_VERSION = 3;

function fieldsForVersion(version: unknown): Set<string> {
  switch (version) {
    case 3:
      return SENSITIVE_CONFIG_FIELDS_V3;
    case 2:
      return SENSITIVE_CONFIG_FIELDS_V2;
    default:
      return SENSITIVE_CONFIG_FIELDS_V1;
  }
}

/** Encrypt sensitive fields in a config object before storage. */
export function encryptConfig(config: Record<string, unknown>): Record<string, unknown> {
  const result = { ...config };
  for (const key of Object.keys(result)) {
    if (SENSITIVE_CONFIG_FIELDS_V3.has(key) && typeof result[key] === "string") {
      result[key] = encrypt(result[key] as string);
    }
  }
  result.__encrypted = CURRENT_VERSION;
  return result;
}

/** Decrypt sensitive fields in a stored config object. */
export function decryptConfig(config: Record<string, unknown>): Record<string, unknown> {
  if (!config.__encrypted) return config;
  const fields = fieldsForVersion(config.__encrypted);
  const result = { ...config };
  for (const key of Object.keys(result)) {
    if (fields.has(key) && typeof result[key] === "string") {
      result[key] = decrypt(result[key] as string);
    }
  }
  delete result.__encrypted;
  return result;
}
