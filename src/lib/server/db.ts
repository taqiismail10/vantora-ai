/**
 * The application database: one SQLite file, opened with Node's built-in
 * `node:sqlite` driver.
 *
 * It holds the Better Auth tables (users, sessions, credential hashes) and the
 * four tables Vantora's authorization and execution guarantees rest on:
 *
 *   membership        who may act for which business, in which role
 *   approval          every minted approval, single-use, with its binding
 *   action_execution  one row per real-world action — the dedup key
 *   action_event      the lifecycle history of each action
 *   cash_movement     settled sandbox account movements, kept apart from forecasts
 *
 * SQLite is a deliberate choice over the optional Supabase connection: approval
 * consumption and execution dedup must be atomic and must survive a restart,
 * and a reviewer cloning the repo has to get both without provisioning a cloud
 * database. `node:sqlite` is synchronous, so a check-then-write sequence inside
 * one `BEGIN IMMEDIATE` block cannot interleave with another request in this
 * process, and SQLite's file lock serialises writers across processes.
 *
 * Tests set `VANTORA_DB_PATH=:memory:`, which gives each test file its own
 * empty database.
 */

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const DB_PATH = process.env.VANTORA_DB_PATH ?? join(process.cwd(), "data", "vantora.db");

const APP_SCHEMA = `
CREATE TABLE IF NOT EXISTS membership (
  user_id     TEXT NOT NULL,
  business_id TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('OWNER', 'ANALYST', 'VIEWER')),
  created_at  INTEGER NOT NULL,
  created_by  TEXT NOT NULL,
  PRIMARY KEY (user_id, business_id)
);

CREATE TABLE IF NOT EXISTS approval (
  jti                TEXT PRIMARY KEY,
  business_id        TEXT NOT NULL,
  user_id            TEXT NOT NULL,
  operation          TEXT NOT NULL,
  target             TEXT NOT NULL,
  action_keys        TEXT NOT NULL,
  scenario_key       TEXT NOT NULL,
  plan_id            TEXT NOT NULL,
  plan_version       TEXT NOT NULL,
  payload_digest     TEXT NOT NULL,
  confirmation_field TEXT NOT NULL,
  confirmed_cents    INTEGER NOT NULL,
  delegate           TEXT,
  created_at         INTEGER NOT NULL,
  expires_at         INTEGER NOT NULL,
  consumed_at        INTEGER,
  consumed_by        TEXT,
  revoked_at         INTEGER,
  revoked_reason     TEXT
);

CREATE TABLE IF NOT EXISTS action_execution (
  action_key   TEXT PRIMARY KEY,
  business_id  TEXT NOT NULL,
  scenario_key TEXT NOT NULL,
  kind         TEXT NOT NULL,
  target_id    TEXT NOT NULL,
  ordinal      INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  status       TEXT NOT NULL,
  approval_jti TEXT NOT NULL,
  submitted_by TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS action_execution_scope ON action_execution (business_id, scenario_key);

CREATE TABLE IF NOT EXISTS action_event (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  action_key TEXT NOT NULL,
  status     TEXT NOT NULL,
  actor      TEXT NOT NULL,
  note       TEXT NOT NULL,
  at         INTEGER NOT NULL,
  audit_seq  INTEGER
);

CREATE TABLE IF NOT EXISTS cash_movement (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id  TEXT NOT NULL,
  scenario_key TEXT NOT NULL,
  action_key   TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  description  TEXT NOT NULL,
  at           INTEGER NOT NULL
);
-- One settlement per action, whatever path tries to record a second.
CREATE UNIQUE INDEX IF NOT EXISTS cash_movement_once ON cash_movement (action_key);

-- ---------------------------------------------------------------------------
-- Customer-owned financial records.
--
-- These live here, beside approvals and cash movements, so that consuming an
-- approval and mutating the records it authorises share one transaction. A
-- company id IS a business id: the same value scopes membership, approvals,
-- executions, audit and everything below.
--
-- Terms are stored as a JSON snapshot on each record rather than as columns so
-- that changing a counterparty's defaults never rewrites a posted invoice.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS company (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  industry        TEXT NOT NULL DEFAULT '',
  country         TEXT NOT NULL DEFAULT '',
  business_type   TEXT NOT NULL DEFAULT '',
  timezone        TEXT NOT NULL DEFAULT 'UTC',
  currency        TEXT NOT NULL DEFAULT 'USD',
  locations_json  TEXT NOT NULL DEFAULT '[]',
  status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active')),
  is_demo         INTEGER NOT NULL DEFAULT 0,
  onboarding_step TEXT NOT NULL DEFAULT 'profile',
  created_at      INTEGER NOT NULL,
  created_by      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS company_account (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL,
  name          TEXT NOT NULL,
  opening_cents INTEGER NOT NULL,
  as_of_date    TEXT NOT NULL,
  is_restricted INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS company_account_scope ON company_account (company_id);

CREATE TABLE IF NOT EXISTS counterparty (
  id                 TEXT PRIMARY KEY,
  company_id         TEXT NOT NULL,
  name               TEXT NOT NULL,
  is_supplier        INTEGER NOT NULL DEFAULT 0,
  is_buyer           INTEGER NOT NULL DEFAULT 0,
  country            TEXT NOT NULL DEFAULT '',
  default_terms_json TEXT NOT NULL DEFAULT '{}',
  profile_json       TEXT NOT NULL DEFAULT '{}',
  created_at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS counterparty_scope ON counterparty (company_id);
CREATE UNIQUE INDEX IF NOT EXISTS counterparty_name_once ON counterparty (company_id, name);

CREATE TABLE IF NOT EXISTS receivable (
  id              TEXT PRIMARY KEY,
  company_id      TEXT NOT NULL,
  counterparty_id TEXT NOT NULL,
  external_id     TEXT,
  amount_cents    INTEGER NOT NULL,
  issue_date      TEXT,
  due_date        TEXT NOT NULL,
  terms_json      TEXT NOT NULL DEFAULT '{}',
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'disputed', 'cancelled')),
  source          TEXT NOT NULL DEFAULT 'manual',
  import_batch    TEXT,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS receivable_scope ON receivable (company_id);
CREATE UNIQUE INDEX IF NOT EXISTS receivable_external_once
  ON receivable (company_id, external_id) WHERE external_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS payable (
  id                TEXT PRIMARY KEY,
  company_id        TEXT NOT NULL,
  counterparty_id   TEXT NOT NULL,
  external_id       TEXT,
  amount_cents      INTEGER NOT NULL,
  due_date          TEXT NOT NULL,
  terms_json        TEXT NOT NULL DEFAULT '{}',
  is_payroll        INTEGER NOT NULL DEFAULT 0,
  payroll_lock_date TEXT,
  status            TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'disputed', 'cancelled')),
  source            TEXT NOT NULL DEFAULT 'manual',
  import_batch      TEXT,
  created_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS payable_scope ON payable (company_id);
CREATE UNIQUE INDEX IF NOT EXISTS payable_external_once
  ON payable (company_id, external_id) WHERE external_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS financing_facility (
  id             TEXT PRIMARY KEY,
  company_id     TEXT NOT NULL,
  provider       TEXT NOT NULL,
  product_type   TEXT NOT NULL,
  max_amount_cents INTEGER NOT NULL,
  apr            REAL NOT NULL,
  terms_json     TEXT NOT NULL DEFAULT '{}',
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS financing_facility_scope ON financing_facility (company_id);

-- Settlement: money that moved, changes to what is owed, and what each one
-- was applied to. Kept as three tables because they are three different
-- things — a payment moves cash, an adjustment does not, and an allocation
-- only points an existing one at an obligation. Posted rows are never edited
-- or deleted; a reversal stamps the row and every computation skips it.
CREATE TABLE IF NOT EXISTS payment (
  id              TEXT PRIMARY KEY,
  company_id      TEXT NOT NULL,
  direction       TEXT NOT NULL CHECK (direction IN ('receipt', 'disbursement')),
  counterparty_id TEXT,
  amount_cents    INTEGER NOT NULL CHECK (amount_cents > 0),
  currency        TEXT NOT NULL,
  -- When the money moved in the real world. Drives cash; recorded_at does not.
  effective_date  TEXT NOT NULL,
  -- 0 when the money is already inside an opening balance.
  affects_cash    INTEGER NOT NULL DEFAULT 1,
  method          TEXT NOT NULL DEFAULT '',
  reference       TEXT,
  idempotency_key TEXT,
  reversed_at     INTEGER,
  reversed_by     TEXT,
  reversal_reason TEXT,
  recorded_at     INTEGER NOT NULL,
  created_by      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS payment_scope ON payment (company_id, effective_date);
CREATE UNIQUE INDEX IF NOT EXISTS payment_idempotency_once
  ON payment (company_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS adjustment (
  id              TEXT PRIMARY KEY,
  company_id      TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('credit_note', 'debit_note')),
  target_kind     TEXT NOT NULL CHECK (target_kind IN ('receivable', 'payable')),
  counterparty_id TEXT,
  amount_cents    INTEGER NOT NULL CHECK (amount_cents > 0),
  effective_date  TEXT NOT NULL,
  reason          TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT,
  reversed_at     INTEGER,
  reversed_by     TEXT,
  reversal_reason TEXT,
  recorded_at     INTEGER NOT NULL,
  created_by      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS adjustment_scope ON adjustment (company_id, effective_date);
CREATE UNIQUE INDEX IF NOT EXISTS adjustment_idempotency_once
  ON adjustment (company_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS allocation (
  id              TEXT PRIMARY KEY,
  company_id      TEXT NOT NULL,
  source_kind     TEXT NOT NULL CHECK (source_kind IN ('payment', 'adjustment')),
  source_id       TEXT NOT NULL,
  target_kind     TEXT NOT NULL CHECK (target_kind IN ('receivable', 'payable')),
  target_id       TEXT NOT NULL,
  amount_cents    INTEGER NOT NULL CHECK (amount_cents > 0),
  reversed_at     INTEGER,
  reversed_by     TEXT,
  reversal_reason TEXT,
  recorded_at     INTEGER NOT NULL,
  created_by      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS allocation_target ON allocation (company_id, target_id);
CREATE INDEX IF NOT EXISTS allocation_source ON allocation (company_id, source_kind, source_id);

-- Recurring obligations: a schedule, and one row per occurrence that has
-- been resolved (generated or linked). Preview is pure computation from the
-- schedule, never stored, so pause/end/edit can never leave a stale "future"
-- row behind. A generated occurrence's payable is an ordinary payable row
-- — an independent snapshot, exactly like any manually entered bill — so
-- editing or pausing the schedule afterward can never rewrite it.
CREATE TABLE IF NOT EXISTS recurring_obligation (
  id                       TEXT PRIMARY KEY,
  company_id               TEXT NOT NULL,
  counterparty_id          TEXT NOT NULL,
  category                 TEXT NOT NULL CHECK (category IN ('payroll', 'rent', 'utilities', 'other')),
  amount_cents             INTEGER NOT NULL CHECK (amount_cents > 0),
  schedule                 TEXT NOT NULL CHECK (schedule IN ('weekly', 'monthly')),
  -- weekly: 0 (Sun) - 6 (Sat). monthly: 1-31; a day past the month's last
  -- day clamps to the month's actual last day (the one explicit, documented
  -- month-end rule — never silently skipped or rolled to the next month).
  schedule_day             INTEGER NOT NULL,
  start_date                TEXT NOT NULL,
  end_date                  TEXT,
  is_payroll                INTEGER NOT NULL DEFAULT 0,
  -- Days before the due date the bank file locks, mirroring payable.payroll_lock_date.
  payroll_lock_offset_days  INTEGER,
  status                    TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'ended')),
  created_at                INTEGER NOT NULL,
  created_by                TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS recurring_obligation_scope ON recurring_obligation (company_id);

CREATE TABLE IF NOT EXISTS recurring_occurrence (
  id            TEXT PRIMARY KEY,
  recurring_id  TEXT NOT NULL,
  company_id    TEXT NOT NULL,
  due_date      TEXT NOT NULL,
  payable_id    TEXT NOT NULL,
  -- 'generated': this occurrence's own payable, created from the schedule.
  -- 'linked': an existing manual/imported payable, pointed at explicitly so
  -- it counts once instead of being duplicated by generation.
  origin        TEXT NOT NULL CHECK (origin IN ('generated', 'linked')),
  created_at    INTEGER NOT NULL,
  created_by    TEXT NOT NULL
);
-- The real duplicate guard: one occurrence per schedule per date, whichever
-- path resolved it, enforced by the database, not by application logic.
CREATE UNIQUE INDEX IF NOT EXISTS recurring_occurrence_once ON recurring_occurrence (recurring_id, due_date);
CREATE INDEX IF NOT EXISTS recurring_occurrence_scope ON recurring_occurrence (company_id);

-- Staff invitations: recipient-bound (the email it was issued to, never
-- "anyone with the link"), expiring, single-use. The token itself is never
-- stored — only its hash, so a database read alone cannot forge acceptance,
-- the same principle as the HMAC approval tokens elsewhere in this app.
CREATE TABLE IF NOT EXISTS company_invitation (
  id           TEXT PRIMARY KEY,
  company_id   TEXT NOT NULL,
  email        TEXT NOT NULL,
  role         TEXT NOT NULL CHECK (role IN ('OWNER', 'ANALYST', 'VIEWER')),
  token_hash   TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  created_by   TEXT NOT NULL,
  expires_at   INTEGER NOT NULL,
  accepted_at  INTEGER,
  accepted_by  TEXT,
  revoked_at   INTEGER,
  revoked_by   TEXT
);
CREATE INDEX IF NOT EXISTS company_invitation_scope ON company_invitation (company_id);
CREATE INDEX IF NOT EXISTS company_invitation_token ON company_invitation (token_hash);

CREATE TABLE IF NOT EXISTS company_policy (
  company_id     TEXT NOT NULL,
  key            TEXT NOT NULL,
  value          TEXT NOT NULL,
  effective_from TEXT NOT NULL,
  set_by         TEXT NOT NULL,
  set_at         INTEGER NOT NULL,
  PRIMARY KEY (company_id, key)
);

-- The seeded demonstration business, present as a company row so that every
-- path treats companies uniformly. The is_demo flag makes it read-only for
-- data entry and keeps its forecast on the seeded dataset, not stored records.
INSERT OR IGNORE INTO company
  (id, name, industry, country, business_type, timezone, currency, locations_json,
   status, is_demo, onboarding_step, created_at, created_by)
VALUES
  ('smart-jeans-mfg', 'Smart Jeans Ltd. (demonstration)', 'Apparel manufacturing', '', '',
   'UTC', 'USD', '[]', 'active', 1, 'done', 0, 'system');
`;

let connection: DatabaseSync | null = null;

export function db(): DatabaseSync {
  if (connection) return connection;
  if (DB_PATH !== ":memory:") mkdirSync(dirname(/* turbopackIgnore: true */ DB_PATH), { recursive: true });
  connection = new DatabaseSync(/* turbopackIgnore: true */ DB_PATH);
  connection.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  connection.exec(APP_SCHEMA);
  return connection;
}

/**
 * Run `work` inside one write transaction. Synchronous on purpose: nothing can
 * await between the checks and the writes, so two requests cannot both pass a
 * "not yet consumed" check.
 */
export function transaction<T>(work: (database: DatabaseSync) => T): T {
  const database = db();
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = work(database);
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
