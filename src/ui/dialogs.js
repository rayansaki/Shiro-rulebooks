// Starting-point dialog and trace window. All are movable and resizable.
import { fmtValue } from '../engine.js';
import { ctx, settings, chatRulebook, currentCharacter } from '../state.js';
import { status, applyValues, applyAssessment, runAssessment, dialogValues } from '../controller.js';
import { FloatingWindow, esc } from './window.js';

// ---------- starting point ----------

let startWin = null;
// mode 'assessment': { baseline, current|null } from the assessor (or set by hand before the chat starts)
// mode 'adjust': { values } — the current values, changed by hand
let startState = null;

export function createStartDialog() {
    startWin = new FloatingWindow({ id: 'start', title: 'Starting point', width: 480, height: 600, minWidth: 300, minHeight: 240, minimisable: false });
    startWin.body.addEventListener('input', (e) => {
        const { meter, col } = e.target.dataset;
        if (!meter) return;
        const v = Number(e.target.value);
        startState[col][meter].value = v;
        startWin.body.querySelectorAll(`[data-meter="${meter}"][data-col="${col}"]`).forEach(el => { if (el !== e.target) el.value = String(v); });
    });
    startWin.body.addEventListener('click', async (e) => {
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (act === 'apply') {
            if (startState.mode === 'adjust') await applyValues(startState.values);
            else await applyAssessment({ baseline: startState.baseline, current: startState.current });
            startWin.close();
        }
        if (act === 'cancel') startWin.close();
        if (act === 'reassess') { startWin.body.querySelector('[data-role="busy"]').hidden = false; runAssessment(); }
    });
    return startWin;
}

function slider(m, col, v) {
    return `<div class="srb-start-cell">
        <div class="srb-meter-top"><span class="srb-label">${col === 'current' ? 'Now' : col === 'baseline' ? 'Card' : 'Value'}</span>
            <input type="number" class="text_pole srb-num" min="${m.min}" max="${m.max}" step="1" value="${Math.round(v.value)}" data-meter="${esc(m.id)}" data-col="${col}" aria-label="${esc(m.label)} ${col}"></div>
        <input type="range" min="${m.min}" max="${m.max}" step="1" value="${Math.round(v.value)}" data-meter="${esc(m.id)}" data-col="${col}" aria-label="${esc(m.label)} ${col}">
        ${v.reason ? `<div class="srb-hint">${esc(v.reason)}</div>` : ''}
    </div>`;
}

/**
 * Opens the dialog.
 * - { baseline, current }: an assessment to confirm (current is null for a new chat).
 * - { fresh: true }: set the starting point by hand (rulebook defaults).
 * - nothing: adjust the current values by hand.
 */
export function openStartDialog({ baseline = null, current = null, fresh = false } = {}) {
    const rb = chatRulebook();
    if (!rb) return;
    const defaults = () => Object.fromEntries(rb.meters.map(m => [m.id, { value: m.start, reason: '' }]));
    if (baseline || fresh) startState = { mode: 'assessment', baseline: structuredClone(baseline || defaults()), current: current ? structuredClone(current) : null };
    else startState = { mode: 'adjust', values: structuredClone(dialogValues()?.values || defaults()) };
    const name = currentCharacter()?.name || 'the character';
    const two = startState.mode === 'assessment' && startState.current;
    const title = startState.mode === 'adjust' ? 'Adjust values' : 'Starting point';
    startWin.setTitle(title, `${rb.name} · ${name}`);
    const intro = startState.mode === 'adjust'
        ? 'Changes the current values. The starting point (which the note compares against) stays as it was.'
        : two
            ? `<b>Card</b> is where ${esc(name)}'s card puts them: the note compares against it, and sends nothing for a meter still at its card level. <b>Now</b> is where the story so far has taken them: the meters start from there.`
            : `Where ${esc(name)} stands toward you at the start, as the card describes. The level each meter starts in sends nothing to the model, because the card already covers it.`;
    startWin.body.innerHTML = `
        <div class="srb-hint">${intro}</div>
        <div data-role="busy" class="srb-hint" hidden><i class="fa-solid fa-spinner fa-spin"></i> Reassessing…</div>
        ${rb.meters.map(m => {
            const cols = startState.mode === 'adjust' ? ['values'] : two ? ['baseline', 'current'] : ['baseline'];
            for (const col of cols) startState[col][m.id] = startState[col][m.id] || { value: m.start, reason: '' };
            return `<div class="srb-start-row">
                <div class="srb-strong">${esc(m.label)}</div>
                <div class="${cols.length > 1 ? 'srb-start-cols' : ''}">${cols.map(col => slider(m, col, startState[col][m.id])).join('')}</div>
            </div>`;
        }).join('')}
        <div class="srb-row srb-end">
            <button type="button" class="menu_button" data-act="reassess">Reassess</button>
            <button type="button" class="menu_button" data-act="cancel">Cancel</button>
            <button type="button" class="menu_button srb-primary" data-act="apply">${startState.mode === 'adjust' ? 'Apply' : 'Start with these'}</button>
        </div>`;
    startWin.open();
}

// ---------- trace ----------

let traceWin = null;

