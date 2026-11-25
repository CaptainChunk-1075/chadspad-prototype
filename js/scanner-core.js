// Document/sticky-note detector built on OpenCV.js.
// Strategy (robust to Captain's maroon mat + hard phone shadow):
//  1. COLOR path: illumination-invariant chromaticity (r,g = R/sum, G/sum). Shadows scale R,G,B together,
//     so chromaticity barely moves under shadow. Background ("mat") model = median chroma of the frame border,
//     blended with a learned mat colour from previous good snaps. Distance-from-mat -> Otsu -> paper mask.
//  2. EDGE path: luminance divided by a heavy blur (flattens lighting) -> Canny -> 4-gon contours.
//  3. Quad fitting: convex hull -> approxPolyDP; if 5-6 vertices (a corner lost in shadow), keep the 4 longest
//     sides and intersect them, i.e. "3-4 strong edges, infer the missing corner". Fallback minAreaRect.
//  4. Score candidates by IoU with the colour mask, convexity and size; pick the best.
export const WORK = 360; // detection resolution (long side)

// NOTE: the Emscripten Module object is a "thenable"; resolving a Promise with it loops forever.
// So we strip .then once it is ready and resolve with the plain object.
let _cvP = null;
export function cvReady() {
  if (_cvP) return _cvP;
  _cvP = new Promise((res) => {
    const t = setInterval(() => {
      const cv = window.cv;
      if (cv && cv.Mat) { clearInterval(t); try { delete cv.then; } catch {} if (cv.then) cv.then = undefined; res(cv); }
    }, 80);
  });
  return _cvP;
}

function median(arr) { const a = Float32Array.from(arr).sort(); return a.length ? a[a.length >> 1] : 0; }

/**
 * Sample the border band -> mat models. Real cameras do NOT keep chroma constant in deep shadow
 * (black level, gamma, JPEG/YUV range), so we keep separate models for the lit mat and the shadowed mat
 * (bright vs dark third of border pixels) and measure distance to the nearest one.
 */
function borderModel(px, w, h) {
  const band = Math.max(3, Math.round(Math.min(w, h) * 0.05));
  const S = [];
  for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) if (x < band || y < band || x >= w - band || y >= h - band) {
    const i = (y * w + x) * 4, R = px[i], G = px[i + 1], B = px[i + 2], s = R + G + B + 1; if (s < 20) continue; S.push([R / s, G / s, s / 3]);
  }
  S.sort((a, b) => a[2] - b[2]);
  const part = (lo, hi) => { const seg = S.slice(Math.floor(S.length * lo), Math.max(Math.floor(S.length * lo) + 1, Math.floor(S.length * hi))); return { r: median(seg.map(v => v[0])), g: median(seg.map(v => v[1])), L: median(seg.map(v => v[2])) }; };
  const all = part(0, 1), dark = part(0, 0.33), mid = part(0.33, 0.66), lit = part(0.66, 1);
  return { r: lit.r, g: lit.g, L: all.L, models: [lit, mid, dark] };
}

function lineFrom(p, q) { return { a: q.y - p.y, b: p.x - q.x, c: (q.y - p.y) * p.x + (p.x - q.x) * p.y }; }
function intersect(l1, l2) { const d = l1.a * l2.b - l2.a * l1.b; if (Math.abs(d) < 1e-6) return null; return { x: (l1.c * l2.b - l2.c * l1.b) / d, y: (l1.a * l2.c - l2.a * l1.c) / d }; }
function polyArea(q) { let s = 0; for (let i = 0; i < q.length; i++) { const a = q[i], b = q[(i + 1) % q.length]; s += a.x * b.y - b.x * a.y; } return Math.abs(s) / 2; }
function isConvex(q) { let sign = 0; for (let i = 0; i < 4; i++) { const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4]; const z = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x); if (z === 0) continue; if (!sign) sign = Math.sign(z); else if (Math.sign(z) !== sign) return false; } return true; }
export function orderQuad(q) { // tl, tr, br, bl
  const c = q.reduce((s, p) => ({ x: s.x + p.x / 4, y: s.y + p.y / 4 }), { x: 0, y: 0 });
  const s = [...q].sort((a, b) => Math.atan2(a.y - c.y, a.x - c.x) - Math.atan2(b.y - c.y, b.x - c.x));
  let tl = 0; s.forEach((p, i) => { if (p.x + p.y < s[tl].x + s[tl].y) tl = i; });
  return [0, 1, 2, 3].map(i => s[(tl + i) % 4]);
}
const matToPts = (m) => { const out = []; for (let i = 0; i < m.rows; i++) out.push({ x: m.data32S[i * 2], y: m.data32S[i * 2 + 1] }); return out; };

