// The rulebook builder: a floating window for making, editing, importing and exporting rulebooks.
// Edits go to a working copy (a draft) per rulebook; Save checks it and writes it to the library.
import { validateRulebook, SEVERITIES } from '../engine.js';
import { ctx, settings, saveSettings, newRulebookId } from '../state.js';
import { FloatingWindow, esc } from './window.js';

const PALETTE = ['#6aa8ef', '#3fbf9b', '#9b8cf0', '#e57aa2', '#ec8a5e', '#e86464', '#d9b45a', '#5fc3d6'];
const DEFAULT_LIMITS = { gainCap: 5, levelMargin: 5, softZone: 0.2, recentTurns: 8 };

let win = null;
let onSaved = () => {};
const drafts = {};          // id -> { rb, dirty, isNew }
let curId = null;
let sel = { kind: 'book' };
let query = '';
let jsonDraft = null;
let jsonError = '';
// A redraw while a button is being pressed would swallow its click: wait until the press ends.
let pressing = false;
let pendingRedraw = false;

// ---------- small helpers ----------

const clone = (x) => JSON.parse(JSON.stringify(x));
const num = (v) => (v === '' || v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));
const isSet = (v) => typeof v === 'string' && /^=\s*-?\d+(\.\d+)?$/.test(v.trim());
const slug = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9_]+/g, '_');
const words = (id) => { const s = String(id || '').replace(/_/g, ' ').trim(); return s ? s[0].toUpperCase() + s.slice(1) : 'Unnamed'; };
const cap = (s) => s[0].toUpperCase() + s.slice(1);
const uniq = (base, taken) => { let id = base, n = 2; while (taken.includes(id)) id = `${base}_${n++}`; return id; };
const str = (v) => (v === undefined || v === null ? '' : String(v));

/** The draft as the extension stores it: numbers as numbers, empty bits left out, levels sorted. */
export function normalize(draft) {
    const out = clone(draft);
    for (const m of out.meters || []) {
        for (const k of ['min', 'max', 'start', 'gainCap', 'softZone', 'levelMargin']) { const n = num(m[k]); if (n === null) delete m[k]; else m[k] = n; }
        if (m.fade) m.fade = { amount: num(m.fade.amount) ?? 0, to: num(m.fade.to) ?? 0, after: num(m.fade.after) ?? 0 };
        if (m.gate) m.gate = { meter: m.gate.meter, min: num(m.gate.min) ?? 0 };
        if (!m.transient) delete m.transient;
        if (!m.displayOnly) delete m.displayOnly;
        for (const l of m.levels || []) { l.from = num(l.from) ?? 0; if (!l.status) delete l.status; }
        (m.levels || []).sort((a, b) => a.from - b.from);
    }
    if (!out.statusMeter) delete out.statusMeter;
    if (out.limits) for (const k of Object.keys(out.limits)) { const n = num(out.limits[k]); if (n !== null) out.limits[k] = n; else delete out.limits[k]; }
    for (const ev of Object.values(out.events || {})) {
        const eff = ev.effects || {};
        for (const sev of Object.keys(eff)) {
            for (const mid of Object.keys(eff[sev] || {})) {
                const v = String(eff[sev][mid]).trim();
                if (v === '') delete eff[sev][mid];
                else eff[sev][mid] = num(v) ?? v;
            }
            if (!Object.keys(eff[sev] || {}).length) delete eff[sev];
        }
        if (ev.cooldown) {
            for (const [mid, c] of Object.entries(ev.cooldown)) {
                const o = typeof c === 'object' && c ? c : { turns: c };
                const turns = num(o.turns);
                if (turns === null) { delete ev.cooldown[mid]; continue; }
                ev.cooldown[mid] = { turns, cap: num(o.cap) ?? 0 };
            }
            if (!Object.keys(ev.cooldown).length) delete ev.cooldown;
        }
        if (!ev.always) delete ev.always;
        if (!ev.bypassCapFrom) delete ev.bypassCapFrom;
        if (!ev.journalFrom) delete ev.journalFrom;
    }
    return out;
}

function problemsOf(draft) {
    const { errors } = validateRulebook(normalize(draft));
    const extra = [];
    for (const [k, ev] of Object.entries(draft.events || {})) {
        const touched = Object.values(ev.effects || {}).some(e => Object.values(e || {}).some(v => String(v).trim() !== ''));
        if (!touched) extra.push(`Event "${k}" doesn't change any meter yet.`);
        for (const [sev, e] of Object.entries(ev.effects || {})) {
            for (const [mid, v] of Object.entries(e || {})) {
                const t = String(v).trim();
                if (t && num(t) === null && !isSet(t)) extra.push(`Event "${k}", ${sev}: "${t}" isn't a number or =N.`);
            }
        }
    }
    return [...errors, ...extra.filter(x => !errors.includes(x))];
}

function touches(ev) {
    const seen = [];
    for (const e of Object.values(ev.effects || {})) for (const [mid, v] of Object.entries(e || {})) if (String(v).trim() !== '' && !seen.includes(mid)) seen.push(mid);
    return seen;
}

function blankMeter(rb) {
    const ids = (rb.meters || []).map(m => m.id);
    return {
        id: uniq('new_meter', ids), label: 'New meter', min: 0, max: 100, start: 0, color: PALETTE[(rb.meters || []).length % PALETTE.length],
        levels: [{ from: 0, name: 'Low', status: 'Low', instruction: '' }, { from: 50, name: 'High', status: 'High', instruction: '' }],
    };
}

function renameMeter(rb, from, to) {
    for (const m of rb.meters) { if (m.id === from) m.id = to; if (m.gate?.meter === from) m.gate.meter = to; }
    if (rb.statusMeter === from) rb.statusMeter = to;
    for (const ev of Object.values(rb.events || {})) {
        for (const sev of Object.keys(ev.effects || {})) {
            const e = ev.effects[sev];
            if (!e || !(from in e)) continue;
            ev.effects[sev] = Object.fromEntries(Object.entries(e).map(([k, v]) => [k === from ? to : k, v]));
        }
        if (ev.cooldown && from in ev.cooldown) ev.cooldown = renameKey(ev.cooldown, from, to);
    }
}

