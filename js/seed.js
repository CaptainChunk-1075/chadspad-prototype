// ~15 realistic demo notes (fake names, 555 numbers). Relative to "now" so the demo always looks live.
import { CURRENT_USER } from './store.js';
const H = 36e5, D = 864e5;
const PAPER = ['#fff59d', '#c8f0d0', '#ffd1dc', '#ffe0a3', '#cfe8ff'];

function stickyPhoto(text, color, ink = '#1c2a6b', rot = 0) {
  const c = document.createElement('canvas'); c.width = 360; c.height = 360;
  const g = c.getContext('2d');
  g.fillStyle = '#5a1a24'; g.fillRect(0, 0, 360, 360);           // maroon mat
  g.save(); g.translate(180, 180); g.rotate(rot); g.fillStyle = color; g.shadowColor = 'rgba(0,0,0,.35)'; g.shadowBlur = 10;
  g.fillRect(-150, -150, 300, 300); g.shadowBlur = 0;
  g.fillStyle = ink; g.font = '30px Caveat, "Comic Sans MS", cursive';
  const words = text.split(/\s+/); let line = '', y = -110;
  for (const w of words) { if (g.measureText(line + w).width > 260) { g.fillText(line, -130, y); line = ''; y += 36; } line += w + ' '; }
  g.fillText(line, -130, y); g.restore();
  return c.toDataURL('image/jpeg', 0.7);
}

