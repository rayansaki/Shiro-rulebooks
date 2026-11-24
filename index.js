// Shuri Rulebooks: slow-burn relationship meters for SillyTavern, scored by a separate judge model.
import { ctx, settings, chatMeta, isSoloChat, getRulebook } from './src/state.js';
import {
    bus, status, onGenerationStarted, onGenerationEnded, onMessageReceived, updateInjection, attach,
    setEnabled, rejudgeLatest,
} from './src/controller.js';
import { createPanel, renderPanel, panel } from './src/ui/panel.js';
import { createStartDialog, openStartDialog, createEditor, openEditor, createTrace, openTrace, renderTrace, startDialog } from './src/ui/dialogs.js';
import { renderChips, renderAllChips, bindChipClicks } from './src/ui/chips.js';
import { createSettings, renderSettings } from './src/ui/settings.js';

const LOG = '[Rulebook]';

function refreshAll() {
    renderPanel();
    renderAllChips();
    renderTrace();
}

function openSettingsDrawer() {
    const drawer = document.querySelector('#srb_settings .inline-drawer-content');
    const extPanel = document.getElementById('rm_extensions_block');
    if (extPanel && !extPanel.classList.contains('openDrawer')) document.querySelector('#extensions-settings-button .drawer-toggle')?.click();
    if (drawer && getComputedStyle(drawer).display === 'none') document.querySelector('#srb_settings .inline-drawer-toggle')?.click();
    setTimeout(() => document.getElementById('srb_settings')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 200);
}

async function onChatChanged() {
    status.errors.clear();
    status.pending.clear();
    const s = settings();
    const w = panel();
    if (isSoloChat() && s.enabled) {
        const c = ctx();
        const meta = chatMeta();
        const ch = c.characters[c.characterId];
        const assigned = s.assignments[ch?.avatar];
        // A new chat (just the greeting) with an assigned character gets its rulebook automatically.
        if (!meta && assigned && getRulebook(assigned) && c.chat.filter(m => !m.is_user).length <= 1 && !c.chat.some(m => m.is_user)) {
            attach(assigned);
            w.open();
        } else if (meta && s.autoOpenWindow && !w.isOpen) {
            w.open();
        }
    }
    updateInjection();
    refreshAll();
    renderSettings();
}

function addMenuButton() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu) return;
    const item = document.createElement('div');
    item.id = 'srb_wand';
    item.className = 'list-group-item flex-container flexGap5';
    item.innerHTML = '<div class="fa-solid fa-scale-balanced extensionsMenuExtensionButton"></div><span>Rulebook</span>';
    item.addEventListener('click', () => { panel().open(); renderPanel(); });
    menu.appendChild(item);
}

function registerCommand() {
    const c = ctx();
    const { SlashCommandParser, SlashCommand, SlashCommandArgument, ARGUMENT_TYPE } = c;
    if (!SlashCommandParser?.addCommandObject) return;
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'rulebook',
        helpString: 'Rulebook: <code>/rulebook</code> or <code>/rulebook open</code> opens the window; also <code>close</code>, <code>on</code>, <code>off</code> (for this chat) and <code>rejudge</code> (the last reply).',
        unnamedArgumentList: [SlashCommandArgument.fromProps({
            description: 'open, close, on, off or rejudge',
            typeList: [ARGUMENT_TYPE.STRING],
            isRequired: false,
            enumList: ['open', 'close', 'on', 'off', 'rejudge'],
        })],
        callback: async (_args, value) => {
            const v = String(value || 'open').trim().toLowerCase();
            if (v === 'open') { panel().open(); renderPanel(); }
            else if (v === 'close') panel().close();
            else if (v === 'on' || v === 'off') { if (chatMeta()) await setEnabled(v === 'on'); }
            else if (v === 'rejudge') await rejudgeLatest();
            return '';
        },
    }));
}

jQuery(async () => {
    try {
        settings();
        createPanel({
            openStart: (o) => openStartDialog(o),
            openEditor: (id) => openEditor(id),
            openTrace: () => openTrace(),
            openSettings: () => openSettingsDrawer(),
        });
        createStartDialog();
        createEditor(() => { renderSettings(); refreshAll(); });
        createTrace();
        await createSettings({
            openWindow: () => { panel().open(); renderPanel(); },
            openEditor: (id) => openEditor(id),
            changed: () => { updateInjection(); refreshAll(); },
        });
        addMenuButton();
        registerCommand();
        bindChipClicks();

        bus.addEventListener('change', (e) => {
            renderPanel();
            renderTrace();
            if (Number.isInteger(e.detail?.index)) renderChips(e.detail.index); else renderAllChips();
            if (Number.isInteger(e.detail?.index)) {
                // A judgement can change how the previous reply's chips look (revisions).
                for (let i = e.detail.index - 1; i >= 0; i--) { if (!ctx().chat[i]?.is_user) { renderChips(i); break; } }
            }
        });
        bus.addEventListener('assessed', (e) => openStartDialog({ values: e.detail.values }));

        const { eventSource, eventTypes: et } = ctx();
        eventSource.on(et.CHAT_CHANGED, onChatChanged);
        eventSource.on(et.GENERATION_STARTED, onGenerationStarted);
        eventSource.on(et.GENERATION_ENDED, onGenerationEnded);
        eventSource.on(et.GENERATION_STOPPED, onGenerationEnded);
        eventSource.on(et.MESSAGE_RECEIVED, onMessageReceived);
        eventSource.on(et.CHARACTER_MESSAGE_RENDERED, (i) => renderChips(Number(i)));
        eventSource.on(et.MESSAGE_SWIPED, (i) => { updateInjection(); renderChips(Number(i)); renderPanel(); });
        eventSource.on(et.MESSAGE_DELETED, () => { updateInjection(); refreshAll(); });
        eventSource.on(et.MESSAGE_UPDATED, (i) => renderChips(Number(i)));
        eventSource.on(et.MORE_MESSAGES_LOADED, renderAllChips);
        if (et.CHAT_DELETED) eventSource.on(et.CHAT_DELETED, refreshAll);

        if (panel().wasOpen() && isSoloChat()) panel().open();
        if (startDialog().isOpen) startDialog().close();
        await onChatChanged();
        console.log(`${LOG} ready`);
    } catch (err) {
        console.error(`${LOG} failed to start`, err);
        toastr.error(`Rulebook failed to start: ${err.message}`);
    }
});
