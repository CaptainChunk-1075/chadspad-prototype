import * as S from './store.js';
import { seedNotes } from './seed.js';
import { THEMES, applyTheme } from './themes.js';
import { esc, emojify, formatPhone, fmtTime, relTime, tomorrowAM, toLocalInput, startOfDay, phoneDigits } from './util.js';
import { openNew, prefetchScanner } from './capture.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const ui = { q: '', sel: null, open: null, archive: false, filter: null, fresh: new Set(), forcedView: null };
export const app = { ui, refresh: () => render(), select, toast, highlightNew };

function setView() {
  const v = ui.forcedView || (window.innerWidth < 820 ? 'phone' : 'desk');
  if (document.body.dataset.view !== v) { document.body.dataset.view = v; render(); }
  if (v === 'phone') prefetchScanner();
}

// ---------- helpers ----------
const laneOf = (n) => (n.status === 'Waiting' && !S.isDueNudge(n)) ? 'Waiting' : n.priority;
function visible() {
  let list = ui.archive ? S.archived() : S.active();
  if (ui.q) list = (ui.archive ? S.all() : list).filter(n => S.matchesQuery(n, ui.q));
  if (ui.filter && !ui.archive) {
    const t = Date.now(), sod = startOfDay(t);
    if (ui.filter === 'today') list = list.filter(n => n.createdAt >= sod || (n.followUpAt && n.followUpAt >= sod && n.followUpAt < sod + 864e5));
    if (ui.filter === 'overdue') list = list.filter(n => (n.followUpAt && n.followUpAt < t) || (n.status === 'Open' && n.priority === 'High' && n.createdAt < sod));
  }
  return list;
}
function sortLane(list, lane) {
  if (lane === 'Waiting') return list.sort((a, b) => (a.followUpAt || 0) - (b.followUpAt || 0));
  return list.sort((a, b) => (S.isDueNudge(b) - S.isDueNudge(a)) || (a.order - b.order) || (b.createdAt - a.createdAt));
}
function orderedIds() {
  if (document.body.dataset.view === 'phone' || ui.archive) return $$('[data-id]', document.body.dataset.view === 'phone' ? $('#phone') : $('#desk')).map(e => e.dataset.id);
  return $$('#desk .card').map(e => e.dataset.id);
}
const tagsOn = () => S.getSettings().tagsEnabled;
function phoneHTML(c, big) {
  if (!c.phone) return '';
  return `<div class="${big ? 'bigphone' : 'digits'}">${esc(formatPhone(c.phone))}${c.ext ? ` <span class="ext">x${esc(c.ext)}</span>` : ''}</div>`;
}

