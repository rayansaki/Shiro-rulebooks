// The Rulebook window: on/off, judge context, meters, status, the note, and actions.
import { statusLine, fmtValue } from '../engine.js';
import { ctx, settings, isSoloChat, chatMeta, chatRulebook, judgeMode, stateAt, findSnapBefore, lastReplyBefore, currentCharacter } from '../state.js';
import { status, noteFor, setEnabled, setContextMode, rejudgeLatest, attach, detach, runAssessment, isJudging } from '../controller.js';
import { profileLabel } from '../judge.js';
import { FloatingWindow, esc } from './window.js';

let win = null;
let noteOpen = false;
let confirmDetach = false;
let actions = {};

/** actions: { openStart, openEditor, openTrace, openSettings } */
export function createPanel(a) {
    actions = a;
    win = new FloatingWindow({ id: 'main', title: 'Rulebook', width: 360, height: 600, minWidth: 260, minHeight: 200, align: 'right' });
    win.el.classList.add('srb-main');
    win.body.addEventListener('click', onClick);
    win.body.addEventListener('change', onChange);
    return win;
}

export const panel = () => win;

function onChange(e) {
    const t = e.target;
    if (t.matches('[data-act="enabled"]')) setEnabled(t.checked);
}

async function onClick(e) {
    const b = e.target.closest('[data-act]');
    if (!b || b.tagName === 'INPUT') return;
    const act = b.dataset.act;
    if (act === 'lean' || act === 'full') return setContextMode(act);
    if (act === 'note') { noteOpen = !noteOpen; return renderPanel(); }
    if (act === 'rejudge') return rejudgeLatest();
    if (act === 'trace') return actions.openTrace();
    if (act === 'start') return actions.openStart();
    if (act === 'edit') return actions.openEditor(chatMeta()?.rulebookId);
    if (act === 'settings') return actions.openSettings();
    if (act === 'retry-assess' || act === 'reassess') return runAssessment();
    if (act === 'manual-start') return actions.openStart({ fresh: true });
    if (act === 'attach') {
        const id = win.body.querySelector('[data-role="attach-select"]')?.value;
        if (id) return attach(id);
    }
    if (act === 'detach') { confirmDetach = true; return renderPanel(); }
    if (act === 'detach-no') { confirmDetach = false; return renderPanel(); }
    if (act === 'detach-yes') { confirmDetach = false; return detach(); }
}

const empty = (text, extra = '') => `<div class="srb-empty">${text}</div>${extra}`;

