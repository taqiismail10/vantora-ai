/**
 * Browser-side Better Auth client: sign up, sign in and sign out.
 *
 * Signing up grants nothing on its own — a new account is a member of no
 * company until it creates one, and every company-scoped route resolves role
 * and company from the server-side membership table.
 */

import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient();
