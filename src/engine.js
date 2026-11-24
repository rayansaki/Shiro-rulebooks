// Pure scoring logic: no SillyTavern imports, so it can be tested in Node.
// Values live in plain objects keyed by meter id.

export const SEVERITIES = ['trivial', 'minor', 'serious', 'severe'];
const sevRank = (s) => SEVERITIES.indexOf(s);

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round1 = (v) => Math.round(v * 10) / 10;

// ---------- validation ----------

/**
 * Checks a rulebook and fills in defaults. Returns { rulebook, errors }.
 * Errors are plain sentences; a rulebook with errors should not be saved.
 */
export function validateRulebook(input) {
    const errors = [];
    const rb = structuredClone(input ?? {});
    if (!rb || typeof rb !== 'object') return { rulebook: null, errors: ['The rulebook must be a JSON object.'] };
    if (!rb.name || typeof rb.name !== 'string') errors.push('Give the rulebook a "name".');
    rb.limits = { gainCap: 5, levelMargin: 5, softZone: 0.2, recentTurns: 8, ...(rb.limits || {}) };
    if (!Array.isArray(rb.meters) || !rb.meters.length) errors.push('Add at least one meter in "meters".');
    const ids = new Set();
    for (const [i, m] of (rb.meters || []).entries()) {
        const where = `Meter ${i + 1}${m?.id ? ` ("${m.id}")` : ''}`;
        if (!m || typeof m !== 'object') { errors.push(`${where} must be an object.`); continue; }
        if (!m.id || !/^[a-z0-9_]+$/.test(m.id)) errors.push(`${where} needs an "id" of lower-case letters, digits or underscores.`);
        if (ids.has(m.id)) errors.push(`${where}: the id "${m.id}" is used twice.`);
        ids.add(m.id);
        m.label = m.label || m.id;
        m.min = Number(m.min ?? 0); m.max = Number(m.max ?? 100);
        if (!(m.max > m.min)) errors.push(`${where}: "max" must be above "min".`);
        m.start = clamp(Number(m.start ?? m.min), m.min, m.max);
        for (const k of ['gainCap', 'softZone', 'levelMargin']) {
            if (m[k] !== undefined && !(Number.isFinite(Number(m[k])) && Number(m[k]) >= 0)) errors.push(`${where}: "${k}" must be a number of 0 or more.`);
            else if (m[k] !== undefined) m[k] = Number(m[k]);
        }
        if (m.fade !== undefined) {
            if (!m.fade || !(Number(m.fade.amount) > 0)) errors.push(`${where}: "fade" needs an "amount" above 0.`);
            else m.fade = { amount: Number(m.fade.amount), to: clamp(Number(m.fade.to ?? m.min), m.min, m.max), after: Math.max(0, Math.floor(Number(m.fade.after ?? 0)) || 0) };
        }
        if (!Array.isArray(m.levels) || !m.levels.length) { errors.push(`${where} needs at least one level.`); m.levels = []; }
        m.levels.forEach((l, j) => {
            if (!l.name) errors.push(`${where}, level ${j + 1}: give it a "name".`);
            l.from = Number(l.from ?? m.min);
            l.instruction = l.instruction || '';
            l.status = l.status || l.name;
        });
        m.levels.sort((a, b) => a.from - b.from);
        if (m.levels.length && m.levels[0].from > m.min) errors.push(`${where}: the first level must start at ${m.min} (its "from").`);
    }
    for (const m of rb.meters || []) {
        if (m.gate) {
            if (!ids.has(m.gate.meter)) errors.push(`Meter "${m.id}": its gate points at an unknown meter "${m.gate.meter}".`);
            m.gate.min = Number(m.gate.min ?? 0);
        }
    }
    rb.events = rb.events || {};
    if (typeof rb.events !== 'object' || Array.isArray(rb.events) || !Object.keys(rb.events).length) errors.push('Add at least one event in "events".');
    for (const [key, ev] of Object.entries(rb.events || {})) {
        if (!/^[a-z0-9_]+$/.test(key)) errors.push(`Event "${key}": ids are lower-case letters, digits or underscores.`);
        if (!ev.description) errors.push(`Event "${key}" needs a "description" for the judge.`);
        ev.effects = ev.effects || {};
        for (const [sev, eff] of Object.entries(ev.effects)) {
            if (!SEVERITIES.includes(sev)) errors.push(`Event "${key}": unknown severity "${sev}" (use ${SEVERITIES.join(', ')}).`);
            for (const [mid, d] of Object.entries(eff || {})) {
                if (!ids.has(mid)) errors.push(`Event "${key}", ${sev}: unknown meter "${mid}".`);
                if (!Number.isFinite(Number(d)) && parseSet(d) === null) errors.push(`Event "${key}", ${sev}: the change for "${mid}" must be a number, or "=N" to set it to N.`);
            }
        }
        if (ev.bypassCapFrom && !SEVERITIES.includes(ev.bypassCapFrom)) errors.push(`Event "${key}": "bypassCapFrom" must be one of ${SEVERITIES.join(', ')}.`);
        if (ev.journalFrom && !SEVERITIES.includes(ev.journalFrom)) errors.push(`Event "${key}": "journalFrom" must be one of ${SEVERITIES.join(', ')}.`);
    }
    if (rb.statusMeter && !ids.has(rb.statusMeter)) errors.push(`"statusMeter" points at an unknown meter "${rb.statusMeter}".`);
    return { rulebook: rb, errors };
}

