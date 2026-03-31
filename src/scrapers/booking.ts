import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { BaseScraper } from './base.js';
import { Reservation, Payout, ExtractionResult, ExtractionOptions } from '../types/index.js';
import { calculateAggregates } from '../extractors/aggregates.js';
import { formatDate } from '../utils/dates.js';

const ADMIN_URL = 'https://admin.booking.com';

export class BookingScraper extends BaseScraper {
  private debugDir = 'output/debug';

  async extract(options: ExtractionOptions): Promise<ExtractionResult> {
    this.debugDir = join(options.output || 'output', 'debug');

    try {
      await this.initialize();
      this.logger.info('Starting Booking.com data extraction...');

      await this.loginToBooking();

      const hotelIds = await this.detectHotelIds();
      this.logger.info(`Detected hotel IDs: ${hotelIds.join(', ') || 'none'}`);

      if (hotelIds.length === 0) {
        throw new Error(
          'No hotel IDs detected after login. Set BOOKING_HOTEL_ID in your .env file.'
        );
      }

      const idsToScrape = options.propertyId
        ? hotelIds.filter((id) => id === options.propertyId)
        : hotelIds;

      if (idsToScrape.length === 0) {
        throw new Error(`No properties found matching ID: ${options.propertyId}`);
      }

      const allReservations: Reservation[] = [];
      const allPayouts: Payout[] = [];

      for (const hotelId of idsToScrape) {
        this.logger.info(`Extracting data for hotel ID: ${hotelId}`);

        const reservations = await this.getReservations(hotelId, options);
        allReservations.push(...reservations);

        const payouts = await this.getPayouts(hotelId, options);
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

  // ---------------------------------------------------------------------------
  // Login
  // ---------------------------------------------------------------------------

  private async loginToBooking(): Promise<void> {
    if (!this.page) throw new Error('Page not initialized');

    this.logger.info(`Navigating to ${ADMIN_URL} ...`);
    await this.page.goto(ADMIN_URL, { waitUntil: 'domcontentloaded' });
    await this.screenshot('01-login-page');

    // Booking.com extranet login form uses name="loginname" for the username field
    const loginSelectors = [
      'input[name="loginname"]',
      'input[name="username"]',
      'input[name="email"]',
      'input[type="email"]',
    ];

    const loginSelector = await this.firstVisibleSelector(loginSelectors, 15000);
    if (!loginSelector) {
      await this.screenshot('01-login-no-field');
      await this.savePageHtml('01-login-page');
      throw new Error(
        'Could not find login name field. Check 01-login-page.html in debug output.'
      );
    }

    await this.page.fill(loginSelector, this.credentials.email);
    this.logger.debug(`Filled login name using selector: ${loginSelector}`);

    // Booking.com may show password on the same page or require a "Continue" click first
    const passwordSelector = 'input[name="password"], input[type="password"]';
    const passwordVisible = await this.page.isVisible(passwordSelector);

    if (!passwordVisible) {
      this.logger.debug('Password field not visible yet — clicking submit to reveal it...');
      await this.page.click('button[type="submit"], input[type="submit"]');
      try {
        await this.page.waitForSelector(passwordSelector, { timeout: 10000 });
        await this.screenshot('02-password-step');
      } catch {
        await this.screenshot('02-no-password-field');
        await this.savePageHtml('02-after-username-submit');
        throw new Error(
          'Password field did not appear after username submit. Check debug output.'
        );
      }
    }

    await this.page.fill(passwordSelector, this.credentials.password);
    await this.screenshot('03-before-submit');
    this.logger.debug('Filled password, submitting...');

    await this.page.click('button[type="submit"], input[type="submit"]');

    // Wait for successful login: URL should change away from login/signin paths
    try {
      await this.page.waitForFunction(
        "!window.location.href.includes('/login') && " +
          "!window.location.href.includes('/signin') && " +
          "!window.location.href.includes('login.en-gb')",
        { timeout: 30000 }
      );
      this.logger.info('Login successful');
    } catch {
      await this.screenshot('04-login-failed');
      await this.savePageHtml('04-login-result');
      const currentUrl = this.page.url();
      throw new Error(
        `Login may have failed — still on login page. Current URL: ${currentUrl}` +
          `\nCheck credentials in .env and see debug output for details.`
      );
    }

    await this.screenshot('05-after-login');
    await this.savePageHtml('05-after-login');
    this.logger.debug(`Post-login URL: ${this.page.url()}`);
  }

  // ---------------------------------------------------------------------------
  // Hotel ID detection
  // ---------------------------------------------------------------------------

  private async detectHotelIds(): Promise<string[]> {
    if (!this.page) throw new Error('Page not initialized');

    // Honour an explicit env override first
    const envId = process.env.BOOKING_HOTEL_ID;
    if (envId) {
      this.logger.info(`Using BOOKING_HOTEL_ID from .env: ${envId}`);
      return envId.split(',').map((s) => s.trim()).filter(Boolean);
    }

    const url = this.page.url();
    this.logger.debug(`Post-login URL: ${url}`);

    // hotel_id= query param
    try {
      const urlObj = new URL(url);
      const param = urlObj.searchParams.get('hotel_id');
      if (param) return [param];
    } catch {/* invalid url */}

    // /hotel/12345/ path segment
    const pathMatch = url.match(/\/hotel\/(\d+)\//);
    if (pathMatch) return [pathMatch[1]];

    // Search the page source for hotel_id occurrences
    const found = await this.page.evaluate(() => {
      const ids: string[] = [];
      // Check inline scripts
      document.querySelectorAll('script').forEach((s) => {
        const matches = [...(s.textContent?.matchAll(/hotel_id['":\s]+(\d{4,})/g) ?? [])];
        matches.forEach((m) => ids.push(m[1]));
      });
      // Check data attributes
      document.querySelectorAll('[data-hotel-id],[data-property-id],[data-hotel]').forEach((el) => {
        const id =
          el.getAttribute('data-hotel-id') ||
          el.getAttribute('data-property-id') ||
          el.getAttribute('data-hotel');
        if (id) ids.push(id);
      });
      return [...new Set(ids)];
    });

    if (found.length > 0) {
      this.logger.info(`Detected hotel IDs from page: ${found.join(', ')}`);
      return found;
    }

    this.logger.warn(
      'Could not auto-detect hotel ID from URL or page source. ' +
        'Add BOOKING_HOTEL_ID=<your_id> to your .env file.'
    );
    await this.screenshot('hotel-id-detection-failed');
    await this.savePageHtml('hotel-id-detection-failed');
    return [];
  }

  // ---------------------------------------------------------------------------
  // Reservations
  // ---------------------------------------------------------------------------

  private async getReservations(
    hotelId: string,
    options: ExtractionOptions
  ): Promise<Reservation[]> {
    if (!this.page) throw new Error('Page not initialized');

    this.logger.info(`Fetching reservations for hotel ${hotelId}...`);

    const params = new URLSearchParams({ hotel_id: hotelId });
    if (options.startDate) params.set('date_from', options.startDate);
    if (options.endDate) params.set('date_to', options.endDate);

    const url = `${ADMIN_URL}/hotel/hoteladmin/reservation.en-gb.html?${params}`;

    try {
      await this.page.goto(url, { waitUntil: 'domcontentloaded' });
      // Give SPA a moment to hydrate
      await this.page.waitForLoadState('networkidle').catch(() => {});
      await this.screenshot(`reservations-${hotelId}`);
      await this.savePageHtml(`reservations-${hotelId}`);

      // Try several plausible row selectors — update once you inspect the real page
      const rowSelectors = [
        '[data-testid="reservation-row"]',
        'tr[data-id]',
        'tr.reservation-row',
        '.bui-table__row[class*="reservation"]',
        'table tbody tr',
      ];

      const rowSelector = await this.firstPresentSelector(rowSelectors);
      if (!rowSelector) {
        this.logger.warn(
          `No reservation rows found on ${url}. ` +
            `Inspect reservations-${hotelId}.html in ${this.debugDir} to find the correct selector.`
        );
        return [];
      }

      this.logger.debug(`Reservation rows matched by: "${rowSelector}"`);
      return await this.parseReservationRows(rowSelector, hotelId, options);
    } catch (error) {
      this.logger.warn(`Could not fetch reservations for hotel ${hotelId}: ${error}`);
      await this.screenshot(`reservations-${hotelId}-error`);
      return [];
    }
  }

  private async parseReservationRows(
    selector: string,
    hotelId: string,
    options: ExtractionOptions
  ): Promise<Reservation[]> {
    if (!this.page) return [];

    const rows = this.page.locator(selector);
    const count = await rows.count();
    this.logger.info(`Parsing ${count} reservation rows`);

    const reservations: Reservation[] = [];

    for (let i = 0; i < count; i++) {
      try {
        const row = rows.nth(i);

        const data = await row.evaluate((el: Element) => {
          const text = (sel: string) =>
            el.querySelector(sel)?.textContent?.trim() ?? '';
          const attr = (sel: string, a: string) =>
            el.querySelector(sel)?.getAttribute(a) ?? '';

          return {
            bookingRef:
              text('[class*="booking-id"],[data-testid="booking-id"],.booking_id') ||
              attr('[data-id]', 'data-id') ||
              el.id ||
              '',
            guestName:
              text('[class*="guest-name"],[data-testid="guest-name"],.guest_name') || '',
            checkIn:
              text(
                '[class*="check-in"],[data-testid="checkin"],.date_from,.arrival,[class*="checkin"]'
              ) || '',
            checkOut:
              text(
                '[class*="check-out"],[data-testid="checkout"],.date_to,.departure,[class*="checkout"]'
              ) || '',
            status:
              text('[class*="status"],[data-testid="status"],.status') || '',
            price:
              text(
                '[class*="price"],[class*="amount"],[data-testid="price"],.price,.amount'
              ) || '',
            currency:
              el.querySelector('[class*="currency"]')?.textContent?.trim() ?? 'EUR',
          };
        });

        if (!data.checkIn && !data.bookingRef) continue;
        if (!this.filterDateRange(data.checkIn, options.startDate, options.endDate)) continue;

        const nights = this.calculateNights(data.checkIn, data.checkOut);
        const grossAmount = this.parseAmount(data.price);

        reservations.push({
          propertyId: hotelId,
          propertyName: `Booking.com Hotel ${hotelId}`,
          bookingDate: new Date().toISOString().split('T')[0],
          checkInDate: data.checkIn,
          checkOutDate: data.checkOut,
          nights,
          guestCount: 1,
          guestName: data.guestName,
          bookingReference: data.bookingRef,
          grossAmount,
          currency: data.currency,
          guestServiceFee: 0,
          hostServiceFee: 0,
          nightlyRateAdjustment: 0,
          hostFees: 0,
          platformFees: 0,
          propertyUseTaxes: 0,
          cleaningFees: 0,
          touristTax: 0,
          otherTaxes: 0,
          netAmount: grossAmount,
          status: data.status,
        });
      } catch (error) {
        this.logger.warn(`Failed to parse reservation row ${i}: ${error}`);
      }
    }

    return reservations;
  }

  // ---------------------------------------------------------------------------
  // Payouts / Finance
  // ---------------------------------------------------------------------------

  private async getPayouts(hotelId: string, options: ExtractionOptions): Promise<Payout[]> {
    if (!this.page) throw new Error('Page not initialized');

    this.logger.info(`Fetching payouts for hotel ${hotelId}...`);

    const url = `${ADMIN_URL}/hotel/hoteladmin/financial_overview.html?hotel_id=${hotelId}`;

    try {
      await this.page.goto(url, { waitUntil: 'domcontentloaded' });
      await this.page.waitForLoadState('networkidle').catch(() => {});
      await this.screenshot(`payouts-${hotelId}`);
      await this.savePageHtml(`payouts-${hotelId}`);

      const rowSelectors = [
        '[data-testid="invoice-row"]',
        'tr.invoice-row',
        'tr[data-invoice-id]',
        'table.invoices tbody tr',
        '[class*="invoice"] tr',
        'table tbody tr',
      ];

      const rowSelector = await this.firstPresentSelector(rowSelectors);
      if (!rowSelector) {
        this.logger.warn(
          `No payout rows found on ${url}. ` +
            `Inspect payouts-${hotelId}.html in ${this.debugDir} to find the correct selector.`
        );
        return [];
      }

      this.logger.debug(`Payout rows matched by: "${rowSelector}"`);
      return await this.parsePayoutRows(rowSelector, options);
    } catch (error) {
      this.logger.warn(`Could not fetch payouts for hotel ${hotelId}: ${error}`);
      await this.screenshot(`payouts-${hotelId}-error`);
      return [];
    }
  }

  private async parsePayoutRows(selector: string, options: ExtractionOptions): Promise<Payout[]> {
    if (!this.page) return [];

    const rows = this.page.locator(selector);
    const count = await rows.count();
    this.logger.info(`Parsing ${count} payout rows`);

    const payouts: Payout[] = [];

    for (let i = 0; i < count; i++) {
      try {
        const row = rows.nth(i);

        const data = await row.evaluate((el: Element) => {
          const text = (sel: string) =>
            el.querySelector(sel)?.textContent?.trim() ?? '';

          return {
            date: text('[class*="date"],.date') || '',
            amount:
              text('[class*="amount"],[class*="price"],[class*="total"],.amount') || '',
            reference:
              text('[class*="id"],[class*="ref"],[class*="invoice"],.id,.ref') || '',
            status: text('[class*="status"],.status') || '',
          };
        });

        if (!data.date && !data.amount) continue;
        if (!this.filterDateRange(data.date, options.startDate, options.endDate)) continue;

        payouts.push({
          payoutDate: data.date,
          amount: this.parseAmount(data.amount),
          currency: 'EUR',
          reference: data.reference,
          status: data.status,
        });
      } catch (error) {
        this.logger.warn(`Failed to parse payout row ${i}: ${error}`);
      }
    }

    return payouts;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Return the first selector from the list that matches at least one element. */
  private async firstPresentSelector(selectors: string[]): Promise<string | null> {
    if (!this.page) return null;
    for (const sel of selectors) {
      const count = await this.page.locator(sel).count();
      if (count > 0) return sel;
    }
    return null;
  }

  /** Return the first selector from the list that has a visible element within timeout. */
  private async firstVisibleSelector(
    selectors: string[],
    timeout = 10000
  ): Promise<string | null> {
    if (!this.page) return null;
    const combined = selectors.join(', ');
    try {
      await this.page.waitForSelector(combined, { timeout });
    } catch {
      return null;
    }
    for (const sel of selectors) {
      if (await this.page.isVisible(sel)) return sel;
    }
    return null;
  }

  private async screenshot(name: string): Promise<void> {
    if (!this.page) return;
    try {
      await mkdir(this.debugDir, { recursive: true });
      const path = join(this.debugDir, `${name}.png`);
      await this.page.screenshot({ path, fullPage: true });
      this.logger.debug(`Screenshot: ${path}`);
    } catch (error) {
      this.logger.debug(`Screenshot failed: ${error}`);
    }
  }

  private async savePageHtml(name: string): Promise<void> {
    if (!this.page) return;
    try {
      await mkdir(this.debugDir, { recursive: true });
      const content = await this.page.content();
      const path = join(this.debugDir, `${name}.html`);
      await writeFile(path, content, 'utf-8');
      this.logger.debug(`HTML dump: ${path}`);
    } catch (error) {
      this.logger.debug(`HTML dump failed: ${error}`);
    }
  }

  private calculateNights(checkIn: string, checkOut: string): number {
    try {
      const start = new Date(checkIn);
      const end = new Date(checkOut);
      const diff = end.getTime() - start.getTime();
      return Math.max(1, Math.round(diff / (1000 * 60 * 60 * 24)));
    } catch {
      return 0;
    }
  }

  private parseAmount(amountStr: string): number {
    if (!amountStr) return 0;
    // Strip currency symbols, keep digits, comma, dot, minus
    const cleaned = amountStr.replace(/[^\d.,-]/g, '');
    // Handle European format: 1.234,56 → 1234.56
    const normalised = cleaned.replace(/\.(?=\d{3})/g, '').replace(',', '.');
    return parseFloat(normalised) || 0;
  }
}
