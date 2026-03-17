import { parse, isValid, format, isAfter, isBefore, startOfDay, endOfDay } from 'date-fns';

export function parseDate(dateString: string): Date {
  // Try multiple date formats
  const formats = ['yyyy-MM-dd', 'MM/dd/yyyy', 'dd/MM/yyyy', 'MMM d, yyyy', 'MMMM d, yyyy'];

  for (const fmt of formats) {
    const parsed = parse(dateString, fmt, new Date());
    if (isValid(parsed)) {
      return parsed;
    }
  }

  // Fallback to native Date parsing
  const nativeDate = new Date(dateString);
  if (isValid(nativeDate)) {
    return nativeDate;
  }

  throw new Error(`Unable to parse date: ${dateString}`);
}

export function formatDate(date: Date, fmt: string = 'yyyy-MM-dd'): string {
  return format(date, fmt);
}

export function isDateInRange(date: Date, startDate?: Date, endDate?: Date): boolean {
  const checkDate = startOfDay(date);

  if (startDate && isBefore(checkDate, startOfDay(startDate))) {
    return false;
  }

  if (endDate && isAfter(checkDate, endOfDay(endDate))) {
    return false;
  }

  return true;
}

export function filterByDateRange(
  dates: Date[],
  startDate?: string,
  endDate?: string
): Date[] {
  const start = startDate ? parseDate(startDate) : undefined;
  const end = endDate ? parseDate(endDate) : undefined;

  return dates.filter((date) => isDateInRange(date, start, end));
}

export function getYearFromDate(date: Date | string): number {
  const d = typeof date === 'string' ? parseDate(date) : date;
  return d.getFullYear();
}