/** "=N" in an effect sets the meter to N instead of changing it. Returns N, or null. */
export function parseSet(v) {
    const m = typeof v === 'string' ? v.trim().match(/^=\s*(-?\d+(?:\.\d+)?)$/) : null;
    return m ? Number(m[1]) : null;
}

const marginFor = (rb, m) => m.levelMargin ?? rb.limits.levelMargin;

// ---------- levels ----------

export function levelIndexFor(meter, value) {
    let idx = 0;
    meter.levels.forEach((l, i) => { if (value >= l.from) idx = i; });
    return idx;
}

/** Range of a level: [from, next.from) — the last level runs to max. */
function levelRange(meter, i) {
    const lo = meter.levels[i].from;
    const hi = i + 1 < meter.levels.length ? meter.levels[i + 1].from : meter.max + 1e-9;
    return [lo, hi];
}

/**
 * The level for a value, with a margin: the current level is kept until the value
 * moves more than `margin` points outside it, so levels don't flicker at the edges.
 */
export function levelWithMargin(meter, value, currentName, margin) {
    const candidate = levelIndexFor(meter, value);
    const cur = meter.levels.findIndex(l => l.name === currentName);
    if (cur === -1 || cur === candidate) return candidate;
    const [lo, hi] = levelRange(meter, cur);
    if (value >= lo - margin && value < hi + margin) return cur;
    return candidate;
}

// ---------- state ----------

/** Builds a full state from values, computing levels without a margin. */
export function makeState(rb, values = {}, prev = null) {
    const state = { values: {}, levels: {}, unlocked: {}, quiet: { ...(prev?.quiet || {}) } };
    for (const m of rb.meters) {
        const v = Number.isFinite(Number(values[m.id])) ? Number(values[m.id]) : (prev?.values?.[m.id] ?? m.start);
        state.values[m.id] = clamp(v, m.min, m.max);
    }
    for (const m of rb.meters) {
        state.unlocked[m.id] = !m.gate || !!prev?.unlocked?.[m.id] || state.values[m.gate.meter] >= m.gate.min;
        const i = prev?.levels?.[m.id] !== undefined
            ? levelWithMargin(m, state.values[m.id], prev.levels[m.id], marginFor(rb, m))
            : levelIndexFor(m, state.values[m.id]);
        state.levels[m.id] = m.levels[i].name;
    }
    return state;
}

