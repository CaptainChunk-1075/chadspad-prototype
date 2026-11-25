// Pure helpers: no DOM state. Build should port these 1:1.
export const uid = () => 'n_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
export const now = () => Date.now();
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- emoji shortcodes (":sweat_smile:" -> 😅) ----------
const EMOJI = {
  sweat_smile: '😅', smile: '😄', grin: '😁', joy: '😂', rofl: '🤣', slightly_smiling_face: '🙂', wink: '😉', blush: '😊',
  thinking: '🤔', thinking_face: '🤔', neutral_face: '😐', unamused: '😒', roll_eyes: '🙄', grimacing: '😬', relieved: '😌',
  worried: '😟', angry: '😠', rage: '😡', cry: '😢', sob: '😭', scream: '😱', exploding_head: '🤯', facepalm: '🤦',
  man_facepalming: '🤦‍♂️', shrug: '🤷', man_shrugging: '🤷‍♂️', pray: '🙏', clap: '👏', thumbsup: '👍', '+1': '👍',
  thumbsdown: '👎', '-1': '👎', ok_hand: '👌', wave: '👋', muscle: '💪', point_up: '☝️', eyes: '👀', fire: '🔥',
  warning: '⚠️', exclamation: '❗', heavy_exclamation_mark: '❗', question: '❓', white_check_mark: '✅', heavy_check_mark: '✔️',
  x: '❌', no_entry: '⛔', rotating_light: '🚨', bell: '🔔', phone: '☎️', telephone_receiver: '📞', iphone: '📱',
  calendar: '📅', date: '📅', clock: '🕐', hourglass: '⌛', truck: '🚚', wrench: '🔧', hammer: '🔨', tools: '🛠️',
  house: '🏠', moneybag: '💰', dollar: '💵', receipt: '🧾', memo: '📝', pushpin: '📌', star: '⭐', sparkles: '✨',
  heart: '❤️', tada: '🎉', snowflake: '❄️', thermometer: '🌡️', droplet: '💧', boom: '💥', zzz: '💤', skull: '💀',
  smiley: '😃', laughing: '😆', upside_down_face: '🙃', confused: '😕', frowning: '☹️', pensive: '😔', hot_face: '🥵', cold_face: '🥶',
};
export function emojify(s) {
  return String(s ?? '').replace(/:([a-z0-9_+\-]+):/gi, (m, k) => EMOJI[k.toLowerCase()] ?? m);
}

