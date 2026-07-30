# Convor Reporting — Analytics Layer Design & Handoff Spec

**Status:** canonical spec. This is the source of truth for the reporting build. The companion file `convor_analytics_schema.sql` is the runnable, tested schema; this document explains the decisions behind it, the ingest contract, and what's deferred.

**Audience:** the implementer (Claude Code on `convor-config`, or you). The architecture section below contains decisions that are **not** inferable from the LibreChat source — they are business/security-model calls and must shape the implementation.

---

## 1. What this solves

Customers of the managed service need to see ROI, not just usage. Three layers, in priority order:

1. **Usage / adoption** — who's active, how much, on which agents. Necessary but not persuasive on its own.
2. **Outcomes** — units of work completed by the automations. This is what a decision-maker cares about.
3. **ROI (dollars)** — outcomes × time saved per unit × loaded rate, vs. the fee. This is what renews contracts.

The schema is built so that Layers 1 and 2 flow from data you already have, and Layer 3 is a small set of per-client assumptions filled in at onboarding.

---

## 2. Architecture decisions (read before implementing)

These are settled. They are the decisions Code's source-code recon would not surface on its own.

- **Central Metabase, one instance.** A single Metabase in a dedicated `convor-reporting` Railway project serves every client. Not one Metabase per customer.
- **Per-client *database*, hard isolation.** Metabase's open-source edition grants data-access permissions at the database/schema level, not the row level. So each customer gets their **own analytics database** (`client_acme`, `client_df`, …), and in Metabase each maps to one connection with one group scoped to it. A client can never query another client's rows, even via the SQL builder. **Do not** put multiple clients' rows in one table with a `client` filter column — that pattern requires the paid tier to secure.
- **Outbound-push ingest; no public DB endpoints on client projects.** Railway private networking is project-scoped, so central Metabase cannot privately reach a database inside a customer's project. We solve this by pushing analytics data *outward* from each client instance to the central analytics store — never by exposing a customer database publicly. This preserves the security posture (no public DB endpoints) documented separately.
- **`tenantId` is the join key.** LibreChat conversations already carry `agent_id` + `tenantId`. `tenant_id` is the tenant grain throughout the schema. In the common case of one tenant per customer instance it's a single value; the column exists so a customer instance serving multiple business units still rolls up correctly.
- **Agent-level attribution is native; department attribution is a Convor-side lookup.** LibreChat's `users` has no department field. Rather than fork the LibreChat user schema (which you'd have to re-patch on every upgrade), department lives on `dim_user.department`, curated on our side. **The Mongo sync must preserve `department` on upsert** — it updates identity/activity columns only.
- **Pricing is a versioned table, never hardcoded.** Token→USD conversion lives in `analytics.pricing` with effective dates. Model prices change; historical cost/ROI must stay honest. No conversion constant belongs in a Metabase question.

---

## 3. Data model

Runnable DDL: `convor_analytics_schema.sql` (PostgreSQL 14+, run once per client database). It has been executed against a live Postgres 16 instance and smoke-tested; the ROI/cost math, error exclusion, and idempotency all verified.

**Dimensions**
- `dim_agent` — LibreChat agents, human-named. `agent_id` matches `conversation.agent_id`.
- `dim_automation` — Make automations, keyed by a stable slug you control (`competitor_digest`, `hr_recruiting_intake`, …).
- `dim_user` — LibreChat users + the curated `department` field.

**Facts**
- `fact_usage_daily` — daily grain `(usage_date, tenant_id, user_id, agent_id, model_key)`. Adoption + token counts, from the Mongo sync.
- `fact_automation_run` — one row per Make execution. Outcomes layer. `run_id` = Make execution id (idempotency key).

**Config**
- `pricing` — versioned token→USD rates per model.
- `roi_assumptions` — per-automation (optionally per-tenant) minutes-saved-per-unit and loaded hourly rate. Versioned. This is the worksheet filled in at onboarding.

**Views (what Metabase points at)**
- `v_usage_daily_costed` — usage with `cost_usd` resolved against the price effective on each date.
- `v_automation_roi` — per-run `hours_saved` and `value_usd`; only `status='success'` creates value; picks the most specific applicable assumption (tenant-specific beats client-wide).
- `v_monthly_summary` — monthly rollup for top-line dashboard tiles.

---

## 4. The automation-run event contract

