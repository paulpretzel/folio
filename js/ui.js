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
    ms = Math.max(ms, 5000);
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

/* Modals are announced as dialogs, take the focus while open (Tab stays inside),
   and hand it back to whatever opened them. */
export function openModal(el, onClose) {
  const back = document.activeElement;
  el.hidden = false;
  el.querySelector('.modal-card')?.focus({ preventScroll: true });
  pushOverlay(el.id, () => {
    el.hidden = true;
    onClose?.();
    if (back?.isConnected) back.focus?.({ preventScroll: true });
  });
}
const FOCUSABLE = 'button:not([hidden]):not([disabled]), input:not([hidden]):not([disabled]), select, textarea:not([hidden]), a[href], summary, [tabindex="0"]';
addEventListener('keydown', (e) => {
  if (e.key !== 'Tab') return;
  const m = document.getElementById(topOverlay() || '');
  if (!m?.classList.contains('modal') || m.hidden) return;
  const items = $$(FOCUSABLE, m).filter((x) => x.offsetParent !== null);
  if (!items.length) return;
  const first = items[0], last = items[items.length - 1];
  if (!m.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
  else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});
for (const m of $$('.modal')) {
  m.setAttribute('role', 'dialog');
  m.setAttribute('aria-modal', 'true');
  const card = m.querySelector('.modal-card'), title = m.querySelector('h3, .action-title');
  card?.setAttribute('tabindex', '-1');
  if (title) { title.id ||= `${m.id}-title`; m.setAttribute('aria-labelledby', title.id); }
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
/** A message with just an OK button. */
export function infoDialog({ title, message }) {
  $('#dialog-cancel').hidden = true;
  return promptDialog({ title, message, noInput: true, okText: 'OK' }).finally(() => { $('#dialog-cancel').hidden = false; });
}

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
