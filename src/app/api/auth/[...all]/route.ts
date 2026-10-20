/**
 * Better Auth's endpoints (sign-in, sign-up, sign-out, session).
 *
 * Sign-up is open by default: a new account holds no membership anywhere until
 * it creates its own company, so registering grants no access to any existing
 * company's data. With `VANTORA_PUBLIC_SIGNUP=off` it is refused here and in
 * the database hook, leaving `npm run users` as the only path.
 */

import { toNextJsHandler } from "better-auth/next-js";
import { NextResponse } from "next/server";

import { getAuth, publicSignupEnabled } from "@/lib/server/auth";

const unconfigured = () =>
  NextResponse.json(
    { error: "Authentication is not configured on this server (BETTER_AUTH_SECRET is missing)." },
    { status: 503 },
  );

export async function GET(request: Request) {
  const auth = await getAuth();
  if (!auth) return unconfigured();
  return toNextJsHandler(auth).GET(request);
}

export async function POST(request: Request) {
  const auth = await getAuth();
  if (!auth) return unconfigured();
  if (new URL(request.url).pathname.includes("/sign-up") && !publicSignupEnabled()) {
    return NextResponse.json(
      { error: "Public sign-up is disabled on this server. Ask the business owner to provision your account." },
      { status: 403 },
    );
  }
  return toNextJsHandler(auth).POST(request);
}
