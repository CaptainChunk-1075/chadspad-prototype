// Capture flows: Photo (live scanner), Type, Voice, Import voicemail, Test scanner on a photo.
// All end in the fast Review screen, which creates the note.
import * as S from './store.js';
import { esc, emojify, extractFields, suggestPriority, makeTitle, formatPhone } from './util.js';
import { cvReady, detectQuad, warp, flattenLighting, splitEntries, WORK } from './scanner-core.js';
import { app } from './app.js';

const $ = (s, r = document) => r.querySelector(s);
const layer = () => document.getElementById('layer');
// OpenCV.js 4.10 from the official docs CDN (10 MB, cached after first load). Vendored copy is the fallback when served from the box.
const OPENCV_URL = 'https://docs.opencv.org/4.10.0/opencv.js';
const OPENCV_FALLBACK = 'vendor/opencv.js';
let cvLoading = null;
export function prefetchScanner() {
  if (cvLoading) return cvLoading;
  const s = document.createElement('script'); s.src = OPENCV_URL; s.async = true;
  s.onerror = () => { if (s.src !== OPENCV_FALLBACK) { const f = document.createElement('script'); f.src = OPENCV_FALLBACK; f.async = true; document.head.appendChild(f); } };
  document.head.appendChild(s);
  cvLoading = cvReady(); return cvLoading;
}
let tessLoading = null;
function loadTesseract() {
  if (tessLoading) return tessLoading;
  tessLoading = new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js'; s.onload = () => res(window.Tesseract); s.onerror = rej; document.head.appendChild(s); });
  return tessLoading;
}
/** Strip OCR noise: list marks (- • |), stray symbols at line starts, blank lines. */
export function cleanOCR(t) {
  return String(t || '').split('\n').map(l => l.replace(/^[\s|~+\-–—•*·.,_=¦!]+/, '').replace(/[|¦]+/g, '').replace(/\s{2,}/g, ' ').trim()).filter(l => l.length > 1).join('\n');
}
/** OCR PLACEHOLDER: Tesseract.js is a stand-in. The real app sends the flattened image to Grok Build's handwriting reader. */
async function ocr(canvas, onProgress) {
  try {
    const T = await loadTesseract();
    const r = await T.recognize(canvas, 'eng', { logger: m => m.status === 'recognizing text' && onProgress && onProgress(Math.round(m.progress * 100)) });
    return cleanOCR(r.data.text);
  } catch (e) { console.warn('OCR failed', e); return ''; }
}
function pickFile(accept, capture) {
  return new Promise((res) => {
    const i = document.createElement('input'); i.type = 'file'; i.accept = accept; if (capture) i.setAttribute('capture', 'environment');
    i.onchange = () => res(i.files[0] || null); i.click();
  });
}
const fileToDataURL = (f) => new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(f); });
async function fileToCanvas(f) {
  const url = typeof f === 'string' ? f : URL.createObjectURL(f);
  const img = new Image(); img.src = url; await img.decode();
  const s = Math.min(1, 2400 / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); return c;
}
const toJPEG = (c, max = 1100, q = 0.8) => { const s = Math.min(1, max / Math.max(c.width, c.height)); const o = document.createElement('canvas'); o.width = Math.round(c.width * s); o.height = Math.round(c.height * s); o.getContext('2d').drawImage(c, 0, 0, o.width, o.height); return o.toDataURL('image/jpeg', q); };

export async function openNew(kind) {
  if (kind === 'type') return openReview({ source: 'type', rawText: '' });
  if (kind === 'voice') return openVoice();
  if (kind === 'voicemail') {
    const f = await pickFile('audio/*'); if (!f) return;
    const audio = await fileToDataURL(f);
    return openReview({ source: 'voicemail', audio, rawText: '', audioName: f.name });
  }
  if (kind === 'testphoto') return openScanner({ still: true });
  if (kind === 'photo') return openScanner({ still: false });
}

