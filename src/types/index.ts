export interface Property {
  id: string;
  name: string;
}

export interface Reservation {
  propertyId: string;
  propertyName: string;
  bookingDate: string;
  checkInDate: string;
  checkOutDate: string;
  nights: number;
  guestCount: number;
  guestName: string;
  bookingReference: string;
  grossAmount: number;
  currency: string;
  hostFees: number;
  platformFees: number;
  cleaningFees: number;
  touristTax: number;
  otherTaxes: number;
  netAmount: number;
  status: string;
  notes?: string;
}

export interface Payout {
  payoutDate: string;
  amount: number;
  currency: string;
  reference: string;
  status: string;
}

export interface YearlyAggregate {
  year: number;
  grossRevenue: number;
  touristTaxCollected: number;
  otherTaxesCollected: number;
  totalFeesWithheld: number;
  netPayoutsReceived: number;
  currency: string;
  reservationCount: number;
}

export interface ExtractionResult {
  reservations: Reservation[];
  payouts: Payout[];
  aggregates: YearlyAggregate[];
  extractedAt: string;
}

export interface ExtractionOptions {
  propertyId?: string;
  startDate?: string;
  endDate?: string;
  output?: string;
  verbose?: boolean;
}