function dropMeter(rb, id) {
    rb.meters = rb.meters.filter(m => m.id !== id);
    for (const m of rb.meters) if (m.gate?.meter === id) delete m.gate;
    if (rb.statusMeter === id) delete rb.statusMeter;
    for (const ev of Object.values(rb.events || {})) {
        for (const e of Object.values(ev.effects || {})) if (e) delete e[id];
        if (ev.cooldown) { delete ev.cooldown[id]; if (!Object.keys(ev.cooldown).length) delete ev.cooldown; }
    }
}

const renameKey = (obj, from, to) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k === from ? to : k, v]));

// ---------- drafts ----------

const library = () => settings().library;
function draft(id = curId) {
    if (!drafts[id] && library()[id]) drafts[id] = { rb: clone(library()[id]), dirty: false, isNew: false };
    return drafts[id];
}
const rb = () => draft()?.rb;
const meterById = (id) => (rb().meters || []).find(m => m.id === id);
const labelOf = (id) => { const m = meterById(id); return m ? (m.label || m.id) : id; };
const allIds = () => [...new Set([...Object.keys(library()), ...Object.keys(drafts).filter(id => drafts[id].isNew)])];
function markDirty() { draft().dirty = true; jsonDraft = null; jsonError = ''; }
function freshId(name) { let id = newRulebookId(name); let n = 2; const base = id; while (drafts[id]) id = `${base}-${n++}`; return id; }

// ---------- window ----------

export function createBuilder(onSave) {
    onSaved = onSave || (() => {});
    win = new FloatingWindow({ id: 'builder', title: 'Rulebook builder', width: 1040, height: 760, minWidth: 340, minHeight: 300 });
    win.body.classList.add('srb-builder');
    win.body.addEventListener('click', onClick);
    win.body.addEventListener('input', onInput);
    win.body.addEventListener('change', onChange);
    win.body.addEventListener('pointerdown', () => { pressing = true; }, true);
    window.addEventListener('pointerup', () => {
        pressing = false;
        if (pendingRedraw) setTimeout(() => { if (pendingRedraw) redraw(); }, 0);
    }, true);
    return win;
}

export const builder = () => win;

/** Opens the builder, on a library rulebook if given. */
export function openBuilder(id = null) {
    const ids = allIds();
    if (id && ids.includes(id)) { if (id !== curId) { curId = id; sel = { kind: 'book' }; } }
    else if (!curId || !ids.includes(curId)) { curId = ids[0] || null; sel = { kind: 'book' }; }
    if (!curId) newBook();
    renderAll();
    win.open();
}

/** Called when the library changes elsewhere (import, delete): drops drafts that no longer match. */
export function libraryChanged() {
    for (const id of Object.keys(drafts)) if (!drafts[id].isNew && !library()[id]) delete drafts[id];
    if (win?.isOpen) { if (!allIds().includes(curId)) curId = allIds()[0]; renderAll(); }
}

function flash(text, kind = 'ok') {
    const el = win.body.querySelector('[data-role="flash"]');
    if (!el) return;
    el.textContent = text;
    el.className = `srb-b-flash ${kind === 'warn' ? 'srb-b-flash-warn' : ''}`;
    el.hidden = !text;
}

// ---------- rendering ----------

function renderAll() {
    if (!curId || !draft()) return;
    win.setTitle('Rulebook builder', rb().name || curId);
    win.body.innerHTML = `
        <div class="srb-b-top">
            <label class="srb-b-pick"><span class="srb-sr">Rulebook to edit</span><select class="text_pole" data-act="open" data-role="pick"></select></label>
            <span class="srb-b-dirty" data-role="dirty"></span>
            <div class="srb-row srb-b-actions">
                <button type="button" class="menu_button" data-act="new">New</button>
                <button type="button" class="menu_button" data-act="duplicate">Duplicate</button>
                <button type="button" class="menu_button" data-act="import">Import</button>
                <button type="button" class="menu_button" data-act="export">Export</button>
                <button type="button" class="menu_button srb-danger" data-act="delete">Delete</button>
                <button type="button" class="menu_button" data-act="revert" data-role="revert">Undo changes</button>
                <button type="button" class="menu_button srb-primary" data-act="save">Save</button>
                <input type="file" accept=".json,application/json" data-role="file" hidden>
            </div>
        </div>
        <div class="srb-b-flash" data-role="flash" role="status" hidden></div>
        <div class="srb-b-cols">
            <nav class="srb-b-nav" aria-label="Rulebook parts">
                <div data-role="navtop"></div>
                <div class="srb-b-navhead"><span>Meters <span class="srb-muted" data-role="mcount"></span></span><button type="button" class="menu_button" data-act="add-meter">Add</button></div>
                <div class="srb-b-list" data-role="meters"></div>
                <div class="srb-b-navhead"><span>Events <span class="srb-muted" data-role="ecount"></span></span><button type="button" class="menu_button" data-act="add-event">Add</button></div>
                <input type="search" class="text_pole srb-b-search" data-role="q" placeholder="Search events" aria-label="Search events" value="${esc(query)}">
                <div class="srb-b-list srb-b-events" data-role="events"></div>
            </nav>
            <main class="srb-b-main" data-role="main"></main>
        </div>`;
    win.body.querySelector('[data-role="file"]').addEventListener('change', importFile);
    renderTop();
    renderNav();
    renderMain();
}

function redraw() {
    pendingRedraw = false;
    renderTop();
    renderNav();
    renderMain();
}

/** Redraws now, or once the current click finishes. */
function redrawSoon() { if (pressing) pendingRedraw = true; else redraw(); }

