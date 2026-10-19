/**
 * Real sessions for route-level tests: accounts are provisioned through the
 * same CLI code path an owner uses, and sign-in goes through Better Auth's own
 * HTTP handler, so every test request carries a genuine session cookie.
 */

import { getAuth } from "../auth";
import { db } from "../db";
import type { HumanRole } from "../identity";
import { provisionUser } from "../users";

export const BASE = "http://localhost:3000";
const PASSWORD = "correct-horse-battery-staple-42";

export async function signedInAs(
  role: HumanRole,
  options: { email?: string; businessId?: string } = {},
): Promise<string> {
  const email = options.email ?? `${role.toLowerCase()}-${Math.random().toString(36).slice(2, 8)}@smartjeans.example`;
  await provisionUser({
    email,
    name: `${role} test user`,
    role,
    password: PASSWORD,
    businessId: options.businessId,
    allowAdditionalOwner: true,
    createdBy: "test",
  });
  return signIn(email, PASSWORD);
}

export async function signIn(email: string, password: string): Promise<string> {
  const auth = (await getAuth())!;
  const response = await auth.handler(
    new Request(`${BASE}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify({ email, password }),
    }),
  );
  if (!response.ok) throw new Error(`sign-in failed: ${response.status} ${await response.text()}`);
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

export function jsonRequest(path: string, body: unknown, cookie?: string): Request {
  return new Request(`${BASE}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: BASE,
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

export function getRequest(path: string, cookie?: string): Request {
  return new Request(`${BASE}${path}`, { headers: cookie ? { cookie } : {} });
}

/** Force a session past its expiry, as if the user had walked away. */
export function expireSessions() {
  db().prepare("UPDATE session SET expiresAt = ?").run(new Date(Date.now() - 60_000).toISOString());
}
