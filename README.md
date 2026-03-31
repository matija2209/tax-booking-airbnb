# Tax Data Extraction CLI

Node.js 24 LTS CLI for extracting host-side booking and tax data from Airbnb and Booking.com.

This project is currently optimized around the Airbnb host flow that was validated live against the current UI on March 31, 2026.

Current status:
- Airbnb extraction is the main working path.
- Airbnb now reads reservation data from the `Reservation Details` modal, not just the table.
- Airbnb writes an in-progress CSV while the run is still happening.
- Airbnb normalizes collapsed UI text in property, listing, guest, and modal payout fields before export.
- Booking.com remains more experimental and will likely need selector work against a live account.

What "working" means right now:
- the scraper can launch a headed browser on macOS
- manual Airbnb email-code verification can be completed in the browser
- the scraper reuses session state from `state.json`
- reservations are processed from the completed reservations table in stable top-down order
- detailed reservation data is collected from the modal opened by the row `Details` button
- progress is written to CSV during the run so partial data is not lost if the session breaks later

## What It Extracts

For Airbnb, the scraper currently pulls:
- reservation identity from the completed reservations table
- booking date, check-in, checkout, guest summary, listing name, confirmation code
- guest-paid totals from the reservation details modal
- host payout totals and fee/tax lines from the reservation details modal
- normalized property names and guest names suitable for CSV export
- yearly aggregates derived from the extracted reservations

The stable reservation key is the confirmation code in the table column next to the price. These codes currently start with `HM...`, and the scraper uses them to track what has already been processed during a run.

The extraction strategy assumes:
- the confirmation code cell is still present in the reservation table
- the `Details` action is still exposed as the first button inside the row action cell
- the modal still contains labeled `Guest paid` and `Host payout` sections

## How Airbnb Works Now

The Airbnb flow is:
1. Load session from `state.json` if present.
2. Open `https://www.airbnb.com/hosting/listings` to discover properties.
3. Open `https://www.airbnb.com/hosting/reservations/completed`.
4. Snapshot the visible table rows in top-down order.
5. Process rows sequentially by confirmation code.
6. Click the first button inside the row action cell (`Details`).
7. Read the `Reservation Details` modal.
8. Close the modal and continue to the next reservation.
9. Save progress to CSV during the run.

Runtime behavior:
- the scraper snapshots each visible reservations page before processing it
- reservation rows are keyed by confirmation code, not by raw row index
- already-processed confirmation codes are tracked in memory to avoid duplicate work within the same run
- the scraper currently skips the separate Airbnb earnings page because the useful payout data is already available inside each reservation modal

Important detail:
- The Airbnb table mixes multiple properties together on the same page.
- The scraper no longer loops property-by-property through the same table.
- It processes the table once in DOM order and maps each row back to the matching property by listing name.
- Property names from Airbnb listings are normalized before matching so unit suffixes like `CDA#1` do not collapse into the base listing name.

## Installation

```bash
pnpm install
cp .env.example .env
```

## Configuration

Create `.env` in the project root:

```env
AIRBNB_EMAIL=your_airbnb_email@example.com
AIRBNB_PASSWORD="your_airbnb_password"
BOOKING_EMAIL=your_booking_email@example.com
BOOKING_PASSWORD="your_booking_password"
BOOKING_HOTEL_ID=optional_booking_hotel_id
OUTPUT_DIR=./output
HEADLESS=false
DEVTOOLS=false
KEEP_OPEN=false
```

Notes:
- Quote passwords if they contain `#`, spaces, or other special characters.
- `HEADLESS=false` is strongly recommended for Airbnb when email confirmation or 2FA is involved.
- `KEEP_OPEN=true` leaves the browser open instead of closing it at cleanup.
- `DEVTOOLS=true` is useful for selector inspection and manual debugging.
- `state.json` is created and reused automatically after a successful login session.

Recommended local Airbnb debug setup:

```env
HEADLESS=false
KEEP_OPEN=true
DEVTOOLS=false
OUTPUT_DIR=./output
```

## Usage

### Airbnb

