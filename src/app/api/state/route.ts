/**
 * GET /api/state - everything the dashboard renders, in one round trip.
 *
 * The first paint is served by the server component in `app/page.tsx`; this
 * route is what the client calls to refresh after an action has changed the
 * audit chain. Both go through `buildDashboardState`.
 */

import { connection, NextResponse } from "next/server";

import { buildDashboardState } from "@/lib/dashboard-data";
import { parseScenarioPresetId } from "@/lib/sandbox/seed-data";
import { parseStressControls } from "@/lib/stress-controls";

export async function GET(request: Request) {
  // `cacheComponents` forbids the `dynamic` segment config, so this is how the
  // route opts out of prerendering: the forecast and the audit chain must be
  // read per request, never baked in at build time.
  await connection();

  // Switching preset or moving a stress control is a pure read: it re-runs the
  // forecast and the MILP and appends nothing to the audit chain. Both parsers
  // narrow to known values rather than erroring, so a hand-edited or stale link
  // still renders — at the baseline, never at an undesigned input.
  const params = new URL(request.url).searchParams;
  const preset = parseScenarioPresetId(params.get("profile"));
  const stress = parseStressControls(params);

  return NextResponse.json(await buildDashboardState(preset, stress));
}