export function seedNotes() {
  const t = Date.now();
  const mk = (o, i) => ({
    owner: CURRENT_USER.id, sharedWith: [], tags: [], callNotes: [], status: 'Open', result: null, followUpAt: null, archived: false,
    ...o, contact: { name: '', company: '', phone: '', ext: '', ...o.contact },
    photo: o.photo === false ? null : stickyPhoto(o.rawText, PAPER[i % PAPER.length], i % 3 ? '#1c2a6b' : '#b3202a', (i % 5 - 2) * 0.04),
    source: o.photo === false ? 'type' : 'photo',
    updatedAt: o.createdAt,
    history: [{ at: o.createdAt, by: CURRENT_USER.id, action: 'created', detail: o.photo === false ? 'typed' : 'photo' }, ...(o.history || [])],
  });
  const list = [
    // ---- active ----
    { title: 'Out of gas — needs delivery today', rawText: 'Michele Ryan 555-201-4478 out of gas, needs delivery TODAY :sweat_smile:', contact: { name: 'Michele Ryan', phone: '(555) 201-4478' }, ask: 'Out of gas, needs delivery today', priority: 'High', createdAt: t - 0.4 * H, tags: ['Delivery'] },
    { title: 'Smells gas by water heater', rawText: 'Dale Hutchins 555-318-0092 smells gas near water heater - send tech ASAP', contact: { name: 'Dale Hutchins', phone: '(555) 318-0092' }, ask: 'Smells gas near water heater, send tech ASAP', priority: 'High', createdAt: t - 1.5 * H, tags: ['Service'] },
    { title: 'Upset about bill — threw a fit', rawText: 'Gloria Pratt 555-774-3310 upset about Nov bill, threw a fit w/ Ciera. Call back', contact: { name: 'Gloria Pratt', phone: '(555) 774-3310' }, ask: 'Upset about November bill, call back', priority: 'High', createdAt: t - 26 * H, tags: ['Billing'] },
    { title: 'Tank set quote for new build', rawText: 'Brock Lumber & Homes LLC - Tom Vance 555-640-2215 x214 tank set for new build on Rt 9', contact: { name: 'Tom Vance', company: 'Brock Lumber & Homes LLC', phone: '(555) 640-2215', ext: '214' }, ask: 'Tank set for new build on Rt 9', priority: 'Medium', createdAt: t - 3 * H, tags: ['Tank Set'] },
    { title: 'Furnace pilot keeps going out', rawText: 'Harold Kimes 555-422-8817 furnace pilot keeps going out', contact: { name: 'Harold Kimes', phone: '(555) 422-8817' }, ask: 'Furnace pilot keeps going out', priority: 'Medium', createdAt: t - 5 * H, tags: ['Service'] },
    { title: 'Wants auto-fill delivery plan', rawText: 'Sandra Okafor 555-903-1146 wants to go on auto-fill', contact: { name: 'Sandra Okafor', phone: '(555) 903-1146' }, ask: 'Wants to sign up for auto-fill', priority: 'Medium', createdAt: t - 28 * H, tags: ['Delivery'], photo: false },
    { title: 'Grill cylinder exchange info', rawText: 'Pete Lindqvist 555-118-6620 grill cylinder exchange info, no rush', contact: { name: 'Pete Lindqvist', phone: '(555) 118-6620' }, ask: 'Grill cylinder exchange info, no rush', priority: 'Low', createdAt: t - 50 * H, photo: false },
    { title: 'Brochure for generator hookup', rawText: 'Marcy Dunn 555-367-9041 send brochure for generator hookup', contact: { name: 'Marcy Dunn', phone: '(555) 367-9041' }, ask: 'Send brochure for generator hookup', priority: 'Low', createdAt: t - 7 * H },
    // ---- waiting (one future, one overdue -> nudge) ----
    { title: 'Regulator replacement — waiting on part', rawText: 'Ed Marsh 555-250-7734 regulator replacement, waiting on part', contact: { name: 'Ed Marsh', phone: '(555) 250-7734' }, ask: 'Regulator replacement, waiting on part', priority: 'Medium', createdAt: t - 30 * H, status: 'Waiting', result: 'Waiting', followUpAt: t + 3 * H, history: [{ at: t - 20 * H, by: CURRENT_USER.id, action: 'result', detail: 'Waiting · part on order' }] },
    { title: 'Leak check follow-up', rawText: 'Rosa Delgado 555-689-4402 leak check after line repair', contact: { name: 'Rosa Delgado', phone: '(555) 689-4402' }, ask: 'Leak check after line repair', priority: 'High', createdAt: t - 22 * H, status: 'Waiting', result: 'Left VM', followUpAt: t - 1.2 * H, history: [{ at: t - 6 * H, by: CURRENT_USER.id, action: 'result', detail: 'Left VM' }] },
    // ---- archived (history matches) ----
    { title: 'Delivery — tank at 10%', rawText: 'Michele Ryan 555-201-4478 tank at 10%, schedule delivery', contact: { name: 'Michele Ryan', phone: '(555) 201-4478' }, ask: 'Tank at 10%, schedule delivery', priority: 'High', createdAt: t - 40 * D, status: 'Done', result: 'Scheduled', archived: true, archivedAt: t - 40 * D + 2 * H },
    { title: 'Billing question — budget plan', rawText: 'Michele Ryan 555-201-4478 question about budget plan amount', contact: { name: 'Michele Ryan', phone: '(555) 201-4478' }, ask: 'Question about budget plan', priority: 'Medium', createdAt: t - 95 * D, status: 'Done', result: 'Called', archived: true, archivedAt: t - 95 * D + 5 * H },
    { title: 'Water heater relight', rawText: 'Dale Hutchins 555-318-0092 relight water heater after delivery', contact: { name: 'Dale Hutchins', phone: '(555) 318-0092' }, ask: 'Relight water heater after delivery', priority: 'Medium', createdAt: t - 60 * D, status: 'Done', result: 'Scheduled', archived: true, archivedAt: t - 59 * D },
    { title: 'Disputed late fee', rawText: 'Gloria Pratt 555-774-3310 disputing late fee', contact: { name: 'Gloria Pratt', phone: '(555) 774-3310' }, ask: 'Disputing late fee', priority: 'High', createdAt: t - 120 * D, status: 'Done', result: 'Called', archived: true, archivedAt: t - 120 * D + 3 * H, callNotes: [{ at: t - 120 * D + 3 * H, by: CURRENT_USER.id, text: 'Waived fee one time. She was fine after.' }] },
    { title: 'Called back about delivery window', rawText: 'Jim Barrow 555-530-7781 delivery window', contact: { name: 'Jim Barrow', phone: '(555) 530-7781' }, ask: 'Delivery window', priority: 'Medium', createdAt: t - 4 * H, status: 'Done', result: 'Called', archived: true, archivedAt: t - 1 * H, photo: false },
  ];
  return list.map(mk);
}
