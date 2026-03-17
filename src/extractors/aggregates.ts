import { Reservation, YearlyAggregate } from '../types/index.js';
import { getYearFromDate, parseDate } from '../utils/dates.js';

export function calculateAggregates(reservations: Reservation[]): YearlyAggregate[] {
  const aggregatesByYear = new Map<number, YearlyAggregate>();

  for (const reservation of reservations) {
    const year = getYearFromDate(reservation.checkInDate);

    if (!aggregatesByYear.has(year)) {
      aggregatesByYear.set(year, {
        year,
        grossRevenue: 0,
        touristTaxCollected: 0,
        otherTaxesCollected: 0,
        totalFeesWithheld: 0,
        netPayoutsReceived: 0,
        currency: reservation.currency,
        reservationCount: 0,
      });
    }

    const aggregate = aggregatesByYear.get(year)!;
    aggregate.grossRevenue += reservation.grossAmount;
    aggregate.touristTaxCollected += reservation.touristTax;
    aggregate.otherTaxesCollected += reservation.otherTaxes;
    aggregate.totalFeesWithheld += reservation.hostFees + reservation.platformFees + reservation.cleaningFees;
    aggregate.netPayoutsReceived += reservation.netAmount;
    aggregate.reservationCount += 1;
  }

  return Array.from(aggregatesByYear.values()).sort((a, b) => a.year - b.year);
}

export function aggregateByProperty(
  reservations: Reservation[]
): Map<string, YearlyAggregate[]> {
  const result = new Map<string, YearlyAggregate[]>();

  for (const reservation of reservations) {
    const propertyId = reservation.propertyId;

    if (!result.has(propertyId)) {
      result.set(propertyId, []);
    }

    const propertyAggregates = result.get(propertyId)!;
    const year = getYearFromDate(reservation.checkInDate);

    let yearAggregate = propertyAggregates.find((a) => a.year === year);
    if (!yearAggregate) {
      yearAggregate = {
        year,
        grossRevenue: 0,
        touristTaxCollected: 0,
        otherTaxesCollected: 0,
        totalFeesWithheld: 0,
        netPayoutsReceived: 0,
        currency: reservation.currency,
        reservationCount: 0,
      };
      propertyAggregates.push(yearAggregate);
    }

    yearAggregate.grossRevenue += reservation.grossAmount;
    yearAggregate.touristTaxCollected += reservation.touristTax;
    yearAggregate.otherTaxesCollected += reservation.otherTaxes;
    yearAggregate.totalFeesWithheld +=
      reservation.hostFees + reservation.platformFees + reservation.cleaningFees;
    yearAggregate.netPayoutsReceived += reservation.netAmount;
    yearAggregate.reservationCount += 1;
  }

  // Sort each property's aggregates by year
  for (const aggregates of result.values()) {
    aggregates.sort((a, b) => a.year - b.year);
  }

  return result;
}
