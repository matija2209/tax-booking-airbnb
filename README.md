# Tax Data Extraction CLI

A Node.js 24 LTS CLI tool for extracting tax-relevant booking data from Airbnb and Booking.com host accounts. The tool automates the extraction of reservation and payout information, organizes it by property, and exports as CSV files for tax reporting and accounting purposes.

## Features

- **Multi-platform support**: Extract data from both Airbnb and Booking.com
- **Comprehensive data extraction**:
  - Per-reservation data: booking date, stay dates, nights, guest count, pricing breakdown, fees, taxes, status
  - Per-payout data: payout date, reference, currency, net amount
  - Yearly aggregates: gross revenue, tax collected, fees withheld, net payouts
- **Flexible filtering**:
  - Date range filtering (--startDate, --endDate)
  - Single property or all properties
  - CSV export with timestamp
- **Secure credential management**: Environment variable based authentication
- **Detailed logging**: Optional verbose output for debugging

## Installation

```bash
# Install dependencies
npm install
# or
pnpm install

# Create .env file with credentials
cp .env.example .env
```

## Configuration

Create a `.env` file in the project root with your credentials:

```env
AIRBNB_EMAIL=your_airbnb_email@example.com
AIRBNB_PASSWORD=your_airbnb_password
BOOKING_EMAIL=your_booking_email@example.com
BOOKING_PASSWORD=your_booking_password
OUTPUT_DIR=./output
```

## Usage

### Extract Airbnb Data

```bash
# Extract all properties
npm run dev airbnb

# Extract with date filtering
npm run dev airbnb --startDate 2024-01-01 --endDate 2024-12-31

# Extract single property
npm run dev airbnb --propertyId your_property_id

# Custom output directory
npm run dev airbnb --output ./my_export

# Verbose output
npm run dev airbnb --verbose
```

### Extract Booking.com Data

```bash
# Extract all properties
npm run dev booking

# Extract with date filtering
npm run dev booking --startDate 2024-01-01 --endDate 2024-12-31

# Extract single property
npm run dev booking --propertyId your_property_id

# Custom output directory
npm run dev booking --output ./my_export
```

## Build and Run

```bash
# Development (with tsx)
npm run dev airbnb
npm run dev booking

# Build to JavaScript
npm run build

# Run compiled version
npm start airbnb
npm start booking

# Run tests
npm test
npm run test:watch
```

## Project Structure

```
tax-booking-airbnb/
├── src/
│   ├── index.ts                 # CLI entry point
│   ├── config.ts                # Configuration & env var handling
│   ├── types/
│   │   └── index.ts             # TypeScript type definitions
│   ├── scrapers/
│   │   ├── base.ts              # Base scraper class
│   │   ├── airbnb.ts            # Airbnb scraper
│   │   └── booking.ts           # Booking.com scraper
│   ├── extractors/
│   │   └── aggregates.ts        # Yearly aggregate calculations
│   ├── exporters/
│   │   └── csv.ts               # CSV export utilities
│   └── utils/
│       ├── auth.ts              # Credential management
│       ├── browser.ts           # Playwright browser setup
│       ├── dates.ts             # Date parsing & filtering
│       └── logger.ts            # Logging utilities
├── tests/
│   ├── airbnb.test.ts
│   └── booking.test.ts
├── .env.example                 # Environment variables template
├── tsconfig.json                # TypeScript configuration
├── jest.config.js               # Jest testing configuration
├── package.json                 # Dependencies and scripts
└── README.md                    # This file
```

## Type Definitions

### Reservation

```typescript
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
  hostFees: number;
  platformFees: number;
  cleaningFees: number;
  touristTax: number;
  otherTaxes: number;
  netAmount: number;
  status: string;
}
```

### Payout

```typescript
interface Payout {
  payoutDate: string;
  amount: number;
  currency: string;
  reference: string;
  status: string;
}
```

### YearlyAggregate

