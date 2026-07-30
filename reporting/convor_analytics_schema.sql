-- =====================================================================
-- Convor Reporting — Analytics Schema (per-client database)
-- =====================================================================
-- Target:   PostgreSQL 14+
-- Scope:    Run ONCE inside each client's analytics database
--           (e.g. client_acme, client_df). One Convor customer = one DB.
--           Central Metabase connects to each DB as a separate, group-
--           scoped connection. No cross-client rows ever share a table.
-- Safe to re-run: all objects use IF NOT EXISTS / OR REPLACE.
-- =====================================================================

CREATE SCHEMA IF NOT EXISTS analytics;
SET search_path TO analytics;

-- ---------------------------------------------------------------------
-- DIMENSIONS
-- ---------------------------------------------------------------------

-- Agent registry. agent_id matches LibreChat conversation.agent_id.
CREATE TABLE IF NOT EXISTS analytics.dim_agent (
    agent_id     text PRIMARY KEY,
    agent_name   text NOT NULL,
    agent_type   text,                       -- 'hr' | 'sales' | 'finance' | ...
    description  text,
    is_active    boolean NOT NULL DEFAULT true,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE analytics.dim_agent IS 'LibreChat agents, human-named for reporting.';

-- Automation registry. automation_key is a stable slug you control.
CREATE TABLE IF NOT EXISTS analytics.dim_automation (
    automation_key   text PRIMARY KEY,
    automation_name  text NOT NULL,
    automation_type  text,                    -- 'digest' | 'intake' | 'qualification' | ...
    agent_id         text REFERENCES analytics.dim_agent(agent_id),  -- optional link
    description      text,
    is_active        boolean NOT NULL DEFAULT true,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE analytics.dim_automation IS 'Make.com automations that emit run events.';

-- User dimension. department is CONVOR-MAINTAINED (LibreChat has no such
-- field) and must be PRESERVED on sync upsert — the Mongo sync updates
-- identity/activity columns only, never department.
CREATE TABLE IF NOT EXISTS analytics.dim_user (
    user_id        text PRIMARY KEY,          -- LibreChat user _id
    tenant_id      text NOT NULL,
    email          text,
    display_name   text,
    department     text,                       -- curated on Convor side; not from LibreChat
    job_role       text,
    is_active      boolean NOT NULL DEFAULT true,
    first_seen_at  timestamptz,
    last_seen_at   timestamptz,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dim_user_tenant     ON analytics.dim_user(tenant_id);
CREATE INDEX IF NOT EXISTS idx_dim_user_department ON analytics.dim_user(department);
COMMENT ON COLUMN analytics.dim_user.department IS 'Convor-maintained. Sync must not overwrite on upsert.';

-- ---------------------------------------------------------------------
-- PRICING  (token -> USD, versioned by effective date)
-- ---------------------------------------------------------------------
-- Never hardcode conversion in a dashboard. Store it here, dated, so
-- historical cost/ROI stays honest when model prices change.
CREATE TABLE IF NOT EXISTS analytics.pricing (
    pricing_id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    model_key                text NOT NULL,      -- matches fact_usage_daily.model_key
    prompt_usd_per_mtok      numeric(12,4) NOT NULL,   -- USD per 1,000,000 prompt tokens
    completion_usd_per_mtok  numeric(12,4) NOT NULL,   -- USD per 1,000,000 completion tokens
    currency                 text NOT NULL DEFAULT 'USD',
    effective_from           date NOT NULL,
    effective_to             date,               -- NULL = current
    notes                    text,
    created_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pricing_model_eff ON analytics.pricing(model_key, effective_from);
-- Exactly one open-ended "current" price per model.
CREATE UNIQUE INDEX IF NOT EXISTS uq_pricing_current
    ON analytics.pricing(model_key) WHERE effective_to IS NULL;

-- ---------------------------------------------------------------------
-- ROI ASSUMPTIONS  (the value model, set with the client at onboarding)
-- ---------------------------------------------------------------------
-- tenant_id NULL = applies to every tenant in this database.
-- Versioned so assumptions can be revised without rewriting history.
CREATE TABLE IF NOT EXISTS analytics.roi_assumptions (
    assumption_id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    automation_key          text NOT NULL REFERENCES analytics.dim_automation(automation_key),
    tenant_id               text,
    minutes_saved_per_unit  numeric(10,2) NOT NULL,
    loaded_hourly_rate      numeric(12,2) NOT NULL,
    currency                text NOT NULL DEFAULT 'USD',
    effective_from          date NOT NULL,
    effective_to            date,
    notes                   text,
    created_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_roi_automation_eff ON analytics.roi_assumptions(automation_key, effective_from);
-- One current assumption per automation per tenant (or client-wide).
CREATE UNIQUE INDEX IF NOT EXISTS uq_roi_current
    ON analytics.roi_assumptions(automation_key, coalesce(tenant_id, '*'))
    WHERE effective_to IS NULL;

-- ---------------------------------------------------------------------
-- FACTS
-- ---------------------------------------------------------------------

-- Adoption + cost. Daily grain from the LibreChat Mongo sync.
-- agent_id / model_key are NOT NULL with sentinels so the composite PK
-- and ON CONFLICT upserts behave (Postgres PK columns can't be NULL).
CREATE TABLE IF NOT EXISTS analytics.fact_usage_daily (
    usage_date          date NOT NULL,
    tenant_id           text NOT NULL,
    user_id             text NOT NULL REFERENCES analytics.dim_user(user_id),
    agent_id            text NOT NULL DEFAULT 'unknown' REFERENCES analytics.dim_agent(agent_id),
    model_key           text NOT NULL DEFAULT 'unknown',
    conversation_count  integer NOT NULL DEFAULT 0,
    message_count       integer NOT NULL DEFAULT 0,
    prompt_tokens       bigint  NOT NULL DEFAULT 0,
    completion_tokens   bigint  NOT NULL DEFAULT 0,
    total_tokens        bigint  NOT NULL DEFAULT 0,
    synced_at           timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (usage_date, tenant_id, user_id, agent_id, model_key)
);
CREATE INDEX IF NOT EXISTS idx_fud_tenant_date ON analytics.fact_usage_daily(tenant_id, usage_date);

-- Outcomes. One row per Make automation execution.
-- run_id = the Make execution id -> natural idempotency key so retries
-- and re-syncs never double-count.
CREATE TABLE IF NOT EXISTS analytics.fact_automation_run (
    run_id           text PRIMARY KEY,
    tenant_id        text NOT NULL,
    automation_key   text NOT NULL REFERENCES analytics.dim_automation(automation_key),
    agent_id         text REFERENCES analytics.dim_agent(agent_id),
    run_ts           timestamptz NOT NULL,
    status           text NOT NULL DEFAULT 'success'
                        CHECK (status IN ('success','error','partial')),
    units_processed  integer NOT NULL DEFAULT 0,
    duration_ms      integer,
    metadata         jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_far_tenant_ts   ON analytics.fact_automation_run(tenant_id, run_ts);
CREATE INDEX IF NOT EXISTS idx_far_automation  ON analytics.fact_automation_run(automation_key);
CREATE INDEX IF NOT EXISTS idx_far_status      ON analytics.fact_automation_run(status);

-- ---------------------------------------------------------------------
-- VIEWS  (what Metabase points at)
-- ---------------------------------------------------------------------

-- Usage with USD cost resolved against the price effective on that date.
CREATE OR REPLACE VIEW analytics.v_usage_daily_costed AS
SELECT
    f.usage_date,
    f.tenant_id,
    f.user_id,
    u.department,
    f.agent_id,
    a.agent_name,
    f.model_key,
    f.conversation_count,
    f.message_count,
    f.prompt_tokens,
    f.completion_tokens,
    f.total_tokens,
    round(
          (f.prompt_tokens     / 1e6) * p.prompt_usd_per_mtok
        + (f.completion_tokens / 1e6) * p.completion_usd_per_mtok
    , 4) AS cost_usd
FROM analytics.fact_usage_daily f
LEFT JOIN analytics.dim_user  u ON u.user_id  = f.user_id
LEFT JOIN analytics.dim_agent a ON a.agent_id = f.agent_id
LEFT JOIN analytics.pricing   p ON p.model_key = f.model_key
     AND f.usage_date >= p.effective_from
     AND (p.effective_to IS NULL OR f.usage_date < p.effective_to);

-- Per-run ROI. Picks the most specific, most recent applicable
-- assumption (tenant-specific beats client-wide). Only successful runs
-- create value.
CREATE OR REPLACE VIEW analytics.v_automation_roi AS
SELECT
    r.run_id,
    r.tenant_id,
    r.automation_key,
    d.automation_name,
    r.agent_id,
    r.run_ts::date AS run_date,
    r.status,
    r.units_processed,
    ra.minutes_saved_per_unit,
    ra.loaded_hourly_rate,
    ra.currency,
    CASE WHEN r.status = 'success'
         THEN round(r.units_processed * ra.minutes_saved_per_unit / 60.0, 2)
         ELSE 0 END AS hours_saved,
    CASE WHEN r.status = 'success'
         THEN round(r.units_processed * ra.minutes_saved_per_unit / 60.0 * ra.loaded_hourly_rate, 2)
         ELSE 0 END AS value_usd
FROM analytics.fact_automation_run r
LEFT JOIN analytics.dim_automation d ON d.automation_key = r.automation_key
LEFT JOIN LATERAL (
    SELECT ra.*
    FROM analytics.roi_assumptions ra
    WHERE ra.automation_key = r.automation_key
      AND (ra.tenant_id = r.tenant_id OR ra.tenant_id IS NULL)
      AND r.run_ts::date >= ra.effective_from
      AND (ra.effective_to IS NULL OR r.run_ts::date < ra.effective_to)
    ORDER BY (ra.tenant_id IS NOT NULL) DESC, ra.effective_from DESC
    LIMIT 1
) ra ON true;

-- Monthly client rollup for the top-line dashboard tiles.
CREATE OR REPLACE VIEW analytics.v_monthly_summary AS
SELECT
    date_trunc('month', run_date)::date               AS month,
    tenant_id,
    count(*) FILTER (WHERE status = 'success')          AS successful_runs,
    sum(units_processed) FILTER (WHERE status = 'success') AS units_processed,
    sum(hours_saved)                                    AS hours_saved,
    sum(value_usd)                                      AS value_usd
FROM analytics.v_automation_roi
GROUP BY 1, 2;

-- ---------------------------------------------------------------------
-- SEED  (sentinels are required; the rest are EXAMPLES to replace)
-- ---------------------------------------------------------------------

-- Required sentinel so unattributed usage rows satisfy the FK/NOT NULL.
INSERT INTO analytics.dim_agent (agent_id, agent_name, agent_type)
VALUES ('unknown', 'Unattributed', 'unknown')
ON CONFLICT (agent_id) DO NOTHING;

-- EXAMPLE agents — replace agent_id values with real LibreChat ids.
INSERT INTO analytics.dim_agent (agent_id, agent_name, agent_type) VALUES
    ('agent_hr',      'HR Answer Engine',          'hr'),
    ('agent_sales',   'Sales Support Engine',      'sales'),
    ('agent_finance', 'Finance Intelligence Engine','finance')
ON CONFLICT (agent_id) DO NOTHING;

-- EXAMPLE automations.
INSERT INTO analytics.dim_automation (automation_key, automation_name, automation_type, agent_id) VALUES
    ('competitor_digest',    'Executive Competitor Digest', 'digest',        NULL),
    ('hr_recruiting_intake', 'HR Recruiting Intake',        'intake',        'agent_hr'),
    ('lead_qualification',   'Lead Qualification Agent',    'qualification', 'agent_sales')
ON CONFLICT (automation_key) DO NOTHING;

-- EXAMPLE pricing — REPLACE with the real contracted model rates.
INSERT INTO analytics.pricing (model_key, prompt_usd_per_mtok, completion_usd_per_mtok, effective_from, notes)
VALUES ('gpt-4o', 2.5000, 10.0000, DATE '2026-01-01', 'EXAMPLE — replace with real rate')
ON CONFLICT DO NOTHING;

-- EXAMPLE ROI assumption — REPLACE per client at onboarding.
INSERT INTO analytics.roi_assumptions
    (automation_key, tenant_id, minutes_saved_per_unit, loaded_hourly_rate, effective_from, notes)
VALUES
    ('hr_recruiting_intake', NULL, 25.00, 45.00, DATE '2026-01-01',
     'EXAMPLE — 25 min saved per intake at HR coordinator loaded rate')
ON CONFLICT DO NOTHING;
