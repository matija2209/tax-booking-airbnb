import { BaseScraper } from './base.js';
import { Reservation, Payout, ExtractionResult, ExtractionOptions } from '../types/index.js';
import { calculateAggregates } from '../extractors/aggregates.js';
import { formatDate } from '../utils/dates.js';

export class AirbnbScraper extends BaseScraper {
  async extract(options: ExtractionOptions): Promise<ExtractionResult> {
    try {
      await this.initialize();

      this.logger.info('Starting Airbnb data extraction...');
      await this.loginToAirbnb();

      const properties = await this.getProperties();
      this.logger.info(`Found ${properties.length} properties`);

      const propertiesToScrape = options.propertyId
        ? properties.filter((p) => p.id === options.propertyId)
        : properties;

      if (propertiesToScrape.length === 0) {
        throw new Error(`No properties found matching ID: ${options.propertyId}`);
      }

      const allReservations: Reservation[] = [];
      const allPayouts: Payout[] = [];

      for (const property of propertiesToScrape) {
        this.logger.info(`Extracting data for property: ${property.name} (${property.id})`);

        const reservations = await this.getReservations(property.id, property.name, options);
        allReservations.push(...reservations);

        const payouts = await this.getPayouts(options);
        allPayouts.push(...payouts);
      }

      const aggregates = calculateAggregates(allReservations);

      return {
        reservations: allReservations,
        payouts: allPayouts,
        aggregates,
        extractedAt: formatDate(new Date(), "yyyy-MM-dd'T'HH:mm:ss"),
      };
    } finally {
      await this.cleanup();
    }
  }

  private async loginToAirbnb(): Promise<void> {
    if (!this.page) {
      throw new Error('Page not initialized');
    }

    const loginUrl = 'https://www.airbnb.com/login';
    const emailSelector = 'input[type="email"]';
    const passwordSelector = 'input[type="password"]';
    const submitSelector = 'button[type="button"]';

    try {
      await this.login(loginUrl, emailSelector, passwordSelector, submitSelector);
    } catch (error) {
      this.logger.error('Failed to login to Airbnb:', error);
      throw error;
    }
  }

  private async getProperties(): Promise<Array<{ id: string; name: string }>> {
    if (!this.page) {
      throw new Error('Page not initialized');
    }

    this.logger.info('Fetching properties...');

    try {
      await this.navigateTo('https://www.airbnb.com/hosting/homes');

      // Wait for property listings to load
      await this.page.waitForSelector('[data-testid="property-card"]', { timeout: 10000 });

      const properties = await this.page.evaluate(() => {
        const cards = document.querySelectorAll('[data-testid="property-card"]');
        return Array.from(cards).map((card) => {
          const link = card.querySelector('a');
          const title = card.querySelector('[data-testid="title"]');

          return {
            id: link?.getAttribute('href')?.split('/').pop() || '',
            name: title?.textContent || 'Unknown',
          };
        });
      });

      return properties;
    } catch (error) {
      this.logger.warn('Could not automatically fetch properties, will proceed with manual entry if needed');
      return [];
    }
  }

  private async getReservations(
    propertyId: string,
    propertyName: string,
    options: ExtractionOptions
  ): Promise<Reservation[]> {
    if (!this.page) {
      throw new Error('Page not initialized');
    }

    const reservations: Reservation[] = [];
    this.logger.info(`Fetching reservations for property ${propertyId}...`);

    try {
      await this.navigateTo(`https://www.airbnb.com/hosting/reservations`);
      await this.page.waitForSelector('[data-testid="reservation-row"]', { timeout: 10000 });

      const rows = await this.page.$$('[data-testid="reservation-row"]');
      this.logger.debug(`Found ${rows.length} reservation rows`);

      for (const row of rows) {
        try {
          const reservation = await this.parseReservationRow(row, propertyId, propertyName, options);
          if (reservation) {
            reservations.push(reservation);
          }
        } catch (error) {
          this.logger.warn(`Failed to parse reservation row: ${error}`);
        }
      }
    } catch (error) {
      this.logger.warn(`Could not fetch reservations for property ${propertyId}: ${error}`);
    }

    return reservations;
  }

