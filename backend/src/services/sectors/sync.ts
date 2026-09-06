import { parse } from 'csv-parse/sync';
import { query } from '../../config/db';

/**
 * Stock -> sector index, from NSE's published index-constituent files
 * (approved 2026-09-04). The Nifty 500 file carries an Industry column for
 * every constituent; the bank lists refine "Financial Services" into the
 * bank indices. Stocks outside the Nifty 500 get no sector row and are
 * compared against the market benchmark only.
 */

const BASE = 'https://niftyindices.com/IndexConstituent';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

// NSE Industry label -> our sector index instrument id. Only indices that
// exist in our instrument master (from Groww's feed) and have a verified
// price ticker are mapped; everything else deliberately stays NULL rather
// than being forced onto a loosely-related index.
const INDUSTRY_TO_INDEX: Record<string, string | null> = {
    'Financial Services': 'NSE:FINNIFTY',
    'Information Technology': 'NSE:NIFTYIT',
    'Healthcare': 'NSE:NIFTYPHARMA',
    'Automobile and Auto Components': 'NSE:NIFTYAUTO',
    'Metals & Mining': 'NSE:NIFTYMETAL',
    'Fast Moving Consumer Goods': 'NSE:NIFTYFMCG',
    'Realty': 'NSE:NIFTYREALTY',
    'Media Entertainment & Publication': 'NSE:NIFTYMEDIA',
    'Capital Goods': null,
    'Consumer Services': null,
    'Chemicals': null,
    'Power': null,
    'Oil Gas & Consumable Fuels': null,
    'Consumer Durables': null,
    'Services': null,
    'Construction': null,
    'Construction Materials': null,
    'Telecommunication': null,
    'Textiles': null,
    'Diversified': null,
};

interface ConstituentRow {
    'Company Name': string;
    Industry: string;
    Symbol: string;
    Series: string;
    'ISIN Code': string;
}

async function fetchConstituents(file: string): Promise<ConstituentRow[]> {
    const res = await fetch(`${BASE}/${file}`, { headers: { 'User-Agent': USER_AGENT, Referer: 'https://niftyindices.com/' } });
    if (!res.ok) throw new Error(`niftyindices ${file} -> ${res.status}`);
    return parse(await res.text(), { columns: true, skip_empty_lines: true, bom: true });
}

export async function syncSectorMap(): Promise<{ mapped: number; withIndex: number }> {
    const [nifty500, banks, psuBanks] = await Promise.all([
        fetchConstituents('ind_nifty500list.csv'),
        fetchConstituents('ind_niftybanklist.csv').catch(() => [] as ConstituentRow[]),
        fetchConstituents('ind_niftypsubanklist.csv').catch(() => [] as ConstituentRow[]),
    ]);

    const bankSymbols = new Set(banks.map(r => r.Symbol));
    const psuSymbols = new Set(psuBanks.map(r => r.Symbol));

    const existing = await query('SELECT instrument_id FROM instruments');
    const known = new Set<string>(existing.rows.map(r => r.instrument_id));

    let mapped = 0, withIndex = 0;
    for (const row of nifty500) {
        const instrumentId = `NSE:${row.Symbol.trim().toUpperCase()}`;
        if (!known.has(instrumentId)) continue;

        let sectorIndex: string | null = INDUSTRY_TO_INDEX[row.Industry] ?? null;
        if (psuSymbols.has(row.Symbol)) sectorIndex = 'NSE:NIFTYPSUBANK';
        else if (bankSymbols.has(row.Symbol)) sectorIndex = 'NSE:BANKNIFTY';
        if (sectorIndex && !known.has(sectorIndex)) sectorIndex = null;

        await query(
            `INSERT INTO stock_sectors (instrument_id, industry, sector_index_id, source, updated_at)
             VALUES ($1, $2, $3, 'NIFTY500_CSV', now())
             ON CONFLICT (instrument_id) DO UPDATE SET
               industry = EXCLUDED.industry, sector_index_id = EXCLUDED.sector_index_id, updated_at = now()`,
            [instrumentId, row.Industry, sectorIndex]
        );
        mapped++;
        if (sectorIndex) withIndex++;
    }
    return { mapped, withIndex };
}

/** Every sector index any mapped stock points at — the indices the backfill
 * and stats jobs must also carry history for. */
export async function referencedSectorIndices(): Promise<string[]> {
    const res = await query('SELECT DISTINCT sector_index_id FROM stock_sectors WHERE sector_index_id IS NOT NULL');
    return res.rows.map(r => r.sector_index_id);
}