function angleDev(q) { // sum |cos| of the 4 corner angles: 0 for a perfect rectangle
  let r = 0; for (let i = 0; i < 4; i++) { const a = q[i], b = q[(i + 1) % 4], d = q[(i + 3) % 4]; const v1 = { x: b.x - a.x, y: b.y - a.y }, v2 = { x: d.x - a.x, y: d.y - a.y }; r += Math.abs(v1.x * v2.x + v1.y * v2.y) / (Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y) + 1e-6); }
  return r;
}
/**
 * Fit a quad to a contour. If the hull simplifies to 5-6 vertices (a corner lost to shadow, a finger or the
 * phone edge), try every choice of 4 of its sides (in order), intersect neighbours, and keep the most
 * rectangular quad that still covers the hull: "3 strong edges + infer the missing corner".
 */
function quadFromContour(cv, cnt) {
  const hull = new cv.Mat(); cv.convexHull(cnt, hull, false, true);
  const peri = cv.arcLength(hull, true), ha = cv.contourArea(hull);
  const cands = [];
  for (const f of [0.015, 0.025, 0.04, 0.06]) {
    const ap = new cv.Mat(); cv.approxPolyDP(hull, ap, f * peri, true);
    const pts = matToPts(ap); ap.delete();
    if (pts.length === 4) { const q = orderQuad(pts); if (isConvex(q)) cands.push({ q, inferred: false }); continue; }
    if (pts.length < 5 || pts.length > 7) continue;
    const n = pts.length, sides = pts.map((p, i) => ({ p, q: pts[(i + 1) % n] }));
    const combos = []; const rec = (start, pick) => { if (pick.length === 4) return combos.push([...pick]); for (let i = start; i < n; i++) rec(i + 1, [...pick, i]); }; rec(0, []);
    for (const c of combos) {
      const ls = c.map(i => lineFrom(sides[i].p, sides[i].q)); const q = [];
      for (let k = 0; k < 4; k++) { const x = intersect(ls[k], ls[(k + 1) % 4]); if (x) q.push(x); }
      if (q.length !== 4) continue; const oq = orderQuad(q); const qa = polyArea(oq);
      if (isConvex(oq) && qa >= ha * 0.97 && qa <= ha * 1.6) cands.push({ q: oq, inferred: true, extra: qa / ha - 1 });
    }
  }
  let best = null, bestS = -1e9;
  for (const c of cands) { const sc = -angleDev(c.q) - (c.extra || 0) * 0.8 - (c.inferred ? 0.03 : 0); if (sc > bestS) { bestS = sc; best = c; } }
  if (!best) { const r = cv.minAreaRect(hull); const v = cv.RotatedRect.points(r); best = { q: orderQuad(v.map(p => ({ x: p.x, y: p.y }))), inferred: true }; }
  hull.delete();
  return { quad: best.q, inferred: best.inferred };
}

function maskIoU(cv, mask, quad, w, h) {
  const qm = cv.Mat.zeros(h, w, cv.CV_8U);
  const pts = cv.matFromArray(4, 1, cv.CV_32SC2, quad.flatMap(p => [Math.round(p.x), Math.round(p.y)]));
  const vec = new cv.MatVector(); vec.push_back(pts); cv.fillPoly(qm, vec, new cv.Scalar(255));
  const inter = new cv.Mat(), uni = new cv.Mat(); cv.bitwise_and(qm, mask, inter); cv.bitwise_or(qm, mask, uni);
  const iou = cv.countNonZero(inter) / Math.max(1, cv.countNonZero(uni));
  qm.delete(); pts.delete(); vec.delete(); inter.delete(); uni.delete();
  return iou;
}

