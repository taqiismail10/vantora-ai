/**
 * Vantora 4-tier permission gate.
 *
 *   TIER_0_AUTO_READ      read-only analysis, runs unattended
 *   TIER_1_DRAFT_ONLY     may produce a draft, never a side effect
 *   TIER_2_HITL_APPROVAL  needs a valid HMAC approval token from a human
 *   TIER_3_PROHIBITED     never permitted, by any caller, with any token
 *
 * Every decision is fail-closed: an unknown operation is treated as Tier 2, a
 * missing signing secret denies Tier 2, and anything whose numbers cannot be
 * traced back to the Python quant engine is denied outright.
 */

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import {
  digestPayload,
  logOperation,
  type AuditLogEntry,
  type GateDecisionName,
  type PermissionTierName,
} from "../sandbox/execution-logger";

export const PERMISSION_TIERS = {
  TIER_0_AUTO_READ: "TIER_0_AUTO_READ",
  TIER_1_DRAFT_ONLY: "TIER_1_DRAFT_ONLY",
  TIER_2_HITL_APPROVAL: "TIER_2_HITL_APPROVAL",
  TIER_3_PROHIBITED: "TIER_3_PROHIBITED",
} as const satisfies Record<PermissionTierName, PermissionTierName>;

export type PermissionTier = PermissionTierName;

/** Operation -> tier registry. Anything unlisted falls through to Tier 2. */
export const OPERATION_TIERS: Record<string, PermissionTier> = {
  read_sme_profile: PERMISSION_TIERS.TIER_0_AUTO_READ,
  run_cash_flow_forecast: PERMISSION_TIERS.TIER_0_AUTO_READ,
  run_recovery_optimization: PERMISSION_TIERS.TIER_0_AUTO_READ,
  rank_financing_options: PERMISSION_TIERS.TIER_0_AUTO_READ,

  draft_supplier_deferral_email: PERMISSION_TIERS.TIER_1_DRAFT_ONLY,
  // A human minting an approval token is itself an auditable act, but it moves
  // no money: the token is worthless until a Tier 2 call presents it.
  issue_hitl_approval_token: PERMISSION_TIERS.TIER_1_DRAFT_ONLY,
  draft_customer_discount_offer: PERMISSION_TIERS.TIER_1_DRAFT_ONLY,
  draft_recovery_plan_summary: PERMISSION_TIERS.TIER_1_DRAFT_ONLY,

  send_supplier_deferral_email: PERMISSION_TIERS.TIER_2_HITL_APPROVAL,
  accept_financing_offer: PERMISSION_TIERS.TIER_2_HITL_APPROVAL,
  execute_recovery_plan: PERMISSION_TIERS.TIER_2_HITL_APPROVAL,
  issue_early_payment_discount: PERMISSION_TIERS.TIER_2_HITL_APPROVAL,

  wire_funds_to_external_account: PERMISSION_TIERS.TIER_3_PROHIBITED,
  change_supplier_bank_details: PERMISSION_TIERS.TIER_3_PROHIBITED,
  disable_audit_logging: PERMISSION_TIERS.TIER_3_PROHIBITED,
  bypass_human_approval: PERMISSION_TIERS.TIER_3_PROHIBITED,
  exfiltrate_financial_records: PERMISSION_TIERS.TIER_3_PROHIBITED,
};

export function classifyOperation(operation: string): PermissionTier {
  return OPERATION_TIERS[operation] ?? PERMISSION_TIERS.TIER_2_HITL_APPROVAL;
}

/** Severity order. A caller may raise its own tier, never lower the registry's. */
const TIER_SEVERITY: Record<PermissionTier, number> = {
  TIER_0_AUTO_READ: 0,
  TIER_1_DRAFT_ONLY: 1,
  TIER_2_HITL_APPROVAL: 2,
  TIER_3_PROHIBITED: 3,
};

export function maxTier(a: PermissionTier, b: PermissionTier): PermissionTier {
  return TIER_SEVERITY[a] >= TIER_SEVERITY[b] ? a : b;
}

// ------------------------------------------------------- HMAC approval tokens (T2)

const TOKEN_VERSION = "v1";
const DEFAULT_TTL_MS = 15 * 60 * 1000;

