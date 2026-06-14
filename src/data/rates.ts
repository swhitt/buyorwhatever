import type { LocationData, MarketData, StateRateTable } from "./types";
import locationsRaw from "./locations.json";
import marketRaw from "./market.json";
import propertyTaxRaw from "./propertyTax.json";
import insuranceRaw from "./insurance.json";

// A plain typed assignment (not a cast): market.json must structurally satisfy MarketData,
// so if a refresh drops or mistypes a field, this fails to compile instead of a `marketRaw as
// MarketData` cast silently passing the gap through to the runtime validator in live.ts.
export const market: MarketData = marketRaw;

// The rate JSONs carry _source/_asOf string metadata alongside their numeric, state-keyed
// rates, so they don't satisfy StateRateTable's number index without a double-cast. Do it ONCE
// here (state-code lookups only ever read the numeric entries, so the metadata is harmless) so
// the loudest type escape hatch in the tree lives in a single place instead of every consumer.
export const locations = locationsRaw as LocationData[];
export const propertyTax = propertyTaxRaw as unknown as StateRateTable;
export const insurance = insuranceRaw as unknown as StateRateTable;

// The national row: the baseline every "reset to my area" fallback and first-paint snapshot
// starts from when no metro is detected yet.
export const usHome = locations.find((l) => l.id === "united-states") ?? locations[0];
