import { createObjectCsvWriter } from 'csv-writer';
import { mkdir } from 'fs/promises';
import { join } from 'path';
import { Reservation, Payout, YearlyAggregate, ExtractionResult } from '../types/index.js';
import { Logger } from '../utils/logger.js';

export class CsvExporter {
  private outputDir: string;
  private logger: Logger;
  private timestamp: string;
  private platform: string;

  constructor(outputDir: string, logger: Logger, platform: string = 'airbnb_booking') {
    this.outputDir = outputDir;
    this.logger = logger;
    this.platform = platform;
    this.timestamp = new Date().toISOString().split('T')[0];
  }

  async export(result: ExtractionResult): Promise<void> {
    await this.ensureOutputDir();

    await this.exportReservations(result.reservations, this.timestamp);
    await this.exportPayouts(result.payouts, this.timestamp);
    await this.exportAggregates(result.aggregates, this.timestamp);

    this.logger.info(`All files exported to ${this.outputDir}`);
  }

  async exportReservationsProgress(reservations: Reservation[]): Promise<void> {
    await this.ensureOutputDir();
    const filename = join(this.outputDir, `${this.platform}_reservations_${this.timestamp}_in_progress.csv`);
    const writer = this.createReservationWriter(filename);
    await writer.writeRecords(reservations);
    this.logger.debug(`Progress-saved ${reservations.length} reservations to ${filename}`);
  }

  private async ensureOutputDir(): Promise<void> {
    try {
      await mkdir(this.outputDir, { recursive: true });
      this.logger.debug(`Output directory ready: ${this.outputDir}`);
    } catch (error) {
      this.logger.error(`Failed to create output directory: ${error}`);
      throw error;
    }
  }

  private async exportReservations(reservations: Reservation[], timestamp: string): Promise<void> {
    if (reservations.length === 0) {
      this.logger.warn('No reservations to export');
      return;
    }

    const filename = join(this.outputDir, `${this.platform}_reservations_${timestamp}.csv`);

    const writer = this.createReservationWriter(filename);

    try {
      await writer.writeRecords(reservations);
      this.logger.info(`Exported ${reservations.length} reservations to ${filename}`);
    } catch (error) {
      this.logger.error(`Failed to export reservations: ${error}`);
      throw error;
    }
  }

  private createReservationWriter(filename: string) {
    return createObjectCsvWriter({
      path: filename,
      header: [
        { id: 'propertyId', title: 'Property ID' },
        { id: 'propertyName', title: 'Property Name' },
        { id: 'bookingDate', title: 'Booking Date' },
        { id: 'checkInDate', title: 'Check-In Date' },
        { id: 'checkOutDate', title: 'Check-Out Date' },
        { id: 'nights', title: 'Nights' },
        { id: 'guestCount', title: 'Guest Count' },
        { id: 'guestName', title: 'Guest Name' },
        { id: 'bookingReference', title: 'Booking Reference' },
        { id: 'grossAmount', title: 'Gross Amount' },
        { id: 'currency', title: 'Currency' },
        { id: 'guestServiceFee', title: 'Guest Service Fee' },
        { id: 'hostServiceFee', title: 'Host Service Fee' },
        { id: 'nightlyRateAdjustment', title: 'Nightly Rate Adjustment' },
        { id: 'hostFees', title: 'Host Fees' },
        { id: 'platformFees', title: 'Platform Fees' },
        { id: 'propertyUseTaxes', title: 'Property Use Taxes' },
        { id: 'cleaningFees', title: 'Cleaning Fees' },
        { id: 'touristTax', title: 'Tourist Tax' },
        { id: 'otherTaxes', title: 'Other Taxes' },
        { id: 'netAmount', title: 'Net Amount' },
        { id: 'status', title: 'Status' },
        { id: 'notes', title: 'Notes' },
        { id: 'reservationUrl', title: 'Reservation URL' },
        { id: 'result', title: 'Result' },
        { id: 'isDisputed', title: 'Is Disputed' },
        { id: 'detailedGuestName', title: 'Detailed Guest Name' },
        { id: 'detailedBookingReference', title: 'Detailed Booking Ref' },
        { id: 'detailedGrossAmount', title: 'Detailed Gross Amount' },
        { id: 'detailedHostFees', title: 'Detailed Host Fees' },
        { id: 'detailedBookingDate', title: 'Detailed Booking Date' },
      ],
    });
  }

  private async exportPayouts(payouts: Payout[], timestamp: string): Promise<void> {
    if (payouts.length === 0) {
      this.logger.warn('No payouts to export');
      return;
    }

    const filename = join(this.outputDir, `${this.platform}_payouts_${timestamp}.csv`);

    const writer = createObjectCsvWriter({
      path: filename,
      header: [
        { id: 'payoutDate', title: 'Payout Date' },
        { id: 'amount', title: 'Amount' },
        { id: 'currency', title: 'Currency' },
        { id: 'reference', title: 'Reference' },
        { id: 'status', title: 'Status' },
      ],
    });

    try {
      await writer.writeRecords(payouts);
      this.logger.info(`Exported ${payouts.length} payouts to ${filename}`);
    } catch (error) {
      this.logger.error(`Failed to export payouts: ${error}`);
      throw error;
    }
  }

  private async exportAggregates(aggregates: YearlyAggregate[], timestamp: string): Promise<void> {
    if (aggregates.length === 0) {
      this.logger.warn('No aggregates to export');
      return;
    }

    const filename = join(this.outputDir, `${this.platform}_yearly_aggregates_${timestamp}.csv`);

    const writer = createObjectCsvWriter({
      path: filename,
      header: [
        { id: 'year', title: 'Year' },
        { id: 'grossRevenue', title: 'Gross Revenue' },
        { id: 'touristTaxCollected', title: 'Tourist Tax Collected' },
        { id: 'otherTaxesCollected', title: 'Other Taxes Collected' },
        { id: 'totalFeesWithheld', title: 'Total Fees Withheld' },
        { id: 'netPayoutsReceived', title: 'Net Payouts Received' },
        { id: 'currency', title: 'Currency' },
        { id: 'reservationCount', title: 'Reservation Count' },
      ],
    });

    try {
      await writer.writeRecords(aggregates);
      this.logger.info(`Exported ${aggregates.length} yearly aggregates to ${filename}`);
    } catch (error) {
      this.logger.error(`Failed to export aggregates: ${error}`);
      throw error;
    }
  }
}

export const createCsvExporter = (outputDir: string, logger: Logger, platform?: string): CsvExporter => {
  return new CsvExporter(outputDir, logger, platform);
};