/**
 * Detect the paper quad in an RGBA Mat (any size). Returns quad in SOURCE coords or null.
 * opts.matModel: learned {r,g} mat chroma; opts.debug: return mask canvas data.
 */
export function detectQuad(cv, src, opts = {}) {
  const scale = WORK / Math.max(src.cols, src.rows);
  const small = new cv.Mat(); cv.resize(src, small, new cv.Size(Math.round(src.cols * scale), Math.round(src.rows * scale)), 0, 0, cv.INTER_AREA);
  const w = small.cols, h = small.rows, px = small.data, N = w * h, frameArea = N;
  const border = borderModel(px, w, h);
  const models = [...border.models]; if (opts.matModel) models.push(opts.matModel); // learned mat colour from earlier good snaps

  // --- colour path ---
  const dist = new cv.Mat(h, w, cv.CV_8U); const dd = dist.data;
  for (let i = 0, j = 0; i < N; i++, j += 4) {
    const R = px[j], G = px[j + 1], B = px[j + 2], s = R + G + B + 1;
    const conf = Math.max(0, Math.min(1, (s - 40) / 80));    // near-black pixels (phone body, deep mat shadow) have no trustworthy chroma
    const r = R / s, g = G / s; let dm = 1e9;
    for (let m = 0; m < models.length; m++) { const v = (r - models[m].r) ** 2 + (g - models[m].g) ** 2; if (v < dm) dm = v; }
    const dc = Math.sqrt(dm) * 900;                            // chroma distance to the nearest mat model
    dd[i] = Math.min(255, dc * conf);
  }
  cv.GaussianBlur(dist, dist, new cv.Size(5, 5), 0);
  const mask = new cv.Mat(); const otsu = cv.threshold(dist, mask, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU);
  const k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(7, 7));
  cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, k); cv.morphologyEx(mask, mask, cv.MORPH_OPEN, k);
  // fill holes (text/logos inside paper)
  const cands = [];
  const conts = new cv.MatVector(), hier = new cv.Mat();
  cv.findContours(mask, conts, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
  const filled = cv.Mat.zeros(h, w, cv.CV_8U);
  let colourOK = otsu > 18;
  for (let i = 0; i < conts.size(); i++) {
    const c = conts.get(i), a = cv.contourArea(c);
    if (a < frameArea * 0.03 || a > frameArea * 0.97) continue;
    cv.drawContours(filled, conts, i, new cv.Scalar(255), -1);
    const { quad, inferred } = quadFromContour(cv, c);
    cands.push({ quad, inferred, method: 'colour', area: a });
  }
  conts.delete(); hier.delete();

  // --- edge path ---
  const gray = new cv.Mat(); cv.cvtColor(small, gray, cv.COLOR_RGBA2GRAY);
  const blur = new cv.Mat(); cv.GaussianBlur(gray, blur, new cv.Size(0, 0), 15);
  const norm = new cv.Mat(); gray.convertTo(gray, cv.CV_32F); blur.convertTo(blur, cv.CV_32F, 1, 1);
  cv.divide(gray, blur, norm, 128); norm.convertTo(norm, cv.CV_8U);
  cv.GaussianBlur(norm, norm, new cv.Size(5, 5), 0);
  const edges = new cv.Mat(); cv.Canny(norm, edges, 40, 110);
  cv.dilate(edges, edges, cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3)));
  const ec = new cv.MatVector(), eh = new cv.Mat();
  cv.findContours(edges, ec, eh, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
  for (let i = 0; i < ec.size(); i++) {
    const c = ec.get(i); const a = cv.contourArea(c);
    if (a < frameArea * 0.05 || a > frameArea * 0.95) continue;
    const peri = cv.arcLength(c, true); const ap = new cv.Mat(); cv.approxPolyDP(c, ap, 0.025 * peri, true);
    if (ap.rows === 4 && cv.isContourConvex(ap)) cands.push({ quad: orderQuad(matToPts(ap)), inferred: false, method: 'edge', area: a });
    ap.delete();
  }
  ec.delete(); eh.delete(); gray.delete(); blur.delete(); norm.delete(); edges.delete();

  // --- score ---
  const filledArea = cv.countNonZero(filled);
  let best = null;
  for (const c of cands) {
    const qa = polyArea(c.quad);
    if (!isConvex(c.quad) || qa < frameArea * 0.04) continue;
    const iou = colourOK && filledArea ? maskIoU(cv, filled, c.quad, w, h) : 0;
    const touches = c.quad.filter(p => p.x < 2 || p.y < 2 || p.x > w - 3 || p.y > h - 3).length;
    // angles near 90° bonus
    let rect = 0; for (let i = 0; i < 4; i++) { const a = c.quad[i], b = c.quad[(i + 1) % 4], d = c.quad[(i + 3) % 4]; const v1 = { x: b.x - a.x, y: b.y - a.y }, v2 = { x: d.x - a.x, y: d.y - a.y }; rect += Math.abs(v1.x * v2.x + v1.y * v2.y) / (Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y) + 1e-6); }
    c.score = (colourOK ? iou * 2 : 0) + Math.min(1, qa / frameArea * 3) * 0.6 - rect * 0.25 - touches * 0.4 - (c.inferred ? 0.05 : 0);
    c.iou = iou;
    if (!best || c.score > best.score) best = c;
  }

  // --- shadow hint: dark fraction inside the quad ---
  let shadow = false, debugMask = null;
  if (best) {
    const L = []; const q = best.quad;
    const minx = Math.max(0, Math.min(...q.map(p => p.x))), maxx = Math.min(w - 1, Math.max(...q.map(p => p.x)));
    const miny = Math.max(0, Math.min(...q.map(p => p.y))), maxy = Math.min(h - 1, Math.max(...q.map(p => p.y)));
    // close (max-filter) first so ink, ruling and logos don't count as "shadow"
    const g = new cv.Mat(); cv.cvtColor(small, g, cv.COLOR_RGBA2GRAY); cv.morphologyEx(g, g, cv.MORPH_CLOSE, cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(11, 11)));
    const inset = (p) => p; const cxq = q.reduce((a, p) => a + p.x / 4, 0), cyq = q.reduce((a, p) => a + p.y / 4, 0);
    const qi = q.map(p => ({ x: cxq + (p.x - cxq) * 0.85, y: cyq + (p.y - cyq) * 0.85 }));
    const inside = (x, y) => { let c = false; for (let i = 0, j = 3; i < 4; j = i++) { const a = qi[i], b = qi[j]; if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) c = !c; } return c; };
    for (let y = miny | 0; y <= maxy; y += 2) for (let x = minx | 0; x <= maxx; x += 2) if (inside(x, y)) L.push(g.data[y * w + x]);
    g.delete();
    L.sort((a, b) => a - b); const p90 = L[Math.floor(L.length * 0.7)] || 1; // reference = typical lit paper
    shadow = L.filter(v => v < p90 * 0.6).length / Math.max(1, L.length) > 0.1;
  }
  if (opts.debug) { debugMask = new ImageData(w, h); for (let i = 0; i < N; i++) { const v = filled.data[i]; debugMask.data.set([v, dd[i], 0, 255], i * 4); } }
  small.delete(); dist.delete(); mask.delete(); filled.delete(); k.delete();
  if (!best || best.score < 0.5) return { quad: null, shadow, border, debugMask, candidates: cands.length, otsu };
  return {
    quad: best.quad.map(p => ({ x: p.x / scale, y: p.y / scale })), score: +best.score.toFixed(3), iou: +best.iou.toFixed(3),
    method: best.method, inferred: best.inferred, shadow, border, debugMask, candidates: cands.length, otsu,
  };
}