// ================= VOICE =================
function openVoice() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    const m = app.modal(`<h2>🎤 Voice</h2><p>This browser can't do live speech-to-text. On iPhone, tap the <b>🎙 mic on the keyboard</b> in the next screen and just talk.</p>
      <div class="row"><button class="btn primary" data-go>Open Type with dictation</button><button class="btn" data-close>Cancel</button></div>`);
    m.querySelector('[data-go]').onclick = () => { m.remove(); openReview({ source: 'voice', rawText: '', dictateHint: true }); };
    return;
  }
  const rec = new SR(); rec.lang = 'en-US'; rec.interimResults = true; rec.continuous = true;
  let finalText = '';
  const m = app.modal(`<h2>🎤 Listening…</h2><p class="muted">Say who called, the number, and what they need.</p>
    <div id="vtext" class="note-text" style="min-height:90px;background:var(--surface-2);padding:10px;border-radius:8px"></div>
    <div class="row"><button class="btn primary big" data-stop>Done</button><button class="btn" data-close>Cancel</button></div>`, { onClose: () => rec.abort() });
  rec.onresult = (e) => { let interim = ''; for (let i = e.resultIndex; i < e.results.length; i++) { const t = e.results[i][0].transcript; if (e.results[i].isFinal) finalText += t + ' '; else interim += t; } m.querySelector('#vtext').textContent = finalText + interim; };
  rec.onerror = (e) => { m.querySelector('#vtext').textContent = `Mic error: ${e.error}. You can type instead.`; };
  m.querySelector('[data-stop]').onclick = () => { rec.stop(); m.remove(); openReview({ source: 'voice', rawText: (finalText || m.querySelector('#vtext').textContent).trim() }); };
  try { rec.start(); } catch (e) { m.querySelector('#vtext').textContent = 'Could not start the mic.'; }
}

