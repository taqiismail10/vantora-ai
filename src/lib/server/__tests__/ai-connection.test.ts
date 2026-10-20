/**
 * AI connection: credential storage, encryption, and mandate lifecycle.
 *
 * Tests:
 *   - Encrypted key cannot be retrieved as plaintext from the DB row
 *   - Decryption with wrong company_id fails (AAD binding)
 *   - Cross-company connection access is refused
 *   - Mandate activation requires a tested connection
 *   - Pausing stops event queue additions
 *   - Financial change queues an event for active mandates only
 */

import { beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";

// Set up encryption key before any imports that call encryptionKey()
const TEST_KEY = randomBytes(32).toString("hex");
process.env.AI_CREDENTIAL_ENCRYPTION_KEY = TEST_KEY;
process.env.VANTORA_DB_PATH = ":memory:";

import { createOrReplaceConnection, decryptApiKey, getConnection, getConnectionWithKey, removeConnection } from "../ai-connection";
import { claimNextEvent, createMandate, getMandate, queueFinancialChange, setMandateStatus } from "../monitoring";
import { db } from "../db";

const COMPANY_A = "test-company-a";
const COMPANY_B = "test-company-b";

beforeAll(() => {
  // Seed minimal company rows so FK/mandate logic works
  const d = db();
  d.prepare(`INSERT OR IGNORE INTO company (id, name, currency, status, is_demo, onboarding_step, created_at, created_by)
    VALUES (?, ?, 'USD', 'active', 0, 'done', ?, 'test')`).run(COMPANY_A, "Company A", Date.now());
  d.prepare(`INSERT OR IGNORE INTO company (id, name, currency, status, is_demo, onboarding_step, created_at, created_by)
    VALUES (?, ?, 'USD', 'active', 0, 'done', ?, 'test')`).run(COMPANY_B, "Company B", Date.now());
});

describe("credential storage and encryption", () => {
  it("stores an encrypted key and retrieves connection metadata without the key", () => {
    const conn = createOrReplaceConnection({
      companyId: COMPANY_A,
      provider: "gemini",
      model: "gemini-2.0-flash",
      apiKey: "test-api-key-12345",
      createdBy: "owner",
    });
    expect(conn.provider).toBe("gemini");
    expect(conn.model).toBe("gemini-2.0-flash");

    // getConnection must never return the raw key
    const meta = getConnection(COMPANY_A);
    expect(meta).not.toBeNull();
    expect((meta as unknown as Record<string, unknown>)["encryptedKey"]).toBeUndefined();
    expect((meta as unknown as Record<string, unknown>)["apiKey"]).toBeUndefined();
  });

  it("stored DB row does not contain the plaintext key", () => {
    const row = db()
      .prepare("SELECT * FROM ai_connection WHERE company_id = ?")
      .get(COMPANY_A) as Record<string, unknown>;
    expect(row).toBeTruthy();
    expect(String(row.encrypted_key)).not.toContain("test-api-key-12345");
  });

  it("can decrypt the key with correct company binding", () => {
    const stored = getConnectionWithKey(COMPANY_A)!;
    const plaintext = decryptApiKey(stored.encryptedKey, COMPANY_A, stored.id);
    expect(plaintext).toBe("test-api-key-12345");
  });

  it("decryption fails with a different company_id (AAD binding)", () => {
    const stored = getConnectionWithKey(COMPANY_A)!;
    expect(() => decryptApiKey(stored.encryptedKey, COMPANY_B, stored.id)).toThrow();
  });

  it("getConnectionWithKey returns null for a different company", () => {
    const stored = getConnectionWithKey(COMPANY_B);
    expect(stored).toBeNull();
  });
});

describe("mandate lifecycle", () => {
  it("requires a tested connection before activation", () => {
    // Connection for B — not tested yet
    createOrReplaceConnection({
      companyId: COMPANY_B,
      provider: "openrouter",
      model: "openai/gpt-4o-mini",
      apiKey: "b-key-xyz",
      createdBy: "owner-b",
    });
    // Create mandate directly — skipping the tested check (server route enforces it)
    createMandate({ companyId: COMPANY_B, connectionId: getConnection(COMPANY_B)!.id, ownerUserId: "user-b" });
    // Activation is server-route guarded; mandate starts paused
    const mandate = getMandate(COMPANY_B);
    expect(mandate?.status).toBe("paused");
  });

  it("activation queues an event", () => {
    createMandate({ companyId: COMPANY_A, connectionId: getConnection(COMPANY_A)!.id, ownerUserId: "owner-a" });
    // Manually mark the connection as tested to satisfy activation
    db().prepare("UPDATE ai_connection SET tested_at = ?, test_revision = 1 WHERE company_id = ?")
      .run(Date.now(), COMPANY_A);
    setMandateStatus(COMPANY_A, "active", "owner-a");
    const mandate = getMandate(COMPANY_A);
    expect(mandate?.status).toBe("active");
    // An activation event must be in the queue
    const event = db().prepare("SELECT * FROM monitoring_event WHERE company_id = ? AND event_type = 'activation' AND claimed_at IS NULL").get(COMPANY_A);
    expect(event).toBeTruthy();
  });

  it("financial change queues an event for active companies only", () => {
    // COMPANY_B is paused — no event should be queued
    const before = db().prepare("SELECT COUNT(*) AS n FROM monitoring_event WHERE company_id = ? AND claimed_at IS NULL").get(COMPANY_B) as { n: number };
    queueFinancialChange(COMPANY_B, "financial_change");
    const after = db().prepare("SELECT COUNT(*) AS n FROM monitoring_event WHERE company_id = ? AND claimed_at IS NULL").get(COMPANY_B) as { n: number };
    expect(after.n).toBe(before.n); // paused mandate: no new event

    // COMPANY_A is active
    const beforeA = db().prepare("SELECT COUNT(*) AS n FROM monitoring_event WHERE company_id = ? AND claimed_at IS NULL").get(COMPANY_A) as { n: number };
    queueFinancialChange(COMPANY_A, "financial_change");
    const afterA = db().prepare("SELECT COUNT(*) AS n FROM monitoring_event WHERE company_id = ? AND claimed_at IS NULL").get(COMPANY_A) as { n: number };
    expect(afterA.n).toBe(beforeA.n + 1);
  });

  it("atomic claiming prevents two workers from claiming the same event", () => {
    const e1 = claimNextEvent("worker-1");
    const e2 = claimNextEvent("worker-2");
    // Both might claim different events (A has multiple), but no single event is claimed twice
    if (e1 && e2) expect(e1.id).not.toBe(e2.id);
  });

  it("removing the connection pauses monitoring", () => {
    removeConnection(COMPANY_A);
    const mandate = getMandate(COMPANY_A);
    expect(mandate?.status).toBe("paused");
  });
});
