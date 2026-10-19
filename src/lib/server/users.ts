/**
 * Owner-controlled account provisioning. Called only from `scripts/users.ts`,
 * which runs on the server with filesystem access — that access *is* the
 * owner's authority. There is no HTTP path into any function here.
 */

import { randomBytes } from "node:crypto";

import { getAuth, withProvisioning } from "./auth";
import { db } from "./db";
import { DEFAULT_BUSINESS_ID, type HumanRole } from "./identity";

const ROLES: HumanRole[] = ["OWNER", "ANALYST", "VIEWER"];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface ProvisionInput {
  email: string;
  name: string;
  role: HumanRole;
  /** Omit to generate one; it is returned once and stored only as a hash. */
  password?: string;
  businessId?: string;
  /** Required to add an OWNER when one already exists. */
  allowAdditionalOwner?: boolean;
  createdBy: string;
}

export interface ProvisionResult {
  userId: string;
  email: string;
  role: HumanRole;
  businessId: string;
  generatedPassword: string | null;
}

async function requireAuth() {
  const auth = await getAuth();
  if (!auth) throw new Error("BETTER_AUTH_SECRET is not set (32+ characters); configure it before provisioning users");
  return auth;
}

export function ownerCount(businessId = DEFAULT_BUSINESS_ID): number {
  const row = db()
    .prepare("SELECT COUNT(*) AS n FROM membership WHERE business_id = ? AND role = 'OWNER'")
    .get(businessId) as { n: number };
  return Number(row.n);
}

export async function provisionUser(input: ProvisionInput): Promise<ProvisionResult> {
  const auth = await requireAuth();
  const email = input.email.trim().toLowerCase();
  const businessId = input.businessId ?? DEFAULT_BUSINESS_ID;
  if (!EMAIL.test(email)) throw new Error(`not an email address: ${input.email}`);
  if (!ROLES.includes(input.role)) throw new Error(`role must be one of ${ROLES.join(", ")}`);
  if (!input.name.trim()) throw new Error("name is required");
  if (input.role === "OWNER" && ownerCount(businessId) > 0 && !input.allowAdditionalOwner) {
    throw new Error(
      `${businessId} already has an OWNER. Re-run with --allow-additional-owner to add another deliberately.`,
    );
  }

  const generatedPassword = input.password ? null : randomBytes(18).toString("base64url");
  const password = input.password ?? generatedPassword!;

  const created = await withProvisioning(() =>
    auth.api.signUpEmail({ body: { email, password, name: input.name.trim() } }),
  );
  const userId = created.user.id;

  db()
    .prepare(
      "INSERT INTO membership (user_id, business_id, role, created_at, created_by) VALUES (?, ?, ?, ?, ?)",
    )
    .run(userId, businessId, input.role, Date.now(), input.createdBy);

  return { userId, email, role: input.role, businessId, generatedPassword };
}

function userIdFor(email: string): string {
  const row = db().prepare('SELECT id FROM "user" WHERE email = ?').get(email.trim().toLowerCase()) as
    | { id: string }
    | undefined;
  if (!row) throw new Error(`no account for ${email}`);
  return row.id;
}

/** Change a role. Ends the user's sessions so the change cannot be outlived by an open tab. */
export async function setRole(email: string, role: HumanRole, businessId = DEFAULT_BUSINESS_ID) {
  await requireAuth();
  if (!ROLES.includes(role)) throw new Error(`role must be one of ${ROLES.join(", ")}`);
  const userId = userIdFor(email);
  const current = db()
    .prepare("SELECT role FROM membership WHERE user_id = ? AND business_id = ?")
    .get(userId, businessId) as { role: HumanRole } | undefined;
  if (current?.role === "OWNER" && role !== "OWNER" && ownerCount(businessId) <= 1) {
    throw new Error("refusing to demote the last OWNER; add another owner first");
  }
  db()
    .prepare(
      `INSERT INTO membership (user_id, business_id, role, created_at, created_by) VALUES (?, ?, ?, ?, 'cli')
       ON CONFLICT (user_id, business_id) DO UPDATE SET role = excluded.role`,
    )
    .run(userId, businessId, role, Date.now());
  db().prepare("DELETE FROM session WHERE userId = ?").run(userId);
}

/** Remove access entirely: memberships and every live session. */
export async function revokeUser(email: string) {
  await requireAuth();
  const userId = userIdFor(email);
  const owners = db()
    .prepare("SELECT business_id FROM membership WHERE user_id = ? AND role = 'OWNER'")
    .all(userId) as { business_id: string }[];
  for (const { business_id } of owners) {
    if (ownerCount(business_id) <= 1) throw new Error(`refusing to revoke the last OWNER of ${business_id}`);
  }
  db().prepare("DELETE FROM membership WHERE user_id = ?").run(userId);
  db().prepare("DELETE FROM session WHERE userId = ?").run(userId);
}

export async function listUsers() {
  await requireAuth();
  return db()
    .prepare(
      `SELECT u.email AS email, u.name AS name, m.business_id AS business_id, m.role AS role,
              (SELECT COUNT(*) FROM session s WHERE s.userId = u.id) AS sessions
         FROM "user" u LEFT JOIN membership m ON m.user_id = u.id ORDER BY u.email`,
    )
    .all() as {
    email: string;
    name: string;
    business_id: string | null;
    role: HumanRole | null;
    sessions: number;
  }[];
}
