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
  guestServiceFee: number;
  hostServiceFee: number;
  nightlyRateAdjustment: number;
  hostFees: number;
  platformFees: number;
  propertyUseTaxes: number;
  cleaningFees: number;
  touristTax: number;
  otherTaxes: number;
  netAmount: number;
  status: string;
  notes?: string;
  reservationUrl?: string;
  result?: string;
  isDisputed?: boolean;
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
  onReservationProcessed?: (
    reservation: Reservation,
    reservations: Reservation[]
  ) => Promise<void> | void;
}
