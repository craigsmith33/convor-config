# Tallmark sample books (QuickBooks sandbox)

The Finance Assistant demo reads a QuickBooks Online **sandbox** company that holds
the books of Tallmark Industrial Supply, the fictional distributor used by the
Sales Assistant demo. These files build and load those books.

| File | What it is |
|---|---|
| `generate_tallmark_books.py` | Generates the books from Tallmark's price guide: about $56M of sales in 2025 and $49M from January 1 to October 12, 2026, 120 customers, 32 vendors, ~2,500 invoices, payments, supplier bills, payroll, rent, loans and opening balances. Deterministic. Prints the expected statements. |
| `tallmark-books.json` | The generated dataset (output of the script above, `--write tallmark-books.json`). |
| `tallmark-loader.mjs` | One-time loader that writes the dataset into the sandbox. |

## How the loader runs

The connector itself stays read-only. The loader ran inside the
`quickbooks-connector` container *before* the connector started, so it shared
the connector's saved QuickBooks login (the token store on `/data`) and wrote any
rotated refresh token back where the connector reads it.

- It refuses to run unless `QUICKBOOKS_ENVIRONMENT` is `sandbox` and the company
  is either Intuit's sample company or Tallmark.
- Progress is kept in `/data/convor-seed/state.json`, so an interrupted run
  resumes without creating duplicates.
- Before deleting anything it saved a full JSON backup of Intuit's sample company
  to `/data/convor-seed/intuit-sample-backup.json`.

Modes (`SEED_MODE`): `probe` (read only), `cleanup` (back up, delete the sample
transactions, make sample names inactive), `setup` (rename the company, create
accounts, items, customers, vendors), `prepare` (cleanup + setup), `load` (opening
balances and all transactions), `tidy` (clear leftover sample sales-tax balances),
`report` (read only).

To run it, the service's start command temporarily downloaded the loader from
`SEED_URL` (pinned by commit, checked against `SEED_SHA256`) and ran it before
`exec node /tmp/qc.mjs`, with the health-check timeout raised to 30 minutes. Both
were restored to normal after the load on October 13, 2026.

## Known leftovers from Intuit's sample company

QuickBooks would not let a few sample records be deleted or made inactive:

- Three customers with unbilled time entries were renamed to dormant Tallmark
  accounts (Rockford Packaging Prototypes, Peoria Gear & Machine, Kankakee Valley
  Bottlers).
- Two vendors (Cal Telephone, Hall Properties) and a handful of zero-balance
  landscaping accounts are still active. They have no transactions.
- Making the sample inventory items inactive posted $567.50 of Inventory
  Shrinkage on October 13, 2026.

## Keeping the demo current

The books stop on October 12, 2026. As weeks pass, open invoices age and
"this month" questions find less. Extending the books means generating the new
period and loading it the same way.
