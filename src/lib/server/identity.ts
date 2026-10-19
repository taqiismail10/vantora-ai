/**
 * Who is calling, and what they may do.
 *
 * Identity comes only from a verified Better Auth session cookie. Role and
 * business come only from the server-side `membership` table, re-read on every
 * request, so a demotion or revocation takes effect on the next call. Nothing
 * in a request body can name an actor, a role or a business: `rejectIdentityFields`
 * refuses any body that tries.
 *
 * The copilot is a service identity, not a human role. It holds the
 * capabilities in `AGENT_CAPABILITIES` intersected with the human it is
 * answering, and it can never hold `approve`, `simulate` or `manage`.
 */

import { getAuth } from "./auth";
import { db } from "./db";

export type HumanRole = "OWNER" | "ANALYST" | "VIEWER";

export type Capability =
  | "read" // dashboard, ledger, audit chain, read-only security probe
  | "analyze" // copilot questions, red-team drill
  | "draft" // Tier 1 drafts
  | "approve" // mint a Tier 2 approval
  | "execute" // present an approval and run the sandbox action
  | "simulate"; // record a simulated counterparty response

export const ROLE_CAPABILITIES: Record<HumanRole, ReadonlySet<Capability>> = {
  OWNER: new Set(["read", "analyze", "draft", "approve", "execute", "simulate"]),
  ANALYST: new Set(["read", "analyze", "draft"]),
  VIEWER: new Set(["read"]),
};

/** The most the copilot can ever do, whoever it is answering. */
export const AGENT_CAPABILITIES: ReadonlySet<Capability> = new Set(["read", "analyze", "draft"]);

export const AGENT_ID = "vantora-copilot";

/** The seeded demonstration business. Real companies are rows in `company`. */
export const DEFAULT_BUSINESS_ID = "smart-jeans-mfg";

export interface HumanActor {
  kind: "human";
  userId: string;
  email: string;
  name: string;
  role: HumanRole;
  businessId: string;
  sessionExpiresAt: string;
}

/** How the actor is written into the audit chain. Email is the account identifier, not a secret. */
export const auditActorId = (actor: HumanActor) => `${actor.email}#${actor.role}`;

export const can = (actor: HumanActor, capability: Capability) =>
  ROLE_CAPABILITIES[actor.role].has(capability);

export class AccessError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 422 | 503,
    message: string,
  ) {
    super(message);
  }
}

const IDENTITY_FIELDS = [
  "actorId",
  "actorType",
  "actor",
  "role",
  "userId",
  "businessId",
  "organizationId",
  "orgId",
  "smeProfileId",
  "approvedBy",
];

/** A body that tries to say who the caller is gets refused, not quietly overridden. */
export function rejectIdentityFields(body: unknown): void {
  if (!body || typeof body !== "object") return;
  const forged = IDENTITY_FIELDS.filter((field) => Object.hasOwn(body, field));
  if (forged.length) {
    throw new AccessError(
      400,
      `identity is taken from your session; the request may not set ${forged.join(", ")}`,
    );
  }
}

/**
 * Cookie-authenticated POSTs must come from this origin. Browsers always send
 * `Origin` on cross-site requests, so a mismatched value is refused. Combined
 * with SameSite=Lax session cookies and JSON-only bodies, this is the CSRF
 * defence for Vantora's own routes; Better Auth checks its own endpoints.
 */
export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (!origin) return;
  const allowed = new URL(process.env.BETTER_AUTH_URL ?? "http://localhost:3000").origin;
  if (origin !== allowed && origin !== new URL(request.url).origin) {
    throw new AccessError(403, "cross-origin request refused");
  }
}

/**
 * Which company the caller is acting for: a header on client fetches,
 * `?company=` on links, or the selection cookie on a plain navigation.
 *
 * This is only ever a selector among memberships the server already granted —
 * `requireActor` refuses an id the caller is not a member of — so it carries
 * no authority of its own and does not need to be signed.
 */
export const COMPANY_HEADER = "x-vantora-company";
export const COMPANY_COOKIE = "vantora_company";

function requestedCompany(request: Request): string | null {
  const header = request.headers.get(COMPANY_HEADER);
  if (header?.trim()) return header.trim();
  try {
    const param = new URL(request.url).searchParams.get("company");
    if (param?.trim()) return param.trim();
  } catch {
    // Internal requests carry an opaque URL; fall through to the cookie.
  }
  const cookie = request.headers.get("cookie");
  const match = cookie?.match(new RegExp(`(?:^|;\\s*)${COMPANY_COOKIE}=([^;]+)`));
  return match ? decodeURIComponent(match[1]).trim() || null : null;
}

export interface SessionUser {
  userId: string;
  email: string;
  name: string;
}

/**
 * The signed-in account, with no company required.
 *
 * Only for the paths a user must reach before they belong to anywhere: listing
 * their companies and creating their first one. It grants no access to any
 * company's data — everything scoped to a company still goes through
 * `requireActor`.
 */
export async function requireSession(request: Request): Promise<SessionUser> {
  const auth = await getAuth();
  if (!auth) {
    throw new AccessError(503, "Authentication is not configured on this server (BETTER_AUTH_SECRET is missing).");
  }
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) throw new AccessError(401, "Sign in to continue. Your session is missing or has expired.");
  return { userId: session.user.id, email: session.user.email, name: session.user.name };
}

/** Resolve the signed-in human, or throw an AccessError with the right status. */
export async function requireActor(request: Request, capability: Capability): Promise<HumanActor> {
  const auth = await getAuth();
  if (!auth) {
    throw new AccessError(
      503,
      "Authentication is not configured on this server (BETTER_AUTH_SECRET is missing). No action can be authorised.",
    );
  }
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) throw new AccessError(401, "Sign in to continue. Your session is missing or has expired.");

  const memberships = db()
    .prepare("SELECT business_id, role FROM membership WHERE user_id = ? ORDER BY created_at, business_id")
    .all(session.user.id) as { business_id: string; role: HumanRole }[];
  if (memberships.length === 0) {
    throw new AccessError(403, "This account has no company yet. Create one to continue.");
  }
  // A caller may name which of their companies to act for, but the name is
  // only ever a selector among memberships already granted server-side — it
  // can never widen access. An unknown or unauthorised id is refused outright
  // rather than quietly falling back to a company they do belong to.
  const requested = requestedCompany(request);
  const membership = requested
    ? memberships.find((m) => m.business_id === requested)
    : memberships[0];
  if (!membership) {
    throw new AccessError(403, "You are not a member of that company.");
  }

  const actor: HumanActor = {
    kind: "human",
    userId: session.user.id,
    email: session.user.email,
    name: session.user.name,
    role: membership.role,
    businessId: membership.business_id,
    sessionExpiresAt: new Date(session.session.expiresAt).toISOString(),
  };
  if (!can(actor, capability)) {
    throw new AccessError(
      403,
      `Your role (${actor.role}) does not include "${capability}". ${
        capability === "approve" || capability === "execute" || capability === "simulate"
          ? "Only the business OWNER can approve or execute financial actions."
          : ""
      }`.trim(),
    );
  }
  return actor;
}

/** Optional variant for server components: null instead of throwing on 401/403. */
export async function currentActor(headers: Headers): Promise<HumanActor | null> {
  try {
    return await requireActor(new Request("http://internal/", { headers }), "read");
  } catch {
    return null;
  }
}
