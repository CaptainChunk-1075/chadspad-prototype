// Local-first store. Everything persists to localStorage; a pending-sync queue
// records every change so the real app can push it to the server when online.
import { uid, now, phoneDigits, startOfDay } from './util.js';

const KEY = 'chadspad.proto.notes.v2';
const LEGACY_KEY = 'chads-pad.notes.v1';         // current live app's format
const SETTINGS_KEY = 'chadspad.proto.settings';
const QUEUE_KEY = 'chadspad.proto.syncQueue';
export const CURRENT_USER = { id: 'u_captain', name: 'Captain Chunk' };
export const PRIORITIES = ['High', 'Medium', 'Low'];
export const RESULTS = ['Called', 'Left VM', 'Scheduled', 'Waiting', 'Other'];
export const TAGS = ['Delivery', 'Service', 'Billing', 'Tank Set'];

const listeners = new Set();
export const onChange = (fn) => (listeners.add(fn), () => listeners.delete(fn));
const emit = (why) => listeners.forEach(fn => fn(why));

let notes = [];
let settings = { theme: 'default', tagsEnabled: false, lastStartDay: null, inkColor: 'navy', fontId: 'hand', matModel: null };

/** Normalize any note (v2 or legacy v1) into the v2 shape. */
export function normalize(n) {
  if (!n || typeof n !== 'object') return null;
  const legacy = typeof n.text === 'string' && n.rawText === undefined;
  const pr = (p) => { const s = String(p || '').toLowerCase(); return s === 'high' ? 'High' : s === 'low' ? 'Low' : 'Medium'; };
  const created = typeof n.createdAt === 'number' ? n.createdAt : Date.parse(n.createdAt) || now();
  return {
    id: n.id || uid(),
    owner: n.owner || CURRENT_USER.id,
    createdAt: created,
    updatedAt: n.updatedAt || created,
    title: n.title || (legacy ? (n.text.split('\n')[0] || '').slice(0, 48) : ''),
    rawText: legacy ? n.text : (n.rawText || ''),
    contact: { name: '', company: '', phone: '', ext: '', ...(n.contact || {}) },
    ask: n.ask || '',
    priority: pr(n.priority),
    status: ['Open', 'Waiting', 'Done'].includes(n.status) ? n.status : (n.archived ? 'Done' : 'Open'),
    result: n.result || null,
    followUpAt: n.followUpAt || null,
    tags: Array.isArray(n.tags) ? n.tags : [],
    photo: n.photo || n.photoDataUrl || null,
    audio: n.audio || null,                // voicemail stub
    source: n.source || (n.photoDataUrl ? 'photo' : 'type'),
    history: Array.isArray(n.history) ? n.history : [{ at: created, by: CURRENT_USER.id, action: 'created' }],
    callNotes: Array.isArray(n.callNotes) ? n.callNotes : [],
    archived: !!n.archived,
    archivedAt: n.archivedAt || (n.archived ? (n.updatedAt || created) : null),
    sharedWith: Array.isArray(n.sharedWith) ? n.sharedWith : [],
    order: typeof n.order === 'number' ? n.order : -created,
    // kept from the live app so nothing is lost on migration:
    inkColor: n.inkColor || 'navy', fontId: n.fontId || 'hand', textSize: n.textSize || 'm', highlights: n.highlights || [],
  };
}

export function load(seedFn) {
  try { settings = { ...settings, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; } catch {}
  try { notes = (JSON.parse(localStorage.getItem(KEY) || 'null') || []).map(normalize).filter(Boolean); } catch { notes = []; }
  if (!localStorage.getItem(KEY)) {
    // Backward compatibility: pick up notes written by the current live app if present on this origin.
    try { const legacy = JSON.parse(localStorage.getItem(LEGACY_KEY) || '[]'); notes = legacy.map(normalize).filter(Boolean); } catch {}
    if (!notes.length && seedFn) notes = seedFn().map(normalize);
    persist('seed');
  }
}
function persist(why) { try { localStorage.setItem(KEY, JSON.stringify(notes)); } catch (e) { console.warn('storage full?', e); } emit(why); }

export const all = () => notes;
export const get = (id) => notes.find(n => n.id === id);
export const getSettings = () => settings;
export function setSetting(k, v) { settings[k] = v; localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); emit('settings'); }

// ---------- sync queue stub ----------
export function queue() { try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); } catch { return []; } }
function enqueue(op, id) { const q = queue(); q.push({ op, id, at: now() }); localStorage.setItem(QUEUE_KEY, JSON.stringify(q.slice(-500))); }
export function flushQueue() {
  // STUB: the real app POSTs these to its server. Here we just pretend when online.
  if (!navigator.onLine) return 0;
  const n = queue().length; localStorage.setItem(QUEUE_KEY, '[]'); emit('sync'); return n;
}

