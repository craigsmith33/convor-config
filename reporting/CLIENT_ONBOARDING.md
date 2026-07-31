# Client Onboarding Runbook

The repeatable process for putting a new client onto Convor Reporting, based on the pilot
build for Hyperdrive Holdings. Plain numbered steps — no developer required.

**Scope:** runs and units of work. The ROI / time-saved / pricing layer is deferred, so this
runbook does not cover `roi_assumptions` or `pricing` beyond one safety step at go-live.

**Assumes already built:** the `convor-reporting` Railway project with `metabase`,
`metabase-appdb`, and `analytics-db`.

**Time:** about 45–60 minutes per client, most of it Part 4.

---

## Before you start

Collect these. Don't start until you have all five.

1. **Client short name**, lowercase, letters and underscores only — e.g. `hyperdrive_holdings`.
   This becomes the database name.
2. **Tenant ID** — the `tenantId` value from that client's LibreChat instance. Usually one
   value per client.
3. **The client's LibreChat agent IDs and friendly names.** Found in their `librechat.yaml`
   under `modelSpecs.list[].preset.agent_id`.
4. **The list of automations** you'll be reporting on, each with a stable slug
   (`lead_qualification`) and a display name ("Lead Qualification Agent").
5. **The client contact's email address** for their Metabase login.

---

## Part 1 — Create the database

1. In Railway, open the `convor-reporting` project.
2. Redeploy the **pgAdmin** service if you deleted it (**+ Create → Template → pgAdmin**),
   set a domain, and log in. Delete it again at the end.
3. In pgAdmin, right-click the `analytics-db` server → **Create** → **Database…**
4. Name it after the client short name — e.g. `hyperdrive_holdings`. Click **Save**.
5. Click once on the new database in the sidebar to select it. **Check the name at the top of
   the Query Tool before every query in this runbook** — running these against the wrong
   client's database is the main way this goes wrong.
6. **Tools → Query Tool**, paste the full contents of `convor_analytics_schema.sql`, click
   **▶ Execute**.
7. Verify — paste and execute:

```
SELECT table_name, table_type
FROM information_schema.tables
WHERE table_schema = 'analytics'
ORDER BY table_type, table_name;
```

   Expect **10 rows**: 7 `BASE TABLE`, 3 `VIEW`.

8. Create the read-only role Metabase will use. Replace the password with a generated one and
   save it in your password manager. Replace `CLIENTDB` with the database name in all four
   places.

```
CREATE ROLE mb_CLIENTDB LOGIN PASSWORD 'GENERATED-PASSWORD-HERE';
GRANT CONNECT ON DATABASE CLIENTDB TO mb_CLIENTDB;
GRANT USAGE ON SCHEMA analytics TO mb_CLIENTDB;
GRANT SELECT ON ALL TABLES IN SCHEMA analytics TO mb_CLIENTDB;
ALTER DEFAULT PRIVILEGES IN SCHEMA analytics GRANT SELECT ON TABLES TO mb_CLIENTDB;
```

---

## Part 2 — Set the agent and automation labels

The schema ships placeholder rows. These are what turn raw IDs into readable chart labels.

1. **Add the real agents.** One line per agent, using the client's actual IDs from step 3 of
   "Before you start". `agent_type` is free text — keep it consistent (`hr`, `sales`,
   `finance`).

```
INSERT INTO analytics.dim_agent (agent_id, agent_name, agent_type) VALUES
    ('PASTE_REAL_AGENT_ID_1', 'HR Answer Engine',           'hr'),
    ('PASTE_REAL_AGENT_ID_2', 'Sales Support Engine',       'sales'),
    ('PASTE_REAL_AGENT_ID_3', 'Finance Intelligence Engine','finance')
ON CONFLICT (agent_id) DO UPDATE
    SET agent_name = EXCLUDED.agent_name,
        agent_type = EXCLUDED.agent_type,
        updated_at = now();
```

   *For reference, the Convor house agent IDs from `librechat.yaml` are
   `agent_g81AUn460eTHJg8RczE3s` (HR), `agent_9d9HDLNTNvgLKPMbRqN-U` (Sales), and
   `agent__-BeQ9Fk3FQBnhQCY4Dn2` (Finance). A client running their own instance will have
   different ones — always take them from that client's config.*

2. **Add the real automations.** `automation_key` is the slug your Make scenario will send;
   it must match exactly.

```
INSERT INTO analytics.dim_automation (automation_key, automation_name, automation_type, agent_id) VALUES
    ('lead_qualification', 'Lead Qualification Agent', 'qualification', 'PASTE_REAL_AGENT_ID_2')
ON CONFLICT (automation_key) DO UPDATE
    SET automation_name = EXCLUDED.automation_name,
        automation_type = EXCLUDED.automation_type,
        agent_id        = EXCLUDED.agent_id,
        updated_at      = now();
```

