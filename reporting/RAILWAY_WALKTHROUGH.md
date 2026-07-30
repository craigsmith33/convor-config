# Railway Setup — Click-by-Click (checklist items 1 & 2)

`PROVISIONING.md` says *what* to build and why. This says *where to click*, assuming you have
never used the Railway dashboard. Follow it top to bottom.

First client database name used throughout: **`client_hyperdrive_holdings`**.

**You do not need to install anything on your laptop.** Step 5 offers two paths — Path A is
browser-only. Path B (terminal) is kept as a fallback.

> Railway ships UI changes often. Button wording may drift slightly; the structure
> (Project → Service → Variables / Settings tabs) has been stable. If a label doesn't match,
> look for the nearest equivalent rather than assuming you're in the wrong place.

---

## Before you start

1. A Railway account at **railway.com** with a payment method. Metabase needs ~2GB RAM and
   runs 24/7 — the free trial won't hold it. Metabase idling is the main cost driver; the two
   Postgres services are minor by comparison.
2. A copy of `reporting/convor_analytics_schema.sql` from this repo, open in a text editor so
   you can copy its contents. (On GitHub: open the file, click **Raw**, select all, copy.)

That's it for Path A. Path B additionally needs `psql` installed — instructions in that
section.

---

## Step 1 — Create the project

1. Go to **railway.com** and log in.
2. On the dashboard, click **New Project** (top right).
3. Choose **Empty Project**. *Don't* pick a database template yet — you want control over what
   goes in.
4. Railway auto-names the project something random like `courageous-tranquility`.
5. Rename it: click the project name (top left) → **Settings** → change **Project Name** to
   `convor-reporting` → **Update**.

✅ An empty `convor-reporting` project.

---

## Step 2 — Add the analytics Postgres

This holds every client's analytics data, one database per client.

1. On the project canvas, click **+ Create** (or **New**) → **Database** → **Add PostgreSQL**.
2. Railway provisions a service tile called **Postgres**. Wait for it to go green/Active.
3. Rename it: click the tile → **Settings** tab → **Service Name** → `analytics-db` → save.

✅ `analytics-db` is running.

---

## Step 3 — Add Metabase

1. On the canvas, click **+ Create** → **Template**.
2. Search **Metabase**. Pick the Metabase template. Click **Deploy**.
3. This creates **two** things: the Metabase app service *and* its own Postgres, which stores
   Metabase's questions, dashboards, users and permissions.
4. Rename that second Postgres to **`metabase-appdb`** (tile → Settings → Service Name).

> **This is the distinction people get wrong.** `metabase-appdb` holds Metabase's own
> furniture. `analytics-db` holds client data. Client analytics data must never land in
> `metabase-appdb`.

5. First boot takes a few minutes.

✅ Three services: `metabase`, `metabase-appdb`, `analytics-db`.

---

## Step 4 — Set the encryption key

This encrypts the client database passwords Metabase will store.

1. Generate a random string of at least 16 characters. Any password generator works — e.g.
   1Password/Bitwarden "generate password", set length 32. Save it in your password manager.
2. Click the **metabase** service → **Variables** tab → **+ New Variable**.
3. Name: `MB_ENCRYPTION_SECRET_KEY`. Value: the generated string. Click **Add**.
4. Railway redeploys automatically. Wait for green.

Do this **before** you add any database connection in the Metabase UI. Connections saved
beforehand are stored unencrypted — recoverable (re-save each under Admin → Databases), but
changing a key that's already in use requires a command-line rotation against a stopped
instance. Cheaper to do it now.

---

## Step 5 — Load the schema

Two paths. **Path A needs no software on your laptop and is the recommended one.**

### Path A — Browser only, via pgAdmin (recommended)

You'll deploy a temporary web-based database admin tool into the same Railway project, use it
in your browser, then delete it. Because it runs *inside* the project, it reaches the database
over Railway's private network — so you never open the database to the public internet at all.
This is both easier and more secure than Path B.

**5A.1 — Deploy pgAdmin**

1. On the project canvas, click **+ Create** → **Template**.
2. Search **pgAdmin** and deploy the pgAdmin 4 template into this same project.
3. Open the new service → **Variables** tab. Confirm these two exist, and set them if the
   template prompts:
   - `PGADMIN_DEFAULT_EMAIL` — any email you'll remember, e.g. `you@convor.ai`
   - `PGADMIN_DEFAULT_PASSWORD` — generate one, save it in your password manager
4. Open the service → **Settings** → **Networking** → **Generate Domain**. This gives pgAdmin
   a web address. (This exposes *pgAdmin*, which is password-protected — not the database.)
5. Click the generated URL. Log in with the email and password from step 3.

**5A.2 — Get the database connection details**

