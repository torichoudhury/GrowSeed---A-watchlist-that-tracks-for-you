/**
 * Turns NSE's free-text corporate-action subjects and board-meeting purposes
 * into typed events. Pure functions — unit-tested in isolation, because a
 * mis-parsed ratio would re-base a user's baseline by the wrong factor.
 */

export type CorporateEventType = 'SPLIT' | 'BONUS' | 'DIVIDEND' | 'RESULTS' | 'OTHER';

export interface ParsedCorporateAction {
    eventType: CorporateEventType;
    ratioNum: number | null;   // BONUS: new shares per ratioDen old;  SPLIT: new face value
    ratioDen: number | null;   // BONUS: old shares;                   SPLIT: old face value
    amountPaise: number | null;
}

const num = (s: string) => Number(s.replace(/,/g, ''));

export function parseCorporateActionSubject(subject: string): ParsedCorporateAction {
    const s = subject.trim();

    // "Bonus 1:1", "Bonus 3:2", "Bonus Issue 1:2"
    const bonus = s.match(/bonus[^\d]*(\d+)\s*:\s*(\d+)/i);
    if (bonus) {
        return { eventType: 'BONUS', ratioNum: num(bonus[1]), ratioDen: num(bonus[2]), amountPaise: null };
    }

    // "Face Value Split (Sub-Division) - From Rs 10/- Per Share To Rs 2/- Per Share"
    // "Face Value Split From Rs 10/- to Re 1/-"
    const split = s.match(/split.*?from\s*(?:rs\.?|re\.?|₹)?\s*([\d.]+).*?to\s*(?:rs\.?|re\.?|₹)?\s*([\d.]+)/i)
        || s.match(/sub-?division.*?from\s*(?:rs\.?|re\.?|₹)?\s*([\d.]+).*?to\s*(?:rs\.?|re\.?|₹)?\s*([\d.]+)/i);
    if (split) {
        const oldFv = num(split[1]);
        const newFv = num(split[2]);
        if (oldFv > 0 && newFv > 0 && oldFv !== newFv) {
            return { eventType: 'SPLIT', ratioNum: newFv, ratioDen: oldFv, amountPaise: null };
        }
    }

    // "Dividend - Rs 6 Per Share", "Interim Dividend - Re 0.50 Per Share",
    // "Interim Dividend - Rs 5 Per Share & Special Dividend Rs 10 Per Share"
    if (/dividend/i.test(s)) {
        const amounts = Array.from(s.matchAll(/(?:rs\.?|re\.?|₹)\s*([\d.]+)/gi)).map(m => num(m[1]));
        const total = amounts.reduce((a, b) => a + b, 0);
        return { eventType: 'DIVIDEND', ratioNum: null, ratioDen: null, amountPaise: total > 0 ? Math.round(total * 100) : null };
    }

    return { eventType: 'OTHER', ratioNum: null, ratioDen: null, amountPaise: null };
}

/** Board-meeting purposes: "Financial Results", "Results/Dividend",
 * "Financial Results/Other business matters" → RESULTS; the rest → OTHER. */
export function classifyMeetingPurpose(purpose: string): CorporateEventType {
    return /result/i.test(purpose) ? 'RESULTS' : 'OTHER';
}

/**
 * Price adjustment factor implied by a split/bonus: multiply PRE-event prices
 * by this to put them on the post-event basis.
 *   BONUS a:b  → each b old shares become a+b  → factor = b / (a + b)
 *   SPLIT new FV n from old FV o               → factor = n / o
 */
export function priceAdjustmentFactor(evt: ParsedCorporateAction): number | null {
    if (evt.ratioNum == null || evt.ratioDen == null || evt.ratioDen === 0) return null;
    if (evt.eventType === 'BONUS') return evt.ratioDen / (evt.ratioNum + evt.ratioDen);
    if (evt.eventType === 'SPLIT') return evt.ratioNum / evt.ratioDen;
    return null;
}