export interface ApprovalClaims {
  operation: string;
  planId: string;
  actorId: string;
  /**
   * SHA-256 of the exact payload the human approved. Without this a token
   * minted to draw $2,345 from FIN-MERIDIAN also authorises $90,000 from
   * FIN-QUICKFLOAT, because operation and planId are identical in both.
   */
  payloadDigest: string;
  /** Single-use nonce, burned on the first ALLOWED use. */
  jti: string;
  /** The figure the human typed to confirm, when the UI asked for one. */
  confirmedAmount?: number;
  /** Epoch milliseconds. */
  exp: number;
}

/**
 * Nonces already spent on an allowed Tier 2 operation.
 *
 * ponytail: process-local, so a single approval server is assumed, and it
 * grows by one entry per executed approval. Upgrade path if either matters:
 * a Redis/DB set keyed by jti with a TTL matching the token's.
 */
const CONSUMED_JTI = new Set<string>();

function signingSecret(): string | null {
  const secret = process.env.HITL_SIGNING_SECRET;
  return secret && secret.length >= 8 ? secret : null;
}

const b64url = (value: string) => Buffer.from(value, "utf8").toString("base64url");

export interface IssueApprovalInput {
  operation: string;
  planId: string;
  actorId: string;
  /** The exact object the Tier 2 call will act on. The token commits to it. */
  payload?: unknown;
  /** The amount the human typed to confirm, cross-checked at verify time. */
  confirmedAmount?: number;
  ttlMs?: number;
  /** Use a nonce the caller already recorded server-side (see `server/approvals.ts`). */
  jti?: string;
}

/** Mint an approval token. In production only the HITL approval route calls this. */
export function issueApprovalToken(claims: IssueApprovalInput): string {
  const secret = signingSecret();
  if (!secret) throw new Error("HITL_SIGNING_SECRET is not configured");

  const body: ApprovalClaims = {
    operation: claims.operation,
    planId: claims.planId,
    actorId: claims.actorId,
    payloadDigest: digestPayload(claims.payload),
    jti: claims.jti ?? randomUUID(),
    ...(claims.confirmedAmount !== undefined ? { confirmedAmount: claims.confirmedAmount } : {}),
    exp: Date.now() + (claims.ttlMs ?? DEFAULT_TTL_MS),
  };
  const encoded = b64url(JSON.stringify(body));
  const signature = createHmac("sha256", secret).update(`${TOKEN_VERSION}.${encoded}`).digest("hex");
  return `${TOKEN_VERSION}.${encoded}.${signature}`;
}

export interface TokenVerification {
  valid: boolean;
  reason: string | null;
  claims: ApprovalClaims | null;
}

export function verifyApprovalToken(
  token: string | undefined,
  expected: { operation: string; planId?: string; payload?: unknown },
): TokenVerification {
  if (!token) return { valid: false, reason: "no userApprovalToken supplied", claims: null };

  const secret = signingSecret();
  if (!secret) return { valid: false, reason: "HITL_SIGNING_SECRET is not configured", claims: null };

  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) {
    return { valid: false, reason: "malformed approval token", claims: null };
  }

  const expectedSignature = createHmac("sha256", secret)
    .update(`${parts[0]}.${parts[1]}`)
    .digest("hex");
  const provided = Buffer.from(parts[2], "utf8");
  const computed = Buffer.from(expectedSignature, "utf8");
  if (provided.length !== computed.length || !timingSafeEqual(provided, computed)) {
    return { valid: false, reason: "approval token signature does not verify", claims: null };
  }

  let claims: ApprovalClaims;
  try {
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as ApprovalClaims;
  } catch {
    return { valid: false, reason: "approval token claims are unreadable", claims: null };
  }

  if (claims.exp <= Date.now()) {
    return { valid: false, reason: "approval token expired", claims };
  }
  if (claims.operation !== expected.operation) {
    return {
      valid: false,
      reason: `approval token was issued for "${claims.operation}", not "${expected.operation}"`,
      claims,
    };
  }
  if (expected.planId && claims.planId !== expected.planId) {
    return { valid: false, reason: "approval token is bound to a different recovery plan", claims };
  }
  // The binding that makes the approval mean something: same operation, same
  // plan and same *payload*. A digest mismatch is a swapped counterparty, a
  // swapped facility or a swapped amount.
  if (claims.payloadDigest !== digestPayload(expected.payload)) {
    return {
      valid: false,
      reason:
        "approval token payloadDigest mismatch: token was minted for a different action payload/amount",
      claims,
    };
  }
  if (
    claims.confirmedAmount !== undefined &&
    claims.confirmedAmount !== payloadAmount(expected.payload)
  ) {
    return {
      valid: false,
      reason: `approval token was confirmed for ${claims.confirmedAmount}, not the amount in this call`,
      claims,
    };
  }
  return { valid: true, reason: null, claims };
}

