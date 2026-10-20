import { describe, expect, it } from "vitest";

import { GET as authGet, POST as authPost } from "../../../app/api/auth/[...all]/route";
import { getAuth } from "../auth";
import { db } from "../db";
import { AccessError, requireActor } from "../identity";
import { provisionUser, setRole } from "../users";
import { BASE, expireSessions, getRequest, jsonRequest, signIn, signedInAs } from "./helpers";

describe("authentication", () => {
  it("resolves the signed-in human and their server-side role", async () => {
    const cookie = await signedInAs("ANALYST");
    const actor = await requireActor(getRequest("/api/state", cookie), "read");
    expect(actor.role).toBe("ANALYST");
    expect(actor.businessId).toBe("smart-jeans-mfg");
  });

  it("rejects anonymous callers with 401", async () => {
    await expect(requireActor(getRequest("/api/state"), "read")).rejects.toMatchObject({ status: 401 });
  });

  it("lets a new account sign up, holding membership in no company at all", async () => {
    const viaRoute = await authPost(
      jsonRequest("/api/auth/sign-up/email", { email: "self@x.example", password: "longenough-password", name: "Me" }),
    );
    expect(viaRoute.status).toBe(200);
    expect(db().prepare('SELECT COUNT(*) AS n FROM "user" WHERE email = ?').get("self@x.example")).toEqual({ n: 1 });

    // Registering grants nothing: until this account creates a company it is
    // a member of nowhere, so every company-scoped route refuses it.
    const cookie = await signIn("self@x.example", "longenough-password");
    const error = await requireActor(getRequest("/", cookie), "read").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AccessError);
    expect((error as AccessError).status).toBe(403);
    expect(db().prepare("SELECT COUNT(*) AS n FROM membership WHERE user_id = (SELECT id FROM \"user\" WHERE email = ?)").get("self@x.example")).toEqual({ n: 0 });
  });

  it("still refuses sign-up entirely when the server disables it", async () => {
    const previous = process.env.VANTORA_PUBLIC_SIGNUP;
    process.env.VANTORA_PUBLIC_SIGNUP = "off";
    try {
      const viaRoute = await authPost(
        jsonRequest("/api/auth/sign-up/email", { email: "locked@x.example", password: "longenough-password", name: "No" }),
      );
      expect(viaRoute.status).toBe(403);

      // Even straight at Better Auth's handler the hook refuses the insert.
      // Better Auth still answers 200 with a synthetic user (it does not reveal
      // whether an address exists), so the assertion is on what matters: no
      // account row and no way to sign in with it.
      const auth = (await getAuth())!;
      await auth.handler(
        jsonRequest("/api/auth/sign-up/email", { email: "locked@x.example", password: "longenough-password", name: "No" }),
      );
      expect(db().prepare('SELECT COUNT(*) AS n FROM "user" WHERE email = ?').get("locked@x.example")).toEqual({ n: 0 });
      await expect(signIn("locked@x.example", "longenough-password")).rejects.toThrow(/sign-in failed/);
    } finally {
      if (previous === undefined) delete process.env.VANTORA_PUBLIC_SIGNUP;
      else process.env.VANTORA_PUBLIC_SIGNUP = previous;
    }
  });

  it("rejects a wrong password", async () => {
    await provisionUser({
      email: "pw@smartjeans.example",
      name: "PW",
      role: "VIEWER",
      password: "the-right-password-123",
      createdBy: "test",
    });
    await expect(signIn("pw@smartjeans.example", "the-wrong-password-123")).rejects.toThrow(/sign-in failed/);
  });

  it("stops honouring a session once it expires", async () => {
    const cookie = await signedInAs("OWNER");
    await requireActor(getRequest("/", cookie), "read");
    expireSessions();
    await expect(requireActor(getRequest("/", cookie), "read")).rejects.toMatchObject({ status: 401 });
  });

  it("ends sessions on sign-out", async () => {
    const cookie = await signedInAs("VIEWER");
    const out = await authPost(jsonRequest("/api/auth/sign-out", {}, cookie));
    expect(out.ok).toBe(true);
    await expect(requireActor(getRequest("/", cookie), "read")).rejects.toMatchObject({ status: 401 });
  });

  it("applies a demotion on the very next request", async () => {
    const email = "demote@smartjeans.example";
    const cookie = await signedInAs("ANALYST", { email });
    await setRole(email, "VIEWER");
    // setRole also ends the user's sessions, so the old cookie is dead.
    await expect(requireActor(getRequest("/", cookie), "read")).rejects.toMatchObject({ status: 401 });
  });

  it("resolves a member of another business to that business, not to this one", async () => {
    const cookie = await signedInAs("OWNER", { businessId: "some-other-co" });
    const actor = await requireActor(getRequest("/", cookie), "read");
    expect(actor.businessId).toBe("some-other-co");
  });

  it("refuses a company the caller names but is not a member of", async () => {
    const cookie = await signedInAs("OWNER", { businessId: "yet-another-co" });
    const request = new Request(`${BASE}/`, { headers: { cookie, "x-vantora-company": "smart-jeans-mfg" } });
    const error = await requireActor(request, "read").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AccessError);
    expect((error as AccessError).status).toBe(403);
  });

  it("serves the session endpoint for the browser client", async () => {
    const cookie = await signedInAs("VIEWER");
    const response = await authGet(new Request(`${BASE}/api/auth/get-session`, { headers: { cookie } }));
    const session = (await response.json()) as { user?: { email?: string } };
    expect(session.user?.email).toMatch(/@smartjeans\.example$/);
  });
});