  private async parseReservationRow(
    row: any,
    propertyId: string,
    propertyName: string,
    options: ExtractionOptions
  ): Promise<Reservation | null> {
    if (!this.page) {
      throw new Error('Page not initialized');
    }

    const rowData = await row.evaluate((element: Element) => {
      const cells = element.querySelectorAll('td');
      return {
        guestName: cells[0]?.textContent?.trim() || '',
        bookingReference: cells[1]?.textContent?.trim() || '',
        checkInDate: cells[2]?.textContent?.trim() || '',
        checkOutDate: cells[3]?.textContent?.trim() || '',
        status: cells[4]?.textContent?.trim() || '',
        amount: cells[5]?.textContent?.trim() || '',
      };
    });

    // Filter by date range
    if (!this.filterDateRange(rowData.checkInDate, options.startDate, options.endDate)) {
      return null;
    }

    // Parse the row data into a Reservation object
    const nights = this.calculateNights(rowData.checkInDate, rowData.checkOutDate);
    const grossAmount = this.parseAmount(rowData.amount);

    const reservation: Reservation = {
      propertyId,
      propertyName,
      bookingDate: new Date().toISOString().split('T')[0],
      checkInDate: rowData.checkInDate,
      checkOutDate: rowData.checkOutDate,
      nights,
      guestCount: 1, // Default, should be extracted if available
      guestName: rowData.guestName,
      bookingReference: rowData.bookingReference,
      grossAmount,
      currency: 'USD', // Should be extracted from page
      hostFees: 0,
      platformFees: 0,
      cleaningFees: 0,
      touristTax: 0,
      otherTaxes: 0,
      netAmount: grossAmount,
      status: rowData.status,
    };

    return reservation;
  }

  private async getPayouts(options: ExtractionOptions): Promise<Payout[]> {
    if (!this.page) {
      throw new Error('Page not initialized');
    }

    const payouts: Payout[] = [];
    this.logger.info('Fetching payouts...');

    try {
      await this.navigateTo('https://www.airbnb.com/hosting/earnings');
      await this.page.waitForSelector('[data-testid="payout-row"]', { timeout: 10000 });

      const rows = await this.page.$$('[data-testid="payout-row"]');
      this.logger.debug(`Found ${rows.length} payout rows`);

      for (const row of rows) {
        try {
          const payout = await this.parsePayoutRow(row, options);
          if (payout) {
            payouts.push(payout);
          }
        } catch (error) {
          this.logger.warn(`Failed to parse payout row: ${error}`);
        }
      }
    } catch (error) {
      this.logger.warn(`Could not fetch payouts: ${error}`);
    }

    return payouts;
  }

  private async parsePayoutRow(row: any, options: ExtractionOptions): Promise<Payout | null> {
    const rowData = await row.evaluate((element: Element) => {
      const cells = element.querySelectorAll('td');
      return {
        date: cells[0]?.textContent?.trim() || '',
        amount: cells[1]?.textContent?.trim() || '',
        reference: cells[2]?.textContent?.trim() || '',
        status: cells[3]?.textContent?.trim() || '',
      };
    });

    // Filter by date range
    if (!this.filterDateRange(rowData.date, options.startDate, options.endDate)) {
      return null;
    }

    const payout: Payout = {
      payoutDate: rowData.date,
      amount: this.parseAmount(rowData.amount),
      currency: 'USD',
      reference: rowData.reference,
      status: rowData.status,
    };

    return payout;
  }

  private calculateNights(checkIn: string, checkOut: string): number {
    try {
      const start = new Date(checkIn);
      const end = new Date(checkOut);
      const diffTime = Math.abs(end.getTime() - start.getTime());
      return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    } catch {
      return 0;
    }
  }

  private parseAmount(amountStr: string): number {
    const match = amountStr.match(/[\d,]+\.?\d*/);
    if (match) {
      return parseFloat(match[0].replace(/,/g, ''));
    }
    return 0;
  }
}