function renderTop() {
    const pick = win.body.querySelector('[data-role="pick"]');
    if (!pick) return;
    pick.innerHTML = allIds().map(id => {
        const d = drafts[id];
        const name = d ? d.rb.name : library()[id]?.name;
        return `<option value="${esc(id)}">${esc(name || id)}${d?.dirty ? ' •' : ''}${d?.isNew ? ' (new)' : ''}</option>`;
    }).join('');
    pick.value = curId;
    const d = draft();
    const dirty = win.body.querySelector('[data-role="dirty"]');
    dirty.textContent = d.isNew ? 'Not saved yet' : d.dirty ? 'Unsaved changes' : 'Saved';
    dirty.classList.toggle('srb-warn', d.dirty || d.isNew);
    win.body.querySelector('[data-role="revert"]').disabled = !d.dirty && !d.isNew;
    win.setTitle('Rulebook builder', rb().name || curId);
}

function navItem(act, id, on, title, sub, dot = '') {
    return `<button type="button" class="srb-b-item ${on ? 'srb-on' : ''}" data-act="${act}" data-id="${esc(id)}" ${on ? 'aria-current="true"' : ''}>
        ${dot ? `<span class="srb-b-dot" style="background:${esc(dot)}"></span>` : ''}
        <span class="srb-b-itext"><span class="srb-b-ititle">${esc(title)}</span><span class="srb-b-isub">${esc(sub)}</span></span></button>`;
}

function renderNav() {
    const r = rb();
    const probs = problemsOf(r);
    const badge = `<span class="srb-b-badge ${probs.length ? 'srb-b-badge-warn' : ''}">${probs.length ? `${probs.length} problem${probs.length > 1 ? 's' : ''}` : 'OK'}</span>`;
    win.body.querySelector('[data-role="navtop"]').innerHTML = `
        <button type="button" class="srb-b-item ${sel.kind === 'book' ? 'srb-on' : ''}" data-act="sel-book"><span class="srb-b-itext"><span class="srb-b-ititle">Overview</span><span class="srb-b-isub">Name, status line, limits</span></span>${badge}</button>
        ${navItem('sel-json', '', sel.kind === 'json', 'JSON', 'See, copy or paste the whole rulebook')}`;
    win.body.querySelector('[data-role="mcount"]').textContent = (r.meters || []).length;
    win.body.querySelector('[data-role="meters"]').innerHTML = (r.meters || []).map(m => {
        const lo = num(m.min);
        const bits = [lo !== null && lo < 0 ? `Two-sided ${str(m.min)} to ${str(m.max)}` : `${str(m.min)} to ${str(m.max)}`, `${(m.levels || []).length} levels`];
        if (m.gate) bits.push(`locked until ${labelOf(m.gate.meter)} ${str(m.gate.min)}`);
        if (m.fade) bits.push('drifts');
        if (m.transient) bits.push('fast');
        if (m.displayOnly) bits.push('display only');
        return navItem('sel-meter', m.id, sel.kind === 'meter' && sel.id === m.id, m.label || m.id, bits.join(' · '), m.color || '#888');
    }).join('') || '<div class="srb-hint">No meters yet.</div>';
    const ids = Object.keys(r.events || {});
    win.body.querySelector('[data-role="ecount"]').textContent = ids.length;
    const q = query.trim().toLowerCase();
    const shown = ids.filter(k => !q || `${k} ${words(k)} ${r.events[k].description || ''} ${touches(r.events[k]).map(labelOf).join(' ')}`.toLowerCase().includes(q));
    win.body.querySelector('[data-role="events"]').innerHTML = shown.map(k => {
        const ev = r.events[k], t = touches(ev).map(labelOf);
        return navItem('sel-event', k, sel.kind === 'event' && sel.id === k, words(k), `${t.length ? t.join(', ') : 'No effects yet'}${ev.always ? ' · always counts' : ''}`);
    }).join('') || `<div class="srb-hint">${q ? 'No events match.' : 'No events yet.'}</div>`;
}

