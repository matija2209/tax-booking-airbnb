import { BaseScraper } from './base.js';
import { Reservation, Payout, ExtractionResult, ExtractionOptions } from '../types/index.js';
import { calculateAggregates } from '../extractors/aggregates.js';
import { formatDate } from '../utils/dates.js';
import { existsSync } from 'fs';

export class AirbnbScraper extends BaseScraper {
  private normalizeInlineText(value: string | null | undefined): string {
    return (value || '')
      .replace(/\u00a0|\u202f/g, ' ')
      .replace(/([A-Za-z)])(CDA#\d+)/g, '$1 $2')
      .replace(/\s+/g, ' ')
      .trim();
  }

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

      const reservations = await this.getReservations(propertiesToScrape, options);
      allReservations.push(...reservations);

      this.logger.info(
        'Skipping Airbnb payouts page extraction. Host payout data is captured from each reservation details modal.'
      );

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
      await this.page.waitForTimeout(5000);

      if (process.env.DEVTOOLS === 'true') {
        this.logger.info('DEVTOOLS=true detected. Pausing on properties page to allow manual 2FA completion and CSS selector inspection...');
        await this.page.pause();
        this.logger.info('Resumed from Inspector. Continuing with property extraction...');
      }

      // Wait for property listings to load, then retry once if the table hydrates slowly.
      try {
        await this.page.waitForSelector('tr.tfgampn', { timeout: 30000 });
      } catch {
        this.logger.warn('Listings table did not appear on first wait. Retrying after an extra delay...');
        await this.page.waitForTimeout(5000);
        await this.page.waitForSelector('tr.tfgampn', { timeout: 30000 });
      }

      const properties = await this.page.evaluate(() => {
        const normalize = (value: string | null | undefined) =>
          (value || '')
            .replace(/\u00a0|\u202f/g, ' ')
            .replace(/([A-Za-z)])(CDA#\d+)/g, '$1 $2')
            .replace(/\s+/g, ' ')
            .trim();

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
            name: normalize(nameEl?.textContent) || 'Unknown',
          };
        }).filter(p => p.id !== ''); // Filter out any where we couldn't find an ID
      });

      if (properties.length === 0) {
        this.logger.warn('Listings page loaded but no property rows were parsed. Waiting once more before giving up...');
        await this.page.waitForTimeout(5000);

        const retryProperties = await this.page.evaluate(() => {
          const normalize = (value: string | null | undefined) =>
            (value || '')
              .replace(/\u00a0|\u202f/g, ' ')
              .replace(/([A-Za-z)])(CDA#\d+)/g, '$1 $2')
              .replace(/\s+/g, ' ')
              .trim();

          const cards = document.querySelectorAll('tr.tfgampn');
          return Array.from(cards).map((card) => {
            const nameEl = card.querySelector('div.t1ojp9a2');
            const checkboxEl = card.querySelector('input[id^="checkbox-"]');
            let id = '';
            if (checkboxEl) {
              const idMatch = checkboxEl.id.match(/checkbox-(\d+)/);
              if (idMatch && idMatch[1]) {
                id = idMatch[1];
              }
            }

            return {
              id,
              name: normalize(nameEl?.textContent) || 'Unknown',
            };
          }).filter(p => p.id !== '');
        });

        return retryProperties;
      }

      return properties;
    } catch (error) {
      this.logger.warn('Could not automatically fetch properties, will proceed with manual entry if needed');
      return [];
    }
  }

  private async getReservations(
    properties: Array<{ id: string; name: string }>,
    options: ExtractionOptions
  ): Promise<Reservation[]> {
    if (!this.page) {
      throw new Error('Page not initialized');
    }

    const reservations: Reservation[] = [];
    const processedReservationCodes = new Set<string>();
    this.logger.info('Fetching completed reservations across all selected properties...');

    try {
      await this.navigateTo(`https://www.airbnb.com/hosting/reservations/completed`);
      await this.page.waitForTimeout(3000);
      
      let hasNextPage = true;
      let pageNum = 1;

      while (hasNextPage) {
        this.logger.debug(`Parsing reservations table (Page ${pageNum})...`);
        
        // Wait for the table rows to appear
        await this.page.waitForSelector('tr[data-testid="host-reservations-table-row"]', { timeout: 30000 });

        const pageRows = await this.getReservationTableRows();
        this.logger.debug(`Found ${pageRows.length} reservation rows on this page`);

        for (const rowData of pageRows) {
          try {
            const reservation = await this.parseReservationRow(
              rowData,
              properties,
              options,
              processedReservationCodes
            );
            if (reservation) {
              reservations.push(reservation);
              if (options.onReservationProcessed) {
                await options.onReservationProcessed(reservation, [...reservations]);
              }
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
      this.logger.warn(`Could not fetch reservations: ${error}`);
    }

    return reservations;
  }

  private async getReservationTableRows(): Promise<Array<{
    status: string;
    guestSummary: string;
    checkInDate: string;
    checkOutDate: string;
    bookedAt: string;
    listingName: string;
    bookingReference: string;
    amount: string;
  }>> {
    if (!this.page) {
      throw new Error('Page not initialized');
    }

    return await this.page.evaluate(() => {
      const getSeparatedText = (element: Element | null): string => {
        if (!element) {
          return '';
        }

        if (element instanceof HTMLElement) {
          const ariaText = element.getAttribute('aria-label');
          if (ariaText) {
            return ariaText;
          }
        }

        const textParts: string[] = [];

        const collectLeafText = (node: Node) => {
          if (node.nodeType === Node.TEXT_NODE) {
            const value = node.textContent?.trim();
            if (value) {
              textParts.push(value);
            }
            return;
          }

          if (node.nodeType !== Node.ELEMENT_NODE) {
            return;
          }

          const elementNode = node as Element;
          const children = Array.from(elementNode.childNodes);
          if (children.length === 0) {
            const value = elementNode.textContent?.trim();
            if (value) {
              textParts.push(value);
            }
            return;
          }

          children.forEach(collectLeafText);
        };

        collectLeafText(element);

        if (textParts.length > 0) {
          return textParts.join(', ');
        }

        return element.textContent || '';
      };

      const normalizeCellText = (element: Element | null) =>
        getSeparatedText(element)
          .replace(/\u00a0|\u202f/g, ' ')
          .replace(/\s+/g, ' ')
          .replace(/\s*,\s*/g, ', ')
          .trim();

      const rows = document.querySelectorAll('tr[data-testid="host-reservations-table-row"]');
      return Array.from(rows).map((row) => {
        const statusCell = row.querySelector('td:nth-child(1)');
        const guestCell = row.querySelector('td:nth-child(2)');
        const checkInCell = row.querySelector('td:nth-child(4)');
        const checkOutCell = row.querySelector('td:nth-child(5)');
        const bookedAtCell = row.querySelector('td:nth-child(6)');
        const listingCell = row.querySelector('td:nth-child(7)');
        const bookingReferenceCell = row.querySelector('td:nth-child(8)');
        const amountCell = row.querySelector('td:nth-child(9)');

        return {
          status: normalizeCellText(statusCell),
          guestSummary: normalizeCellText(guestCell),
          checkInDate: normalizeCellText(checkInCell),
          checkOutDate: normalizeCellText(checkOutCell),
          bookedAt: normalizeCellText(bookedAtCell),
          listingName: normalizeCellText(listingCell),
          bookingReference: normalizeCellText(bookingReferenceCell),
          amount: normalizeCellText(amountCell),
        };
      });
    });
  }

  private async parseReservationRow(
    rowData: {
      status: string;
      guestSummary: string;
      checkInDate: string;
      checkOutDate: string;
      bookedAt: string;
      listingName: string;
      bookingReference: string;
      amount: string;
    },
    properties: Array<{ id: string; name: string }>,
    options: ExtractionOptions,
    processedReservationCodes: Set<string>
  ): Promise<Reservation | null> {
    if (!this.page) {
      throw new Error('Page not initialized');
    }

    if (!rowData.bookingReference) {
      return null;
    }

    if (processedReservationCodes.has(rowData.bookingReference)) {
      this.logger.debug(`Skipping already processed reservation ${rowData.bookingReference}.`);
      return null;
    }

    // Optionally filter by checking if listingName matches propertyName roughly
    // Or we simply check all reservations and compare the listing name. 
    // Usually, the completed page shows ALL properties, so we ONLY add it if the listingName matches or includes the name
    // (Airbnb's table doesn't inherently filter by property ID unless the URL is structured that way)
    const matchedProperty = properties.find((property) =>
      this.propertyNamesMatch(rowData.listingName, property.name)
    );

    if (!matchedProperty) {
      return null;
    }

    // Filter by date range
    if (!this.filterDateRange(rowData.checkInDate, options.startDate, options.endDate)) {
      return null;
    }

    const row = this.page
      .locator('tr[data-testid="host-reservations-table-row"]')
      .filter({ hasText: rowData.bookingReference })
      .first();
    const detailsButton = row.locator('td button').first();
    this.logger.debug(`Opening reservation details for ${rowData.bookingReference}...`);
    await row.scrollIntoViewIfNeeded();
    await this.page.waitForTimeout(300);
    await detailsButton.click();

    const detailData = await this.parseReservationDetailsModal();
    await this.closeReservationDetailsModal();
    this.logger.debug(`Closed reservation details for ${rowData.bookingReference}.`);
    processedReservationCodes.add(rowData.bookingReference);

    // Parse the row data into a Reservation object
    const nights = this.calculateNights(rowData.checkInDate, rowData.checkOutDate);
    const fallbackGrossAmount = this.parseAmount(rowData.amount);
    const guestCount = detailData.guestCount || this.parseGuestCount(rowData.guestSummary);
    const guestName = this.parseGuestName(rowData.guestSummary);
    const bookingDate = this.parseBookedDate(rowData.bookedAt);
    const grossAmount = detailData.grossAmount || fallbackGrossAmount;
    const currency = detailData.currency || this.extractCurrencyCode(rowData.amount) || 'EUR';

    const reservation: Reservation = {
      propertyId: matchedProperty.id,
      propertyName: matchedProperty.name,
      bookingDate,
      checkInDate: rowData.checkInDate,
      checkOutDate: rowData.checkOutDate,
      nights,
      guestCount,
      guestName,
      bookingReference: rowData.bookingReference,
      grossAmount,
      currency,
      guestServiceFee: detailData.guestServiceFee,
      hostServiceFee: detailData.hostServiceFee,
      nightlyRateAdjustment: detailData.nightlyRateAdjustment,
      hostFees: detailData.hostFees,
      platformFees: detailData.guestServiceFee,
      propertyUseTaxes: detailData.propertyUseTaxes,
      cleaningFees: detailData.cleaningFee,
      touristTax: 0,
      otherTaxes: detailData.otherTaxes,
      netAmount: detailData.netAmount || fallbackGrossAmount,
      status: rowData.status,
      notes: detailData.notes,
    };

    return reservation;
  }

  private async parseReservationDetailsModal(): Promise<{
    guestCount: number;
    grossAmount: number;
    currency: string;
    guestServiceFee: number;
    hostServiceFee: number;
    nightlyRateAdjustment: number;
    hostFees: number;
    propertyUseTaxes: number;
    cleaningFee: number;
    otherTaxes: number;
    netAmount: number;
    notes?: string;
  }> {
    if (!this.page) {
      throw new Error('Page not initialized');
    }

    const dialog = this.page.locator('[role="dialog"]').last();
    await dialog.waitFor({ state: 'visible', timeout: 10000 });
    await this.page.waitForTimeout(3000);
    await this.scrollReservationDetails(dialog);

    const modalData = await dialog.evaluate((element: Element) => {
      const normalize = (value: string | null | undefined) =>
        (value || '').replace(/\u00a0|\u202f/g, ' ').replace(/\s+/g, ' ').trim();

      const sections = Array.from(
        element.querySelectorAll('section[data-testid="hrd-sbui-payment-details-section"]')
      ).map((section) => {
        const title = normalize(
          section.querySelector('h2 div, h2')?.textContent || section.querySelector('h2')?.textContent
        );
        const rows = Array.from(section.querySelectorAll('.h11gwptq')).map((row) => ({
          label: normalize(row.querySelector('.dayvjea')?.textContent),
          amount: normalize(row.querySelector('.fqvptfs')?.textContent),
        }));

        return {
          title,
          rows: rows.filter((row) => row.label || row.amount),
        };
      });

      return {
        modalText: normalize(element.textContent),
        sections,
      };
    });

    const guestPaidSection = modalData.sections.find((section) => section.title === 'Guest paid');
    const hostPayoutSection = modalData.sections.find((section) => section.title === 'Host payout');

    const grossAmount = this.extractSectionTotal(guestPaidSection?.rows || []);
    const guestServiceFee = this.extractSectionAmount(guestPaidSection?.rows || [], 'Guest service fee');
    const netAmount = this.extractSectionTotal(hostPayoutSection?.rows || []);
    const hostServiceFee = Math.abs(
      this.extractSectionAmount(hostPayoutSection?.rows || [], 'Host service fee')
    );
    const nightlyRateAdjustment = this.extractSectionAmount(
      hostPayoutSection?.rows || [],
      'Nightly rate adjustment'
    );
    const propertyUseTaxes = this.extractSectionAmount(hostPayoutSection?.rows || [], 'Property use taxes');
    const cleaningFee = this.extractSectionAmount(hostPayoutSection?.rows || [], 'Cleaning fee');
    const currency =
      this.extractCurrencyCodeFromRows(hostPayoutSection?.rows || []) ||
      this.extractCurrencyCodeFromRows(guestPaidSection?.rows || []) ||
      'EUR';

    return {
      guestCount: this.parseGuestCount(modalData.modalText),
      grossAmount,
      currency,
      guestServiceFee,
      hostServiceFee,
      nightlyRateAdjustment,
      hostFees: hostServiceFee,
      propertyUseTaxes,
      cleaningFee,
      otherTaxes: propertyUseTaxes,
      netAmount,
      notes: this.formatSectionNotes(hostPayoutSection?.rows || []),
    };
  }

  private async scrollReservationDetails(dialog: any): Promise<void> {
    for (let i = 0; i < 5; i++) {
      await dialog.evaluate((element: Element) => {
        element.scrollTop = element.scrollHeight;
      });
      await this.page?.waitForTimeout(150);
    }
  }

  private async closeReservationDetailsModal(): Promise<void> {
    if (!this.page) {
      throw new Error('Page not initialized');
    }

    const dialog = this.page.locator('[role="dialog"]').last();
    const closeButton = dialog.locator('button[aria-label="Close"], button').filter({ hasText: 'Close' }).first();

    if (await closeButton.count()) {
      await closeButton.click();
    } else {
      await this.page.keyboard.press('Escape');
    }

    await dialog.waitFor({ state: 'hidden', timeout: 10000 });
    await this.page.waitForTimeout(500);
  }

  private extractSectionTotal(rows: Array<{ label: string; amount: string }>): number {
    const totalRow = rows.find((row) => /^Total\s+\([A-Z]{3}\)$/i.test(row.label));
    return totalRow ? this.parseAmount(totalRow.amount) : 0;
  }

  private extractSectionAmount(rows: Array<{ label: string; amount: string }>, label: string): number {
    const normalizedTarget = this.normalizeSectionLabel(label);
    const row = rows.find((entry) => this.normalizeSectionLabel(entry.label).startsWith(normalizedTarget));
    return row ? this.parseAmount(row.amount) : 0;
  }

  private normalizeSectionLabel(label: string): string {
    return label
      .toLowerCase()
      .replace(/\([^)]*\)/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private extractCurrencyCodeFromRows(rows: Array<{ label: string; amount: string }>): string {
    for (const row of rows) {
      const codeMatch = row.label.match(/\(([A-Z]{3})\)/);
      if (codeMatch?.[1]) {
        return codeMatch[1];
      }
      const amountCurrency = this.extractCurrencyCode(row.amount);
      if (amountCurrency) {
        return amountCurrency;
      }
    }
    return '';
  }

  private formatSectionNotes(rows: Array<{ label: string; amount: string }>): string | undefined {
    const notes = rows
      .filter((row) => row.label && row.amount)
      .map((row) => `${row.label}: ${row.amount}`)
      .join(', ');
    return notes || undefined;
  }

  private parseGuestCount(text: string): number {
    const matches = [...text.matchAll(/(\d+)\s+(adults?|children?|infants?|guests?)/gi)];
    return matches.reduce((sum, match) => sum + parseInt(match[1] || '0', 10), 0);
  }

  private parseGuestName(summary: string): string {
    return summary
      .replace(/\s+\d+\s+(adult|adults|child|children|infant|infants|guest|guests).*$/i, '')
      .replace(/[,\s]+$/g, '')
      .trim();
  }

  private parseBookedDate(text: string): string {
    const match = text.match(/[A-Z][a-z]{2}\s+\d{1,2},\s+\d{4}/);
    return match ? match[0] : text;
  }

  private extractCurrencyCode(text: string): string {
    const codeMatch = text.match(/\(([A-Z]{3})\)/);
    if (codeMatch?.[1]) {
      return codeMatch[1];
    }
    if (text.includes('€')) return 'EUR';
    if (text.includes('$')) return 'USD';
    if (text.includes('£')) return 'GBP';
    return '';
  }

  private propertyNamesMatch(listingName: string, propertyName: string): boolean {
    const normalize = (value: string) =>
      value
        .replace(/CDA#\d+/gi, '')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();

    const listing = normalize(listingName);
    const property = normalize(propertyName);

    return listing.includes(property) || property.includes(listing);
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
    const normalized = amountStr.replace(/\u2212/g, '-').replace(/\s+/g, '');
    const match = normalized.match(/-?[€$£]?([\d,]+\.?\d*)/);
    if (match) {
      const value = parseFloat(match[1].replace(/,/g, ''));
      return normalized.includes('-') ? -value : value;
    }
    return 0;
  }
}
