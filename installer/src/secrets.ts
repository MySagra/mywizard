import { randomBytes, randomInt } from "node:crypto";
import type { EnvMap } from "./env-file.js";

/**
 * Fully local secret generation (node:crypto), no network calls.
 */

/** Alphabet that is safe for URLs / MySQL DSNs / Redis URLs: no @ : / ? # [ ] ' " \ */
const SAFE_ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789-_";

export function randomHex(bytes = 48): string {
  return randomBytes(bytes).toString("hex");
}

export function randomPassword(length = 28): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += SAFE_ALPHABET[randomInt(SAFE_ALPHABET.length)];
  }
  return out;
}

/**
 * API keys are NOT generated: they must be created in the admin panel and
 * pasted here, so the .env only carries an explicit placeholder.
 */
export const API_KEY_PLACEHOLDER = {
  mystampa: "ms_pt_CHANGE_ME",
  myclienti: "ms_wb_CHANGE_ME",
} as const;

export interface SecretSpec {
  key: string;
  generate: () => string;
}

export const SECRET_SPECS: readonly SecretSpec[] = [
  { key: "JWT_SECRET", generate: () => randomHex(48) },
  { key: "PEPPER", generate: () => randomHex(32) },
  { key: "ROOT_PASSWORD", generate: () => randomPassword(32) },
  { key: "DB_USER_PASSWORD", generate: () => randomPassword(28) },
  { key: "REDIS_PASS", generate: () => randomPassword(28) },
  { key: "DBGATE_USER", generate: () => "admin" },
  { key: "DBGATE_PASSWORD", generate: () => randomPassword(20) },
] as const;

export type Secrets = Record<string, string>;

export interface SecretsResult {
  secrets: Secrets;
  /** keys reused from a pre-existing .env */
  reused: string[];
  /** freshly generated keys */
  generated: string[];
}

/**
 * Reuses secrets already present in the existing .env (idempotency) and only
 * generates the missing ones; `regenerate` forces a full regeneration.
 */
export function resolveSecrets(
  existing: EnvMap,
  regenerate = false,
  skip: readonly string[] = [],
): SecretsResult {
  const secrets: Secrets = {};
  const reused: string[] = [];
  const generated: string[] = [];

  for (const spec of SECRET_SPECS) {
    if (skip.includes(spec.key)) continue;
    const current = existing[spec.key];
    if (!regenerate && current !== undefined && current !== "") {
      secrets[spec.key] = current;
      reused.push(spec.key);
    } else {
      secrets[spec.key] = spec.generate();
      generated.push(spec.key);
    }
  }
  return { secrets, reused, generated };
}
