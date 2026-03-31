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

    // Check if already logged in (session state loaded successfully)
    const isAlreadyLoggedIn = await this.page.evaluate(() => {
      const url = window.location.href;
      const isOnLoginPage = url.includes('/login') ||
                           url.includes('/signin') ||
                           url.includes('/sign-in') ||
                           url.includes('login.en-gb');
      const hasLoginForm = !!document.querySelector('input[name="loginname"], input[name="username"], input[type="email"]');
      return !isOnLoginPage && !hasLoginForm;
    });

    if (isAlreadyLoggedIn) {
      this.logger.info('Already logged in (session state restored from state.json)');
      return;
    }

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
      // Step 1: Navigate to Finance > Reservations statement
      this.logger.debug('Opening Finance nav menu...');

      // Click the Finance nav item to open submenu
      const financeNavSelector = '[data-nav-tag="finance"] button.ext-navigation-top-item__link';
      try {
        await this.page.waitForSelector(financeNavSelector, { timeout: 8000 });
        await this.page.click(financeNavSelector);
        await this.page.waitForTimeout(500);
        this.logger.debug('Finance nav menu opened');
      } catch {
        this.logger.warn('Could not open Finance nav menu. Saving page for inspection.');
        await this.screenshot(`finance-nav-missing-${hotelId}`);
        await this.savePageHtml(`finance-nav-missing-${hotelId}`);
        return [];
      }

      // Click on Reservations statement submenu item
      this.logger.debug('Clicking Reservations statement submenu item...');
      const reservationsStatementSelectors = [
        'a:has-text("Reservations statement")',
        '[data-nav-tag="finance_reservations"] a',
        'span:has-text("Reservations statement")',
      ];

      let statementClicked = false;
      for (const sel of reservationsStatementSelectors) {
        try {
          await this.page.waitForSelector(sel, { timeout: 3000 });
          if (await this.page.isVisible(sel)) {
            await this.page.click(sel);
            statementClicked = true;
            this.logger.debug(`Clicked Reservations statement using: ${sel}`);
            break;
          }
        } catch { /* try next */ }
      }

      if (!statementClicked) {
        this.logger.warn('Could not click Reservations statement submenu. Saving page for inspection.');
        await this.screenshot(`reservations-statement-missing-${hotelId}`);
        await this.savePageHtml(`reservations-statement-missing-${hotelId}`);
        return [];
      }

      await this.page.waitForLoadState('domcontentloaded');
      await this.page.waitForTimeout(3000);
      this.logger.info(`Reservations page URL: ${this.page.url()}`);

      // Step 2: Select period from the period selector dropdown
      this.logger.debug('Selecting period from period selector...');

      try {
        // Find the period selector (select.document-selector)
        const periodSelector = 'select.document-selector';
        await this.page.waitForSelector(periodSelector, { timeout: 10000 });

        // Determine target year
        const targetDate = options.startDate || '2025-01-01';
        const targetYear = targetDate.split('-')[0];

        // Get all available options from the select
        const availableOptions = await this.page.evaluate(() => {
          const select = document.querySelector('select.document-selector');
          if (!select) return [];
          const options: string[] = [];
          select.querySelectorAll('option[value]').forEach((opt) => {
            const val = opt.getAttribute('value');
            if (val) options.push(val);
          });
          return options;
        });

        this.logger.debug(`Available periods: ${availableOptions.join(', ')}`);

        // Filter for all periods in targetYear
        const periodsToScrape = availableOptions.filter((p) => p.startsWith(`${targetYear}-`));
        if (periodsToScrape.length === 0) {
          throw new Error(`No periods available in selector for year ${targetYear}`);
        }

        const allReservations: Reservation[] = [];
        const rowSelector = 'table tbody tr';  // Use more robust table row selector

        for (const period of periodsToScrape) {
          this.logger.info(`Processing period: ${period}...`);
          try {
            await this.page.evaluate((val) => {
              const s = document.querySelector('select.document-selector') as HTMLSelectElement;
              if (s) {
                s.value = val;
                s.dispatchEvent(new Event('change', { bubbles: true }));
              }
            }, period);
            
            // Wait for the page data to update (it should auto-load)
            await this.page.waitForTimeout(3000);
            
            try {
              await this.page.waitForSelector(rowSelector, { timeout: 15000 });
              // Wait a bit for data to fully render
              await this.page.waitForTimeout(2000);
            } catch {
              this.logger.warn(`Timed out waiting for reservation rows to load for ${period}. Continuing...`);
              continue; // Move to the next period instead of aborting
            }

            const periodReservations = await this.parseReservationRows(rowSelector, hotelId, options, allReservations);
            this.logger.info(`Extracted ${periodReservations.length} new reservations from ${period}`);
          } catch (err) {
            this.logger.warn(`Failed to process period ${period}: ${err}`);
          }
        }

        await this.screenshot(`reservations-${hotelId}-complete`);
        await this.savePageHtml(`reservations-${hotelId}-complete`);

        await this.extractReservationDetails(allReservations, options);

        return allReservations;
      } catch (error) {
        this.logger.warn(`Failed to initialize period loop for hotel ${hotelId}: ${error}`);
        return [];
      }
    } catch (error) {
      this.logger.warn(`Could not fetch reservations for hotel ${hotelId}: ${error}`);
      await this.screenshot(`reservations-${hotelId}-error`);
      return [];
    }
  }

  private async parseReservationRows(
    selector: string,
    hotelId: string,
    options: ExtractionOptions,
    accumulatedReservations?: Reservation[]
  ): Promise<Reservation[]> {
    if (!this.page) return [];

    const rows = this.page.locator(selector);
    const count = await rows.count();
    this.logger.info(`Parsing ${count} reservation rows`);

    const reservations: Reservation[] = [];

    for (let i = 0; i < count; i++) {
      try {
        const row = rows.nth(i);

        // Parse Finance Reservations page table structure
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const data: any = await row.evaluate((el: any) => {
          const tds = el.querySelectorAll('td');
          const texts = [];
          for (let j = 0; j < 10; j++) {
            const td = tds[j];
            texts[j] = td && td.textContent ? td.textContent.trim().replace(/\s+/g, ' ') : '';
          }

          const aTag = tds[0] ? tds[0].querySelector('a') : null;
          return {
            bookingRef: aTag && aTag.textContent ? aTag.textContent.trim() : texts[0],
            reservationUrl: aTag ? aTag.href : undefined,
            guestName: texts[1],
            checkIn: texts[2],
            checkOut: texts[3],
            result: texts[4],
            grossAmount: texts[5],
            hostFees: texts[6],
            isDisputed: tds[7] ? !!tds[7].querySelector('input[type="checkbox"]:checked') : false,
            nights: '',
            guestCount: '',
          };
        });

        if (!data.checkIn && !data.bookingRef) continue;
        if (!this.filterDateRange(data.checkIn, options.startDate, options.endDate)) continue;

        const nights = parseInt(data.nights.replace(/\D/g, '')) || 0;
        const grossAmount = this.parseAmount(data.grossAmount);
        const guestCountNum = parseInt(data.guestCount.replace(/\D/g, '')) || 1;
        const hostFees = this.parseAmount(data.hostFees);

        const reservation: Reservation = {
          propertyId: hotelId,
          propertyName: `Booking.com Hotel ${hotelId}`,
          bookingDate: new Date().toISOString().split('T')[0],
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
          status: data.result || 'Stayed',
          reservationUrl: data.reservationUrl,
          result: data.result,
          isDisputed: data.isDisputed,
        };

        reservations.push(reservation);
        if (accumulatedReservations) {
          accumulatedReservations.push(reservation);
        }

        if (options.onReservationProcessed) {
          await options.onReservationProcessed(reservation, accumulatedReservations || reservations);
        }
      } catch (error) {
        this.logger.warn(`Failed to parse reservation row ${i}: ${error}`);
      }
    }

    return reservations;
  }

  private async extractReservationDetails(reservations: Reservation[], options: ExtractionOptions): Promise<void> {
    if (!this.page) return;

    this.logger.info(`Extracting detailed information for ${reservations.length} reservations...`);

    for (let i = 0; i < reservations.length; i++) {
      const res = reservations[i];
      if (!res.reservationUrl) continue;

      try {
        this.logger.debug(`Navigating to reservation details: ${res.reservationUrl}`);
        await this.page.goto(res.reservationUrl, { waitUntil: 'domcontentloaded' });
        await this.page.waitForTimeout(3000); // Wait for potential dynamic data

        // Intercept login/2FA redirect and wait
        const currentUrl = this.page.url();
        if (currentUrl.includes('/login') || currentUrl.includes('/signin') || currentUrl.includes('verification')) {
          this.logger.warn('Hit login/2FA intercept on reservation detail page. Waiting up to 5 mins for manual resolution...');
          const startTime = Date.now();
          while (Date.now() - startTime < 300000) {
            if (!this.page.url().includes('login') && !this.page.url().includes('signin') && !this.page.url().includes('verification')) {
               break;
            }
            await this.page.waitForTimeout(5000);
          }
          // After 2FA, it usually redirects automatically. Let's just go to the URL again to be safe
          await this.page.goto(res.reservationUrl, { waitUntil: 'domcontentloaded' });
          await this.page.waitForTimeout(3000);
        }

        const guestName = await this.page.textContent('[data-test-id="reservation-overview-name"]').catch(() => null);
        if (guestName) res.detailedGuestName = guestName.trim();

        const bookingNumber = await this.page.textContent('p.res-content__label:has-text("Booking number:") + p.res-content__info').catch(() => null);
        if (bookingNumber) res.detailedBookingReference = bookingNumber.trim();

        const totalPriceText = await this.page.textContent('p.res-content__label:has-text("Total price") + p.res-content__info').catch(() => null);
        if (totalPriceText) {
          res.detailedGrossAmount = this.parseAmount(totalPriceText);
        }

        const commissionText = await this.page.textContent('p.res-content__label:has-text("Commission and charges:") + p.res-content__info').catch(() => null);
        if (commissionText) {
          res.detailedHostFees = this.parseAmount(commissionText);
        }

        const receivedText = await this.page.textContent('p.res-content__label:has-text("Received") + p.res-content__info').catch(() => null);
        if (receivedText) {
          // Parse date (e.g. "Sunday, April 13, 2025" or "Sun, Apr 13, 2025")
          try {
            const dateObj = new Date(receivedText.replace(/^[a-zA-Z]+,\s*/, ''));
            if (!isNaN(dateObj.getTime())) {
              res.detailedBookingDate = dateObj.toISOString().split('T')[0];
            }
          } catch (e) {}
        }
      } catch (error) {
        this.logger.warn(`Failed to extract details for ${res.bookingReference || 'unknown'}: ${error}`);
      }

      if (options.onReservationProcessed) {
        await options.onReservationProcessed(res, reservations);
      }
      this.logger.info(`[${i + 1}/${reservations.length}] Extracted details for ${res.bookingReference || 'unknown'} and saved/updated to CSV`);
    }
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

  // ---------------------------------------------------------------------------
  // Calendar Widget Interaction
  // ---------------------------------------------------------------------------

  /**
   * Select a date via the interactive calendar widget.
   * 1. Click the date input to open calendar popover
   * 2. Navigate to target month if needed
   * 3. Click the date number in the calendar
   * 4. Wait for calendar to close
   */
  private async selectDateViaCalendar(inputSelector: string, targetDate: string): Promise<void> {
    if (!this.page) throw new Error('Page not initialized');

    const [year, month, day] = targetDate.split('-').map(Number);

    this.logger.debug(`Opening calendar for ${inputSelector} to select ${targetDate}`);

    // Click the date input to open calendar
    await this.page.click(inputSelector);
    await this.page.waitForTimeout(500);

    // Wait for calendar popover to appear
    try {
      await this.page.waitForSelector('.bui-calendar__content', { timeout: 5000 });
      this.logger.debug('Calendar popover opened');
    } catch {
      throw new Error(`Calendar popover failed to open for ${inputSelector}`);
    }

    // Navigate to target month if needed
    const isTargetMonth = await this.isCalendarMonth(year, month);
    if (!isTargetMonth) {
      this.logger.debug(`Calendar not showing target month ${year}-${month}. Navigating...`);
      await this.navigateCalendarToMonth(year, month);
    }

    // Click the day in the calendar
    this.logger.debug(`Clicking day ${day} in calendar`);
    const dayElement = await this.page.evaluate((dayNum) => {
      const cells = document.querySelectorAll('.bui-calendar__date:not(.bui-calendar__date--empty)');
      const cell = Array.from(cells).find((c) => c.textContent?.trim() === String(dayNum));
      if (!cell) return null;
      const rect = cell.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }, day);

    if (!dayElement) {
      throw new Error(`Could not find day ${day} in calendar for ${targetDate}`);
    }

    await this.page.mouse.click(dayElement.x, dayElement.y);
    await this.page.waitForTimeout(300);

    // Wait for calendar to close
    try {
      await this.page.waitForSelector('.bui-calendar__content', { state: 'hidden', timeout: 3000 });
      this.logger.debug(`Calendar closed after selecting ${targetDate}`);
    } catch {
      this.logger.warn(`Calendar did not close after selecting ${targetDate}. Proceeding anyway.`);
    }
  }

  /**
   * Navigate the calendar to a target year/month using prev/next buttons.
   * Evaluates current month and clicks buttons until target is visible.
   */
  private async navigateCalendarToMonth(targetYear: number, targetMonth: number): Promise<void> {
    if (!this.page) throw new Error('Page not initialized');

    const maxAttempts = 24; // Max 24 months to navigate
    let attempts = 0;

    while (attempts < maxAttempts) {
      attempts++;

      const isTarget = await this.isCalendarMonth(targetYear, targetMonth);
      if (isTarget) {
        this.logger.debug(`Reached target month ${targetYear}-${String(targetMonth).padStart(2, '0')}`);
        return;
      }

      // Determine if we need to go forward or backward
      const currentMonth = await this.page.evaluate(() => {
        const header = document.querySelector('.bui-calendar__month');
        if (!header) return null;
        const text = header.textContent || '';
        const monthMatch = text.match(/(\w+)\s+(\d{4})/);
        if (!monthMatch) return null;
        const months: Record<string, number> = {
          january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
          july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
        };
        const monthNum = months[monthMatch[1].toLowerCase()] || 0;
        const yearNum = parseInt(monthMatch[2]) || 0;
        return { year: yearNum, month: monthNum };
      });

      if (!currentMonth) {
        throw new Error('Could not extract current month from calendar');
      }

      // Determine navigation direction
      let goForward = false;
      if (currentMonth.year < targetYear) {
        goForward = true;
      } else if (currentMonth.year === targetYear && currentMonth.month < targetMonth) {
        goForward = true;
      }

      // Click appropriate button
      const buttonSelector = goForward ? '[data-test-id="next-btn"]' : '[data-test-id="prev-btn"]';

      try {
        await this.page.click(buttonSelector);
        await this.page.waitForTimeout(300);
      } catch {
        throw new Error(`Could not find ${goForward ? 'next' : 'prev'} button in calendar`);
      }

      this.logger.debug(
        `Calendar navigation: current=${currentMonth.year}-${String(currentMonth.month).padStart(2, '0')} ` +
        `target=${targetYear}-${String(targetMonth).padStart(2, '0')} direction=${goForward ? 'forward' : 'backward'}`
      );
    }

    throw new Error(`Could not navigate to month ${targetYear}-${String(targetMonth).padStart(2, '0')} after ${maxAttempts} attempts`);
  }

  /**
   * Check if the calendar is currently showing the target month/year.
   * Extracts year/month from calendar header and compares.
   */
  private async isCalendarMonth(targetYear: number, targetMonth: number): Promise<boolean> {
    if (!this.page) return false;

    return await this.page.evaluate(
      ({ year, month }) => {
        const header = document.querySelector('.bui-calendar__month');
        if (!header) return false;

        const text = header.textContent || '';
        const monthMatch = text.match(/(\w+)\s+(\d{4})/);
        if (!monthMatch) return false;

        const months: Record<string, number> = {
          january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
          july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
        };

        const currentMonth = months[monthMatch[1].toLowerCase()] || 0;
        const currentYear = parseInt(monthMatch[2]) || 0;

        return currentYear === year && currentMonth === month;
      },
      { year: targetYear, month: targetMonth }
    );
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