// ================= SCANNER =================
const SAMPLES = [['caseA_sticky_shadow', 'Sample A: mint sticky, maroon mat, hard shadow'], ['caseA4_corner_covered_by_phone', 'Sample A4: corner covered'], ['caseB_blue_booklet', 'Sample B: blue booklet on wood'], ['multi_legal_pad', 'Sample M: legal pad, 3 entries']];
export async function openScanner({ still, preset, multi } = {}) {
  const st = { mode: 'note', multi: false, stream: null, raf: 0, quad: null, stableSince: 0, lastQuad: null, firstLook: performance.now(), torch: false, det: null, frozen: null, debug: false };
  const root = document.createElement('div'); root.className = 'capture';
  root.innerHTML = `
   <div class="top"><button class="btn" data-x>✕</button>
     <div class="seg" id="seg-mode"><button class="on" data-mode="note">Handwritten note</button><button data-mode="doc">Full document</button></div>
     <div class="seg"><button id="multi">Multi-note page</button></div>
     <button class="btn hidden" id="torch">🔦 Light</button>
     <span class="spacer"></span><button class="btn" id="dbg" title="Show what the scanner sees">👁</button></div>
   <div class="stage" id="stage"><canvas id="view"></canvas><div class="hint" id="hint">Starting…</div></div>
   <div class="scan-info" id="info"></div>
   <div class="bar" id="bar"></div>`;
  layer().appendChild(root);
  if (multi) { st.multi = true; $('#multi', root).classList.add('on'); }
  const view = $('#view', root), vctx = view.getContext('2d');
  const hint = (t, cls = '') => { const h = $('#hint', root); h.textContent = t; h.className = 'hint ' + cls; h.classList.toggle('hidden', !t); };
  window.addEventListener('resize', () => st.onResize && st.onResize());
  const close = () => { cancelAnimationFrame(st.raf); st.stream && st.stream.getTracks().forEach(t => t.stop()); root.remove(); };
  root.querySelector('[data-x]').onclick = close;
  root.querySelector('#seg-mode').onclick = (e) => { const b = e.target.closest('[data-mode]'); if (!b) return; st.mode = b.dataset.mode; root.querySelectorAll('[data-mode]').forEach(x => x.classList.toggle('on', x === b)); };
  root.querySelector('#multi').onclick = (e) => { st.multi = !st.multi; e.target.classList.toggle('on', st.multi); };
  root.querySelector('#dbg').onclick = () => { st.debug = !st.debug; if (st.frozen) drawStill(); };
  hint('Loading scanner engine…');
  const cv = await prefetchScanner();
  const small = document.createElement('canvas'); const sctx = small.getContext('2d', { willReadFrequently: true });

  function fitView(w, h) { const stage = $('#stage', root).getBoundingClientRect(); const s = Math.min(stage.width / w, stage.height / h); view.width = Math.round(w * s); view.height = Math.round(h * s); return s; }
  function drawQuad(q, scale, color = '#3ecf6e', fill = 'rgba(62,207,110,.18)') {
    if (!q) return; vctx.beginPath(); q.forEach((p, i) => i ? vctx.lineTo(p.x * scale, p.y * scale) : vctx.moveTo(p.x * scale, p.y * scale)); vctx.closePath();
    vctx.fillStyle = fill; vctx.fill(); vctx.lineWidth = 4; vctx.strokeStyle = color; vctx.stroke();
  }
  function runDetect(srcCanvas) {
    const s = WORK / Math.max(srcCanvas.width, srcCanvas.height);
    small.width = Math.round(srcCanvas.width * s); small.height = Math.round(srcCanvas.height * s);
    sctx.drawImage(srcCanvas, 0, 0, small.width, small.height);
    const mat = cv.matFromImageData(sctx.getImageData(0, 0, small.width, small.height));
    const r = detectQuad(cv, mat, { matModel: S.getSettings().matModel, debug: st.debug }); mat.delete();
    if (r.quad) r.quad = r.quad.map(p => ({ x: p.x / s, y: p.y / s }));
    return r;
  }
  const qDist = (a, b) => Math.max(...a.map((p, i) => Math.hypot(p.x - b[i].x, p.y - b[i].y)));

  // ---------- still image (test path / fallback) ----------
  async function useStill(canvas, label) {
    st.frozen = canvas; cancelAnimationFrame(st.raf); st.stream && st.stream.getTracks().forEach(t => t.stop()); st.stream = null;
    const t0 = performance.now(); const r = runDetect(canvas); const ms = Math.round(performance.now() - t0);
    st.det = r; st.quad = r.quad || defaultQuad(canvas.width, canvas.height);
    $('#info', root).textContent = `${label || 'Photo'} · ${r.quad ? `✅ paper found (${r.method}${r.inferred ? ', missing corner inferred' : ''}, score ${r.score})` : '⚠ no edges found: drag the corners'} · ${ms} ms${r.shadow ? ' · shadow detected' : ''}`;
    cropEditor();
  }
  function defaultQuad(w, h) { const m = 0.12; return [{ x: w * m, y: h * m }, { x: w * (1 - m), y: h * m }, { x: w * (1 - m), y: h * (1 - m) }, { x: w * m, y: h * (1 - m) }]; }

  function drawStill() {
    const c = st.frozen; const s = fitView(c.width, c.height); vctx.drawImage(c, 0, 0, view.width, view.height);
    if (st.debug && st.det?.debugMask) { const m = document.createElement('canvas'); m.width = st.det.debugMask.width; m.height = st.det.debugMask.height; m.getContext('2d').putImageData(st.det.debugMask, 0, 0); vctx.globalAlpha = .55; vctx.drawImage(m, 0, 0, view.width, view.height); vctx.globalAlpha = 1; }
    drawQuad(st.quad, s); return s;
  }
  function cropEditor() {
    hint(st.det?.quad ? (st.det.shadow ? 'Found it. Shadow will be evened out. Drag corners if needed.' : 'Found the paper. Drag corners if needed.') : 'Drag the 4 corners onto the paper', st.det?.quad ? 'good' : 'warn');
    const stage = $('#stage', root);
    stage.querySelectorAll('.corner').forEach(x => x.remove());
    // bar first: its height changes the stage size, which changes the canvas' rendered size
    $('#bar', root).innerHTML = `<button class="btn" id="retake">↺ Retake</button><button class="btn" id="choose">🖼 Other photo</button>
      ${still ? SAMPLES.map(([k, l]) => `<button class="btn" data-sample="${k}" title="${esc(l)}">${esc(l.split(':')[0])}</button>`).join('') : ''}
      <button class="btn primary big" id="use">Use this crop ✓</button>`;
    $('#retake', root).onclick = () => (still ? choosePhoto() : startCamera());
    $('#choose', root).onclick = choosePhoto;
    root.querySelectorAll('[data-sample]').forEach(b => b.onclick = () => loadSample(b.dataset.sample));
    $('#use', root).onclick = finish;
    drawStill();
    const rs = () => view.getBoundingClientRect().width / st.frozen.width; // rendered px per image px
    const place = () => { const vr = view.getBoundingClientRect(), sr = stage.getBoundingClientRect(), k = rs(); stage.querySelectorAll('.corner').forEach((h, i) => { h.style.left = (vr.left - sr.left + st.quad[i].x * k) + 'px'; h.style.top = (vr.top - sr.top + st.quad[i].y * k) + 'px'; }); };
    st.quad.forEach((p, i) => {
      const h = document.createElement('div'); h.className = 'corner'; stage.appendChild(h);
      h.onpointerdown = (e) => {
        e.preventDefault(); h.setPointerCapture(e.pointerId);
        h.onpointermove = (ev) => { const vr = view.getBoundingClientRect(), k = rs(); st.quad[i] = { x: Math.max(0, Math.min(st.frozen.width, (ev.clientX - vr.left) / k)), y: Math.max(0, Math.min(st.frozen.height, (ev.clientY - vr.top) / k)) }; drawStill(); place(); };
        h.onpointerup = () => { h.onpointermove = null; };
      };
    });
    requestAnimationFrame(place);
    st.onResize = () => { if (st.frozen) { drawStill(); place(); } };
  }
  async function choosePhoto() { const f = await pickFile('image/*'); if (f) useStill(await fileToCanvas(f), f.name); }
  async function loadSample(k) { const { SAMPLE_IMAGES } = await import('./samples.js'); useStill(await fileToCanvas(SAMPLE_IMAGES[k]), (SAMPLES.find(s => s[0] === k) || [k, k])[1]); }

  async function finish() {
    hint('Flattening…');
    let flat = warp(cv, st.frozen, st.quad);
    if (st.mode === 'note') flat = flattenLighting(cv, flat);
    // learn the mat colour from a good detection (helps next time on the same desk)
    if (st.det?.quad && st.det.border) { const old = S.getSettings().matModel; const b = st.det.border; S.setSetting('matModel', old ? { r: old.r * 0.7 + b.r * 0.3, g: old.g * 0.7 + b.g * 0.3 } : { r: b.r, g: b.g }); } // learn lit-mat chroma
    const original = toJPEG(st.frozen, 900, 0.7);
    close();
    if (st.multi) return openMultiReview(flat, st.mode, original);
    openReview({ source: 'photo', photoCanvas: flat, mode: st.mode, original });
  }

  // ---------- live camera ----------
  async function startCamera() {
    st.frozen = null; $('#stage', root).querySelectorAll('.corner').forEach(x => x.remove());
    $('#info', root).textContent = '';
    $('#bar', root).innerHTML = `<button class="btn" id="choose">🖼 Choose photo</button><button class="shutter" id="shutter" aria-label="Take photo"></button><button class="btn" id="manual" title="Snap now and drag the corners yourself">✋ Manual</button>`;
    $('#choose', root).onclick = choosePhoto;
    $('#shutter', root).onclick = () => snap(false);
    $('#manual', root).onclick = () => snap(true);
    try {
      st.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1440 } }, audio: false });
    } catch (e) {
      hint('Camera not available here. Choose a photo instead.', 'warn');
      if (/iPhone|iPad/.test(navigator.userAgent)) { const f = await pickFile('image/*', true); if (f) useStill(await fileToCanvas(f), 'Camera photo'); }
      return;
    }
    const video = document.createElement('video'); video.playsInline = true; video.muted = true; video.srcObject = st.stream; await video.play(); st.video = video;
    const track = st.stream.getVideoTracks()[0]; const caps = track.getCapabilities ? track.getCapabilities() : {};
    if (caps.torch) { const tb = $('#torch', root); tb.classList.remove('hidden'); tb.onclick = async () => { st.torch = !st.torch; try { await track.applyConstraints({ advanced: [{ torch: st.torch }] }); tb.classList.toggle('sel', st.torch); } catch {} }; }
    st.firstLook = performance.now(); st.stableSince = 0; st.lastQuad = null;
    let lastDet = 0;
    const frame = document.createElement('canvas');
    const loop = (t) => {
      st.raf = requestAnimationFrame(loop);
      const w = video.videoWidth, h = video.videoHeight; if (!w) return;
      const s = fitView(w, h); vctx.drawImage(video, 0, 0, view.width, view.height);
      if (t - lastDet > 110) {
        lastDet = t; const fs = Math.min(1, (WORK * 2) / Math.max(w, h)); frame.width = Math.round(w * fs); frame.height = Math.round(h * fs); // 2x work size, cv INTER_AREA does the rest
        frame.getContext('2d').drawImage(video, 0, 0, frame.width, frame.height);
        const r = runDetect(frame); const k = w / frame.width; st.det = r; window.__liveDbg = { w, h, fw: frame.width, fh: frame.height, quad: r.quad, method: r.method, score: r.score, border: r.border };
        if (r.quad) {
          const q = r.quad.map(p => ({ x: p.x * k, y: p.y * k }));
          const tol = Math.hypot(w, h) * 0.025;
          if (st.lastQuad && qDist(q, st.lastQuad) < tol) { if (!st.stableSince) st.stableSince = t; } else st.stableSince = 0;
          st.lastQuad = q; st.quad = q; st.firstLook = t;
        } else { st.quad = null; st.stableSince = 0; }
      }
      if (st.quad) {
        const held = st.stableSince ? t - st.stableSince : 0;
        drawQuad(st.quad, s, held > 250 ? '#3ecf6e' : '#ffd84a', held > 250 ? 'rgba(62,207,110,.2)' : 'rgba(255,216,74,.12)');
        $('#shutter', root)?.classList.add('ready');
        if (st.det?.shadow) hint('Shadow on note: tilt a bit' + (caps.torch ? ' or tap 🔦' : ''), 'warn'); else hint(held ? 'Hold still…' : 'Found it, hold steady', 'good');
        if (held >= 500) { snap(false, true); return; }
      } else {
        $('#shutter', root)?.classList.remove('ready');
        hint(t - st.firstLook > 2000 ? "Can't find the edges. Tap ✋ Manual and drag the corners." : 'Looking for the note…', t - st.firstLook > 2000 ? 'warn' : '');
      }
    };
    st.raf = requestAnimationFrame(loop);
  }
  function snap(manual, auto) {
    const v = st.video; if (!v) return;
    const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight; c.getContext('2d').drawImage(v, 0, 0);
    if (navigator.vibrate) navigator.vibrate(30);
    const q = !manual && st.quad ? st.quad : null;
    cancelAnimationFrame(st.raf); st.stream.getTracks().forEach(t => t.stop()); st.stream = null;
    st.frozen = c;
    if (q) { st.quad = q; $('#info', root).textContent = auto ? '📸 Auto-captured (outline held steady 0.5 s)' : '📸 Captured'; cropEditor(); }
    else useStill(c, 'Manual snap');
  }

  if (preset) return loadSample(preset);
  if (still) { hint('Pick a photo to test the scanner, or try a sample', ''); $('#bar', root).innerHTML = `<button class="btn primary" id="choose">🖼 Choose photo</button>${SAMPLES.map(([k, l]) => `<button class="btn" data-sample="${k}">${esc(l)}</button>`).join('')}`; $('#choose', root).onclick = choosePhoto; root.querySelectorAll('[data-sample]').forEach(b => b.onclick = () => loadSample(b.dataset.sample)); return; }
  startCamera();
}
window.__openScanner = openScanner;

