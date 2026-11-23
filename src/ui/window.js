// A floating window: drag it by the header, resize it from any edge or corner, minimise or close it.
// Position and size are remembered per window, per browser.

const LS = 'srb_windows';
const loadAll = () => { try { return JSON.parse(localStorage.getItem(LS)) || {}; } catch { return {}; } };
const saveOne = (id, patch) => { try { const all = loadAll(); all[id] = { ...(all[id] || {}), ...patch }; localStorage.setItem(LS, JSON.stringify(all)); } catch { /* storage may be unavailable */ } };

let topZ = 3100;
const EDGES = ['n', 'e', 's', 'w', 'ne', 'nw', 'se', 'sw'];

export class FloatingWindow {
    /**
     * @param {object} o
     * @param {string} o.id unique id, also used to remember geometry
     * @param {string} o.title
     * @param {number} [o.width] default width in px
     * @param {number} [o.height] default height in px
     * @param {number} [o.minWidth]
     * @param {number} [o.minHeight]
     * @param {boolean} [o.minimisable]
     * @param {() => void} [o.onClose]
     */
    constructor(o) {
        this.o = { width: 380, height: 520, minWidth: 260, minHeight: 160, minimisable: true, ...o };
        this.el = document.createElement('div');
        this.el.className = 'srb-window';
        this.el.id = `srb_win_${o.id}`;
        this.el.setAttribute('role', 'dialog');
        this.el.setAttribute('aria-label', o.title);
        this.el.innerHTML = `
            <div class="srb-win-header">
                <span class="srb-win-grip fa-solid fa-grip-vertical" aria-hidden="true"></span>
                <div class="srb-win-titles"><div class="srb-win-title"></div><div class="srb-win-subtitle"></div></div>
                <div class="srb-win-extra"></div>
                ${this.o.minimisable ? '<button type="button" class="srb-win-btn srb-win-min fa-solid fa-minus" title="Minimise" aria-label="Minimise"></button>' : ''}
                <button type="button" class="srb-win-btn srb-win-close fa-solid fa-xmark" title="Close" aria-label="Close"></button>
            </div>
            <div class="srb-win-body"></div>
            ${EDGES.map(e => `<div class="srb-win-edge srb-edge-${e}" data-edge="${e}"></div>`).join('')}`;
        document.body.appendChild(this.el);
        this.header = this.el.querySelector('.srb-win-header');
        this.body = this.el.querySelector('.srb-win-body');
        this.extra = this.el.querySelector('.srb-win-extra');
        this.setTitle(o.title);
        this.restore();
        this.bind();
    }

    setTitle(title, subtitle = '') {
        this.el.querySelector('.srb-win-title').textContent = title;
        this.el.querySelector('.srb-win-subtitle').textContent = subtitle;
        this.el.querySelector('.srb-win-subtitle').style.display = subtitle ? '' : 'none';
    }

    get isOpen() { return this.el.classList.contains('srb-open'); }
    get isMinimised() { return this.el.classList.contains('srb-minimised'); }

    open() {
        this.el.classList.add('srb-open');
        this.raise();
        this.clamp();
        saveOne(this.o.id, { open: true });
    }

    close() {
        this.el.classList.remove('srb-open');
        saveOne(this.o.id, { open: false });
        this.o.onClose?.();
    }

    toggle() { if (this.isOpen) this.close(); else this.open(); }

    setMinimised(min) {
        this.el.classList.toggle('srb-minimised', min);
        saveOne(this.o.id, { minimised: min });
        if (!min) this.clamp();
    }

    raise() { this.el.style.zIndex = String(++topZ); }

    wasOpen() { return !!loadAll()[this.o.id]?.open; }

    restore() {
        const g = loadAll()[this.o.id] || {};
        const vw = window.innerWidth, vh = window.innerHeight;
        const w = Math.min(g.width ?? this.o.width, vw - 8);
        const h = Math.min(g.height ?? this.o.height, vh - 8);
        this.el.style.width = `${Math.max(this.o.minWidth, w)}px`;
        this.el.style.height = `${Math.max(this.o.minHeight, h)}px`;
        const defLeft = this.o.align === 'right' ? vw - w - 16 : (vw - w) / 2;
        this.el.style.left = `${g.left ?? Math.max(4, defLeft)}px`;
        this.el.style.top = `${g.top ?? Math.max(4, vh * 0.12)}px`;
        if (g.minimised) this.el.classList.add('srb-minimised');
    }

