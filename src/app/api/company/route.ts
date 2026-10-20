/**
 * Company lifecycle and financial-record entry.
 *
 * `GET` returns the caller's companies plus, for the active one, its records
 * and coverage report. `POST` carries one `action`, mirroring `/api/action`.
 *
 * Authorisation rules, in order of how easy they are to get wrong:
 *
 *   - `create_company` and `list` take a session only, because a new account
 *     belongs nowhere until it makes its first company. Everything else goes
 *     through `requireActor`, which resolves the company from the caller's own
 *     memberships and refuses an id they do not hold.
 *   - Writes require `draft`; policy changes and activation require `approve`
 *     (OWNER). A VIEWER can read and nothing else.
 *   - `rejectIdentityFields` still refuses any body naming an actor, a role or
 *     a business, so the only way to choose a company is the validated header,
 *     query or cookie selector.
 */

import { connection, NextResponse } from "next/server";

import {
  activateCompany,
  companiesForUser,
  createCompany,
  getCompany,
  getPolicies,
  POLICY_KEYS,
  setOnboardingStep,
  setPolicy,
  updateCompanyProfile,
  type OnboardingStep,
  type PolicyKey,
} from "@/lib/server/companies";
import { companyDataset } from "@/lib/server/company-state";
import { commitImportFromCsv, previewImportFromCsv } from "@/lib/server/csv-import";
import {
  acceptInvitation,
  createInvitation,
  listInvitations,
  listMembers,
  removeMember,
  revokeInvitation,
  setMemberRole,
} from "@/lib/server/invitations";
import {
  addRecurring,
  defaultHorizonDate,
  deleteRecurring,
  generateOccurrences,
  linkOccurrence,
  listRecurring,
  previewOccurrences,
  setRecurringStatus,
  updateRecurring,
  type RecurringStatus,
} from "@/lib/server/recurrence";
import { obligationBalances } from "@/lib/server/settlements";
import {
  AccessError,
  assertSameOrigin,
  rejectIdentityFields,
  requireActor,
  requireSession,
  type HumanRole,
} from "@/lib/server/identity";
import { parseCents } from "@/lib/server/money";
import {
  allocate,
  recordAdjustment,
  recordPayment,
  reverse,
  settlementRecords,
  type SourceKind,
} from "@/lib/server/settlements";
import {
  addAccount,
  addCounterparty,
  addFacility,
  addPayable,
  addReceivable,
  companyRecords,
  deleteAccount,
  deleteCounterparty,
  deleteFacility,
  deletePayable,
  deleteReceivable,
  setPayableStatus,
  setReceivableStatus,
  updateCounterparty,
  updateFacility,
  updatePayable,
} from "@/lib/server/records";

import { queueFinancialChange } from "@/lib/server/monitoring";

function fail(error: unknown) {
  if (error instanceof AccessError) return NextResponse.json({ error: error.message }, { status: error.status });
  console.error("[company]", error);
  return NextResponse.json({ error: "The request could not be completed." }, { status: 500 });
}

const str = (value: unknown): string => (typeof value === "string" ? value : "");

export async function GET(request: Request) {
  // `cacheComponents` forbids the `dynamic` segment config, so this is how the
  // route opts out of prerendering.
  await connection();
  try {
    const session = await requireSession(request);
    const companies = companiesForUser(session.userId);
    if (companies.length === 0) {
      return NextResponse.json({ account: session, companies: [], active: null });
    }
    const actor = await requireActor(request, "read");
    const company = getCompany(actor.businessId);
    if (!company) throw new AccessError(404, "company not found");
    const dataset = companyDataset(company);
    return NextResponse.json({
      account: session,
      companies: companies.map((c) => ({ id: c.id, name: c.name, role: c.role, status: c.status, isDemo: c.isDemo })),
      active: {
        company,
        role: actor.role,
        records: companyRecords(company.id),
        recurring: listRecurring(company.id),
        members: listMembers(company.id),
        invitations: actor.role === "OWNER" ? listInvitations(company.id) : [],
        settlement: settlementRecords(company.id),
        policies: getPolicies(company.id),
        coverage: dataset.coverage,
        counts: dataset.counts,
        asOf: dataset.asOf,
        horizonDays: dataset.horizonDays,
        forecastable: dataset.state !== null,
      },
    });
  } catch (error) {
    return fail(error);
  }
}

