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

/** Fields that contain secrets and should be encrypted at rest. */
const SENSITIVE_CONFIG_FIELDS = new Set([
  "applicationPassword",
  "accessToken",
  "adminToken",
  "apiToken",
  "adminApiKey",
  "apiKey",
  "integrationToken",
  "secret",
  "token",
  "username",
]);

/**
 * Fields added to SENSITIVE_CONFIG_FIELDS after rows already held them in
 * plaintext (inside a config flagged __encrypted). Decrypting those raw values
 * fails; for these fields only, a failure means "stored before encryption" and
 * the value is returned as-is. It is encrypted the next time the integration is
 * saved. Every other field still fails loudly, so a wrong ENCRYPTION_KEY is not
 * masked.
 */
const LEGACY_PLAINTEXT_FIELDS = new Set(["token"]);

/** Encrypt sensitive fields in a config object before storage. */
export function encryptConfig(config: Record<string, unknown>): Record<string, unknown> {
  const result = { ...config };
  for (const key of Object.keys(result)) {
    if (SENSITIVE_CONFIG_FIELDS.has(key) && typeof result[key] === "string") {
      result[key] = encrypt(result[key] as string);
    }
  }
  result.__encrypted = true;
  return result;
}

/** Decrypt sensitive fields in a stored config object. */
export function decryptConfig(config: Record<string, unknown>): Record<string, unknown> {
  if (!config.__encrypted) return config;
  const result = { ...config };
  for (const key of Object.keys(result)) {
    if (SENSITIVE_CONFIG_FIELDS.has(key) && typeof result[key] === "string") {
      try {
        result[key] = decrypt(result[key] as string);
      } catch (err) {
        if (!LEGACY_PLAINTEXT_FIELDS.has(key)) throw err;
      }
    }
  }
  delete result.__encrypted;
  return result;
}