1. Go back to the **analytics-db** service → **Variables** tab.
2. Note these values (click to reveal):
   - `PGHOST` — the private hostname, something like `analytics-db.railway.internal`
   - `PGPORT` — usually `5432`
   - `PGUSER` — usually `postgres`
   - `PGPASSWORD` — the long generated password
   - `PGDATABASE` — usually `railway`

**5A.3 — Connect pgAdmin to the database**

1. In pgAdmin, right-click **Servers** (left sidebar) → **Register** → **Server…**
2. **General** tab → **Name**: `analytics-db`
3. **Connection** tab, fill in from 5A.2:
   - **Host name/address**: the `PGHOST` value
   - **Port**: `5432`
   - **Maintenance database**: `railway`
   - **Username**: `postgres`
   - **Password**: the `PGPASSWORD` value — tick **Save password**
4. Click **Save**. The server appears in the sidebar.

*If it fails to connect*, see "pgAdmin can't reach the database" in Troubleshooting.

**5A.4 — Create the client database**

1. Right-click your `analytics-db` server → **Create** → **Database…**
2. **Database** field: `client_hyperdrive_holdings`
3. Click **Save**.

You should now see `client_hyperdrive_holdings` in the sidebar under **Databases**.

**5A.5 — Run the schema**

1. Click once on **`client_hyperdrive_holdings`** in the sidebar to select it. *Make sure it's
   selected and not the `railway` database* — the query runs against whatever is highlighted.
2. Top menu → **Tools** → **Query Tool**.
3. Paste the entire contents of `convor_analytics_schema.sql` into the editor.
4. Click the **▶ Execute** button (or press F5).

**What success looks like:** a "Query returned successfully" message in the Messages tab, and
no red error text. The script is safe to re-run — a second pass shows
`NOTICE ... already exists, skipping` and does not duplicate anything.

**5A.6 — Create the read-only role for Metabase**

Metabase should never be able to write to the warehouse.

Still in the Query Tool on `client_hyperdrive_holdings`, clear the editor and paste this,
replacing `PUT-A-STRONG-PASSWORD-HERE` with a generated password you save:

```
CREATE ROLE mb_hyperdrive LOGIN PASSWORD 'PUT-A-STRONG-PASSWORD-HERE';
GRANT CONNECT ON DATABASE client_hyperdrive_holdings TO mb_hyperdrive;
GRANT USAGE ON SCHEMA analytics TO mb_hyperdrive;
GRANT SELECT ON ALL TABLES IN SCHEMA analytics TO mb_hyperdrive;
ALTER DEFAULT PRIVILEGES IN SCHEMA analytics GRANT SELECT ON TABLES TO mb_hyperdrive;
```

Click **▶ Execute**. Success = "Query returned successfully", no red text.

**5A.7 — Verify**

Clear the editor, paste this, and execute:

```
SELECT table_name, table_type
FROM information_schema.tables
WHERE table_schema = 'analytics'
ORDER BY table_type, table_name;
```

**Expected: 10 rows** — 7 `BASE TABLE` and 3 `VIEW`.

| Tables (7) | Views (3) |
|---|---|
| `dim_agent`, `dim_automation`, `dim_user`, `pricing`, `roi_assumptions`, `fact_usage_daily`, `fact_automation_run` | `v_usage_daily_costed`, `v_automation_roi`, `v_monthly_summary` |

Then confirm the views actually run:

```
SELECT * FROM analytics.v_monthly_summary;
```

**Expected: 0 rows, no error.** Empty is correct — no data has been loaded yet.

**5A.8 — Delete pgAdmin**

Don't leave a database admin console running on a public URL.

1. Click the pgAdmin service tile → **Settings** → scroll to **Danger Zone** → **Delete
   Service** → confirm.

You can always redeploy it for five minutes next time you need it.

✅ Path A complete — **skip Path B and go to Step 6.**

---

### Path B — Terminal with psql (fallback only)

Use this only if Path A didn't work.

**5B.1 — Install psql**

*On a Mac:*
1. Open **Terminal** (Cmd+Space, type "Terminal", Enter).
2. Install Homebrew if you don't have it — paste this and press Enter:
```
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```
3. Then:
```
brew install libpq
```
4. Then make it available:
```
brew link --force libpq
```

*On Windows:*
1. Download the PostgreSQL installer from **https://www.postgresql.org/download/windows/**
2. Run it. On the "Select Components" screen, **untick everything except Command Line Tools**.
3. Finish the install.
4. Open **Command Prompt** (Start menu, type "cmd", Enter).

*Both:* confirm it worked — this prints a version number:
```
psql --version
```

**5B.2 — Open a temporary door to the database**

Railway enables a public TCP proxy on Postgres **by default**, so the door is already open.
You'll close it in Step 6.