Every automation emits one event per execution. This shape is **fixed now** and does not depend on the automation catalog being complete — new automations reuse it unchanged. Add one final module to each Make scenario that writes:

```json
{
  "run_id":          "{{execution.id}}",        // Make execution id — idempotency key
  "tenant_id":       "acme",                     // the client/tenant
  "automation_key":  "hr_recruiting_intake",     // stable slug; must exist in dim_automation
  "agent_id":        "agent_hr",                 // optional; null if not agent-linked
  "run_ts":          "2026-07-15T09:00:00Z",     // execution time
  "status":          "success",                  // success | error | partial
  "units_processed": 8,                          // the countable unit of work
  "duration_ms":     4200,                       // optional
  "metadata":        { }                         // optional jsonb, anything extra
}
```

Two ways to land it, implementer's choice:
- **Direct Postgres insert** from Make into the client's analytics DB (simplest; needs Make → analytics-DB connectivity).
- **Thin authenticated ingest endpoint** (a small service in `convor-reporting`) that Make POSTs to, which inserts with `ON CONFLICT (run_id) DO NOTHING`. Preferred if you don't want Make holding DB credentials.

`units_processed` is the single most important field to define correctly per automation — it's the countable thing ROI multiplies. Decide it when you build each scenario.

---

## 5. Ingest — the two feeds

**Feed A — Make automation runs (outcomes).** As above. Start here: it's five minutes per scenario and it's the outcomes layer. Instrument **one** existing automation (Competitor Digest or Lead Qualification) first, confirm rows land, then template it across the rest.

**Feed B — LibreChat Mongo sync (adoption + cost).** A nightly worker per client instance that reads Mongo and pushes daily rollups outbound to `fact_usage_daily` and `dim_user`. Notes for the implementer:
- Source collections: `conversations` (for `agent_id`, `tenantId`), `messages` (`tokenCount`), and the `transactions` collection (token usage; `transactions.enabled` defaults to `true`, so it's already accruing).
- Aggregate to the daily grain before writing; upsert with `ON CONFLICT (usage_date, tenant_id, user_id, agent_id, model_key) DO UPDATE`.
- **Upsert dimensions before facts** (users/agents must exist for the FKs). Unattributed usage uses the seeded `agent_id='unknown'` sentinel.
- **Preserve `dim_user.department` on upsert** — never overwrite it from the sync.

---

## 6. How ROI computes

`hours_saved = units_processed × minutes_saved_per_unit / 60` (successful runs only)
`value_usd   = hours_saved × loaded_hourly_rate`

Both assumptions come from `roi_assumptions`, agreed with the client at onboarding and written down per automation. Because the numbers are *the client's own agreed figures*, the ROI report reads as their math, not vendor marketing — which is the whole point. Revising an assumption = close the current row (`effective_to`) and insert a new one; history stays intact.

---

## 7. Deferred (not in this phase)

- **Branded portal / embedding.** OSS Metabase supports static embeds only; interactive signed embeds are Pro. Clients log into `insights.convor.ai` directly for now — professional enough on your domain. Portal wrapper is a later phase.
- **SSO for client users.** OSS is email+password. Acceptable at this stage.
- **The auto-generated monthly ROI PDF.** A later Make scenario that queries `v_monthly_summary` and emails a branded one-pager. Metabase's built-in dashboard subscriptions cover the monthly touchpoint until then.

---

## 8. Handoff checklist for the implementer

1. Provision the central `convor-reporting` Railway project: Metabase (template, ~2GB RAM) + a **separate** analytics Postgres (do not reuse the Finance MCP database).
2. For the first client, create the analytics database and run `convor_analytics_schema.sql` in it.
3. Replace the seeded EXAMPLE rows: real LibreChat `agent_id`s in `dim_agent`, real model rates in `pricing`, the client's agreed figures in `roi_assumptions`.
4. Implement Feed A on one existing automation; confirm rows in `fact_automation_run`.
5. Implement Feed B (nightly Mongo sync); confirm `fact_usage_daily` populates and `department` survives re-sync.
6. In Metabase: add the client DB as a connection, create a client group scoped to it (query-builder only, no native SQL for client users), build the "Client Insights" dashboard against the three views.
7. Harden per the security spec before inviting the client: custom domain behind Cloudflare, `MB_ENCRYPTION_SECRET_KEY` set at first boot, public sharing disabled, both databases private-only.
