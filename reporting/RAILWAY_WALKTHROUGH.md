# Railway Setup — Click-by-Click (checklist items 1 & 2)

`PROVISIONING.md` says *what* to build and why. This says *where to click*, assuming you have
never used the Railway dashboard. Follow it top to bottom.

First client database name used throughout: **`client_hyperdrive_holdings`**.

> Railway ships UI changes often. Button wording may drift slightly; the structure
> (Project → Service → Variables / Settings tabs) has been stable. If a label doesn't match,
> look for the nearest equivalent rather than assuming you're in the wrong place.

---

## Before you start

1. A Railway account at **railway.com** with a payment method. Metabase needs ~2GB RAM and
   runs 24/7 — the free trial won't hold it. Metabase idling is the main cost driver here;
   the two Postgres services are minor by comparison.
2. **psql on your laptop.** You need this to run the schema file.
   - macOS: `brew install libpq && brew link --force libpq`
   - Windows: install PostgreSQL, tick "Command Line Tools"
   - Verify: `psql --version`
3. A local copy of `reporting/convor_analytics_schema.sql` from this repo.

---

## Step 1 — Create the project

1. Go to **railway.com** and log in.
2. On the dashboard, click **New Project** (top right).
3. From the menu, choose **Empty Project**. *Don't* pick a database template yet — you want
   control over what goes in.
4. Railway opens an empty canvas and auto-names the project something random like
   `courageous-tranquility`.
5. Rename it: click the project name (top left) → **Settings** → change **Project Name** to
   `convor-reporting` → **Update**.

✅ You now have an empty `convor-reporting` project.

---

## Step 2 — Add the analytics Postgres

This is the database that will hold every client's analytics data, one database per client.

1. On the project canvas, click **+ Create** (or **New**) → **Database** → **Add PostgreSQL**.
2. Railway provisions a service tile called **Postgres**. Wait for it to go green/Active.
3. Rename it so you never confuse it with Metabase's own database: click the tile →
   **Settings** tab → **Service Name** → `analytics-db` → save.

✅ `analytics-db` is running.

---

## Step 3 — Add Metabase

1. Back on the canvas, click **+ Create** → **Template**.
2. Search **Metabase**. Pick the Metabase template.
3. Click **Deploy**. This creates **two** things: the Metabase app service *and* its own
   Postgres, which stores Metabase's questions, dashboards, users and permissions.
4. Rename that second Postgres to **`metabase-appdb`** (same path: tile → Settings →
   Service Name).

> **This is the distinction people get wrong.** `metabase-appdb` holds Metabase's own
> furniture. `analytics-db` holds client data. Client analytics data must never land in
> `metabase-appdb`.

5. Wait for Metabase to finish deploying. First boot takes a few minutes.

✅ Three services: `metabase`, `metabase-appdb`, `analytics-db`.

---

## Step 4 — Set the encryption key (do this before Step 7)

This encrypts the client database passwords Metabase will store.

1. Generate a key on your laptop:
   ```bash
   openssl rand -base64 32
   ```
   Copy the output. Put it in your password manager — losing it while it's in use is painful.
2. Click the **metabase** service → **Variables** tab → **+ New Variable**.
3. Name: `MB_ENCRYPTION_SECRET_KEY`. Value: the generated string. **Add**.
4. Railway redeploys automatically. Wait for green.

Do this **before** you add any database connection in the Metabase UI. If you add
connections first they're stored unencrypted — recoverable (re-save each one under
Admin → Databases), but changing a key that's already in use requires a CLI rotation against
a stopped instance. Cheaper to just do it now.

---

## Step 5 — Open a temporary door to `analytics-db`

To run the schema you need to reach the database from your laptop. Railway enables a public
TCP proxy on Postgres **by default**, so the door is already open — you'll use it, then close
it in Step 8.

1. Click **analytics-db** → **Variables** tab.
2. Find **`DATABASE_PUBLIC_URL`**. Click to reveal, and copy it. It looks like:
   ```
   postgresql://postgres:LONGPASSWORD@shuttle.proxy.rlwy.net:15140/railway
   ```
   - `DATABASE_PUBLIC_URL` = reachable from your laptop ← use this one now
   - `DATABASE_URL` = private, only reachable inside the project ← Metabase uses this later

3. Test it:
   ```bash
   export ADMIN_URL='postgresql://postgres:LONGPASSWORD@shuttle.proxy.rlwy.net:15140/railway'
   psql "$ADMIN_URL" -c 'SELECT version();'
   ```
   You should see PostgreSQL's version. If it hangs, the TCP proxy was disabled — re-enable
   under analytics-db → **Settings** → **Networking** → **Public Networking**.

---

## Step 6 — Create the client database and run the schema

