/**
 * GET /api/state - everything the dashboard renders, in one round trip.
 *
 * The first paint is served by the server component in `app/page.tsx`; this
 * route is what the client calls to refresh after an action has changed the
 * audit chain. Both go through `buildDashboardState`.
 */

import { connection, NextResponse } from "next/server";

import { buildDashboardState } from "@/lib/dashboard-data";

export async function GET() {
  // `cacheComponents` forbids the `dynamic` segment config, so this is how the
  // route opts out of prerendering: the forecast and the audit chain must be
  // read per request, never baked in at build time.
  await connection();

  return NextResponse.json(await buildDashboardState());
}
