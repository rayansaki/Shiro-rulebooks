// Settings, the chat's rulebook binding, and per-swipe snapshots.
import { validateRulebook, makeState, normalizeState } from './engine.js';
import { SLOW_BURN, DEFAULT_SETTINGS } from './defaults.js';

export const KEY = 'shuri_rulebooks';     // extension settings
export const META = 'shuri_rulebook';     // chat metadata
export const SNAP = 'shuri_rulebook';     // message extra

export const ctx = () => SillyTavern.getContext();

// ---------- settings ----------

function mergeDefaults(target, defaults) {
    for (const [k, v] of Object.entries(defaults)) {
        if (target[k] === undefined) target[k] = structuredClone(v);
        else if (v && typeof v === 'object' && !Array.isArray(v) && typeof target[k] === 'object' && k !== 'library' && k !== 'assignments') {
            mergeDefaults(target[k], v);
        }
    }
    return target;
}

export function settings() {
    const es = ctx().extensionSettings;
    if (!es[KEY] || typeof es[KEY] !== 'object') es[KEY] = {};
    const s = mergeDefaults(es[KEY], DEFAULT_SETTINGS);
    if (!Object.keys(s.library).length) s.library[SLOW_BURN.id] = structuredClone(SLOW_BURN);
    if ((s.version ?? 1) < 2) {
        if (Number(s.judge.maxTokens) === 1024) s.judge.maxTokens = 4000;
        s.version = 2;
    }
    return s;
}

export const saveSettings = () => ctx().saveSettingsDebounced();

export function newRulebookId(name) {
    const base = String(name || 'rulebook').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'rulebook';
    let id = base, n = 2;
    while (settings().library[id]) id = `${base}-${n++}`;
    return id;
}

/** A library rulebook, validated. Returns null if it's missing or broken. */
export function getRulebook(id) {
    const raw = settings().library[id];
    if (!raw) return null;
    const { rulebook, errors } = validateRulebook(raw);
    if (errors.length) return null;
    rulebook.id = id;
    return rulebook;
}

// ---------- the current chat ----------

/** True for an open one-to-one chat (group chats are not supported). */
export function isSoloChat() {
    const c = ctx();
    return !c.groupId && c.characterId !== undefined && c.characterId !== null && !!c.characters[c.characterId] && !!c.getCurrentChatId?.();
}

export function currentCharacter() {
    const c = ctx();
    return isSoloChat() ? c.characters[c.characterId] : null;
}

export function chatMeta() {
    if (!isSoloChat()) return null;
    return ctx().chatMetadata?.[META] || null;
}

export async function setChatMeta(patch, { now = false } = {}) {
    const c = ctx();
    if (patch === null) delete c.chatMetadata[META];
    else c.chatMetadata[META] = { ...(c.chatMetadata[META] || {}), ...patch };
    if (now) await c.saveMetadata(); else c.saveMetadataDebounced();
}

/** The rulebook bound to this chat, if it exists and is valid. */
export function chatRulebook() {
    const meta = chatMeta();
    return meta?.rulebookId ? getRulebook(meta.rulebookId) : null;
}

export function judgeMode() {
    return chatMeta()?.context || settings().judge.defaultContext;
}

// ---------- snapshots ----------

export const getSnap = (msg) => msg?.extra?.[SNAP] || null;

/** Writes a snapshot to the message and to its current swipe, so swiping away and back keeps it. */
export function writeSnap(index, snap) {
    const msg = ctx().chat[index];
    if (!msg) return;
    msg.extra = msg.extra && typeof msg.extra === 'object' ? msg.extra : {};
    msg.extra[SNAP] = snap;
    const info = Array.isArray(msg.swipe_info) ? msg.swipe_info[msg.swipe_id ?? 0] : null;
    if (info && typeof info === 'object') {
        info.extra = info.extra && typeof info.extra === 'object' ? info.extra : {};
        info.extra[SNAP] = structuredClone(snap);
    }
}

export function clearSnap(index) {
    const msg = ctx().chat[index];
    if (!msg) return;
    if (msg.extra) delete msg.extra[SNAP];
    const info = Array.isArray(msg.swipe_info) ? msg.swipe_info[msg.swipe_id ?? 0] : null;
    if (info?.extra) delete info.extra[SNAP];
}

/** A char reply that can be judged: not the user, not hidden or a system message. */
export function isReply(msg) {
    return !!msg && !msg.is_user && !msg.is_system && typeof msg.mes === 'string';
}

/**
 * True when a new swipe has been started but not generated yet. Its extra still holds the
 * previous swipe's data until SillyTavern saves the new reply.
 */
export function isPendingSwipe(msg) {
    return !!msg && Array.isArray(msg.swipes) && typeof msg.swipe_id === 'number' && msg.swipe_id >= msg.swipes.length;
}

/**
 * True when a snapshot belongs to the chat's current attachment. Each attach gets a new
 * epoch, so snapshots left from an earlier attachment are ignored.
 */
export function snapMatches(s) {
    const meta = chatMeta();
    return !!s && !!meta && s.rb === meta.rulebookId && s.epoch === meta.epoch;
}

/** The newest matching snapshot before `index` (exclusive). */
export function findSnapBefore(index) {
    const chat = ctx().chat;
    for (let i = Math.min(index, chat.length) - 1; i >= 0; i--) {
        if (isPendingSwipe(chat[i])) continue;
        const s = getSnap(chat[i]);
        if (snapMatches(s)) return { index: i, snap: s };
    }
    return null;
}

/** The first matching snapshot after `index`. */
export function findSnapAfter(index) {
    const chat = ctx().chat;
    for (let i = index + 1; i < chat.length; i++) {
        if (isPendingSwipe(chat[i])) continue;
        const s = getSnap(chat[i]);
        if (snapMatches(s)) return { index: i, snap: s };
    }
    return null;
}

/** Index of the newest judgeable reply before `index` (exclusive), or -1. */
export function lastReplyBefore(index) {
    const chat = ctx().chat;
    for (let i = Math.min(index, chat.length) - 1; i >= 0; i--) if (isReply(chat[i])) return i;
    return -1;
}

export function startState(rb) {
    const meta = chatMeta();
    if (!meta?.start?.values) return null;
    return makeState(rb, meta.start.values);
}

/**
 * The state at a point in the chat: the newest snapshot before `upto` (exclusive),
 * or the starting point. Returns { state, snap, index } or null when there's no starting point.
 */
export function stateAt(rb, upto = ctx().chat.length) {
    const start = startState(rb);
    if (!start) return null;
    const found = findSnapBefore(upto);
    if (!found) return { state: start, snap: null, index: -1 };
    return { state: normalizeState(rb, found.snap.after, start), snap: found.snap, index: found.index };
}

/** True when the chat's rulebook is attached, has a starting point, and is switched on. */
export function isActive() {
    const meta = chatMeta();
    return !!(settings().enabled && meta?.enabled !== false && meta?.start?.values && chatRulebook());
}
