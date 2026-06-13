export interface MarketData {
  asOf: string;
  mortgage: { rate30: number; rate15: number; asOf: string; source: string };
  inflation: { rate: number; asOf: string; source: string };
  appreciation: { rate1yr: number; rate5yrCagr: number; asOf: string; source: string };
  national: { homeValue: number; rent: number; asOf: string; source: string };
}

export interface LocationData {
  id: string;
  metro: string;
  state: string;
  homeValue: number;
  rent: number;
  appreciation5yr?: number;
}

export type PropertyTaxTable = Record<string, number>;