// ================= REVIEW (single note) =================
export function openReview(init) {
  const st = { rawText: init.rawText || '', fields: extractFields(init.rawText || ''), dirty: {}, priority: null, ink: S.getSettings().inkColor || 'navy', font: S.getSettings().fontId || 'hand', tags: [], photo: null };
  if (init.photoCanvas) st.photo = toJPEG(init.photoCanvas);
  const root = document.createElement('div'); root.className = 'review';
  const sug = () => suggestPriority(st.rawText + ' ' + st.fields.ask);
  root.innerHTML = `<div class="inner">
    <div style="display:flex;align-items:center;gap:8px"><button class="btn" data-cancel>✕</button><h2 style="margin:0;flex:1">Review note</h2><span class="chip">${esc({ photo: '📷 Photo', type: '⌨ Typed', voice: '🎤 Voice', voicemail: '📼 Voicemail' }[init.source] || init.source)}</span></div>
    ${st.photo ? `<img class="snap" src="${st.photo}" style="margin-top:10px">` : ''}
    ${init.audio ? `<audio controls src="${init.audio}" style="width:100%;margin-top:10px"></audio><div class="ocrnote">📼 ${esc(init.audioName || 'Voicemail')} attached. <b>Placeholder:</b> the real app sends this to Grok Build to transcribe and summarize (caller, number, what they want). For now, type a quick summary below.</div>` : ''}
    ${init.source === 'photo' ? `<div class="ocrnote" id="ocrstat">Reading handwriting… <b>Placeholder OCR</b> (Tesseract) for this prototype; the real app uses Grok Build's reader. Text is always editable.</div>` : ''}
    ${init.dictateHint ? `<div class="ocrnote">Tap the 🎙 on your keyboard and talk.</div>` : ''}
    <div class="suggest" id="sug"></div>
    <label class="f">Name</label><input type="text" data-k="name">
    <div class="grid2" style="grid-template-columns:2fr 1fr"><div><label class="f">Phone</label><input type="tel" data-k="phone" style="font-family:var(--font-digits);font-size:20px"></div><div><label class="f">Ext</label><input type="text" data-k="ext"></div></div>
    <label class="f">Company</label><input type="text" data-k="company">
    <label class="f">What they want</label><textarea data-k="ask" rows="2"></textarea>
    <label class="f">Note text ${init.source === 'photo' ? '(from the photo)' : ''}</label><textarea id="raw" rows="4" class="note-text" style="font-size:22px">${esc(st.rawText)}</textarea>
    ${S.getSettings().tagsEnabled ? `<label class="f">Tags</label><div class="prio-row">${S.TAGS.map(t => `<button class="btn" data-tag="${t}">${t}</button>`).join('')}</div>` : ''}
    <div style="margin-top:10px"><button class="btn ghost" id="stylebtn">🖊 Style</button><div class="hidden" id="style">
      <div class="stylebox">${['navy', 'blue', 'black', 'red', 'green'].map(c => `<button class="swatch ${c === st.ink ? 'sel' : ''}" data-ink="${c}" style="background:var(--pen-${c})" aria-label="${c} ink"></button>`).join('')}</div>
      <div class="stylebox">${[['hand', 'Hand'], ['print', 'Print'], ['plain', 'Plain']].map(([k, l]) => `<button class="btn ${k === st.font ? 'sel' : ''}" data-font="${k}">${l}</button>`).join('')}</div></div></div>
  </div>
  <div class="savebar"><button class="btn" data-cancel>Cancel</button><button class="btn primary big" id="save">Save note</button></div>`;
  layer().appendChild(root);
  const fill = () => { root.querySelectorAll('[data-k]').forEach(i => { if (!st.dirty[i.dataset.k]) i.value = st.fields[i.dataset.k] || ''; }); renderSug(); };
  function renderSug() {
    const s = sug(); const p = st.priority || s.priority;
    $('#sug', root).innerHTML = `<div class="small muted">Suggested priority${s.why.length ? ` · because “${esc(s.why.join('”, “'))}”` : ''}</div>
      <div class="prio-row" style="margin-top:6px">${S.PRIORITIES.map(x => `<button class="btn ${x} ${x === p ? 'sel big' : ''}" data-p="${x}">${x === p && !st.priority ? '✓ ' : ''}${x}</button>`).join('')}</div>
      <div class="why">${st.priority ? 'Set by you.' : 'One tap Save keeps the suggestion.'}</div>`;
  }
  fill();
  root.addEventListener('input', (e) => {
    if (e.target.id === 'raw') { st.rawText = e.target.value; st.fields = extractFields(st.rawText); fill(); }
    if (e.target.dataset.k) { st.dirty[e.target.dataset.k] = true; st.fields[e.target.dataset.k] = e.target.value; renderSug(); }
  });
  root.addEventListener('click', (e) => {
    const t = e.target.closest('[data-p],[data-cancel],[data-ink],[data-font],[data-tag],#stylebtn,#save'); if (!t) return;
    if (t.dataset.p) { st.priority = t.dataset.p; renderSug(); }
    if (t.hasAttribute('data-cancel')) root.remove();
    if (t.id === 'stylebtn') $('#style', root).classList.toggle('hidden');
    if (t.dataset.ink) { st.ink = t.dataset.ink; root.querySelectorAll('[data-ink]').forEach(x => x.classList.toggle('sel', x === t)); $('#raw', root).style.color = `var(--pen-${st.ink})`; }
    if (t.dataset.font) { st.font = t.dataset.font; root.querySelectorAll('[data-font]').forEach(x => x.classList.toggle('sel', x === t)); }
    if (t.dataset.tag) { st.tags = st.tags.includes(t.dataset.tag) ? st.tags.filter(x => x !== t.dataset.tag) : [...st.tags, t.dataset.tag]; t.classList.toggle('sel'); }
    if (t.id === 'save') save();
  });
  function save() {
    const f = st.fields; const raw = st.rawText || f.ask || (init.audio ? 'Voicemail' : '');
    if (!raw.trim() && !st.photo && !init.audio) { app.toast('Nothing to save yet'); return; }
    const n = S.create({ title: makeTitle(f, raw), rawText: emojify(raw), contact: { name: f.name, company: f.company, phone: formatPhone(f.phone), ext: f.ext }, ask: f.ask,
      priority: st.priority || sug().priority, photo: st.photo, audio: init.audio || null, source: init.source, tags: st.tags, inkColor: st.ink, fontId: st.font });
    root.remove(); app.toast(`Saved to ${n.priority}`); app.highlightNew(n.id);
  }
  if (init.photoCanvas) {
    ocr(init.photoCanvas, (p) => { const s = $('#ocrstat', root); if (s) s.firstChild.textContent = `Reading handwriting… ${p}% `; }).then((text) => {
      if (!root.isConnected) return; const s = $('#ocrstat', root);
      if (s) s.firstChild.textContent = text ? 'Read it. ' : "Couldn't read it (placeholder OCR). Type what it says. ";
      if (text && !$('#raw', root).value) { st.rawText = text; $('#raw', root).value = text; st.fields = extractFields(text); fill(); }
    });
  } else setTimeout(() => $('#raw', root)?.focus(), 50);
}

// ================= MULTI-NOTE REVIEW =================
async function openMultiReview(flat, mode, original) {
  const cv = await prefetchScanner();
  let entries = splitEntries(cv, flat).map(e => ({ snippet: toJPEG(e.canvas, 900, 0.75), canvas: e.canvas, text: '', lead: e.lead, lines: e.lines, priority: null }));
  if (!entries.length) entries = [{ snippet: toJPEG(flat), canvas: flat, text: '', lead: false, lines: 1 }];
  const root = document.createElement('div'); root.className = 'review';
  layer().appendChild(root);
  function render() {
    root.innerHTML = `<div class="inner"><div style="display:flex;gap:8px;align-items:center"><button class="btn" data-cancel>✕</button><h2 style="margin:0;flex:1">${entries.length} notes found on this page</h2></div>
      <div class="ocrnote">Split by blank gaps + a leading dash / dot / line. Merge or split if it guessed wrong. <b>Placeholder OCR</b> (Tesseract); the real app uses Grok Build's reader.</div>
      ${entries.map((e, i) => { const s = suggestPriority(e.text); const p = e.priority || s.priority; const f = extractFields(e.text); return `<div class="entry" data-i="${i}">
        <div class="small muted">#${i + 1}${e.lead ? ' · starts with a mark' : ''}${e.lines > 1 ? ` · ${e.lines} lines` : ''}${f.phone ? ` · 📞 ${esc(f.phone)}` : ''}${f.name ? ` · ${esc(f.name)}` : ''}</div>
        <img src="${e.snippet}" alt="snippet ${i + 1}">
        <textarea data-t="${i}" rows="2" placeholder="${e.reading ? 'Reading…' : 'Type what it says'}">${esc(e.text)}</textarea>
        <div class="tools"><div class="prio-row" style="flex:1">${S.PRIORITIES.map(x => `<button class="btn ${x} ${x === p ? 'sel' : ''}" data-pi="${i}" data-p="${x}">${x}</button>`).join('')}</div>
        ${i ? `<button class="btn" data-merge="${i}">⤒ Merge with above</button>` : ''}<button class="btn" data-split="${i}" title="Split the text at the cursor into a new entry">✂ Split</button><button class="btn ghost" data-skip="${i}">Skip</button></div></div>`; }).join('')}
      </div><div class="savebar"><button class="btn" data-cancel>Cancel</button><button class="btn primary big" id="saveall">Save ${entries.length} notes</button></div>`;
  }
  render();
  root.addEventListener('input', e => { if (e.target.dataset.t) entries[+e.target.dataset.t].text = e.target.value; });
  root.addEventListener('click', (e) => {
    const t = e.target.closest('button'); if (!t) return;
    if (t.hasAttribute('data-cancel')) return root.remove();
    if (t.dataset.pi) { entries[+t.dataset.pi].priority = t.dataset.p; render(); }
    if (t.dataset.merge) { const i = +t.dataset.merge, a = entries[i - 1], b = entries[i]; const c = document.createElement('canvas'); c.width = Math.max(a.canvas.width, b.canvas.width); c.height = a.canvas.height + b.canvas.height; const g = c.getContext('2d'); g.drawImage(a.canvas, 0, 0); g.drawImage(b.canvas, 0, a.canvas.height); entries.splice(i - 1, 2, { ...a, canvas: c, snippet: toJPEG(c, 900, 0.75), text: [a.text, b.text].filter(Boolean).join('\n'), lines: a.lines + b.lines }); render(); }
    if (t.dataset.split) { const i = +t.dataset.split; const ta = root.querySelector(`[data-t="${i}"]`); const pos = ta.selectionStart || Math.floor(ta.value.length / 2); const e1 = entries[i]; entries.splice(i, 1, { ...e1, text: ta.value.slice(0, pos).trim() }, { ...e1, text: ta.value.slice(pos).trim(), priority: null }); render(); }
    if (t.dataset.skip) { entries.splice(+t.dataset.skip, 1); render(); }
    if (t.id === 'saveall') {
      let last; const ids = []; entries.forEach(en => { const f = extractFields(en.text); last = S.create({ title: makeTitle(f, en.text), rawText: emojify(en.text), contact: { name: f.name, company: f.company, phone: f.phone, ext: f.ext }, ask: f.ask, priority: en.priority || suggestPriority(en.text).priority, photo: en.snippet, source: 'photo-multi' }); ids.push(last.id); });
      root.remove(); app.toast(`Saved ${entries.length} notes`); if (last) app.highlightNew(last.id, ids);
    }
  });
  // OCR each snippet in sequence
  for (const en of entries) { en.reading = true; }
  render();
  for (const en of [...entries]) { const txt = await ocr(en.canvas); en.reading = false; if (!en.text) en.text = txt; if (root.isConnected) render(); }
}
window.__openMulti = (c) => openMultiReview(c, 'note');
