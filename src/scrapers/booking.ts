import { BaseScraper } from './base.js';
import { Reservation, Payout, ExtractionResult, ExtractionOptions } from '../types/index.js';
import { calculateAggregates } from '../extractors/aggregates.js';
import { formatDate } from '../utils/dates.js';

export class BookingScraper extends BaseScraper {
  async extract(options: ExtractionOptions): Promise<ExtractionResult> {
    try {
      await this.initialize();

      this.logger.info('Starting Booking.com data extraction...');
      await this.loginToBooking();

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

  private async loginToBooking(): Promise<void> {
    if (!this.page) {
      throw new Error('Page not initialized');
    }

    const loginUrl = 'https://partner.booking.com/en-gb/login';
    const emailSelector = 'input[type="email"]';
    const passwordSelector = 'input[type="password"]';
    const submitSelector = 'button[type="submit"]';

    try {
      await this.login(loginUrl, emailSelector, passwordSelector, submitSelector);
    } catch (error) {
      this.logger.error('Failed to login to Booking.com:', error);
      throw error;
    }
  }

  private async getProperties(): Promise<Array<{ id: string; name: string }>> {
    if (!this.page) {
      throw new Error('Page not initialized');
    }

    this.logger.info('Fetching properties...');

    try {
      await this.navigateTo('https://partner.booking.com/en-gb/properties');

      // Wait for property listings to load
      await this.page.waitForSelector('[data-testid="property-item"]', { timeout: 10000 });

      const properties = await this.page.evaluate(() => {
        const items = document.querySelectorAll('[data-testid="property-item"]');
        return Array.from(items).map((item) => {
          const link = item.querySelector('a');
          const nameElement = item.querySelector('[data-testid="property-name"]');

          return {
            id: link?.getAttribute('href')?.split('/').pop() || '',
            name: nameElement?.textContent || 'Unknown',
          };
        });
      });

      return properties;
    } catch (error) {
      this.logger.warn('Could not automatically fetch properties');
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
      await this.navigateTo(`https://partner.booking.com/en-gb/property/${propertyId}/reservations`);
      await this.page.waitForSelector('[data-testid="reservation-item"]', { timeout: 10000 });

      const items = await this.page.$$('[data-testid="reservation-item"]');
      this.logger.debug(`Found ${items.length} reservation items`);

      for (const item of items) {
        try {
          const reservation = await this.parseReservationItem(item, propertyId, propertyName, options);
          if (reservation) {
            reservations.push(reservation);
          }
        } catch (error) {
          this.logger.warn(`Failed to parse reservation: ${error}`);
        }
      }
    } catch (error) {
      this.logger.warn(`Could not fetch reservations for property ${propertyId}: ${error}`);
    }

    return reservations;
  }

  private async parseReservationItem(
    item: any,
    propertyId: string,
    propertyName: string,
    options: ExtractionOptions
  ): Promise<Reservation | null> {
    const itemData = await item.evaluate((element: Element) => {
      return {
        guestName: element.querySelector('[data-testid="guest-name"]')?.textContent?.trim() || '',
        bookingReference: element.querySelector('[data-testid="booking-ref"]')?.textContent?.trim() || '',
        checkInDate: element.querySelector('[data-testid="checkin"]')?.textContent?.trim() || '',
        checkOutDate: element.querySelector('[data-testid="checkout"]')?.textContent?.trim() || '',
        status: element.querySelector('[data-testid="status"]')?.textContent?.trim() || '',
        totalAmount: element.querySelector('[data-testid="amount"]')?.textContent?.trim() || '',
      };
    });

    // Filter by date range
    if (!this.filterDateRange(itemData.checkInDate, options.startDate, options.endDate)) {
      return null;
    }

    const nights = this.calculateNights(itemData.checkInDate, itemData.checkOutDate);
    const grossAmount = this.parseAmount(itemData.totalAmount);

    const reservation: Reservation = {
      propertyId,
      propertyName,
      bookingDate: new Date().toISOString().split('T')[0],
      checkInDate: itemData.checkInDate,
      checkOutDate: itemData.checkOutDate,
      nights,
      guestCount: 1,
      guestName: itemData.guestName,
      bookingReference: itemData.bookingReference,
      grossAmount,
      currency: 'EUR',
      hostFees: 0,
      platformFees: 0,
      cleaningFees: 0,
      touristTax: 0,
      otherTaxes: 0,
      netAmount: grossAmount,
      status: itemData.status,
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
      await this.navigateTo('https://partner.booking.com/en-gb/finances/payouts');
      await this.page.waitForSelector('[data-testid="payout-item"]', { timeout: 10000 });

      const items = await this.page.$$('[data-testid="payout-item"]');
      this.logger.debug(`Found ${items.length} payout items`);

      for (const item of items) {
        try {
          const payout = await this.parsePayoutItem(item, options);
          if (payout) {
            payouts.push(payout);
          }
        } catch (error) {
          this.logger.warn(`Failed to parse payout: ${error}`);
        }
      }
    } catch (error) {
      this.logger.warn(`Could not fetch payouts: ${error}`);
    }

    return payouts;
  }

  private async parsePayoutItem(item: any, options: ExtractionOptions): Promise<Payout | null> {
    const itemData = await item.evaluate((element: Element) => {
      return {
        date: element.querySelector('[data-testid="payout-date"]')?.textContent?.trim() || '',
        amount: element.querySelector('[data-testid="payout-amount"]')?.textContent?.trim() || '',
        reference: element.querySelector('[data-testid="payout-ref"]')?.textContent?.trim() || '',
        status: element.querySelector('[data-testid="payout-status"]')?.textContent?.trim() || '',
      };
    });

    // Filter by date range
    if (!this.filterDateRange(itemData.date, options.startDate, options.endDate)) {
      return null;
    }

    const payout: Payout = {
      payoutDate: itemData.date,
      amount: this.parseAmount(itemData.amount),
      currency: 'EUR',
      reference: itemData.reference,
      status: itemData.status,
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