const field = (label, inner, cls = '') => `<label class="srb-b-field ${cls}"><span>${label}</span>${inner}</label>`;
const input = (bind, value, attrs = '') => `<input type="text" class="text_pole" data-bind="${esc(bind)}" value="${esc(str(value))}" ${attrs}>`;
const select = (bind, value, options) => `<select class="text_pole" data-bind="${esc(bind)}">${options.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(value ?? '') ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
const textarea = (bind, value, rows = 3, attrs = '') => `<textarea class="text_pole" rows="${rows}" data-bind="${esc(bind)}" ${attrs}>${esc(str(value))}</textarea>`;
const check = (bind, on, label, hint = '') => `<label class="srb-b-check"><input type="checkbox" data-bind="${esc(bind)}" ${on ? 'checked' : ''}><span>${label}${hint ? `<span class="srb-hint srb-block">${hint}</span>` : ''}</span></label>`;
const TOKENS = 'Use {{char}} and {{user}} for the names.';

function renderMain() {
    const main = win.body.querySelector('[data-role="main"]');
    if (!main) return;
    const r = rb();
    if (sel.kind === 'meter' && !meterById(sel.id)) sel = { kind: 'book' };
    if (sel.kind === 'event' && !r.events?.[sel.id]) sel = { kind: 'book' };
    // Keep focus and scroll across a redraw.
    const active = document.activeElement;
    const keep = active && main.contains(active) && active.dataset.bind ? { bind: active.dataset.bind, start: active.selectionStart, end: active.selectionEnd } : null;
    const scroll = main.scrollTop;
    main.innerHTML = sel.kind === 'meter' ? meterPage(meterById(sel.id)) : sel.kind === 'event' ? eventPage(sel.id) : sel.kind === 'json' ? jsonPage() : bookPage();
    main.scrollTop = scroll;
    if (keep) {
        const el = main.querySelector(`[data-bind="${CSS.escape(keep.bind)}"]`);
        if (el) { el.focus(); try { if (keep.start !== null && keep.start !== undefined) el.setSelectionRange(keep.start, keep.end); } catch { /* not a text field */ } }
    }
}

function bookPage() {
    const r = rb();
    const limits = { ...DEFAULT_LIMITS, ...(r.limits || {}) };
    const probs = problemsOf(r);
    const lim = [
        ['gainCap', 'Most a meter can gain in one turn', 'points', 'Stops one big moment from jumping a slow meter. Serious losses can be set to ignore it, per event.'],
        ['levelMargin', 'Margin before dropping back a level', 'points', 'Stops a meter flickering between two levels when it sits on the line.'],
        ['softZone', 'Slow down near the ends', '% of the range', 'Changes shrink inside this band at each end, so the extremes are hard to reach.'],
        ['recentTurns', 'Major events stay in the note for', 'turns', 'How long the journal reminds the main model of a big moment.'],
    ];
    return `<section class="srb-b-card">
        <h3>Overview</h3>
        <div class="srb-b-grid2">
            ${field('Name', input('book.name', r.name))}
            ${field('Meter shown in the status line', select('book.statusMeter', r.statusMeter || '', [['', 'None'], ...(r.meters || []).map(m => [m.id, m.label || m.id])]))}
        </div>
        ${field('Description (for you; the judge never sees it)', textarea('book.description', r.description, 2))}
        <h4>Limits for every meter</h4>
        <div class="srb-hint">A meter can override these on its own page.</div>
        <div class="srb-b-grid2">${lim.map(([k, label, unit, help]) => field(label, `<span class="srb-b-unit">${input(`limit.${k}`, k === 'softZone' && num(limits[k]) !== null ? Math.round(num(limits[k]) * 100) : limits[k], 'inputmode="decimal"')}<span class="srb-hint">${unit}</span></span><span class="srb-hint">${help}</span>`)).join('')}</div>
        <h4>Check</h4>
        ${probs.length ? `<ul class="srb-b-problems">${probs.map(p => `<li>${esc(p)}</li>`).join('')}</ul><div class="srb-hint">A rulebook with problems can't be saved.</div>` : `<div class="srb-b-ok">No problems found. ${(r.meters || []).length} meters and ${Object.keys(r.events || {}).length} events.</div>`}
    </section>`;
}

function levelInfo(m) {
    const lo = num(m.min), hi = num(m.max);
    const span = lo !== null && hi !== null && hi > lo ? hi - lo : null;
    const froms = (m.levels || []).map(l => num(l.from)).filter(n => n !== null).sort((a, b) => a - b);
    const nextFrom = (f) => froms.find(x => x > f) ?? hi;
    const range = (l) => { const f = num(l.from); if (f === null || hi === null) return ''; return `${f} to ${nextFrom(f)}`; };
    return { lo, hi, span, froms, nextFrom, range };
}

function barHtml(m) {
    const { lo, span, nextFrom, range } = levelInfo(m);
    const lv = m.levels || [];
    const segs = lv.map((l, i) => {
        const f = num(l.from);
        const w = span && f !== null ? Math.max(0, (nextFrom(f) - f) / span * 100) : 0;
        const op = 0.3 + 0.7 * (lv.length > 1 ? i / (lv.length - 1) : 1);
        return `<span class="srb-b-seg" title="${esc(`${l.name || 'Level'}: ${range(l)}`)}" style="flex:0 0 ${w.toFixed(2)}%;background:${esc(m.color || '#888')};opacity:${op.toFixed(2)}"></span>`;
    }).join('');
    const st = num(m.start);
    const pct = span && st !== null ? Math.min(100, Math.max(0, (st - lo) / span * 100)) : null;
    return `<div class="srb-b-barlabels"><span>${esc(str(m.min))}</span><span>Levels across the range · the white mark is the fallback start</span><span>${esc(str(m.max))}</span></div>
        <div class="srb-b-bar">${segs}${pct !== null ? `<span class="srb-b-mark" style="left:${pct.toFixed(2)}%"></span>` : ''}</div>`;
}

function fadeSentence(m) {
    if (!m.fade) return '';
    return num(m.fade.after)
        ? `Nothing happens for the first ${str(m.fade.after)} quiet turns. From then on it moves ${str(m.fade.amount)} a turn towards ${str(m.fade.to)} until something touches it again.`
        : `It moves ${str(m.fade.amount)} towards ${str(m.fade.to)} on every turn where nothing touches it.`;
}

function meterPage(m) {
    const r = rb();
    const { range } = levelInfo(m);
    const lo = num(m.min);
    const others = (r.meters || []).filter(x => x.id !== m.id);
    const used = Object.keys(r.events || {}).filter(k => touches(r.events[k]).includes(m.id)).map(words);
    const gates = (r.meters || []).filter(x => x.gate?.meter === m.id).map(x => x.label || x.id);
    const limits = { ...DEFAULT_LIMITS, ...(r.limits || {}) };
    const P = `meter.${m.id}`;
    return `<section class="srb-b-card">
        <div class="srb-row srb-between"><h3 class="srb-b-h"><span class="srb-b-dot" style="background:${esc(m.color || '#888')}"></span><span data-live="title">${esc(m.label || m.id)}</span></h3>
            <button type="button" class="menu_button srb-danger" data-act="delete-meter">Delete meter</button></div>
        <div class="srb-b-grid3">
            ${field('Name', input(`${P}.label`, m.label))}
            ${field('ID (used by events)', input(`${P}.id`, m.id))}
            ${field('Colour', `<input type="color" class="srb-b-color" data-bind="${esc(P)}.color" value="${esc(m.color || '#888888')}">`)}
            ${field('Lowest value', input(`${P}.min`, m.min, 'inputmode="numeric"'))}
            ${field('Highest value', input(`${P}.max`, m.max, 'inputmode="numeric"'))}
            ${field('Fallback start', input(`${P}.start`, m.start, 'inputmode="numeric"'))}
        </div>
        <div class="srb-hint">${lo !== null && lo < 0 ? 'Two-sided: the negative end means the opposite of the positive one.' : 'One-sided: it measures how much, from none upwards.'} Each chat's real starting point comes from the assessment; the fallback is used only when there isn't one.</div>
        <div data-live="bar">${barHtml(m)}</div>

        <h4>Behaviour</h4>
        <div class="srb-row srb-b-gate">
            ${field('Available', select(`${P}.gate.meter`, m.gate?.meter || '', [['', 'From the start'], ...others.map(x => [x.id, `Once ${x.label || x.id}…`])]))}
            ${m.gate ? `${field('reaches at least', input(`${P}.gate.min`, m.gate.min, 'inputmode="numeric"'), 'srb-b-narrow')}<span class="srb-hint">Once open, it stays open.</span>` : ''}
        </div>
        <div class="srb-b-box">
            ${check(`${P}.fade`, !!m.fade, 'Drifts back on its own when nothing touches it')}
            ${m.fade ? `<div class="srb-row srb-b-fade">
                ${field('After this many quiet turns', input(`${P}.fade.after`, m.fade.after ?? 0, 'inputmode="numeric"'), 'srb-b-narrow')}
                ${field('it moves by', input(`${P}.fade.amount`, m.fade.amount, 'inputmode="numeric"'), 'srb-b-narrow')}
                ${field('each turn, towards', input(`${P}.fade.to`, m.fade.to, 'inputmode="numeric"'), 'srb-b-narrow')}
            </div><div class="srb-hint" data-live="fade">${esc(fadeSentence(m))}</div>` : ''}
        </div>
        ${check(`${P}.transient`, !!m.transient, 'Fast meter', 'Always described in the note, even at its starting level. For in-the-moment states the card can\'t cover.')}
        ${check(`${P}.displayOnly`, !!m.displayOnly, 'Display only', 'Scored and shown in the extension, but never sent to the main model: no line in the note at any level. Events still change it, and its events can still go in the journal.')}
        <div class="srb-b-sub">Limits for this meter only <span class="srb-hint">(leave blank to use the rulebook's)</span></div>
        <div class="srb-b-grid3">
            ${[['gainCap', 'Most gained per turn'], ['levelMargin', 'Level margin'], ['softZone', 'Slow-down band (0 to 1)']].map(([k, l]) => field(l, input(`${P}.${k}`, m[k], `inputmode="decimal" placeholder="Rulebook: ${esc(str(limits[k]))}"`))).join('')}
        </div>

        <div class="srb-row srb-between srb-b-levelhead"><h4>Levels</h4><button type="button" class="menu_button" data-act="add-level">Add level</button></div>
        <div class="srb-hint">${m.displayOnly ? 'This meter is display only, so these instructions are never sent. They\'re kept in case you turn it back on.' : `The instruction is what the main model is told while the meter sits in that level. ${esc(TOKENS)} An empty instruction sends nothing for that level.`}</div>
        ${(m.levels || []).map((l, i) => `<div class="srb-b-level">
            <div class="srb-b-levelside">
                ${field('From', input(`${P}.level.${i}.from`, l.from, 'inputmode="numeric"'), 'srb-b-from')}
                ${field('Name', input(`${P}.level.${i}.name`, l.name))}
                <span class="srb-hint srb-b-span2">${range(l) ? `Covers ${esc(range(l))}` : ''}</span>
                ${field('Status word', input(`${P}.level.${i}.status`, l.status, `placeholder="${esc(l.name || '')}"`), 'srb-b-span2')}
            </div>
            <div class="srb-b-levelmain">
                ${field('Instruction', textarea(`${P}.level.${i}.instruction`, l.instruction, 3, 'placeholder="Leave empty to send nothing at this level."'))}
                <button type="button" class="menu_button" data-act="remove-level" data-i="${i}" aria-label="Remove level ${esc(l.name || i + 1)}">Remove level</button>
            </div>
        </div>`).join('')}
        <div class="srb-hint srb-b-usedby">${used.length ? `Changed by ${used.length} event${used.length === 1 ? '' : 's'}: ${esc(used.join(', '))}.` : 'No event changes this meter yet.'}${gates.length ? ` Unlocks ${esc(gates.join(', '))}.` : ''}${r.statusMeter === m.id ? ' Shown in the status line.' : ''}</div>
    </section>`;
}

const cellClass = (v) => { const t = String(v ?? '').trim(); if (!t) return ''; if (isSet(t)) return 'srb-b-set'; const n = num(t); if (n === null) return 'srb-b-bad'; return n < 0 ? 'srb-b-neg' : n > 0 ? 'srb-b-pos' : ''; };

function eventPage(k) {
    const r = rb();
    const ev = r.events[k];
    const cols = r.meters || [];
    const P = `event.${k}`;
    const sevOpts = [['', 'Never'], ...SEVERITIES.map(s => [s, `${cap(s)} and up`])];
    return `<section class="srb-b-card">
        <div class="srb-row srb-between"><h3 data-live="title">${esc(words(k))}</h3><button type="button" class="menu_button srb-danger" data-act="delete-event">Delete event</button></div>
        ${field('ID (what the judge reports)', input(`${P}.id`, k), 'srb-b-idfield')}
        ${field('What the judge is told', textarea(`${P}.description`, ev.description, 3))}
        <div class="srb-hint">${esc(TOKENS)} Severity hints in brackets help the judge rate it.</div>
        <h4>What each severity does</h4>
        <div class="srb-hint">A number changes the meter by that much. =N sets it to N (for a reset). Blank leaves it alone.</div>
        <div class="srb-b-tablebox"><table class="srb-b-table" style="min-width:${110 + cols.length * 84}px">
            <thead><tr><th scope="col">Severity</th>${cols.map(c => `<th scope="col"><span class="srb-b-dot" style="background:${esc(c.color || '#888')}"></span>${esc(c.label || c.id)}</th>`).join('')}</tr></thead>
            <tbody>${SEVERITIES.map(s => `<tr><th scope="row">${cap(s)}</th>${cols.map(c => {
                const v = ev.effects?.[s]?.[c.id];
                return `<td><input type="text" class="text_pole ${cellClass(v)}" data-bind="${esc(P)}.effect.${s}.${esc(c.id)}" value="${esc(str(v))}" aria-label="${esc(`${cap(s)}, ${c.label || c.id}`)}"></td>`;
            }).join('')}</tr>`).join('')}</tbody>
        </table></div>
        <h4>Cooldown</h4>
        <div class="srb-hint">Stops a meter climbing straight back up after this event, for example arousal after a climax. Starts on the next turn; drops and drifting back still happen.</div>
        ${Object.entries(ev.cooldown || {}).map(([mid, c]) => {
            const o = typeof c === 'object' && c ? c : { turns: c, cap: 0 };
            return `<div class="srb-row srb-b-cool">
                <span>After this event,</span>
                ${field('Meter', select(`${P}.cool.${mid}.meter`, mid, cols.map(m => [m.id, m.label || m.id])), 'srb-b-coolmeter')}
                <span>can rise by at most</span>
                ${field('Points a turn', input(`${P}.cool.${mid}.cap`, o.cap ?? 0, 'inputmode="numeric"'), 'srb-b-narrow')}
                <span>for the next</span>
                ${field('Turns', input(`${P}.cool.${mid}.turns`, o.turns, 'inputmode="numeric"'), 'srb-b-narrow')}
                <button type="button" class="menu_button" data-act="remove-cool" data-id="${esc(mid)}" aria-label="Remove the cooldown on ${esc(labelOf(mid))}">Remove</button>
            </div>`;
        }).join('')}
        <div class="srb-row"><button type="button" class="menu_button" data-act="add-cool" ${cols.length ? '' : 'disabled'}>Add cooldown</button></div>
        <div class="srb-row srb-b-evopts">
            ${field('Losses ignore the per-turn cap from', select(`${P}.bypassCapFrom`, ev.bypassCapFrom || '', sevOpts))}
            ${field('Goes in the journal from', select(`${P}.journalFrom`, ev.journalFrom || '', sevOpts))}
            ${check(`${P}.always`, !!ev.always, 'Always counts', 'Counted even when it\'s expected at the current level. Use for physical or one-off moments.')}
        </div>
    </section>`;
}

function jsonPage() {
    const text = jsonDraft ?? JSON.stringify(normalize(rb()), null, 2);
    return `<section class="srb-b-card srb-b-jsoncard">
        <div class="srb-row srb-between"><h3>JSON</h3>
            <div class="srb-row">
                <button type="button" class="menu_button" data-act="json-copy">Copy</button>
                <button type="button" class="menu_button" data-act="json-reset" ${jsonDraft === null ? 'disabled' : ''}>Discard edits</button>
                <button type="button" class="menu_button srb-primary" data-act="json-apply" ${jsonDraft === null ? 'disabled' : ''}>Apply</button>
            </div></div>
        <div class="srb-hint">This is exactly what the extension stores. Edit or paste here, then Apply to load it into the form.</div>
        ${jsonError ? `<div class="srb-b-problems srb-b-jsonerr" role="alert">${esc(jsonError)}</div>` : ''}
        <textarea class="text_pole srb-json srb-b-json" spellcheck="false" data-role="json" aria-label="Rulebook JSON">${esc(text)}</textarea>
    </section>`;
}

/** Updates the parts of the page that follow what you type, without redrawing the field you're in. */
function live() {
    renderTop();
    renderNav();
    const main = win.body.querySelector('[data-role="main"]');
    if (sel.kind === 'meter') {
        const m = meterById(sel.id);
        if (!m) return;
        const t = main.querySelector('[data-live="title"]'); if (t) t.textContent = m.label || m.id;
        const b = main.querySelector('[data-live="bar"]'); if (b) b.innerHTML = barHtml(m);
        const f = main.querySelector('[data-live="fade"]'); if (f) f.textContent = fadeSentence(m);
    }
}

// ---------- editing ----------

/** Applies one field. Returns true when the page should be redrawn now (structure changed). */
function apply(bind, el) {
    const r = rb();
    const v = el.type === 'checkbox' ? el.checked : el.value;
    const parts = bind.split('.');
    markDirty();
    if (parts[0] === 'book') {
        const k = parts[1];
        if (k === 'statusMeter') { if (v) r.statusMeter = v; else delete r.statusMeter; return false; }
        r[k] = v;
        return false;
    }
    if (parts[0] === 'limit') {
        r.limits = r.limits || {};
        r.limits[parts[1]] = parts[1] === 'softZone' && num(v) !== null ? num(v) / 100 : v;
        return false;
    }
    if (parts[0] === 'meter') {
        const id = parts[1], m = meterById(id), k = parts[2];
        if (!m) return true;
        if (k === 'id') return false; // handled on change, so half-typed ids don't collide
        if (k === 'gate') {
            if (parts[3] === 'meter') { if (!v) delete m.gate; else m.gate = { meter: v, min: m.gate?.min ?? 50 }; return true; }
            if (m.gate) m.gate.min = v;
            return false;
        }
        if (k === 'fade') {
            if (parts.length === 3) { if (v) m.fade = { amount: 10, to: num(m.min) ?? 0, after: 3 }; else delete m.fade; return true; }
            if (m.fade) m.fade[parts[3]] = v;
            return false;
        }
        if (k === 'transient') { if (v) m.transient = true; else delete m.transient; return false; }
        if (k === 'displayOnly') { if (v) m.displayOnly = true; else delete m.displayOnly; return true; }
        if (k === 'level') { const l = m.levels?.[Number(parts[3])]; if (l) l[parts[4]] = v; return false; }
        if (['gainCap', 'softZone', 'levelMargin'].includes(k)) { if (String(v).trim() === '') delete m[k]; else m[k] = v; return false; }
        m[k] = v;
        return false;
    }
    if (parts[0] === 'event') {
        const k = parts[1], ev = r.events?.[k], f = parts[2];
        if (!ev) return true;
        if (f === 'id') return false; // handled on change, so half-typed ids don't collide
        if (f === 'effect') {
            const [, , , sev, mid] = parts;
            ev.effects = ev.effects || {};
            ev.effects[sev] = ev.effects[sev] || {};
            if (String(v).trim() === '') delete ev.effects[sev][mid]; else ev.effects[sev][mid] = v;
            el.className = `text_pole ${cellClass(v)}`;
            return false;
        }
        if (f === 'cool') {
            const mid = parts[3], what = parts[4];
            ev.cooldown = ev.cooldown || {};
            const cur = ev.cooldown[mid];
            const o = typeof cur === 'object' && cur ? cur : { turns: cur ?? 3, cap: 0 };
            if (what === 'meter') {
                if (v === mid) return false;
                if (v in ev.cooldown) { flash(`This event already has a cooldown on ${labelOf(v)}.`, 'warn'); return true; }
                ev.cooldown = renameKey({ ...ev.cooldown, [mid]: o }, mid, v);
                return true;
            }
            o[what] = v;
            ev.cooldown[mid] = o;
            return false;
        }
        if (f === 'always') { if (v) ev.always = true; else delete ev.always; return false; }
        if (f === 'bypassCapFrom' || f === 'journalFrom') { if (v) ev[f] = v; else delete ev[f]; return false; }
        ev[f] = v;
        return false;
    }
    return false;
}

function onInput(e) {
    const t = e.target;
    if (t.dataset.role === 'q') { query = t.value; renderNav(); return; }
    if (t.dataset.role === 'json') { jsonDraft = t.value; jsonError = ''; win.body.querySelectorAll('[data-act="json-reset"],[data-act="json-apply"]').forEach(b => { b.disabled = false; }); return; }
    if (!t.dataset.bind || t.type === 'checkbox' || t.tagName === 'SELECT') return;
    if (/^(event|meter)\.[^.]+\.id$/.test(t.dataset.bind)) return;
    if (apply(t.dataset.bind, t)) renderMain(); else live();
}

function onChange(e) {
    const t = e.target;
    if (t.dataset.act === 'open') { curId = t.value; sel = { kind: 'book' }; jsonDraft = null; jsonError = ''; renderAll(); return; }
    if (!t.dataset.bind) return;
    const bind = t.dataset.bind;
    if (/^meter\.[^.]+\.id$/.test(bind)) {
        const old = bind.split('.')[1], nid = slug(t.value);
        if (!nid) { t.value = old; return; }
        if (nid !== old) {
            if (meterById(nid)) { flash(`Another meter already uses the ID "${nid}".`, 'warn'); t.value = old; return; }
            markDirty();
            renameMeter(rb(), old, nid);
            sel = { kind: 'meter', id: nid };
        }
        redrawSoon();
        return;
    }
    if (bind.startsWith('event.') && bind.endsWith('.id')) {
        const old = bind.split('.')[1], nid = slug(t.value);
        if (!nid) { t.value = old; return; }
        if (nid !== old) {
            if (rb().events[nid]) { flash(`Another event already uses the ID "${nid}".`, 'warn'); t.value = old; return; }
            markDirty();
            rb().events = renameKey(rb().events, old, nid);
            sel = { kind: 'event', id: nid };
        }
        redrawSoon();
        return;
    }
    if (t.type === 'checkbox' || t.tagName === 'SELECT' || t.type === 'color') apply(bind, t);
    // Text fields were applied as you typed; redraw now that the field is finished (ranges, sorting, labels).
    redrawSoon();
}

async function onClick(e) {
    const b = e.target.closest('[data-act]');
    if (!b || b.tagName === 'SELECT') return;
    const act = b.dataset.act;
    const r = rb();
    if (act === 'sel-book') sel = { kind: 'book' };
    else if (act === 'sel-json') sel = { kind: 'json' };
    else if (act === 'sel-meter') sel = { kind: 'meter', id: b.dataset.id };
    else if (act === 'sel-event') sel = { kind: 'event', id: b.dataset.id };
    else if (act === 'add-meter') { markDirty(); const m = blankMeter(r); r.meters = [...(r.meters || []), m]; sel = { kind: 'meter', id: m.id }; }
    else if (act === 'add-event') {
        markDirty();
        const id = uniq('new_event', Object.keys(r.events || {}));
        r.events = { ...(r.events || {}), [id]: { description: '', effects: {} } };
        sel = { kind: 'event', id }; query = '';
        const q = win.body.querySelector('[data-role="q"]'); if (q) q.value = '';
    }
    else if (act === 'delete-meter') {
        const m = meterById(sel.id);
        const used = Object.keys(r.events || {}).filter(k => touches(r.events[k]).includes(m.id)).length;
        const ok = await ctx().Popup.show.confirm('Delete this meter?', `"${esc(m.label || m.id)}" will be removed${used ? `, along with its effects in ${used} event${used === 1 ? '' : 's'}` : ''}. Nothing is saved until you press Save.`);
        if (!ok) return;
        markDirty(); dropMeter(r, m.id); sel = { kind: 'book' };
    }
    else if (act === 'delete-event') { markDirty(); delete r.events[sel.id]; flash(`Deleted the ${words(sel.id)} event. Nothing is saved until you press Save.`); sel = { kind: 'book' }; }
    else if (act === 'add-cool') {
        const ev = r.events[sel.id];
        const free = (r.meters || []).find(m => !(m.id in (ev.cooldown || {})));
        if (!free) { flash('Every meter already has a cooldown on this event.', 'warn'); return; }
        markDirty();
        ev.cooldown = { ...(ev.cooldown || {}), [free.id]: { turns: 3, cap: 0 } };
    }
    else if (act === 'remove-cool') {
        const ev = r.events[sel.id];
        markDirty();
        delete ev.cooldown[b.dataset.id];
        if (!Object.keys(ev.cooldown).length) delete ev.cooldown;
    }
    else if (act === 'add-level') {
        const m = meterById(sel.id), { hi, froms, lo } = levelInfo(m);
        const top = froms.length ? froms[froms.length - 1] : (lo ?? 0);
        markDirty();
        m.levels = [...(m.levels || []), { from: hi !== null ? Math.round(top + (hi - top) / 2) : top + 10, name: 'New level', status: '', instruction: '' }];
    }
    else if (act === 'remove-level') { markDirty(); meterById(sel.id).levels.splice(Number(b.dataset.i), 1); }
    else if (act === 'json-copy') {
        const text = jsonDraft ?? JSON.stringify(normalize(r), null, 2);
        try { await navigator.clipboard.writeText(text); flash('Copied the JSON.'); } catch { flash('Couldn\'t copy here: select the text and copy it instead.', 'warn'); }
        return;
    }
    else if (act === 'json-reset') { jsonDraft = null; jsonError = ''; }
    else if (act === 'json-apply') {
        try {
            const parsed = JSON.parse(jsonDraft);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('it must be one JSON object.');
            parsed.id = curId;
            draft().rb = parsed;
            markDirty();
            flash('Loaded the JSON into the form.');
        } catch (err) { jsonError = `Couldn't read that: ${err.message}`; }
    }
    else if (act === 'new') return newBook();
    else if (act === 'duplicate') {
        const copy = clone(normalize(r));
        copy.name = `Copy of ${r.name || curId}`;
        addDraft(copy, 'Made a copy. It isn\'t in your library until you press Save.');
        return;
    }
    else if (act === 'import') { win.body.querySelector('[data-role="file"]').click(); return; }
    else if (act === 'export') return exportBook();
    else if (act === 'delete') return deleteBook();
    else if (act === 'revert') return revertBook();
    else if (act === 'save') return saveBook();
    else return;
    redraw();
}

