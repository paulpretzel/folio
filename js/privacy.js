/* Privacy: a running log of every connection Folio makes to a server other than
   its own, shown in Settings → Privacy so anyone can check that nothing leaves the
   device. Folio's own files (the app, pdf.js, the guide book) don't count; in the
   web version they come from the address Folio was installed from.

   Two sources feed the log:
   - the browser's resource timing, which lists everything this page loaded, and
   - Content Security Policy reports, for anything the policy stopped.
   It covers what the app's pages load. pdf.js's worker only talks to the page. */
import { $, esc, ls, relTime } from './ui.js';

const MAX = 50;
const log = ls.get('privacy', null) || { since: Date.now(), made: [], blocked: [] };
if (!log.since) log.since = Date.now();
ls.set('privacy', log);

const outside = (url) => {
  try {
    const u = new URL(url, location.href);
    return /^https?:$/.test(u.protocol) && u.origin !== location.origin ? u : null;
  } catch { return null; }
};
function record(list, url) {
  const u = outside(url);
  if (!u) return;
  const entry = { host: u.host, url: u.origin + u.pathname, at: Date.now() };
  const last = log[list][0];
  if (last && last.url === entry.url && entry.at - last.at < 60_000) return;   // one line per burst, not per byte range
  // A blocked load still shows up in resource timing; it belongs under blocked only.
  const same = (e) => e.url === entry.url && Math.abs(e.at - entry.at) < 5000;
  if (list === 'made' && log.blocked.some(same)) return;
  if (list === 'made' && (log.fetched || []).some((e) => e.url === entry.url && Math.abs(e.at - entry.at) < 60_000)) return;
  if (list === 'blocked') log.made = log.made.filter((e) => !same(e));
  log[list].unshift(entry);
  log[list].length = Math.min(log[list].length, MAX);
  ls.set('privacy', log);
}

try {
  new PerformanceObserver((list) => { for (const e of list.getEntries()) record('made', e.name); })
    .observe({ type: 'resource', buffered: true });
} catch {}
document.addEventListener('securitypolicyviolation', (e) => record('blocked', e.blockedURI));

/** A free book downloaded from Folio's library at the reader's request, listed by name. */
export function logDownload(url, title) {
  const u = new URL(url, location.href);
  const entry = { host: u.host, url: u.origin + u.pathname, title, at: Date.now() };
  log.made = log.made.filter((e) => !(e.url === entry.url && Math.abs(e.at - entry.at) < 60_000));   // the same request, seen by the browser
  log.fetched = [entry, ...(log.fetched || [])].slice(0, MAX);
  ls.set('privacy', log);
}

const day = (ts) => new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

/** Fill in Settings → Privacy and About each time Settings opens. */
async function showPrivacy() {
  const made = log.made.length, blocked = log.blocked.length;
  $('#privacy-status').classList.toggle('clear', !made);
  $('#privacy-headline').textContent = made ? `${made === MAX ? `${MAX}+` : made} outside connection${made === 1 ? '' : 's'}` : 'No outside connections';
  const web = location.protocol === 'https:' && !/^(localhost|127\.)/.test(location.hostname);
  $('#privacy-detail').textContent = (made
    ? `Since ${day(log.since)}, Folio has connected to the servers listed below.`
    : `Since ${day(log.since)}, Folio hasn’t connected to any ${log.fetched?.length ? 'outside ' : ''}server.`)
    + (web ? ` It only fetches its own updates from ${location.host}, where you installed it.` : '')
    + (log.fetched?.length ? ' The free classics you downloaded from Folio’s own library are listed below.' : '');
  const rows = [
    ...log.made.map((e) => ({ ...e, kind: 'Connected' })),
    ...log.blocked.map((e) => ({ ...e, kind: 'Blocked' })),
    ...(log.fetched || []).map((e) => ({ ...e, kind: 'Downloaded' })),
  ].sort((a, b) => b.at - a.at);
  $('#privacy-log').hidden = !rows.length;
  $('#privacy-log-count').textContent = blocked ? ` · ${blocked} blocked` : '';
  $('#privacy-log-list').innerHTML = rows.map((e) =>
    `<li><span class="grow"><b>${esc(e.title || e.host)}</b><small>${esc(e.url)}</small></span><span class="muted small">${e.kind} · ${esc(relTime(e.at))}</span></li>`).join('');

  let build = '';
  try { build = (await caches.keys()).find((k) => /^folio-v\d+$/.test(k)) || ''; } catch {}
  $('#about-build').textContent = build ? ` build ${build.replace('folio-v', '')}` : '';
  $('#about-build').hidden = !build;
}
$('#lib-settings-btn').addEventListener('click', showPrivacy);