3. **Remove the placeholder agents** once nothing references them.

```
DELETE FROM analytics.dim_agent
WHERE agent_id IN ('agent_hr','agent_sales','agent_finance');
```

   ⚠️ **Never delete the `unknown` agent row.** It's the sentinel that lets unattributed usage
   land without breaking. If this DELETE errors with a foreign key message, something still
   points at a placeholder — finish Part 7 first, then come back.

4. **Remove the placeholder automations** you aren't using.

```
DELETE FROM analytics.dim_automation
WHERE automation_key IN ('competitor_digest','hr_recruiting_intake','lead_qualification')
  AND automation_key NOT IN ('PUT_YOUR_REAL_SLUGS_HERE');
```

   If all three seeded slugs happen to be ones you're really using, skip this step.

---

## Part 3 — Connect Metabase to the database

1. In Metabase, click the **gear icon** (top right) → **Admin settings** → **Databases** →
   **Add a database**.
2. Fill in:
   - **Database type**: PostgreSQL
   - **Display name**: the client's real company name, e.g. `Hyperdrive Holdings`. This is
     what appears in the UI — make it presentable.
   - **Host**: the private hostname from Railway, `analytics-db.railway.internal`
   - **Port**: `5432`
   - **Database name**: the client short name, e.g. `hyperdrive_holdings`
   - **Username**: `mb_CLIENTDB` from Part 1 step 8
   - **Password**: the generated password
3. **Save**. Wait for the sync to finish.
4. Confirm the `analytics` schema tables and views appear.

---

## Part 4 — Build the client's dashboard

**Read this first.** Metabase can duplicate a dashboard and its questions, but it **cannot
repoint the copies at a different database** — there is no built-in setting for it. So each
copied question has to be edited to point at the new client's database, one at a time. With
seven charts that's roughly 20 minutes. This is the recurring manual cost of the
one-database-per-client model. See "When to upgrade" at the end.

1. Create the client's collection: left sidebar → **+ New** → **Collection**. Name it the
   client's company name. Save it inside **Our analytics**.
2. Open your master **Client Insights** dashboard.
3. Click the **⋯** menu (top right) → **Duplicate**.
4. Set the target collection to the client's collection. Leave "duplicate the questions"
   **ticked** — you need independent copies.
5. Open the duplicated dashboard. For **each of the seven cards**:
   a. Click the card title to open the question.
   b. Click the **data source** at the top of the query builder.
   c. Change the database from the pilot to the client's database. Pick the same table or view.
   d. Confirm the chart still renders and the visualization settings survived.
   e. **Save**.
6. When all seven are done, reload the dashboard and check every chart draws with the client's
   data — not the pilot's. **Verify at least one number against a direct SQL query** before
   moving on; a card silently left pointing at the pilot database is the failure mode here.
7. Rename the dashboard to something client-facing, e.g. "Hyperdrive Holdings — Insights".

The seven charts from the pilot: Total Runs, Units of Work Processed, Runs Over Time,
Success vs Error, Runs by Agent, Automation Runs by Type, This Week vs Last Week.

---

## Part 5 — Permissions, so the client sees only their own data

**This is the step that must not be rushed.** Do it before inviting anyone.

### What the free version actually gives you

Worth knowing up front, because the spec assumed otherwise: **the "Blocked" and "View data"
permission settings are Pro/Enterprise only.** In open-source Metabase that setting isn't
even displayed — don't go looking for it.

In OSS, client isolation rests on two controls working together:

- **Collection permissions** decide which saved dashboards and questions a group can see.
  This is the primary boundary.
- **Create queries permissions** decide which databases a group can build new questions
  against or browse.

Separate databases per client plus these two controls is a real boundary — but it depends on
collection discipline. **One question saved into the wrong collection is the way a client sees
another client's numbers.** Always save client work into that client's collection.

### Steps

1. **Lock down the All Users group first.** Everyone is automatically in it, so any access it
   has, everyone has.
   - **Admin settings** → **Permissions** → **Data**.
   - Select the **All Users** group.
   - For **every** database listed, set **Create queries** to **No**.
2. **Check All Users' collection access.**
   - **Admin settings** → **Permissions** → **Collections**.
   - Set **All Users** to **No access** on every client collection.
3. **Create the client's group.**
   - **Admin settings** → **People** → **Groups** → **Create a group**.
   - Name it after the client, e.g. `Hyperdrive Holdings`.
4. **Give the group data access to its own database only.**
   - **Permissions** → **Data** → select the new group.
   - On the **client's own database**: set **Create queries** to **Query builder only**. This
     allows filtering and drill-through on their own data, and blocks the SQL editor.
   - On **every other database** — including other clients' and `metabase-appdb`: set
     **Create queries** to **No**.
