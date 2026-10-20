/**
 * POST /api/ai-connection — manage a company's AI provider connection.
 *
 * All actions require an authenticated OWNER session for the current company.
 * The API key is never returned in responses.
 *
 *   { action: "save",    provider, model, apiKey, baseUrl?, providerRestrictions? }
 *   { action: "test" }
 *   { action: "remove" }
 *   { action: "get" }      — returns connection metadata (no key)
 */

import { NextResponse } from "next/server";

import {
  createOrReplaceConnection,
  getConnection,
  getConnectionWithKey,
  markConnectionTested,
  removeConnection,
  validateConnectionInput,
} from "@/lib/server/ai-connection";
import { testConnectionCapability } from "@/lib/agent/monitoring-agent";
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
      const conn = getConnection(companyId);
      if (!conn) return NextResponse.json({ connection: null });
      return NextResponse.json({ connection: conn });
    }

    if (action === "remove") {
      removeConnection(companyId);
      return NextResponse.json({ removed: true });
    }

    if (action === "save") {
      const validationError = validateConnectionInput({
        provider: String(body.provider ?? ""),
        model: String(body.model ?? ""),
        apiKey: String(body.apiKey ?? ""),
        baseUrl: typeof body.baseUrl === "string" ? body.baseUrl : null,
      });
      if (validationError) return err(422, validationError);

      const conn = createOrReplaceConnection({
        companyId,
        provider: body.provider as "gemini" | "openrouter",
        model: String(body.model),
        apiKey: String(body.apiKey),
        baseUrl: typeof body.baseUrl === "string" ? body.baseUrl : null,
        providerRestrictions:
          body.provider === "openrouter" && body.providerRestrictions
            ? (body.providerRestrictions as { order?: string[]; require_parameters?: boolean })
            : null,
        createdBy: actor.userId,
      });
      return NextResponse.json({ connection: conn });
    }

    if (action === "test") {
      const stored = getConnectionWithKey(companyId);
      if (!stored) return err(404, "No AI connection saved for this company");
      const result = await testConnectionCapability(stored, companyId);
      if (result.ok) markConnectionTested(companyId);
      return NextResponse.json({ ok: result.ok, detail: result.detail });
    }

    return err(400, `Unknown action: ${String(action).slice(0, 40)}`);
  } catch (cause) {
    if (cause instanceof Error && "status" in cause) {
      return err((cause as { status: number }).status, cause.message);
    }
    console.error("[ai-connection]", cause);
    return err(500, "Internal error");
  }
}
