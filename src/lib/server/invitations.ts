/**
 * Staff invitations and membership management.
 *
 * No email infrastructure exists on this server (the signup screen already
 * says so plainly), so an invitation is never "sent" — the owner is given a
 * copyable link and shares it however they choose. The link is honest about
 * that: nothing here claims delivery.
 *
 * An invitation is bound to the email it names — accepting it requires a
 * signed-in session whose own email matches, not merely possession of the
 * link — expires (7 days), and is single-use (`accepted_at` set once,
 * checked and burned inside one transaction, the same pattern M2's
 * settlements and M4's approvals already use for every other one-time
 * token in this app). The raw token is never stored, only its hash.
 */

import { randomBytes, randomUUID } from "node:crypto";

import { sha256 } from "../sandbox/execution-logger";
import { db, transaction } from "./db";
import { AccessError, type HumanRole } from "./identity";

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface Invitation {
  id: string;
  email: string;
  role: HumanRole;
  createdAt: number;
  expiresAt: number;
  acceptedAt: number | null;
  revokedAt: number | null;
  status: "pending" | "accepted" | "revoked" | "expired";
}

function statusOf(row: { accepted_at: number | null; revoked_at: number | null; expires_at: number }): Invitation["status"] {
  if (row.accepted_at) return "accepted";
  if (row.revoked_at) return "revoked";
  if (row.expires_at <= Date.now()) return "expired";
  return "pending";
}

export function listInvitations(companyId: string): Invitation[] {
  const rows = db()
    .prepare("SELECT * FROM company_invitation WHERE company_id = ? ORDER BY created_at DESC")
    .all(companyId) as {
    id: string;
    email: string;
    role: HumanRole;
    created_at: number;
    expires_at: number;
    accepted_at: number | null;
    revoked_at: number | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    role: r.role,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    acceptedAt: r.accepted_at,
    revokedAt: r.revoked_at,
    status: statusOf(r),
  }));
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Returns the invitation and the raw, one-time token — shown to the owner
 * exactly once; only its hash is ever stored. */
