import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCorporateActionSubject, classifyMeetingPurpose, priceAdjustmentFactor } from './parse';

test('bonus ratio parses and halves price for 1:1', () => {
    const e = parseCorporateActionSubject('Bonus 1:1');
    assert.equal(e.eventType, 'BONUS');
    assert.deepEqual([e.ratioNum, e.ratioDen], [1, 1]);
    assert.equal(priceAdjustmentFactor(e), 0.5);
});

test('bonus 3:2 gives factor 2/5', () => {
    const e = parseCorporateActionSubject('Bonus Issue 3:2');
    assert.equal(e.eventType, 'BONUS');
    assert.equal(priceAdjustmentFactor(e), 0.4);
});

test('face value split from 10 to 2 gives factor 0.2', () => {
    const e = parseCorporateActionSubject('Face Value Split (Sub-Division) - From Rs 10/- Per Share To Rs 2/- Per Share');
    assert.equal(e.eventType, 'SPLIT');
    assert.deepEqual([e.ratioNum, e.ratioDen], [2, 10]);
    assert.equal(priceAdjustmentFactor(e), 0.2);
});

test('split with Re 1 wording', () => {
    const e = parseCorporateActionSubject('Face Value Split From Rs 10/- to Re 1/-');
    assert.equal(e.eventType, 'SPLIT');
    assert.equal(priceAdjustmentFactor(e), 0.1);
});

test('dividend amounts sum interim + special', () => {
    const e = parseCorporateActionSubject('Interim Dividend - Rs 5 Per Share & Special Dividend Rs 10 Per Share');
    assert.equal(e.eventType, 'DIVIDEND');
    assert.equal(e.amountPaise, 1500);
});

test('dividend with Re 0.50', () => {
    const e = parseCorporateActionSubject('Dividend - Re 0.50 Per Share');
    assert.equal(e.amountPaise, 50);
});

test('unknown subjects are OTHER with no factor', () => {
    const e = parseCorporateActionSubject('Rights 1:4 @ Premium Rs 100/- Per Share');
    assert.equal(e.eventType, 'OTHER');
    assert.equal(priceAdjustmentFactor(e), null);
});

test('meeting purposes containing "Result" are RESULTS', () => {
    assert.equal(classifyMeetingPurpose('Financial Results'), 'RESULTS');
    assert.equal(classifyMeetingPurpose('Results/Dividend'), 'RESULTS');
    assert.equal(classifyMeetingPurpose('Financial Results/Other business matters'), 'RESULTS');
    assert.equal(classifyMeetingPurpose('Fund Raising'), 'OTHER');
});
