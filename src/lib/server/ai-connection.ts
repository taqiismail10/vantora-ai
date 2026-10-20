/**
 * Per-company AI connection: encrypted credential storage and CRUD.
 *
 * API keys are encrypted with AES-256-GCM before writing to SQLite.
 * The ciphertext binds company_id and connection_id as authenticated
 * associated data, so a row copied to another company's context decrypts
 * as a MAC failure rather than the wrong key.
 *
 * AI_CREDENTIAL_ENCRYPTION_KEY must be present (64-char hex of 32 bytes).
 * The server refuses to start credential operations without it.
 * It never appears in API responses, logs, audit payloads or prompts.
 */

import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";

import { db, transaction } from "./db";
import { AccessError } from "./identity";

// ---------------------------------------------------------------------- types

export interface AiConnection {
  id: string;
  companyId: string;
  provider: "gemini" | "openrouter";
  model: string;
  baseUrl: string | null;
  providerRestrictions: { order?: string[]; require_parameters?: boolean } | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  testedAt: number | null;
  testRevision: number;
}

interface Row {
  id: string;
  company_id: string;
  provider: string;
  model: string;
  encrypted_key: string;
  base_url: string | null;
  provider_restrictions_json: string | null;
  created_by: string;
  created_at: number;
  updated_at: number;
  tested_at: number | null;
  test_revision: number;
}

// ----------------------------------------------------------------- encryption

function encryptionKey(): Buffer {
  const raw = (process.env.AI_CREDENTIAL_ENCRYPTION_KEY ?? "").trim();
  if (raw.length !== 64) {
    throw new AccessError(
      503,
      "AI_CREDENTIAL_ENCRYPTION_KEY is not set or has the wrong length. " +
        "Generate it with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
    );
  }
  const buf = Buffer.from(raw, "hex");
  if (buf.length !== 32) throw new AccessError(503, "AI_CREDENTIAL_ENCRYPTION_KEY is not valid hex");
  return buf;
}

function encryptApiKey(plaintext: string, companyId: string, connectionId: string): string {
  const key = encryptionKey();
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(`${companyId}:${connectionId}`, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${nonce.toString("hex")}:${ct.toString("hex")}:${tag.toString("hex")}`;
}

export function decryptApiKey(stored: string, companyId: string, connectionId: string): string {
  const key = encryptionKey();
  const parts = stored.split(":");
  if (parts.length !== 3) throw new AccessError(503, "Stored credential format is invalid");
  const [nonceHex, ctHex, tagHex] = parts;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(nonceHex, "hex"));
    decipher.setAAD(Buffer.from(`${companyId}:${connectionId}`, "utf8"));
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    return decipher.update(Buffer.from(ctHex, "hex")).toString("utf8") + decipher.final("utf8");
  } catch {
    throw new AccessError(503, "Credential decryption failed (wrong key or tampered record)");
  }
}

// ---------------------------------------------------------------------- mappers

function rowToConnection(row: Row): AiConnection {
  return {
    id: row.id,
    companyId: row.company_id,
    provider: row.provider as "gemini" | "openrouter",
    model: row.model,
    baseUrl: row.base_url ?? null,
    providerRestrictions: row.provider_restrictions_json ? JSON.parse(row.provider_restrictions_json) : null,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    testedAt: row.tested_at ?? null,
    testRevision: row.test_revision,
  };
}

// ----------------------------------------------------------------------- CRUD

export function getConnection(companyId: string): AiConnection | null {
  const row = db()
    .prepare("SELECT * FROM ai_connection WHERE company_id = ?")
    .get(companyId) as Row | undefined;
  return row ? rowToConnection(row) : null;
}

/** Returns the stored row including encrypted_key (server-only). */
export function getConnectionWithKey(companyId: string): (AiConnection & { encryptedKey: string }) | null {
  const row = db()
    .prepare("SELECT * FROM ai_connection WHERE company_id = ?")
    .get(companyId) as Row | undefined;
  if (!row) return null;
  return { ...rowToConnection(row), encryptedKey: row.encrypted_key };
}

export function createOrReplaceConnection(input: {
  companyId: string;
  provider: "gemini" | "openrouter";
  model: string;
  apiKey: string;
  baseUrl?: string | null;
  providerRestrictions?: { order?: string[]; require_parameters?: boolean } | null;
  createdBy: string;
}): AiConnection {
  const id = randomUUID();
  const now = Date.now();
  const encryptedKey = encryptApiKey(input.apiKey, input.companyId, id);

  return transaction((d) => {
    // Remove any existing connection first — one per company
    d.prepare("DELETE FROM ai_connection WHERE company_id = ?").run(input.companyId);
    d.prepare(`
      INSERT INTO ai_connection
        (id, company_id, provider, model, encrypted_key, base_url,
         provider_restrictions_json, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.companyId,
      input.provider,
      input.model,
      encryptedKey,
      input.baseUrl ?? null,
      input.providerRestrictions ? JSON.stringify(input.providerRestrictions) : null,
      input.createdBy,
      now,
      now,
    );
    return rowToConnection(
      d.prepare("SELECT * FROM ai_connection WHERE id = ?").get(id) as unknown as Row,
    );
  });
}

export function markConnectionTested(companyId: string): void {
  db()
    .prepare("UPDATE ai_connection SET tested_at = ?, test_revision = test_revision + 1 WHERE company_id = ?")
    .run(Date.now(), companyId);
}

export function removeConnection(companyId: string): void {
  transaction((d) => {
    d.prepare("DELETE FROM ai_connection WHERE company_id = ?").run(companyId);
    // Pause any mandate that depended on this connection
    d.prepare("UPDATE monitoring_mandate SET status = 'paused' WHERE company_id = ?").run(companyId);
  });
}

// ----------------------------------------- validation helpers (no key exposure)

const SUPPORTED_GEMINI_MODELS = ["gemini-2.0-flash", "gemini-2.0-flash-lite", "gemini-1.5-pro", "gemini-1.5-flash", "gemini-3.1-flash-lite"];
const MAX_MODEL_ID_LENGTH = 120;

export function validateConnectionInput(input: {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl?: string | null;
}): string | null {
  if (input.provider !== "gemini" && input.provider !== "openrouter") {
    return "provider must be 'gemini' or 'openrouter'";
  }
  if (!input.model || input.model.length > MAX_MODEL_ID_LENGTH) {
    return "model is required (max 120 characters)";
  }
  if (!input.apiKey || input.apiKey.length < 8) {
    return "apiKey must be at least 8 characters";
  }
  if (input.provider === "gemini") {
    const knownGemini = SUPPORTED_GEMINI_MODELS.some((m) => input.model.startsWith(m.split("-").slice(0, 2).join("-")));
    if (!knownGemini && !input.model.startsWith("gemini-")) {
      return `model '${input.model.slice(0, 40)}' does not look like a Gemini model id (expected 'gemini-...')`;
    }
  }
  if (input.provider === "openrouter" && input.baseUrl) {
    try {
      const url = new URL(input.baseUrl);
      const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
      if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
        return "baseUrl must be https (http only for localhost)";
      }
    } catch {
      return "baseUrl is not a valid URL";
    }
  }
  return null;
}
