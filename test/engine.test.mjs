// Run with: node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    validateRulebook, makeState, applyTurn, reviseEvents, composeNote, levelWithMargin,
    softFactor, extractJson, cleanVerdict, cleanAssessment, nextJournal, reviseJournal, statusLine, normalizeState,
} from '../src/engine.js';
import { SLOW_BURN } from '../src/defaults.js';

const { rulebook: rb, errors } = validateRulebook(SLOW_BURN);
const meter = (id) => rb.meters.find(m => m.id === id);

test('the bundled rulebook is valid', () => {
    assert.deepEqual(errors, []);
});

test('validation reports unknown meters and severities', () => {
    const bad = structuredClone(SLOW_BURN);
    bad.events.support.effects.huge = { nope: 3 };
    const { errors: e } = validateRulebook(bad);
    assert.ok(e.some(x => x.includes('unknown severity "huge"')));
    assert.ok(e.some(x => x.includes('unknown meter "nope"')));
});

test('starting state picks levels from values', () => {
    const s = makeState(rb, { kindness: -70, dominance: 60, affection: 10, love: 0, lust: 15, trust: 25 });
    assert.equal(s.levels.kindness, 'Cruel');
    assert.equal(s.levels.dominance, 'In charge');
    assert.equal(s.unlocked.love, false);
});

test('ordinary gains are capped per turn; serious losses are not', () => {
    const s = makeState(rb, { affection: 30, trust: 50, kindness: 0 });
    const up = applyTurn(rb, s, [
        { type: 'support', severity: 'serious', reason: 'a' },
        { type: 'quality_time', severity: 'serious', reason: 'b' },
    ]);
    assert.equal(up.state.values.affection, 35, 'affection +12 nominal is capped at +5');
    assert.ok(up.applied.every(a => a.capped));
    const down = applyTurn(rb, s, [{ type: 'dishonesty', severity: 'serious', reason: 'hid it' }]);
    assert.equal(down.state.values.trust, 20, 'trust −30 is not capped');
});

test('a trivial lie touches trust only; cheating hits everything', () => {
    const s = makeState(rb, { trust: 60, affection: 70, love: 40, kindness: 20 });
    s.unlocked.love = true;
    const lie = applyTurn(rb, s, [{ type: 'dishonesty', severity: 'trivial', reason: 'the milk' }]);
    assert.deepEqual(lie.applied[0].deltas, { trust: -3 });
    const cheat = applyTurn(rb, s, [{ type: 'dishonesty', severity: 'severe', reason: 'cheated' }]);
    assert.equal(cheat.state.values.trust, 0);
    assert.equal(cheat.state.values.affection, 30);
    assert.equal(cheat.state.values.love, 10);
    assert.equal(cheat.state.values.kindness, -5);
});

test('gains shrink near the end they move towards', () => {
    const m = meter('dominance');
    assert.equal(softFactor(m, 0, -5, 0.2), 1);
    assert.ok(softFactor(m, -90, -5, 0.2) < 0.5);
    assert.equal(softFactor(m, -90, 5, 0.2), 1, 'moving away from the end is not slowed');
    const s = makeState(rb, { dominance: -90 });
    const r = applyTurn(rb, s, [{ type: 'user_takes_charge', severity: 'serious', reason: 'x' }]);
    assert.ok(r.state.values.dominance > -93, `got ${r.state.values.dominance}`);
});

test('levels keep a margin before changing', () => {
    const m = meter('kindness');
    assert.equal(m.levels[levelWithMargin(m, -32, 'Prickly', 5)].name, 'Prickly');
    assert.equal(m.levels[levelWithMargin(m, -36, 'Prickly', 5)].name, 'Cold');
});

test('love stays locked until affection reaches 50, then stays unlocked', () => {
    let s = makeState(rb, { affection: 48, love: 0 });
    let r = applyTurn(rb, s, [{ type: 'vulnerability', severity: 'serious', reason: 'opened up' }]);
    assert.equal(r.state.values.love, 0, 'locked at the start of the turn');
    assert.equal(r.state.unlocked.love, true, 'affection reached 52, so it unlocks now');
    s = r.state;
    r = applyTurn(rb, s, [{ type: 'vulnerability', severity: 'serious', reason: 'again' }]);
    assert.equal(r.state.values.love, 3);
    r = applyTurn(rb, { ...r.state, values: { ...r.state.values, affection: 20 } }, []);
    assert.equal(r.state.unlocked.love, true);
});