/** Perspective-flatten src canvas by quad → new canvas. */
export function warp(cv, srcCanvas, quad, maxSide = 1600) {
  const [tl, tr, br, bl] = quad;
  let W = Math.max(Math.hypot(tr.x - tl.x, tr.y - tl.y), Math.hypot(br.x - bl.x, br.y - bl.y));
  let H = Math.max(Math.hypot(bl.x - tl.x, bl.y - tl.y), Math.hypot(br.x - tr.x, br.y - tr.y));
  const s = Math.min(1, maxSide / Math.max(W, H)); W = Math.round(W * s); H = Math.round(H * s);
  const src = cv.imread(srcCanvas), dst = new cv.Mat();
  const a = cv.matFromArray(4, 1, cv.CV_32FC2, [tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y]);
  const b = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, W, 0, W, H, 0, H]);
  const M = cv.getPerspectiveTransform(a, b);
  cv.warpPerspective(src, dst, M, new cv.Size(W, H), cv.INTER_LINEAR, cv.BORDER_REPLICATE);
  const out = document.createElement('canvas'); cv.imshow(out, dst);
  src.delete(); dst.delete(); a.delete(); b.delete(); M.delete();
  return out;
}

/** Shadow cleanup: divide each channel by a heavily blurred luminance so shadowed areas match lit ones. */
export function flattenLighting(cv, canvas) {
  const src = cv.imread(canvas); const rgb = new cv.Mat(); cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
  const gray = new cv.Mat(); cv.cvtColor(rgb, gray, cv.COLOR_RGB2GRAY);
  const k = Math.max(31, (Math.round(Math.max(src.cols, src.rows) / 8) | 1));
  // background estimate: close (removes ink), then blur
  const bgm = new cv.Mat(); cv.morphologyEx(gray, bgm, cv.MORPH_CLOSE, cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(15, 15)));
  cv.GaussianBlur(bgm, bgm, new cv.Size(k, k), 0);
  // target = 80th percentile of the background estimate (the lit paper), gain only brightens (never darkens)
  const d = rgb.data, b = bgm.data; const hist = new Uint32Array(256); for (let i = 0; i < b.length; i++) hist[b[i]]++;
  let acc = 0, target = 255; for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= b.length * 0.8) { target = v; break; } }
  for (let i = 0, j = 0; i < b.length; i++, j += 3) { const g = Math.max(1, Math.min(3.5, target / Math.max(8, b[i]))); d[j] = Math.min(255, d[j] * g); d[j + 1] = Math.min(255, d[j + 1] * g); d[j + 2] = Math.min(255, d[j + 2] * g); }
  const out = document.createElement('canvas'); cv.imshow(out, rgb);
  src.delete(); rgb.delete(); gray.delete(); bgm.delete();
  return out;
}