export function renderPanel() {
    if (!win) return;
    const s = settings();
    const meta = chatMeta();
    const rb = chatRulebook();
    const ch = currentCharacter();
    win.setTitle('Rulebook', rb ? `${rb.name} · ${ch?.name || ''}` : (ch?.name || ''));

    if (!s.enabled) { win.body.innerHTML = empty('The Rulebook extension is switched off in its settings.', '<button type="button" class="menu_button" data-act="settings">Open settings</button>'); return; }
    if (!isSoloChat()) { win.body.innerHTML = empty('Open a one-to-one chat with a character. Group chats aren\'t supported.'); return; }

    if (!meta) {
        const lib = Object.entries(s.library);
        const assigned = s.assignments[ch?.avatar];
        win.body.innerHTML = `
            <div class="srb-empty">No rulebook in this chat yet.${assigned ? ` ${esc(ch.name)} is set to use <b>${esc(s.library[assigned]?.name || assigned)}</b> for new chats.` : ''}</div>
            <label class="srb-field">Rulebook
                <select class="text_pole" data-role="attach-select">${lib.map(([id, r]) => `<option value="${esc(id)}" ${id === assigned ? 'selected' : ''}>${esc(r.name || id)}</option>`).join('')}</select>
            </label>
            <button type="button" class="menu_button srb-primary" data-act="attach">Attach and work out the starting point</button>
            <div class="srb-hint">The assessor reads the character sheet${s.assess.readHistory ? ' and the story so far' : ''} and proposes where ${esc(ch?.name || 'the character')} starts on each meter.</div>`;
        return;
    }
    if (!rb) {
        win.body.innerHTML = empty('This chat\'s rulebook is missing or has errors. Fix it in the editor, or detach it.', `
            <div class="srb-row"><button type="button" class="menu_button" data-act="edit">Edit rulebook</button><button type="button" class="menu_button" data-act="detach">Detach</button></div>${detachConfirm()}`);
        return;
    }
    if (status.assessing) { win.body.innerHTML = empty('<i class="fa-solid fa-spinner fa-spin"></i> Working out the starting point…'); return; }
    if (!meta.start?.values) {
        win.body.innerHTML = empty(status.assessError ? `The assessment failed: ${esc(status.assessError)}` : 'This chat has no starting point yet.', `
            <div class="srb-row"><button type="button" class="menu_button" data-act="retry-assess">Try again</button><button type="button" class="menu_button" data-act="manual-start">Set by hand</button></div>
            <div class="srb-row"><button type="button" class="menu_button" data-act="trace">Show trace</button><button type="button" class="menu_button" data-act="detach">Detach</button></div>${detachConfirm()}`);
        return;
    }

    const on = meta.enabled !== false;
    const mode = judgeMode();
    const c = ctx();
    const at = stateAt(rb);
    const latestReply = lastReplyBefore(c.chat.length);
    const latest = findSnapBefore(c.chat.length);
    const fresh = latest && latest.index === latestReply ? latest.snap : null;
    const judgeName = profileLabel(s.judge.profileId);
    const err = status.errors.get(latestReply);

    const meters = rb.meters.map(m => {
        const v = at.state.values[m.id];
        const locked = m.gate && !at.state.unlocked[m.id];
        const delta = fresh && on ? Math.round((fresh.after.values[m.id] ?? v) - (fresh.before.values[m.id] ?? v)) : 0;
        const bi = m.min < 0;
        const pct = (x) => ((x - m.min) / (m.max - m.min)) * 100;
        const left = bi ? Math.min(pct(0), pct(v)) : 0;
        const width = locked ? 0 : (bi ? Math.abs(pct(v) - pct(0)) : pct(v));
        const gateMeter = locked ? rb.meters.find(x => x.id === m.gate.meter) : null;
        return `
            <div class="srb-meter ${locked ? 'srb-locked' : ''}">
                <div class="srb-meter-top">
                    <span class="srb-meter-name">${esc(m.label)}</span>
                    <span class="srb-meter-level">${locked ? '<i class="fa-solid fa-lock"></i> Locked' : esc(at.state.levels[m.id])}
                        ${locked ? '' : `<span class="srb-meter-val">${fmtValue(m, v)}</span>`}
                        ${delta ? `<span class="srb-delta ${delta > 0 ? 'up' : 'down'}">${delta > 0 ? '+' : '−'}${Math.abs(delta)}</span>` : ''}</span>
                </div>
                <div class="srb-track">${bi ? '<div class="srb-mid"></div>' : ''}<div class="srb-fill" style="left:${left}%;width:${width}%;background:${esc(m.color || 'var(--srb-accent)')}"></div></div>
                ${locked ? `<div class="srb-hint">Unlocks when ${esc(gateMeter?.label || m.gate.meter)} reaches ${m.gate.min}</div>` : ''}
            </div>`;
    }).join('');

    const note = noteFor();
    win.body.innerHTML = `
        <div class="srb-onrow">
            <div><div class="srb-strong">${on ? 'On' : 'Off'}</div><div class="srb-hint">${on ? 'Judging each turn and adding a note' : 'Paused for this chat'}</div></div>
            <label class="srb-switch" title="Rulebook on or off for this chat"><input type="checkbox" data-act="enabled" ${on ? 'checked' : ''}><span></span></label>
        </div>
        ${on ? '' : '<div class="srb-notice">No judge calls and nothing added to the prompt, so the chat runs exactly as it would without the extension. The meters keep their values and carry on from here when you switch it back on.</div>'}
        <div class="srb-section">
            <div class="srb-label">Judge context</div>
            <div class="srb-seg" role="group" aria-label="Judge context">
                <button type="button" data-act="lean" aria-pressed="${mode === 'lean'}">Lean</button>
                <button type="button" data-act="full" aria-pressed="${mode === 'full'}">Full</button>
            </div>
            <div class="srb-hint">${mode === 'lean' ? 'The last exchange, current levels and recent major events.' : 'Adds the card and persona (as the starting point), lorebook entries and earlier messages, cleaned of trackers and HTML.'}</div>
            <div class="srb-hint">${judgeName ? `Judge: ${esc(judgeName)} · reasoning ${esc(s.judge.reasoning)}` : '<span class="srb-warn">Choose a judge model in the Rulebook settings.</span>'}</div>
        </div>
        ${isJudging() ? '<div class="srb-hint"><i class="fa-solid fa-spinner fa-spin"></i> Judging the last reply…</div>' : ''}
        ${err ? `<div class="srb-notice srb-warn">The last judgement failed: ${esc(err)}</div>` : ''}
        <div class="srb-meters ${on ? '' : 'srb-off'}">${meters}</div>
        <div class="srb-status"><span class="srb-hint">Status</span> <span class="srb-strong">${esc(statusLine(rb, at.state))}</span></div>
        <button type="button" class="srb-note-toggle" data-act="note" aria-expanded="${noteOpen}">What the main model gets <span>${noteOpen ? 'Hide' : 'Show'}</span></button>
        ${noteOpen ? `<pre class="srb-note">${esc(on ? (note ? ctx().substituteParams(note) : 'Nothing yet: every meter is still at its starting level, which the character card already covers.') : 'Nothing is sent while the rulebook is off.')}</pre>` : ''}
        <div class="srb-grid">
            <button type="button" class="menu_button" data-act="rejudge" ${on ? '' : 'disabled'}>Re-judge last turn</button>
            <button type="button" class="menu_button" data-act="trace">Show trace</button>
            <button type="button" class="menu_button" data-act="start">Adjust values</button>
            <button type="button" class="menu_button" data-act="edit">Edit rulebook</button>
        </div>
        <button type="button" class="menu_button srb-wide" data-act="reassess">Reassess the starting point</button>
        <button type="button" class="srb-link" data-act="detach">Detach rulebook from this chat (permanent)</button>
        ${detachConfirm()}`;
}

function detachConfirm() {
    if (!confirmDetach) return '';
    return `<div class="srb-notice"><b>Detach permanently?</b> This chat's rulebook, starting point and values are deleted, and the judging and the note stop. Attaching a rulebook again starts over with a new assessment.<br>To pause instead, use the On/Off switch at the top: nothing is lost, and the meters carry on when you switch it back on.
        <div class="srb-row"><button type="button" class="menu_button" data-act="detach-no">Keep it</button><button type="button" class="menu_button srb-danger" data-act="detach-yes">Detach permanently</button></div></div>`;
}