1. Click **analytics-db** → **Variables** tab.
2. Find **`DATABASE_PUBLIC_URL`**, click to reveal, copy it. It looks like:
```
postgresql://postgres:LONGPASSWORD@shuttle.proxy.rlwy.net:15140/railway
```
   - `DATABASE_PUBLIC_URL` = reachable from your laptop ← use this one
   - `DATABASE_URL` = private, only works inside Railway ← Metabase uses this later

In every command below, replace the whole `postgresql://...` string with **your** copied
value. Keep the single quotes.

**5B.3 — Test the connection**

*What it does:* proves your laptop can reach the database.

```
psql 'postgresql://postgres:LONGPASSWORD@shuttle.proxy.rlwy.net:15140/railway' -c "SELECT version();"
```

*Success looks like:* one line of output starting `PostgreSQL 16...`. If it hangs or times
out, the TCP proxy is off — re-enable it under analytics-db → **Settings** → **Networking**.

**5B.4 — Create the client database**

*What it does:* creates the empty database that will hold this client's data.

```
psql 'postgresql://postgres:LONGPASSWORD@shuttle.proxy.rlwy.net:15140/railway' -c "CREATE DATABASE client_hyperdrive_holdings;"
```

*Success looks like:* the single word `CREATE DATABASE`.

**5B.5 — Run the schema**

*What it does:* builds all the tables and views inside that new database.

Note the end of the URL changed from `/railway` to `/client_hyperdrive_holdings`. Also replace
`/path/to/` with wherever the file actually is on your machine.

```
psql 'postgresql://postgres:LONGPASSWORD@shuttle.proxy.rlwy.net:15140/client_hyperdrive_holdings' -v ON_ERROR_STOP=1 -f /path/to/convor_analytics_schema.sql
```

*Success looks like:* a run of `CREATE TABLE`, `CREATE INDEX`, `CREATE VIEW`, `INSERT 0 1`
lines, and **no line containing `ERROR`**. Safe to re-run; a second pass prints
`NOTICE: ... already exists, skipping`.

**5B.6 — Create the read-only role**

Five commands. Run them one at a time, in order. Replace `PUT-A-STRONG-PASSWORD-HERE` with a
generated password and save it.

*1 of 5 — create the login role.* Success: `CREATE ROLE`
```
psql 'postgresql://postgres:LONGPASSWORD@shuttle.proxy.rlwy.net:15140/client_hyperdrive_holdings' -c "CREATE ROLE mb_hyperdrive LOGIN PASSWORD 'PUT-A-STRONG-PASSWORD-HERE';"
```

*2 of 5 — let it connect to this database.* Success: `GRANT`
```
psql 'postgresql://postgres:LONGPASSWORD@shuttle.proxy.rlwy.net:15140/client_hyperdrive_holdings' -c "GRANT CONNECT ON DATABASE client_hyperdrive_holdings TO mb_hyperdrive;"
```

*3 of 5 — let it see the analytics schema.* Success: `GRANT`
```
psql 'postgresql://postgres:LONGPASSWORD@shuttle.proxy.rlwy.net:15140/client_hyperdrive_holdings' -c "GRANT USAGE ON SCHEMA analytics TO mb_hyperdrive;"
```

*4 of 5 — let it read existing tables.* Success: `GRANT`
```
psql 'postgresql://postgres:LONGPASSWORD@shuttle.proxy.rlwy.net:15140/client_hyperdrive_holdings' -c "GRANT SELECT ON ALL TABLES IN SCHEMA analytics TO mb_hyperdrive;"
```

*5 of 5 — let it read tables added later.* Success: `ALTER DEFAULT PRIVILEGES`
```
psql 'postgresql://postgres:LONGPASSWORD@shuttle.proxy.rlwy.net:15140/client_hyperdrive_holdings' -c "ALTER DEFAULT PRIVILEGES IN SCHEMA analytics GRANT SELECT ON TABLES TO mb_hyperdrive;"
```

**5B.7 — Verify**

*What it does:* lists everything the schema created.

```
psql 'postgresql://postgres:LONGPASSWORD@shuttle.proxy.rlwy.net:15140/client_hyperdrive_holdings' -c "SELECT table_name, table_type FROM information_schema.tables WHERE table_schema='analytics' ORDER BY table_type, table_name;"
```

*Success looks like:* **10 rows** — 7 `BASE TABLE` and 3 `VIEW`, exactly as in the Path A
table above, ending with `(10 rows)`.

*What it does:* proves the views execute.

```
psql 'postgresql://postgres:LONGPASSWORD@shuttle.proxy.rlwy.net:15140/client_hyperdrive_holdings' -c "SELECT * FROM analytics.v_monthly_summary;"
```

