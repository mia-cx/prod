import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  type BinaryLike,
} from "node:crypto";

import { ModelCredentialError } from "./contracts.js";

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const API_KEY_ENVELOPE_VERSION = 1 as const;

export type ApiKeyEncryptionContext = Readonly<{
  guildId: string;
  purpose: string;
  provider: string;
}>;

export type EncryptedApiKey = Readonly<{
  ciphertext: string;
  nonce: string;
  authTag: string;
  hint: string;
  envelopeVersion: typeof API_KEY_ENVELOPE_VERSION;
}>;

export class InvalidEncryptionKeyError extends Error {
  override readonly name = "InvalidEncryptionKeyError";
}

export const decodeEncryptionKey = (encoded: string): Buffer => {
  const normalized = encoded.trim();
  const decoded = Buffer.from(normalized, "base64");
  if (
    decoded.length !== KEY_BYTES ||
    decoded.toString("base64").replaceAll("=", "") !==
      normalized.replaceAll("=", "")
  ) {
    throw new InvalidEncryptionKeyError(
      "API_KEY_ENCRYPTION_KEY must be a base64-encoded 32-byte key",
    );
  }
  return decoded;
};

const HINT_MIN_REVEAL_LENGTH = 16;

const keyHint = (apiKey: string): string =>
  apiKey.length < HINT_MIN_REVEAL_LENGTH
    ? "•".repeat(8)
    : `${apiKey.slice(0, 4)}${"•".repeat(apiKey.length - 8)}${apiKey.slice(-4)}`;

const associatedData = (context: ApiKeyEncryptionContext): Buffer =>
  Buffer.from(
    JSON.stringify([
      "@mia-cx/protocord-model-settings/api-key",
      API_KEY_ENVELOPE_VERSION,
      context.guildId,
      context.purpose,
      context.provider,
    ]),
    "utf8",
  );

export const encryptApiKey = (
  apiKey: string,
  encryptionKey: BinaryLike,
  context: ApiKeyEncryptionContext,
): EncryptedApiKey => {
  if (apiKey.trim().length === 0) {
    throw new TypeError("API key must not be empty");
  }
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, nonce, {
    authTagLength: AUTH_TAG_BYTES,
  });
  cipher.setAAD(associatedData(context));
  const ciphertext = Buffer.concat([
    cipher.update(apiKey, "utf8"),
    cipher.final(),
  ]);
  return Object.freeze({
    ciphertext: ciphertext.toString("base64"),
    nonce: nonce.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    hint: keyHint(apiKey),
    envelopeVersion: API_KEY_ENVELOPE_VERSION,
  });
};

const decodePart = (value: string, expectedLength?: number): Buffer => {
  const decoded = Buffer.from(value, "base64");
  if (
    decoded.toString("base64").replaceAll("=", "") !==
      value.replaceAll("=", "") ||
    (expectedLength !== undefined && decoded.length !== expectedLength)
  ) {
    throw new ModelCredentialError();
  }
  return decoded;
};

export const decryptApiKey = (
  encrypted: Pick<EncryptedApiKey, "ciphertext" | "nonce" | "authTag">,
  encryptionKey: BinaryLike,
  context: ApiKeyEncryptionContext,
  envelopeVersion: number,
): string => {
  try {
    if (envelopeVersion !== API_KEY_ENVELOPE_VERSION) {
      throw new ModelCredentialError();
    }
    const decipher = createDecipheriv(
      "aes-256-gcm",
      encryptionKey,
      decodePart(encrypted.nonce, NONCE_BYTES),
      { authTagLength: AUTH_TAG_BYTES },
    );
    decipher.setAAD(associatedData(context));
    decipher.setAuthTag(decodePart(encrypted.authTag, AUTH_TAG_BYTES));
    return Buffer.concat([
      decipher.update(decodePart(encrypted.ciphertext)),
      decipher.final(),
    ]).toString("utf8");
  } catch (error) {
    if (error instanceof ModelCredentialError) throw error;
    throw new ModelCredentialError();
  }
};
