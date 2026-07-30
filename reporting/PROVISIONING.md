# Convor Reporting — Provisioning Runbook (checklist items 1 & 2)

Companion to `Convor_Reporting_Design_Spec.md`. Covers handoff checklist items 1 and 2 only.
Architecture decisions come from Section 2 of the spec and are settled — this runbook only
records *how* to execute them.

**Status:** Item 1 (Railway provisioning) is **not yet executed** — it requires Railway
credentials that the build environment does not have. Item 2 has been **rehearsed and
verified locally** against PostgreSQL 16 (see "Schema verification" below); it still needs
to be applied to the real Railway instance.

---

## 1. Central `convor-reporting` Railway project

Three services. Note the *two distinct* Postgres roles — this is easy to conflate:

| Service | Purpose | Notes |
|---|---|---|
| `metabase` | The single central Metabase (serves every client) | Template, ~2GB RAM |
| `metabase-appdb` | Metabase's **own** internal metadata store | Questions, dashboards, users, permissions. Usually created by the Railway Metabase template. **Never** put client analytics data here. |
| `analytics-db` | Postgres hosting the **per-client analytics databases** | `client_acme`, `client_df`, … one database per Convor customer |

Do **not** reuse the Finance MCP database for any of these.

### Why one Postgres service can host all clients

Section 2 requires per-client *database* isolation, not per-client *server*. A Postgres
connection is bound to a single database and cannot reach across databases in a query, so
one `analytics-db` service holding `client_acme`, `client_df`, … satisfies the isolation
requirement. Metabase OSS then gets one connection per client database, each scoped to one
group.

### Required settings

- **`MB_ENCRYPTION_SECRET_KEY` must be set before the very first boot.** Setting it later
  means re-encrypting an already-populated app DB. Generate with `openssl rand -base64 32`
  and store it in the Railway service variables.
- Both Postgres services stay **private-only — no public TCP proxy / no exposed endpoint.**
  This is the security posture the outbound-push ingest design exists to preserve
  (spec Section 2). Metabase reaches them over Railway private networking inside the
  project; client instances push data *outward* and are never dialled into.
- Only the `metabase` service gets a public domain, later fronted by Cloudflare at
  `insights.convor.ai` (spec checklist item 7).

### Credentials needed to execute this step

Provisioning cannot be scripted from the build environment as configured — there is no
Railway CLI, no `RAILWAY_TOKEN` / `RAILWAY_API_TOKEN`, and no Railway MCP server. Either:

- **Manual:** create the project and three services in the Railway dashboard, or
- **Scripted:** expose a Railway **account** token as `RAILWAY_API_TOKEN` in the environment
  (a project-scoped `RAILWAY_TOKEN` cannot create a *new* project), then
  `npm i -g @railway/cli` and drive `railway init` / `railway add`.

---

## 2. First client analytics database

Once `analytics-db` exists, for each client:

```bash
# 1. Create the client database and a least-privilege role
createdb  -h <analytics-db-host> -U postgres client_df
psql      -h <analytics-db-host> -U postgres -d postgres -c \
  "CREATE ROLE mb_client_df LOGIN PASSWORD '<generated>';"

# 2. Run the schema (safe to re-run; all objects are IF NOT EXISTS / OR REPLACE)
psql -h <analytics-db-host> -U postgres -d client_df -v ON_ERROR_STOP=1 \
     -f reporting/convor_analytics_schema.sql

# 3. Grant the Metabase connection role read-only access to the analytics schema
psql -h <analytics-db-host> -U postgres -d client_df <<'SQL'
GRANT CONNECT ON DATABASE client_df TO mb_client_df;
GRANT USAGE ON SCHEMA analytics TO mb_client_df;
GRANT SELECT ON ALL TABLES IN SCHEMA analytics TO mb_client_df;
ALTER DEFAULT PRIVILEGES IN SCHEMA analytics
  GRANT SELECT ON TABLES TO mb_client_df;
SQL
```

A dedicated per-client role is defence in depth. Database-level separation already prevents
cross-client queries; the role also prevents a misconfigured Metabase connection from
writing to the warehouse.

The ingest worker (Feeds A and B, spec Section 5) needs a **separate** role with `INSERT`/
`UPDATE` — do not reuse `mb_client_df` for writes.

---

## Schema verification

`convor_analytics_schema.sql` was executed against a clean PostgreSQL 16.13 instance and
independently smoke-tested. Confirmed:

- Applies clean with `ON_ERROR_STOP=1`; **idempotent** on re-run (NOTICEs only, seed rows do
  not duplicate).
- `v_usage_daily_costed` — 1,000,000 prompt tokens @ $2.50/Mtok + 500,000 completion tokens
  @ $10.00/Mtok resolved to `cost_usd = 7.5000` against the date-effective pricing row.
- `v_automation_roi` — 8 units × 25 min ÷ 60 × $45/h = `$150.00`; `status='error'` correctly
  contributes `0`.
- `fact_automation_run.run_id` idempotency — replaying an existing `run_id` with different
  `units_processed` is a no-op, so retries cannot double-count.
- `dim_user.department` survives a sync-style upsert when `department` is omitted from the
  `ON CONFLICT ... DO UPDATE SET` list (the pattern Feed B must use).

### One operational finding

An automation present in `dim_automation` but with **no matching row in `roi_assumptions`**
produces `hours_saved = NULL` and `value_usd = NULL`, while its `units_processed` still
counts toward `v_monthly_summary`. The rollup then reads as internally inconsistent — e.g.
*13 units processed, $150.00 value* — which understates ROI and invites exactly the question
you don't want on a client call.

This is the schema behaving as designed, not a defect, but the seed data ships three
automations and only one assumption, so it will occur on day one. Checklist item 3 should
ensure **every** active automation has a current `roi_assumptions` row. Worth considering a
pre-publish check:

```sql
SELECT a.automation_key
FROM analytics.dim_automation a
LEFT JOIN analytics.roi_assumptions r
       ON r.automation_key = a.automation_key AND r.effective_to IS NULL
WHERE a.is_active AND r.assumption_id IS NULL;
```

---

## Not started (per instructions — stop after items 1 & 2)

Checklist items 3–7: replacing seeded EXAMPLE rows with real agent IDs / model rates /
client-agreed ROI figures, Feed A, Feed B, Metabase dashboard build, and security hardening.
