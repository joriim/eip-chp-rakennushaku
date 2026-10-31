"""Build the single-file browser app web/rakennushaku.html.

Same UI as the Python package (src/rakennushaku/static), with the server API
replaced by the in-browser engine (web/engine.js). Leaflet and its images are
inlined so the file works offline-first, from disk or from any static host.

    python web/build.py
"""

from __future__ import annotations

import base64
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "src" / "rakennushaku" / "static"
WEB = ROOT / "web"
VERSION = "0.5.0"


def sub(text: str, old: str, new: str) -> str:
    assert old in text, f"anchor not found: {old[:70]!r}"
    return text.replace(old, new, 1)


def leaflet_css() -> str:
    css = (STATIC / "vendor/leaflet/leaflet.css").read_text(encoding="utf-8")

    def data_uri(m: re.Match) -> str:
        p = STATIC / "vendor/leaflet" / m.group(1)
        return "url(data:image/png;base64," + base64.b64encode(p.read_bytes()).decode() + ")"

    return re.sub(r"url\((images/[^)]+\.png)\)", data_uri, css)


def ui_js() -> str:
    js = (STATIC / "app.js").read_text(encoding="utf-8")
    js = sub(js, "/* Rakennushaku UI. Plain JS + Leaflet; all external data comes through the local API. */",
             "/* Rakennushaku UI (browser version). Same UI as the Python app; data calls go to the in-browser engine RH. */")
    # ---- local API router replaces fetch() to the Python server
    start = js.index("  async function api(path, opts = {}) {")
    end = js.index("  function toast(msg, isError) {")
    js = js[:start] + r'''  const KEY_STORE = "rakennushaku.mmlKey";
  const mmlKey = () => ($("#mmlKey") ? $("#mmlKey").value.trim() : "");

  async function api(path, opts = {}) {
    const u = new URL(path, "https://local.invalid");
    const q = Object.fromEntries(u.searchParams), b = opts.body || {}, key = mmlKey();
    switch (u.pathname) {
      case "/api/property": return RH.fetchProperty(q.kt, key);
      case "/api/property-at": return RH.propertyAt(+q.lon, +q.lat, key);
      case "/api/buildings": return { buildings: await RH.buildingsForArea(b.geometry, key) };
      case "/api/buildings-around": {
        const area = RH.circle(+q.lat, +q.lon, +q.r || 250);
        return { area, buildings: await RH.buildingsForArea(area, key, 0) };
      }
      case "/api/weather/stations": return { stations: await RH.nearestStations(+q.lat, +q.lon, +q.year) };
      case "/api/weather/fmi": {
        let r = await RH.fmiTemperature(+q.fmisid, +q.year);
        if (r.missing && q.lat) { try { r = RH.patchGaps(r, await RH.openMeteoTemperature(+q.lat, +q.lon, +q.year)); } catch (_) { /* best effort */ } }
        return r;
      }
      case "/api/weather/open-meteo": return RH.openMeteoTemperature(+q.lat, +q.lon, +q.year);
      case "/api/parse-series": return RH.parseSeries(b.text, { kind: b.kind, year: b.year });
      case "/api/model": return RH.run(RH.prepare(b.project));
      case "/api/export/csv": return RH.csv(RH.run(RH.prepare(b.project)), b.prices);
      case "/api/prices": return RH.fetchPrices(+q.year);
      case "/api/export/hintahistoria": return RH.hintahistoriaCsv(b.prices || {});
      case "/api/export/paste-prices": return RH.pastePrices(b.prices || {});
      case "/api/export/paste": return RH.paste(RH.run(RH.prepare(b.project)));
    }
    throw new Error("Tuntematon toiminto " + u.pathname);
  }

''' + js[end:]
    # ---- base layers straight from MML WMTS with the viewer's own key
    start = js.index("  function initBaseLayers() {")
    end = js.index("  function setMode(m, text) {")
    js = js[:start] + r'''  let baseCtrl = null, orto = null, tausta = null;
  function initBaseLayers() {
    if (baseCtrl) { map.removeControl(baseCtrl); baseCtrl = null; }
    [orto, tausta].forEach((l) => { if (l && map.hasLayer(l)) map.removeLayer(l); });
    const k = mmlKey();
    if (!k) { if (!map.hasLayer(osm)) osm.addTo(map); return; }
    const wm = (layer, fmt) => `${RH.WMTS}?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${layer}&STYLE=default`
      + `&TILEMATRIXSET=WGS84_Pseudo-Mercator&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=${fmt}&api-key=${encodeURIComponent(k)}`;
    orto = L.tileLayer(wm("ortokuva", "image/jpeg"), { maxZoom: 20, maxNativeZoom: 15, attribution: "&copy; MML" });
    tausta = L.tileLayer(wm("taustakartta", "image/png"), { maxZoom: 20, maxNativeZoom: 16, attribution: "&copy; MML" });
    baseCtrl = L.control.layers({ "MML ortokuva": orto, "MML taustakartta": tausta, "OpenStreetMap": osm }, null, { position: "topright" }).addTo(map);
    if (map.hasLayer(osm)) map.removeLayer(osm);
    orto.addTo(map);
  }

''' + js[end:]
    # ---- property ID or street address in the same field
    js = sub(js, '''    busy(e.submitter || $("#ktForm button"), "Haetaan…", async () => {
      const p = await api(`/api/property?kt=${encodeURIComponent(kt)}`);
      await useProperty(p);
    });''', '''    busy(e.submitter || $("#ktForm button"), "Haetaan…", async () => {
      if (RH.looksLikeKt(kt)) { await useProperty(await api(`/api/property?kt=${encodeURIComponent(kt)}`)); return; }
      const hits = await RH.geocode(kt, mmlKey());
      if (!hits.length) throw new Error(`Osoitetta "${kt}" ei löytynyt. Kokeile muotoa "Katu 12, Kunta" tai kiinteistötunnusta.`);
      const p = await api(`/api/property-at?lat=${hits[0].lat}&lon=${hits[0].lon}`);
      await useProperty(p);
      toast(`${hits[0].label} → kiinteistö ${p.display}`);
    });''')
    # ---- boot: metadata from the engine, key from this browser
    js = sub(js, '''    try { META = await api("/api/status"); } catch (e) { toast("Palvelimeen ei saatu yhteyttä.", true); }''',
             f'''    META = {{ version: "{VERSION} (selain)", use_types: RH.USE_TYPES, attribution: {{ ...RH.ATTR, prices: RH.PRICE_ATTR }}, has_mml_key: false,
      heat_units: Object.fromEntries(Object.entries(RH.HEAT_UNITS).map(([k, v]) => [k, v.label])) }};
    try {{ $("#mmlKey").value = localStorage.getItem(KEY_STORE) || ""; }} catch (_) {{ /* storage unavailable */ }}
    META.has_mml_key = !!mmlKey();
    $("#mmlKey").addEventListener("change", () => {{
      try {{ localStorage.setItem(KEY_STORE, mmlKey()); }} catch (_) {{ /* storage unavailable */ }}
      META.has_mml_key = !!mmlKey();
      updateKeyUi();
      initBaseLayers();
      if (META.has_mml_key) toast("MML-avain tallennettu tähän selaimeen.");
    }});''')
    js = sub(js, '''    const kc = $("#keyChip");
    kc.className = "chip " + (META.has_mml_key ? "ok" : "warn");
    kc.textContent = META.has_mml_key ? "MML-avain käytössä" : "MML-avain puuttuu";
    if (!META.has_mml_key) {
      $("#step1Hint").innerHTML = "MML-rajapinta-avain puuttuu, joten kiinteistö- ja rakennushaku eivät toimi. Lisää <code>MML_API_KEY</code> tiedostoon <code>.env</code> ja käynnistä uudelleen, tai lisää rakennukset kartalle käsin kohdassa 2.";
    }''', '''    updateKeyUi();''')
    js = sub(js, '''  // ------------------------------------------------------------------ boot''', '''  const HINT_DEFAULT = $("#step1Hint").innerHTML;
  function updateKeyUi() {
    const kc = $("#keyChip");
    kc.className = "chip " + (META.has_mml_key ? "ok" : "warn");
    kc.textContent = META.has_mml_key ? "Avain tallennettu" : "Avain puuttuu";
    $("#step1Hint").innerHTML = META.has_mml_key ? HINT_DEFAULT
      : 'Kiinteistö- ja rakennushaku tarvitsee Maanmittauslaitoksen ilmaisen API-avaimen. Lisää se yläpalkkiin '
        + '(<a href="https://www.maanmittauslaitos.fi/rajapinnat/api-avaimen-ohje" target="_blank" rel="noopener">avaimen tilaus</a>). '
        + 'Ilman avainta voit lisätä rakennukset kartalle käsin kohdassa 2.';
  }

  // ------------------------------------------------------------------ boot''')
    js = js.replace("  boot();\n})();", """  const dlg = $("#docsDialog");
  if (dlg) {
    const openDocs = (e) => { if (e) e.preventDefault(); if (!dlg.open) dlg.showModal(); };
    $("#docsLink").addEventListener("click", openDocs);
    $("#docsClose").addEventListener("click", () => dlg.close());
    dlg.addEventListener("close", () => { if (location.hash === "#menetelmat") history.replaceState(null, "", location.pathname); });
    if (location.hash === "#menetelmat") openDocs();
  }
  boot();
})();""")
    assert "docsDialog" in js
    return js