export async function POST(request: Request) {
  await connection();
  try {
    assertSameOrigin(request);
    const body: unknown = await request.json().catch(() => null);
    if (!body || typeof body !== "object") throw new AccessError(400, "a JSON body is required");
    rejectIdentityFields(body);
    const payload = body as Record<string, unknown>;
    const action = str(payload.action);

    // --- Session-only: a new account has no company yet -----------------
    if (action === "create_company") {
      const session = await requireSession(request);
      const existing = companiesForUser(session.userId);
      if (existing.length >= 5) {
        throw new AccessError(409, "This account already has the maximum number of companies.");
      }
      const company = createCompany(
        {
          name: payload.name,
          industry: payload.industry,
          country: payload.country,
          businessType: payload.businessType,
          timezone: payload.timezone,
          currency: payload.currency,
          locations: payload.locations,
        },
        session.userId,
      );
      return NextResponse.json({ ok: true, company });
    }

    // Also session-only: accepting an invitation is how an account that may
    // belong to no company yet gains its first membership.
    if (action === "accept_invitation") {
      const session = await requireSession(request);
      const result = acceptInvitation(str(payload.token), session.userId, session.email);
      return NextResponse.json({ ok: true, ...result });
    }

    // --- Everything else is scoped to one of the caller's companies -----
    const needsOwner =
      action === "set_policy" ||
      action === "activate" ||
      action === "update_company" ||
      action === "set_payroll_status" ||
      // Undoing a posted financial record is an owner decision, not data entry.
      action === "reverse" ||
      // Who can act for this company, and as whom, is an owner decision.
      action === "invite_member" ||
      action === "revoke_invitation" ||
      action === "set_member_role" ||
      action === "remove_member";
    const actor = await requireActor(request, needsOwner ? "approve" : "draft");
    const company = getCompany(actor.businessId);
    if (!company) throw new AccessError(404, "company not found");
    if (company.isDemo) {
      throw new AccessError(403, "The demonstration company is read-only. Create your own company to enter data.");
    }
    const currency = company.currency;

    switch (action) {
      case "update_company":
        return NextResponse.json({ ok: true, company: updateCompanyProfile(company.id, payload) });

      case "invite_member": {
        const result = createInvitation(company.id, payload.email, payload.memberRole, actor.email);
        return NextResponse.json({
          ok: true,
          invitation: result.invitation,
          // Shown once, here, since only the hash is ever stored — the
          // owner copies this themselves; this server sends nothing.
          inviteLink: `${new URL(request.url).origin}/accept-invite?token=${encodeURIComponent(result.token)}`,
        });
      }

      case "revoke_invitation":
        revokeInvitation(company.id, str(payload.id), actor.email);
        return NextResponse.json({ ok: true });

      case "set_member_role":
        setMemberRole(company.id, str(payload.memberId), str(payload.memberRole) as HumanRole);
        return NextResponse.json({ ok: true });

      case "remove_member":
        removeMember(company.id, str(payload.memberId));
        return NextResponse.json({ ok: true });

      case "set_step": {
        const step = str(payload.step) as OnboardingStep;
        setOnboardingStep(company.id, step);
        return NextResponse.json({ ok: true });
      }

      case "add_account":
        return NextResponse.json({ ok: true, account: addAccount(company.id, currency, payload as never) });

      case "delete_account":
        deleteAccount(company.id, str(payload.id));
        return NextResponse.json({ ok: true });

      case "add_counterparty":
        return NextResponse.json({ ok: true, counterparty: addCounterparty(company.id, payload as never) });

      case "update_counterparty":
        return NextResponse.json({
          ok: true,
          counterparty: updateCounterparty(company.id, str(payload.id), payload as never),
        });

      case "delete_counterparty":
        deleteCounterparty(company.id, str(payload.id));
        return NextResponse.json({ ok: true });

      case "add_receivable": {
        const rec = addReceivable(company.id, currency, payload as never);
        queueFinancialChange(company.id, "financial_change", { kind: "add_receivable" });
        return NextResponse.json({ ok: true, receivable: rec });
      }

      case "set_receivable_status":
        setReceivableStatus(company.id, str(payload.id), str(payload.status) as "open" | "disputed" | "cancelled");
        return NextResponse.json({ ok: true });

      case "delete_receivable":
        deleteReceivable(company.id, str(payload.id));
        return NextResponse.json({ ok: true });

      case "csv_import_preview": {
        const kind = str(payload.kind);
        if (kind !== "receivable" && kind !== "payable") throw new AccessError(422, 'kind must be "receivable" or "payable"');
        return NextResponse.json({
          ok: true,
          ...previewImportFromCsv(company.id, currency, kind, payload.csvText, payload.mapping),
        });
      }

      case "csv_import_confirm": {
        const kind = str(payload.kind);
        if (kind !== "receivable" && kind !== "payable") throw new AccessError(422, 'kind must be "receivable" or "payable"');
        return NextResponse.json({
          ok: true,
          ...commitImportFromCsv(company.id, currency, kind, payload.csvText, payload.mapping),
        });
      }

      case "add_payable": {
        const payable = addPayable(company.id, currency, payload as never);
        queueFinancialChange(company.id, "financial_change", { kind: "add_payable" });
        return NextResponse.json({ ok: true, payable });
      }

      case "update_payable":
        return NextResponse.json({
          ok: true,
          payable: updatePayable(company.id, str(payload.id), payload as never),
        });

      case "set_payable_status":
        setPayableStatus(company.id, str(payload.id), str(payload.status) as "open" | "disputed" | "cancelled");
        return NextResponse.json({ ok: true });

      case "delete_payable":
        deletePayable(company.id, str(payload.id));
        return NextResponse.json({ ok: true });

      case "add_facility":
        return NextResponse.json({ ok: true, facility: addFacility(company.id, currency, payload as never) });

      case "update_facility":
        return NextResponse.json({
          ok: true,
          facility: updateFacility(company.id, str(payload.id), currency, payload as never),
        });

      case "delete_facility":
        deleteFacility(company.id, str(payload.id));
        return NextResponse.json({ ok: true });

      case "add_recurring":
        return NextResponse.json({ ok: true, recurring: addRecurring(company.id, currency, payload as never) });

      case "update_recurring":
        return NextResponse.json({
          ok: true,
          recurring: updateRecurring(company.id, str(payload.id), currency, payload as never),
        });

      case "set_recurring_status": {
        const value = str(payload.status);
        if (value !== "active" && value !== "paused" && value !== "ended") {
          throw new AccessError(422, 'status must be "active", "paused" or "ended"');
        }
        return NextResponse.json({ ok: true, recurring: setRecurringStatus(company.id, str(payload.id), value as RecurringStatus) });
      }

      case "delete_recurring":
        deleteRecurring(company.id, str(payload.id));
        return NextResponse.json({ ok: true });

      case "preview_recurring_occurrences": {
        const through = str(payload.through) || defaultHorizonDate();
        return NextResponse.json({ ok: true, occurrences: previewOccurrences(company.id, str(payload.id), through) });
      }

      case "generate_recurring_occurrences": {
        const through = str(payload.through) || defaultHorizonDate();
        return NextResponse.json({ ok: true, ...generateOccurrences(company.id, currency, str(payload.id), through) });
      }

      case "link_recurring_occurrence":
        linkOccurrence(company.id, str(payload.id), str(payload.dueDate), str(payload.payableId));
        return NextResponse.json({ ok: true });

      case "set_payroll_status": {
        const value = str(payload.status);
        if (value !== "none" && value !== "entered") {
          throw new AccessError(422, 'payroll status must be "none" or "entered"');
        }
        setPolicy(company.id, "payroll_status", value, actor.email, new Date().toISOString().slice(0, 10));
        return NextResponse.json({ ok: true });
      }

      case "set_policy": {
        const key = str(payload.key) as PolicyKey;
        if (!(POLICY_KEYS as readonly string[]).includes(key) || key === "payroll_status") {
          throw new AccessError(422, "unknown policy");
        }
        let value: string;
        if (key === "minimum_safe_buffer_cents" || key === "monthly_revenue_cents") {
          // A zero buffer is a real choice, so it is accepted here even though
          // parseCents refuses zero for an amount that must move money.
          if (payload.value === 0 || payload.value === "0") {
            value = "0";
          } else {
            const parsed = parseCents(payload.value, currency);
            if (!parsed.ok) throw new AccessError(422, parsed.reason);
            value = String(parsed.cents);
          }
        } else {
          const parsed = Number(payload.value);
          if (!Number.isFinite(parsed) || parsed < 0) throw new AccessError(422, "value must be a non-negative number");
          if (key === "gross_margin" && parsed > 1) throw new AccessError(422, "gross margin is a fraction (0.3 for 30%)");
          if (key === "credit_score" && parsed > 1000) throw new AccessError(422, "credit score is out of range");
          value = String(parsed);
        }
        setPolicy(company.id, key, value, actor.email, new Date().toISOString().slice(0, 10));
        return NextResponse.json({ ok: true });
      }

      case "record_payment": {
        const result = recordPayment(company.id, currency, payload as never, actor.email);
        queueFinancialChange(company.id, "financial_change", { kind: "record_payment" });
        return NextResponse.json({ ok: true, ...result, balances: [...obligationBalances(company.id).values()] });
      }

      case "record_adjustment": {
        const result = recordAdjustment(company.id, currency, payload as never, actor.email);
        return NextResponse.json({ ok: true, ...result, balances: [...obligationBalances(company.id).values()] });
      }

      case "allocate": {
        const allocation = allocate(company.id, currency, payload as never, actor.email);
        return NextResponse.json({ ok: true, allocation, balances: [...obligationBalances(company.id).values()] });
      }

      case "reverse": {
        const kind = str(payload.kind);
        if (kind !== "payment" && kind !== "adjustment" && kind !== "allocation") {
          throw new AccessError(422, 'kind must be "payment", "adjustment" or "allocation"');
        }
        const result = reverse(company.id, kind as SourceKind | "allocation", str(payload.id), str(payload.reason), actor.email);
        return NextResponse.json({ ok: true, ...result, balances: [...obligationBalances(company.id).values()] });
      }

      case "activate": {
        const dataset = companyDataset(company);
        const blocking = dataset.coverage.find((note) => note.level === "blocking");
        if (blocking) throw new AccessError(409, blocking.message);
        activateCompany(company.id);
        return NextResponse.json({ ok: true });
      }

      default:
        throw new AccessError(400, `unknown action "${action.slice(0, 40)}"`);
    }
  } catch (error) {
    return fail(error);
  }
}
