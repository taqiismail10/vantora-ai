/**
 * GET /api/state - everything the dashboard renders, in one round trip.
 * Any signed-in role may read it.
 *
 * Switching preset or moving a stress control is a pure read: it re-runs the
 * forecast and the MILP and appends nothing to the audit chain. The parsers
 * narrow unknown values to the baseline, so a stale link still renders; the
 * payload's `scenario` says exactly what was computed, and actions must send
 * that back.
 */

import { connection, NextResponse } from "next/server";

import { buildDashboardState } from "@/lib/dashboard-data";
import { parseScenarioPresetId } from "@/lib/sandbox/seed-data";
import { AccessError, requireActor } from "@/lib/server/identity";
import { parseStressControls } from "@/lib/stress-controls";

export async function GET(request: Request) {
  // `cacheComponents` forbids the `dynamic` segment config, so this is how the
  // route opts out of prerendering.
  await connection();
  try {
    const actor = await requireActor(request, "read");
    const params = new URL(request.url).searchParams;
    return NextResponse.json(
      await buildDashboardState(actor, {
        preset: parseScenarioPresetId(params.get("profile")),
        stress: parseStressControls(params),
      }),
    );
  } catch (error) {
    if (error instanceof AccessError) return NextResponse.json({ error: error.message }, { status: error.status });
    throw error;
  }
}
