// Change chips under each judged reply. Only the newest judged turn can be changed by tapping.
import { SEVERITIES } from '../engine.js';
import { ctx, settings, chatRulebook } from '../state.js';
import { chipModel, overrideEvent, scheduleJudge } from '../controller.js';
import { esc } from './window.js';

const mesEl = (index) => document.querySelector(`#chat .mes[mesid="${index}"]`);

const labelOf = (rb, id) => rb.meters.find(m => m.id === id)?.label || id;
const words = (id) => { const s = String(id || '').replace(/_/g, ' ').trim(); return s ? s[0].toUpperCase() + s.slice(1) : id; };

function deltaText(rb, deltas, sets = {}) {
    const parts = Object.entries(deltas || {}).filter(([id, d]) => d && !(id in sets)).map(([id, d]) => {
        const r = Math.round(Math.abs(d));
        return `${labelOf(rb, id)} ${d > 0 ? '+' : '−'}${r || '<1'}`;
    });
    for (const [id, v] of Object.entries(sets || {})) parts.push(`${labelOf(rb, id)} → ${Math.round(v)}`);
    return parts.join(', ') || 'no change';
}

function eventChip(rb, ev, i, { editable, revised }) {
    const r = revised?.[i];
    const cancelled = r?.cancelled || ev.cancelled;
    const reratedFrom = r && !r.cancelled && r.severity !== ev.severity ? ev.severity : (ev.originalSeverity && ev.originalSeverity !== ev.severity ? ev.originalSeverity : '');
    const sev = r && !r.cancelled ? r.severity : ev.severity;
    const title = r?.revisedReason ? `Revised next turn: ${r.revisedReason}` : (ev.userEdited ? `Changed by you${ev.originalType ? ` (the judge said ${words(ev.originalType)})` : ''}` : '');
    const cls = ['srb-chip', cancelled ? 'srb-cancelled' : '', editable ? 'srb-editable' : '', (ev.deltas && Object.values(ev.deltas).some(d => d < 0)) ? 'srb-neg' : 'srb-pos'].join(' ');
    const inner = `${esc(deltaText(rb, ev.deltas, ev.sets))} · ${esc(ev.reason || ev.type)} <span class="srb-sev">(${esc(sev)}${reratedFrom ? `, was ${esc(reratedFrom)}` : ''}${ev.originalType ? ', event changed' : ''}${ev.capped ? ', capped' : ''})</span>${r ? ' <span class="srb-sev">revised</span>' : ''}`;
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
        for (const [id, d] of Object.entries(snap.fades || {})) {
            // Drift can run either way (towards the meter's fade target); small amounts keep one decimal so they don't read as +0.
            const amt = Math.abs(d) < 1 ? Math.abs(d).toFixed(1) : Math.round(Math.abs(d));
            chips.push(`<span class="srb-chip srb-muted">${esc(labelOf(rb, id))} ${d > 0 ? '+' : '−'}${amt} · ${d > 0 ? 'building over time' : 'fading'}</span>`);
        }
        for (const [id, c] of Object.entries(snap.cooled || {})) {
            chips.push(`<span class="srb-chip srb-muted">${esc(labelOf(rb, id))} +${Math.round(c.blocked)} blocked · cooling down${c.left > 0 ? ` (${c.left} more turn${c.left === 1 ? '' : 's'})` : ' (last turn)'}</span>`);
        }
        for (const [id, c] of Object.entries(snap.cooling || {})) {
            chips.push(`<span class="srb-chip srb-muted">${esc(labelOf(rb, id))} cooldown · ${c.left} turn${c.left === 1 ? '' : 's'}</span>`);
        }
        if (!chips.length) chips.push('<span class="srb-chip srb-muted">Nothing scored this turn</span>');
        if (snap.revise?.events?.length) chips.push('<span class="srb-chip srb-muted" title="See the previous reply">Revised the previous turn</span>');
        if (snap.manual) chips.push('<span class="srb-chip srb-muted">Adjusted by hand</span>');
        if (editable && snap.events.length) chips.push('<span class="srb-hint srb-chip-hint">Tap a chip to change its event or severity, or remove it</span>');
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

/** Tap handling: opens an event and severity menu on an editable chip, or retries a failed judgement. */
export function bindChipClicks() {
    document.addEventListener('change', (e) => {
        const sel = e.target.closest('.srb-chip-menu select[data-type-for]');
        if (!sel) return;
        const box = sel.closest('.srb-chips');
        const ev = Number(sel.dataset.typeFor);
        box.querySelector('.srb-chip-menu')?.remove();
        overrideEvent(Number(box.dataset.index), ev, `type:${sel.value}`);
    });
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
        const rb = chatRulebook();
        const cur = chipModel(index)?.snap?.events?.[Number(ev)]?.type;
        const types = Object.keys(rb?.events || {});
        menu.innerHTML = `<label class="srb-chip-type"><span>Event</span><select class="text_pole" data-type-for="${ev}">${types.map(t => `<option value="${esc(t)}" ${t === cur ? 'selected' : ''}>${esc(words(t))}</option>`).join('')}</select></label>`
            + SEVERITIES.map(s => `<button type="button" class="menu_button" data-pick="${s}" data-ev="${ev}">${s}</button>`).join('')
            + `<button type="button" class="menu_button srb-danger" data-pick="remove" data-ev="${ev}">Remove</button>`;
        box.appendChild(menu);
    });
}