/** Makes an old state fit the current rulebook (meters added or removed since). */
export function normalizeState(rb, state, fallback = null) {
    const values = { ...(fallback?.values || {}), ...(state?.values || {}) };
    const s = makeState(rb, values, null);
    for (const m of rb.meters) {
        if (state?.levels?.[m.id] && m.levels.some(l => l.name === state.levels[m.id])) {
            s.levels[m.id] = m.levels[levelWithMargin(m, s.values[m.id], state.levels[m.id], marginFor(rb, m))].name;
        }
        if (state?.unlocked?.[m.id]) s.unlocked[m.id] = true;
    }
    s.quiet = { ...(state?.quiet || {}) };
    return s;
}

// ---------- applying a turn ----------

/** Nominal effect of one event, or null when the event or severity is unknown. */
export function eventEffect(rb, ev) {
    const def = rb.events[ev.type];
    if (!def || !SEVERITIES.includes(ev.severity)) return null;
    return def.effects?.[ev.severity] || {};
}

const bypasses = (rb, ev) => {
    const from = rb.events[ev.type]?.bypassCapFrom;
    return !!from && sevRank(ev.severity) >= sevRank(from);
};

/** Gains shrink as a value nears the end it is moving towards. */
export function softFactor(meter, value, delta, softZone) {
    if (!delta || !softZone) return 1;
    const remaining = delta > 0 ? meter.max - value : value - meter.min;
    const zone = (meter.max - meter.min) * softZone;
    if (remaining >= zone) return 1;
    return Math.max(0.2, remaining / zone);
}

/**
 * Applies a turn's events to a state.
 * Returns { state, applied, meters } where `applied` lists each event with the change it
 * actually made per meter, and `meters` explains each meter's maths (for the trace).
 * Per meter: `gainCap`, `softZone` and `levelMargin` override the rulebook's limits; an effect of
 * "=N" sets the meter to N (the last one wins, after other changes); `fade` moves a meter towards
 * `fade.to` by `fade.amount` once it has gone more than `fade.after` judged turns in a row without
 * any event touching it.
 */
export function applyTurn(rb, before, events) {
    const lim = rb.limits;
    const applied = [];
    const perMeter = {};
    for (const m of rb.meters) perMeter[m.id] = { normal: 0, bypass: 0, set: null, touched: false };

    for (const ev of events || []) {
        if (ev.cancelled) { applied.push({ ...ev, deltas: {}, sets: {} }); continue; }
        const eff = eventEffect(rb, ev);
        if (!eff) continue;
        const by = bypasses(rb, ev);
        const nominal = {}, sets = {};
        for (const [mid, d] of Object.entries(eff)) {
            if (!perMeter[mid]) continue;
            perMeter[mid].touched = true;
            const setTo = parseSet(d);
            if (setTo !== null) { sets[mid] = setTo; perMeter[mid].set = setTo; continue; }
            nominal[mid] = Number(d);
            perMeter[mid][by ? 'bypass' : 'normal'] += Number(d);
        }
        applied.push({ ...ev, bypass: by, nominal, sets, deltas: {} });
    }

    const meters = {};
    const values = {};
    for (const m of rb.meters) {
        const old = before.values[m.id];
        const pm = perMeter[m.id];
        const locked = m.gate && !before.unlocked?.[m.id];
        const cap = m.gainCap ?? lim.gainCap;
        let normal = pm.normal;
        const factor = softFactor(m, old, normal, m.softZone ?? lim.softZone);
        normal *= factor;
        const capped = cap > 0 && Math.abs(normal) > cap;
        if (capped) normal = Math.sign(normal) * cap;
        let next = locked ? old : clamp(round1(old + normal + pm.bypass), m.min, m.max);
        if (!locked && pm.set !== null) next = clamp(pm.set, m.min, m.max);
        let faded = 0;
        const quiet = pm.touched ? 0 : (before.quiet?.[m.id] ?? 0) + 1;
        if (!locked && !pm.touched && m.fade && quiet > m.fade.after && old !== m.fade.to) {
            const toward = old > m.fade.to ? -1 : 1;
            next = toward < 0 ? Math.max(m.fade.to, old - m.fade.amount) : Math.min(m.fade.to, old + m.fade.amount);
            faded = round1(next - old);
        }
        values[m.id] = next;
        meters[m.id] = {
            old, next, nominal: pm.normal, bypass: pm.bypass, set: pm.set, faded, quiet, factor: round1(factor), capped, locked: !!locked,
            scale: pm.normal ? normal / pm.normal : 1,
        };
    }

    // Spread each meter's actual change back over the events, for the chips.
    for (const a of applied) {
        if (!a.nominal) continue;
        for (const [mid, d] of Object.entries(a.nominal)) {
            const mm = meters[mid];
            if (mm.locked || mm.set !== null) { a.deltas[mid] = 0; continue; }
            a.deltas[mid] = round1(a.bypass ? d : d * mm.scale);
            if (mm.capped && !a.bypass) a.capped = true;
        }
        for (const mid of Object.keys(a.sets || {})) {
            const mm = meters[mid];
            if (!mm.locked) a.deltas[mid] = round1(mm.next - mm.old);
        }
    }

    const state = makeState(rb, values, before);
    state.quiet = Object.fromEntries(rb.meters.filter(m => m.fade).map(m => [m.id, meters[m.id].quiet]));
    for (const m of rb.meters) meters[m.id].level = state.levels[m.id];
    const fades = Object.fromEntries(Object.entries(meters).filter(([, x]) => x.faded).map(([id, x]) => [id, x.faded]));
    return { state, applied, meters, fades };
}