function payloadAmount(payload: unknown): number | undefined {
  if (payload && typeof payload === "object" && "amount" in payload) {
    const amount = Number((payload as { amount: unknown }).amount);
    return Number.isFinite(amount) ? amount : undefined;
  }
  return undefined;
}

// ------------------------------------------------------------ numerical integrity

const MONEY_PATTERN = /\$\s?(-?\d[\d,]*(?:\.\d+)?)/g;
const MONEY_WORDS_PATTERN = /(-?\d[\d,]*(?:\.\d+)?)\s*(?:USD|dollars)\b/gi;
const PERCENT_PATTERN = /(-?\d+(?:\.\d+)?)\s?%/g;
const APR_PATTERN = /\bAPR\b[^\d%]{0,16}(-?\d+(?:\.\d+)?)/gi;

export interface NumericalViolation {
  kind: "dollar" | "percentage" | "unverifiable";
  value: number;
  nearestEngineValue: number | null;
  message: string;
}

export interface NumericalIntegrityResult {
  ok: boolean;
  violations: NumericalViolation[];
  checkedDollarFigures: number[];
  checkedPercentages: number[];
}

function collectNumbers(value: unknown, sink: Set<number> = new Set()): Set<number> {
  if (typeof value === "number" && Number.isFinite(value)) {
    sink.add(value);
    sink.add(Math.round(value * 100) / 100);
  } else if (typeof value === "string") {
    // Figures the engine itself quoted in a label or detail string are
    // engine-attested too: an action labelled "$43,000 invoice settles in 2d"
    // vouches for $43,000 even though only the discounted $42,355 is a field.
    for (const parsed of [
      ...extract(MONEY_PATTERN, value),
      ...extract(MONEY_WORDS_PATTERN, value),
      ...extract(PERCENT_PATTERN, value),
      ...extract(APR_PATTERN, value),
    ]) {
      sink.add(parsed);
    }
  } else if (Array.isArray(value)) {
    for (const item of value) collectNumbers(item, sink);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectNumbers(item, sink);
  }
  return sink;
}

function extract(pattern: RegExp, haystack: string): number[] {
  const found: number[] = [];
  for (const match of haystack.matchAll(pattern)) {
    let parsed = Number(match[1].replace(/,/g, ""));
    // "-$49,700" is minus forty-nine thousand, not plus: the sign can sit on
    // either side of the dollar symbol, and reading it as positive would let a
    // sign error through the check.
    if (match.index > 0 && haystack[match.index - 1] === "-") parsed = -parsed;
    if (Number.isFinite(parsed)) found.push(parsed);
  }
  return found;
}

function nearest(value: number, allowed: number[]): number | null {
  if (!allowed.length) return null;
  return allowed.reduce((best, candidate) =>
    Math.abs(candidate - value) < Math.abs(best - value) ? candidate : best,
  );
}

/**
 * Deterministically block any LLM text or tool call whose dollar figures,
 * percentages or APRs cannot be traced to the quant engine's own output.
 *
 * Tolerance is $1 / 0.5% on money (the model is allowed to round "$1,368.87" to
 * "$1,369") and 0.05 on percentage points. A fabricated figure such as the
 * $45,000 in the malicious invoice memo matches nothing and is rejected.
 */
