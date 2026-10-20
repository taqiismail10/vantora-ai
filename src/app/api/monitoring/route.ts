/**
 * POST /api/monitoring — manage the company's monitoring mandate.
 *
 * All actions require an authenticated OWNER session.
 *
 *   { action: "get" }                           — mandate + recent runs
 *   { action: "create",  checkIntervalS?, endDate? }
 *   { action: "activate" }
 *   { action: "pause" }
 *   { action: "stop" }
 */

import { NextResponse } from "next/server";

import { getConnection } from "@/lib/server/ai-connection";
import {
  createMandate,
  getMandate,
  listRecentRuns,
  setMandateStatus,
  workerStatus,
} from "@/lib/server/monitoring";
import { assertSameOrigin, requireActor, rejectIdentityFields } from "@/lib/server/identity";

function err(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const actor = await requireActor(request, "approve");
    const body = (await request.json()) as Record<string, unknown>;
    rejectIdentityFields(body);

    const companyId = actor.businessId;
    const { action } = body;

    if (action === "get") {
      const mandate = getMandate(companyId);
      const runs = listRecentRuns(companyId, 10);
      // An active mandate with no live worker does nothing at all, so the
      // owner is told rather than left watching an empty run list.
      return NextResponse.json({ mandate, runs, worker: workerStatus() });
    }

    if (action === "create") {
      const conn = getConnection(companyId);
      if (!conn) return err(422, "Save and test an AI connection before enabling monitoring");
      if (!conn.testedAt) return err(422, "The AI connection must pass a capability test before monitoring can be enabled");

      const checkIntervalS =
        typeof body.checkIntervalS === "number" ? Math.max(300, body.checkIntervalS) : 3600;
      const endDate = typeof body.endDate === "string" ? body.endDate : null;

      const mandate = createMandate({
        companyId,
        connectionId: conn.id,
        ownerUserId: actor.userId,
        checkIntervalS,
        endDate,
      });
      return NextResponse.json({ mandate });
    }

    if (action === "activate" || action === "pause" || action === "stop") {
      const statusMap = { activate: "active", pause: "paused", stop: "stopped" } as const;
      const mandate = setMandateStatus(companyId, statusMap[action as keyof typeof statusMap], actor.userId);
      return NextResponse.json({ mandate });
    }

    return err(400, `Unknown action: ${String(action).slice(0, 40)}`);
  } catch (cause) {
    if (cause instanceof Error && "status" in cause) {
      return err((cause as { status: number }).status, cause.message);
    }
    console.error("[monitoring]", cause);
    return err(500, "Internal error");
  }
}