*Success looks like:* column headers and `(0 rows)`. Empty is correct — no data yet.

---

## Step 6 — Close the door

Lock both databases to private-only, per spec Section 2.

1. **analytics-db** → **Settings** tab → **Networking** → under **Public Networking**, remove
   the TCP proxy (**Remove**/**Delete** next to the `*.proxy.rlwy.net` entry).
2. Repeat for **metabase-appdb**.
3. Leave the **metabase** service's public domain alone — that one is meant to be reachable,
   and gets the Cloudflare + `insights.convor.ai` treatment at checklist item 7.

After this, `DATABASE_PUBLIC_URL` stops working from your laptop — expected. Metabase reaches
`analytics-db` privately at `analytics-db.railway.internal:5432`.

*If you used Path A you never opened the door in the first place — but still check both
services here, because Railway turns the proxy on by default at creation.*

To run SQL later: redeploy pgAdmin for a few minutes (Path A), or temporarily re-add the TCP
proxy (Path B).

---

## Step 7 — Confirm before you stop

- [ ] Project named `convor-reporting`
- [ ] Three services: `metabase`, `metabase-appdb`, `analytics-db`
- [ ] `MB_ENCRYPTION_SECRET_KEY` set on `metabase`, key saved in your password manager
- [ ] Database `client_hyperdrive_holdings` exists with **7 tables + 3 views** under
      `analytics`
- [ ] Role `mb_hyperdrive` created, password saved
- [ ] TCP proxy removed from **both** Postgres services
- [ ] pgAdmin service deleted (if you used Path A)
- [ ] Nothing reused from the Finance MCP project

That's checklist items 1 and 2 complete. Stop here for review.

---

## Pause / Resume to save cost (pre-client phase only)

**This applies only before a customer is using the system.** Once a client is live on the
dashboard, Metabase stays on — pausing it takes their reporting offline.

Metabase is the expensive service (~2GB RAM, running 24/7). The two Postgres services are
comparatively cheap, and pausing them buys little while risking confusion — leave them
running.

### To pause Metabase

1. Click the **metabase** service tile.
2. Go to the **Deployments** tab.
3. Find the active deployment at the top of the list.
4. Click the **⋮** (three-dot) menu on that deployment → **Remove**.

The service stops and its compute charges stop with it. The service, its variables (including
`MB_ENCRYPTION_SECRET_KEY`), and its configuration all stay in place.

### What still costs money while paused

- **The Hobby plan subscription (~$5/month).** Charged whether anything runs or not.
- **Volume/disk storage.** Removing a deployment stops compute, **not** storage. Metabase's
  volume and both Postgres volumes keep billing. This is small but non-zero.
- **`analytics-db` and `metabase-appdb` compute**, if you leave them running — which you
  should. `metabase-appdb` holds all your dashboards and saved questions.

So pausing cuts the largest line item, not the bill entirely. Expect a small monthly floor.

⚠️ **Do not delete `metabase-appdb` to save money.** Every dashboard, question, user and
permission group you build lives there. Deleting it means rebuilding item 6 from scratch.

### To resume

1. **metabase** service → **Deployments** tab.
2. On the most recent deployment, click **⋮** → **Redeploy**.
3. Wait for green. Metabase comes back with all dashboards and connections intact.

First boot after a pause takes a couple of minutes. If the public URL 502s, wait and refresh.

---

## Troubleshooting

**pgAdmin can't reach the database (Path A).** Check you used the **private** `PGHOST`
(`...railway.internal`), not the public proxy address, and that both services are in the same
Railway project. Private networking only works within one project.

**Metabase can't reach `analytics-db` over the private network.** Railway's private network is
IPv6-only and the JVM sometimes prefers IPv4. On the **metabase** service, add variable
`JAVA_TOOL_OPTIONS` = `-Djava.net.preferIPv6Addresses=true` and redeploy. This is the most
likely thing to bite you at checklist item 6.

**`psql: command not found` (Path B).** psql isn't installed or isn't on your PATH — see
5B.1. On Windows, close and reopen Command Prompt after installing.

**`FATAL: database "client_hyperdrive_holdings" does not exist`.** Step 5B.4 didn't run, or
the end of the URL is wrong. The database name is the part after the final `/`.

**`CREATE DATABASE cannot run inside a transaction block`.** Run it on its own exactly as in
5B.4 — don't paste it together with other statements.

**Query Tool ran against the wrong database (Path A).** pgAdmin runs against whatever is
selected in the sidebar. Re-select `client_hyperdrive_holdings`, reopen Tools → Query Tool,
and re-run. The script is safe to re-run.

**Metabase slow or restarting.** Under-resourced; confirm your plan allows ~2GB for that
service.