export function createTrace() {
    traceWin = new FloatingWindow({ id: 'trace', title: 'Trace', width: 560, height: 620, minWidth: 300, minHeight: 200 });
    traceWin.body.addEventListener('click', async (e) => {
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (act === 'copy' && status.lastTrace) {
            try { await navigator.clipboard.writeText(JSON.stringify(status.lastTrace, null, 2)); toastr.success('Trace copied'); } catch { toastr.error('Could not copy'); }
        }
        if (act === 'refresh') renderTrace();
    });
    return traceWin;
}

const tokens = (msgs) => Math.round((msgs || []).reduce((n, m) => n + String(m.content || '').length, 0) / 4);

export function renderTrace() {
    if (!traceWin?.isOpen) return;
    const t = status.lastTrace;
    if (!t) { traceWin.body.innerHTML = '<div class="srb-empty">Nothing yet. A trace appears after the next judgement or assessment.</div>'; return; }
    const rb = chatRulebook();
    const label = (id) => rb?.meters.find(m => m.id === id)?.label || id;
    const when = new Date(t.at).toLocaleTimeString();
    const math = t.math ? Object.entries(t.math).filter(([, m]) => m.nominal || m.bypass || m.old !== m.next || m.set !== null).map(([id, m]) =>
        `<tr><td>${esc(label(id))}</td><td>${m.old} → <b>${m.next}</b></td><td>${m.nominal ? `${m.nominal > 0 ? '+' : ''}${m.nominal}` : ''}${m.factor < 1 ? ` ×${m.factor} near the end` : ''}${m.capped ? ' (capped)' : ''}${m.bypass ? ` ${m.bypass > 0 ? '+' : ''}${m.bypass} uncapped` : ''}${m.locked ? ' (locked)' : ''}${m.set !== null && m.set !== undefined ? ` set to ${m.set}` : ''}${m.faded ? ` faded ${m.faded > 0 ? '+' : ''}${m.faded}` : ''}${m.cooled ? ` cooling down: ${m.cooled} blocked` : ''}</td><td>${esc(m.level || '')}</td></tr>`).join('') : '';
    traceWin.body.innerHTML = `
        <div class="srb-row srb-between"><div class="srb-hint">${t.kind === 'assessment' ? 'Starting-point assessment' : `Judgement of message #${t.index}`} · ${when}${t.model ? ` · ${esc(t.model)}` : ''}${t.mode ? ` · ${esc(t.mode)}` : ''} ${t.messages ? ` · about ${tokens(t.messages)} tokens in` : ''}</div>
            <div class="srb-row"><button type="button" class="menu_button" data-act="refresh">Refresh</button><button type="button" class="menu_button" data-act="copy">Copy</button></div></div>
        ${t.error ? `<div class="srb-notice srb-warn">${esc(t.error)}</div>` : ''}
        ${t.attempts?.length ? `<div class="srb-label">Calls</div><ul class="srb-list">${t.attempts.map((a, i) => `<li>${i + 1}. reasoning ${esc(a.reasoning)}, max ${a.maxTokens} tokens: ${a.error ? `<span class="srb-warn">failed (${esc(a.error)})</span>` : `${a.chars ?? 0} characters back`}${a.note ? ` · ${esc(a.note)}` : ''}</li>`).join('')}</ul>` : ''}
        ${t.verdict ? `<div class="srb-label">Events</div><ul class="srb-list">${t.verdict.events.map(e => `<li><b>${esc(e.type)}</b> (${esc(e.severity)}): ${esc(e.reason)}</li>`).join('') || '<li>None</li>'}</ul>` : ''}
        ${t.verdict?.revise?.length ? `<div class="srb-label">Revised the previous turn</div><ul class="srb-list">${t.verdict.revise.map(r => `<li>#${r.index} ${esc(r.action)}${r.severity ? ` → ${esc(r.severity)}` : ''}: ${esc(r.reason)}</li>`).join('')}</ul>${t.verdict.revise.length && !t.revisedPrevious ? '<div class="srb-hint">Not applied: the previous reply wasn\'t judged.</div>' : ''}` : ''}
        ${math ? `<div class="srb-label">Meters</div><table class="srb-table"><thead><tr><th>Meter</th><th>Value</th><th>Change</th><th>Level</th></tr></thead><tbody>${math}</tbody></table>` : ''}
        ${t.baseline ? `<div class="srb-label">Proposed values${t.current ? ' (card → now)' : ''}</div><ul class="srb-list">${Object.entries(t.baseline).map(([id, v]) => `<li><b>${esc(label(id))}</b> ${v.value}${t.current ? ` → ${t.current[id]?.value}` : ''}: ${esc(t.current?.[id]?.reason || v.reason)}</li>`).join('')}</ul>` : ''}
        ${(t.runs || [{ label: '', messages: t.messages, raw: t.raw }]).map(r => `
            <details><summary>${r.label ? `${esc(r.label)}: prompt` : 'Prompt'} sent (${(r.messages || []).length} messages, about ${tokens(r.messages)} tokens)</summary>${(r.messages || []).map(m => `<div class="srb-label">${esc(m.role)}</div><pre class="srb-pre">${esc(m.content)}</pre>`).join('')}</details>
            <details ${t.error ? 'open' : ''}><summary>${r.label ? `${esc(r.label)}: raw answer` : 'Raw answer'}</summary><pre class="srb-pre">${esc(r.raw || '(none)')}</pre></details>`).join('')}`;
}

export function openTrace() {
    traceWin.open();
    renderTrace();
}

export const startDialog = () => startWin;
