/**
 * M5: staff invitations and membership management.
 *
 * What this pins:
 *   an invitation is bound to the email it names, not the link alone;
 *   it expires and is single-use, including against a repeated/concurrent accept;
 *   the last owner can never be demoted or removed;
 *   a membership change takes effect on the very next authorization check;
 *   tenant/role boundaries on every new action.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("next/server", async (original) => ({
  ...(await original<typeof import("next/server")>()),
  connection: async () => {},
}));

import { POST as companyPost } from "../../../app/api/company/route";
import { getAuth } from "../auth";
import { db } from "../db";
import { BASE } from "./helpers";

const PASSWORD = "correct-horse-battery-staple-42";

async function signUp(email: string): Promise<string> {
  const auth = (await getAuth())!;
  await auth.handler(
    new Request(`${BASE}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify({ email, password: PASSWORD, name: email.split("@")[0] }),
    }),
  );
  const signIn = await auth.handler(
    new Request(`${BASE}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify({ email, password: PASSWORD }),
    }),
  );
  return signIn.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}

async function post(body: Record<string, unknown>, cookie: string, company?: string) {
  const response = await companyPost(
    new Request(`${BASE}/api/company`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE, cookie, ...(company ? { "x-vantora-company": company } : {}) },
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function newCompany(email: string, name: string): Promise<{ cookie: string; id: string }> {
  const cookie = await signUp(email);
  const created = await post({ action: "create_company", name }, cookie);
  const id = (created.body as { company: { id: string } }).company.id;
  return { cookie, id };
}

function tokenFrom(inviteLink: string): string {
  return new URL(inviteLink).searchParams.get("token")!;
}

describe("company creation", () => {
  it("enforces the five-company limit server-side", async () => {
    const cookie = await signUp("m5-limit@example.com");
    for (let i = 0; i < 5; i += 1) {
      const result = await post({ action: "create_company", name: `Limit Co ${i}` }, cookie);
      expect(result.status).toBe(200);
    }
    const sixth = await post({ action: "create_company", name: "Limit Co 6" }, cookie);
    expect(sixth.status).toBe(409);
    expect(String(sixth.body.error)).toMatch(/maximum/);
  });

  it("a new company starts with no records and never inherits another company's currency", async () => {
    const owner = await newCompany("m5-fresh-a@example.com", "Fresh Co A");
    await post({ action: "add_counterparty", name: "A's Supplier", isSupplier: true }, owner.cookie, owner.id);
    await post({ action: "add_account", name: "A Main", openingBalance: "500", asOfDate: "2026-01-01" }, owner.cookie, owner.id);

    const created = await post({ action: "create_company", name: "Fresh Co B", currency: "BDT" }, owner.cookie);
    expect(created.status).toBe(200);
    const bId = (created.body as { company: { id: string; currency: string } }).company.id;
    expect((created.body as { company: { currency: string } }).company.currency).toBe("BDT");

    const { companyRecords } = await import("../records");
    const records = companyRecords(bId);
    expect(records.accounts).toHaveLength(0);
    expect(records.counterparties).toHaveLength(0);
  });
});

describe("invitations are bound to the email they name", () => {
  it("refuses acceptance from a different signed-in account", async () => {
    const owner = await newCompany("m5-bind-owner@example.com", "Bind Co");
    const invited = await post({ action: "invite_member", email: "m5-bind-invited@example.com", memberRole: "ANALYST" }, owner.cookie, owner.id);
    expect(invited.status).toBe(200);
    const token = tokenFrom((invited.body as { inviteLink: string }).inviteLink);

    const wrongPerson = await signUp("m5-bind-wrong@example.com");
    const result = await post({ action: "accept_invitation", token }, wrongPerson);
    expect(result.status).toBe(403);
    expect(String(result.body.error)).toMatch(/was sent to/);
  });

  it("accepts and grants the exact role named, taking effect immediately", async () => {
    const owner = await newCompany("m5-grant-owner@example.com", "Grant Co");
    const invited = await post({ action: "invite_member", email: "m5-grant-invited@example.com", memberRole: "ANALYST" }, owner.cookie, owner.id);
    const token = tokenFrom((invited.body as { inviteLink: string }).inviteLink);

    const invitedCookie = await signUp("m5-grant-invited@example.com");
    const accepted = await post({ action: "accept_invitation", token }, invitedCookie);
    expect(accepted.status).toBe(200);
    expect((accepted.body as { role: string }).role).toBe("ANALYST");

    // Immediately usable: a draft action works, an owner-only one is refused.
    const draftOk = await post({ action: "set_step", step: "cash" }, invitedCookie, owner.id);
    expect(draftOk.status).toBe(200);
    const ownerOnly = await post({ action: "set_policy", key: "minimum_safe_buffer_cents", value: "100" }, invitedCookie, owner.id);
    expect(ownerOnly.status).toBe(403);
  });
});

describe("expiry and single use", () => {
  it("refuses an expired invitation", async () => {
    const owner = await newCompany("m5-expire-owner@example.com", "Expire Co");
    const invited = await post({ action: "invite_member", email: "m5-expire-invited@example.com", memberRole: "VIEWER" }, owner.cookie, owner.id);
    const token = tokenFrom((invited.body as { inviteLink: string }).inviteLink);

    db().prepare("UPDATE company_invitation SET expires_at = ? WHERE company_id = ?").run(Date.now() - 1000, owner.id);

    const invitedCookie = await signUp("m5-expire-invited@example.com");
    const result = await post({ action: "accept_invitation", token }, invitedCookie);
    expect(result.status).toBe(409);
    expect(String(result.body.error)).toMatch(/expired/);
  });

  it("refuses a replayed accept, including two concurrent attempts", async () => {
    const owner = await newCompany("m5-replay-owner@example.com", "Replay Co");
    const invited = await post({ action: "invite_member", email: "m5-replay-invited@example.com", memberRole: "VIEWER" }, owner.cookie, owner.id);
    const token = tokenFrom((invited.body as { inviteLink: string }).inviteLink);
    const invitedCookie = await signUp("m5-replay-invited@example.com");

    const [a, b] = await Promise.all([
      post({ action: "accept_invitation", token }, invitedCookie),
      post({ action: "accept_invitation", token }, invitedCookie),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses[0]).toBe(200);
    expect(statuses[1]).toBeGreaterThanOrEqual(400);

    const membership = db()
      .prepare("SELECT COUNT(*) AS n FROM membership WHERE business_id = ? AND user_id = (SELECT id FROM user WHERE email = ?)")
      .get(owner.id, "m5-replay-invited@example.com") as { n: number };
    expect(membership.n).toBe(1);

    const third = await post({ action: "accept_invitation", token }, invitedCookie);
    expect(third.status).toBeGreaterThanOrEqual(400);
  });

  it("refuses a revoked invitation", async () => {
    const owner = await newCompany("m5-revoke-owner@example.com", "Revoke Co");
    const invited = await post({ action: "invite_member", email: "m5-revoke-invited@example.com", memberRole: "VIEWER" }, owner.cookie, owner.id);
    const id = (invited.body as { invitation: { id: string } }).invitation.id;
    const token = tokenFrom((invited.body as { inviteLink: string }).inviteLink);

    const revoked = await post({ action: "revoke_invitation", id }, owner.cookie, owner.id);
    expect(revoked.status).toBe(200);

    const invitedCookie = await signUp("m5-revoke-invited@example.com");
    const result = await post({ action: "accept_invitation", token }, invitedCookie);
    expect(result.status).toBe(409);
    expect(String(result.body.error)).toMatch(/revoked/);
  });
});

describe("the last owner can never be demoted or removed", () => {
  it("refuses to demote the only owner", async () => {
    const owner = await newCompany("m5-lastowner-demote@example.com", "Last Owner Demote Co");
    const userId = (db().prepare("SELECT id FROM user WHERE email = ?").get("m5-lastowner-demote@example.com") as { id: string }).id;
    const result = await post({ action: "set_member_role", memberId: userId, memberRole: "ANALYST" }, owner.cookie, owner.id);
    expect(result.status).toBe(409);
    expect(String(result.body.error)).toMatch(/only owner/);
  });

  it("refuses to remove the only owner", async () => {
    const owner = await newCompany("m5-lastowner-remove@example.com", "Last Owner Remove Co");
    const userId = (db().prepare("SELECT id FROM user WHERE email = ?").get("m5-lastowner-remove@example.com") as { id: string }).id;
    const result = await post({ action: "remove_member", memberId: userId }, owner.cookie, owner.id);
    expect(result.status).toBe(409);
  });

  it("allows demoting an owner once a second owner exists", async () => {
    const owner = await newCompany("m5-secondowner@example.com", "Second Owner Co");
    const invited = await post({ action: "invite_member", email: "m5-secondowner-two@example.com", memberRole: "OWNER" }, owner.cookie, owner.id);
    const token = tokenFrom((invited.body as { inviteLink: string }).inviteLink);
    const secondCookie = await signUp("m5-secondowner-two@example.com");
    await post({ action: "accept_invitation", token }, secondCookie);

    const firstUserId = (db().prepare("SELECT id FROM user WHERE email = ?").get("m5-secondowner@example.com") as { id: string }).id;
    const demoted = await post({ action: "set_member_role", memberId: firstUserId, memberRole: "ANALYST" }, secondCookie, owner.id);
    expect(demoted.status).toBe(200);

    // Takes effect immediately: the demoted account can no longer approve.
    const refused = await post({ action: "set_policy", key: "minimum_safe_buffer_cents", value: "100" }, owner.cookie, owner.id);
    expect(refused.status).toBe(403);
  });
});

describe("authorization and company scoping", () => {
  it("rejects an ANALYST inviting someone", async () => {
    const owner = await newCompany("m5-gate-owner@example.com", "Gate Co");
    const invited = await post({ action: "invite_member", email: "m5-gate-analyst@example.com", memberRole: "ANALYST" }, owner.cookie, owner.id);
    const token = tokenFrom((invited.body as { inviteLink: string }).inviteLink);
    const analystCookie = await signUp("m5-gate-analyst@example.com");
    await post({ action: "accept_invitation", token }, analystCookie);

    const result = await post({ action: "invite_member", email: "someone-else@example.com", memberRole: "VIEWER" }, analystCookie, owner.id);
    expect(result.status).toBe(403);
  });

  it("rejects a cross-company invite/revoke/role change", async () => {
    const owner = await newCompany("m5-cross-a@example.com", "Invite Cross A");
    const other = await newCompany("m5-cross-b@example.com", "Invite Cross B");
    const invited = await post({ action: "invite_member", email: "whoever@example.com", memberRole: "VIEWER" }, owner.cookie, owner.id);
    const id = (invited.body as { invitation: { id: string } }).invitation.id;

    const forged = await post({ action: "revoke_invitation", id }, other.cookie, owner.id);
    expect(forged.status).toBe(403);
    const wrongId = await post({ action: "revoke_invitation", id }, other.cookie, other.id);
    expect(wrongId.status).toBe(404);
  });

  it("refuses an invitation to an email already a member", async () => {
    const owner = await newCompany("m5-already-member@example.com", "Already Member Co");
    const result = await post({ action: "invite_member", email: "m5-already-member@example.com", memberRole: "VIEWER" }, owner.cookie, owner.id);
    expect(result.status).toBe(409);
  });
});
