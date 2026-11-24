// The settings drawer in Extensions.
import { validateRulebook } from '../engine.js';
import { DEFAULT_SETTINGS } from '../defaults.js';
import { ctx, settings, saveSettings, newRulebookId } from '../state.js';
import { profiles } from '../judge.js';
import { esc } from './window.js';

let hooks = {};
let showAllAssigned = false;

const $id = (id) => document.getElementById(id);

/** hooks: { openWindow, openEditor, changed } */
export async function createSettings(h) {
    hooks = h;
    const res = await fetch(new URL('../../settings.html', import.meta.url));
    const tpl = document.createElement('div');
    tpl.innerHTML = await res.text();
    (document.getElementById('extensions_settings2') || document.getElementById('extensions_settings'))?.appendChild(tpl.firstElementChild);
    bind();
    renderSettings();
}

function bindCheck(id, get, set) {
    const el = $id(id);
    el.checked = !!get();
    el.addEventListener('change', () => { set(el.checked); saveSettings(); hooks.changed(); });
}

function bindValue(id, get, set, { number = false } = {}) {
    const el = $id(id);
    el.value = get() ?? '';
    el.addEventListener('change', () => { set(number ? Number(el.value) : el.value); saveSettings(); hooks.changed(); });
}

function bind() {
    const s = settings();
    bindCheck('srb_enabled', () => s.enabled, v => { s.enabled = v; });
    bindCheck('srb_auto_open', () => s.autoOpenWindow, v => { s.autoOpenWindow = v; });
    bindCheck('srb_chips', () => s.showChips, v => { s.showChips = v; });
    bindValue('srb_reasoning', () => s.judge.reasoning, v => { s.judge.reasoning = v; });
    bindValue('srb_temperature', () => s.judge.temperature, v => { s.judge.temperature = Number.isFinite(v) ? v : 0.2; }, { number: true });
    bindValue('srb_max_tokens', () => s.judge.maxTokens, v => { s.judge.maxTokens = Math.min(32000, Math.max(256, v || 4000)); }, { number: true });
    bindValue('srb_default_context', () => s.judge.defaultContext, v => { s.judge.defaultContext = v; });
    bindCheck('srb_retry', () => s.judge.retry, v => { s.judge.retry = v; });
    bindCheck('srb_include_card', () => s.judge.includeCard, v => { s.judge.includeCard = v; });
    bindValue('srb_lorebook', () => s.judge.lorebook, v => { s.judge.lorebook = v; });
    bindCheck('srb_include_history', () => s.judge.includeHistory, v => { s.judge.includeHistory = v; });
    bindValue('srb_history_limit', () => s.judge.historyLimit, v => { s.judge.historyLimit = Math.max(2, v || 60); }, { number: true });
    bindValue('srb_strip', () => s.judge.strip, v => { s.judge.strip = v.trim() ? v : DEFAULT_SETTINGS.judge.strip; });
    bindCheck('srb_assess_confirm', () => s.assess.confirm, v => { s.assess.confirm = v; });
    bindCheck('srb_assess_history', () => s.assess.readHistory, v => { s.assess.readHistory = v; });
    bindValue('srb_depth', () => s.note.depth, v => { s.note.depth = Math.max(0, v || 0); }, { number: true });
    bindValue('srb_header', () => s.note.header, v => { s.note.header = v.trim() ? v : DEFAULT_SETTINGS.note.header; });
    bindCheck('srb_numbers', () => s.note.includeNumbers, v => { s.note.includeNumbers = v; });

    $id('srb_judge_profile').addEventListener('change', (e) => { s.judge.profileId = e.target.value; saveSettings(); hooks.changed(); });
    $id('srb_assess_profile').addEventListener('change', (e) => { s.assess.profileId = e.target.value; saveSettings(); });
    // Profiles can be created while the page is open: refresh the lists when they're opened.
    ['srb_judge_profile', 'srb_assess_profile'].forEach(id => $id(id).addEventListener('focus', renderProfiles));

    $id('srb_open_window').addEventListener('click', () => hooks.openWindow());
    $id('srb_new').addEventListener('click', () => hooks.openEditor(null));
    $id('srb_import_btn').addEventListener('click', () => $id('srb_import').click());
    $id('srb_import').addEventListener('change', importFile);
    $id('srb_library').addEventListener('click', onLibraryClick);
    $id('srb_char_search').addEventListener('input', renderCharacters);
    $id('srb_char_all').addEventListener('click', () => { showAllAssigned = !showAllAssigned; renderCharacters(); });
    $id('srb_settings').addEventListener('change', (e) => {
        if (!e.target.matches('[data-assign]')) return;
        const avatar = e.target.dataset.assign;
        if (e.target.value) s.assignments[avatar] = e.target.value; else delete s.assignments[avatar];
        saveSettings();
        renderCharacters();
        hooks.changed();
    });
}

export function renderSettings() {
    if (!$id('srb_settings')) return;
    renderProfiles();
    renderLibrary();
    renderCharacters();
}

function renderProfiles() {
    const s = settings();
    const list = profiles();
    const opt = (p) => `<option value="${esc(p.id)}">${esc(p.model ? `${p.model} · ${p.name}` : p.name)}</option>`;
    const j = $id('srb_judge_profile');
    j.innerHTML = `<option value="">Choose a connection profile…</option>${list.map(opt).join('')}`;
    j.value = list.some(p => p.id === s.judge.profileId) ? s.judge.profileId : '';
    const a = $id('srb_assess_profile');
    a.innerHTML = `<option value="">Same as the judge</option>${list.map(opt).join('')}`;
    a.value = list.some(p => p.id === s.assess.profileId) ? s.assess.profileId : '';
}

