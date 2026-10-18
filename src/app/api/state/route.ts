/**
 * GET /api/state - everything the dashboard renders, in one round trip.
 *
 * The first paint is served by the server component in `app/page.tsx`; this
 * route is what the client calls to refresh after an action has changed the
 * audit chain. Both go through `buildDashboardState`.
 */

import { connection, NextResponse } from "next/server";

import { buildDashboardState } from "@/lib/dashboard-data";
import { parseSmeProfileId } from "@/lib/sandbox/seed-data";

export async function GET(request: Request) {
  // `cacheComponents` forbids the `dynamic` segment config, so this is how the
  // route opts out of prerendering: the forecast and the audit chain must be
  // read per request, never baked in at build time.
  await connection();

  // Reading a different sandbox is a pure read: it re-runs the engine and
  // appends nothing to the audit chain. Anything unrecognised falls back to
  // Apex rather than erroring, so a bad link still renders.
  const params = new URL(request.url).searchParams;
  const profile = parseSmeProfileId(params.get("profile"));
  // The engine bounds rho at [0, 0.95]; clamp here too so a hand-edited URL
  // cannot 422 the Python call and silently drop the dashboard to the mirror.
  const rho = Math.min(Math.max(Number(params.get("rho")) || 0, 0), 0.95);

  return NextResponse.json(await buildDashboardState(profile, rho));
}