export function verifyNumericalIntegrity(
  llmPayload: unknown,
  quantEngineOutput: unknown,
): NumericalIntegrityResult {
  const text = typeof llmPayload === "string" ? llmPayload : JSON.stringify(llmPayload ?? "");
  const dollars = [...extract(MONEY_PATTERN, text), ...extract(MONEY_WORDS_PATTERN, text)];
  const percentages = [...extract(PERCENT_PATTERN, text), ...extract(APR_PATTERN, text)];
  const violations: NumericalViolation[] = [];

  if (quantEngineOutput === undefined || quantEngineOutput === null) {
    for (const value of [...dollars, ...percentages]) {
      violations.push({
        kind: "unverifiable",
        value,
        nearestEngineValue: null,
        message: `no quant engine output supplied to verify ${value} against`,
      });
    }
    return { ok: violations.length === 0, violations, checkedDollarFigures: dollars, checkedPercentages: percentages };
  }

  const engineNumbers = [...collectNumbers(quantEngineOutput)];
  // Rates are stored as fractions (0.14) but quoted as percentages (14%).
  const engineRates = engineNumbers.flatMap((n) =>
    Math.abs(n) <= 1 ? [n, Math.round(n * 1000000) / 10000] : [n],
  );

  for (const value of dollars) {
    const tolerance = Math.max(1, Math.abs(value) * 0.005);
    if (!engineNumbers.some((n) => Math.abs(n - value) <= tolerance)) {
      violations.push({
        kind: "dollar",
        value,
        nearestEngineValue: nearest(value, engineNumbers),
        message: `$${value.toLocaleString()} does not appear in the quant engine output`,
      });
    }
  }

  for (const value of percentages) {
    if (!engineRates.some((n) => Math.abs(n - value) <= 0.05)) {
      violations.push({
        kind: "percentage",
        value,
        nearestEngineValue: nearest(value, engineRates),
        message: `${value}% does not match any rate computed by the quant engine`,
      });
    }
  }

  return {
    ok: violations.length === 0,
    violations,
    checkedDollarFigures: dollars,
    checkedPercentages: percentages,
  };
}

// --------------------------------------------------------- prompt-injection screen

const INJECTION_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: "system_override", pattern: /\bsystem\s*(?:override|prompt|message)\b/i },
  { name: "ignore_previous_instructions", pattern: /\b(?:ignore|disregard|forget)\b[^.?!]{0,40}\b(?:previous|prior|earlier|above|all)\b[^.?!]{0,20}\b(?:instruction|prompt|rule|direction)/i },
  { name: "new_instructions", pattern: /\b(?:new|updated|revised)\s+instructions?\s*[:\-]/i },
  // The qualifier is required: "remit to the usual account on file" is ordinary
  // supplier boilerplate, "wire to external account" is not.
  { name: "wire_to_external_account", pattern: /\b(?:wire|transfer|remit|send)\b[^.?!]{0,60}\b(?:external|new|different|offshore|alternate|updated)\s+account\b/i },
  // A bare account number is ordinary remittance advice ("quote account
  // #10044821 on remittance"). What makes it an injection is a payment verb
  // steering money *at* it.
  {
    name: "account_number_injection",
    pattern:
      /\b(?:wire|transfer|send|deposit|route|redirect|reroute)\b[^.?!]{0,60}\baccount\s*(?:number|no\.?)?\s*#?\s*\d{5,}/i,
  },
  { name: "bypass_approval", pattern: /\b(?:no|without|skip|bypass|waive)\b[^.?!]{0,30}\b(?:human\s+)?(?:approval|authorisation|authorization|review|confirmation)\b/i },
  { name: "forged_authority", pattern: /\b(?:cfo|ceo|owner|director|admin(?:istrator)?)\b[^.?!]{0,40}\b(?:pre-?approved|authorised|authorized|instructed|approved)\b/i },
  { name: "role_reassignment", pattern: /\byou\s+are\s+(?:now|a)\b|\bact\s+as\b|\bdeveloper\s+mode\b|\bjailbreak\b/i },
  { name: "tool_invocation_attempt", pattern: /<\/?(?:system|tool|function)[\s>]|\{\{\s*\w+\s*\}\}/i },
  // "a trade secret", "secret sauce" and "handle per the NDA" are ordinary
  // manufacturing English. An injection *asks for* the credential.
  {
    name: "credential_request",
    pattern:
      /\b(?:send|share|provide|reveal|give|disclose|paste|forward|return|email|what\s+(?:is|are))\b[^.?!]{0,40}\b(?:api[\s_-]?key|password|passphrase|secret\s+key|private\s+key|access\s+token|credential)s?\b/i,
  },
  { name: "urgency_coercion", pattern: /\b(?:immediately|urgent(?:ly)?|before\s+processing)\b[^.?!]{0,40}\b(?:wire|transfer|pay|release)\b/i },
  { name: "disable_controls", pattern: /\b(?:disable|turn\s+off|suppress)\b[^.?!]{0,30}\b(?:logging|audit|security|guardrail)/i },
];