export function createInvitation(companyId: string, email: unknown, role: unknown, createdBy: string): { invitation: Invitation; token: string } {
  const cleanEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (!EMAIL.test(cleanEmail)) throw new AccessError(422, "a valid email is required");
  if (role !== "OWNER" && role !== "ANALYST" && role !== "VIEWER") throw new AccessError(422, 'role must be "OWNER", "ANALYST" or "VIEWER"');

  const existingMember = db()
    .prepare("SELECT 1 FROM membership m JOIN user u ON u.id = m.user_id WHERE m.business_id = ? AND u.email = ?")
    .get(companyId, cleanEmail);
  if (existingMember) throw new AccessError(409, `${cleanEmail} is already a member of this company`);

  const token = randomBytes(24).toString("base64url");
  const id = randomUUID();
  const now = Date.now();
  db()
    .prepare(
      "INSERT INTO company_invitation (id, company_id, email, role, token_hash, created_at, created_by, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(id, companyId, cleanEmail, role, sha256(token), now, createdBy, now + INVITATION_TTL_MS);

  const row = db().prepare("SELECT * FROM company_invitation WHERE id = ?").get(id) as {
    id: string;
    email: string;
    role: HumanRole;
    created_at: number;
    expires_at: number;
    accepted_at: number | null;
    revoked_at: number | null;
  };
  return {
    invitation: {
      id: row.id,
      email: row.email,
      role: row.role,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      acceptedAt: row.accepted_at,
      revokedAt: row.revoked_at,
      status: statusOf(row),
    },
    token,
  };
}

export function revokeInvitation(companyId: string, id: string, revokedBy: string): void {
  const changed = db()
    .prepare("UPDATE company_invitation SET revoked_at = ?, revoked_by = ? WHERE company_id = ? AND id = ? AND accepted_at IS NULL AND revoked_at IS NULL")
    .run(Date.now(), revokedBy, companyId, id);
  if (Number(changed.changes) === 0) {
    const exists = db().prepare("SELECT 1 FROM company_invitation WHERE company_id = ? AND id = ?").get(companyId, id);
    throw new AccessError(exists ? 409 : 404, exists ? "that invitation was already accepted or revoked" : "invitation not found");
  }
}

/**
 * Burns an invitation and creates the membership it grants, inside one
 * transaction so a replayed or concurrently repeated accept can succeed at
 * most once — the same `UPDATE ... WHERE accepted_at IS NULL` single-flight
 * pattern approvals.ts uses for execution.
 */
export function acceptInvitation(token: string, acceptingUserId: string, acceptingEmail: string): { companyId: string; role: HumanRole } {
  const tokenHash = sha256(token);
  return transaction((database) => {
    const row = database.prepare("SELECT * FROM company_invitation WHERE token_hash = ?").get(tokenHash) as
      | {
          id: string;
          company_id: string;
          email: string;
          role: HumanRole;
          accepted_at: number | null;
          revoked_at: number | null;
          expires_at: number;
        }
      | undefined;
    if (!row) throw new AccessError(404, "that invitation link is not valid");
    if (row.revoked_at) throw new AccessError(409, "that invitation was revoked");
    if (row.accepted_at) throw new AccessError(409, "that invitation has already been used");
    if (row.expires_at <= Date.now()) throw new AccessError(409, "that invitation has expired; ask the owner for a new one");
    if (row.email !== acceptingEmail.trim().toLowerCase()) {
      throw new AccessError(403, `this invitation was sent to ${row.email}, not the signed-in account`);
    }

    const burned = database
      .prepare("UPDATE company_invitation SET accepted_at = ?, accepted_by = ? WHERE id = ? AND accepted_at IS NULL")
      .run(Date.now(), acceptingUserId, row.id);
    if (Number(burned.changes) !== 1) throw new AccessError(409, "that invitation has already been used");

    database
      .prepare(
        "INSERT INTO membership (user_id, business_id, role, created_at, created_by) VALUES (?, ?, ?, ?, ?) ON CONFLICT (user_id, business_id) DO UPDATE SET role = excluded.role",
      )
      .run(acceptingUserId, row.company_id, row.role, Date.now(), `invitation:${row.id}`);

    return { companyId: row.company_id, role: row.role };
  });
}

// --- Membership management -------------------------------------------

export interface Member {
  userId: string;
  email: string;
  name: string;
  role: HumanRole;
}

export function listMembers(companyId: string): Member[] {
  const rows = db()
    .prepare(
      "SELECT m.user_id, u.email, u.name, m.role FROM membership m JOIN user u ON u.id = m.user_id WHERE m.business_id = ? ORDER BY m.created_at",
    )
    .all(companyId) as { user_id: string; email: string; name: string; role: HumanRole }[];
  return rows.map((r) => ({ userId: r.user_id, email: r.email, name: r.name, role: r.role }));
}

function ownerCount(companyId: string): number {
  return (
    db().prepare("SELECT COUNT(*) AS n FROM membership WHERE business_id = ? AND role = 'OWNER'").get(companyId) as { n: number }
  ).n;
}

/** Refuses to demote or remove the company's only remaining OWNER. */
export function setMemberRole(companyId: string, targetUserId: string, nextRole: HumanRole): void {
  const current = db()
    .prepare("SELECT role FROM membership WHERE business_id = ? AND user_id = ?")
    .get(companyId, targetUserId) as { role: HumanRole } | undefined;
  if (!current) throw new AccessError(404, "that person is not a member of this company");
  if (current.role === "OWNER" && nextRole !== "OWNER" && ownerCount(companyId) <= 1) {
    throw new AccessError(409, "this is the only owner — promote someone else first");
  }
  db().prepare("UPDATE membership SET role = ? WHERE business_id = ? AND user_id = ?").run(nextRole, companyId, targetUserId);
}

export function removeMember(companyId: string, targetUserId: string): void {
  const current = db()
    .prepare("SELECT role FROM membership WHERE business_id = ? AND user_id = ?")
    .get(companyId, targetUserId) as { role: HumanRole } | undefined;
  if (!current) throw new AccessError(404, "that person is not a member of this company");
  if (current.role === "OWNER" && ownerCount(companyId) <= 1) {
    throw new AccessError(409, "the only owner cannot be removed — promote someone else first");
  }
  db().prepare("DELETE FROM membership WHERE business_id = ? AND user_id = ?").run(companyId, targetUserId);
}