5. **Give the group collection access to its own collection only.**
   - **Permissions** → **Collections**.
   - Client's collection → **View access**. Not Curate — View access stops them editing or
     moving anything.
   - Every other collection, including **Our analytics** → **No access**.
6. **Verify before inviting the client.** Do not skip this.
   - Create a throwaway test user, add them **only** to the client group.
   - Open a private/incognito window and log in as that user.
   - Confirm: they see only their own dashboard; no other client's collection appears; no
     SQL editor; no admin gear icon.
   - Delete the test user.

---

## Part 6 — Invite the client and strip the view down

1. **Admin settings** → **People** → **Invite someone**. Enter their email. Add them to the
   client's group **and nothing else** — do not leave them in Administrators.
2. Non-admin users don't see the admin gear or admin nav at all, so that part is automatic
   once they're not an admin.
3. **Set their landing page.** **Admin settings** → **Settings** → **General** → look for the
   **custom homepage** option and point it at the dashboard. This drops users straight onto
   the dashboard instead of the collections browser.
4. Under **Settings** → **General**, set the **site name** to something client-appropriate.

**Be straight with the client about what this is:** a login to a Metabase instance on your
domain, not a fully white-labelled portal. Removing all Metabase chrome needs interactive
embedding, which is a paid tier, and is deferred per spec Section 7. It's professional as-is.

---

## Part 7 — Go-live checks

Run these in the client's database before handing over the login.

1. **Delete the test rows.** See "Removing the TEST_ rows" below. Run the preview first.
2. **Neutralise the example dollar figures.** The schema seeds one EXAMPLE `pricing` row and
   one EXAMPLE `roi_assumptions` row. You aren't showing dollars yet, but `v_automation_roi`
   and `v_monthly_summary` will happily return money based on those made-up numbers if anyone
   builds a chart on them. Clear them so nobody quotes a fabricated figure:

```
DELETE FROM analytics.roi_assumptions WHERE notes LIKE 'EXAMPLE%';
DELETE FROM analytics.pricing WHERE notes LIKE 'EXAMPLE%';
```

3. **Check every automation has a label.** Anything returned here will show as a raw slug or
   blank on the dashboard:

```
SELECT DISTINCT r.automation_key
FROM analytics.fact_automation_run r
LEFT JOIN analytics.dim_automation d ON d.automation_key = r.automation_key
WHERE d.automation_key IS NULL;
```

   Expect **0 rows**.

4. **Check every agent has a label:**

```
SELECT DISTINCT r.agent_id
FROM analytics.fact_automation_run r
LEFT JOIN analytics.dim_agent a ON a.agent_id = r.agent_id
WHERE r.agent_id IS NOT NULL AND a.agent_id IS NULL;
```

   Expect **0 rows**.

5. **Confirm the dashboard is empty or shows only real runs** — no `TEST_` anywhere.
6. **Delete the pgAdmin service** (Settings → Danger Zone → Delete Service). Don't leave a
   database console on a public URL.
7. Confirm `analytics-db` still has **no public TCP proxy**.

---

## Removing the TEST_ rows

**Preview first — always.** This shows exactly what will go:

```
SELECT run_id, automation_key, run_ts, units_processed FROM analytics.fact_automation_run WHERE run_id LIKE 'TEST\_%' ORDER BY run_id;
```

Check the count matches what you injected (12 for the pilot). Then delete:

```
DELETE FROM analytics.fact_automation_run WHERE run_id LIKE 'TEST\_%';
```

**Note the backslash.** In SQL, `_` is a wildcard meaning "any single character", so plain
`'TEST_%'` would also match `TESTING`, `TESTA`, and anything else starting with `TEST`. The
`\_` escapes it to mean a literal underscore. With deliberately-named test data it would
probably work either way — but there is no undo on a `DELETE`, so use the precise version.

If you labelled the test rows somewhere other than `run_id`, find them with:

```
SELECT * FROM analytics.fact_automation_run WHERE run_id ILIKE '%test%' OR automation_key ILIKE '%test%' OR tenant_id ILIKE '%test%';
```

---

## When to upgrade

Two things in this runbook are manual because of open-source limits, and both are solved by
Metabase Pro:

- **Repointing seven questions per client (Part 4).** Pro has **database routing**, built for
  exactly this shape — "each customer has their own database with identical schemas". One set
  of questions routes to the right database based on who's logged in. That removes Part 4
  almost entirely.
- **Collection discipline as the isolation boundary (Part 5).** Pro's **Blocked** view-data
  permission makes collection permissions insufficient on their own, so a misfiled question
  can't leak data.

Rough trigger: at **three or four clients**, Part 4 alone is a couple of hours per onboarding
and the misfiling risk compounds. That's the point to price up Pro rather than absorb it.