export interface InjectionMatch {
  name: string;
  excerpt: string;
  /** The exact substring that matched, so a reviewer can be shown what fired. */
  matched: string;
}

export interface InjectionScanResult {
  injectionDetected: boolean;
  severity: "none" | "suspicious" | "critical";
  matches: InjectionMatch[];
  /** Safe to show a human; never safe to put in a model prompt unquoted. */
  sanitizedMemo: string;
}

/**
 * Screen untrusted third-party text (invoice memos, supplier emails, OCR output)
 * for instructions aimed at the agent rather than at the human reader.
 */
/**
 * Untrusted text is displayed to people, so long digit runs — account and
 * routing numbers an attacker planted — are masked to their last two digits
 * before they reach a screen. Detection runs on the raw text; only what is
 * returned for display is masked.
 */
export const maskDigits = (text: string) => text.replace(/\d{5,}/g, (run) => `${"•".repeat(run.length - 2)}${run.slice(-2)}`);

export function detectIndirectPromptInjection(untrustedMemo: string | null | undefined): InjectionScanResult {
  const memo = untrustedMemo ?? "";
  const matches: InjectionMatch[] = [];

  for (const { name, pattern } of INJECTION_PATTERNS) {
    const hit = memo.match(pattern);
    if (hit?.index !== undefined) {
      matches.push({
        name,
        excerpt: maskDigits(memo.slice(Math.max(0, hit.index - 20), hit.index + hit[0].length + 20).trim()),
        matched: maskDigits(hit[0]),
      });
    }
  }

  return {
    injectionDetected: matches.length > 0,
    severity: matches.length === 0 ? "none" : matches.length >= 2 ? "critical" : "suspicious",
    matches,
    sanitizedMemo: maskDigits(memo.replace(/[\r\n]+/g, " ").slice(0, 500)),
  };
}

// ----------------------------------------------------------------- the gate itself

export interface GateRequest {
  operation: string;
  actorId: string;
  /** May only raise the registry tier, never lower it. See `maxTier`. */
  tier?: PermissionTier;
  /** The LLM response or tool-call arguments under review. */
  payload?: unknown;
  /** Authoritative figures from the Python engine, for integrity checking. */
  quantEngineOutput?: unknown;
  userApprovalToken?: string;
  /** Third-party text (e.g. an invoice memo) that fed this operation. */
  untrustedContext?: string;
  planId?: string;
  smeProfileId?: string;
  recoveryPlanId?: string;
  actorType?: string;
  /**
   * Atomic consume-and-record step for Tier 2, run synchronously after the
   * token verifies and before anything is awaited. The server's approval
   * store uses it to burn the nonce and insert the execution row in one
   * transaction; when it is absent the process-local nonce set is used.
   */
  commit?: (claims: ApprovalClaims | null) => { ok: true } | { ok: false; reason: string };
  /**
   * The caller holds no token because the approval is a server-held
   * delegation (the copilot acting on an owner's approval). Only valid with
   * `commit`, which must find and consume that delegation itself.
   */
  delegated?: boolean;
  /**
   * Numerical attestation applies to text a model produced. A Tier 2 payload
   * built by the server from engine output (integer cents, never model text)
   * has nothing to attest, so the approval service turns the check off for
   * it; model-proposed arguments never reach the gate as a payload, they are
   * mapped onto a server-built one first.
   */
  attest?: boolean;
}

export interface GateResult {
  decision: GateDecisionName;
  tier: PermissionTier;
  allowed: boolean;
  reason: string;
  numericalIntegrity: NumericalIntegrityResult | null;
  injection: InjectionScanResult | null;
  tokenVerification: TokenVerification | null;
  auditEntry: AuditLogEntry;
}

