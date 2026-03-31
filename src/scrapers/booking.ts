import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { BaseScraper } from './base.js';
import { Reservation, Payout, ExtractionResult, ExtractionOptions } from '../types/index.js';
import { calculateAggregates } from '../extractors/aggregates.js';
import { formatDate, parseDate } from '../utils/dates.js';

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

        // Navigate to dashboard first to establish session context
        if (!this.page) throw new Error('Page not initialized');
        const dashboardUrl = `https://admin.booking.com/hotel/hoteladmin/extranet_ng/manage/home.html?hotel_id=${hotelId}`;
        await this.page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' });
        await this.page.waitForTimeout(3000);

        if (this.page.url().includes('/sign-in') || this.page.url().includes('/login')) {
          this.logger.warn('Session lost during dashboard navigation. Attempting re-login...');
          await this.loginToBooking();
          if (!this.page) throw new Error('Page not initialized after re-login');
          await this.page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' });
        }

        const reservations = await this.getReservations(hotelId, options);
        allReservations.push(...reservations);

        // Payouts extraction skipped for now - focus on Reservations
        // const payouts = await this.getPayouts(hotelId, options);
        // allPayouts.push(...payouts);
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

    // Check for CAPTCHA/Challenge after entering username
    await this.checkForCaptcha();

    // Booking.com may show password on the same page or require a "Continue" click first
    const passwordSelector = 'input[name="password"], input[type="password"]';
    const passwordVisible = await this.page.isVisible(passwordSelector);

    if (!passwordVisible) {
      this.logger.debug('Password field not visible yet — clicking submit to reveal it...');
      await this.page.click('button[type="submit"], input[type="submit"]');
      
      // Check for CAPTCHA/Challenge after clicking "Next"
      await this.checkForCaptcha();

      try {
        await this.page.waitForSelector(passwordSelector, { timeout: 10000 });
        await this.screenshot('02-password-step');
      } catch {
        // If password selector still not found, check CAPTCHA one more time
        await this.checkForCaptcha();

        if (await this.page.isVisible(passwordSelector)) {
           // password might have appeared after CAPTCHA
        } else {
          await this.screenshot('02-no-password-field');
          await this.savePageHtml('02-after-username-submit');
          throw new Error(
            'Password field did not appear after username submit. Check debug output.'
          );
        }
      }
    }

    // Check CAPTCHA right before filling password
    await this.checkForCaptcha();

    const submitButtons = [
      'button[type="submit"]',
      'input[type="submit"]',
      'button:has-text("Sign in")',
      'button:has-text("Next")',
    ];

    let loginResolved = false;
    let attempts = 0;
    while (!loginResolved && attempts < 5) {
      attempts++;
      
      // Check/Fill password if visible
      if (await this.page.isVisible(passwordSelector)) {
        await this.page.fill(passwordSelector, this.credentials.password);
        await this.page.waitForTimeout(1000);
        
        const submitSelector = await this.firstVisibleSelector(submitButtons);
        if (submitSelector) {
          this.logger.debug(`Clicking submit button (attempt ${attempts}): ${submitSelector}`);
          await this.page.click(submitSelector);
        } else {
          await this.page.keyboard.press('Enter');
        }
        await this.page.waitForTimeout(5000);
      }

      await this.checkForCaptcha();

      const currentUrl = this.page.url();
      if (!currentUrl.includes('/login') && !currentUrl.includes('/signin') && !currentUrl.includes('/sign-in') && !currentUrl.includes('login.en-gb')) {
        loginResolved = true;
        this.logger.info('Login successful');
      } else {
        // Still on login page, might need 2FA or another attempt
        const is2FAVisible = await this.page.evaluate(() => {
          return !!(
            document.querySelector('[data-testid*="verification"]') ||
            document.querySelector('[class*="verification"]') ||
            document.body.innerText.includes('Verification method')
          );
        });
        
        if (is2FAVisible) {
           await this.handle2FA();
           loginResolved = true; // handle2FA waits for completion
        }
      }
    }

    if (!loginResolved) {
      throw new Error('Failed to resolve login after multiple attempts.');
    }

    // Save session state
    await this.browserManager.getContext().storageState({ path: 'state.json' });
    this.logger.info('Saved session state to state.json');

    await this.screenshot('05-after-login');
    await this.savePageHtml('05-after-login');
    this.logger.debug(`Post-login URL: ${this.page.url()}`);
  }

  private async handle2FA(): Promise<void> {
    if (!this.page) return;
    this.logger.info('Two-factor authentication (2FA) detected. Waiting up to 5 minutes for manual resolution...');
    
    const startTime = Date.now();
    const timeout = 300000; // 5 minutes

    while (Date.now() - startTime < timeout) {
      const currentUrl = this.page.url();
      const isStillOnSignIn = currentUrl.includes('/login') || 
                             currentUrl.includes('/signin') || 
                             currentUrl.includes('/sign-in') || 
                             currentUrl.includes('login.en-gb');

      if (!isStillOnSignIn) {
        this.logger.info(`URL changed to ${currentUrl}. 2FA likely resolved.`);
        return;
      }

      this.logger.debug(`2FA Browser Ping: URL=${currentUrl.split('?')[0]}`);
      await this.page.waitForTimeout(5000);
    }
    
    throw new Error('2FA not resolved within 5 minutes.');
  }

  private async checkForCaptcha(): Promise<void> {
    if (!this.page) return;

    const captchaSelectors = [
      '#challenge-form',
      '#captcha-container',
      'iframe[src*="challenge"]',
      'script[src*="challenge.js"]',
      'div[id*="challenge"]',
      '#px-captcha',
      '[data-testid*="captcha"]',
    ];

    const isChallengeVisible = await this.page.evaluate((selectors) => {
      const text = document.body.innerText;
      return selectors.some(s => {
               const el = document.querySelector(s);
               if (!el) return false;
               const rect = el.getBoundingClientRect();
               return rect.width > 0 && rect.height > 0;
             }) || 
             text.includes('Please solve the challenge') ||
             text.includes('Verify you are human') ||
             text.includes("Let's make sure you're human");
    }, captchaSelectors);

    if (isChallengeVisible) {
      await this.screenshot('01-login-captcha-detected');
      this.logger.warn('CAPTCHA or Security Challenge detected: "Let\'s make sure you\'re human" or similar.');
      
      if (process.env.HEADLESS === 'false') {
        this.logger.info('Waiting for manual resolution in the browser (timeout: 2m). I will check status every 5s...');
        
        const startTime = Date.now();
        let resolved = false;

        while (Date.now() - startTime < 120000) {
          const status = await this.page.evaluate((selectors) => {
            const text = document.body.innerText;
            const hasCaptcha = selectors.some(s => {
              const el = document.querySelector(s);
              if (!el) return false;
              const rect = el.getBoundingClientRect();
              return rect.width > 0 && rect.height > 0;
            });
            const hasChallengeText = text.includes('Please solve the challenge') || 
                                    text.includes('Verify you are human') ||
                                    text.includes("Let's make sure you're human");
            const hasPassword = !!document.querySelector('input[name="password"], input[type="password"]');
            const hasUsernameError = !!document.querySelector('#loginname-error') || text.includes('username and password combination you entered doesn\'t match');
            
            return {
              url: window.location.href,
              isChallenged: (hasCaptcha || hasChallengeText) && !hasPassword,
              hasPassword,
              hasUsernameError,
              textSnippet: text.substring(0, 100).replace(/\n/g, ' ')
            };
          }, captchaSelectors);

          if (status.hasPassword) {
            this.logger.info('Password field detected! Proceeding...');
            resolved = true;
            break;
          }

          if (!status.isChallenged && !status.url.includes('/sign-in')) {
            this.logger.info(`URL changed to ${status.url}. Challenge likely resolved.`);
            resolved = true;
            break;
          }

          this.logger.debug(`Browser Ping: URL=${status.url.split('?')[0]} | Challenge=${status.isChallenged} | PasswordField=${status.hasPassword}`);
          await this.page.waitForTimeout(5000);
        }

        if (!resolved) {
          this.logger.warn('Timed out waiting for resolution.');
        }
      } else {
        throw new Error('CAPTCHA detected in headless mode. Please run in headed mode to solve.');
      }
    }
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

    try {
      // Step 1: Click the Reservations nav item
      this.logger.debug('Clicking Reservations nav item...');
      const navSelectors = [
        'a[href*="search_reservations"]',
        'a.ext-navigation-top-item__link:has-text("Reservations")',
        'span.ext-navigation-top-item__title-text:has-text("Reservations")',
      ];

      let clicked = false;
      for (const sel of navSelectors) {
        try {
          await this.page.waitForSelector(sel, { timeout: 8000 });
          await this.page.click(sel);
          clicked = true;
          this.logger.debug(`Clicked Reservations nav using: ${sel}`);
          break;
        } catch { /* try next */ }
      }

      if (!clicked) {
        this.logger.warn('Could not click Reservations nav item. Saving page for inspection.');
        await this.screenshot(`reservations-nav-missing-${hotelId}`);
        await this.savePageHtml(`reservations-nav-missing-${hotelId}`);
        return [];
      }

      await this.page.waitForLoadState('domcontentloaded');
      await this.page.waitForTimeout(3000);
      this.logger.info(`Reservations page URL: ${this.page.url()}`);

      // Step 2: Fill the date-range form and click Show
      const dateFrom = options.startDate
        ? this.toPickerDate(options.startDate)
        : this.toPickerDate('2025-01-01');
      const dateTo = options.endDate
        ? this.toPickerDate(options.endDate)
        : this.toPickerDate('2025-12-31');

      this.logger.debug(`Setting date range: ${dateFrom} → ${dateTo}`);

      await this.page.waitForSelector('#date_from', { timeout: 10000 });

      // Clear and fill date_from (triple-click to select all, then type)
      await this.page.click('#date_from', { clickCount: 3 });
      await this.page.waitForTimeout(300);
      await this.page.keyboard.press('Delete');
      await this.page.waitForTimeout(300);
      await this.page.fill('#date_from', dateFrom);
      await this.page.waitForTimeout(500);

      // Clear and fill date_to
      await this.page.click('#date_to', { clickCount: 3 });
      await this.page.waitForTimeout(300);
      await this.page.keyboard.press('Delete');
      await this.page.waitForTimeout(300);
      await this.page.fill('#date_to', dateTo);
      await this.page.waitForTimeout(500);

      // Click the Show button
      await this.page.click('button:has-text("Show"), input[value="Show"], [type="submit"]:has-text("Show")');
      this.logger.info('Clicked Show — waiting up to 60s for reservations table to load...');

      // Step 3: Wait for table rows to load (up to 60s)
      const rowSelector = 'tr.bui-table__row';
      try {
        await this.page.waitForSelector(rowSelector, { timeout: 60000 });
        // Wait for loading bars to disappear (data to load)
        this.logger.debug('Waiting for table data to load (loading bars to disappear)...');
        await this.page.waitForFunction(
          () => {
            const loadingBars = document.querySelectorAll('tr.bui-table__row .loading-bar--animated');
            return loadingBars.length === 0;
          },
          { timeout: 60000 }
        );
        this.logger.debug('Table data loaded successfully');
      } catch {
        this.logger.warn('Timed out waiting for reservation rows or data to load. Saving page for inspection.');
        await this.screenshot(`reservations-timeout-${hotelId}`);
        await this.savePageHtml(`reservations-timeout-${hotelId}`);
        return [];
      }

      await this.screenshot(`reservations-${hotelId}`);
      await this.savePageHtml(`reservations-${hotelId}`);

      return await this.parseReservationRows(rowSelector, hotelId, options);
    } catch (error) {
      this.logger.warn(`Could not fetch reservations for hotel ${hotelId}: ${error}`);
      await this.screenshot(`reservations-${hotelId}-error`);
      return [];
    }
  }

  /** Convert YYYY-MM-DD to the "Month DD, YYYY" format the Booking.com datepicker expects. */
  private toPickerDate(isoDate: string): string {
    const [year, month, day] = isoDate.split('-').map(Number);
    const months = [
      'January','February','March','April','May','June',
      'July','August','September','October','November','December',
    ];
    return `${months[month - 1]} ${day}, ${year}`;
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

        const data = await row.evaluate((el) => ({
          bookingRef:
            el.querySelector('[data-heading="Booking number"] span')?.textContent?.trim() ?? '',
          guestName:
            el.querySelector('[data-heading="Guest Name"] a span')?.textContent?.trim() ?? '',
          guestCount:
            el.querySelector('[data-heading="Guest Name"] .bui-f-font-caption span')?.textContent?.trim() ?? '',
          bookingDate:
            el.querySelector('[data-heading="Booked on"] span')?.textContent?.trim() ?? '',
          checkIn:
            el.querySelector('[data-heading="Check-in"] span')?.textContent?.trim() ?? '',
          checkOut:
            el.querySelector('[data-heading="Check-out"] span')?.textContent?.trim() ?? '',
          room:
            el.querySelector('[data-heading="Rooms"]')?.textContent?.trim() ?? '',
          status:
            el.querySelector('[data-heading="Status"] .reservation-status__main span')?.textContent?.trim() ?? '',
          price:
            el.querySelector('[data-heading="Price"] span')?.textContent?.trim() ?? '',
          commission:
            el.querySelector('[data-heading="Commission and charges"] span')?.textContent?.trim() ?? '',
        }));

        if (!data.checkIn && !data.bookingRef) continue;
        if (!this.filterDateRange(data.checkIn, options.startDate, options.endDate)) continue;

        const nights = this.calculateNights(data.checkIn, data.checkOut);
        const grossAmount = this.parseAmount(data.price);
        const guestCountNum = parseInt(data.guestCount.replace(/\D/g, '')) || 1;
        const hostFees = this.parseAmount(data.commission);

        const reservation: Reservation = {
          propertyId: hotelId,
          propertyName: `Booking.com Hotel ${hotelId}`,
          bookingDate: data.bookingDate || new Date().toISOString().split('T')[0],
          checkInDate: data.checkIn,
          checkOutDate: data.checkOut,
          nights,
          guestCount: guestCountNum,
          guestName: data.guestName,
          bookingReference: data.bookingRef,
          grossAmount,
          currency: 'EUR',
          guestServiceFee: 0,
          hostServiceFee: hostFees,
          nightlyRateAdjustment: 0,
          hostFees: hostFees,
          platformFees: 0,
          propertyUseTaxes: 0,
          cleaningFees: 0,
          touristTax: 0,
          otherTaxes: 0,
          netAmount: grossAmount - hostFees,
          status: data.status,
        };

        reservations.push(reservation);

        if (options.onReservationProcessed) {
          await options.onReservationProcessed(reservation, reservations);
        }
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

    try {
      // Click the Finance nav item
      this.logger.debug('Clicking Finance nav item...');
      const navSelectors = [
        'a[href*="financial_overview"]',
        'a.ext-navigation-top-item__link:has-text("Finance")',
        'span.ext-navigation-top-item__title-text:has-text("Finance")',
      ];

      let clicked = false;
      for (const sel of navSelectors) {
        try {
          await this.page.waitForSelector(sel, { timeout: 8000 });
          await this.page.click(sel);
          clicked = true;
          this.logger.debug(`Clicked Finance nav using: ${sel}`);
          break;
        } catch { /* try next */ }
      }

      if (!clicked) {
        this.logger.warn('Could not click Finance nav item. Skipping payouts.');
        return [];
      }

      await this.page.waitForLoadState('domcontentloaded');
      await this.page.waitForTimeout(3000);
      this.logger.info(`Payouts page URL: ${this.page.url()}`);

      await this.screenshot(`payouts-${hotelId}`);
      await this.savePageHtml(`payouts-${hotelId}`);

      // Look for invoice/payout table rows
      const rowSelector = 'tr.bui-table__row';
      const hasRows = await this.page.locator(rowSelector).count();
      if (hasRows === 0) {
        this.logger.warn(
          `No payout rows found. Inspect payouts-${hotelId}.html in ${this.debugDir} to find the correct selector.`
        );
        return [];
      }

      this.logger.debug(`Found ${hasRows} payout rows`);
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

        const data = await row.evaluate((el) => ({
          date:
            el.querySelector('[class*="date"],[data-testid="invoice-date"],.date,.invoice_date')?.textContent?.trim() ?? '',
          amount:
            el.querySelector('[class*="amount"],[class*="price"],[class*="total"],[data-testid="total-amount"],.amount,.total')?.textContent?.trim() ?? '',
          reference:
            el.querySelector('[class*="id"],[class*="ref"],[class*="invoice"],[data-testid="invoice-id"],.id,.ref,.invoice_number')?.textContent?.trim() ?? '',
          status:
            el.querySelector('[class*="status"],[data-testid="invoice-status"],.status,.invoice_status')?.textContent?.trim() ?? '',
        }));

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
      if (!checkIn || !checkOut) return 0;
      const start = parseDate(checkIn);
      const end = parseDate(checkOut);
      const diff = end.getTime() - start.getTime();
      // Ensure we get at least 1 night for valid stays, even if check-in/out are the same (rare)
      return Math.max(1, Math.round(diff / (1000 * 60 * 60 * 24)));
    } catch {
      return 0;
    }
  }

  private parseAmount(amountStr: string): number {
    if (!amountStr) return 0;
    
    // Strip currency symbols and other non-numeric chars except digits, comma, dot, and minus
    const cleaned = amountStr.replace(/[^\d.,-]/g, '').trim();
    if (!cleaned) return 0;

    // Determine if it's European (1.234,56) or US/UK (1,234.56) format
    // We look at the last separator
    const lastComma = cleaned.lastIndexOf(',');
    const lastDot = cleaned.lastIndexOf('.');

    let normalised = cleaned;
    if (lastComma > lastDot) {
      // European format: comma is decimal separator
      normalised = cleaned.replace(/\./g, '').replace(',', '.');
    } else if (lastDot > lastComma) {
      // US/UK format: dot is decimal separator
      normalised = cleaned.replace(/,/g, '');
    } else {
      // No separators or only one type
      normalised = cleaned.replace(',', '.');
    }

    return parseFloat(normalised) || 0;
  }
}
