# Changelog

All notable changes to the Tax Data Extraction CLI project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-03-17

### Added

#### Project Setup
- Initialized Node.js 24 LTS project with TypeScript 5.3.3
- Set up package.json with all required dependencies and scripts
- Configured TypeScript compiler with strict mode enabled
- Created Jest testing framework configuration
- Added .gitignore for Node.js projects
- Created .env.example template for credential management

#### Core Infrastructure
- **Configuration Module** (`src/config.ts`):
  - Environment variable loading and validation
  - Credential management for both Airbnb and Booking.com
  - Output directory configuration

- **Type Definitions** (`src/types/index.ts`):
  - Reservation interface with all required fields
  - Payout interface for financial data
  - Property metadata structure
  - YearlyAggregate for tax reporting
  - ExtractionResult for scraper output
  - ExtractionOptions for CLI parameters

#### Utility Modules
- **Logger** (`src/utils/logger.ts`):
  - Structured logging with INFO, DEBUG, WARN, ERROR levels
  - Verbose mode for detailed output
  - Consistent message formatting

- **Date Utilities** (`src/utils/dates.ts`):
  - Multi-format date parsing (YYYY-MM-DD, MM/DD/YYYY, etc.)
  - Date range filtering
  - Year extraction from dates
  - Date formatting utilities

- **Authentication** (`src/utils/auth.ts`):
  - Credential validation
  - Credential masking for secure logging

- **Browser Manager** (`src/utils/browser.ts`):
  - Playwright browser lifecycle management
  - Context and page creation
  - Timeout configuration
  - Graceful cleanup

#### Scraper Framework
- **Base Scraper** (`src/scrapers/base.ts`):
  - Abstract base class for platform scrapers
  - Common login flow template
  - Navigation utilities
  - Date range filtering helpers
  - Browser lifecycle management

- **Airbnb Scraper** (`src/scrapers/airbnb.ts`):
  - Login to Airbnb host dashboard
  - Property detection and listing
  - Reservation extraction with all fields
  - Payout history extraction
  - Currency and amount parsing
  - Date range filtering
  - Guest count and night calculation

- **Booking.com Scraper** (`src/scrapers/booking.ts`):
  - Login to Booking.com partner portal
  - Property detection and listing
  - Reservation extraction
  - Payout/earnings extraction
  - Booking-specific field parsing
  - Date range filtering

#### Data Processing
- **Aggregates Extractor** (`src/extractors/aggregates.ts`):
  - Yearly aggregate calculation from reservations
  - Property-level aggregation
  - Tax and fee summation
  - Revenue calculations
  - Reservation counting per year

#### Export Functionality
- **CSV Exporter** (`src/exporters/csv.ts`):
  - Reservation data export to CSV with 18 columns
  - Payout data export to CSV with 5 columns
  - Yearly aggregate export to CSV with 8 columns
  - Automatic output directory creation
  - Timestamped filename generation
  - Detailed export logging

#### CLI Interface
- **Command Line Interface** (`src/index.ts`):
  - `airbnb` command for Airbnb data extraction
  - `booking` command for Booking.com data extraction
  - Options for property filtering (--propertyId)
  - Date range filtering (--startDate, --endDate)
  - Custom output directory (--output)
  - Verbose logging mode (--verbose)
  - Help system with command descriptions
  - Error handling with exit codes

#### Testing
- **Airbnb Tests** (`tests/airbnb.test.ts`):
  - Scraper instantiation tests
  - Amount parsing tests
  - Night calculation tests

- **Booking.com Tests** (`tests/booking.test.ts`):
  - Scraper instantiation tests
  - Amount parsing tests
  - Night calculation tests

#### Documentation
- **README.md**:
  - Comprehensive project overview
  - Installation instructions
  - Configuration guide
  - Usage examples for both platforms
  - Build and test commands
  - Project structure documentation
  - Type definitions reference
  - Output file descriptions
  - Command line options reference
  - Error handling guide
  - Development setup
  - Security and privacy notes
  - Troubleshooting section

- **CHANGELOG.md** (this file):
  - Version history and changes documentation

### Features

#### Data Extraction Capabilities
- Extracts 18 reservation fields including:
  - Property identification
  - Guest information
  - Booking reference
  - Check-in/check-out dates
  - Night count calculation
  - Pricing breakdown (gross, fees, taxes)
  - Reservation status

- Extracts 5 payout fields:
  - Payout date
  - Amount
  - Currency
  - Reference number
  - Status

- Calculates yearly aggregates:
  - Gross revenue
  - Tourist tax collected
  - Other taxes collected
  - Total fees withheld
  - Net payouts received
  - Reservation count per year

#### Filtering & Options
- Property-level filtering via ID
- Date range filtering (start and end dates)
- Automatic all-properties extraction
- Custom output directory support
- Verbose debug logging

#### Data Export
- Three CSV file types generated per extraction
- Consistent timestamp-based naming
- Automatic directory creation
- Full column headers in English
- Proper number and date formatting

### Technical Stack

- **Language**: TypeScript 5.3.3 (ES2024)
- **Runtime**: Node.js 24.0.0+ (ES Modules)
- **Browser Automation**: Playwright 1.45.0
- **CLI Framework**: yargs 17.7.2
- **Date Handling**: date-fns 3.0.0
- **CSV Export**: csv-writer 1.6.0
- **Testing**: Jest 29.7.0 with ts-jest
- **Development**: tsx 4.7.0

### Project Structure

Complete file structure with 17 core source files:
- 1 CLI entry point
- 1 configuration module
- 1 type definitions module
- 4 utility modules
- 3 scraper modules
- 1 aggregates extractor
- 1 CSV exporter
- 2 test files
- Plus configuration files (tsconfig.json, jest.config.js, package.json)

### Known Limitations

- Requires valid credentials for platform accounts
- Web scraping may break if platform UI changes
- Two-factor authentication may need manual intervention
- Scraping bound by platform rate limiting
- Initial data extraction requires browser automation

### Security Considerations

- Credentials stored locally in .env (not committed to git)
- Credentials masked in log output
- No sensitive data transmission to external services
- Local data processing only
- headless browser automation

---

## Future Versions

Planned enhancements for future releases:

- Database storage (SQLite/PostgreSQL)
- Scheduled/automated extractions
- Multi-year aggregations
- PDF report generation
- Accounting software integration
- Data reconciliation features
- Tax calculation assistance
