import { BaseScraper } from './base.js';
import { Reservation, Payout, ExtractionResult, ExtractionOptions } from '../types/index.js';
import { calculateAggregates } from '../extractors/aggregates.js';
import { formatDate } from '../utils/dates.js';
import { existsSync } from 'fs';

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

    if (existsSync('state.json')) {
      this.logger.info('Session state found, skipping explicit login step.');
      // By returning here, we'll proceed directly to dashboard fetching.
      // If the cookie had expired, the properties fetch would fail.
      return;
    }

    const loginUrl = 'https://www.airbnb.com/login';

    try {
      if (process.env.DEVTOOLS === 'true') {
        this.logger.info('DEVTOOLS=true detected. Pausing on login page for manual CSS element inspection...');
        await this.page.goto(loginUrl, { waitUntil: 'domcontentloaded' });
        await this.page.pause();
        this.logger.info('Resumed from Inspector. Continuing with automated login...');
      } else {
        this.logger.info('Navigating to login page...');
        await this.page.goto(loginUrl, { waitUntil: 'domcontentloaded' });
      }

      // 1. Check if "Continue with email" button exists and click it
      const continueWithEmailSelector = 'button[aria-label="Continue with email"]';
      const continueBtn = await this.page.$(continueWithEmailSelector);
      if (continueBtn) {
        this.logger.debug('Clicking "Continue with email"...');
        await this.page.click(continueWithEmailSelector);
        await this.page.waitForTimeout(1000); // Wait for animation
      }

      // 2. Fill Email
      this.logger.debug('Filling email field...');
      const emailSelector = 'input#email-login-email, input[name="user[email]"]';
      await this.page.waitForSelector(emailSelector, { state: 'visible' });
      await this.page.fill(emailSelector, this.credentials.email);

      // 3. Click Continue
      this.logger.debug('Clicking Continue after email...');
      const submitSelector = 'button[type="submit"], [data-testid="signup-login-submit-btn"]';
      await this.page.click(submitSelector);

      // 4. Fill Password
      this.logger.debug('Waiting for password field or another login challenge...');
      const passwordSelector = 'input#email-signup-password, [data-testid="email-signup-password"]';
      
      try {
        await this.page.waitForSelector(passwordSelector, { state: 'visible', timeout: 15000 });
        await this.page.fill(passwordSelector, this.credentials.password);

        // 5. Click Log In
        this.logger.info('Submitting login form...');
        await Promise.all([
          this.page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
          this.page.click(submitSelector)
        ]);
        this.logger.info('Login successful');
        
        await this.browserManager.getContext().storageState({ path: 'state.json' });
        this.logger.info('Saved session state to state.json');
      } catch (e) {
        this.logger.warn('Password field did not appear within 15 seconds. Airbnb might be enforcing a CAPTCHA, Phone Number challenge, or 2FA immediately in headless mode.');
        this.logger.info('If you are running in Headless mode, please run it in Headed mode first `HEADLESS=false pnpm run dev -- airbnb` to solve the challenge.');
        
        if (process.env.HEADLESS !== 'false') {
          // Dump the HTML so user can debug what page it's actually on
          const html = await this.page.content();
          this.logger.debug(`Current HTML (first 500 chars): ${html.substring(0, 500)}`);
          throw new Error('Headless login blocked by Airbnb security challenge.');
        } else {
          // If in headed mode we could pause here for the user to solve it manually
          this.logger.info('Waiting for manual login completion since we are in headed mode...');
          await this.page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }); 
          
          await this.browserManager.getContext().storageState({ path: 'state.json' });
          this.logger.info('Saved session state to state.json after manual login');
        }
      }
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
      await this.navigateTo('https://www.airbnb.com/hosting/listings');

      if (process.env.DEVTOOLS === 'true') {
        this.logger.info('DEVTOOLS=true detected. Pausing on properties page to allow manual 2FA completion and CSS selector inspection...');
        await this.page.pause();
        this.logger.info('Resumed from Inspector. Continuing with property extraction...');
      }

      // Wait for property listings to load
      await this.page.waitForSelector('tr.tfgampn', { timeout: 30000 });

      const properties = await this.page.evaluate(() => {
        const cards = document.querySelectorAll('tr.tfgampn');
        return Array.from(cards).map((card) => {
          // Extract name
          const nameEl = card.querySelector('div.t1ojp9a2');
          
          // Extract ID from checkbox input (e.g. id="checkbox-12345")
          const checkboxEl = card.querySelector('input[id^="checkbox-"]');
          let id = '';
          if (checkboxEl) {
            const idMatch = checkboxEl.id.match(/checkbox-(\d+)/);
            if (idMatch && idMatch[1]) {
              id = idMatch[1];
            }
          }

          return {
            id: id,
            name: nameEl?.textContent?.trim() || 'Unknown',
          };
        }).filter(p => p.id !== ''); // Filter out any where we couldn't find an ID
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
    this.logger.info(`Fetching completed reservations for property ${propertyId}...`);

    try {
      await this.navigateTo(`https://www.airbnb.com/hosting/reservations/completed`);
      
      let hasNextPage = true;
      let pageNum = 1;

      while (hasNextPage) {
        this.logger.debug(`Parsing reservations table (Page ${pageNum})...`);
        
        // Wait for the table rows to appear
        await this.page.waitForSelector('tr[data-testid="host-reservations-table-row"]', { timeout: 30000 });

        const rows = await this.page.$$('tr[data-testid="host-reservations-table-row"]');
        this.logger.debug(`Found ${rows.length} reservation rows on this page`);

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

        // Check for pagination "Next" button using SVG path to bypass language translations
        // The Next button usually has an SVG with a path like "m4.29 1.71 a 1 1 0 1 1 1.42 -1.41..."
        // In Playwright we can target robustly by looking for the last button in the pagination nav,
        // or specifically looking for a button that contains the SVG path.
        // Option A: Last button in the pagination group
        // Option B: Target by svg path structure
        // Let's use a robust structural locator: 
        // nav[aria-label="Pagination"] is usually localized, so we find the nav element, then the last button inside it.
        // A safer way without aria is to look for the svg path used by the next arrow.
        const nextButtonSelector = 'button:has(svg path[d^="m4.29 1.71 a 1 1 0 1 1 1.42 -1.41"]), button:has(svg[aria-label="Next"])';
        
        // Let's use an even broader approach combining the known class and the last button approach,
        // or a locator that evaluates the SVG icon direction.
        // A highly reliable way in Airbnb right now is checking for `button` that is the direct sibling after the active page number
        // However, `button` with that specific svg path is very distinct. Let's provide a few fallbacks in case of slight DOM changes.
        const fallbackNextSelector = 'button[aria-label="Next"], button[aria-label="Naprej"], button.c1ytbx3a';
        
        let nextBtn = await this.page.$(nextButtonSelector);
        if (!nextBtn) {
            nextBtn = await this.page.$(fallbackNextSelector);
        }
        
        if (nextBtn) {
          const isDisabled = await nextBtn.evaluate((n) => n.hasAttribute('disabled') || n.getAttribute('aria-disabled') === 'true');
          if (!isDisabled) {
            this.logger.debug('Clicking Next page for reservations...');
            await Promise.all([
              this.page.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => {}), // Ignore timeouts on AJAX paginations
              nextBtn.click()
            ]);
            pageNum++;
            await this.page.waitForTimeout(2000); // Small wait for DOM to update if AJAX
          } else {
            hasNextPage = false;
          }
        } else {
          hasNextPage = false;
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
      // Helper function to get text content safely
      const getText = (selector: string, context: Element | Document = document) => {
        const el = context.querySelector(selector);
        return el?.textContent?.trim() || '';
      };

      // Table structure reference based on browser subagent:
      // Status: td:nth-child(1) span
      // Guests: td:nth-child(2) a span
      // Contact: td:nth-child(3)
      // Check-in: td:nth-child(4)
      // Checkout: td:nth-child(5)
      // Booked: td:nth-child(6)
      // Listing: td:nth-child(7)
      // Confirmation Code: td:nth-child(8)
      // Total Payout: td:nth-child(9)

      return {
        status: getText('td:nth-child(1) span', element),
        guestName: getText('td:nth-child(2) a span, td:nth-child(2)', element),
        checkInDate: getText('td:nth-child(4)', element),
        checkOutDate: getText('td:nth-child(5)', element),
        listingName: getText('td:nth-child(7)', element),
        bookingReference: getText('td:nth-child(8)', element),
        amount: getText('td:nth-child(9)', element),
      };
    });

    // Optionally filter by checking if listingName matches propertyName roughly
    // Or we simply check all reservations and compare the listing name. 
    // Usually, the completed page shows ALL properties, so we ONLY add it if the listingName matches or includes the name
    // (Airbnb's table doesn't inherently filter by property ID unless the URL is structured that way)
    if (rowData.listingName && propertyName && !rowData.listingName.includes(propertyName)) {
      // Skip this row if it doesn't match the current property we are extracting for.
      return null;
    }

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
