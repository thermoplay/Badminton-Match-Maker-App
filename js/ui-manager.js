// =============================================================================
// UI MANAGER — ui-manager.js
// Responsibilities: Manages all modal/overlay UI elements consistently.
// =============================================================================

function _escapeHTML(str) {
    if (typeof str !== 'string') return '';
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

const UIManager = {
    _modal: null,
    _backdrop: null,

    _init() {
        if (this._modal) return;
        this._backdrop = document.createElement('div');
        this._backdrop.className = 'modal-backdrop';
        this._backdrop.onclick = () => this.hide();

        this._modal = document.createElement('div');
        this._modal.className = 'modal-container';
        this._modal.addEventListener('click', (e) => {
            if (e.target === this._modal && this._modal.classList.contains('modal-type-card')) {
                this.hide();
            }
        });

        document.body.appendChild(this._backdrop);
        document.body.appendChild(this._modal);
    },

    show(contentHTML, type = 'sheet') {
        this._init();
        this._modal.innerHTML = contentHTML;
        // The UIManager now has its own styles, no need to borrow from actionMenu
        this._modal.className = `modal-container modal-type-${type}`;
        document.body.classList.add('modal-open');
        this._backdrop.classList.add('visible');
        this._modal.classList.add('visible');
    },

    hide() {
        if (!this._modal) return;
        document.body.classList.remove('modal-open');
        this._backdrop.classList.remove('visible');
        this._modal.classList.remove('visible');
    },

    confirm({ title, message, confirmText = 'Confirm', onConfirm, isDestructive = false }) {
        const confirmBtnClass = isDestructive ? 'btn-main btn-danger' : 'btn-main';
        const content = `<div class="menu-card"><h2>${_escapeHTML(title)}</h2><p>${_escapeHTML(message)}</p><button id="modalConfirm" class="${confirmBtnClass} menu-btn">${_escapeHTML(confirmText)}</button><button id="modalCancel" class="btn-cancel">Cancel</button></div>`;
        this.show(content, 'card');
        document.getElementById('modalConfirm').onclick = () => { this.hide(); onConfirm(); };
        document.getElementById('modalCancel').onclick = () => this.hide();
    },

    prompt({ title, initialValue = '', placeholder = '', confirmText = 'OK', onConfirm }) {
        const content = `
            <div class="menu-card">
                <h2>${_escapeHTML(title)}</h2>
                <input type="text" id="modalInput" class="input-modal-field" value="${_escapeHTML(initialValue)}" placeholder="${_escapeHTML(placeholder)}">
                <button id="modalConfirm" class="btn-main menu-btn">${_escapeHTML(confirmText)}</button>
                <button id="modalCancel" class="btn-cancel">Cancel</button>
            </div>
        `;
        this.show(content, 'card');

        const inputEl = document.getElementById('modalInput');
        const confirmBtn = document.getElementById('modalConfirm');
        const cancelBtn = document.getElementById('modalCancel');

        inputEl.focus();
        inputEl.select();

        const submit = () => { this.hide(); onConfirm(inputEl.value); };

        confirmBtn.onclick = submit;
        cancelBtn.onclick = () => this.hide();
        inputEl.onkeydown = (e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') this.hide(); };
    }
};

window.UIManager = UIManager;