/* Shared helpers: DOM shortcuts, toast, overlay stack, dialogs, sheets. */

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const icon = (name) => `<svg><use href="#i-${name}"/></svg>`;
export const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
export const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

export const ls = {
  get(k, d = null) { try { const v = localStorage.getItem('folio:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('folio:' + k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem('folio:' + k); } catch {} },
};

export function relTime(ts) {
  if (!ts) return '';
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
export function fmtDuration(sec) {
  sec = Math.round(sec || 0);
  if (sec < 60) return '0m';
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}
export const safeName = (s) => s.replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 80) || 'book';

/* ---------- toast & busy ---------- */
const toastEl = $('#toast');
let toastTimer;
export function toast(msg, { action, onAction, ms = 2400 } = {}) {
  clearTimeout(toastTimer);
  toastEl.replaceChildren(document.createTextNode(msg));
  if (action) {
    const b = document.createElement('button');
    b.className = 'toast-action';
    b.textContent = action;
    b.onclick = () => { toastEl.classList.remove('show'); onAction?.(); };
    toastEl.append(b);
    ms = 5000;
  }
  toastEl.classList.add('show');
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
}
export const hideToast = () => toastEl.classList.remove('show');

export function busy(on, text = 'Working…') {
  $('#busy').hidden = !on;
  $('#busy-text').textContent = text;
}

/* ---------- overlay stack wired to the history (Android back button) ---------- */
const overlays = [];
const popWaiters = [];
export function pushOverlay(name, close) {
  overlays.push({ name, close });
  history.pushState({ folio: overlays.length }, '');
}
export function closeTop() {
  return new Promise((resolve) => {
    if (!overlays.length) return resolve();
    popWaiters.push(resolve);
    history.back();
  });
}
addEventListener('popstate', () => {
  const o = overlays.pop();
  o?.close();
  popWaiters.shift()?.();
});
export const topOverlay = () => overlays[overlays.length - 1]?.name;
export const hasOverlay = (name) => overlays.some((o) => o.name === name);

export function openModal(el, onClose) {
  el.hidden = false;
  pushOverlay(el.id, () => { el.hidden = true; onClose?.(); });
}
for (const m of $$('.modal')) {
  m.addEventListener('click', (e) => {
    // .sticky modals hold unsaved edits, so a stray tap outside shouldn't dismiss them
    if ((e.target === m && !m.classList.contains('sticky')) || e.target.closest('[data-close]')) closeTop();
  });
}

/* ---------- dialogs ---------- */
export function promptDialog({ title, value = '', placeholder = '', multiline = false, okText = 'Save', inputType = 'text', message = null, noInput = false, danger = false }) {
  return new Promise((resolve) => {
    const dlg = $('#dialog');
    $('#dialog-title').textContent = title;
    const msg = $('#dialog-msg');
    msg.hidden = !message; msg.textContent = message || '';
    const input = $('#dialog-input'), ta = $('#dialog-textarea');
    input.hidden = noInput || multiline;
    ta.hidden = noInput || !multiline;
    const field = multiline ? ta : input;
    field.value = value;
    field.placeholder = placeholder;
    input.type = inputType;
    input.inputMode = inputType === 'number' ? 'numeric' : 'text';
    const ok = $('#dialog-ok');
    ok.textContent = okText;
    ok.classList.toggle('danger', danger);
    let result = null;
    const submit = () => { result = noInput ? true : field.value; closeTop(); };
    ok.onclick = submit;
    $('#dialog-cancel').onclick = () => closeTop();
    input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } };
    openModal(dlg, () => resolve(result));
    if (!noInput) { field.focus(); if (!multiline) field.select(); }
  });
}
export const confirmDialog = (opts) => promptDialog({ ...opts, noInput: true });

/** Bottom sheet menu. Actions: { label, icon, danger, check, sub, run } */
export function actionSheet(title, actions) {
  $('#action-title').textContent = title || '';
  $('#action-title').hidden = !title;
  const list = $('#action-list');
  list.replaceChildren(...actions.map((a) => {
    const b = document.createElement('button');
    b.innerHTML = `${a.icon ? icon(a.icon) : ''}<span class="grow">${esc(a.label)}${a.sub ? `<small>${esc(a.sub)}</small>` : ''}</span>${a.check ? icon('check') : ''}`;
    if (a.danger) b.className = 'danger';
    if (a.check) b.classList.add('checked');
    b.onclick = async () => { await closeTop(); a.run?.(); };
    return b;
  }));
  openModal($('#action-sheet'));
}

/* ---------- file share/download ---------- */
export async function shareOrDownload(filename, text, mime) {
  const file = new File([text], filename, { type: mime });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: filename }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