// ---------- mutations (no delete anywhere: archive only) ----------
export function create(data) {
  const n = normalize({ ...data, id: uid(), createdAt: now(), updatedAt: now(), owner: CURRENT_USER.id, history: [{ at: now(), by: CURRENT_USER.id, action: 'created', detail: data.source || '' }] });
  n.order = Math.min(0, ...notes.filter(x => x.priority === n.priority).map(x => x.order)) - 1;
  notes.unshift(n); enqueue('create', n.id); persist('create'); return n;
}
export function update(id, patch, action, detail) {
  const n = get(id); if (!n) return;
  Object.assign(n, patch, { updatedAt: now() });
  if (action) n.history.push({ at: now(), by: CURRENT_USER.id, action, detail: detail || '' });
  enqueue('update', id); persist('update'); return n;
}
export function setPriority(id, p, order) {
  const n = get(id); if (!n || (n.priority === p && order === undefined)) return;
  const patch = { priority: p };
  patch.order = order !== undefined ? order : Math.min(0, ...notes.filter(x => x.priority === p).map(x => x.order)) - 1;
  if (n.status === 'Waiting' && order !== undefined) { patch.status = 'Open'; }
  return update(id, patch, n.priority !== p ? 'priority' : null, `${n.priority} → ${p}`);
}
export function checkOff(id, result, followUpAt) {
  const n = get(id); if (!n) return;
  if (result === 'Left VM' || result === 'Waiting') {
    return update(id, { status: 'Waiting', result, followUpAt, nudged: false }, 'result', `${result} · follow up ${new Date(followUpAt).toLocaleString()}`);
  }
  return update(id, { status: 'Done', result, followUpAt: null, archived: true, archivedAt: now() }, 'result', `${result} · checked off`);
}
export function reopen(id) { return update(id, { status: 'Open', archived: false, archivedAt: null, followUpAt: null }, 'reopened'); }
export function archive(id) { return update(id, { archived: true, archivedAt: now() }, 'archived'); }
export function addCallNote(id, text) {
  const n = get(id); if (!n || !text.trim()) return;
  n.callNotes.push({ at: now(), by: CURRENT_USER.id, text: text.trim() });
  return update(id, {}, 'call note', text.trim().slice(0, 80));
}

// ---------- queries ----------
export const isDueNudge = (n, t = now()) => n.status === 'Waiting' && n.followUpAt && n.followUpAt <= t && !n.archived;
export const active = () => notes.filter(n => !n.archived);
export const archived = () => notes.filter(n => n.archived);
export function counters(t = now()) {
  const sod = startOfDay(t), eod = sod + 864e5;
  const act = active();
  return {
    today: act.filter(n => n.createdAt >= sod || (n.followUpAt && n.followUpAt >= sod && n.followUpAt < eod)).length,
    overdue: act.filter(n => (n.followUpAt && n.followUpAt < t) || (n.status === 'Open' && n.priority === 'High' && n.createdAt < sod)).length,
    doneToday: notes.filter(n => n.status === 'Done' && n.archivedAt >= sod).length,
  };
}
export function matchesQuery(n, q) {
  if (!q) return true;
  const hay = [n.title, n.rawText, n.ask, n.contact.name, n.contact.company, n.contact.phone, phoneDigits(n.contact.phone), n.contact.ext,
    n.result, n.status, n.priority, ...(n.tags || []), ...n.callNotes.map(c => c.text), new Date(n.createdAt).toDateString()].join(' ').toLowerCase();
  return q.toLowerCase().split(/\s+/).every(w => hay.includes(w) || (w.replace(/\D/g, '').length >= 3 && hay.includes(w.replace(/\D/g, ''))));
}
/** Customer history: archived notes with the same phone digits or same name. */
export function pastNotesFor(n) {
  const d = phoneDigits(n.contact.phone), name = (n.contact.name || '').trim().toLowerCase();
  if (!d && !name) return [];
  return notes.filter(o => o.id !== n.id && o.archived && (
    (d && d.length >= 7 && phoneDigits(o.contact.phone).endsWith(d.slice(-7))) || (name && name.length > 2 && (o.contact.name || '').trim().toLowerCase() === name)
  )).sort((a, b) => b.createdAt - a.createdAt);
}
export function morningSummary(t = now()) {
  const sod = startOfDay(t), eod = sod + 864e5, act = active();
  const overdue = act.filter(n => n.followUpAt && n.followUpAt < t);
  return {
    overdue,
    dueToday: act.filter(n => n.followUpAt && n.followUpAt >= t && n.followUpAt < eod),
    carried: act.filter(n => n.createdAt < sod && n.status === 'Open' && !overdue.includes(n)),
  };
}
export function exportJSON() { return JSON.stringify({ exportedAt: new Date().toISOString(), version: 2, notes }, null, 1); }
export function resetDemo(seedFn) { notes = seedFn().map(normalize); localStorage.removeItem(QUEUE_KEY); settings.lastStartDay = null; localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); persist('seed'); }