/**
 * Applies the judge's revisions of the previous turn to that turn's events.
 * Each revision: { index, action: 'cancel' | 'rerate', severity?, reason? }.
 */
export function reviseEvents(events, revisions) {
    const out = (events || []).map(e => ({ ...e }));
    for (const r of revisions || []) {
        const e = out[r.index];
        if (!e || e.cancelled) continue;
        if (r.action === 'cancel') { e.cancelled = true; e.revisedReason = r.reason || ''; }
        else if (r.action === 'rerate' && SEVERITIES.includes(r.severity) && r.severity !== e.severity) {
            e.originalSeverity = e.originalSeverity || e.severity;
            e.severity = r.severity;
            e.revisedReason = r.reason || '';
        }
    }
    return out;
}

// ---------- journal (recent major events) ----------

export function isMajor(rb, ev) {
    const from = rb.events[ev.type]?.journalFrom;
    return !!from && !ev.cancelled && sevRank(ev.severity) >= sevRank(from);
}

/**
 * Journal after a turn: earlier entries plus this turn's major events, newest last, at most 20.
 * An event that is still in the note's recent window isn't logged again (so a scene that carries on
 * over several turns is one entry, from when it started), unless it comes back at a higher severity,
 * which replaces the earlier entry.
 */
export function nextJournal(rb, journal, turn, applied) {
    const window = rb.limits?.recentTurns ?? 8;
    let out = [...(journal || [])];
    applied.forEach((a, i) => {
        if (!isMajor(rb, a)) return;
        const entry = { turn, key: `${turn}:${i}`, type: a.type, severity: a.severity, reason: a.reason || '' };
        const same = out.findIndex(j => j.type === a.type && turn - j.turn < window);
        if (same >= 0) {
            if (sevRank(a.severity) <= sevRank(out[same].severity)) return;
            out.splice(same, 1);
        }
        out.push(entry);
    });
    return out.slice(-20);
}

/** Journal with one turn's entries rebuilt after a revision. */
export function reviseJournal(rb, journal, turn, revisedEvents) {
    const kept = (journal || []).filter(j => j.turn !== turn);
    return nextJournal(rb, kept, turn, revisedEvents).sort((a, b) => a.turn - b.turn);
}

// ---------- the note for the main model ----------

/**
 * Builds the note sent to the main model. Levels that match the starting point send nothing,
 * because the character card already describes them (except transient meters, which always
 * describe their current level). Levels with an empty instruction send nothing. Returns '' when
 * there is nothing to say.
 * Keeps {{char}} and {{user}} as macros; SillyTavern substitutes them.
 */