// ---------- render ----------
function render() {
  renderCounters();
  renderSync();
  if (document.body.dataset.view === 'phone') renderPhone(); else renderDesk();
  if (ui.open) renderDetail();
}
function renderCounters() {
  const c = S.counters();
  $('#counters').innerHTML = [['today', 'Today', c.today, ''], ['overdue', 'Overdue', c.overdue, 'over'], ['done', 'Done today', c.doneToday, 'done']]
    .map(([k, l, v, cls]) => `<button class="counter ${cls} ${ui.filter === k ? 'active' : ''}" data-filter="${k}" title="Filter: ${l}"><b>${v}</b><span>${l}</span></button>`).join('');
}
function renderSync() {
  const q = S.queue().length, el = $('#sync');
  el.classList.toggle('pending', q > 0);
  el.lastElementChild.textContent = q ? `On this device · ${q} pending sync` : (navigator.onLine ? 'Saved · synced' : 'Offline · saved on this device');
}
function card(n) {
  const due = S.isDueNudge(n);
  const chips = [];
  if (due) chips.push(`<span class="chip nudge">⏰ Follow-up due</span>`);
  if (n.status === 'Waiting' && !due) chips.push(`<span class="chip wait">${esc(n.result || 'Waiting')} · ${esc(relTime(n.followUpAt))}</span>`);
  if (n.archived) chips.push(`<span class="chip">${esc(n.result || 'Archived')} · ${esc(fmtTime(n.archivedAt))}</span>`);
  if (n.audio) chips.push(`<span class="chip">🎙 Voicemail</span>`);
  if (tagsOn()) n.tags.forEach(t => chips.push(`<span class="chip">${esc(t)}</span>`));
  if (S.pastNotesFor(n).length && !n.archived) chips.push(`<span class="chip" title="Past notes with this person">↺ ${S.pastNotesFor(n).length} past</span>`);
  chips.push(`<span class="faint small">${esc(fmtTime(n.createdAt))}</span>`);
  const who = [n.contact.name, n.contact.company].filter(Boolean).join(' · ');
  return `<div class="card ${n.photo ? 'has-thumb' : ''} ${ui.sel === n.id ? 'sel' : ''} ${ui.fresh.has(n.id) ? 'fresh' : ''}" data-id="${n.id}" data-p="${n.priority}" draggable="${!n.archived && document.body.dataset.view === 'desk'}" tabindex="0">
    ${n.photo ? `<img class="thumb" src="${n.photo}" alt="">` : ''}
    <div class="t">${esc(emojify(n.title || n.ask || n.rawText).slice(0, 90))}</div>
    ${who ? `<div class="who">${esc(who)}</div>` : ''}
    ${phoneHTML(n.contact)}
    <div class="meta">${chips.join('')}</div></div>`;
}
function renderDesk() {
  const el = $('#desk');
  if (ui.archive) return renderArchive(el);
  const list = visible();
  const lanes = { High: [], Medium: [], Low: [], Waiting: [] };
  list.forEach(n => lanes[laneOf(n)].push(n));
  el.innerHTML = `<div class="board">${Object.entries(lanes).map(([lane, arr]) => `
    <div class="col" data-col="${lane}">
      <div class="col-h">${lane === 'Waiting' ? '⏳ Waiting / follow-up' : lane} <span class="n">${arr.length}</span>
        <span class="spacer"></span>${lane !== 'Waiting' ? `<span class="faint small">${{ High: '1', Medium: '2', Low: '3' }[lane]}</span>` : ''}</div>
      <div class="col-body">${sortLane(arr, lane).map(card).join('') || `<div class="empty">${lane === 'Waiting' ? 'Left VM / Waiting notes rest here until their follow-up time.' : 'Nothing here'}</div>`}</div>
    </div>`).join('')}</div>`;
}
function renderArchive(el) {
  const list = visible().sort((a, b) => (b.archivedAt || b.updatedAt) - (a.archivedAt || a.updatedAt));
  el.innerHTML = `<div class="archive"><h2 style="margin:4px 0 4px">Archive <span class="muted small">${list.length} notes · nothing is ever deleted · search covers names, numbers, call notes, dates</span></h2>
    <button class="btn" id="btn-back">← Back to desk</button>
    <div style="margin-top:10px">${list.map(n => `<div class="arow" data-id="${n.id}">
      <span class="chip ${n.priority}">${n.priority}</span><span><b>${esc(emojify(n.title))}</b><br><span class="muted small">${esc(emojify(n.ask || n.rawText).slice(0, 90))}</span></span>
      <span>${esc(n.contact.name)}<br><span class="muted small">${esc(formatPhone(n.contact.phone))}</span></span>
      <span class="small">${esc(n.result || n.status)}<br><span class="muted">${esc(fmtTime(n.archivedAt || n.updatedAt))}</span></span>
      <span class="small muted">${n.archived ? 'Archived' : 'Active'}</span></div>`).join('') || '<div class="empty">No matches</div>'}</div></div>`;
}
function renderPhone() {
  const el = $('#phone'); const list = visible();
  if (ui.archive) return renderArchive(el);
  const groups = [['⏰ Follow-ups due', list.filter(n => S.isDueNudge(n))], ['High', list.filter(n => laneOf(n) === 'High' && !S.isDueNudge(n))], ['Medium', list.filter(n => laneOf(n) === 'Medium' && !S.isDueNudge(n))], ['Low', list.filter(n => laneOf(n) === 'Low' && !S.isDueNudge(n))], ['Waiting', list.filter(n => laneOf(n) === 'Waiting')]];
  el.innerHTML = `<div class="phone-list">
    <div style="display:flex;gap:6px;margin-top:4px"><button class="btn" id="btn-archive-p">Archive</button><button class="btn" id="btn-morning-p">☀ Morning</button><button class="btn" id="btn-desk-p" title="Desk layout">🖥 Desk</button></div>
    ${groups.filter(g => g[1].length).map(([h, arr]) => `<h4>${h} · ${arr.length}</h4>${sortLane(arr, h === 'Waiting' ? 'Waiting' : 'x').map(card).join('')}`).join('') || '<div class="empty">No notes yet. Tap + to snap one.</div>'}</div>`;
}