Keep using the `$ADMIN_URL` from Step 5.

```bash
# 1. Create the client's own database
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -c 'CREATE DATABASE client_hyperdrive_holdings;'

# 2. Point at that new database (same URL, different name after the last slash)
export CLIENT_URL='postgresql://postgres:LONGPASSWORD@shuttle.proxy.rlwy.net:15140/client_hyperdrive_holdings'

# 3. Run the schema
psql "$CLIENT_URL" -v ON_ERROR_STOP=1 -f reporting/convor_analytics_schema.sql
```

Expect a clean run of `CREATE TABLE` / `CREATE INDEX` / `CREATE VIEW` / `INSERT` lines and no
`ERROR`. The script is safe to re-run — a second pass prints `NOTICE ... already exists,
skipping` and does not duplicate seed rows.

**Verify it landed:**

```bash
psql "$CLIENT_URL" -c '\dt analytics.*'   # 6 tables
psql "$CLIENT_URL" -c '\dv analytics.*'   # 3 views
psql "$CLIENT_URL" -c 'SELECT * FROM analytics.v_monthly_summary;'   # 0 rows, no error
```

Six tables: `dim_agent`, `dim_automation`, `dim_user`, `pricing`, `roi_assumptions`,
`fact_usage_daily`, `fact_automation_run`. Three views: `v_usage_daily_costed`,
`v_automation_roi`, `v_monthly_summary`. Empty summary is correct — no data yet.

---

## Step 7 — Create the read-only role for Metabase

Metabase should never be able to write to the warehouse.

```bash
psql "$CLIENT_URL" -v ON_ERROR_STOP=1 <<'SQL'
CREATE ROLE mb_hyperdrive LOGIN PASSWORD 'PUT-A-STRONG-GENERATED-PASSWORD-HERE';
GRANT CONNECT ON DATABASE client_hyperdrive_holdings TO mb_hyperdrive;
GRANT USAGE  ON SCHEMA analytics TO mb_hyperdrive;
GRANT SELECT ON ALL TABLES IN SCHEMA analytics TO mb_hyperdrive;
ALTER DEFAULT PRIVILEGES IN SCHEMA analytics GRANT SELECT ON TABLES TO mb_hyperdrive;
SQL
```

Generate the password with `openssl rand -base64 24` and save it — you'll paste it into
Metabase at checklist item 6.

The ingest worker (Feeds A and B) needs a **separate** role with INSERT/UPDATE. Don't reuse
`mb_hyperdrive` for writes.

---

## Step 8 — Close the door

Now lock both databases to private-only, per spec Section 2.

1. **analytics-db** → **Settings** tab → **Networking** → under **Public Networking**, remove
   the TCP proxy (**Remove** / **Delete** next to the `*.proxy.rlwy.net` entry).
2. Repeat for **metabase-appdb**.
3. Leave the **metabase** service's public domain alone — that one is meant to be reachable,
   and gets the Cloudflare + `insights.convor.ai` treatment at checklist item 7.

After this, `DATABASE_PUBLIC_URL` stops working from your laptop — expected. Metabase reaches
`analytics-db` over private networking at `analytics-db.railway.internal:5432`.

To run SQL against the database later, temporarily re-add the TCP proxy, do the work, remove
it again.

---

## Step 9 — Confirm before you stop

- [ ] Project named `convor-reporting`
- [ ] Three services: `metabase`, `metabase-appdb`, `analytics-db`
- [ ] `MB_ENCRYPTION_SECRET_KEY` set on `metabase`, key saved in your password manager
- [ ] Database `client_hyperdrive_holdings` exists with 6 tables + 3 views under `analytics`
- [ ] Role `mb_hyperdrive` created, password saved
- [ ] TCP proxy removed from **both** Postgres services
- [ ] Nothing reused from the Finance MCP project

That's checklist items 1 and 2 complete. Stop here for review.

---

## Troubleshooting

**Metabase can't reach `analytics-db` over the private network.** Railway's private network
is IPv6-only, and the JVM sometimes prefers IPv4. On the `metabase` service, add variable
`JAVA_TOOL_OPTIONS` = `-Djava.net.preferIPv6Addresses=true` and redeploy.

**`psql: command not found`.** psql isn't on your PATH — see "Before you start".

**`FATAL: database "client_hyperdrive_holdings" does not exist`.** Step 6.1 didn't run, or
you edited the wrong part of the URL. The database name is the segment after the final `/`.

**`CREATE DATABASE cannot run inside a transaction block`.** You wrapped it in a transaction.
Run it as its own `-c` command exactly as in Step 6.1.

**Metabase is slow or restarting.** It's under-resourced; confirm your plan allows ~2GB for
that service.