// ---------- phone / contact extraction ----------
const PHONE_RE = /(?:\+?1[\s.\-]?)?\(?(\d{3})\)?[\s.\-]?(\d{3})[\s.\-]?(\d{4})(?:\s*(?:x|ext\.?|extension|#)\s*(\d{1,6}))?/i;
export function formatPhone(p) {
  const d = String(p ?? '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  if (d.length === 7) return `${d.slice(0, 3)}-${d.slice(3)}`;
  return p ?? '';
}
export const phoneDigits = (p) => String(p ?? '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
const COMPANY_RE = /\b([A-Z][\w&'.]*(?:\s+[A-Z][\w&'.]*)*\s+(?:LLC|Inc\.?|Co\.?|Corp\.?|Farms?|Dairy|Church|School|Restaurant|Diner|Motel|Plumbing|Heating|HVAC|Construction|Builders|Homes|Supply|Store|Market|Bakery|Grill|Ranch|Orchards?))\b/;
const STOPWORDS = /^(call|callback|call back|cb|re|pls|please|needs?|wants?|asap|today|tomorrow|left|vm|delivery|tank|leak|bill|check|customer|cust|new|old|urgent)$/i;

export function extractFields(text) {
  const raw = emojify(text || '').trim();
  const lines = raw.split(/\n+/).map(l => l.trim()).filter(Boolean);
  const out = { name: '', company: '', phone: '', ext: '', ask: '' };
  const pm = raw.match(PHONE_RE);
  if (pm) { out.phone = formatPhone(pm[1] + pm[2] + pm[3]); out.ext = pm[4] || ''; }
  if (!out.ext) { const em = raw.match(/\b(?:x|ext\.?)\s*(\d{2,6})\b/i); if (em) out.ext = em[1]; }
  const cm = raw.match(COMPANY_RE); if (cm) out.company = cm[1];
  // Name: first 2-3 capitalized words that are not stopwords, not part of company, no digits
  for (const line of lines) {
    const cleaned = line.replace(PHONE_RE, '').replace(/[-–•*·]\s*/, '').trim();
    const m = cleaned.match(/\b((?:Mr\.|Mrs\.|Ms\.|Dr\.)\s+)?([A-Z][a-z'’]+(?:[-\s][A-Z][a-z'’]+){0,2})\b/);
    if (m && !STOPWORDS.test(m[2].split(/\s/)[0]) && !(out.company && out.company.includes(m[2]))) { out.name = ((m[1] || '') + m[2]).trim(); break; }
  }
  // Ask: everything that is not the name/phone/company line fragments
  let ask = raw.replace(PHONE_RE, ' ');
  if (out.name) ask = ask.replace(out.name, ' ');
  if (out.company) ask = ask.replace(out.company, ' ');
  ask = ask.replace(/\b(?:x|ext\.?)\s*\d{2,6}\b/i, ' ').replace(/^[\s\-–•*·:,]+/gm, '').replace(/\s+/g, ' ').trim();
  out.ask = ask.replace(/^[,.\-–:\s]+|[,\-–:\s]+$/g, '');
  return out;
}

// ---------- priority suggestion ----------
const HIGH_WORDS = [/\btoday\b/i, /\basap\b/i, /\burgent\b/i, /\bemergenc/i, /\bout of (gas|propane)\b/i, /\bno heat\b/i, /\bleak\b/i,
  /\bsmell\b/i, /\bdeliver(y|ies)?\b/i, /\bupset\b/i, /\bangry\b/i, /\bmad\b/i, /\bpissed\b/i, /\bfit\b/i, /\bfurious\b/i, /\bcomplain/i, /\bnow\b/i, /\brun out\b/i, /\bempty\b/i];
const LOW_WORDS = [/\bwhenever\b/i, /\bno rush\b/i, /\bnext week\b/i, /\bfyi\b/i, /\bsometime\b/i, /\bquote\b/i, /\binfo\b/i, /\bbrochure\b/i];
export function suggestPriority(text) {
  const t = text || '';
  const hits = HIGH_WORDS.filter(r => r.test(t)).map(r => (t.match(r) || [''])[0]);
  if (hits.length) return { priority: 'High', why: hits.slice(0, 3).map(h => h.toLowerCase()) };
  const lows = LOW_WORDS.filter(r => r.test(t)).map(r => (t.match(r) || [''])[0]);
  if (lows.length) return { priority: 'Low', why: lows.slice(0, 2).map(h => h.toLowerCase()) };
  return { priority: 'Medium', why: [] };
}

export function makeTitle(fields, raw) {
  const ask = fields.ask || raw || '';
  const short = ask.split(/[.\n!?]/)[0].trim().slice(0, 48);
  return short || fields.name || 'New note';
}

// ---------- time ----------
export const startOfDay = (t = Date.now()) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
export const dayKey = (t = Date.now()) => new Date(t).toLocaleDateString('en-CA');
export function fmtTime(t) {
  if (!t) return '';
  const d = new Date(t), today = startOfDay(), day = startOfDay(t);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (day === today) return `Today ${time}`;
  if (day === today - 864e5) return `Yesterday ${time}`;
  if (day === today + 864e5) return `Tomorrow ${time}`;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + time;
}
export function relTime(t) {
  const m = Math.round((t - Date.now()) / 6e4), a = Math.abs(m);
  const s = a < 60 ? `${a}m` : a < 1440 ? `${Math.round(a / 60)}h` : `${Math.round(a / 1440)}d`;
  return m >= 0 ? `in ${s}` : `${s} ago`;
}
export function tomorrowAM(hour = 8) { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(hour, 0, 0, 0); return d.getTime(); }
export const toLocalInput = (t) => { const d = new Date(t - new Date(t).getTimezoneOffset() * 6e4); return d.toISOString().slice(0, 16); };