// ---------- library actions ----------

function addDraft(book, msg) {
    const id = freshId(book.name || 'rulebook');
    book.id = id;
    drafts[id] = { rb: book, dirty: true, isNew: true };
    curId = id;
    sel = { kind: 'book' };
    jsonDraft = null; jsonError = '';
    renderAll();
    if (msg) flash(msg);
}

function newBook() {
    const b = { name: 'New rulebook', description: '', limits: { ...DEFAULT_LIMITS }, meters: [], events: {} };
    b.meters.push(blankMeter(b));
    addDraft(b, 'Started a new rulebook. Add meters and events, then Save.');
}

function saveBook() {
    const d = draft();
    const probs = problemsOf(d.rb);
    if (probs.length) {
        sel = { kind: 'book' };
        renderNav(); renderMain();
        flash(`Not saved: ${probs.length} problem${probs.length > 1 ? 's' : ''} to fix first (listed in the Overview).`, 'warn');
        return;
    }
    const out = normalize(d.rb);
    out.id = curId;
    library()[curId] = out;
    saveSettings();
    drafts[curId] = { rb: clone(out), dirty: false, isNew: false };
    jsonDraft = null; jsonError = '';
    renderTop(); renderNav(); renderMain();
    flash('Saved. Chats using this rulebook use the new version from their next turn.');
    onSaved();
}