```typescript
interface YearlyAggregate {
  year: number;
  grossRevenue: number;
  touristTaxCollected: number;
  otherTaxesCollected: number;
  totalFeesWithheld: number;
  netPayoutsReceived: number;
  currency: string;
  reservationCount: number;
}
```

## Output Files

The tool generates three CSV files by default:

1. **airbnb_booking_reservations_YYYY-MM-DD.csv**
   - Contains all reservation details
   - One row per reservation
   - Includes pricing breakdown and tax information

2. **airbnb_booking_payouts_YYYY-MM-DD.csv**
   - Contains all payout records
   - One row per payout
   - Includes payout date, amount, and reference

3. **yearly_aggregates_YYYY-MM-DD.csv**
   - Summary statistics by year
   - Total revenue, taxes, fees, and payouts
   - Reservation count per year

## Command Line Options

### Common Options

- `-v, --verbose`: Enable verbose logging output
- `-h, --help`: Show help information

### Airbnb/Booking Commands

- `-p, --propertyId <id>`: Extract data for a specific property ID
- `-s, --startDate <date>`: Filter reservations from this date (YYYY-MM-DD)
- `-e, --endDate <date>`: Filter reservations until this date (YYYY-MM-DD)
- `-o, --output <path>`: Custom output directory for CSV files

## Error Handling

The tool includes comprehensive error handling for:

- Missing or invalid credentials
- Network timeouts during scraping
- Login failures
- Missing or malformed data
- File system errors during export

Check the console output for detailed error messages when issues occur.

## Logging

Use the `--verbose` flag to enable detailed debug output:

```bash
npm run dev airbnb --verbose
```

Log levels:
- `[INFO]` - General information messages
- `[DEBUG]` - Detailed debug information (verbose only)
- `[WARN]` - Warning messages
- `[ERROR]` - Error messages

## Development

### Prerequisites

- Node.js 24.0.0 or higher
- npm or pnpm

### Dependencies

- **playwright**: ^1.45.0 - Browser automation
- **yargs**: ^17.7.2 - CLI argument parsing
- **dotenv**: ^16.3.1 - Environment variable loading
- **csv-writer**: ^1.6.0 - CSV file generation
- **date-fns**: ^3.0.0 - Date parsing and formatting
- **typescript**: ^5.3.3 - Type safety
- **jest**: ^29.7.0 - Testing framework
- **tsx**: ^4.7.0 - TypeScript execution for dev

### Scripts

```bash
npm run dev           # Run with tsx (development)
npm run build         # Compile TypeScript to JavaScript
npm start             # Run compiled JavaScript
npm test              # Run all tests
npm run test:watch    # Run tests in watch mode
```

## Data Privacy & Security

- Credentials are stored locally in `.env` and never transmitted to third parties
- The tool uses headless browser automation via Playwright
- All data extraction happens locally on your machine
- Credentials are masked in log output for security

## Limitations & Notes

- This tool requires valid credentials for the platforms
- Web scraping may break if platform UI changes significantly
- Some platforms may have rate limiting; consider spacing out extractions
- Two-factor authentication may require manual intervention

## Troubleshooting

### Login Failures

If login fails:
1. Verify credentials are correct in `.env`
2. Check if 2FA is enabled (may require manual login)
3. Ensure you're not being rate-limited

### Missing Data

If some data is not being extracted:
1. Enable verbose logging: `--verbose`
2. Check if the data is available on the platform
3. Verify date filters aren't excluding the data

### File Write Errors

If CSV export fails:
1. Ensure you have write permissions in the output directory
2. Check available disk space
3. Verify the path exists and is valid

## Testing

Run the test suite:

```bash
npm test

# Watch mode for development
npm run test:watch
```

## License

ISC

## Future Enhancements

Potential improvements for future versions:

- Database storage option (SQLite, PostgreSQL)
- Data deduplication and reconciliation
- PDF report generation
- Email delivery of reports
- Scheduled/automated extractions
- Multi-year aggregation
- Tax calculation assistance
- Integration with accounting software