test('kneeling example: the refusal cancels the first turn and the reversal counts', () => {
    const start = makeState(rb, { dominance: 0 });
    // Turn X: she kneels unprompted.
    const turnX = applyTurn(rb, start, [{ type: 'char_yields', severity: 'serious', reason: 'knelt for him' }]);
    assert.equal(turnX.state.values.dominance, -4);
    // Turn X+2: the judge cancels turn X and scores the user kneeling instead.
    const revised = reviseEvents(turnX.applied, [{ index: 0, action: 'cancel', reason: 'he refused' }]);
    const mid = applyTurn(rb, start, revised);
    assert.equal(mid.state.values.dominance, 0);
    const turnX2 = applyTurn(rb, mid.state, [{ type: 'user_yields', severity: 'serious', reason: 'knelt for her' }]);
    assert.equal(turnX2.state.values.dominance, 5, 'net gain for her (capped at +5)');
});

test('re-rating keeps the original severity for display', () => {
    const ev = reviseEvents([{ type: 'dishonesty', severity: 'severe', reason: 'x' }], [{ index: 0, action: 'rerate', severity: 'minor' }]);
    assert.equal(ev[0].severity, 'minor');
    assert.equal(ev[0].originalSeverity, 'severe');
});

test('the note skips levels that match the start and lists recent major events', () => {
    const start = makeState(rb, { kindness: -70, dominance: 60, affection: 10, trust: 25, lust: 15 });
    const now = makeState(rb, { kindness: -15, dominance: 60, affection: 40, trust: 25, lust: 15 });
    const journal = [{ turn: 40, key: '40:0', type: 'dishonesty', severity: 'serious', reason: 'caught him lying' }];
    const note = composeNote(rb, now, start, journal, 42, { header: '[H]' });
    assert.match(note, /^\[H\]/);
    assert.match(note, /Mean ↔ Kind \(began Cruel, now Prickly\)/);
    assert.match(note, /Affection \(began Indifferent, now Comfortable\)/);
    assert.doesNotMatch(note, /Sub ↔ Dom/);
    assert.match(note, /Recent \(2 turns ago\): caught him lying/);
    assert.equal(composeNote(rb, start, start, [], 1, { header: '[H]' }), '');
});

test('journal records major events and can be rebuilt after a revision', () => {
    const r = applyTurn(rb, makeState(rb, {}), [{ type: 'dishonesty', severity: 'serious', reason: 'lied' }]);
    const j = nextJournal(rb, [], 5, r.applied);
    assert.equal(j.length, 1);
    const cancelled = reviseEvents(r.applied, [{ index: 0, action: 'cancel' }]);
    assert.equal(reviseJournal(rb, j, 5, cancelled).length, 0);
});

test('parsing tolerates fences and chatter, and drops bad entries', () => {
    const raw = extractJson('Sure!\n```json\n{"events":[{"type":"support","severity":"minor","reason":"made dinner"},{"type":"nope","severity":"minor"}],"revise":[{"index":3,"action":"cancel"}]}\n```');
    const v = cleanVerdict(rb, raw, 1);
    assert.equal(v.events.length, 1);
    assert.equal(v.revise.length, 0, 'index 3 is out of range');
    assert.throws(() => extractJson('no json here'));
});

test('assessment values are clamped and rounded', () => {
    const a = cleanAssessment(rb, { meters: { kindness: { value: -140.4, reason: 'cruel' }, trust: 33.6 } });
    assert.equal(a.kindness.value, -100);
    assert.equal(a.trust.value, 34);
    assert.equal(a.affection.value, 10, 'missing meters use the rulebook start');
});

test('status line comes from the status meter', () => {
    assert.equal(statusLine(rb, makeState(rb, { kindness: -15 })), 'Thawing');
});

test('old states survive meters being added to the rulebook', () => {
    const s = normalizeState(rb, { values: { trust: 50 }, levels: { trust: 'Cautious' } });
    assert.equal(s.values.trust, 50);
    assert.equal(s.values.lust, 10);
});

// ---------- per-meter overrides, set effects, fade ----------
const fast = validateRulebook({
    name: 'Fast meter test',
    meters: [
        { id: 'slow', min: 0, max: 100, start: 50, levels: [{ from: 0, name: 'Low', instruction: 'x' }, { from: 60, name: 'High', instruction: 'y' }] },
        {
            id: 'arousal', label: 'Arousal', min: 0, max: 100, start: 0, gainCap: 40, softZone: 0, levelMargin: 3, transient: true,
            fade: { amount: 10, to: 0 },
            levels: [{ from: 0, name: 'Calm', instruction: '' }, { from: 35, name: 'Warm', instruction: 'warm' }, { from: 60, name: 'Aroused', instruction: 'aroused' }],
        },
    ],
    events: {
        kiss: { description: 'kiss', always: true, effects: { serious: { arousal: 20, slow: 20 } } },
        climax: { description: 'her climax', always: true, effects: { serious: { arousal: '=0' } } },
        bad: { description: 'bad', effects: { minor: { arousal: '=x' } } },
    },
});

