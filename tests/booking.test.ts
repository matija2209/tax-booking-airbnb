import { BookingScraper } from '../src/scrapers/booking';
import { createLogger } from '../src/utils/logger';

describe('BookingScraper', () => {
  const mockCredentials = {
    email: 'test@example.com',
    password: 'password123',
  };

  const logger = createLogger({ verbose: false });
  const scraper = new BookingScraper(mockCredentials, logger);

  // Access private methods for testing via casting to any
  const scraperAny = scraper as any;

  it('should create a scraper instance', () => {
    expect(scraper).toBeDefined();
  });

  describe('parseAmount', () => {
    it('should parse European format correctly (1.234,56)', () => {
      expect(scraperAny.parseAmount('1.234,56')).toBe(1234.56);
      expect(scraperAny.parseAmount('€ 1.234,56')).toBe(1234.56);
    });

    it('should parse simple format correctly (1234.56)', () => {
      expect(scraperAny.parseAmount('1234.56')).toBe(1234.56);
      expect(scraperAny.parseAmount('$1234.56')).toBe(1234.56);
    });

    it('should parse US/UK format correctly (1,234.56)', () => {
      expect(scraperAny.parseAmount('1,234.56')).toBe(1234.56);
      expect(scraperAny.parseAmount('£ 1,234.56')).toBe(1234.56);
    });

    it('should handle empty strings', () => {
      expect(scraperAny.parseAmount('')).toBe(0);
      expect(scraperAny.parseAmount(null as any)).toBe(0);
    });

    it('should handle negative numbers', () => {
      expect(scraperAny.parseAmount('-1.234,56')).toBe(-1234.56);
    });
  });

  describe('calculateNights', () => {
    it('should calculate nights between two dates', () => {
      expect(scraperAny.calculateNights('2023-01-01', '2023-01-05')).toBe(4);
    });

    it('should return at least 1 night if dates are same', () => {
      expect(scraperAny.calculateNights('2023-01-01', '2023-01-01')).toBe(1);
    });

    it('should handle invalid dates gracefully', () => {
      expect(scraperAny.calculateNights('invalid', '2023-01-01')).toBe(0);
    });
  });
});
