// Casper unit conversions: 1 CSPR = 1,000,000,000 motes (10^9)

export const MOTES_PER_CSPR = 1_000_000_000n;

export function motesToCspr(motes: bigint): number {
  return Number(motes) / Number(MOTES_PER_CSPR);
}

export function csprToMotes(cspr: number): bigint {
  return BigInt(Math.round(cspr * Number(MOTES_PER_CSPR)));
}

export function formatMotes(motes: bigint): string {
  const cspr = motesToCspr(motes);
  return `${cspr.toFixed(4)} CSPR (${motes.toString()} motes)`;
}
