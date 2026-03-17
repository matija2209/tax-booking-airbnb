#!/usr/bin/env node

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { AirbnbScraper } from './scrapers/airbnb.js';
import { BookingScraper } from './scrapers/booking.js';
import { CsvExporter } from './exporters/csv.js';
import { createLogger } from './utils/logger.js';
import { getConfig, validateConfig } from './config.js';
import { ExtractionOptions } from './types/index.js';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const logger = createLogger({ verbose: process.env.VERBOSE === 'true' });

const argv = yargs(hideBin(process.argv))
  .command(
    'airbnb',
    'Extract tax data from Airbnb',
    (yargs) =>
      yargs
        .option('propertyId', {
          alias: 'p',
          describe: 'Specific property ID to extract (optional, defaults to all)',
          type: 'string',
        })
        .option('startDate', {
          alias: 's',
          describe: 'Start date for filtering reservations (YYYY-MM-DD)',
          type: 'string',
        })
        .option('endDate', {
          alias: 'e',
          describe: 'End date for filtering reservations (YYYY-MM-DD)',
          type: 'string',
        })
        .option('output', {
          alias: 'o',
          describe: 'Output directory for CSV files',
          type: 'string',
          default: join(__dirname, '..', 'output'),
        }),
    async (args) => {
      try {
        const credentials = validateConfig('airbnb');
        const options: ExtractionOptions = {
          propertyId: args.propertyId,
          startDate: args.startDate,
          endDate: args.endDate,
          output: args.output as string,
          verbose: args.verbose as boolean | undefined,
        };

        logger.info('Initializing Airbnb scraper...');
        const scraper = new AirbnbScraper(credentials, logger);
        const result = await scraper.extract(options);

        logger.info(`Extracted ${result.reservations.length} reservations and ${result.payouts.length} payouts`);

        const exporter = new CsvExporter(options.output!, logger);
        await exporter.export(result);

        logger.info('Airbnb extraction completed successfully');
      } catch (error) {
        logger.error(`Airbnb extraction failed: ${error}`);
        process.exit(1);
      }
    }
  )
  .command(
    'booking',
    'Extract tax data from Booking.com',
    (yargs) =>
      yargs
        .option('propertyId', {
          alias: 'p',
          describe: 'Specific property ID to extract (optional, defaults to all)',
          type: 'string',
        })
        .option('startDate', {
          alias: 's',
          describe: 'Start date for filtering reservations (YYYY-MM-DD)',
          type: 'string',
        })
        .option('endDate', {
          alias: 'e',
          describe: 'End date for filtering reservations (YYYY-MM-DD)',
          type: 'string',
        })
        .option('output', {
          alias: 'o',
          describe: 'Output directory for CSV files',
          type: 'string',
          default: join(__dirname, '..', 'output'),
        }),
    async (args) => {
      try {
        const credentials = validateConfig('booking');
        const options: ExtractionOptions = {
          propertyId: args.propertyId,
          startDate: args.startDate,
          endDate: args.endDate,
          output: args.output as string,
          verbose: args.verbose as boolean | undefined,
        };

        logger.info('Initializing Booking.com scraper...');
        const scraper = new BookingScraper(credentials, logger);
        const result = await scraper.extract(options);

        logger.info(`Extracted ${result.reservations.length} reservations and ${result.payouts.length} payouts`);

        const exporter = new CsvExporter(options.output!, logger);
        await exporter.export(result);

        logger.info('Booking.com extraction completed successfully');
      } catch (error) {
        logger.error(`Booking.com extraction failed: ${error}`);
        process.exit(1);
      }
    }
  )
  .option('verbose', {
    alias: 'v',
    describe: 'Enable verbose output',
    type: 'boolean',
    default: false,
  })
  .help()
  .alias('help', 'h')
  .demandCommand(1, 'You must specify a command: airbnb or booking')
  .strict()
  .parseAsync();