export function composeNote(rb, state, start, journal, turn, opts = {}) {
    const lines = [];
    for (const m of rb.meters) {
        if (m.gate && !state.unlocked[m.id]) continue;
        const level = state.levels[m.id];
        const startLevel = start?.levels?.[m.id];
        // A fast (transient) meter is a state of the moment: the card's opening scene doesn't cover
        // it later on, so it's always described. Slow meters only when they've moved from the start.
        if (!m.transient && startLevel && level === startLevel) continue;
        const lv = m.levels.find(l => l.name === level);
        if (!lv?.instruction) continue;
        const num = opts.includeNumbers ? ` ${fmtValue(m, state.values[m.id])}` : '';
        const from = !m.transient && startLevel && startLevel !== level ? `began ${startLevel}, now ${level}${num}` : `${level}${num}`;
        lines.push(`- ${m.label} (${from}): ${lv.instruction}`);
    }
    const recent = (journal || []).filter(j => turn - j.turn < rb.limits.recentTurns);
    for (const j of recent) {
        const ago = turn - j.turn;
        const when = ago <= 0 ? 'this turn' : ago === 1 ? '1 turn ago' : `${ago} turns ago`;
        lines.push(`- Recent (${when}): ${j.reason || j.type}. {{char}} is still affected by it.`);
    }
    if (!lines.length) return '';
    return [opts.header || '', ...lines].filter(Boolean).join('\n');
}

export function fmtValue(meter, v) {
    const r = Math.round(v);
    return meter.min < 0 && r > 0 ? `+${r}` : String(r).replace('-', '−');
}

export function statusLine(rb, state) {
    const m = rb.meters.find(x => x.id === rb.statusMeter) || rb.meters[0];
    const lv = m?.levels.find(l => l.name === state.levels[m.id]);
    return lv?.status || '';
}

// ---------- parsing the judge's answer ----------

/** Pulls the first JSON object out of a model reply (tolerates code fences and chatter). */
export function extractJson(text) {
    if (text && typeof text === 'object') return text;
    const s = String(text || '').replace(/```(?:json)?/gi, '');
    const start = s.indexOf('{');
    if (start === -1) throw new Error('No JSON object in the reply.');
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < s.length; i++) {
        const c = s[i];
        if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
        if (c === '"') inStr = true;
        else if (c === '{') depth++;
        else if (c === '}' && --depth === 0) return JSON.parse(s.slice(start, i + 1));
    }
    throw new Error('The JSON object in the reply is incomplete.');
}

/** Keeps only well-formed events and revisions. */
export function cleanVerdict(rb, raw, prevEventCount = 0) {
    const events = (Array.isArray(raw?.events) ? raw.events : [])
        .filter(e => e && rb.events[e.type] && SEVERITIES.includes(e.severity))
        .map(e => ({ type: e.type, severity: e.severity, reason: String(e.reason || '').slice(0, 120) }));
    const revise = (Array.isArray(raw?.revise) ? raw.revise : [])
        .filter(r => r && Number.isInteger(Number(r.index)) && Number(r.index) >= 0 && Number(r.index) < prevEventCount
            && (r.action === 'cancel' || (r.action === 'rerate' && SEVERITIES.includes(r.severity))))
        .map(r => ({ index: Number(r.index), action: r.action, severity: r.severity, reason: String(r.reason || '').slice(0, 120) }));
    return { events, revise };
}

/** Keeps assessment values in range. */
export function cleanAssessment(rb, raw) {
    const out = {};
    const src = raw?.meters || raw || {};
    for (const m of rb.meters) {
        const r = src[m.id];
        const v = Number(typeof r === 'object' ? r?.value : r);
        out[m.id] = {
            value: Number.isFinite(v) ? clamp(Math.round(v), m.min, m.max) : m.start,
            reason: typeof r === 'object' ? String(r?.reason || '').slice(0, 200) : '',
        };
    }
    return out;
}