// ---------- detail panel ----------
function select(id, open) {
  ui.sel = id;
  $$('.card.sel').forEach(e => e.classList.remove('sel'));
  const el = document.querySelector(`.card[data-id="${id}"]`); if (el) { el.classList.add('sel'); el.scrollIntoView({ block: 'nearest' }); }
  if (open) { ui.open = id; renderDetail(); $('#detail').classList.add('open'); }
  else if (ui.open) { ui.open = id; renderDetail(); }
}
function closeDetail() { ui.open = null; $('#detail').classList.remove('open'); }
function renderDetail() {
  const n = S.get(ui.open); const el = $('#detail'); if (!n) return closeDetail();
  const past = S.pastNotesFor(n); const phone = document.body.dataset.view === 'phone';
  const scroll = el.dataset.for === n.id ? el.scrollTop : 0; el.dataset.for = n.id; const draft = $('#callnote', el)?.value || ''; const hadFocus = document.activeElement?.id === 'callnote';
  el.innerHTML = `
  <div class="panel-h"><span class="chip ${n.priority}">${n.priority}</span>
    <span class="chip ${n.status === 'Waiting' ? 'wait' : ''}">${n.status}${n.result ? ' · ' + esc(n.result) : ''}</span>
    ${S.isDueNudge(n) ? '<span class="chip nudge">Follow-up due</span>' : ''}
    <span class="spacer"></span>
    <button class="btn" disabled title="Coming later: share this note with Cierra or a shared list">Share</button>
    ${n.archived ? `<button class="btn" data-act="reopen">Reopen</button>` : `<button class="btn" data-act="archive" title="Archive (nothing is ever deleted)">Archive</button>`}
    <button class="btn ghost" data-act="close" aria-label="Close" title="Close (Esc)">✕</button></div>
  ${n.photo ? `<section><img class="photo-big" src="${n.photo}" data-act="zoom" alt="Original note photo"></section>` : ''}
  ${n.audio ? `<section><h3>Voicemail</h3><audio controls src="${n.audio}" style="width:100%"></audio>
    <div class="ocrnote">Transcript &amp; summary placeholder: the real app sends this audio to Grok Build's reader and fills in who called, the number and what they want.</div></section>` : ''}
  <section>
    ${n.contact.name || n.contact.company ? `<div class="bigname">${esc(n.contact.name)}${n.contact.company ? ` <span class="muted" style="font-weight:500;font-size:16px">· ${esc(n.contact.company)}</span>` : ''}</div>` : ''}
    ${phoneHTML(n.contact, true) || '<div class="muted">No phone number found. Add one below.</div>'}
    ${phone && n.contact.phone ? `<a class="btn primary big" style="margin-top:8px" href="tel:${phoneDigits(n.contact.phone)}${n.contact.ext ? ',' + n.contact.ext : ''}">📞 Call</a>` : ''}
    <details style="margin-top:8px"><summary class="muted small">Edit contact</summary>
      <div class="grid2"><div><label class="f">Name</label><input type="text" data-f="contact.name" value="${esc(n.contact.name)}"></div>
      <div><label class="f">Company</label><input type="text" data-f="contact.company" value="${esc(n.contact.company)}"></div>
      <div><label class="f">Phone</label><input type="tel" data-f="contact.phone" value="${esc(n.contact.phone)}"></div>
      <div><label class="f">Ext</label><input type="text" data-f="contact.ext" value="${esc(n.contact.ext)}"></div></div></details>
  </section>
  ${past.length ? `<section><h3>Past notes with this person · ${past.length}</h3>
    ${past.map(p => `<div class="past" data-open="${p.id}"><b>${esc(emojify(p.title))}</b> <span class="muted small">· ${esc(new Date(p.createdAt).toLocaleDateString())} · ${esc(p.result || p.status)}</span>
    ${p.callNotes.length ? `<div class="small muted">“${esc(p.callNotes[p.callNotes.length - 1].text)}”</div>` : ''}</div>`).join('')}</section>` : ''}
  <section><h3>The ask</h3>
    <input type="text" data-f="title" value="${esc(n.title)}" style="font-weight:600;font-size:16px">
    <label class="f">What they want</label><textarea data-f="ask" rows="2">${esc(n.ask)}</textarea>
    <label class="f">Note as written</label><div class="note-text" style="color:var(--pen-${n.inkColor || 'navy'})">${esc(emojify(n.rawText))}</div>
  </section>
  <section><h3>Priority <span class="faint" style="text-transform:none;letter-spacing:0">(keys 1 / 2 / 3)</span></h3><div class="prio-row">
    ${S.PRIORITIES.map(p => `<button class="btn ${p} ${n.priority === p ? 'sel' : ''}" data-prio="${p}">${p}</button>`).join('')}</div>
    ${tagsOn() ? `<h3 style="margin-top:12px">Tags</h3><div class="prio-row">${S.TAGS.map(t => `<button class="btn ${n.tags.includes(t) ? 'sel' : ''}" data-tag="${t}">${t}</button>`).join('')}</div>` : ''}
  </section>
  <section><h3>Check off · stamps the time</h3>
    <div class="results">
      <button class="btn Called" data-res="Called">✔ Called</button>
      <button class="btn lvm" data-res="Left VM">📼 Left VM</button>
      <button class="btn" data-res="Scheduled">📅 Scheduled</button>
      <button class="btn Waiting" data-res="Waiting">⏳ Waiting</button></div>
    <div class="small muted" style="margin-top:6px">Called / Scheduled check it off and archive it. Left VM / Waiting ask when to bring it back. <button class="btn ghost small" data-res="Other">Other…</button></div>
    ${n.followUpAt ? `<div class="small" style="margin-top:6px">Follow-up: <b>${esc(fmtTime(n.followUpAt))}</b> (${esc(relTime(n.followUpAt))})</div>` : ''}
  </section>
  <section><h3>Call notes</h3>
    <textarea id="callnote" rows="2" placeholder="What happened on the call…"></textarea>
    <div style="margin-top:6px"><button class="btn" data-act="addnote">Add call note</button></div>
    <ul class="hist" style="margin-top:8px">${[...n.callNotes].reverse().map(c => `<li><b>${esc(fmtTime(c.at))}</b>: ${esc(c.text)}</li>`).join('')}</ul>
  </section>
  <section><h3>History</h3><ul class="hist">${[...n.history].reverse().map(h => `<li>${esc(fmtTime(h.at))}: ${esc(h.action)}${h.detail ? ' · ' + esc(h.detail) : ''}</li>`).join('')}</ul>
    <div class="small faint" style="margin-top:6px">Owner: ${esc(n.owner === S.CURRENT_USER.id ? S.CURRENT_USER.name : n.owner)} · shared with: ${n.sharedWith.length ? esc(n.sharedWith.join(', ')) : 'nobody'}</div></section>`;
  el.scrollTop = scroll; if (draft) $('#callnote', el).value = draft; if (hadFocus) $('#callnote', el).focus();
}
$('#detail').addEventListener('click', (e) => {
  const n = S.get(ui.open); if (!n) return;
  const t = e.target.closest('[data-act],[data-prio],[data-res],[data-open],[data-tag]'); if (!t) return;
  if (t.dataset.act === 'close') closeDetail();
  if (t.dataset.act === 'archive') { S.archive(n.id); toast('Archived. Find it any time in Archive.'); closeDetail(); }
  if (t.dataset.act === 'reopen') { S.reopen(n.id); toast('Back on the desk'); }
  if (t.dataset.act === 'zoom') modal(`<img src="${n.photo}" style="width:100%">`, { wide: true });
  if (t.dataset.act === 'addnote') { const v = $('#callnote').value; $('#callnote').value = ''; if (v.trim()) { S.addCallNote(n.id, v); toast('Call note saved ' + new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })); } }
  if (t.dataset.prio) S.setPriority(n.id, t.dataset.prio);
  if (t.dataset.tag) { const tags = n.tags.includes(t.dataset.tag) ? n.tags.filter(x => x !== t.dataset.tag) : [...n.tags, t.dataset.tag]; S.update(n.id, { tags }, 'tags', tags.join(', ')); }
  if (t.dataset.res) doResult(n.id, t.dataset.res);
  if (t.dataset.open) select(t.dataset.open, true);
});
$('#detail').addEventListener('change', (e) => {
  const f = e.target.dataset.f; const n = S.get(ui.open); if (!f || !n) return;
  if (f.startsWith('contact.')) { const k = f.split('.')[1]; const contact = { ...n.contact, [k]: k === 'phone' ? formatPhone(e.target.value) : e.target.value }; S.update(n.id, { contact }, 'edited', k); }
  else S.update(n.id, { [f]: e.target.value }, 'edited', f);
});
function doResult(id, res) {
  if (res === 'Left VM' || res === 'Waiting') return pickFollowUp(id, res);
  if (res === 'Other') {
    const m = modal(`<h2>Check off: other result</h2><input type="text" id="otherres" placeholder="e.g. Sent to billing, Customer cancelled"><div class="row"><button class="btn primary" data-ok>Check off</button><button class="btn" data-close>Cancel</button></div>`);
    $('#otherres', m).focus();
    $('[data-ok]', m).onclick = () => { S.checkOff(id, 'Other: ' + ($('#otherres', m).value || '—')); m.remove(); afterDone(id); };
    return;
  }
  S.checkOff(id, res); afterDone(id);
}
function afterDone(id) {
  toast(`✔ Checked off ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · moved to archive`);
  const ids = orderedIds(); const i = ids.indexOf(id); const next = ids.filter(x => x !== id)[Math.min(i, ids.length - 2)];
  closeDetail(); if (next) select(next, false);
}
function pickFollowUp(id, res) {
  const n = S.get(id);
  const in2h = Date.now() + 2 * 36e5, tam = tomorrowAM(8);
  const m = modal(`<h2>${esc(res)}: when should it come back?</h2>
    <p class="muted">It will rest in the Waiting lane, then pop back to the top of ${esc(n.priority)} with a nudge.</p>
    <div class="row"><button class="btn big" data-t="${in2h}">In 2 hours<br><span class="small muted">${esc(fmtTime(in2h))}</span></button>
    <button class="btn big" data-t="${tam}">Tomorrow AM<br><span class="small muted">${esc(fmtTime(tam))}</span></button>
    <button class="btn big" data-t="${Date.now() + 60e3}" title="Demo: 1 minute">In 1 min<br><span class="small muted">(demo)</span></button></div>
    <label class="f">Custom</label><div class="row" style="margin-top:0"><input type="datetime-local" id="fu-custom" value="${toLocalInput(tam)}" style="max-width:260px"><button class="btn" data-custom>Set</button></div>
    <div class="row"><button class="btn ghost" data-close>Cancel</button></div>`);
  m.addEventListener('click', (e) => {
    const b = e.target.closest('[data-t],[data-custom]'); if (!b) return;
    const t = b.dataset.t ? +b.dataset.t : new Date($('#fu-custom', m).value).getTime();
    if (!t) return; S.checkOff(id, res, t); m.remove(); toast(`${res} stamped · back ${relTime(t)}`); closeDetail();
  });
}

// ---------- nudges ----------
function checkNudges() {
  S.active().filter(n => S.isDueNudge(n) && !n.nudged).forEach(n => {
    S.update(n.id, { nudged: true }, 'nudge', 'follow-up time reached, back to top');
    toast(`⏰ Follow-up due: ${n.contact.name || n.title}`);
    ui.fresh.add(n.id); setTimeout(() => ui.fresh.delete(n.id), 9000);
  });
  render();
}

// ---------- morning screen ----------
function showMorning() {
  const s = S.morningSummary();
  const li = (n) => `<li data-open="${n.id}"><span class="chip ${n.priority}">${n.priority}</span> <b>${esc(emojify(n.title))}</b> <span class="muted small">${esc(n.contact.name)} ${n.followUpAt ? '· ' + esc(fmtTime(n.followUpAt)) : ''}</span></li>`;
  const sec = (h, arr, empty) => `<h3 style="margin:14px 0 4px">${h} <span class="muted">${arr.length}</span></h3><ul class="mlist">${arr.map(li).join('') || `<li class="faint">${empty}</li>`}</ul>`;
  const d = new Date();
  const m = modal(`<h2>Good morning, Captain ☀</h2><div class="muted">${d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</div>
    ${sec('⏰ Overdue follow-ups', s.overdue, 'Nothing overdue')}
    ${sec('📅 Follow-ups due today', s.dueToday, 'None scheduled today')}
    ${sec('↪ Carried over from before today', s.carried, 'Clean slate')}
    <div class="row"><button class="btn primary big" data-start style="flex:1;justify-content:center">Start the day</button></div>`, { onClose: startDay });
  $('[data-start]', m).onclick = () => { startDay(); m.remove(); };
  m.addEventListener('click', e => { const o = e.target.closest('[data-open]'); if (o) { startDay(); m.remove(); select(o.dataset.open, true); } });
}
function startDay() { S.setSetting('lastStartDay', new Date().toLocaleDateString('en-CA')); }

// ---------- modal + toast ----------
function modal(html, { wide, onClose } = {}) {
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal" style="${wide ? 'max-width:900px' : ''}">${html}</div>`;
  bg.addEventListener('click', e => { if (e.target === bg || e.target.closest('[data-close]')) { bg.remove(); onClose && onClose(); } });
  $('#layer').appendChild(bg); return bg;
}
app.modal = modal;
let toastT;
function toast(msg) { $$('.toast').forEach(t => t.remove()); const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; document.body.appendChild(t); clearTimeout(toastT); toastT = setTimeout(() => t.remove(), 3200); }
function highlightNew(id, more = []) { more.forEach(x => ui.fresh.add(x)); setTimeout(() => more.forEach(x => ui.fresh.delete(x)), 9000); ui.fresh.add(id); render(); setTimeout(() => { ui.fresh.delete(id); }, 9000); select(id, document.body.dataset.view === 'desk'); }

function showHelp() {
  modal(`<h2>Keyboard shortcuts</h2><table style="width:100%;border-collapse:collapse;line-height:2">
  ${[['j / k', 'Next / previous note'], ['Enter', 'Open selected note'], ['1 / 2 / 3', 'Priority High / Medium / Low'], ['d', 'Done (Called) · checks off + archives'], ['v', 'Left VM (asks follow-up time)'], ['w', 'Waiting (asks follow-up time)'], ['n', 'New note'], ['/', 'Search'], ['a', 'Toggle archive'], ['Esc', 'Close panel / clear search'], ['?', 'This help']]
    .map(([k, v]) => `<tr><td><kbd>${k}</kbd></td><td>${v}</td></tr>`).join('')}</table><div class="row"><button class="btn" data-close>Close</button></div>`);
}
function showSettings() {
  const s = S.getSettings();
  const m = modal(`<h2>Settings</h2>
    <label style="display:flex;gap:10px;align-items:center;margin:10px 0"><input type="checkbox" id="set-tags" ${s.tagsEnabled ? 'checked' : ''} style="width:auto"> Quick tags (Delivery / Service / Billing / Tank Set) <span class="muted small">· off by default, hidden everywhere when off</span></label>
    <label class="f">Theme</label><select id="set-theme">${THEMES.map(t => `<option value="${t.id}" ${t.id === s.theme ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select>
    <h3 style="margin-top:16px">Backup</h3><div class="row" style="margin-top:4px"><button class="btn" id="set-export">Export all notes (JSON)</button><button class="btn" id="set-reset">Reset demo data</button></div>
    <h3 style="margin-top:16px">Account</h3><div class="muted small">Signed in as ${esc(S.CURRENT_USER.name)} (prototype, local only). Multi-user logins + sharing with Cierra: planned, not in prototype.</div>
    <div class="row"><button class="btn" data-close>Done</button></div>`);
  $('#set-tags', m).onchange = (e) => { S.setSetting('tagsEnabled', e.target.checked); };
  $('#set-theme', m).onchange = (e) => { S.setSetting('theme', e.target.value); applyTheme(e.target.value); $('#theme').value = e.target.value; };
  $('#set-export', m).onclick = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([S.exportJSON()], { type: 'application/json' })); a.download = `chadspad-backup-${new Date().toLocaleDateString('en-CA')}.json`; a.click(); };
  $('#set-reset', m).onclick = () => { S.resetDemo(seedNotes); m.remove(); toast('Demo data reset'); };
}

// ---------- events ----------
document.addEventListener('click', (e) => {
  const c = e.target.closest('.card, .arow');
  if (c && !e.target.closest('#detail')) { select(c.dataset.id, true); return; }
  const f = e.target.closest('[data-filter]');
  if (f) { const k = f.dataset.filter; if (k === 'done') { ui.archive = true; ui.q = ''; ui.filter = null; } else { ui.filter = ui.filter === k ? null : k; ui.archive = false; } render(); return; }
  const id = e.target.closest('button')?.id;
  if (id === 'btn-archive' || id === 'btn-archive-p') { ui.archive = !ui.archive; render(); }
  if (id === 'btn-back') { ui.archive = false; render(); }
  if (id === 'btn-morning' || id === 'btn-morning-p') showMorning();
  if (id === 'btn-settings') showSettings();
  if (id === 'btn-view') { ui.forcedView = 'phone'; setView(); }
  if (id === 'btn-desk-p') { ui.forcedView = 'desk'; setView(); }
  if (id === 'btn-new') newMenu($('#btn-new'));
  if (id === 'fab') toggleNewMenu();
});
$('#theme').onchange = (e) => { S.setSetting('theme', e.target.value); applyTheme(e.target.value); };
$('#search').addEventListener('input', (e) => { ui.q = e.target.value.trim(); render(); });
function newMenuItems() { return [['photo', '📷 Photo'], ['type', '⌨ Type'], ['voice', '🎤 Voice'], ['voicemail', '📼 Import voicemail'], ['testphoto', '🧪 Test scanner on a photo']]; }
function toggleNewMenu() {
  const m = $('#newmenu'); m.classList.toggle('hidden'); prefetchScanner();
  m.innerHTML = newMenuItems().map(([k, l]) => `<button class="btn" data-new="${k}">${l}</button>`).join('');
}
function newMenu(anchor) {
  prefetchScanner();
  const m = modal(`<h2>New note</h2><div class="row">${newMenuItems().map(([k, l]) => `<button class="btn big" data-new="${k}">${l}</button>`).join('')}</div>
    <p class="muted small">On the desk you'll mostly use the phone to snap. Here you can type, test the scanner on a saved photo, or import a voicemail file.</p>`);
  m.addEventListener('click', e => { if (e.target.closest('[data-new]')) m.remove(); });
}
document.addEventListener('click', (e) => { const b = e.target.closest('[data-new]'); if (b) { $('#newmenu').classList.add('hidden'); openNew(b.dataset.new); } });

// drag & drop (desk)
let dragId = null;
document.addEventListener('dragstart', (e) => { const c = e.target.closest('.card'); if (!c) return; dragId = c.dataset.id; c.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', dragId); });
document.addEventListener('dragend', () => { $$('.dragging').forEach(x => x.classList.remove('dragging')); $$('.col.drop').forEach(x => x.classList.remove('drop')); $$('.drop-marker').forEach(x => x.remove()); dragId = null; });
document.addEventListener('dragover', (e) => {
  const col = e.target.closest('.col'); if (!col || !dragId) return; e.preventDefault();
  $$('.col.drop').forEach(x => x !== col && x.classList.remove('drop')); col.classList.add('drop');
  $$('.drop-marker').forEach(x => x.remove());
  if (col.dataset.col !== 'Waiting') { const after = dropAfter(col, e.clientY); const mk = document.createElement('div'); mk.className = 'drop-marker'; const body = $('.col-body', col); after ? after.after(mk) : body.prepend(mk); }
});
function dropAfter(col, y) { let last = null; for (const c of $$('.card:not(.dragging)', col)) { const r = c.getBoundingClientRect(); if (y > r.top + r.height / 2) last = c; } return last; }
document.addEventListener('drop', (e) => {
  const col = e.target.closest('.col'); if (!col || !dragId) return; e.preventDefault();
  const id = dragId, lane = col.dataset.col; const n = S.get(id);
  if (lane === 'Waiting') { if (n.status !== 'Waiting') pickFollowUp(id, 'Waiting'); return; }
  const cards = $$('.card:not(.dragging)', col).map(c => S.get(c.dataset.id)).filter(x => x && x.id !== id);
  const after = dropAfter(col, e.clientY); const idx = after ? cards.findIndex(c => c.id === after.dataset.id) + 1 : 0;
  const prev = cards[idx - 1], next = cards[idx];
  const order = prev && next ? (prev.order + next.order) / 2 : prev ? prev.order + 1 : next ? next.order - 1 : 0;
  S.setPriority(id, lane, order);
  if (n.status === 'Waiting') S.update(id, { status: 'Open', followUpAt: null }, 'moved out of Waiting');
  toast(`Moved to ${lane}`);
});

// keyboard
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea, select')) { if (e.key === 'Escape') { e.target.blur(); if (e.target.id === 'search') { e.target.value = ''; ui.q = ''; render(); } } return; }
  if ($('.capture, .review')) return;
  const ids = orderedIds(); const i = ids.indexOf(ui.sel);
  const k = e.key;
  if (k === '/') { e.preventDefault(); $('#search').focus(); return; }
  if (k === '?') { showHelp(); return; }
  if (k === 'Escape') { const mb = $$('.modal-bg').pop(); if (mb) mb.remove(); else closeDetail(); return; }
  if ($('.modal-bg')) return;
  if (k === 'j' || k === 'ArrowDown') { e.preventDefault(); select(ids[Math.min(ids.length - 1, i + 1)] || ids[0], false); }
  if (k === 'k' || k === 'ArrowUp') { e.preventDefault(); select(ids[Math.max(0, i - 1)] || ids[0], false); }
  if (k === 'Enter' && ui.sel) select(ui.sel, true);
  if (k === 'n') openNew('type');
  if (k === 'a') { ui.archive = !ui.archive; render(); }
  if (!ui.sel || !S.get(ui.sel)) return;
  if (k === '1' || k === '2' || k === '3') { S.setPriority(ui.sel, S.PRIORITIES[+k - 1]); toast(`Priority → ${S.PRIORITIES[+k - 1]}`); select(ui.sel, false); }
  if (k === 'd') doResult(ui.sel, 'Called');
  if (k === 'v') doResult(ui.sel, 'Left VM');
  if (k === 'w') doResult(ui.sel, 'Waiting');
});
// ---------- boot ----------
await Promise.race([document.fonts.load('30px Caveat'), new Promise(r => setTimeout(r, 1500))]);
S.load(seedNotes);
const params = new URLSearchParams(location.search);
ui.forcedView = params.get('view');
applyTheme(S.getSettings().theme);
$('#theme').innerHTML = THEMES.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('');
$('#theme').value = S.getSettings().theme;
setView();
window.addEventListener('resize', setView);
S.onChange(() => render());
render();
if (S.getSettings().lastStartDay !== new Date().toLocaleDateString('en-CA') && !params.has('nomorning')) showMorning();
setInterval(checkNudges, 15000); checkNudges();
setInterval(() => { if (S.queue().length) { S.flushQueue(); } }, 20000);
window.addEventListener('online', () => S.flushQueue());

window.__app = { S, ui, showMorning, select, render };
