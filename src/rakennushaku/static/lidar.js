/* Rakennushaku: building height and roof shape from the NLS (MML) open laser scanning data.

   Data: Laserkeilausaineisto 0,5 p (CC BY 4.0), a classified point cloud of about 0.5 points/m², delivered as
   LAZ files per 3 × 3 km TM35 map sheet (1:5000) by the NLS file service (OGC API Processes,
   process laserkeilausaineisto_05_karttalehti). Classes: 1 unclassified (buildings are here), 2 ground,
   3–5 vegetation, 7 low noise, 12 overlap, 15–17 air/isolated/fault points.

   Method per selected building (footprint from the NLS Topographic Database):
   - ground level = median of ground points (class 2) within 12 m outside the footprint;
   - roof points = class 1 points at least 0.7 m inside the footprint, 1.2–45 m above ground;
   - roof shape = the best of three least-squares models across the building's main axis:
     flat (h = c), mono-pitch (h = a + b·u) and gable (h = r − s·|u − u0|); pitch = atan(slope);
   - lidar footprint = 2 m cells with a class 1 point over 2 m high, closed by one cell, connected to the
     footprint; compared with the NLS footprint area;
   - volume = modelled roof height integrated over the footprint (2 m grid).

   Runs in the browser (and Node for tests). LAZ is decompressed with laz-perf (Apache-2.0, WebAssembly). */