async function revertBook() {
    const d = draft();
    if (d.isNew) {
        const ok = await ctx().Popup.show.confirm('Discard this rulebook?', 'It hasn\'t been saved, so it will be gone.');
        if (!ok) return;
        delete drafts[curId];
        curId = Object.keys(library())[0] || null;
        if (!curId) return newBook();
    } else {
        drafts[curId] = { rb: clone(library()[curId]), dirty: false, isNew: false };
    }
    sel = { kind: 'book' }; jsonDraft = null; jsonError = '';
    renderAll();
    flash('Went back to the last saved version.');
}

function usedBy(id) {
    const chars = ctx().characters || [];
    return Object.entries(settings().assignments).filter(([, r]) => r === id).map(([av]) => chars.find(c => c.avatar === av)?.name).filter(Boolean);
}

async function deleteBook() {
    const d = draft();
    if (d.isNew) return revertBook();
    const s = settings();
    if (Object.keys(s.library).length < 2) { flash('Keep at least one rulebook in the library.', 'warn'); return; }
    const users = usedBy(curId);
    const ok = await ctx().Popup.show.confirm('Delete rulebook?', `"${esc(d.rb.name || curId)}" will be removed from the library${users.length ? ` and unassigned from ${esc(users.join(', '))}` : ''}. Chats that use it will stop judging until you attach another.`);
    if (!ok) return;
    delete s.library[curId];
    for (const [av, r] of Object.entries(s.assignments)) if (r === curId) delete s.assignments[av];
    delete drafts[curId];
    saveSettings();
    curId = Object.keys(s.library)[0];
    sel = { kind: 'book' };
    renderAll();
    flash('Deleted.');
    onSaved();
}

