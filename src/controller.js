// Judging turns, the note for the main model, and the starting point.
import { applyTurn, reviseEvents, nextJournal, reviseJournal, composeNote, normalizeState, makeState } from './engine.js';
import {
    ctx, settings, chatMeta, setChatMeta, chatRulebook, judgeMode, isActive, isReply, isPendingSwipe,
    getSnap, writeSnap, clearSnap, findSnapBefore, lastReplyBefore, startState, stateAt, snapMatches,
} from './state.js';
import { buildJudgeMessages, judge, assess, profileLabel } from './judge.js';

const INJECT_KEY = 'shuri_rulebook';
const IN_CHAT = 1;
const ROLE_USER = 1;

/** UI listens to this: 'change' (anything to redraw) and 'assessed' (values to confirm). */
export const bus = new EventTarget();
const emit = (type, detail = {}) => bus.dispatchEvent(new CustomEvent(type, { detail }));

export const status = {
    pending: new Set(),   // message indexes being judged
    errors: new Map(),    // message index -> error text
    assessing: false,
    assessError: '',
    lastTrace: null,
};

let currentGenType = null;
let job = null;           // { index, controller, promise }

// ---------- the note ----------

function injectionFilter() {
    return isActive() && !['quiet', 'impersonate', 'continue'].includes(currentGenType);
}

/** The note for the state at `upto` (exclusive). Returns '' when nothing needs saying. */
export function noteFor(upto = ctx().chat.length) {
    const rb = chatRulebook();
    if (!rb || !isActive()) return '';
    const at = stateAt(rb, upto);
    if (!at) return '';
    const s = settings().note;
    return composeNote(rb, at.state, startState(rb), at.snap?.journal || [], at.snap?.turn ?? 0, {
        header: s.header, includeNumbers: s.includeNumbers,
    });
}

/** Sets the note. With excludeLastReply, uses the state before the last reply (swipes, regenerate). */
export function updateInjection({ excludeLastReply = false } = {}) {
    const c = ctx();
    let upto = c.chat.length;
    if (excludeLastReply && isReply(c.chat[upto - 1])) upto -= 1;
    const note = noteFor(upto);
    c.setExtensionPrompt(INJECT_KEY, note, IN_CHAT, Number(settings().note.depth) || 0, false, ROLE_USER, injectionFilter);
    return note;
}

// ---------- generation hooks ----------

export async function onGenerationStarted(type, _params, dryRun) {
    currentGenType = type || 'normal';
    if (dryRun || ['quiet', 'impersonate'].includes(currentGenType)) return;
    // Let a judgement still running finish, so the note is up to date (at most 30 seconds).
    if (job && job.index !== ctx().chat.length - 1) {
        await Promise.race([job.promise, new Promise(r => setTimeout(r, 30000))]);
    }
    updateInjection({ excludeLastReply: ['swipe', 'regenerate', 'continue'].includes(currentGenType) });
}

export function onGenerationEnded() {
    currentGenType = null;
}

export function onMessageReceived(index, type) {
    if (['first_message', 'impersonate', 'quiet'].includes(type)) return;
    const msg = ctx().chat[index];
    if (!isReply(msg) || index === 0) return;
    // A new swipe starts with a copy of the previous swipe's data: drop its old snapshot.
    if (type !== 'continue' && getSnap(msg)) clearSnap(index);
    if (!isActive()) { emit('change', { index }); return; }
    scheduleJudge(index);
}

// ---------- judging ----------

const fingerprint = (msg) => `${msg?.swipe_id ?? 0}|${msg?.mes?.length ?? 0}|${String(msg?.mes || '').slice(0, 80)}`;

export function scheduleJudge(index) {
    if (job) job.controller.abort();
    const controller = new AbortController();
    const entry = { index, controller, promise: null };
    entry.promise = judgeMessage(index, controller.signal).finally(() => { if (job === entry) job = null; });
    job = entry;
    return entry.promise;
}

