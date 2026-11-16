/** Money is held as integer minor units (cents) everywhere; formatting happens at the edge. */
export const toMinor = (major: number): number => Math.round(major * 100);
export const formatMinor = (minor: number, currency = 'CAD'): string =>
  new Intl.NumberFormat('en-CA', { style: 'currency', currency, maximumFractionDigits: 0 }).format(minor / 100);