/**
 * Multi-note page split (heuristic stub): ink mask -> horizontal projection -> text bands;
 * removes printed ruling + margin, then a band that starts with a small blob hanging left of the text column
 * (dash/dot/line) OR follows a clearly bigger blank gap begins a new entry;
 * bands without a lead mark are continuation lines of the entry above.
 */
export function splitEntries(cv, canvas) {
  const src = cv.imread(canvas); const gray = new cv.Mat(); cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  const ink = new cv.Mat(); cv.adaptiveThreshold(gray, ink, 255, cv.ADAPTIVE_THRESH_MEAN_C, cv.THRESH_BINARY_INV, 31, 18);
  cv.morphologyEx(ink, ink, cv.MORPH_OPEN, cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(2, 2)));
  // remove printed ruling (legal-pad blue lines, red margin): long thin horizontal / vertical runs
  for (const [kw, kh] of [[Math.round(ink.cols * 0.2), 1], [1, Math.round(ink.rows * 0.2)]]) {
    const lines = new cv.Mat(); cv.morphologyEx(ink, lines, cv.MORPH_OPEN, cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(kw, kh)));
    cv.dilate(lines, lines, cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(kh > 1 ? 5 : 1, kw > 1 ? 5 : 1)));
    cv.subtract(ink, lines, ink); lines.delete();
  }
  const w = ink.cols, h = ink.rows, d = ink.data;
  const mX = Math.round(w * 0.06); // ignore paper edge / crop sliver
  // kill any column that is inked over most of the page height (margin rule, binding, fold)
  { const colInk = new Uint32Array(w); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (d[y * w + x]) colInk[x]++;
    for (let x = 0; x < w; x++) if (colInk[x] > h * 0.35) for (let xx = Math.max(0, x - 3); xx <= Math.min(w - 1, x + 3); xx++) for (let y = 0; y < h; y++) d[y * w + xx] = 0; }
  const rows = new Float32Array(h);
  for (let y = 0; y < h; y++) { let c = 0; for (let x = mX; x < w - mX; x++) if (d[y * w + x]) c++; rows[y] = c / w; }
  const bands = []; let inB = false, s = 0; const thr = 0.015; // fraction of row width that is ink
  for (let y = Math.round(h * 0.02); y < h; y++) { const on = rows[y] > thr; if (on && !inB) { inB = true; s = y; } if ((!on || y === h - 1) && inB) { inB = false; if (y - s > h * 0.012) bands.push({ y0: s, y1: y }); } }
  // merge bands separated by tiny gaps (descenders)
  const merged = []; for (const b of bands) { const last = merged[merged.length - 1]; if (last && b.y0 - last.y1 < h * 0.012) last.y1 = b.y1; else merged.push({ ...b }); }
  // lead-mark detection: a dash / dot / line hangs out LEFT of the text column, or is a small blob followed by a gap
  for (const b of merged) {
    const cols = []; for (let x = mX; x < w - mX; x++) { let c = 0; for (let y = b.y0; y < b.y1; y++) if (d[y * w + x]) c++; cols.push(c >= 2 ? c : 0); }
    const first = cols.findIndex(c => c > 0); let end = first; while (end < cols.length && cols[end] > 0) end++;
    let gapEnd = end; while (gapEnd < cols.length && cols[gapEnd] === 0) gapEnd++;
    const bh = b.y1 - b.y0;
    b.x0 = first + mX; b.blob = first >= 0 && (end - first) < bh * 1.2 && (gapEnd - end) > bh * 0.3; b.textX = b.blob ? gapEnd + mX : b.x0;
  }
  const textXs = merged.map(b => b.textX).sort((a, b) => a - b); const bodyX = textXs[textXs.length >> 1] || 0;
  for (const b of merged) { const bh = b.y1 - b.y0; b.lead = b.blob && b.x0 < bodyX - bh * 0.3; }
  // group into entries: a new entry starts at a lead mark OR after a clearly bigger blank gap than between lines
  const gaps = merged.slice(1).map((b, i) => b.y0 - merged[i].y1).sort((a, b) => a - b);
  const typGap = gaps.length ? gaps[Math.floor(gaps.length * 0.3)] : 0;
  const bigGap = Math.max(h * 0.035, typGap * 2.5 + 4);
  const entries = [];
  for (const b of merged) {
    const last = entries[entries.length - 1];
    if (!last || b.lead || (b.y0 - last.y1) > bigGap) entries.push({ y0: b.y0, y1: b.y1, lead: b.lead, lines: 1 });
    else { last.y1 = b.y1; last.lines++; }
  }
  src.delete(); gray.delete(); ink.delete();
  return entries.map(e => {
    const pad = Math.round(h * 0.012); const y0 = Math.max(0, e.y0 - pad), y1 = Math.min(h, e.y1 + pad);
    const c = document.createElement('canvas'); c.width = w; c.height = y1 - y0; c.getContext('2d').drawImage(canvas, 0, y0, w, y1 - y0, 0, 0, w, y1 - y0);
    return { y0, y1, lead: e.lead, lines: e.lines, canvas: c };
  });
}