    /** Keeps the header reachable after the browser window shrinks. */
    clamp() {
        const r = this.el.getBoundingClientRect();
        const vw = window.innerWidth, vh = window.innerHeight;
        if (r.width > vw - 8) this.el.style.width = `${Math.max(this.o.minWidth, vw - 8)}px`;
        if (!this.isMinimised && r.height > vh - 8) this.el.style.height = `${Math.max(this.o.minHeight, vh - 8)}px`;
        const w = this.el.offsetWidth;
        this.el.style.left = `${Math.min(Math.max(0, r.left), Math.max(0, vw - Math.min(w, 80)))}px`;
        this.el.style.top = `${Math.min(Math.max(0, r.top), Math.max(0, vh - 44))}px`;
    }

    bind() {
        this.el.addEventListener('pointerdown', () => this.raise(), true);
        this.el.querySelector('.srb-win-close').addEventListener('click', () => this.close());
        this.el.querySelector('.srb-win-min')?.addEventListener('click', () => this.setMinimised(!this.isMinimised));
        window.addEventListener('resize', () => { if (this.isOpen) this.clamp(); });

        // Drag by the header (not by its buttons or controls).
        let drag = null;
        this.header.addEventListener('pointerdown', (e) => {
            if (e.button !== 0 || e.target.closest('button, input, select, label, a')) return;
            const r = this.el.getBoundingClientRect();
            drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
            this.header.setPointerCapture(e.pointerId);
            e.preventDefault();
        });
        this.header.addEventListener('pointermove', (e) => {
            if (!drag) return;
            const w = this.el.offsetWidth;
            this.el.style.left = `${Math.min(Math.max(0, e.clientX - drag.dx), window.innerWidth - Math.min(w, 80))}px`;
            this.el.style.top = `${Math.min(Math.max(0, e.clientY - drag.dy), window.innerHeight - 44)}px`;
        });
        const endDrag = () => {
            if (!drag) return;
            drag = null;
            saveOne(this.o.id, { left: parseFloat(this.el.style.left), top: parseFloat(this.el.style.top) });
        };
        this.header.addEventListener('pointerup', endDrag);
        this.header.addEventListener('pointercancel', endDrag);

        // Resize from any edge or corner.
        let rs = null;
        this.el.querySelectorAll('.srb-win-edge').forEach(edge => {
            edge.addEventListener('pointerdown', (e) => {
                if (e.button !== 0 || this.isMinimised) return;
                const r = this.el.getBoundingClientRect();
                rs = { edge: edge.dataset.edge, x: e.clientX, y: e.clientY, l: r.left, t: r.top, w: r.width, h: r.height };
                edge.setPointerCapture(e.pointerId);
                e.preventDefault();
                e.stopPropagation();
            });
            edge.addEventListener('pointermove', (e) => {
                if (!rs) return;
                const dx = e.clientX - rs.x, dy = e.clientY - rs.y;
                const { minWidth: mw, minHeight: mh } = this.o;
                let { l, t, w, h } = rs;
                if (rs.edge.includes('e')) w = Math.max(mw, Math.min(rs.w + dx, window.innerWidth - rs.l));
                if (rs.edge.includes('s')) h = Math.max(mh, Math.min(rs.h + dy, window.innerHeight - rs.t));
                if (rs.edge.includes('w')) { w = Math.max(mw, rs.w - dx); l = Math.max(0, rs.l + rs.w - w); w = rs.l + rs.w - l; }
                if (rs.edge.includes('n')) { h = Math.max(mh, rs.h - dy); t = Math.max(0, rs.t + rs.h - h); h = rs.t + rs.h - t; }
                Object.assign(this.el.style, { left: `${l}px`, top: `${t}px`, width: `${w}px`, height: `${h}px` });
            });
            const endResize = () => {
                if (!rs) return;
                rs = null;
                saveOne(this.o.id, {
                    left: parseFloat(this.el.style.left), top: parseFloat(this.el.style.top),
                    width: parseFloat(this.el.style.width) || this.el.offsetWidth,
                    height: parseFloat(this.el.style.height) || this.el.offsetHeight,
                });
            };
            edge.addEventListener('pointerup', endResize);
            edge.addEventListener('pointercancel', endResize);
        });
    }
}

/** Small helper: creates an element from an HTML string. */
export function html(str) {
    const t = document.createElement('template');
    t.innerHTML = str.trim();
    return t.content.firstElementChild;
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));
