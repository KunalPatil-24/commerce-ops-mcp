/** Money helpers. All internal amounts are integer cents. */

/** Formats integer cents as a USD string, e.g. 15000 -> "$150.00". */
export function centsToUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * Converts a dollar amount (as entered by a human or AI) to integer cents.
 * Math.round avoids floating-point drift, e.g. 80.1 * 100 = 8009.999... -> 8010.
 */
export function dollarsToCents(dollars: number): number {
  return Math.round(dollars * 100);
}
