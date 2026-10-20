/**
 * Authentication: Better Auth, email + password, sessions in SQLite.
 *
 * Better Auth owns credential hashing (scrypt), session issuance, cookie
 * signing, expiry/refresh and its own origin checks. Vantora adds two rules on
 * top and nothing else:
 *
 *   1. **No public sign-up.** A user row can only be created while
 *      `withProvisioning` is on the stack, which only the owner-run CLI
 *      (`npm run users`) does. The HTTP sign-up endpoint is also refused at the
 *      route (`app/api/auth/[...all]/route.ts`), so there are two locks.
 *   2. **Roles are not Better Auth's concern.** Identity comes from the session;
 *      role and business come from the `membership` table (`identity.ts`).
 *
 * With no `BETTER_AUTH_SECRET` configured, `getAuth()` returns null and every
 * protected route answers 503. There is deliberately no bypass.
 */

import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { getMigrations } from "better-auth/db/migration";

import { db } from "./db";

export const SESSION_TTL_SECONDS = 8 * 60 * 60;

let provisioning = 0;

/** Server-only. Lets the provisioning CLI create a user row; nothing else can. */
export async function withProvisioning<T>(work: () => Promise<T>): Promise<T> {
  provisioning += 1;
  try {
    return await work();
  } finally {
    provisioning -= 1;
  }
}

export const authBaseUrl = () => process.env.BETTER_AUTH_URL ?? "http://localhost:3000";

/**
 * Self-service sign-up, on by default now that a new account creates its own
 * company rather than joining an existing one.
 *
 * A new account has no membership anywhere until it creates a company, so
 * signing up grants no access to any existing company's data. Set
 * `VANTORA_PUBLIC_SIGNUP=off` to restore the provisioning-only posture, in
 * which `npm run users` is the only way an account can exist.
 */
export const publicSignupEnabled = () => (process.env.VANTORA_PUBLIC_SIGNUP ?? "on").toLowerCase() !== "off";

function createAuth() {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret || secret.length < 32) return null;
  const baseURL = authBaseUrl();
  return betterAuth({
    appName: "Vantora AI",
    secret,
    baseURL,
    trustedOrigins: [new URL(baseURL).origin],
    database: db(),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      autoSignIn: false,
    },
    session: {
      expiresIn: SESSION_TTL_SECONDS,
      // Sliding refresh at most hourly; revocation (`npm run users -- revoke`)
      // deletes the session rows, which takes effect on the next request
      // because cookie caching is left off.
      updateAge: 60 * 60,
      freshAge: 15 * 60,
    },
    rateLimit: {
      enabled: process.env.NODE_ENV !== "test",
      window: 60,
      max: 60,
      customRules: {
        "/sign-in/email": { window: 60, max: 5 },
        "/sign-up/email": { window: 60 * 60, max: 5 },
      },
    },
    advanced: {
      cookiePrefix: "vantora",
      useSecureCookies: baseURL.startsWith("https://"),
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            if (provisioning === 0 && !publicSignupEnabled()) {
              throw new APIError("FORBIDDEN", {
                message: "Accounts are provisioned by the business owner; public sign-up is disabled.",
              });
            }
            return { data: user };
          },
        },
      },
    },
  });
}

export type VantoraAuth = NonNullable<ReturnType<typeof createAuth>>;

let instance: VantoraAuth | null | undefined;
let ready: Promise<VantoraAuth | null> | null = null;

/** The configured auth instance with its tables migrated, or null when unconfigured. */
export function getAuth(): Promise<VantoraAuth | null> {
  if (ready) return ready;
  ready = (async () => {
    if (instance === undefined) instance = createAuth();
    if (!instance) return null;
    const { runMigrations } = await getMigrations(instance.options);
    await runMigrations();
    return instance;
  })();
  return ready;
}