/**
 * Single entry point for every agent operation. Checks run most-severe first and
 * the result is always written to the hash-chained audit log, allow or deny.
 */
export async function enforcePermissionGate(request: GateRequest): Promise<GateResult> {
  // The registry is the floor. A caller may only ever raise the tier, so
  // `{ operation: "wire_funds_to_external_account", tier: "TIER_0_AUTO_READ" }`
  // still resolves to TIER_3_PROHIBITED.
  const registryTier = classifyOperation(request.operation);
  const effectiveTier = request.tier ? maxTier(registryTier, request.tier) : registryTier;

  let tier: PermissionTier = effectiveTier;
  let decision: GateDecisionName = "DENIED";
  let reason = "denied by default";

  const injection = request.untrustedContext !== undefined
    ? detectIndirectPromptInjection(request.untrustedContext)
    : null;

  const numericalIntegrity = request.payload !== undefined && request.attest !== false
    ? verifyNumericalIntegrity(request.payload, request.quantEngineOutput)
    : null;

  let tokenVerification: TokenVerification | null = null;

  if (injection?.injectionDetected) {
    // Untrusted text tried to issue instructions: the operation is poisoned.
    tier = PERMISSION_TIERS.TIER_3_PROHIBITED;
    reason = `indirect prompt injection detected (${injection.matches.map((m) => m.name).join(", ")})`;
  } else if (effectiveTier === PERMISSION_TIERS.TIER_3_PROHIBITED) {
    reason = `operation "${request.operation}" is TIER_3_PROHIBITED and can never be executed`;
  } else if (numericalIntegrity && !numericalIntegrity.ok) {
    reason = `numerical integrity failure: ${numericalIntegrity.violations.map((v) => v.message).join("; ")}`;
  } else if (effectiveTier === PERMISSION_TIERS.TIER_2_HITL_APPROVAL) {
    if (request.delegated) {
      tokenVerification = request.commit
        ? { valid: true, reason: null, claims: null }
        : { valid: false, reason: "a delegated execution needs a server-held approval", claims: null };
    } else {
      tokenVerification = verifyApprovalToken(request.userApprovalToken, {
        operation: request.operation,
        planId: request.planId,
        payload: request.payload,
      });
    }
    if (tokenVerification.valid && !request.commit && CONSUMED_JTI.has(tokenVerification.claims!.jti)) {
      // One approval, one execution. A re-presented token is a replay.
      tokenVerification = {
        valid: false,
        reason: "approval token has already been consumed (replay)",
        claims: tokenVerification.claims,
      };
    }
    if (tokenVerification.valid) {
      // Synchronous on purpose: nothing awaits between the check and the burn.
      const committed = request.commit ? request.commit(tokenVerification.claims) : null;
      if (committed && !committed.ok) {
        tokenVerification = { valid: false, reason: committed.reason, claims: tokenVerification.claims };
      } else if (!request.commit) {
        CONSUMED_JTI.add(tokenVerification.claims!.jti);
      }
    }
    if (tokenVerification.valid) {
      decision = "ALLOWED";
      reason = request.delegated
        ? `owner-delegated approval verified for ${request.operation}`
        : `human approval verified for ${request.operation}`;
    } else {
      reason = `TIER_2_HITL_APPROVAL blocked: ${tokenVerification.reason}`;
    }
  } else if (effectiveTier === PERMISSION_TIERS.TIER_1_DRAFT_ONLY) {
    decision = "DRAFTED";
    reason = `draft produced for human review; no side effects executed`;
  } else {
    decision = "ALLOWED";
    reason = `TIER_0_AUTO_READ read-only operation`;
  }

  const auditEntry = await logOperation({
    actorId: request.actorId,
    actorType: request.actorType,
    operation: request.operation,
    tier,
    decision,
    reason,
    payload: request.payload,
    smeProfileId: request.smeProfileId,
    recoveryPlanId: request.recoveryPlanId,
  });

  return {
    decision,
    tier,
    allowed: decision !== "DENIED",
    reason,
    numericalIntegrity,
    injection,
    tokenVerification,
    auditEntry,
  };
}