(function (root) {
  "use strict";

  // ------------------------------------------------------------------ ETRS-TM35FIN (EPSG:3067)
  // Transverse Mercator on GRS80, central meridian 27°E, k0 0.9996, false easting 500 000 m (Krüger series).
  const A_ = 6378137, F_ = 1 / 298.257222101, K0 = 0.9996, LON0 = 27 * Math.PI / 180, FE = 500000;
  const N_ = F_ / (2 - F_), E_ = Math.sqrt(F_ * (2 - F_));
  const AA = A_ / (1 + N_) * (1 + N_ * N_ / 4 + N_ ** 4 / 64);
  const ALPHA = [N_ / 2 - 2 * N_ ** 2 / 3 + 5 * N_ ** 3 / 16, 13 * N_ ** 2 / 48 - 3 * N_ ** 3 / 5, 61 * N_ ** 3 / 240];
  const BETA = [N_ / 2 - 2 * N_ ** 2 / 3 + 37 * N_ ** 3 / 96, N_ ** 2 / 48 + N_ ** 3 / 15, 17 * N_ ** 3 / 480];
  const DELTA = [2 * N_ - 2 * N_ ** 2 / 3 - 2 * N_ ** 3, 7 * N_ ** 2 / 3 - 8 * N_ ** 3 / 5, 56 * N_ ** 3 / 15];

  function toTm35(lon, lat) {
    const phi = lat * Math.PI / 180, dl = lon * Math.PI / 180 - LON0;
    const t = Math.sinh(Math.atanh(Math.sin(phi)) - E_ * Math.atanh(E_ * Math.sin(phi)));
    const xi = Math.atan(t / Math.cos(dl)), eta = Math.atanh(Math.sin(dl) / Math.sqrt(1 + t * t));
    let x = eta, y = xi;
    for (let j = 1; j <= 3; j++) {
      x += ALPHA[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
      y += ALPHA[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
    }
    return [FE + K0 * AA * x, K0 * AA * y];
  }
  function fromTm35(e, n) {
    const xi = n / (K0 * AA), eta = (e - FE) / (K0 * AA);
    let xp = xi, ep = eta;
    for (let j = 1; j <= 3; j++) {
      xp -= BETA[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
      ep -= BETA[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
    }
    const chi = Math.asin(Math.sin(xp) / Math.cosh(ep));
    let phi = chi;
    for (let j = 1; j <= 3; j++) phi += DELTA[j - 1] * Math.sin(2 * j * chi);
    const lon = LON0 + Math.atan(Math.sinh(ep) / Math.cos(xp));
    return [lon * 180 / Math.PI, phi * 180 / Math.PI];
  }

  // ------------------------------------------------------------------ TM35 map sheets
  // 1:200 000 sheets are 192 × 96 km from E −76 000, N 6 570 000 (rows K…X without O, columns from 2);
  // 1:100 000, 1:50 000 and 1:25 000 halve both sides (1 SW, 2 NW, 3 SE, 4 NE); 1:10 000 splits
  // 24 × 12 km into 6 × 6 km cells A–H (column by column from SW); 1:5000 halves again (1–4): 3 × 3 km.
  const ROWS = "KLMNPQRSTUVWX";
  function sheetName(e, n) {
    const r = Math.floor((n - 6570000) / 96000), c = Math.floor((e + 76000) / 192000);
    if (r < 0 || r >= ROWS.length || c < 0) return null;
    let name = ROWS[r] + (c + 2);
    let x0 = -76000 + c * 192000, y0 = 6570000 + r * 96000, w = 192000, h = 96000;
    for (let k = 0; k < 3; k++) {
      w /= 2; h /= 2;
      const qx = e - x0 >= w ? 1 : 0, qy = n - y0 >= h ? 1 : 0;
      name += 1 + 2 * qx + qy;
      x0 += qx * w; y0 += qy * h;
    }
    const col = Math.floor((e - x0) / 6000), row = Math.floor((n - y0) / 6000);
    name += "ABCDEFGH"[col * 2 + row];
    x0 += col * 6000; y0 += row * 6000;
    const qx = e - x0 >= 3000 ? 1 : 0, qy = n - y0 >= 3000 ? 1 : 0;
    return name + (1 + 2 * qx + qy);
  }
  function sheetsForBox(minE, minN, maxE, maxN) {
    const out = new Set();
    for (let e = Math.floor(minE / 3000) * 3000 + 1; e <= maxE + 2999; e += 3000) {
      for (let n = Math.floor(minN / 3000) * 3000 + 1; n <= maxN + 2999; n += 3000) {
        const s = sheetName(Math.min(e, maxE), Math.min(n, maxN));
        if (s) out.add(s);
      }
    }
    return [...out].sort();
  }

  // ------------------------------------------------------------------ geometry helpers
  function outerRings(geom) {
    if (!geom) return [];
    if (geom.type === "Polygon") return [geom.coordinates[0]];
    if (geom.type === "MultiPolygon") return geom.coordinates.map((p) => p[0]);
    return [];
  }
  function ringArea(r) { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]); return Math.abs(a / 2); }
  function inRing(x, y, r) {
    let inside = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const xi = r[i][0], yi = r[i][1], xj = r[j][0], yj = r[j][1];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function edgeDist(x, y, r) {
    let d = Infinity;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const ax = r[j][0], ay = r[j][1], bx = r[i][0], by = r[i][1];
      const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
      const t = L > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L)) : 0;
      d = Math.min(d, Math.hypot(x - ax - t * dx, y - ay - t * dy));
    }
    return d;
  }
  function convexHull(pts) {
    const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (p.length < 3) return p;
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [], up = [];
    for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
    for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
    return lo.slice(0, -1).concat(up.slice(0, -1));
  }
  // minimum-area rectangle: its long side gives the building's main axis
  function mainAxis(rings) {
    const hull = convexHull(rings.flat());
    let best = { area: Infinity, angle: 0, length: 0, width: 0 };
    for (let i = 0; i < hull.length; i++) {
      const a = hull[i], b = hull[(i + 1) % hull.length];
      const ang = Math.atan2(b[1] - a[1], b[0] - a[0]), c = Math.cos(ang), s = Math.sin(ang);
      let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
      for (const q of hull) {
        const u = q[0] * c + q[1] * s, v = -q[0] * s + q[1] * c;
        minU = Math.min(minU, u); maxU = Math.max(maxU, u); minV = Math.min(minV, v); maxV = Math.max(maxV, v);
      }
      const area = (maxU - minU) * (maxV - minV);
      if (area < best.area) {
        const along = maxU - minU >= maxV - minV;
        best = { area, angle: along ? ang : ang + Math.PI / 2, length: Math.max(maxU - minU, maxV - minV), width: Math.min(maxU - minU, maxV - minV) };
      }
    }
    return best;
  }
  // Sutherland–Hodgman: clip a polygon by the half-plane a·x + b·y ≤ c
  function clipHalf(poly, a, b, c) {
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const P = poly[i], Q = poly[(i + 1) % poly.length];
      const fp = a * P[0] + b * P[1] - c, fq = a * Q[0] + b * Q[1] - c;
      if (fp <= 0) out.push(P);
      if ((fp < 0 && fq > 0) || (fp > 0 && fq < 0)) { const t = fp / (fp - fq); out.push([P[0] + t * (Q[0] - P[0]), P[1] + t * (Q[1] - P[1])]); }
    }
    return out;
  }
  const quantile = (sorted, q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))] : NaN);
  const median = (arr) => quantile(Float64Array.from(arr).sort(), 0.5);

  // ------------------------------------------------------------------ LAZ decoding
  let lazPromise = null;
  function lazPerf(opts) {
    if (!lazPromise) {
      const factory = (opts && opts.factory) || root.createLazPerf;
      if (!factory) return Promise.reject(new Error("LAZ-purkukirjasto (laz-perf) puuttuu."));
      lazPromise = factory(opts && opts.wasmBinary ? { wasmBinary: opts.wasmBinary } : (opts && opts.locateFile ? { locateFile: opts.locateFile } : {}));
    }
    return lazPromise;
  }
  function readHeader(buf) {
    const dv = new DataView(buf.buffer || buf, buf.byteOffset || 0);
    const sig = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
    if (sig !== "LASF") throw new Error("Tiedosto ei ole LAS/LAZ-muotoinen.");
    return {
      version: `${dv.getUint8(24)}.${dv.getUint8(25)}`,
      day: dv.getUint16(90, true), year: dv.getUint16(92, true),
      format: dv.getUint8(104) & 0x3f, recordLength: dv.getUint16(105, true),
      scale: [dv.getFloat64(131, true), dv.getFloat64(139, true), dv.getFloat64(147, true)],
      offset: [dv.getFloat64(155, true), dv.getFloat64(163, true), dv.getFloat64(171, true)],
      maxX: dv.getFloat64(179, true), minX: dv.getFloat64(187, true), maxY: dv.getFloat64(195, true), minY: dv.getFloat64(203, true),
    };
  }
  /* Decode a LAZ file and keep the points inside any of the boxes ([minE, minN, maxE, maxN], TM35).
     Returns {header, x, y, z, cls} as typed arrays. */
  async function decodeLaz(arrayBuffer, boxes, opts) {
    const bytes = new Uint8Array(arrayBuffer);
    const hdr = readHeader(bytes);
    const L = await lazPerf(opts);
    const filePtr = L._malloc(bytes.length);
    L.HEAPU8.set(bytes, filePtr);
    const laz = new L.LASZip();
    try {
      laz.open(filePtr, bytes.length);
      const count = laz.getCount(), len = laz.getPointLength(), fmt = laz.getPointFormat();
      const ptPtr = L._malloc(len);
      const [sx, sy, sz] = hdr.scale, [ox, oy, oz] = hdr.offset;
      const ib = boxes.filter((b) => b[2] >= hdr.minX && b[0] <= hdr.maxX && b[3] >= hdr.minY && b[1] <= hdr.maxY)
        .map((b) => [Math.floor((b[0] - ox) / sx), Math.floor((b[1] - oy) / sy), Math.ceil((b[2] - ox) / sx), Math.ceil((b[3] - oy) / sy)]);
      const xs = [], ys = [], zs = [], cs = [];
      const clsAt = fmt >= 6 ? 16 : 15, clsMask = fmt >= 6 ? 0xff : 0x1f;
      if (ib.length) {
        for (let i = 0; i < count; i++) {
          laz.getPoint(ptPtr);
          const dv = new DataView(L.HEAPU8.buffer, ptPtr, len);
          const X = dv.getInt32(0, true), Y = dv.getInt32(4, true);
          let hit = false;
          for (let k = 0; k < ib.length; k++) { const b = ib[k]; if (X >= b[0] && X <= b[2] && Y >= b[1] && Y <= b[3]) { hit = true; break; } }
          if (!hit) continue;
          xs.push(X * sx + ox); ys.push(Y * sy + oy); zs.push(dv.getInt32(8, true) * sz + oz); cs.push(dv.getUint8(clsAt) & clsMask);
        }
      }
      L._free(ptPtr);
      return { header: { ...hdr, count, pointFormat: fmt }, x: Float64Array.from(xs), y: Float64Array.from(ys), z: Float64Array.from(zs), cls: Uint8Array.from(cs) };
    } finally {
      laz.delete();
      L._free(filePtr);
    }
  }

  // ------------------------------------------------------------------ analysis
  const BUFFER = 12;          // m around the footprint: ground search and lidar footprint
  const INSET = 0.7;          // m inside the footprint for roof points (walls and eaves excluded)
  const H_MIN = 1.2, H_MAX = 45;
  const ROOF_CLASSES = new Set([1]);
  const NOT_ROOF = new Set([2, 7, 15, 16, 17]);
  const CELL = 2;

  function buildingBox(rings, pad) {
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    for (const r of rings) for (const p of r) { a = Math.min(a, p[0]); b = Math.min(b, p[1]); c = Math.max(c, p[0]); d = Math.max(d, p[1]); }
    return [a - pad, b - pad, c + pad, d + pad];
  }
  // Fit flat, mono-pitch and gable roofs across the main axis; returns the best model.
  function fitRoof(us, hs, width) {
    const n = us.length;
    const mean = hs.reduce((s, v) => s + v, 0) / n;
    const sst = hs.reduce((s, v) => s + (v - mean) ** 2, 0) || 1e-9;
    const lin = (xs) => {   // h = a + b·x
      let sx = 0, sy = 0, sxx = 0, sxy = 0;
      for (let i = 0; i < n; i++) { sx += xs[i]; sy += hs[i]; sxx += xs[i] * xs[i]; sxy += xs[i] * hs[i]; }
      const den = n * sxx - sx * sx;
      const b = den > 1e-9 ? (n * sxy - sx * sy) / den : 0, a = (sy - b * sx) / n;
      let sse = 0; for (let i = 0; i < n; i++) sse += (hs[i] - a - b * xs[i]) ** 2;
      return { a, b, sse };
    };
    const mono = lin(us);
    let gable = null;
    for (let k = -5; k <= 5; k++) {
      const u0 = k * 0.04 * width;     // ridge within the middle 40 % of the width
      const g = lin(us.map((u) => Math.abs(u - u0)));
      if (g.b < 0 && (!gable || g.sse < gable.sse)) gable = { r: g.a, s: -g.b, u0, sse: g.sse };
    }
    const r2m = 1 - mono.sse / sst, r2g = gable ? 1 - gable.sse / sst : -1;
    return { mean, sst, mono: { ...mono, r2: r2m }, gable: gable && { ...gable, r2: r2g } };
  }

  function analyseBuilding(b, pts, scanYear) {
    const ringsLL = outerRings(b.geometry);
    if (!ringsLL.length) return { status: "no_footprint", notes: ["Rakennuksesta on vain piste; lidar-analyysi tarvitsee pohjan."] };
    const rings = ringsLL.map((r) => r.map((p) => toTm35(p[0], p[1])));
    const area = rings.reduce((s, r) => s + ringArea(r), 0);
    const box = buildingBox(rings, BUFFER);
    const inside = (x, y) => rings.some((r) => inRing(x, y, r));
    const dist = (x, y) => Math.min(...rings.map((r) => edgeDist(x, y, r)));

    const ground = [], near = [];
    for (let i = 0; i < pts.x.length; i++) {
      const x = pts.x[i], y = pts.y[i];
      if (x < box[0] || x > box[2] || y < box[1] || y > box[3]) continue;
      const c = pts.cls[i];
      if (c === 2) { if (!inside(x, y)) ground.push(pts.z[i]); continue; }
      if (!NOT_ROOF.has(c)) near.push(i);
    }
    const notes = [];
    let z0;
    if (ground.length >= 3) z0 = median(ground);
    else {
      const all = [];
      for (const i of near) all.push(pts.z[i]);
      if (!all.length) return { status: "no_points", area_mml_m2: Math.round(area), year: scanYear, notes: ["Rakennuksen kohdalla ei ole keilauspisteitä."] };
      z0 = quantile(Float64Array.from(all).sort(), 0.02);
      notes.push("Maanpinta arvioitu matalimmista pisteistä (maapisteitä ei löytynyt).");
    }
    // roof points
    const ax = mainAxis(rings), ca = Math.cos(ax.angle), sa = Math.sin(ax.angle);
    let cx = 0, cy = 0, m = 0;
    for (const r of rings) for (const p of r) { cx += p[0]; cy += p[1]; m++; }
    cx /= m; cy /= m;
    const us = [], hs = [];
    for (const i of near) {
      const x = pts.x[i], y = pts.y[i];
      if (!ROOF_CLASSES.has(pts.cls[i]) || !inside(x, y) || dist(x, y) < INSET) continue;
      const h = pts.z[i] - z0;
      if (h < H_MIN || h > H_MAX) continue;
      us.push(-(x - cx) * sa + (y - cy) * ca);   // across the main axis
      hs.push(h);
    }
    // lidar footprint: elevated cells connected to the footprint
    const nx = Math.ceil((box[2] - box[0]) / CELL), ny = Math.ceil((box[3] - box[1]) / CELL);
    const grid = new Uint8Array(nx * ny);
    for (const i of near) {
      if (pts.cls[i] !== 1 || pts.z[i] - z0 < 2) continue;
      const gx = Math.floor((pts.x[i] - box[0]) / CELL), gy = Math.floor((pts.y[i] - box[1]) / CELL);
      if (gx >= 0 && gy >= 0 && gx < nx && gy < ny) grid[gy * nx + gx] = 1;
    }
    const morph = (src, dilate) => {
      const out = new Uint8Array(src.length);
      for (let gy = 0; gy < ny; gy++) for (let gx = 0; gx < nx; gx++) {
        let v = dilate ? 0 : 1;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = gx + dx, yy = gy + dy;
          const s = xx >= 0 && yy >= 0 && xx < nx && yy < ny ? src[yy * nx + xx] : 0;
          if (dilate && s) v = 1;
          if (!dilate && !s) v = 0;
        }
        out[gy * nx + gx] = v;
      }
      return out;
    };
    const closed = morph(morph(grid, true), false);
    const inFoot = new Uint8Array(nx * ny);
    let footCells = 0, footHit = 0;
    for (let gy = 0; gy < ny; gy++) for (let gx = 0; gx < nx; gx++) {
      if (inside(box[0] + (gx + 0.5) * CELL, box[1] + (gy + 0.5) * CELL)) { inFoot[gy * nx + gx] = 1; footCells++; if (closed[gy * nx + gx]) footHit++; }
    }
    const seen = new Uint8Array(nx * ny), stack = [];
    for (let k = 0; k < nx * ny; k++) if (inFoot[k] && closed[k]) { seen[k] = 1; stack.push(k); }
    let lidarCells = 0;
    while (stack.length) {
      const k = stack.pop(); lidarCells++;
      const gx = k % nx, gy = (k - gx) / nx;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const xx = gx + dx, yy = gy + dy;
        if (xx < 0 || yy < 0 || xx >= nx || yy >= ny) continue;
        const kk = yy * nx + xx;
        if (!seen[kk] && closed[kk]) { seen[kk] = 1; stack.push(kk); }
      }
    }
    const coverage = footCells ? footHit / footCells : 0;
    const lidarArea = lidarCells * CELL * CELL;

    const base = { area_mml_m2: Math.round(area), coverage: Math.round(coverage * 100) / 100, year: scanYear, n_roof: hs.length,
      ground_z: Math.round(z0 * 10) / 10, axis_deg: Math.round(((ax.angle * 180 / Math.PI) % 180 + 180) % 180) };
    const expected = area * 0.5;   // points at 0.5 p/m²
    if (hs.length < Math.max(6, 0.08 * expected) || coverage < 0.3) {
      notes.push("Lidar ei näe rakennusta tässä kohdassa: se voi olla purettu tai rakennettu keilauksen jälkeen, tai puusto peittää sen.");
      return { status: "not_seen", ...base, lidar_area_m2: Math.round(lidarArea), notes };
    }
    const sorted = Float64Array.from(hs).sort();
    const p10 = quantile(sorted, 0.1), p95 = quantile(sorted, 0.95), p50 = quantile(sorted, 0.5);
    const fit = fitRoof(us, hs, ax.width);
    let roof = "tasakatto", model = { type: "flat", h: p50 };
    if (p95 - p10 >= 0.8) {
      const g = fit.gable, mo = fit.mono;
      if (g && g.r2 >= 0.5 && g.r2 >= mo.r2 + 0.05) { roof = "harjakatto"; model = { type: "gable", r: g.r, s: g.s, u0: g.u0 }; }
      else if (mo.r2 >= 0.5) { roof = "pulpettikatto"; model = { type: "mono", a: mo.a, b: mo.b }; }
      else { roof = "monimuotoinen"; model = { type: "flat", h: fit.mean }; }
    }
    const roofH = (u) => (model.type === "gable" ? model.r - model.s * Math.abs(u - model.u0)
      : model.type === "mono" ? model.a + model.b * u : model.h);
    const half = ax.width / 2;
    let eave, ridge, pitch = 0;
    if (model.type === "gable") { ridge = model.r; eave = Math.max(H_MIN, model.r - model.s * half); pitch = Math.atan(model.s) * 180 / Math.PI; }  // mean of the two eaves
    else if (model.type === "mono") { const a = roofH(-half), c = roofH(half); eave = Math.min(a, c); ridge = Math.max(a, c); pitch = Math.atan(Math.abs(model.b)) * 180 / Math.PI; }
    else { eave = p10; ridge = p95; }
    // volume: modelled height over the footprint on a 1 m grid
    let vol = 0, cells = 0;
    for (let y = box[1] + 0.5; y < box[3]; y += 1) for (let x = box[0] + 0.5; x < box[2]; x += 1) {
      if (!inside(x, y)) continue;
      vol += Math.max(0, Math.min(H_MAX, roofH(-(x - cx) * sa + (y - cy) * ca))); cells++;
    }
    const meanH = cells ? vol / cells : p50;
    if (lidarArea > area * 1.2 && lidarArea - area > 20) notes.push(`Lidar-pohja (${Math.round(lidarArea)} m²) on suurempi kuin MML:n (${Math.round(area)} m²): mahdollinen laajennus, katos tai viereinen rakennus.`);
    if (lidarArea < area * 0.8) notes.push(`Lidar-pohja (${Math.round(lidarArea)} m²) on pienempi kuin MML:n (${Math.round(area)} m²): osa rakennuksesta voi olla purettu tai puuston peitossa.`);
    if (roof === "monimuotoinen") notes.push("Katon muoto ei sovi yksinkertaiseen malliin; korkeus on keskiarvo.");
    return {
      status: "ok", ...base, roof, pitch_deg: Math.round(pitch), eave_h: Math.round(eave * 10) / 10, ridge_h: Math.round(ridge * 10) / 10,
      mean_h: Math.round(meanH * 10) / 10, volume_m3: Math.round(meanH * area), lidar_area_m2: Math.round(lidarArea),
      model: { ...model, cx, cy, angle: ax.angle, width: ax.width, length: ax.length }, notes,
    };
  }

  /* Strips for drawing the roof shape in 3D: polygons (lon/lat) with heights, parallel to the ridge. */
  function roofStrips(b, lidar, n) {
    if (!lidar || lidar.status !== "ok") return null;
    const md = lidar.model;
    const rings = outerRings(b.geometry).map((r) => r.map((p) => toTm35(p[0], p[1])));
    const ca = Math.cos(md.angle), sa = Math.sin(md.angle);
    const roofH = (u) => (md.type === "gable" ? md.r - md.s * Math.abs(u - md.u0) : md.type === "mono" ? md.a + md.b * u : md.h);
    let minU = Infinity, maxU = -Infinity;
    for (const r of rings) for (const p of r) { const u = -(p[0] - md.cx) * sa + (p[1] - md.cy) * ca; minU = Math.min(minU, u); maxU = Math.max(maxU, u); }
    const steps = md.type === "flat" ? 1 : n || 10, out = [];
    for (let k = 0; k < steps; k++) {
      const u1 = minU + (maxU - minU) * k / steps, u2 = minU + (maxU - minU) * (k + 1) / steps;
      const h = Math.max(H_MIN, Math.min(H_MAX, roofH((u1 + u2) / 2)));
      for (const r of rings) {
        const poly = clipStrip(r.slice(0, -1), md, u1, u2);
        if (poly.length >= 3) out.push({ ring: poly.concat([poly[0]]).map((p) => fromTm35(p[0], p[1])), h });
      }
    }
    return out;
  }
  function clipStrip(poly, md, u1, u2) {
    const ca = Math.cos(md.angle), sa = Math.sin(md.angle);
    // u(x, y) = −sa·x + ca·y + k,  k = sa·cx − ca·cy
    const k = sa * md.cx - ca * md.cy;
    let p = clipHalf(poly, sa, -ca, k - u1);     // u ≥ u1  ⇔  sa·x − ca·y ≤ k − u1
    p = clipHalf(p, -sa, ca, u2 - k);            // u ≤ u2  ⇔ −sa·x + ca·y ≤ u2 − k
    return p;
  }

  // ------------------------------------------------------------------ data sources
  const MML_PROC = "https://avoin-paikkatieto.maanmittauslaitos.fi/tiedostopalvelu/ogcproc/v1";
  const PROCESS = "laserkeilausaineisto_05_karttalehti";

  // Pick the LAZ files from a results document; the newest file per sheet if several years are offered.
  function lazFiles(results) {
    const found = [];
    const walk = (o) => {
      if (!o || typeof o !== "object") return;
      if (Array.isArray(o)) { o.forEach(walk); return; }
      const path = o.path || o.href || o.url;
      if (typeof path === "string" && (/\.laz(\?|$)/i.test(path) || /laz/i.test(String(o.format || o.type || "")))) {
        const sheet = o.mapSheetNumber || o.mapSheet || (path.match(/([K-X]\d{4}[A-H]\d)/) || [])[1] || "";
        const year = +(String(o.year || o.productionYear || path).match(/(20\d\d)/) || [])[1] || 0;
        found.push({ path, sheet, year, length: +o.length || +o.size || null, name: path.split("/").pop().split("?")[0] });
      }
      for (const k in o) if (k !== "path") walk(o[k]);
    };
    walk(results);
    const best = {};
    for (const f of found) { const k = f.sheet || f.name; if (!best[k] || f.year > best[k].year) best[k] = f; }
    return Object.values(best);
  }
  // Inputs for the process: map sheets and LAZ, plus the newest value of any other required choice.
  function processInputs(desc, sheets) {
    const inputs = { mapSheetInput: sheets };
    const defs = (desc && desc.inputs) || {};
    const list = Array.isArray(defs) ? defs : Object.entries(defs).map(([id, d]) => ({ id, ...d }));
    for (const d of list) {
      const id = d.id;
      if (!id || id === "mapSheetInput") continue;
      const sch = d.schema || {};
      const en = sch.enum || (sch.items && sch.items.enum);
      if (id === "fileFormatInput") { inputs[id] = en && !en.includes("LAZ") ? en[0] : "LAZ"; continue; }
      const required = (d.minOccurs == null ? 1 : d.minOccurs) > 0;
      if (required && en && en.length) inputs[id] = sch.type === "array" ? [en[en.length - 1]] : en[en.length - 1];
      else if (required && sch.default != null) inputs[id] = sch.default;
    }
    if (!("fileFormatInput" in inputs)) inputs.fileFormatInput = "LAZ";
    return inputs;
  }
  function withKey(url, key) { return key ? url + (url.includes("?") ? "&" : "?") + "api-key=" + encodeURIComponent(key) : url; }
  async function getJson(url, opts) {
    const r = await fetch(url, opts);
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      const e = new Error(r.status === 401 || r.status === 403 ? "MML hylkäsi API-avaimen (401/403)." : `MML:n tiedostopalvelu vastasi ${r.status}. ${t.slice(0, 160)}`);
      e.status = r.status; throw e;
    }
    return r.json();
  }
  // Direct use from the browser with the viewer's own key (single-file version).
  function directSource(getKey) {
    return {
      async submit(sheets) {
        const key = getKey();
        if (!key) throw new Error("MML-rajapinta-avain puuttuu.");
        const desc = await getJson(withKey(`${MML_PROC}/processes/${PROCESS}`, key)).catch(() => null);
        const body = { id: PROCESS, inputs: processInputs(desc, sheets) };
        const res = await getJson(withKey(`${MML_PROC}/processes/${PROCESS}/execution`, key),
          { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        return res.jobID || res.jobId || res.id;
      },
      async status(job) {
        const key = getKey();
        const s = await getJson(withKey(`${MML_PROC}/jobs/${encodeURIComponent(job)}`, key));
        const out = { status: s.status, progress: s.progress, message: s.message };
        if (s.status === "successful") out.files = lazFiles(await getJson(withKey(`${MML_PROC}/jobs/${encodeURIComponent(job)}/results`, key)));
        return out;
      },
      fileUrl(f) { return withKey(f.path, getKey()); },
    };
  }
  // Through the Python server, which holds the key (server version).
  function serverSource() {
    return {
      async submit(sheets) { return (await getJson("/api/lidar/job", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sheets }) })).job; },
      async status(job) { return getJson(`/api/lidar/job/${encodeURIComponent(job)}`); },
      fileUrl(f) { return `/api/lidar/file?url=${encodeURIComponent(f.path)}`; },
    };
  }
  async function download(url, onProgress) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Laserkeilaustiedoston lataus epäonnistui (${r.status}).`);
    const total = +r.headers.get("content-length") || 0;
    if (!r.body || !r.body.getReader) return r.arrayBuffer();
    const reader = r.body.getReader(), parts = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value); got += value.length;
      if (onProgress) onProgress(got, total);
    }
    const out = new Uint8Array(got);
    let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
    return out.buffer;
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* Whole run for the selected buildings: sheets → job → LAZ → analysis.
     onStep(text) reports progress; returns {results: {id: lidar}, sheets, files}. */
  async function run(buildings, source, onStep, opts) {
    const say = onStep || (() => {});
    const withShape = buildings.filter((b) => outerRings(b.geometry).length);
    if (!withShape.length) throw new Error("Valituilla rakennuksilla ei ole pohjaa (vain pisteitä).");
    const boxes = withShape.map((b) => buildingBox(outerRings(b.geometry).map((r) => r.map((p) => toTm35(p[0], p[1]))), BUFFER));
    const env = boxes.reduce((a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]);
    const sheets = sheetsForBox(...env);
    if (sheets.length > 6) throw new Error(`Rakennukset ovat ${sheets.length} karttalehden alueella; valitse lähekkäiset rakennukset (enintään 6 lehteä).`);
    say(`Tilataan laserkeilausaineisto (${sheets.join(", ")})…`);
    const job = await source.submit(sheets);
    let st;
    for (let i = 0; ; i++) {
      st = await source.status(job);
      if (st.status === "successful") break;
      if (st.status === "failed" || st.status === "dismissed") throw new Error(`MML:n tiedostopalvelu ei toimittanut aineistoa (${st.status}${st.message ? ": " + st.message : ""}).`);
      if (i > 150) throw new Error("Aineiston valmistelu kesti yli viisi minuuttia; yritä myöhemmin uudelleen.");
      say(`MML valmistelee aineistoa${st.progress != null ? ` (${st.progress} %)` : ""}…`);
      await sleep(i < 5 ? 1000 : 2000);
    }
    const files = st.files || [];
    if (!files.length) throw new Error("Alueelta ei ole avointa laserkeilausaineistoa (0,5 p). Kattavuus laajenee vuosittain.");
    const all = { x: [], y: [], z: [], cls: [] };
    let year = 0;
    for (let k = 0; k < files.length; k++) {
      const f = files[k];
      const buf = await download(source.fileUrl(f), (got, total) =>
        say(`Ladataan ${f.sheet || f.name} (${k + 1}/${files.length}): ${(got / 1e6).toFixed(1)}${total ? ` / ${(total / 1e6).toFixed(1)}` : ""} Mt…`));
      say(`Puretaan ${f.sheet || f.name}…`);
      const pts = await decodeLaz(buf, boxes, opts);
      year = Math.max(year, pts.header.year || f.year || 0);
      for (const key of ["x", "y", "z", "cls"]) all[key].push(pts[key]);
    }
    const cat = (arrs, T) => { const n = arrs.reduce((s, a) => s + a.length, 0), o = new T(n); let p = 0; for (const a of arrs) { o.set(a, p); p += a.length; } return o; };
    const pts = { x: cat(all.x, Float64Array), y: cat(all.y, Float64Array), z: cat(all.z, Float64Array), cls: cat(all.cls, Uint8Array) };
    say("Lasketaan korkeudet ja kattomuodot…");
    const results = {};
    for (const b of buildings) results[b.id] = analyseBuilding(b, pts, year || null);
    return { results, sheets, files: files.map((f) => f.name), year };
  }

  const RHL = { toTm35, fromTm35, sheetName, sheetsForBox, decodeLaz, readHeader, analyseBuilding, roofStrips, lazFiles, processInputs,
    directSource, serverSource, run, lazPerf, PROCESS, MML_PROC };
  if (typeof module === "object" && module.exports) module.exports = RHL;
  else root.RHL = RHL;
})(typeof self !== "undefined" ? self : this);
