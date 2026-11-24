// Builds the judge's and the assessor's prompts, calls the model and parses the answers.
import { SEVERITIES, extractJson, cleanVerdict, cleanAssessment, fmtValue } from './engine.js';
import { ctx, settings, isReply, currentCharacter } from './state.js';

const sub = (text) => ctx().substituteParams(String(text ?? ''));
const names = () => ({ char: ctx().name2 || 'the character', user: ctx().name1 || 'the user' });

// ---------- text cleaning ----------

/** Parses the settings' strip list: one /pattern/flags per line. Bad lines are skipped. */
function stripPatterns() {
    return String(settings().judge.strip || '').split('\n').map(l => l.trim()).filter(Boolean).map(l => {
        const m = l.match(/^\/(.*)\/([a-z]*)$/s);
        try { return m ? new RegExp(m[1], m[2].includes('g') ? m[2] : m[2] + 'g') : null; } catch { return null; }
    }).filter(Boolean);
}

export function cleanText(text) {
    let t = String(text || '');
    for (const re of stripPatterns()) t = t.replace(re, '');
    return t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

const line = (msg) => `${msg.name}: ${cleanText(msg.mes)}`;

// ---------- background for the full judge and the assessor ----------

function sheet({ withGreeting = false } = {}) {
    const n = names();
    const f = ctx().getCharacterCardFields();
    const parts = [];
    if (f.description) parts.push(`Description:\n${f.description}`);
    if (f.personality) parts.push(`Personality:\n${f.personality}`);
    if (f.scenario) parts.push(`Scenario:\n${f.scenario}`);
    if (withGreeting) {
        const first = ctx().chat.find(m => !m.is_user && !m.is_system);
        if (first) parts.push(`Opening message:\n${cleanText(first.mes)}`);
    }
    const persona = f.persona ? `${n.user}'s persona:\n${f.persona}` : '';
    return { sheet: parts.join('\n\n'), persona };
}

async function lorebookText(mode) {
    if (mode === 'none') return '';
    try {
        const wi = await import('../../../../world-info.js');
        if (mode === 'constant') {
            const entries = await wi.getSortedEntries();
            const seen = new Set();
            return entries
                .filter(e => e.constant && !e.disable && e.content)
                .map(e => sub(e.content).trim())
                .filter(t => t && !seen.has(t) && seen.add(t))
                .join('\n\n');
        }
        const c = ctx();
        const chatForWI = c.chat.filter(m => !m.is_system).map(m => `${m.name}: ${m.mes}`).reverse();
        const f = c.getCharacterCardFields();
        const res = await wi.getWorldInfoPrompt(chatForWI, c.maxContext, true, {
            trigger: 'normal', personaDescription: f.persona, characterDescription: f.description,
            characterPersonality: f.personality, characterDepthPrompt: f.charDepthPrompt, scenario: f.scenario, creatorNotes: f.creatorNotes,
        });
        const depth = (res.worldInfoDepth || []).flatMap(d => d.entries || []);
        return [res.worldInfoBefore, res.worldInfoAfter, ...depth].map(t => String(t || '').trim()).filter(Boolean).join('\n\n');
    } catch (err) {
        console.warn('[Rulebook] Could not read lorebook entries', err);
        return '';
    }
}

/** Visible messages before `index` (exclusive), newest last, at most `limit`. */
function history(index, limit) {
    const msgs = ctx().chat.slice(0, Math.max(0, index)).filter(m => !m.is_system && typeof m.mes === 'string');
    return msgs.slice(-limit).map(line).join('\n\n');
}

// ---------- the judge ----------

function stateText(rb, state, journal, turn) {
    const levels = rb.meters.map(m => {
        if (m.gate && !state.unlocked[m.id]) return `${m.label}: locked (opens when ${rb.meters.find(x => x.id === m.gate.meter)?.label || m.gate.meter} reaches ${m.gate.min})`;
        return `${m.label}: ${state.levels[m.id]} (${fmtValue(m, state.values[m.id])})`;
    }).join('\n');
    const recent = (journal || []).slice(-6).map(j => `- Turn ${j.turn} (${j.severity}): ${j.reason || j.type}`).join('\n');
    return `Current levels, ${turn ? `after turn ${turn}` : 'at the start'}:\n${levels}\n\nRecent major events:\n${recent || '- None yet.'}`;
}

function systemPrompt(rb) {
    const n = names();
    const events = Object.entries(rb.events).map(([k, e]) => `- ${k}: ${sub(e.description)}`).join('\n');
    return `You are the referee for an ongoing roleplay between ${n.char} (the character) and ${n.user} (the user). You never write story text. You read the latest exchange and report which of the listed events happened in it, from ${n.char}'s point of view.

Rules:
- Score only the LATEST EXCHANGE. Everything before it is background: never score it again, even when it is mentioned or remembered.
- Only count what ${n.char} sees, hears or finds out. ${n.user}'s private thoughts and inner narration are never evidence. A lie ${n.char} hasn't discovered doesn't count until ${n.char} discovers it.
- Behaviour that fits ${n.char}'s current levels is expected, not an event. Score what ${n.user} chooses to do, and ${n.char} acting against or beyond ${n.char}'s current levels.
- Judge severity by how much it matters in this relationship, using the current state and recent events.
- Several events can happen in one exchange. If nothing on the list happened, return an empty list.
- Keep each reason under 8 words: a plain description of what happened.
- You also get the previous turn's verdict. If the latest exchange changes what the previous turn meant (for example ${n.user} refused, undid or reversed it), cancel or re-rate those events by their index. Only revise when the meaning clearly changed.

Severity:
- trivial: barely matters; ${n.char} would forget it by tomorrow.
- minor: noticeable; ${n.char} would remember it for a few days.
- serious: changes how ${n.char} sees ${n.user} for a while.
- severe: a turning point ${n.char} won't get past easily.

Events:
${events}

Reply with JSON only, in this shape:
{"events": [{"type": "<event>", "severity": "<${SEVERITIES.join('|')}>", "reason": "<under 8 words>"}], "revise": [{"index": <number>, "action": "cancel|rerate", "severity": "<new severity, for rerate>", "reason": "<under 8 words>"}]}`;
}

/**
 * Builds the judge's messages for the reply at `index`.
 * prev: { index, snap } of the previous judged turn, or null. base: the state before this turn.
 */
export async function buildJudgeMessages({ rb, index, mode, prev, base, prevEligible }) {
    const c = ctx();
    const n = names();
    const s = settings().judge;
    const prevReplyIdx = (() => { for (let i = index - 1; i >= 0; i--) if (isReply(c.chat[i])) return i; return -1; })();
    const userMsgs = c.chat.slice(prevReplyIdx + 1, index).filter(m => m.is_user && !m.is_system);

    const blocks = [];
    if (mode === 'full') {
        const bg = [];
        if (s.includeCard) {
            const { sheet: sh, persona } = sheet();
            if (sh) bg.push(`${n.char}'s character sheet. It describes where ${n.char} started, not where ${n.char} is now:\n${sh}`);
            if (persona) bg.push(persona);
        }
        const lore = await lorebookText(s.lorebook);
        if (lore) bg.push(`Lorebook entries:\n${lore}`);
        if (s.includeHistory) {
            const h = history(prevReplyIdx >= 0 ? prevReplyIdx : index, Number(s.historyLimit) || 60);
            if (h) bg.push(`Earlier messages:\n${h}`);
        }
        if (bg.length) blocks.push(`<background note="never score this">\n${bg.join('\n\n')}\n</background>`);
    }
    blocks.push(`<current_state>\n${stateText(rb, base, prev?.snap?.journal, prev?.snap?.turn ?? 0)}\n</current_state>`);

    const pv = prevEligible && prev?.snap?.events?.length
        ? prev.snap.events.map((e, i) => `${i}. ${e.type} (${e.severity})${e.cancelled ? ' [already cancelled]' : ''}: ${e.reason || ''}`).join('\n')
        : 'None to revise.';
    blocks.push(`<previous_verdict>\n${pv}\n</previous_verdict>`);

    if (prevReplyIdx >= 0) blocks.push(`<previous_reply note="already scored as the previous turn">\n${line(c.chat[prevReplyIdx])}\n</previous_reply>`);
    const latest = [...userMsgs.map(line), line(c.chat[index])].join('\n\n');
    blocks.push(`<latest_exchange note="score only this">\n${latest}\n</latest_exchange>`);
    blocks.push('Score only the latest exchange. Reply with JSON only.');

    return [
        { role: 'system', content: systemPrompt(rb) },
        { role: 'user', content: blocks.join('\n\n') },
    ];
}

// ---------- the assessor ----------

export async function buildAssessMessages(rb) {
    const c = ctx();
    const n = names();
    const meters = rb.meters.map(m => {
        const lv = m.levels.map(l => `${l.name} from ${fmtValue(m, l.from)}`).join(', ');
        return `- ${m.id} (${m.label}, ${m.min} to ${m.max}). Levels: ${lv}.`;
    }).join('\n');
    const system = `You set the starting point for a roleplay rulebook. Read the character sheet and work out where ${n.char} stands toward ${n.user} at the start of this story, on each meter below. Rate ${n.char}'s attitude toward ${n.user} specifically, not ${n.char}'s personality in general: someone vicious to everyone else can still start kind toward ${n.user}. If the sheet says nothing about a meter, use a sensible value for two people with the relationship the sheet describes.

Meters:
${meters}

For each meter give a whole number within its range and a reason of at most 15 words, based on the sheet.
Reply with JSON only, in this shape:
{"meters": {${rb.meters.map(m => `"${m.id}": {"value": <number>, "reason": "<15 words>"}`).join(', ')}}}`;

    const { sheet: sh, persona } = sheet({ withGreeting: true });
    const parts = [`${n.char}'s character sheet:\n${sh || '(empty)'}`];
    if (persona) parts.push(persona);
    const lore = await lorebookText('constant');
    if (lore) parts.push(`Lorebook entries:\n${lore}`);
    const visible = c.chat.filter(m => !m.is_system);
    if (settings().assess.readHistory && visible.length > 1) {
        parts.push(`The story so far (rate where things stand now, at the end of it):\n${history(c.chat.length, 40)}`);
    }
    return [
        { role: 'system', content: system },
        { role: 'user', content: `${parts.join('\n\n')}\n\nReply with JSON only.` },
    ];
}

// ---------- calling the model ----------

export function profiles() {
    try { return ctx().ConnectionManagerRequestService.getSupportedProfiles() || []; } catch { return []; }
}

export function profileLabel(id) {
    const p = profiles().find(x => x.id === id);
    return p ? `${p.model || p.name}` : '';
}

function isChatCompletion(profileId) {
    try {
        const svc = ctx().ConnectionManagerRequestService;
        return svc.validateProfile(svc.getProfile(profileId)).selected === 'openai';
    } catch { return false; }
}

const EFFORT = { off: 'none', minimal: 'minimal', low: 'low' };
const DEFAULT_MAX_TOKENS = 4000;

/**
 * Sends messages through a connection profile, using only its API, model and key.
 * Each attempt is added to `log` (for the trace).
 */
export async function callModel(profileId, messages, { maxTokens, temperature, reasoning, signal, log = [], note } = {}) {
    if (!profileId) throw new Error('Choose a judge model in the Rulebook settings.');
    const svc = ctx().ConnectionManagerRequestService;
    if (!svc) throw new Error('The Connection Manager extension is needed for the judge.');
    const prompt = svc.constructPrompt(messages, profileId);
    const max = Number(maxTokens) || DEFAULT_MAX_TOKENS;
    const payload = { temperature: Number(temperature ?? 0.2) };
    if (isChatCompletion(profileId) && EFFORT[reasoning]) Object.assign(payload, { reasoning_effort: EFFORT[reasoning], include_reasoning: false });
    const opts = { stream: false, extractData: true, includePreset: false, includeInstruct: true, signal };
    const send = async (p, note) => {
        const entry = { at: Date.now(), reasoning: p.reasoning_effort || 'model default', maxTokens: max, note };
        log.push(entry);
        try {
            const res = await svc.sendRequest(profileId, prompt, max, opts, p);
            const text = typeof res === 'string' ? res : String(res?.content ?? '');
            entry.chars = text.length;
            return text;
        } catch (err) {
            entry.error = errText(err);
            throw err;
        }
    };
    try {
        return await send(payload, note);
    } catch (err) {
        if (signal?.aborted) throw err;
        // When the provider rejects the reasoning setting (or just says "Bad Request", which is all
        // SillyTavern passes on), try once without it. Refused requests aren't billed.
        if (payload.reasoning_effort && /reason|effort|thinking|bad request/i.test(errText(err))) {
            const { reasoning_effort: _r, include_reasoning: _i, ...rest } = payload;
            try {
                return await send(rest, `Retried without the reasoning setting ("${payload.reasoning_effort}") after the first call was refused.`);
            } catch (err2) {
                throw explainRefusal(err2);
            }
        }
        throw explainRefusal(err);
    }
}

const errText = (err) => err?.cause?.message || err?.message || String(err);

/** SillyTavern only passes on "Bad Request"; the provider's reason is in its server log. */
function explainRefusal(err) {
    if (!/^bad request$/i.test(errText(err).trim())) return err;
    return new Error('Bad Request: the provider refused the request. SillyTavern only passes on that label; the reason is in SillyTavern\'s server log (search it for "Chat completion request error"). Common causes: a setting the model or provider doesn\'t accept, or a provider-side content filter on the prompt.');
}

const CUT_OFF = 'The answer was cut off before the JSON ended, probably because the model reasoned despite the Reasoning setting (thinking counts towards the limit). Raise Max tokens in the Rulebook settings, or use a model or provider that honours "Off".';

/**
 * Calls the model and parses JSON. A malformed answer is retried once with a nudge
 * (if `retry`); a cut-off answer isn't, because it would be cut off again.
 */
async function callForJson(profileId, messages, opts, retry) {
    let raw = await callModel(profileId, messages, opts);
    try {
        return { raw, json: extractJson(raw) };
    } catch (err) {
        if (err.message.includes('incomplete')) throw Object.assign(new Error(CUT_OFF), { raw });
        if (!retry) throw Object.assign(new Error(`The answer wasn't valid JSON: ${err.message}`), { raw });
        const again = [...messages, { role: 'assistant', content: raw }, { role: 'user', content: 'That was not valid JSON. Reply with the JSON object only, nothing else.' }];
        raw = await callModel(profileId, again, { ...opts, note: 'Retry after an answer that wasn\'t valid JSON.' });
        try {
            return { raw, json: extractJson(raw) };
        } catch (err2) {
            if (err2.message.includes('incomplete')) throw Object.assign(new Error(CUT_OFF), { raw });
            throw Object.assign(new Error(`The answer wasn't valid JSON, twice: ${err2.message}`), { raw });
        }
    }
}

export async function judge({ rb, messages, prevEventCount, signal, log = [] }) {
    const s = settings().judge;
    try {
        const { raw, json } = await callForJson(s.profileId, messages, { maxTokens: s.maxTokens, temperature: s.temperature, reasoning: s.reasoning, signal, log }, s.retry);
        return { raw, verdict: cleanVerdict(rb, json, prevEventCount) };
    } catch (err) {
        throw Object.assign(new Error(errText(err)), { raw: err.raw });
    }
}

export async function assess(rb, log = []) {
    const s = settings();
    const profileId = s.assess.profileId || s.judge.profileId;
    const messages = await buildAssessMessages(rb);
    try {
        const { raw, json } = await callForJson(profileId, messages, { maxTokens: s.judge.maxTokens, temperature: 0.3, reasoning: s.judge.reasoning, log }, s.judge.retry);
        return { raw, messages, values: cleanAssessment(rb, json) };
    } catch (err) {
        throw Object.assign(new Error(errText(err)), { raw: err.raw, messages });
    }
}

export const characterName = () => currentCharacter()?.name || names().char;
