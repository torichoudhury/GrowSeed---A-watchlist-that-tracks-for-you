import { query, pool } from './config/db';
import { scanForMissedAdjustments, type AdjustmentFinding } from './services/fundamentals/adjustmentScan';

/**
 * `npm run detect:splits [-- --apply]`
 *
 * Reports corporate actions our NSE parsing missed, found from the numbers
 * alone (services/fundamentals/splitDetector.ts). The plain run records each
 * HIGH-confidence finding as a SUSPECTED_ADJUSTMENT row for review and
 * changes no prices.
 *
 * With --apply, those findings are promoted to real BONUS rows, which the
 * existing re-basing path (applyPendingPriceAdjustments, run by
 * `npm run sync:fundamentals`) then uses to fix stored history. Opt-in on
 * purpose: an inference should never rewrite prices by itself.
 */

const apply = process.argv.includes('--apply');

/** factor = den/(num+den) → the a:b a BONUS row needs to re-base with. */
function bonusRatioFor(factor: number): { num: number; den: number } | null {
    for (const den of [1, 2, 3, 4, 5]) {
        for (const num of [1, 2, 3, 4, 5, 9, 10]) {
            if (Math.abs(den / (num + den) - factor) < 1e-6) return { num, den };
        }
    }
    return null;
}

function printTable(findings: AdjustmentFinding[]) {
    console.log('  DATE        INSTRUMENT       MOVE      IMPLIED  MATCHES             ERR    RANGE  NEXT  VOL     CONF     CALENDAR');
    for (const f of findings) {
        const a = f.artifact;
        console.log(
            `  ${a.date}  ${f.instrumentId.padEnd(15)} ${(a.returnBps / 100).toFixed(2).padStart(7)}%  ` +
            `${a.impliedFactor.toFixed(4).padStart(7)}  ${a.label.padEnd(19)} ` +
            `${(a.relError * 100).toFixed(2).padStart(5)}%  ${a.rangeClear ? 'clear' : ' no  '}  ` +
            `${a.nextDayCalm ? 'calm' : 'busy'}  ${(a.volumeRatio ?? 0).toFixed(1).padStart(5)}×  ${a.confidence.padEnd(7)}  ` +
            `${f.knownEvent ?? '— none on calendar'}`
        );
    }
}

async function main() {
    const scan = await scanForMissedAdjustments();
    console.log(`\nScanned ${scan.scanned} instruments with stored history.`);

    if (scan.findings.length === 0) {
        console.log('No ratio-shaped jumps found — every large move in the stored series looks like a real move.\n');
        return;
    }

    console.log(`\n${scan.findings.length} ratio-shaped jump(s):\n`);
    printTable(scan.findings);

    console.log(`\nRecorded ${scan.recorded} new SUSPECTED_ADJUSTMENT row(s) for review `
        + `(${scan.actionable.length} actionable: HIGH confidence, nothing on the calendar).`);
    console.log('Recording changes no prices — the estimators simply exclude those sessions from every return distribution.');

    if (!apply) {
        if (scan.actionable.length) {
            console.log('\nRe-run with `npm run detect:splits -- --apply` to promote them to BONUS rows and re-base stored prices.\n');
        }
        return;
    }

    let promoted = 0;
    for (const f of scan.actionable) {
        const a = f.artifact;
        const bonus = a.factor < 1 ? bonusRatioFor(a.factor) : null;
        if (!bonus) {
            console.log(`  skipping ${f.instrumentId} ${a.date} — ${a.label} has no clean bonus ratio to re-base with; add that row by hand`);
            continue;
        }
        const ins = await query(
            `INSERT INTO corporate_events (instrument_id, event_type, event_date, ratio_num, ratio_den, amount_paise, subject, source)
             VALUES ($1, 'BONUS', $2, $3, $4, NULL, $5, 'INFERRED')
             ON CONFLICT (instrument_id, event_type, event_date, subject) DO NOTHING
             RETURNING id`,
            [f.instrumentId, a.date, bonus.num, bonus.den,
             `Inferred ${bonus.num}:${bonus.den} bonus from a ${(a.returnBps / 100).toFixed(2)}% ratio-shaped jump`]
        );
        if (ins.rows.length) promoted++;
    }
    console.log(`\nPromoted ${promoted} finding(s) to BONUS rows. Run \`npm run sync:fundamentals\` to re-base history, then \`npm run stats\`.\n`);
}

main()
    .catch(err => { console.error('Split detection failed:', err); process.exitCode = 1; })
    .finally(async () => { await pool.end(); });
