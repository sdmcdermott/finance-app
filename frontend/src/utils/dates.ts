// Global date display format: MM/DD/YY
// All ISO YYYY-MM-DD strings should be passed through fmtDate before display.

/**
 * Formats an ISO date string (YYYY-MM-DD) as MM/DD/YY.
 * Returns '—' for empty/undefined values.
 */
export const fmtDate = (iso: string | undefined | null): string => {
  if (!iso) return '—';
  const parts = iso.slice(0, 10).split('-'); // handle ISO datetimes too
  if (parts.length !== 3) return iso;
  const [y, m, d] = parts;
  return `${m}/${d}/${y.slice(2)}`;
};

/**
 * Formats a number as a dollar amount with commas and 2 decimal places.
 * Always uses the absolute value — callers handle sign prefix if needed.
 * e.g. 1234.5 → "$1,234.50"
 */
export const fmtCurrency = (n: number): string =>
  '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