/** Judges the reply at `index` and saves a snapshot on it. */
async function judgeMessage(index, signal) {
    const c = ctx();
    const rb = chatRulebook();
    const meta = chatMeta();
    const msg = c.chat[index];
    if (!rb || !meta || !isReply(msg) || isPendingSwipe(msg)) return;
    const chatId = c.getCurrentChatId();
    const fp = fingerprint(msg);
    const mode = judgeMode();
    status.pending.add(index);
    status.errors.delete(index);
    emit('change', { index });

    const start = startState(rb);
    const prev = findSnapBefore(index);
    const prevEligible = !!prev && prev.index === lastReplyBefore(index);
    const base = prev ? normalizeState(rb, prev.snap.after, start) : start;
    const trace = { kind: 'judge', at: Date.now(), index, mode, model: profileLabel(settings().judge.profileId) };

    try {
        const messages = await buildJudgeMessages({ rb, index, mode, prev, base, prevEligible });
        trace.messages = messages;
        const { raw, verdict } = await judge({ rb, messages, prevEventCount: prevEligible ? prev.snap.events.length : 0, signal });
        trace.raw = raw;
        trace.verdict = verdict;
        if (c.getCurrentChatId() !== chatId || c.chat[index] !== msg || fingerprint(msg) !== fp) {
            trace.error = 'The reply changed while it was being judged, so the result was dropped.';
            return;
        }

        let mid = base;
        let journalBase = prev?.snap?.journal || [];
        let revise = null;
        if (prevEligible && verdict.revise.length) {
            const revised = reviseEvents(prev.snap.events, verdict.revise);
            mid = applyTurn(rb, normalizeState(rb, prev.snap.before, start), revised).state;
            journalBase = reviseJournal(rb, journalBase, prev.snap.turn, revised);
            revise = { index: prev.index, date: c.chat[prev.index]?.send_date ?? null, list: verdict.revise, events: revised };
        }
        const result = applyTurn(rb, mid, verdict.events);
        const turn = (prev?.snap?.turn ?? 0) + 1;
        const snap = {
            v: 1, rb: rb.id, epoch: meta.epoch, turn,
            before: mid, after: result.state, events: result.applied, revise,
            journal: nextJournal(rb, journalBase, turn, result.applied),
            judged: { at: Date.now(), mode, model: trace.model },
        };
        writeSnap(index, snap);
        await c.saveChat();
        trace.math = result.meters;
        trace.revisedPrevious = revise;
    } catch (err) {
        if (signal?.aborted) { trace.error = 'Cancelled by a newer judgement.'; return; }
        console.error('[Rulebook] Judge failed', err);
        trace.error = err.message;
        trace.raw = trace.raw || err.raw;
        status.errors.set(index, err.message);
    } finally {
        status.pending.delete(index);
        if (!signal?.aborted) status.lastTrace = trace;
        updateInjection();
        emit('change', { index });
    }
}

/** Re-judges the newest reply. */
export function rejudgeLatest() {
    const c = ctx();
    const i = lastReplyBefore(c.chat.length);
    if (i <= 0) return null;
    return scheduleJudge(i);
}

/**
 * Changes one event of the newest judged turn: a new severity, or 'remove'.
 * Only the newest turn can be changed, because later turns build on it.
 */
export async function overrideEvent(index, eventIndex, action) {
    const rb = chatRulebook();
    const latest = findSnapBefore(ctx().chat.length);
    if (!rb || !latest || latest.index !== index) return;
    const snap = structuredClone(latest.snap);
    const ev = snap.events[eventIndex];
    if (!ev) return;
    if (action === 'remove') ev.cancelled = true;
    else { ev.originalSeverity = ev.originalSeverity || ev.severity; ev.severity = action; ev.cancelled = false; }
    ev.userEdited = true;
    const result = applyTurn(rb, normalizeState(rb, snap.before, startState(rb)), snap.events);
    snap.after = result.state;
    snap.events = result.applied;
    snap.journal = nextJournal(rb, (snap.journal || []).filter(j => j.turn !== snap.turn), snap.turn, result.applied);
    writeSnap(index, snap);
    await ctx().saveChat();
    updateInjection();
    emit('change', { index });
}

// ---------- attaching and the starting point ----------

