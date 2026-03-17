import { Browser, BrowserContext, Page, chromium } from 'playwright';

export interface BrowserOptions {
  headless?: boolean;
  timeout?: number;
  slowMo?: number;
}

export class BrowserManager {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private timeout: number;

  constructor(options: BrowserOptions = {}) {
    this.timeout = options.timeout || 30000;
  }

  async launch(options: BrowserOptions = {}): Promise<Browser> {
    const headless = options.headless !== false;
    const slowMo = options.slowMo || 0;

    this.browser = await chromium.launch({
      headless,
      slowMo,
    });

    return this.browser;
  }

  async createContext(): Promise<BrowserContext> {
    if (!this.browser) {
      throw new Error('Browser not launched. Call launch() first.');
    }

    this.context = await this.browser.newContext();
    this.context.setDefaultTimeout(this.timeout);

    return this.context;
  }

  async createPage(): Promise<Page> {
    if (!this.context) {
      throw new Error('Context not created. Call createContext() first.');
    }

    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(this.timeout);

    return this.page;
  }

  getPage(): Page {
    if (!this.page) {
      throw new Error('Page not created. Call createPage() first.');
    }
    return this.page;
  }

  async cleanup(): Promise<void> {
    try {
      if (this.page) {
        await this.page.close();
        this.page = null;
      }
      if (this.context) {
        await this.context.close();
        this.context = null;
      }
      if (this.browser) {
        await this.browser.close();
        this.browser = null;
      }
    } catch (error) {
      console.error('Error during browser cleanup:', error);
    }
  }
}

export const createBrowserManager = (options?: BrowserOptions): BrowserManager => {
  return new BrowserManager(options);
};