```bash
# normal headed run
KEEP_OPEN=true HEADLESS=false pnpm exec tsx src/index.ts airbnb --verbose

# date filtering
pnpm exec tsx src/index.ts airbnb --startDate 2024-01-01 --endDate 2024-12-31 --verbose

# custom output directory
pnpm exec tsx src/index.ts airbnb --output ./my_export --verbose
```

Recommended first real run on a desktop:

```bash
KEEP_OPEN=true HEADLESS=false pnpm exec tsx src/index.ts airbnb --verbose
```

Why this command:
- it keeps the browser visible
- it leaves the browser open after completion or failure
- it prints per-step logs so selector problems are easier to spot
- it writes in-progress CSV output while processing reservations

### Booking.com

```bash
pnpm exec tsx src/index.ts booking --verbose
```

### Build / test

```bash
pnpm run build
pnpm test
pnpm start airbnb
```

## Output Files

Airbnb currently writes:

1. `output/airbnb_booking_reservations_YYYY-MM-DD_in_progress.csv`
Progress file updated during the run after each successfully processed reservation.

2. `output/airbnb_booking_reservations_YYYY-MM-DD.csv`
Final reservation export written at the end of a successful run.

3. `output/yearly_aggregates_YYYY-MM-DD.csv`
Aggregates derived from final reservation data.

Optional payout output still exists in the exporter, but Airbnb payout-page scraping is currently skipped because the useful host payout data is already captured from each reservation modal.

Operational detail:
- the in-progress CSV is a full rewrite of the current in-memory reservation set after each processed reservation
- this is intentionally conservative and resilience-oriented
- if the run dies halfway through, the file should still contain everything processed up to the last successful modal scrape

## Reservation Schema

```ts
interface Reservation {
  propertyId: string;
  propertyName: string;
  bookingDate: string;
  checkInDate: string;
  checkOutDate: string;
  nights: number;
  guestCount: number;
  guestName: string;
  bookingReference: string;
  grossAmount: number;
  currency: string;
  guestServiceFee: number;
  hostServiceFee: number;
  nightlyRateAdjustment: number;
  hostFees: number;
  platformFees: number;
  propertyUseTaxes: number;
  cleaningFees: number;
  touristTax: number;
  otherTaxes: number;
  netAmount: number;
  status: string;
  notes?: string;
}
```

Notes on current field mapping:
- `grossAmount` is taken from the modal `Guest paid` section when available, otherwise from the table total.
- `netAmount` is taken from the modal `Host payout` total.
- `guestServiceFee` is derived from the modal guest service fee line using normalized label matching.
- `hostServiceFee` is derived from the modal host service fee line using normalized label matching.
- `nightlyRateAdjustment` is derived from the modal nightly rate adjustment line.
- `propertyUseTaxes` is derived from the modal property use taxes line.
- `cleaningFees` is derived from the modal cleaning fee line when present.
- `hostFees` is kept as a backward-compatible alias of `hostServiceFee`.
- `platformFees` is kept as a backward-compatible alias of `guestServiceFee`.
- `otherTaxes` is kept as a backward-compatible alias of `propertyUseTaxes`.
- `notes` stores structured host payout line items as a comma-separated `label: amount` string.
- `guestName` is trimmed from the table guest summary and trailing punctuation is removed during export normalization.
- `propertyName` is taken from the normalized Airbnb listings page result, not directly from the raw reservations table text.

Example `Host payout` lines seen in the live Airbnb modal:
- `3 nights room fee`
- `Nightly rate adjustment`
- `Host service fee (3.0% + VAT)`
- `Property use taxes`
- `Total (EUR)`

Example `notes` value written to CSV:
- `3 nights room fee: € 234.00, Nightly rate adjustment: −€ 18.72, Host service fee (3.0% + VAT): −€ 7.88, Property use taxes: € 22.50, Total (EUR): € 229.90`

## Logging

Use `--verbose` for debug logs:

```bash
pnpm exec tsx src/index.ts airbnb --verbose
```

