// Change chips under each judged reply. Only the newest judged turn can be changed by tapping.
import { SEVERITIES } from '../engine.js';
import { ctx, settings, chatRulebook } from '../state.js';
import { chipModel, overrideEvent, scheduleJudge } from '../controller.js';
import { esc } from './window.js';

const mesEl = (index) => document.querySelector(`#chat .mes[mesid="${index}"]`);

function deltaText(rb, deltas) {
    const parts = Object.entries(deltas || {}).filter(([, d]) => d).map(([id, d]) => {
        const label = rb.meters.find(m => m.id === id)?.label || id;
        const r = Math.round(Math.abs(d));
        return `${label} ${d > 0 ? '+' : '−'}${r || '<1'}`;
    });
    return parts.join(', ') || 'no change';
}

function eventChip(rb, ev, i, { editable, revised }) {
    const r = revised?.[i];
    const cancelled = r?.cancelled || ev.cancelled;
    const reratedFrom = r && !r.cancelled && r.severity !== ev.severity ? ev.severity : (ev.originalSeverity && ev.originalSeverity !== ev.severity ? ev.originalSeverity : '');
    const sev = r && !r.cancelled ? r.severity : ev.severity;
    const title = r?.revisedReason ? `Revised next turn: ${r.revisedReason}` : (ev.userEdited ? 'Changed by you' : '');
    const cls = ['srb-chip', cancelled ? 'srb-cancelled' : '', editable ? 'srb-editable' : '', (ev.deltas && Object.values(ev.deltas).some(d => d < 0)) ? 'srb-neg' : 'srb-pos'].join(' ');
    const inner = `${esc(deltaText(rb, ev.deltas))} · ${esc(ev.reason || ev.type)} <span class="srb-sev">(${esc(sev)}${reratedFrom ? `, was ${esc(reratedFrom)}` : ''}${ev.capped ? ', capped' : ''})</span>${r ? ' <span class="srb-sev">revised</span>' : ''}`;
    return editable
        ? `<button type="button" class="${cls}" data-ev="${i}" title="${esc(title || 'Tap to change')}">${inner}</button>`
        : `<span class="${cls}" title="${esc(title)}">${inner}</span>`;
}

export function renderChips(index) {
    const el = mesEl(index);
    if (!el) return;
    el.querySelector('.srb-chips')?.remove();
    if (!settings().showChips || !settings().enabled) return;
    const model = chipModel(index);
    const rb = chatRulebook();
    if (!model || !rb) return;
    const box = document.createElement('div');
    box.className = 'srb-chips';
    box.dataset.index = String(index);
    if (model.kind === 'pending') box.innerHTML = '<span class="srb-chip srb-muted"><i class="fa-solid fa-spinner fa-spin"></i> Judging…</span>';
    else if (model.kind === 'error') box.innerHTML = `<span class="srb-chip srb-warn" title="${esc(model.text)}">Judge failed</span><button type="button" class="srb-chip srb-editable" data-act="retry">Retry</button>`;
    else if (model.kind === 'off') box.innerHTML = '<span class="srb-chip srb-muted">Rulebook off · this turn wasn\'t scored</span>';
    else {
        const { snap, revised, editable } = model;
        const chips = snap.events.map((ev, i) => eventChip(rb, ev, i, { editable, revised }));
        if (!chips.length) chips.push('<span class="srb-chip srb-muted">Nothing scored this turn</span>');
        if (snap.revise?.events?.length) chips.push('<span class="srb-chip srb-muted" title="See the previous reply">Revised the previous turn</span>');
        if (snap.manual) chips.push('<span class="srb-chip srb-muted">Adjusted by hand</span>');
        if (editable && snap.events.length) chips.push('<span class="srb-hint srb-chip-hint">Tap a chip to change its severity or remove it</span>');
        box.innerHTML = chips.join('');
    }
    const text = el.querySelector('.mes_text');
    if (text) text.after(box); else el.querySelector('.mes_block')?.appendChild(box);
}

export function renderAllChips() {
    document.querySelectorAll('#chat .srb-chips').forEach(x => x.remove());
    const chat = ctx().chat;
    document.querySelectorAll('#chat .mes[mesid]').forEach(el => {
        const i = Number(el.getAttribute('mesid'));
        if (Number.isInteger(i) && chat[i]) renderChips(i);
    });
}

/** Tap handling: opens a severity menu on an editable chip, or retries a failed judgement. */
export function bindChipClicks() {
    document.addEventListener('click', async (e) => {
        const box = e.target.closest('.srb-chips');
        if (!box) return;
        const index = Number(box.dataset.index);
        if (e.target.closest('[data-act="retry"]')) return scheduleJudge(index);
        const pick = e.target.closest('[data-pick]');
        if (pick) {
            box.querySelector('.srb-chip-menu')?.remove();
            return overrideEvent(index, Number(pick.dataset.ev), pick.dataset.pick);
        }
        const chip = e.target.closest('.srb-editable[data-ev]');
        if (!chip) return;
        const existing = box.querySelector('.srb-chip-menu');
        if (existing && existing.dataset.ev === chip.dataset.ev) { existing.remove(); return; }
        existing?.remove();
        const ev = chip.dataset.ev;
        const menu = document.createElement('div');
        menu.className = 'srb-chip-menu';
        menu.dataset.ev = ev;
        menu.innerHTML = SEVERITIES.map(s => `<button type="button" class="menu_button" data-pick="${s}" data-ev="${ev}">${s}</button>`).join('')
            + `<button type="button" class="menu_button srb-danger" data-pick="remove" data-ev="${ev}">Remove</button>`;
        box.appendChild(menu);
    });
}