export async function attach(rulebookId) {
    await setChatMeta({ rulebookId, enabled: true, epoch: Date.now(), start: null, context: null }, { now: true });
    emit('change');
    return runAssessment();
}

export async function detach() {
    if (job) job.controller.abort();
    await setChatMeta(null, { now: true });
    status.errors.clear();
    updateInjection();
    emit('change');
}

export async function setEnabled(on) {
    await setChatMeta({ enabled: !!on });
    updateInjection();
    emit('change');
}

export async function setContextMode(mode) {
    await setChatMeta({ context: mode });
    emit('change');
}

/** Asks the assessor for starting values. Emits 'assessed' for confirmation, or applies them. */
export async function runAssessment() {
    const rb = chatRulebook();
    if (!rb) return;
    status.assessing = true;
    status.assessError = '';
    emit('change');
    try {
        const r = await assess(rb);
        status.lastTrace = { kind: 'assessment', at: Date.now(), messages: r.messages, raw: r.raw, values: r.values, model: profileLabel(settings().assess.profileId || settings().judge.profileId) };
        if (settings().assess.confirm) emit('assessed', { values: r.values });
        else await applyValues(r.values);
    } catch (err) {
        console.error('[Rulebook] Assessment failed', err);
        status.assessError = err.message;
        status.lastTrace = { kind: 'assessment', at: Date.now(), messages: err.messages, raw: err.raw, error: err.message };
    } finally {
        status.assessing = false;
        emit('change');
    }
}

/**
 * Applies values from the starting-point dialog. Before any judged turn they become the
 * starting point; after, they adjust the newest snapshot (the starting point stays as it was).
 * values: { meterId: { value, reason } | number }
 */
export async function applyValues(values) {
    const rb = chatRulebook();
    if (!rb) return;
    const vals = {}, reasons = {};
    for (const m of rb.meters) {
        const v = values[m.id];
        vals[m.id] = Number(typeof v === 'object' ? v?.value : v);
        if (typeof v === 'object' && v?.reason) reasons[m.id] = v.reason;
    }
    const latest = findSnapBefore(ctx().chat.length);
    if (!latest || !chatMeta()?.start) {
        await setChatMeta({ start: { values: vals, reasons, at: Date.now() } }, { now: true });
    } else {
        const snap = structuredClone(latest.snap);
        snap.after = makeState(rb, vals, normalizeState(rb, snap.after, startState(rb)));
        snap.manual = { at: Date.now() };
        writeSnap(latest.index, snap);
        await ctx().saveChat();
    }
    updateInjection();
    emit('change');
}

/** Values the starting-point dialog should open with: current values once turns exist. */
export function dialogValues() {
    const rb = chatRulebook();
    const meta = chatMeta();
    if (!rb) return null;
    const at = stateAt(rb);
    const out = {};
    for (const m of rb.meters) {
        out[m.id] = { value: at ? at.state.values[m.id] : m.start, reason: at?.snap ? '' : (meta?.start?.reasons?.[m.id] || '') };
    }
    return { values: out, adjusting: !!at?.snap };
}

// ---------- read helpers for the UI ----------

/** What the chips under a message should show. */
export function chipModel(index) {
    const c = ctx();
    const msg = c.chat[index];
    if (!isReply(msg) || index === 0 || !chatMeta()) return null;
    if (isPendingSwipe(msg) || status.pending.has(index)) return { kind: 'pending' };
    if (status.errors.has(index)) return { kind: 'error', text: status.errors.get(index) };
    const snap = getSnap(msg);
    if (snapMatches(snap)) {
        // A later turn may have revised this one.
        let revised = null;
        for (let i = index + 1; i < c.chat.length; i++) {
            const s = getSnap(c.chat[i]);
            if (snapMatches(s)) { if (s.revise?.index === index) revised = s.revise.events; break; }
        }
        const latest = findSnapBefore(c.chat.length);
        return { kind: 'judged', snap, revised, editable: latest?.index === index && !revised };
    }
    if (!isActive() && index === lastReplyBefore(c.chat.length)) return { kind: 'off' };
    return null;
}

export const currentGeneration = () => currentGenType;
export const isJudging = () => !!job;