Log levels:
- `[INFO]` high-level progress
- `[DEBUG]` detailed navigation and reservation processing
- `[WARN]` recoverable scraping issues
- `[ERROR]` hard failures

Examples of useful debug output:
- current navigation target
- number of rows found on the page
- reservation confirmation code being opened
- progress CSV saves
- modal open / modal close steps
- property count discovered from listings

## Troubleshooting

### Airbnb login requires email code / 2FA

Run headed:

```bash
HEADLESS=false KEEP_OPEN=true pnpm exec tsx src/index.ts airbnb --verbose
```

If Airbnb asks for an email code:
- complete the verification manually in the browser
- the scraper will continue once the session is valid
- `state.json` will be reused on future runs
- if the session becomes stale later, delete `state.json` and run headed again

### Browser closes too early

Use:

```bash
KEEP_OPEN=true HEADLESS=false pnpm exec tsx src/index.ts airbnb --verbose
```

### Password loads as empty

If your password contains `#`, quote it:

```env
AIRBNB_PASSWORD="abc#123"
```

### Rows seem to skip or reorder

The scraper now processes rows from a table snapshot using confirmation code as the stable reservation ID.

If behavior still looks wrong:
- enable `--verbose`
- confirm the row still has the confirmation code in column 8
- confirm the action button is still the first `button` inside the row `td`
- confirm the modal opens from the current visible row, not from a recycled row after table re-render
- inspect whether Airbnb changed the table markup or virtualized the row list

### A new run attaches to the previous one

If you start multiple Airbnb runs in parallel, Chrome pages and scraper state can collide.

Before rerunning:
- stop any previous `airbnb` scraper process
- close old headed Chrome windows started by the scraper
- rerun only one Airbnb process at a time

### No properties found

This usually means one of:
- session state is stale
- Airbnb changed the listings page DOM
- the page had not fully hydrated

Delete `state.json` and run headed again if needed.

## Limitations

- Airbnb selectors are tightly coupled to the current host UI and may drift.
- The Airbnb modal parser is working from current live observations, not a fully generalized schema.
- Progress CSV rewrites the full in-memory reservation set after each processed reservation; this is intentional for resilience, not efficiency.
- Booking.com is not yet hardened to the same level as Airbnb.
- Tests currently verify wiring and build stability, not full end-to-end browser extraction.
- `state.json` contains real authenticated session state and should be treated as sensitive local data.
- The scraper still depends on manual intervention when Airbnb presents a fresh email challenge or other anti-bot verification.
- If Airbnb changes the reservation modal labels, amount extraction will need to be updated.

## Practical Workflow

For a real Airbnb extraction session, the most reliable workflow is:
1. Start headed with `KEEP_OPEN=true`.
2. Complete any Airbnb login or email-code challenge manually.
3. Let the scraper process the completed reservations table in order.
4. Watch the in-progress CSV appear in `output/`.
5. If the run fails, inspect the last processed confirmation code in the CSV and logs before restarting.

This project is currently designed as a pragmatic extraction tool, not as a polished unattended production service. The live Airbnb UI changes enough that headed debugging is still part of normal operation.

## Project Structure

```text
tax-booking-airbnb/
├── src/
│   ├── index.ts
│   ├── config.ts
│   ├── types/index.ts
│   ├── scrapers/
│   │   ├── base.ts
│   │   ├── airbnb.ts
│   │   └── booking.ts
│   ├── extractors/aggregates.ts
│   ├── exporters/csv.ts
│   └── utils/
│       ├── browser.ts
│       ├── dates.ts
│       └── logger.ts
├── tests/
├── .env.example
├── package.json
└── README.md
```

## Scripts

```bash
pnpm exec tsx src/index.ts airbnb --verbose
pnpm exec tsx src/index.ts booking --verbose
pnpm run build
pnpm test
```

## Next Improvements

- write payouts incrementally if Booking.com stabilizes
- add a resume file keyed by confirmation code across separate runs
- export one JSON debug artifact per processed reservation
- improve Airbnb modal parsing for hidden / expandable sections
- add true end-to-end tests against saved HTML fixtures
