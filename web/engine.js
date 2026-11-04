/* Rakennushaku engine: the same logic as the Python package, for the browser.
   Time base: 8 760 h fixed EET (UTC+2), 29.2. removed - as in Maatilan hybridienergialaskuri. */
(function (root) {
  "use strict";
  const HOURS = 8760, H = 3600e3, EET = 2 * H;
  const RH = {};
  RH.HOURS = HOURS;

  // ------------------------------------------------------------------ time base
  const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  function hourIndex(utcMs, year) {
    const e = new Date(utcMs + EET);
    if (e.getUTCFullYear() !== year) return null;
    const m = e.getUTCMonth(), d = e.getUTCDate();
    if (m === 1 && d === 29) return null;
    let doy = Math.round((Date.UTC(year, m, d) - Date.UTC(year, 0, 1)) / 864e5);
    if (isLeap(year) && m > 1) doy -= 1;
    return doy * 24 + e.getUTCHours();
  }
  function hourStartsUtc(year) {
    const out = [];
    for (let t = Date.UTC(year, 0, 1) - EET, end = Date.UTC(year + 1, 0, 1) - EET; t < end; t += H) {
      const e = new Date(t + EET);
      if (!(e.getUTCMonth() === 1 && e.getUTCDate() === 29)) out.push(t);
    }
    return out;
  }
  const _calCache = {};
  function calendar(year) {
    if (_calCache[year]) return _calCache[year];
    const month = new Int8Array(HOURS), day = new Int8Array(HOURS), hour = new Int8Array(HOURS), weekday = new Int8Array(HOURS);
    hourStartsUtc(year).forEach((t, i) => {
      const e = new Date(t + EET);
      month[i] = e.getUTCMonth() + 1; day[i] = e.getUTCDate(); hour[i] = e.getUTCHours(); weekday[i] = (e.getUTCDay() + 6) % 7;
    });
    return (_calCache[year] = { month, day, hour, weekday });
  }
  function monthlySum(s, year) {
    const m = calendar(year).month, out = new Array(12).fill(0);
    for (let i = 0; i < HOURS; i++) if (s[i] != null && !Number.isNaN(s[i])) out[m[i] - 1] += s[i];
    return out;
  }
  function fillGaps(series, maxGap = 6) {
    const s = Float64Array.from(series, (v) => (v == null ? NaN : v));
    let nInterp = 0;
    for (let i = 0; i < s.length;) {
      if (!Number.isNaN(s[i])) { i++; continue; }
      let j = i;
      while (j < s.length && Number.isNaN(s[j])) j++;
      const gap = j - i;
      if (gap <= maxGap && i > 0 && j < s.length) {
        for (let k = 0; k < gap; k++) s[i + k] = s[i - 1] + (s[j] - s[i - 1]) * (k + 1) / (gap + 1);
        nInterp += gap;
      } else if (gap <= maxGap && (i > 0 || j < s.length)) {
        for (let k = i; k < j; k++) s[k] = i === 0 ? s[j] : s[i - 1];
        nInterp += gap;
      }
      i = j;
    }
    let still = 0;
    for (const v of s) if (Number.isNaN(v)) still++;
    return { values: s, interpolated: nInterp, missing: still };
  }
  Object.assign(RH, { hourIndex, hourStartsUtc, calendar, monthlySum, fillGaps });

  // ------------------------------------------------------------------ Finnish local time (EU summer time)
  function lastSunday(y, month) { // month 0-based; returns day of month
    const d = new Date(Date.UTC(y, month + 1, 0));
    return d.getUTCDate() - d.getUTCDay();
  }
  function inDST(utcMs) {
    const y = new Date(utcMs).getUTCFullYear();
    const start = Date.UTC(y, 2, lastSunday(y, 2), 1), end = Date.UTC(y, 9, lastSunday(y, 9), 1);
    return utcMs >= start && utcMs < end;
  }
  function localToUtc(y, mo, d, h, mi, s, fold) {
    const naive = Date.UTC(y, mo, d, h, mi, s || 0);
    const u3 = naive - 3 * H, u2 = naive - 2 * H;
    const ok3 = inDST(u3), ok2 = !inDST(u2);
    if (ok3 && ok2) return fold ? u2 : u3; // repeated autumn hour
    if (ok3) return u3;
    return u2;
  }
  RH.localToUtc = localToUtc;

  // ------------------------------------------------------------------ series parser
  const DT_ISO = /^\d{4}-\d{2}-\d{2}[T ]\d{1,2}:\d{2}/, DT_FI = /^\d{1,2}\.\d{1,2}\.\d{4}\s+\d{1,2}[:.]\d{2}/;
  const VALUE_HINTS = /määrä|maara|kulutus|kwh|wh|energia|value|amount|lämpötila|lampotila|temp|°c|arvo/i;
  const looksDt = (s) => DT_ISO.test(s.trim()) || DT_FI.test(s.trim());
  function toFloat(s) {
    if (s == null) return null;
    s = String(s).trim().replace(/[  ]/g, "");
    if (!s || /^(nan|-|null|none)$/i.test(s)) return null;
    if (s.includes(",") && s.includes(".")) s = s.lastIndexOf(",") > s.lastIndexOf(".") ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
    else s = s.replace(",", ".");
    const v = Number(s);
    return Number.isFinite(v) ? v : null;
  }
  function splitCsv(line, delim) {
    const out = []; let cur = "", q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
      else if (c === '"') q = true;
      else if (c === delim) { out.push(cur); cur = ""; }
      else cur += c;
    }
    out.push(cur);
    return out;
  }
  function parseDt(s, naiveTz, state) {
    s = s.trim();
    let y, mo, d, h, mi, se = 0;
    let m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?/);
    if (m) { d = +m[1]; mo = +m[2] - 1; y = +m[3]; h = +m[4]; mi = +m[5]; se = +(m[6] || 0); }
    else {
      m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/);
      if (!m) throw new Error("bad date");
      y = +m[1]; mo = +m[2] - 1; d = +m[3]; h = +m[4]; mi = +m[5]; se = +(m[6] || 0);
      if (m[7]) {
        if (m[7] === "Z") return Date.UTC(y, mo, d, h, mi, se);
        const sign = m[7][0] === "-" ? -1 : 1, hh = +m[7].slice(1, 3), mm = +m[7].slice(-2);
        return Date.UTC(y, mo, d, h, mi, se) - sign * (hh * H + mm * 60e3);
      }
    }
    const naive = Date.UTC(y, mo, d, h, mi, se);
    if (naiveTz === "utc") return naive;
    if (naiveTz === "eet") return naive - EET;
    const fold = state.maxLocal != null && naive <= state.maxLocal ? 1 : 0;
    state.maxLocal = state.maxLocal == null ? naive : Math.max(state.maxLocal, naive);
    return localToUtc(y, mo, d, h, mi, se, fold);
  }

  function parseSeries(text, opt = {}) {
    const kind = opt.kind || "energy", naiveTz = opt.naiveTz || "local", stampAt = opt.stampAt || "start";
    let unit = opt.unit || "auto";
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 3) throw new Error("Tiedostossa on liian vähän rivejä.");
    const head = lines.slice(0, 20).join("\n");
    const cnt = (c) => head.split(c).length - 1;
    const delim = cnt(";") >= 5 ? ";" : cnt("\t") >= 5 ? "\t" : ",";
    const rows = lines.map((l) => splitCsv(l, delim));
    const first = rows[0];
    const hasHeader = !first.some(looksDt) && first.filter((c) => toFloat(c) != null).length < first.length / 2;
    const data = hasHeader ? rows.slice(1) : rows;
    const ncol = Math.max(...data.map((r) => r.length));
    const header = (hasHeader ? first.map((c) => c.trim()) : []);
    for (let i = header.length; i < ncol; i++) header.push(`sarake ${i + 1}`);
    const sample = data.slice(0, 200);
    let ti = opt.timestampColumn != null ? header.indexOf(opt.timestampColumn) : -1;
    if (ti < 0) {
      const scores = header.map((_, i) => sample.filter((r) => i < r.length && looksDt(r[i])).length);
      ti = scores.indexOf(Math.max(...scores));
      if (scores[ti] < sample.length * 0.8) throw new Error("Aikaleimasaraketta ei tunnistettu.");
    }
    let vi = opt.valueColumn != null ? header.indexOf(opt.valueColumn) : -1;
    if (vi < 0) {
      const numeric = header.map((_, i) => i).filter((i) => i !== ti && sample.filter((r) => i < r.length && toFloat(r[i]) != null).length >= sample.length * 0.6);
      if (!numeric.length) throw new Error("Numeerista arvosaraketta ei löytynyt.");
      const hinted = numeric.filter((i) => VALUE_HINTS.test(header[i]));
      const isId = (i) => { const v = new Set(sample.map((r) => (r[i] || "").trim())); return v.size === 1 && [...v][0].length > 10; };
      let cands = (hinted.length ? hinted : numeric).filter((i) => !isId(i));
      if (!cands.length) cands = numeric;
      vi = hinted.length ? cands[0] : cands[cands.length - 1];
    }
    const notes = [], stamps = [], vals = [], st = {};
    for (const r of data) {
      if (ti >= r.length || !looksDt(r[ti])) continue;
      let t;
      try { t = parseDt(r[ti], naiveTz, st); } catch (_) { continue; }
      stamps.push(t);
      vals.push(vi < r.length ? toFloat(r[vi]) : null);
    }
    if (stamps.length < 3) throw new Error("Aikaleimoja ei saatu luettua.");
    const diffs = [];
    for (let i = 1; i < Math.min(stamps.length, 201); i++) { const dm = (stamps[i] - stamps[i - 1]) / 60e3; if (dm > 0) diffs.push(dm); }
    diffs.sort((a, b) => a - b);
    const res = diffs.length ? Math.round(diffs[Math.floor(diffs.length / 2)]) : 60;
    if (res > 60) throw new Error(`Aika-askel ${res} min on liian pitkä tuntisarjaksi. Käytä kuukausi- tai vuosisummaa.`);
    if (![5, 10, 15, 30, 60].includes(res)) notes.push(`Epätavallinen aika-askel ${res} min.`);
    if (stampAt === "end") for (let i = 0; i < stamps.length; i++) stamps[i] -= res * 60e3;
    let scale = 1;
    const hname = header[vi].toLowerCase();
    if (kind === "energy") {
      if (unit === "auto") unit = hname.includes("mwh") ? "MWh" : /(^|[^km])wh/.test(hname) ? "Wh" : "kWh";
      scale = { Wh: 0.001, kWh: 1, MWh: 1000 }[unit];
    } else unit = "°C";
    let year = opt.year;
    if (!year) {
      const c = {};
      stamps.forEach((t) => { const y = new Date(t + EET).getUTCFullYear(); c[y] = (c[y] || 0) + 1; });
      year = +Object.entries(c).sort((a, b) => b[1] - a[1])[0][0];
    }
    const perHour = [5, 10, 15, 30, 60].includes(res) ? 60 / res : 1;
    const acc = new Float64Array(HOURS), n = new Int32Array(HOURS);
    let used = 0;
    stamps.forEach((t, i) => {
      if (vals[i] == null) return;
      const idx = hourIndex(t, year);
      if (idx == null) return;
      acc[idx] += vals[i] * scale; n[idx]++; used++;
    });
    const out = new Array(HOURS).fill(null);
    let complete = 0, partial = 0, dup = 0;
    for (let i = 0; i < HOURS; i++) {
      if (!n[i]) continue;
      if (n[i] > perHour) dup++;
      if (kind === "energy") {
        if (n[i] >= perHour) { out[i] = acc[i] * perHour / n[i]; complete++; } else partial++;
      } else { out[i] = acc[i] / n[i]; complete++; }
    }
    if (partial) notes.push(`${partial} tuntia oli vajaita (puuttuvia varttiarvoja); ne käsitellään puuttuvina.`);
    if (dup) notes.push(`${dup} tunnilla oli tavallista enemmän rivejä; arvot skaalattiin tunnin tasolle.`);
    const r = { values: out, year, kind, resolution_min: res, rows_read: data.length, rows_used: used, hours_complete: complete,
      hours_missing: HOURS - complete, timestamp_column: header[ti], value_column: header[vi], unit, notes };
    if (kind === "temperature") {
      const f = fillGaps(out, 6);
      r.values = Array.from(f.values, (v) => (Number.isNaN(v) ? null : Math.round(v * 100) / 100));
      r.interpolated = f.interpolated; r.missing = f.missing;
    } else r.total_kwh = out.reduce((a, v) => a + (v || 0), 0);
    return r;
  }
  RH.parseSeries = parseSeries;

  // ------------------------------------------------------------------ geometry helpers (lon/lat, local metres)
  function rings(g) {
    if (g.type === "Polygon") return [g.coordinates];
    if (g.type === "MultiPolygon") return g.coordinates;
    return [];
  }
  function metric(lat0) { const kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110574; return (p) => [p[0] * kx, p[1] * ky]; }
  function ringArea(r, f) {
    let a = 0;
    for (let i = 0, k = r.length - 1; i < r.length; k = i++) { const p = f(r[k]), q = f(r[i]); a += p[0] * q[1] - q[0] * p[1]; }
    return Math.abs(a / 2);
  }
  function geomLat(g) {
    if (g.type === "Point") return g.coordinates[1];
    if (g.type === "MultiPoint") return g.coordinates[0][1];
    return rings(g)[0][0][0][1];
  }
  function areaM2(g) {
    const f = metric(geomLat(g));
    return rings(g).reduce((s, poly) => s + ringArea(poly[0], f) - poly.slice(1).reduce((t, h) => t + ringArea(h, f), 0), 0);
  }
  function centroid(g) {
    if (g.type === "Point") return g.coordinates;
    if (g.type === "MultiPoint") return g.coordinates[0];
    const f = metric(geomLat(g));
    let A = 0, cx = 0, cy = 0;
    for (const poly of rings(g)) {
      const r = poly[0];
      for (let i = 0, k = r.length - 1; i < r.length; k = i++) {
        const cr = r[k][0] * r[i][1] - r[i][0] * r[k][1];
        A += cr; cx += (r[k][0] + r[i][0]) * cr; cy += (r[k][1] + r[i][1]) * cr;
      }
    }
    if (Math.abs(A) < 1e-14) return rings(g)[0][0][0];
    return [cx / (3 * A), cy / (3 * A)];
  }
  function inRing(pt, ring) {
    let c = false;
    for (let i = 0, k = ring.length - 1; i < ring.length; k = i++) {
      const [xi, yi] = ring[i], [xk, yk] = ring[k];
      if ((yi > pt[1]) !== (yk > pt[1]) && pt[0] < (xk - xi) * (pt[1] - yi) / (yk - yi) + xi) c = !c;
    }
    return c;
  }
  function contains(g, pt) {
    return rings(g).some((poly) => inRing(pt, poly[0]) && !poly.slice(1).some((h) => inRing(pt, h)));
  }
  function distToBoundaryM(g, pt) {
    const f = metric(pt[1]), p = f(pt);
    let best = Infinity;
    for (const poly of rings(g)) for (const r of poly) for (let i = 1; i < r.length; i++) {
      const a = f(r[i - 1]), b = f(r[i]);
      const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
      const t = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)) : 0;
      best = Math.min(best, Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy));
    }
    return best;
  }
  function bounds(g) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const add = (c) => { x0 = Math.min(x0, c[0]); y0 = Math.min(y0, c[1]); x1 = Math.max(x1, c[0]); y1 = Math.max(y1, c[1]); };
    if (g.type === "Point") add(g.coordinates); else rings(g).forEach((p) => p.forEach((r) => r.forEach(add)));
    return [x0, y0, x1, y1];
  }
  Object.assign(RH, { areaM2, centroid, contains, distToBoundaryM, bounds });

  // ------------------------------------------------------------------ MML
  RH.MML_BASE = "https://avoin-paikkatieto.maanmittauslaitos.fi";
  RH.WMTS = "https://avoin-karttakuva.maanmittauslaitos.fi/avoin/wmts";
  const CLASS_GROUPS = {
    4221: ["Asuinrakennus", "asuin"], 4222: ["Liike- tai julkinen rakennus", "toimisto"], 4223: ["Lomarakennus", "muu"],
    4224: ["Teollinen rakennus", "korjaamo"], 4225: ["Kirkollinen rakennus", "muu"],
    4226: ["Maatalous- tai varastorakennus", "tuotanto"], 4227: ["Muu rakennus", "muu"],
  };
  RH.ATTR = {
    mml: "Sisältää Maanmittauslaitoksen Maastotietokannan ja kiinteistörekisterikartan aineistoa (CC BY 4.0).",
    fmi: "Ilmatieteen laitos, avoin data (CC BY 4.0)",
    open_meteo: "Open-Meteo.com, ERA5-uudelleenanalyysi (CC BY 4.0)",
  };
  class HttpError extends Error { constructor(msg, status) { super(msg); this.status = status; } }
  RH.HttpError = HttpError;

  async function getJson(url, what) {
    let r;
    try { r = await fetch(url); } catch (e) { throw new HttpError(`${what}: rajapintaan ei saatu yhteyttä.`, 0); }
    if (r.status === 401 || r.status === 403) throw new HttpError(`${what}: rajapinta hylkäsi pyynnön (${r.status}). Tarkista MML-avain.`, r.status);
    if (!r.ok) throw new HttpError(`${what}: rajapinta vastasi virheellä ${r.status}.`, r.status);
    return r.json();
  }
  async function getFeatures(url, params, what) {
    const feats = [];
    let offset = 0;
    const limit = params.limit || 1000;
    for (let guard = 0; guard < 50; guard++) {
      const q = new URLSearchParams({ ...params, ...(offset ? { offset } : {}) });
      const j = await getJson(`${url}?${q}`, what);
      const page = j.features || [];
      feats.push(...page);
      if (page.length < limit) break;
      offset += page.length;
    }
    return feats;
  }
  function needKey(key) { if (!key) throw new HttpError("MML-rajapinta-avain puuttuu. Lisää se yläpalkin kenttään.", 401); }

  function normaliseKt(t) {
    t = String(t).trim().replace(/\s/g, "");
    if (t.includes("-")) {
      const p = t.split("-");
      if (p.length !== 4 || !p.every((x) => /^\d+$/.test(x))) throw new HttpError("Kiinteistötunnus muodossa KKK-RRR-YYYY-XXXX tai 14 numeroa.", 400);
      return p[0].padStart(3, "0") + p[1].padStart(3, "0") + p[2].padStart(4, "0") + p[3].padStart(4, "0");
    }
    if (/^\d{14}$/.test(t)) return t;
    throw new HttpError("Kiinteistötunnus muodossa KKK-RRR-YYYY-XXXX tai 14 numeroa.", 400);
  }
  const displayKt = (n) => `${+n.slice(0, 3)}-${+n.slice(3, 6)}-${+n.slice(6, 10)}-${+n.slice(10, 14)}`;
  RH.normaliseKt = normaliseKt; RH.displayKt = displayKt;
  RH.looksLikeKt = (s) => /^\s*\d{1,3}-\d{1,3}-\d{1,4}-\d{1,4}\s*$/.test(s) || /^\s*\d{14}\s*$/.test(s);

  const PROPERTY_URL = () => `${RH.MML_BASE}/kiinteisto-avoin/simple-features/v3/collections/PalstanSijaintitiedot/items`;
  const BUILDING_URL = () => `${RH.MML_BASE}/maastotiedot/features/v1/collections/rakennus/items`;

  RH.fetchProperty = async function (kt, key) {
    needKey(key);
    const num = normaliseKt(kt);
    const feats = await getFeatures(PROPERTY_URL(), { kiinteistotunnus: num, limit: 100, "api-key": key }, "Kiinteistöhaku");
    if (!feats.length) throw new HttpError(`Kiinteistöä ${displayKt(num)} ei löytynyt.`, 404);
    const polys = [];
    feats.forEach((f) => rings(f.geometry).forEach((p) => polys.push(p)));
    const geometry = polys.length === 1 ? { type: "Polygon", coordinates: polys[0] } : { type: "MultiPolygon", coordinates: polys };
    return { kiinteistotunnus: num, display: displayKt(num), area_ha: Math.round(areaM2(geometry) / 100) / 100, parts: feats.length, geometry };
  };
  RH.propertyAt = async function (lon, lat, key) {
    needKey(key);
    const d = 0.0008;
    const feats = await getFeatures(PROPERTY_URL(), { bbox: [lon - d, lat - d, lon + d, lat + d].join(","), limit: 100, "api-key": key }, "Kiinteistöhaku");
    const hit = feats.find((f) => contains(f.geometry, [lon, lat]));
    if (!hit || !hit.properties || !hit.properties.kiinteistotunnus) throw new HttpError("Pisteestä ei löytynyt kiinteistöä.", 404);
    return RH.fetchProperty(String(hit.properties.kiinteistotunnus), key);
  };
  RH.geocode = async function (text, key) {
    needKey(key);
    const q = new URLSearchParams({ text, sources: "addresses", crs: "EPSG:4326", size: 5, lang: "fin", "api-key": key });
    const j = await getJson(`${RH.MML_BASE}/geocoding/v2/pelias/search?${q}`, "Osoitehaku");
    return (j.features || []).map((f) => ({ label: f.properties.label, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] }));
  };

  function buildingRecord(f) {
    const p = f.properties || {};
    const kl = parseInt(p.kohdeluokka || 0, 10);
    const krs = p.kerrosluku == null || p.kerrosluku === "" ? null : parseInt(p.kerrosluku, 10);
    const grp = CLASS_GROUPS[Math.floor(kl / 10)] || [`Rakennus (${kl})`, "muu"];
    const isPoint = f.geometry.type === "Point" || f.geometry.type === "MultiPoint";
    return {
      mtk_id: String(p.mtk_id), kohdeluokka: kl, class_label: grp[0], default_use: grp[1], kerrosluku: krs,
      floors: krs && krs > 0 ? krs : (kl % 10 === 2 ? 3 : 1), is_point: isPoint,
      footprint_m2: isPoint ? null : Math.round(areaM2(f.geometry) * 10) / 10, alkupvm: p.alkupvm || null, geometry: f.geometry,
    };
  }
  RH.buildingsForArea = async function (area, key, bufferM = 60) {
    needKey(key);
    const [x0, y0, x1, y1] = bounds(area);
    const lat0 = (y0 + y1) / 2, dlat = bufferM / 110574, dlon = bufferM / (111320 * Math.cos(lat0 * Math.PI / 180));
    const bbox = [x0 - dlon, y0 - dlat, x1 + dlon, y1 + dlat].map((v) => v.toFixed(6)).join(",");
    const feats = await getFeatures(BUILDING_URL(), { bbox, limit: 1000, "api-key": key }, "Rakennushaku");
    const seen = new Set(), out = [];
    for (const f of feats) {
      if (!f.properties || f.properties.mtk_id == null || seen.has(String(f.properties.mtk_id))) continue;
      seen.add(String(f.properties.mtk_id));
      const b = buildingRecord(f);
      // on the property when its centroid lies inside or within 5 m of the boundary
      // (MTK footprints and cadastral boundaries do not line up exactly)
      const c = centroid(b.geometry);
      b.on_property = contains(area, c) || distToBoundaryM(area, c) <= 5;
      out.push(b);
    }
    out.sort((a, b) => (a.on_property === b.on_property ? (b.footprint_m2 || 0) - (a.footprint_m2 || 0) : a.on_property ? -1 : 1));
    return out;
  };
  RH.circle = function (lat, lon, r) {
    const kx = 111320 * Math.cos(lat * Math.PI / 180), ring = [];
    for (let i = 0; i <= 32; i++) { const a = 2 * Math.PI * i / 32; ring.push([lon + r * Math.cos(a) / kx, lat + r * Math.sin(a) / 110574]); }
    return { type: "Polygon", coordinates: [ring] };
  };

  // ------------------------------------------------------------------ weather
  RH.FMI_WFS = "https://opendata.fmi.fi/wfs";
  RH.OPEN_METEO = "https://archive-api.open-meteo.com/v1/archive";
  const memo = new Map();
  async function getText(url, what) {
    if (memo.has(url)) return memo.get(url);
    let r;
    try { r = await fetch(url); } catch (e) { throw new HttpError(`${what}: rajapintaan ei saatu yhteyttä.`, 0); }
    if (!r.ok) throw new HttpError(`${what}: rajapinta vastasi virheellä ${r.status}.`, r.status);
    const t = await r.text();
    memo.set(url, t);
    return t;
  }
  function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371, p1 = lat1 * Math.PI / 180, p2 = lat2 * Math.PI / 180, dp = p2 - p1, dl = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }
  RH.haversineKm = haversineKm;
  const byName = (el, n) => el.getElementsByTagNameNS("*", n);
  RH.parseFmiStations = function (xml) {
    const doc = new DOMParser().parseFromString(xml, "text/xml");
    const out = [];
    for (const f of byName(doc, "EnvironmentalMonitoringFacility")) {
      const st = { fmisid: null, name: null, lat: null, lon: null, begin: null, end: null };
      for (const e of byName(f, "identifier")) if ((e.getAttribute("codeSpace") || "").includes("fmisid")) { st.fmisid = +e.textContent; break; }
      for (const e of byName(f, "name")) { const cs = e.getAttribute("codeSpace") || ""; if (cs.endsWith("/name") || !cs) { st.name = e.textContent.trim(); break; } }
      const pos = byName(f, "pos")[0];
      if (pos) { const [a, b] = pos.textContent.trim().split(/\s+/).map(Number); st.lat = a; st.lon = b; }
      const bp = byName(f, "beginPosition")[0], ep = byName(f, "endPosition")[0];
      if (bp) st.begin = bp.textContent.slice(0, 10) || null;
      if (ep) st.end = ep.textContent.slice(0, 10) || ep.getAttribute("indeterminatePosition");
      if (st.fmisid && st.lat != null) out.push(st);
    }
    return out;
  };
  let stationCache = null;
  RH.fmiStations = async function () {
    if (stationCache) return stationCache;
    try {
      const c = JSON.parse(localStorage.getItem("rakennushaku.fmiStations") || "null");
      if (c && Date.now() - c.t < 30 * 864e5) return (stationCache = c.s);
    } catch (_) { /* storage unavailable */ }
    const q = new URLSearchParams({ service: "WFS", version: "2.0.0", request: "getFeature", storedquery_id: "fmi::ef::stations", networkid: "121" });
    const s = RH.parseFmiStations(await getText(`${RH.FMI_WFS}?${q}`, "FMI:n asemahaku"));
    try { localStorage.setItem("rakennushaku.fmiStations", JSON.stringify({ t: Date.now(), s })); } catch (_) { /* ignore */ }
    return (stationCache = s);
  };
  RH.nearestStations = async function (lat, lon, year, n = 6) {
    const out = [];
    for (const st of await RH.fmiStations()) {
      if (st.begin && +st.begin.slice(0, 4) > year) continue;
      if (st.end && /^\d{4}/.test(st.end) && +st.end.slice(0, 4) < year) continue;
      out.push({ ...st, distance_km: Math.round(haversineKm(lat, lon, st.lat, st.lon) * 10) / 10 });
    }
    return out.sort((a, b) => a.distance_km - b.distance_km).slice(0, n);
  };
  RH.parseFmiSimple = function (xml) {
    const doc = new DOMParser().parseFromString(xml, "text/xml");
    const ex = byName(doc, "ExceptionText")[0];
    if (ex) throw new HttpError("FMI: " + ex.textContent, 400);
    const out = [];
    for (const e of byName(doc, "BsWfsElement")) {
      const t = Date.parse(byName(e, "Time")[0].textContent);
      const v = parseFloat(byName(e, "ParameterValue")[0].textContent);
      out.push([t, Number.isNaN(v) ? null : v]);
    }
    return out;
  };
  function finishWeather(series, source, attribution) {
    let rawMissing = 0;
    for (const v of series) if (v == null || Number.isNaN(v)) rawMissing++;
    const f = fillGaps(series, 6);
    const vals = Array.from(f.values, (v) => (Number.isNaN(v) ? null : Math.round(v * 100) / 100));
    const ok = vals.filter((v) => v != null);
    return {
      source, attribution, values: vals, missing_raw: rawMissing, interpolated: f.interpolated, missing: f.missing,
      mean: ok.length ? ok.reduce((a, b) => a + b, 0) / ok.length : null,
      min: ok.length ? Math.min(...ok) : null, max: ok.length ? Math.max(...ok) : null,
    };
  }
  RH.fmiTemperature = async function (fmisid, year) {
    const start = Date.UTC(year, 0, 1) - EET, end = Date.UTC(year + 1, 0, 1) - EET, now = Date.now();
    const series = new Array(HOURS).fill(null);
    const iso = (ms) => new Date(ms).toISOString().slice(0, 19) + "Z";
    const chunks = [];
    for (let t0 = start; t0 < end && t0 < now; t0 = Math.min(t0 + 28 * 24 * H, end)) chunks.push([t0, Math.min(t0 + 28 * 24 * H, end)]);
    const run = async ([t0, t1]) => {
      const q = new URLSearchParams({ service: "WFS", version: "2.0.0", request: "getFeature",
        storedquery_id: "fmi::observations::weather::hourly::simple", fmisid: String(fmisid), parameters: "TA_PT1H_AVG",
        starttime: iso(t0 + H), endtime: iso(t1), timestep: "60" });
      for (const [t, v] of RH.parseFmiSimple(await getText(`${RH.FMI_WFS}?${q}`, "FMI:n havaintohaku"))) {
        const idx = hourIndex(t - H, year); // value stamped at t = mean of the hour ending at t
        if (idx != null && v != null) series[idx] = v;
      }
    };
    for (let i = 0; i < chunks.length; i += 4) await Promise.all(chunks.slice(i, i + 4).map(run));
    return finishWeather(series, `FMI asema ${fmisid}`, RH.ATTR.fmi);
  };
  RH.openMeteoTemperature = async function (lat, lon, year) {
    const q = new URLSearchParams({ latitude: lat.toFixed(4), longitude: lon.toFixed(4), start_date: `${year - 1}-12-31`,
      end_date: `${year}-12-31`, hourly: "temperature_2m", timezone: "GMT" });
    const j = JSON.parse(await getText(`${RH.OPEN_METEO}?${q}`, "Open-Meteo"));
    const inst = new Map();
    j.hourly.time.forEach((t, i) => { const v = j.hourly.temperature_2m[i]; if (v != null) inst.set(Date.parse(t + ":00Z"), v); });
    const series = new Array(HOURS).fill(null);
    for (const [t, v] of inst) {
      const idx = hourIndex(t, year);
      if (idx == null) continue;
      const nx = inst.get(t + H);
      series[idx] = nx == null ? v : 0.5 * (v + nx); // instantaneous -> hour mean
    }
    return finishWeather(series, `Open-Meteo ${lat.toFixed(3)}, ${lon.toFixed(3)}`, RH.ATTR.open_meteo);
  };
  RH.patchGaps = function (primary, secondary) {
    const vals = primary.values.slice();
    let n = 0;
    vals.forEach((v, i) => { if (v == null && secondary.values[i] != null) { vals[i] = secondary.values[i]; n++; } });
    return { ...primary, values: vals, missing: vals.filter((v) => v == null).length, patched: n, patched_from: n ? secondary.source : null };
  };

  // ------------------------------------------------------------------ model
  RH.USE_TYPES = {
    broileri: { label: "Broilerikasvattamo", t_set: 21, gain: 0, H: 2.2, q_base: 0, e_base: 3.0, e_vent: 0.25, profile: "flat", cycle: "broiler" },
    lihasika: { label: "Lihasikala", t_set: 19, gain: 11, H: 1.6, q_base: 0, e_base: 2.5, e_vent: 0.30, profile: "flat" },
    emakko: { label: "Emakko- tai porsastuotanto", t_set: 22, gain: 7, H: 1.6, q_base: 2.0, e_base: 3.5, e_vent: 0.30, profile: "flat" },
    navetta: { label: "Navetta (lypsykarja)", t_set: 10, gain: 9, H: 1.0, q_base: 3.0, e_base: 4.0, e_vent: 0.20, profile: "milking" },
    asuin: { label: "Asuinrakennus", t_set: 21, gain: 3, H: 1.3, q_base: 3.0, e_base: 4.0, e_vent: 0, profile: "home" },
    toimisto: { label: "Toimisto tai sosiaalitila", t_set: 21, gain: 3, H: 1.3, q_base: 1.5, e_base: 3.0, e_vent: 0, profile: "workday" },
    korjaamo: { label: "Konehalli tai korjaamo", t_set: 12, gain: 1, H: 0.9, q_base: 0, e_base: 1.0, e_vent: 0, profile: "workday" },
    kuivuri: { label: "Viljankuivuri (elo–lokakuu)", t_set: 0, gain: 0, H: 0, q_base: 60, e_base: 12, e_vent: 0, profile: "flat", season: [212, 288] },
    muu: { label: "Muu lämmitetty tila", t_set: 17, gain: 2, H: 1.0, q_base: 0, e_base: 1.5, e_vent: 0, profile: "flat" },
  };
  const PROFILES = {
    flat: new Array(24).fill(1),
    home: [0.6, 0.5, 0.5, 0.5, 0.5, 0.6, 0.9, 1.3, 1.2, 0.9, 0.8, 0.9, 1.0, 0.9, 0.9, 1.0, 1.2, 1.5, 1.7, 1.6, 1.5, 1.3, 1.0, 0.8],
    milking: [0.7, 0.7, 0.7, 0.7, 0.8, 1.5, 1.8, 1.7, 1.2, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 1.0, 1.5, 1.8, 1.7, 1.2, 0.9, 0.8, 0.7, 0.7],
  };
  function dailyProfile(name, cal) {
    const p = new Float64Array(HOURS);
    for (let i = 0; i < HOURS; i++) {
      if (name === "workday") p[i] = cal.weekday[i] >= 5 ? 0.5 : (cal.hour[i] >= 7 && cal.hour[i] < 16 ? 1.8 : 0.5);
      else p[i] = (PROFILES[name] || PROFILES.flat)[cal.hour[i]];
    }
    let m = 0;
    for (const v of p) m += v;
    m /= HOURS;
    for (let i = 0; i < HOURS; i++) p[i] /= m;
    return p;
  }
  const FROST_T = 8; // °C kept in an empty broiler house (own assumption)
  const BROILER_T0 = 30, BROILER_T27 = 20;
  function broilerState(c) {
    const batch = c.batch_days ?? 35, empty = c.empty_days ?? 12, pre = c.preheat_days ?? 2, first = c.first_placement_doy ?? 5;
    const period = batch + empty;
    const on = new Uint8Array(HOURS), tset = new Float64Array(HOURS), gain = new Float64Array(HOURS), el = new Float64Array(HOURS);
    for (let i = 0; i < HOURS; i++) {
      const rel = (((i / 24 - first) % period) + period) % period;
      const inBatch = rel < batch, preheat = !inBatch && rel >= period - pre;
      const frac = Math.min(1, Math.max(0, rel / batch));
      // between batches the house is kept frost-free; pre-heating brings it to 30 °C
      // 30 °C at placement -> 20 °C at 27 days (Aviagen Ross handbook 2025, Table 2.4, linear approximation)
      tset[i] = inBatch ? BROILER_T0 - (BROILER_T0 - BROILER_T27) * Math.min(1, Math.max(0, rel / 27)) : preheat ? BROILER_T0 : FROST_T;
      gain[i] = inBatch ? 15 * Math.pow(frac, 1.3) : 0;
      on[i] = 1;
      el[i] = inBatch ? 1 : preheat ? 0.4 : 0.15;
    }
    return { on, tset, gain, el };
  }
  function buildingSeries(b, t, year) {
    const p = { ...(RH.USE_TYPES[b.use] || RH.USE_TYPES.muu), ...(b.params || {}) };
    const A = +b.heated_m2 || 0, cal = calendar(year), prof = dailyProfile(p.profile, cal);
    const bs = p.cycle === "broiler" ? broilerState(b.cycle || {}) : null;
    const heat_w = new Float64Array(HOURS), heat_b = new Float64Array(HOURS), el_w = new Float64Array(HOURS), el_b = new Float64Array(HOURS);
    for (let i = 0; i < HOURS; i++) {
      const inSeason = p.season ? (Math.floor(i / 24) >= p.season[0] && Math.floor(i / 24) < p.season[1] ? 1 : 0) : 1;
      const on = (bs ? bs.on[i] : 1) * inSeason, ts = bs ? bs.tset[i] : p.t_set, g = bs ? bs.gain[i] : p.gain, em = (bs ? bs.el[i] : 1) * inSeason;
      heat_w[i] = on ? A * p.H * Math.max(0, ts - g - t[i]) / 1000 : 0;
      heat_b[i] = on ? A * p.q_base / 1000 : 0;
      el_b[i] = A * p.e_base * prof[i] * em / 1000;
      el_w[i] = A * p.e_vent * Math.max(0, t[i] - 12) * prof[i] * em / 1000;
    }
    return { heat_w, heat_b, el_w, el_b };
  }
  RH.buildingSeries = buildingSeries;

  function cvRmse(y, yhat, p) {
    const n = y.length; let mean = 0, ss = 0;
    for (let i = 0; i < n; i++) { mean += y[i]; ss += (y[i] - yhat[i]) ** 2; }
    mean /= n;
    if (n <= p || mean <= 0) return null;
    return Math.sqrt(ss / (n - p)) / mean;
  }
  function nnls2(W, B, y) {
    let ww = 0, bb = 0, wb = 0, wy = 0, by = 0;
    for (let i = 0; i < y.length; i++) { ww += W[i] * W[i]; bb += B[i] * B[i]; wb += W[i] * B[i]; wy += W[i] * y[i]; by += B[i] * y[i]; }
    const det = ww * bb - wb * wb;
    if (Math.abs(det) > 1e-12 * Math.max(1, ww * bb)) {
      const a = (wy * bb - by * wb) / det, b = (by * ww - wy * wb) / det;
      if (a >= 0 && b >= 0) return [a, b];
    }
    const sse = (a, b) => { let s = 0; for (let i = 0; i < y.length; i++) s += (y[i] - a * W[i] - b * B[i]) ** 2; return s; };
    const c = [];
    if (ww > 0) { const a = Math.max(0, wy / ww); c.push([a, 0, sse(a, 0)]); }
    if (bb > 0) { const b = Math.max(0, by / bb); c.push([0, b, sse(0, b)]); }
    if (!c.length) return [0, 0];
    c.sort((x, z) => x[2] - z[2]);
    return [c[0][0], c[0][1]];
  }
  const r3 = (v) => (v == null ? null : Math.round(v * 1000) / 1000);
  function calibrate(W, B, data, year) {
    const model = W.map((w, i) => w + B[i]);
    const totalModel = model.reduce((a, b) => a + b, 0);
    const kind = (data && data.kind) || "none";
    const rep = { kind, model_total_kwh: Math.round(totalModel) };
    if (kind === "annual") {
      const target = +data.kwh || 0;
      if (target <= 0 || totalModel <= 0) { rep.warning = "Vuosikulutus tai mallin tulos on nolla; mallin oletus käytössä."; return [model, rep]; }
      if (data.base_share != null && data.base_share !== "") {
        const share = Math.min(1, Math.max(0, +data.base_share));
        const Wt = W.reduce((a, v) => a + v, 0), Bt = B.reduce((a, v) => a + v, 0);
        const tb = share * target, tw = (1 - share) * target;
        let Bs = Bt > 0 ? B.map((v) => v * tb / Bt) : new Array(HOURS).fill(tb / HOURS), Ws;
        if (Wt > 0) Ws = W.map((v) => v * tw / Wt);
        else {
          Ws = new Array(HOURS).fill(0);
          Bs = tb > 0 ? Bs.map((v) => v * target / tb) : new Array(HOURS).fill(target / HOURS);
          rep.warning = "Mallin sääosa on nolla; koko vuosisumma jaettiin tasaisesti.";
        }
        Object.assign(rep, { base_share: r3(share), target_kwh: Math.round(target),
          note: `Vuosisumma kalibroitu; säästä riippumaton osuus ${Math.round(share * 100)} % käyttäjältä.` });
        return [Ws.map((v, i) => v + Bs[i]), rep];
      }
      const k = target / totalModel;
      Object.assign(rep, { scale: r3(k), target_kwh: Math.round(target), note: "Vuosisumma kalibroitu; tuntiprofiilin muoto tulee mallista." });
      return [model.map((v) => v * k), rep];
    }
    if (kind === "monthly") {
      const mvals = (data.kwh_months || []).concat(new Array(12).fill(null)).slice(0, 12).map((v) => (v == null || v === "" ? null : +v));
      const Wm = monthlySum(W, year), Bm = monthlySum(B, year);
      const idx = mvals.map((v, i) => (v == null ? -1 : i)).filter((i) => i >= 0);
      if (idx.length < 3) { rep.warning = "Kuukausiarvoja on alle kolme; mallin oletus käytössä."; return [model, rep]; }
      const [a, b] = nnls2(idx.map((i) => Wm[i]), idx.map((i) => Bm[i]), idx.map((i) => mvals[i]));
      const fit = Wm.map((w, i) => a * w + b * Bm[i]);
      Object.assign(rep, { a: r3(a), b: r3(b), months_used: idx.length, limit: 0.15,
        cv_rmse: r3(cvRmse(idx.map((i) => mvals[i]), idx.map((i) => fit[i]), 2)),
        target_kwh: Math.round(idx.reduce((s, i) => s + mvals[i], 0)) });
      if (idx.length < 12) rep.note = `${12 - idx.length} kuukautta täydennetty sovitteella.`;
      return [W.map((w, i) => a * w + b * B[i]), rep];
    }
    if (kind === "hourly") {
      const vals = data.values || [];
      if (vals.length !== HOURS) { rep.warning = "Tuntisarjan pituus ei ole 8 760; mallin oletus käytössä."; return [model, rep]; }
      const ok = []; vals.forEach((v, i) => { if (v != null) ok.push(i); });
      if (ok.length < 24 * 14) { rep.warning = "Mitattuja tunteja on alle kaksi viikkoa; mallin oletus käytössä."; return [model, rep]; }
      const [a, b] = nnls2(ok.map((i) => W[i]), ok.map((i) => B[i]), ok.map((i) => vals[i]));
      const out = W.map((w, i) => (vals[i] != null ? vals[i] : a * w + b * B[i]));
      const filled = HOURS - ok.length;
      Object.assign(rep, { a: r3(a), b: r3(b), hours_measured: ok.length, hours_filled: filled, limit: 0.30,
        cv_rmse: r3(cvRmse(ok.map((i) => vals[i]), ok.map((i) => a * W[i] + b * B[i]), 2)),
        target_kwh: Math.round(out.reduce((s, v) => s + v, 0)),
        note: "Mitatut tunnit käytetään sellaisenaan" + (filled ? "; puuttuvat tunnit täydennetty sovitteella." : ".") });
      return [out, rep];
    }
    rep.note = "Ei kulutustietoa: tulos on mallin oletus, ei tilan kulutus.";
    return [model, rep];
  }
  RH.calibrate = calibrate;

  // ---- several parts at once (an electricity meter that also carries heating electricity); same steps as model.py
  function solve(G, h) {
    const n = h.length;
    const A = G.map((row, i) => row.slice().concat([h[i]]));
    let scale = 1;
    for (let i = 0; i < n; i++) scale = Math.max(scale, Math.abs(A[i][i]));
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
      if (Math.abs(A[p][c]) <= 1e-12 * scale) return null;
      const tmp = A[c]; A[c] = A[p]; A[p] = tmp;
      for (let r = c + 1; r < n; r++) {
        const f = A[r][c] / A[c][c];
        for (let k = c; k <= n; k++) A[r][k] -= f * A[c][k];
      }
    }
    const x = new Array(n).fill(0);
    for (let r = n - 1; r >= 0; r--) {
      let acc = A[r][n];
      for (let k = r + 1; k < n; k++) acc -= A[r][k] * x[k];
      x[r] = acc / A[r][r];
    }
    return x;
  }
  function dot(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }
  function nnlsCols(X, y) {
    const n = X.length;
    const G = X.map((xi) => X.map((xj) => dot(xi, xj))), h = X.map((xi) => dot(xi, y)), yy = dot(y, y);
    let bestSse = null, best = new Array(n).fill(0);
    for (let mask = 1; mask < (1 << n); mask++) {
      const idx = [...Array(n).keys()].filter((i) => (mask >> i) & 1);
      if (idx.some((i) => G[i][i] <= 0)) continue;
      const sol = solve(idx.map((i) => idx.map((j) => G[i][j])), idx.map((i) => h[i]));
      if (!sol || sol.some((v) => v < 0)) continue;
      const c = new Array(n).fill(0);
      idx.forEach((i, k) => { c[i] = sol[k]; });
      let sse = yy;
      for (let i = 0; i < n; i++) { sse -= 2 * c[i] * h[i]; for (let j = 0; j < n; j++) sse += c[i] * G[i][j] * c[j]; }
      if (bestSse === null || sse < bestSse - 1e-9 * Math.max(1, Math.abs(yy))) { bestSse = sse; best = c; }
    }
    return best;
  }
  const addArr = (arrs) => { const o = new Array(HOURS).fill(0); arrs.forEach((a) => { for (let i = 0; i < HOURS; i++) o[i] += a[i]; }); return o; };
  function calibrateCols(cols, data, year) {
    const n = cols.length, model = addArr(cols);
    const totalModel = model.reduce((a, v) => a + v, 0);
    const kind = (data && data.kind) || "none";
    const rep = { kind, model_total_kwh: Math.round(totalModel) };
    if (kind === "annual") {
      const target = +data.kwh || 0;
      if (target <= 0 || totalModel <= 0) { rep.warning = "Vuosikulutus tai mallin tulos on nolla; mallin oletus käytössä."; return [cols.slice(), rep]; }
      const k = target / totalModel;
      Object.assign(rep, { scale: r3(k), target_kwh: Math.round(target), note: "Vuosisumma kalibroitu; lämmityssähkön ja muun sähkön suhde tulee mallista." });
      return [cols.map((c) => c.map((v) => v * k)), rep];
    }
    if (kind === "monthly") {
      const mvals = (data.kwh_months || []).concat(new Array(12).fill(null)).slice(0, 12).map((v) => (v == null || v === "" ? null : +v));
      const idx = mvals.map((v, i) => (v == null ? -1 : i)).filter((i) => i >= 0);
      if (idx.length < n + 1) { rep.warning = `Kuukausiarvoja on alle ${n + 1}; mallin oletus käytössä.`; return [cols.slice(), rep]; }
      const Xm = cols.map((c) => monthlySum(c, year));
      const coef = nnlsCols(Xm.map((x) => idx.map((i) => x[i])), idx.map((i) => mvals[i]));
      const fit = [...Array(12)].map((_, m) => coef.reduce((s, c, j) => s + c * Xm[j][m], 0));
      Object.assign(rep, { coef: coef.map(r3), months_used: idx.length, limit: 0.15,
        cv_rmse: r3(cvRmse(idx.map((i) => mvals[i]), idx.map((i) => fit[i]), n)),
        target_kwh: Math.round(idx.reduce((s, i) => s + mvals[i], 0)) });
      if (idx.length < 12) rep.note = `${12 - idx.length} kuukautta täydennetty sovitteella.`;
      return [cols.map((c, j) => c.map((v) => coef[j] * v)), rep];
    }
    if (kind === "hourly") {
      const vals = data.values || [];
      if (vals.length !== HOURS) { rep.warning = "Tuntisarjan pituus ei ole 8 760; mallin oletus käytössä."; return [cols.slice(), rep]; }
      const ok = []; vals.forEach((v, i) => { if (v != null) ok.push(i); });
      if (ok.length < 24 * 14) { rep.warning = "Mitattuja tunteja on alle kaksi viikkoa; mallin oletus käytössä."; return [cols.slice(), rep]; }
      const coef = nnlsCols(cols.map((c) => ok.map((i) => c[i])), ok.map((i) => vals[i]));
      const parts = cols.map((c, j) => c.map((v) => coef[j] * v)), fit = addArr(parts);
      const out = fit.map((f, i) => (vals[i] != null ? +vals[i] : f));
      const comps = parts.map((pj, j) => out.map((o, i) => o * (fit[i] > 0 ? pj[i] / fit[i] : model[i] > 0 ? cols[j][i] / model[i] : 1 / n)));
      const filled = HOURS - ok.length;
      Object.assign(rep, { coef: coef.map(r3), hours_measured: ok.length, hours_filled: filled, limit: 0.30,
        cv_rmse: r3(cvRmse(ok.map((i) => +vals[i]), ok.map((i) => fit[i]), n)),
        target_kwh: Math.round(out.reduce((s, v) => s + v, 0)),
        note: "Mitatut tunnit käytetään sellaisenaan" + (filled ? "; puuttuvat tunnit täydennetty sovitteella." : ".") });
      return [comps, rep];
    }
    rep.note = "Ei kulutustietoa: tulos on mallin oletus, ei tilan kulutus.";
    return [cols.slice(), rep];
  }
  RH.calibrateCols = calibrateCols;

  RH.HEAT_UNITS = {
    kWh: { label: "kWh lämpöä", k: 1, fuel: false }, MWh: { label: "MWh lämpöä", k: 1000, fuel: false },
    "i-m3": { label: "i-m³ haketta", k: 800, fuel: true }, MWh_pa: { label: "MWh polttoainetta", k: 1000, fuel: true },
    t_pelletti: { label: "t pellettiä", k: 4700, fuel: true }, l_oljy: { label: "l kevyttä polttoöljyä", k: 10, fuel: true },
    // electric heating: electricity used for heating (sub-meter); heat = electricity × COP
    kWh_el: { label: "kWh sähköä lämmitykseen", k: 1, fuel: false, el: true }, MWh_el: { label: "MWh sähköä lämmitykseen", k: 1000, fuel: false, el: true },
  };
  RH.heatToKwh = function (value, unit, eff = 0.85, chip = 0.8, cop = 1) {
    const u = RH.HEAT_UNITS[unit] || RH.HEAT_UNITS.kWh;
    const k = unit === "i-m3" ? chip * 1000 : u.k;
    if (u.el) return +value * k * cop;
    return +value * k * (u.fuel ? eff : 1);
  };
  RH.HEATING_SYSTEMS = { fuel: "Kattila (hake, pelletti, öljy)", district: "Kaukolämpö", electric: "Sähkölämmitys", heatpump: "Lämpöpumppu" };
  function heatingCop(d) {
    const sys = (d && d.system) || "fuel";
    if (sys === "heatpump") return Math.max(1, +(d && d.cop) || 3);
    if (sys === "electric") return 1;
    return null;
  }
  RH.heatingCop = heatingCop;
  RH.prepare = function (project) {
    const num = (v) => (v == null || v === "" ? null : +v);
    const circuits = (project.circuits || []).map((c) => {
      const d = { ...(c.data || {}) }, eff = +d.efficiency || 0.85, chip = +d.chip_density || 0.8, unit = d.unit || "kWh";
      const cop = heatingCop(d) || 1;
      if (d.kind === "annual" && num(d.value) != null) d.kwh = RH.heatToKwh(d.value, unit, eff, chip, cop);
      if (num(d.base_share_pct) != null) d.base_share = +d.base_share_pct / 100;
      if (d.kind === "monthly") d.kwh_months = (d.months || []).map((v) => (num(v) == null ? null : RH.heatToKwh(v, unit, eff, chip, cop)));
      // an hourly sub-meter file of heating electricity (kWh/h): heat = electricity × COP
      if (d.kind === "hourly" && (RH.HEAT_UNITS[unit] || {}).el && d.values) d.values = d.values.map((v) => (v == null ? null : +v * cop));
      return { ...c, data: d };
    });
    const meters = (project.meters || []).map((m) => {
      const d = { ...(m.data || {}) }, k = d.unit === "MWh" ? 1000 : 1;
      if (d.kind === "annual" && num(d.value) != null) d.kwh = +d.value * k;
      if (d.kind === "monthly") d.kwh_months = (d.months || []).map((v) => (num(v) == null ? null : +v * k));
      return { ...m, data: d };
    });
    const cids = circuits.map((c) => c.id), mids = meters.map((m) => m.id);
    const buildings = (project.buildings || []).map((b) => {
      const o = { ...b, circuit: cids.includes(b.circuit) ? b.circuit : cids[0], meter: mids.includes(b.meter) ? b.meter : mids[0] };
      if (num(b.known_heat_mwh) != null && o.known_heat_kwh == null) o.known_heat_kwh = +b.known_heat_mwh * 1000;
      if (num(b.known_el_mwh) != null && o.known_el_kwh == null) o.known_el_kwh = +b.known_el_mwh * 1000;
      return o;
    });
    return { ...project, circuits, meters, buildings };
  };

  const mwh = (kwh) => (kwh / 1000).toFixed(1).replace(".", ",");
  function subtractKnown(data, K, year, what) {
    const Ksum = K.reduce((a, v) => a + v, 0);
    if (!data || Ksum <= 0) return [data, null];
    const d = { ...data };
    if (data.kind === "annual") {
      const rest = (+data.kwh || 0) - Ksum;
      d.kwh = rest;
      if (rest <= 0) {
        if (what) return [d, `${what[0].toUpperCase()}${what.slice(1)} (${mwh(Ksum)} MWh) on vähintään mittarin kulutus (${mwh(+data.kwh || 0)} MWh); muulle sähkölle ei jää mitään.`];
        return [d, `Tunnettujen rakennusten kulutus (${mwh(Ksum)} MWh) on vähintään piirin kulutus (${mwh(+data.kwh || 0)} MWh); muille ei jää lämpöä.`];
      }
      return [d, null];
    }
    if (data.kind === "monthly") {
      const km = monthlySum(K, year), m = (data.kwh_months || []).concat(new Array(12).fill(null));
      let neg = 0;
      d.kwh_months = [...Array(12)].map((_, i) => {
        if (m[i] == null || m[i] === "") return null;
        let r = +m[i] - km[i];
        if (r < 0) { neg++; r = 0; }
        return r;
      });
      return [d, neg ? `${neg} kuukautena ${what || "tunnettujen rakennusten osuus"} ylitti mitatun; erotus rajattiin nollaan.` : null];
    }
    if (data.kind === "hourly") {
      let neg = 0;
      d.values = (data.values || []).map((v, i) => {
        if (v == null) return null;
        let r = i < HOURS ? +v - K[i] : +v;
        if (r < 0) { neg++; r = 0; }
        return r;
      });
      return [d, neg ? `${neg} tuntina ${what || "tunnettujen rakennusten osuus"} ylitti mitatun; erotus rajattiin nollaan.` : null];
    }
    return [d, null];
  }
  function scaled(m, total) {
    const s = m.reduce((a, v) => a + v, 0);
    return s > 0 ? m.map((v) => v * total / s) : new Array(HOURS).fill(total / HOURS);
  }
  function group(members, parts, pw, pb, knownKey, data, year) {
    const per = {};
    members.forEach((b) => { per[b.id] = new Array(HOURS).fill(0); });
    const known = members.filter((b) => (+b[knownKey] || 0) > 0), rest = members.filter((b) => !known.includes(b));
    const K = new Array(HOURS).fill(0);
    for (const b of known) {
      const m = parts[b.id][pw].map((v, i) => v + parts[b.id][pb][i]);
      const sb = scaled(m, +b[knownKey]);
      per[b.id] = sb;
      for (let i = 0; i < HOURS; i++) K[i] += sb[i];
    }
    let R, rep;
    if (rest.length) {
      const W = new Array(HOURS).fill(0), B = new Array(HOURS).fill(0);
      rest.forEach((b) => { for (let i = 0; i < HOURS; i++) { W[i] += parts[b.id][pw][i]; B[i] += parts[b.id][pb][i]; } });
      const [d, warn] = subtractKnown(data, K, year);
      if (d && d.kind === "annual" && (+d.kwh || 0) <= 0) {
        R = new Array(HOURS).fill(0);
        rep = { kind: "annual", model_total_kwh: Math.round(W.reduce((a, v, i) => a + v + B[i], 0)) };
      } else {
        [R, rep] = calibrate(W, B, d, year);
        R = R.map((v) => Math.max(0, v));
      }
      if (warn) rep.warning = warn;
      for (let i = 0; i < HOURS; i++) {
        const m = W[i] + B[i];
        rest.forEach((b) => { per[b.id][i] = R[i] * (m > 0 ? (parts[b.id][pw][i] + parts[b.id][pb][i]) / m : 1 / rest.length); });
      }
    } else {
      R = new Array(HOURS).fill(0);
      rep = { kind: (data && data.kind) || "none", note: "Kaikille rakennuksille on annettu tunnettu kulutus." };
      if (data && data.kind === "annual" && data.kwh) {
        const diff = K.reduce((a, v) => a + v, 0) - +data.kwh;
        if (Math.abs(diff) > 0.01 * +data.kwh) rep.warning = `Rakennusten tunnettu kulutus poikkeaa piirin vuosisummasta ${diff >= 0 ? "+" : "−"}${mwh(Math.abs(diff))} MWh.`;
      }
    }
    const series = K.map((v, i) => v + R[i]);
    if (known.length) {
      const Ksum = K.reduce((a, v) => a + v, 0);
      const notes = [`Tunnettu kulutus ${mwh(Ksum)} MWh: ${known.map((b) => b.name || b.id).join(", ")}.`];
      if (rep.note) notes.push(rep.note);
      rep.note = notes.join(" ");
      rep.known_kwh = Math.round(Ksum);
    }
    return [series, per, rep];
  }

  const shareOf = (part, whole, n) => part.map((v, i) => (whole[i] > 0 ? v / whole[i] : 1 / n));
  function groupJoint(members, parts, data, year, defs) {
    const per = {};
    members.forEach((b) => { per[b.id] = new Array(HOURS).fill(0); });
    const known = members.filter((b) => (+b.known_el_kwh || 0) > 0), rest = members.filter((b) => !known.includes(b));
    const K = new Array(HOURS).fill(0);
    for (const b of known) {
      const sb = scaled(parts[b.id].el_w.map((v, i) => v + parts[b.id].el_b[i]), +b.known_el_kwh);
      per[b.id] = sb;
      for (let i = 0; i < HOURS; i++) K[i] += sb[i];
    }
    const [d, warn] = subtractKnown(data, K, year);
    const Wv = addArr(rest.map((b) => parts[b.id].el_w)), Be = addArr(rest.map((b) => parts[b.id].el_b));
    for (const df of defs) {
      df.W = addArr(df.members.map((b) => parts[b.id].heat_w)).map((v) => v / df.cop);
      df.B = addArr(df.members.map((b) => parts[b.id].heat_b)).map((v) => v / df.cop);
    }
    const Wh = addArr(defs.map((df) => df.W)), Bh = addArr(defs.map((df) => df.B));
    const BeBh = Be.map((v, i) => v + Bh[i]);
    const cols = [Wv, BeBh, Wh];
    let comps, rep;
    if (d && d.kind === "annual" && (+d.kwh || 0) <= 0) {
      comps = [0, 1, 2].map(() => new Array(HOURS).fill(0));
      rep = { kind: "annual", model_total_kwh: Math.round(addArr(cols).reduce((a, v) => a + v, 0)) };
    } else {
      [comps, rep] = calibrateCols(cols, d, year);
      comps = comps.map((c) => c.map((v) => Math.max(0, v)));
    }
    if (warn) rep.warning = warn;
    const baseEl = rest.length ? comps[1].map((v, i) => v * (BeBh[i] > 0 ? Be[i] / BeBh[i] : 1)) : new Array(HOURS).fill(0);
    const Rel = comps[0].map((v, i) => v + baseEl[i]);
    const Rhel = comps[2].map((v, i) => v + (comps[1][i] - baseEl[i]));
    const modelEl = Wv.map((v, i) => v + Be[i]);
    for (const b of rest) {
      const sh = shareOf(parts[b.id].el_w.map((v, i) => v + parts[b.id].el_b[i]), modelEl, rest.length);
      per[b.id] = Rel.map((v, i) => v * sh[i]);
    }
    const modelH = Wh.map((v, i) => v + Bh[i]);
    for (const df of defs) {
      const sh = shareOf(df.W.map((v, i) => v + df.B[i]), modelH, defs.length);
      df.hel = Rhel.map((v, i) => v * sh[i]);
      df.heat = df.hel.map((v) => v * df.cop);
      const heatModel = addArr(df.members.map((b) => parts[b.id].heat_w.map((v, i) => v + parts[b.id].heat_b[i])));
      df.per = {};
      for (const b of df.members) {
        const sb = shareOf(parts[b.id].heat_w.map((v, i) => v + parts[b.id].heat_b[i]), heatModel, df.members.length);
        df.per[b.id] = df.heat.map((v, i) => v * sb[i]);
      }
    }
    const helTotal = Rhel.reduce((a, v) => a + v, 0);
    const note = `Lämmityssähkö ${mwh(helTotal)} MWh erotettu mittarin kulutuksesta (${defs.map((df) => df.name).join(", ")}).`;
    rep.note = note + (rep.note ? " " + rep.note : "");
    rep.heating_el_kwh = Math.round(helTotal);
    if (known.length) {
      const Ksum = K.reduce((a, v) => a + v, 0);
      rep.note = `Tunnettu kulutus ${mwh(Ksum)} MWh: ${known.map((b) => b.name || b.id).join(", ")}. ` + rep.note;
      rep.known_kwh = Math.round(Ksum);
    }
    return [K.map((v, i) => v + Rel[i]), per, rep];
  }
  function capacityCheck(rep, series, cap) {
    if (cap == null || cap === "" || !(+cap > 0)) return;
    const over = series.filter((v) => v > +cap).length;
    const peak = series.reduce((a, v) => Math.max(a, v), 0);
    rep.capacity_kw = +cap; rep.hours_over_capacity = over;
    if (over) {
      const msg = `Huipputeho ${Math.round(peak)} kW ylittää kattilan tehon ${Math.round(+cap)} kW ${over} tuntina. Tarkista profiili (esim. broilerierien ajoitus) tai kattilan teho.`;
      rep.warning = rep.warning ? rep.warning + " " + msg : msg;
    }
  }

  RH.run = function (project) {
    const year = +project.year;
    const t = project.temperature || [];
    if (t.length !== HOURS) throw new HttpError("Ulkolämpötilasarjassa pitää olla 8 760 tuntiarvoa.", 422);
    const tMissing = t.filter((v) => v == null || Number.isNaN(v)).length;
    if (tMissing) throw new HttpError(`Ulkolämpötilasarjasta puuttuu ${tMissing} tuntia. Valitse päättynyt vuosi, toinen sääasema tai Open-Meteo.`, 422);
    const blds = (project.buildings || []).filter((b) => b.heated);
    if (!blds.length) throw new HttpError("Valitse vähintään yksi rakennus.", 422);
    const parts = {};
    blds.forEach((b) => { parts[b.id] = buildingSeries(b, t, year); });
    const heat = new Float64Array(HOURS), el = new Float64Array(HOURS), hel = new Float64Array(HOURS);
    const per = {};
    blds.forEach((b) => { per[b.id] = { heat: new Float64Array(HOURS), el: new Float64Array(HOURS) }; });
    const reports = { circuits: [], meters: [] };
    const meters = project.meters || [], mids = meters.map((m) => m.id), meterById = {};
    meters.forEach((m) => { meterById[m.id] = m; });
    const helKnown = {}, helNames = {}, deferred = {};
    mids.forEach((m) => { helKnown[m] = new Array(HOURS).fill(0); helNames[m] = []; deferred[m] = []; });
    const hasData = (g) => !!g && (((g.data || {}).kind) || "none") !== "none";
    const sumA = (a) => a.reduce((s, v) => s + v, 0), peakA = (a) => a.reduce((s, v) => Math.max(s, v), 0);

    for (const g of project.circuits || []) {
      const members = blds.filter((b) => b.circuit === g.id && ["both", "heat"].includes(b.scope || "both"));
      if (!members.length) continue;
      const d = g.data || {}, cop = heatingCop(d);
      const mid = mids.includes(d.el_meter) ? d.el_meter : (mids.length ? mids[0] : null);
      const base = { id: g.id, name: g.name || g.id, members: members.map((b) => b.id), system: d.system || "fuel" };
      if (cop && mid && (d.kind || "none") === "none" && hasData(meterById[mid])) {
        const rep = { ...base, kind: "from_meter", cop, el_meter: mid };
        deferred[mid].push({ g, name: base.name, members, cop, rep });
        reports.circuits.push(rep);
        continue;
      }
      const [series, pr, rep] = group(members, parts, "heat_w", "heat_b", "known_heat_kwh", d, year);
      for (let i = 0; i < HOURS; i++) heat[i] += series[i];
      for (const id in pr) for (let i = 0; i < HOURS; i++) per[id].heat[i] += pr[id][i];
      Object.assign(rep, base, { annual_kwh: Math.round(sumA(series)), peak_kw: Math.round(peakA(series) * 10) / 10 });
      if (cop) {
        const h = series.map((v) => v / cop);
        for (let i = 0; i < HOURS; i++) hel[i] += h[i];
        Object.assign(rep, { cop, heating_el_kwh: Math.round(sumA(h)), el_meter: mid });
        if (mid) { for (let i = 0; i < HOURS; i++) helKnown[mid][i] += h[i]; helNames[mid].push(base.name); }
      }
      capacityCheck(rep, series, d.capacity_kw);
      reports.circuits.push(rep);
    }

    for (const g of meters) {
      const members = blds.filter((b) => b.meter === g.id && ["both", "el"].includes(b.scope || "both"));
      const defs = deferred[g.id] || [];
      if (!members.length && !defs.length) continue;
      let data = g.data, hwarn = null;
      const Hk = helKnown[g.id], HkSum = sumA(Hk);
      if (HkSum > 0) [data, hwarn] = subtractKnown(data, Hk, year, "lämmityssähkö");
      const [series, pr, rep] = defs.length ? groupJoint(members, parts, data, year, defs) : group(members, parts, "el_w", "el_b", "known_el_kwh", data, year);
      if (HkSum > 0) {
        const msg = `Lämmityssähkö ${mwh(HkSum)} MWh vähennetty mittarin tiedoista (${helNames[g.id].join(", ")}).`;
        rep.note = msg + (rep.note ? " " + rep.note : "");
        rep.heating_el_kwh = Math.round(HkSum + (+rep.heating_el_kwh || 0));
        if (hwarn) rep.warning = rep.warning ? rep.warning + " " + hwarn : hwarn;
      }
      for (let i = 0; i < HOURS; i++) el[i] += series[i];
      for (const id in pr) for (let i = 0; i < HOURS; i++) per[id].el[i] += pr[id][i];
      Object.assign(rep, { id: g.id, name: g.name || g.id, members: members.map((b) => b.id),
        annual_kwh: Math.round(sumA(series)), peak_kw: Math.round(peakA(series) * 10) / 10 });
      reports.meters.push(rep);
      for (const df of defs) {
        for (let i = 0; i < HOURS; i++) { heat[i] += df.heat[i]; hel[i] += df.hel[i]; }
        for (const id in df.per) for (let i = 0; i < HOURS; i++) per[id].heat[i] += df.per[id][i];
        Object.assign(df.rep, { annual_kwh: Math.round(sumA(df.heat)), peak_kw: Math.round(peakA(df.heat) * 10) / 10,
          heating_el_kwh: Math.round(sumA(df.hel)),
          note: `Lämpö = lämmityssähkö ${mwh(sumA(df.hel))} MWh × ${df.cop.toFixed(1)}, erotettu mittarin ${g.name || g.id} kulutuksesta. Muoto tulee mallista.` });
        capacityCheck(df.rep, df.heat, (df.g.data || {}).capacity_kw);
      }
    }
    const cal = calendar(year), sum = (a) => a.reduce((s, v) => s + v, 0), mx = (a) => a.reduce((s, v) => Math.max(s, v), 0);
    const r1 = (v) => Math.round(v * 10) / 10;
    return {
      year,
      electricity: Array.from(el, (v) => Math.round(v * 1000) / 1000),
      heat: Array.from(heat, (v) => Math.round(v * 1000) / 1000),
      temperature: t.map((v) => Math.round(v * 100) / 100),
      monthly: {
        electricity: monthlySum(el, year).map(Math.round), heat: monthlySum(heat, year).map(Math.round),
        temperature: [...Array(12)].map((_, m) => { let s = 0, n = 0; for (let i = 0; i < HOURS; i++) if (cal.month[i] === m + 1) { s += t[i]; n++; } return r1(s / n); }),
      },
      totals: { electricity_kwh: Math.round(sum(el)), heat_kwh: Math.round(sum(heat)), electricity_peak_kw: r1(mx(el)), heat_peak_kw: r1(mx(heat)), heating_el_kwh: Math.round(sum(hel)) },
      buildings: blds.map((b) => ({ id: b.id, electricity_kwh: Math.round(sum(per[b.id].el)), heat_kwh: Math.round(sum(per[b.id].heat)), heat_peak_kw: r1(mx(per[b.id].heat)) })),
      calibration: reports,
    };
  };

  // ------------------------------------------------------------------ spot prices
  // Sähkötin (Pakastin Oy) serves Nord Pool FI day-ahead prices, €/MWh without VAT,
  // hourly with UTC stamps; from 1.10.2025 the hour is the mean of the 15-min prices.
  // The free API is for non-commercial use and Nord Pool owns the data, so the app
  // fetches prices for the viewer's own analysis and never bundles them.
  RH.SAHKOTIN = "https://sahkotin.fi/prices.csv";
  RH.PRICE_YEARS = [2023, 2024, 2025, 2026]; // the calculator's Hintahistoria columns C–F
  RH.PRICE_ATTR = "Pörssihinnat: Sähkötin (sahkotin.fi), Nord Pool FI-alue, €/MWh alv 0. Ilmainen rajapinta ei-kaupalliseen käyttöön.";
  RH.parsePriceCsv = function (text, year) {
    const acc = new Float64Array(HOURS), n = new Int32Array(HOURS);
    for (const line of text.split(/\r?\n/).slice(1)) {
      const [ts, p] = line.split(",");
      if (!ts || p === undefined || p.trim() === "") continue;
      const idx = hourIndex(Date.parse(ts), year), v = Number(p);
      if (idx == null || !Number.isFinite(v)) continue;
      acc[idx] += v; n[idx]++;
    }
    const values = Array.from(acc, (v, i) => (n[i] ? Math.round((v / n[i]) * 100) / 100 : null));
    return priceStats(values, year);
  };
  function priceStats(values, year) {
    const ok = values.filter((v) => v != null);
    const now = Date.now();
    let future = 0; // hours of the year that have not happened yet (beyond tomorrow)
    hourStartsUtc(year).forEach((t, i) => { if (values[i] == null && t > now + 36 * H) future++; });
    return {
      year, values, hours: ok.length, missing: HOURS - ok.length, future,
      mean: ok.length ? ok.reduce((a, b) => a + b, 0) / ok.length : null,
      min: ok.length ? Math.min(...ok) : null, max: ok.length ? Math.max(...ok) : null,
      negative: ok.filter((v) => v < 0).length, source: "Sähkötin, Nord Pool FI",
    };
  }
  RH.priceStats = priceStats;
  RH.fetchPrices = async function (year) {
    const start = new Date(Date.UTC(year, 0, 1) - EET).toISOString();
    const end = new Date(Date.UTC(year + 1, 0, 1) - EET - 1).toISOString();
    const text = await getText(`${RH.SAHKOTIN}?start=${start}&end=${end}`, "Pörssihintahaku");
    return RH.parsePriceCsv(text, year);
  };

  // ------------------------------------------------------------------ export
  const fi = (v, nd = 3) => v.toFixed(nd).replace(".", ",");
  const fiOrBlank = (v, nd) => (v == null ? "" : fi(v, nd));
  RH.csv = function (res, prices) {
    const cal = calendar(res.year);
    const p = prices && prices.length === HOURS ? prices : null;
    const head = ["Tunti", "Kk", "Pv", "Klo", "Sähkö (kWh/h)", "Lämpö (kWh/h)", "Ulkolämpötila (°C)"];
    if (p) head.push(`Pörssihinta ${res.year} (€/MWh, alv 0)`);
    const lines = [head.join(";")];
    for (let i = 0; i < HOURS; i++) {
      let row = `${i + 1};${cal.month[i]};${cal.day[i]};${cal.hour[i]};${fi(res.electricity[i])};${fi(res.heat[i])};${fi(res.temperature[i], 1)}`;
      if (p) row += ";" + fiOrBlank(p[i], 2);
      lines.push(row);
    }
    return "﻿" + lines.join("\r\n") + "\r\n";
  };
  RH.paste = function (res) { return res.electricity.map((e, i) => `${fi(e)}\t${fi(res.heat[i])}`).join("\r\n"); };
  // Same columns as the calculator's Hintahistoria sheet: A Tunti, B Aika, C–F 2023–2026.
  RH.hintahistoriaCsv = function (byYear) {
    const cal = calendar(2023);
    const pad = (v) => String(v).padStart(2, "0");
    const lines = ["Tunti;Aika (EET, UTC+2);" + RH.PRICE_YEARS.join(";")];
    for (let i = 0; i < HOURS; i++) {
      const cols = RH.PRICE_YEARS.map((y) => (byYear[y] ? fiOrBlank(byYear[y][i], 2) : ""));
      lines.push(`${i + 1};${pad(cal.day[i])}.${pad(cal.month[i])}. klo ${pad(cal.hour[i])};${cols.join(";")}`);
    }
    return "﻿" + lines.join("\r\n") + "\r\n";
  };
  RH.pastePrices = function (byYear) {
    return [...Array(HOURS)].map((_, i) => RH.PRICE_YEARS.map((y) => (byYear[y] ? fiOrBlank(byYear[y][i], 2) : "")).join("\t")).join("\r\n");
  };

  root.RH = RH;
})(typeof window !== "undefined" ? window : globalThis);