function usedBy(id) {
    const s = settings();
    const chars = ctx().characters || [];
    return Object.entries(s.assignments).filter(([, r]) => r === id).map(([av]) => chars.find(c => c.avatar === av)?.name).filter(Boolean);
}

function renderLibrary() {
    const lib = settings().library;
    $id('srb_library').innerHTML = Object.entries(lib).map(([id, rb]) => {
        const { errors } = validateRulebook(rb);
        const users = usedBy(id);
        const meta = `${(rb.meters || []).length} meters · ${Object.keys(rb.events || {}).length} events · ${users.length ? `used by ${esc(users.slice(0, 3).join(', '))}${users.length > 3 ? ` and ${users.length - 3} more` : ''}` : 'not assigned'}`;
        return `<div class="srb-lib-row" data-id="${esc(id)}">
            <div class="srb-lib-text"><div class="srb-strong">${esc(rb.name || id)}</div><div class="srb-hint">${meta}${errors.length ? ' · <span class="srb-warn">has problems</span>' : ''}</div></div>
            <div class="srb-row">
                <button type="button" class="menu_button" data-lib="edit">Edit</button>
                <button type="button" class="menu_button" data-lib="duplicate">Duplicate</button>
                <button type="button" class="menu_button" data-lib="export">Export</button>
                <button type="button" class="menu_button srb-danger" data-lib="delete" ${Object.keys(lib).length < 2 ? 'disabled title="Keep at least one rulebook"' : ''}>Delete</button>
            </div></div>`;
    }).join('');
}

async function onLibraryClick(e) {
    const btn = e.target.closest('[data-lib]');
    if (!btn) return;
    const id = btn.closest('[data-id]').dataset.id;
    const s = settings();
    const rb = s.library[id];
    const act = btn.dataset.lib;
    if (act === 'edit') return hooks.openEditor(id);
    if (act === 'duplicate') {
        const copy = structuredClone(rb);
        copy.name = `Copy of ${rb.name || id}`;
        copy.id = newRulebookId(copy.name);
        s.library[copy.id] = copy;
    }
    if (act === 'export') {
        const blob = new Blob([JSON.stringify(rb, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${id}.rulebook.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        return;
    }
    if (act === 'delete') {
        const users = usedBy(id);
        const ok = await ctx().Popup.show.confirm('Delete rulebook?', `"${esc(rb.name || id)}" will be removed from the library${users.length ? ` and unassigned from ${esc(users.join(', '))}` : ''}. Chats that use it will stop judging until you attach another.`);
        if (!ok) return;
        delete s.library[id];
        for (const [av, r] of Object.entries(s.assignments)) if (r === id) delete s.assignments[av];
    }
    saveSettings();
    renderSettings();
    hooks.changed();
}

async function importFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
        if (file.size > 2 * 1024 * 1024) throw new Error('The file is over 2 MB.');
        const json = JSON.parse(await file.text());
        const { errors } = validateRulebook(json);
        const s = settings();
        json.id = newRulebookId(json.name || file.name.replace(/\.json$/i, ''));
        s.library[json.id] = json;
        saveSettings();
        renderSettings();
        if (errors.length) { toastr.warning(`Imported "${json.name || json.id}" with ${errors.length} problem(s). Open it in the editor to fix them.`); hooks.openEditor(json.id); }
        else toastr.success(`Imported "${json.name}"`);
    } catch (err) {
        toastr.error(`Could not import: ${err.message}`);
    }
}

function charRow(ch) {
    const s = settings();
    const lib = Object.entries(s.library);
    const cur = s.assignments[ch.avatar] || '';
    return `<label class="srb-char-row"><span class="srb-char-name">${esc(ch.name)}</span>
        <select class="text_pole" data-assign="${esc(ch.avatar)}"><option value="">None</option>${lib.map(([id, r]) => `<option value="${esc(id)}" ${id === cur ? 'selected' : ''}>${esc(r.name || id)}</option>`).join('')}</select></label>`;
}

function renderCharacters() {
    const s = settings();
    const chars = (ctx().characters || []).filter(c => c?.avatar);
    const q = $id('srb_char_search').value.trim().toLowerCase();
    $id('srb_char_results').innerHTML = q ? (chars.filter(c => c.name?.toLowerCase().includes(q)).slice(0, 8).map(charRow).join('') || '<div class="srb-hint">No characters match.</div>') : '';
    const recent = [...chars].sort((a, b) => (Number(b.date_last_chat) || 0) - (Number(a.date_last_chat) || 0)).slice(0, 3);
    $id('srb_char_recent').innerHTML = recent.map(charRow).join('') || '<div class="srb-hint">No chats yet.</div>';
    const assigned = chars.filter(c => s.assignments[c.avatar]);
    const btn = $id('srb_char_all');
    btn.textContent = showAllAssigned ? 'Hide the list' : `Show the ${assigned.length} character${assigned.length === 1 ? '' : 's'} with a rulebook`;
    btn.hidden = !assigned.length;
    const box = $id('srb_char_assigned');
    box.hidden = !showAllAssigned;
    box.innerHTML = showAllAssigned ? assigned.map(charRow).join('') : '';
}