function exportBook() {
    const out = normalize(rb());
    out.id = curId;
    const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${curId}.rulebook.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    if (draft().dirty) flash('Exported, including your unsaved changes.');
}

async function importFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
        if (file.size > 2 * 1024 * 1024) throw new Error('The file is over 2 MB.');
        const json = JSON.parse(await file.text());
        if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('The file must hold one rulebook object.');
        const s = settings();
        const existing = Object.entries(s.library).find(([id, r]) => (json.id && id === json.id) || (json.name && r.name === json.name));
        let replace = false;
        if (existing) replace = !!(await ctx().Popup.show.confirm('Replace the existing rulebook?', `"${esc(existing[1].name || existing[0])}" is already in your library. Replace it with this file? Chats that use it keep working and switch to the new version. Choose No to import it as a separate copy.`));
        const probs = problemsOf(json);
        if (replace) {
            const id = existing[0];
            if (probs.length) {
                // Load it as unsaved changes, so the library copy keeps working until it's fixed.
                json.id = id;
                drafts[id] = { rb: json, dirty: true, isNew: false };
                curId = id; sel = { kind: 'book' };
                renderAll();
                flash(`Loaded "${json.name || id}" as unsaved changes: it has ${probs.length} problem${probs.length > 1 ? 's' : ''} to fix before it can replace the saved one.`, 'warn');
                return;
            }
            const out = normalize(json); out.id = id;
            s.library[id] = out; saveSettings();
            drafts[id] = { rb: clone(out), dirty: false, isNew: false };
            curId = id; sel = { kind: 'book' };
            renderAll();
            flash(`Replaced "${out.name}".`);
            onSaved();
            return;
        }
        if (probs.length) { addDraft(json, `Imported "${json.name || file.name}" with ${probs.length} problem${probs.length > 1 ? 's' : ''}. Fix them, then Save to add it to the library.`); return; }
        const out = normalize(json);
        out.id = newRulebookId(out.name || file.name.replace(/\.json$/i, ''));
        s.library[out.id] = out; saveSettings();
        drafts[out.id] = { rb: clone(out), dirty: false, isNew: false };
        curId = out.id; sel = { kind: 'book' };
        renderAll();
        flash(`Imported "${out.name}".`);
        onSaved();
    } catch (err) {
        flash(`Could not import: ${err.message}`, 'warn');
    }
}
