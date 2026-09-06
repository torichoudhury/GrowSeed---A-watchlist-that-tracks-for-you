// ONLY call these functions when rendering to the user. Never in calculations.
export const formatRupees = (paise: number): string =>
    (paise / 100).toLocaleString('en-IN', { style: 'currency', currency: 'INR' });

export const formatPct = (bps: number): string =>
    (bps / 100).toFixed(2) + '%';

export const formatRatio = (ratio: number): string =>
    ratio.toFixed(1) + '×';

export const formatZ = (z: number): string =>
    z.toFixed(1) + '×';