test('invalid set values are reported', () => {
    assert.ok(fast.errors.some(e => e.includes('"=N"')));
});

const frb = (() => { const r = structuredClone(fast.rulebook); delete r.events.bad; return validateRulebook(r).rulebook; })();

test('a meter can have its own per-turn cap and no slowdown near the end', () => {
    let s = makeState(frb, { arousal: 0, slow: 50 });
    const r = applyTurn(frb, s, [{ type: 'kiss', severity: 'serious' }, { type: 'kiss', severity: 'serious' }]);
    assert.equal(r.state.values.arousal, 40, 'two kisses: +40, within its own cap');
    assert.equal(r.state.values.slow, 55, 'the other meter keeps the rulebook cap of 5');
    s = makeState(frb, { arousal: 90 });
    assert.equal(applyTurn(frb, s, [{ type: 'kiss', severity: 'serious' }]).state.values.arousal, 100, 'softZone 0: no slowdown');
});

test('"=N" sets a meter, after other changes in the same turn', () => {
    const s = makeState(frb, { arousal: 80 });
    const r = applyTurn(frb, s, [{ type: 'kiss', severity: 'serious' }, { type: 'climax', severity: 'serious' }]);
    assert.equal(r.state.values.arousal, 0);
    assert.deepEqual(r.applied[1].sets, { arousal: 0 });
    assert.equal(r.applied[1].deltas.arousal, -80);
    assert.equal(r.applied[0].deltas.arousal, 0, 'the kiss is overridden by the reset');
});

test('fade only applies on a turn when nothing touched the meter', () => {
    const s = makeState(frb, { arousal: 45, slow: 50 });
    const quiet = applyTurn(frb, s, []);
    assert.equal(quiet.state.values.arousal, 35);
    assert.deepEqual(quiet.fades, { arousal: -10 });
    assert.equal(quiet.state.values.slow, 50, 'meters without fade stay put');
    const busy = applyTurn(frb, s, [{ type: 'kiss', severity: 'serious' }]);
    assert.equal(busy.state.values.arousal, 65);
    assert.deepEqual(busy.fades, {});
    assert.equal(applyTurn(frb, makeState(frb, { arousal: 4 }), []).state.values.arousal, 0, 'never fades past its target');
});

test('fade can wait for several quiet turns, and any touch resets the count', () => {
    const drb = validateRulebook({
        ...frb,
        meters: frb.meters.map(m => m.id === 'arousal' ? { ...m, fade: { amount: 10, to: 0, after: 3 } } : m),
    }).rulebook;
    let s = makeState(drb, { arousal: 60 });
    const seen = [];
    for (let i = 0; i < 5; i++) { const r = applyTurn(drb, s, []); s = r.state; seen.push(s.values.arousal); }
    assert.deepEqual(seen, [60, 60, 60, 50, 40], 'first fade on the 4th quiet turn');
    s = applyTurn(drb, s, [{ type: 'kiss', severity: 'serious' }]).state;
    assert.equal(s.quiet.arousal, 0, 'a touch resets the quiet count');
    const v = s.values.arousal;
    s = applyTurn(drb, s, []).state;
    assert.equal(s.values.arousal, v, 'no fade straight after a touch');
    assert.equal(normalizeState(drb, s).quiet.arousal, 1, 'the count survives normalising');
});

test('a meter can have its own level margin', () => {
    let s = makeState(frb, { arousal: 36 });
    assert.equal(s.levels.arousal, 'Warm');
    s = applyTurn(frb, s, []).state; // 26: more than 3 below Warm's edge
    assert.equal(s.levels.arousal, 'Calm');
});

test('transient meters leave out "began … now …" and the lowest level sends nothing', () => {
    const start = makeState(frb, { arousal: 0, slow: 50 });
    assert.equal(composeNote(frb, start, start, [], 1, {}), '');
    const now = makeState(frb, { arousal: 62, slow: 50 });
    assert.match(composeNote(frb, now, start, [], 1, {}), /- Arousal \(Aroused\): aroused/);
});

test('transient meters are described even at their starting level', () => {
    const start = makeState(frb, { arousal: 40, slow: 50 });
    assert.match(composeNote(frb, start, start, [], 1, {}), /- Arousal \(Warm\): warm/);
    assert.doesNotMatch(composeNote(frb, start, start, [], 1, {}), /Low|High/, 'slow meters at their start stay silent');
});