def page() -> str:
    html = (STATIC / "index.html").read_text(encoding="utf-8")
    html = sub(html, '<link rel="stylesheet" href="/static/vendor/leaflet/leaflet.css">', "<style>\n" + leaflet_css() + "\n</style>")
    css = (STATIC / "app.css").read_text(encoding="utf-8")
    css += """
.keybox { display: flex; align-items: center; gap: 6px; color: var(--ink-2); font-size: 13px; }
.keybox input { width: 13.5em; font-family: var(--font-num); font-size: 12px; padding: 4px 7px; }
.privacy { color: var(--ink-3); }
@media (max-width: 900px) { .keybox input { width: 100%; } .keybox { flex: 1 1 100%; } }
"""
    html = sub(html, '<link rel="stylesheet" href="/static/app.css">', "<style>\n" + css + "\n</style>")
    html = sub(html, '<span id="keyChip" class="chip"></span>',
               '<label class="keybox" for="mmlKey">MML API-avain\n'
               '      <input id="mmlKey" type="password" autocomplete="off" spellcheck="false" placeholder="liitä avain">\n'
               '    </label>\n    <span id="keyChip" class="chip"></span>')
    html = sub(html, 'placeholder="Kiinteistötunnus (KKK-RRR-YYYY-XXXX)"', 'placeholder="Kiinteistötunnus tai osoite, esim. Kampusranta 11, Seinäjoki"')
    html = sub(html, '<label for="kt" class="sr">Kiinteistötunnus</label>', '<label for="kt" class="sr">Kiinteistötunnus tai osoite</label>')
    docs = (WEB / "menetelmat_fragment.html").read_text(encoding="utf-8")
    html = sub(html, '<a id="docsLink" class="docslink" href="/static/menetelmat.html" target="_blank" rel="noopener">Menetelmät, oletukset ja lähteet</a>',
               '<a id="docsLink" class="docslink" href="#menetelmat">Menetelmät, oletukset ja lähteet</a>'
               '<span class="privacy">Kaikki laskenta tehdään tässä selaimessa. Kulutustiedot eivät lähde koneelta; '
               'rajapinnoille lähtevät vain sijainti, kiinteistötunnus ja vuosi. MML-avain tallennetaan vain tähän selaimeen.</span>')
    html = sub(html, '<div id="toast"',
               '<dialog id="docsDialog" class="docs-dialog" aria-label="Menetelmät ja lähteet"><header><strong>Menetelmät, oletukset ja lähteet</strong>'
               '<button type="button" class="btn small" id="docsClose">Sulje</button></header><div class="docs-body">' + docs + '</div></dialog>\n<div id="toast"')
    leaflet = (STATIC / "vendor/leaflet/leaflet.js").read_text(encoding="utf-8")
    lic = (STATIC / "vendor/leaflet/LICENSE").read_text(encoding="utf-8").strip().replace("*/", "* /")
    html = sub(html, '<script src="/static/vendor/leaflet/leaflet.js"></script>',
               "<script>/* Leaflet 1.9.4 (https://leafletjs.com), BSD-2-Clause:\n" + lic + "\n*/\n" + leaflet + "\n</script>")
    engine = (WEB / "engine.js").read_text(encoding="utf-8")
    html = sub(html, '<script src="/static/app.js"></script>', "<script>\n" + engine + "\n</script>\n<script>\n" + ui_js() + "\n</script>")
    html = sub(html, "<title>Rakennushaku</title>", "<title>Rakennushaku</title>\n<meta name=\"description\" content=\"Tilan lämmitettävät rakennukset ja tunnittainen energiaprofiili Maatilan hybridienergialaskuriin\">")
    return html


if __name__ == "__main__":
    out = WEB / "rakennushaku.html"
    out.write_text(page(), encoding="utf-8")
    print(out, round(out.stat().st_size / 1024), "kB")
