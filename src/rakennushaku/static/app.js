/* Rakennushaku UI. Plain JS + Leaflet; all external data comes through the local API. */
(function () {
  "use strict";

  const $ = (s, el) => (el || document).querySelector(s);
  const fmt = (v, nd = 0) => v == null || Number.isNaN(v) ? "–"
    : Number(v).toLocaleString("fi-FI", { minimumFractionDigits: nd, maximumFractionDigits: nd });
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const MONTHS = ["Tammi", "Helmi", "Maalis", "Huhti", "Touko", "Kesä", "Heinä", "Elo", "Syys", "Loka", "Marras", "Joulu"];
  const DRAFT_KEY = "rakennushaku.draft.v1";
  const PROD_MIN_M2 = 600; // agricultural footprints at least this big are suggested as production buildings

  let META = { use_types: {}, heat_units: {}, has_mml_key: false, attribution: {} };
  let state = blankState();
  let mode = "none";

  function blankState() {
    const y = new Date().getFullYear() - 1;
    return {
      year: y,
      mainUse: "broileri",
      area: null,            // {kind, display, geometry, kt, center:[lat,lon]}
      buildings: [],         // MML records + user fields
      circuits: [{ id: "c1", name: "Päälämmitys", data: { kind: "none", unit: "i-m3", efficiency: 0.85 } }],
      meters: [{ id: "m1", name: "Sähköliittymä", data: { kind: "none", unit: "kWh" } }],
      stations: [],
      weatherChoice: null,   // {type:'fmi', fmisid} | {type:'open-meteo'} | {type:'file'}
      weather: null,         // {source, values, ...}
      prices: {},            // year -> {values[8760] €/MWh alv 0, stats}
      result: null,
    };
  }

  // ------------------------------------------------------------------ API
  async function api(path, opts = {}) {
    const res = await fetch(path, {
      method: opts.body ? "POST" : "GET",
      headers: opts.body ? { "Content-Type": "application/json" } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (!res.ok) {
      let msg = `Virhe ${res.status}`;
      try { const j = await res.json(); msg = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail); } catch (_) { /* text */ }
      throw new Error(msg);
    }
    const ct = res.headers.get("content-type") || "";
    return ct.includes("json") ? res.json() : res.text();
  }

  // Messages stack in the lower left corner, so a second message does not hide the first and none covers the results.
  function toast(msg, isError, ms) {
    const host = $("#toast");
    const t = document.createElement("div");
    t.className = "toast" + (isError ? " error" : "");
    t.innerHTML = `<span>${esc(msg)}</span><button type="button" class="toast-x" aria-label="Sulje ilmoitus">×</button>`;
    const close = () => t.remove();
    t.querySelector("button").onclick = close;
    host.appendChild(t);
    while (host.children.length > 4) host.firstChild.remove();
    setTimeout(close, ms || (isError ? 10000 : 4000));
  }

  async function busy(btn, label, fn) {
    const old = btn ? btn.textContent : null;
    if (btn) { btn.disabled = true; btn.textContent = label; }
    try { return await fn(); }
    catch (e) { toast(e.message || String(e), true); }
    finally { if (btn) { btn.disabled = false; btn.textContent = old; } }
  }

  // ------------------------------------------------------------------ map
  const map = L.map("map", { zoomControl: true }).setView([62.79, 22.84], 10);
  const osm = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 20, maxNativeZoom: 19, attribution: "&copy; OpenStreetMap",
  }).addTo(map);
  const layers = { area: null, buildings: L.layerGroup().addTo(map) };
  const shapes = {}; // building id -> leaflet layer

  function initBaseLayers() {
    if (!META.has_mml_key) return;
    const orto = L.tileLayer("/tiles/ortokuva/{z}/{x}/{y}", { maxZoom: 20, maxNativeZoom: 15, attribution: "&copy; MML" });
    const tausta = L.tileLayer("/tiles/taustakartta/{z}/{x}/{y}", { maxZoom: 20, maxNativeZoom: 16, attribution: "&copy; MML" });
    L.control.layers({ "MML ortokuva": orto, "MML taustakartta": tausta, "OpenStreetMap": osm }, null, { position: "topright" }).addTo(map);
    map.removeLayer(osm);
    orto.addTo(map);
  }

  // Raster tiles for the 3D view: MML orthophoto through the local tile proxy, OSM without a key.
  function tileTemplate() {
    return META.has_mml_key
      ? { url: location.origin + "/tiles/ortokuva/{z}/{x}/{y}", maxzoom: 15, attribution: "&copy; Maanmittauslaitos" }
      : { url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png", maxzoom: 19, attribution: "&copy; OpenStreetMap" };
  }

  function setMode(m, text) {
    mode = m;
    const b = $("#modeBanner");
    $("#pickProperty").classList.toggle("active", m === "pick-property");
    $("#pickCircle").classList.toggle("active", m === "pick-circle");
    $("#addBuilding").classList.toggle("active", m === "add-building");
    map.getContainer().style.cursor = m === "none" ? "" : "crosshair";
    if (m === "none") { b.hidden = true; return; }
    b.innerHTML = `<span>${esc(text)}</span><button type="button" id="cancelMode">Peruuta</button>`;
    b.hidden = false;
    $("#cancelMode").onclick = () => setMode("none");
  }

  map.on("click", async (e) => {
    const { lat, lng } = e.latlng;
    if (mode === "pick-property") {
      setMode("none");
      await busy(null, "", async () => {
        const p = await api(`/api/property-at?lat=${lat}&lon=${lng}`);
        await useProperty(p);
      });
    } else if (mode === "pick-circle") {
      setMode("none");
      await busy(null, "", async () => {
        const r = await api(`/api/buildings-around?lat=${lat}&lon=${lng}&r=250`);
        setArea({ kind: "circle", display: "250 m säde", geometry: r.area, center: [lat, lng] });
        setBuildings(r.buildings);
      });
    } else if (mode === "add-building") {
      setMode("none");
      const id = "k" + Date.now().toString(36);
      const nb = decorate({
        mtk_id: id, manual: true, class_label: "Käsin lisätty", kohdeluokka: 0, default_use: "muu", floors: 1,
        footprint_m2: null, is_point: true, on_property: true,
        geometry: { type: "Point", coordinates: [lng, lat] },
      }, true);
      nb.name = `Rakennus ${state.buildings.filter((b) => b.manual).length + 1}`;
      nb.area_default = true;   // 100 m² until the user gives the real area
      state.buildings.push(nb);
      if (!state.area) setArea({ kind: "manual", display: "Käsin lisätyt", geometry: null, center: [lat, lng] });
      renderAll();
      focusBuilding(id);
    }
  });

  function drawArea() {
    if (layers.area) { map.removeLayer(layers.area); layers.area = null; }
    if (!state.area || !state.area.geometry) return;
    layers.area = L.geoJSON(state.area.geometry, {
      style: { color: getCss("--accent"), weight: 2, dashArray: "6 5", fill: true, fillOpacity: 0.04 },
      interactive: false,
    }).addTo(map);
  }

  function getCss(v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }

  function drawBuildings() {
    layers.buildings.clearLayers();
    for (const k in shapes) delete shapes[k];
    const accent = getCss("--accent"), heat = getCss("--heat"), elc = getCss("--el"), nb = getCss("--neighbour");
    for (const b of state.buildings) {
      const col = (b.scope || "both") === "el" ? elc : heat;
      const style = b.heated
        ? { color: col, weight: 2, fillColor: col, fillOpacity: 0.55 }
        : b.on_property
          ? { color: accent, weight: 1.5, fillColor: accent, fillOpacity: 0.12 }
          : { color: nb, weight: 1, fillColor: nb, fillOpacity: 0.12, dashArray: "3 3" };
      let lyr;
      if (b.geometry.type === "Point" || b.geometry.type === "MultiPoint") {
        const c = b.geometry.type === "Point" ? b.geometry.coordinates : b.geometry.coordinates[0];
        lyr = L.circleMarker([c[1], c[0]], { ...style, radius: 7 });
      } else {
        lyr = L.geoJSON(b.geometry, { style: () => style });
      }
      lyr.bindTooltip(`<strong>${esc(b.name)}</strong><br>${inCalc(b)}<br>${esc(b.class_label)}${b.footprint_m2 ? `<br>${fmt(b.footprint_m2)} m²` : ""}`
        + `<br><small>Klikkaa: mukaan tai pois laskennasta</small>`, { className: "bt", sticky: true });
      lyr.on("click", (ev) => { L.DomEvent.stopPropagation(ev); toggleHeated(b.id); focusBuilding(b.id); });
      lyr.addTo(layers.buildings);
      shapes[b.id] = lyr;
    }
  }

  // ------------------------------------------------------------------ area & buildings
  function setArea(a) {
    state.area = a;
    state.result = null;
    lastResult = null;
    drawArea();
    if (layers.area) map.fitBounds(layers.area.getBounds(), { padding: [30, 30], maxZoom: 17 });
    const chip = $("#areaChip");
    chip.textContent = a.kind === "property" ? `Kiinteistö ${a.display}, ${fmt(a.area_ha, 1)} ha` : a.display;
    chip.hidden = false;
    loadStations();
  }

  async function useProperty(p) {
    const g = L.geoJSON(p.geometry).getBounds().getCenter();
    setArea({ kind: "property", display: p.display, kt: p.kiinteistotunnus, area_ha: p.area_ha, geometry: p.geometry, center: [g.lat, g.lng] });
    $("#kt").value = p.display;
    const r = await api("/api/buildings", { body: { geometry: p.geometry } });
    setBuildings(r.buildings);
    const n = state.buildings.filter((b) => b.on_property).length;
    toast(`${n} rakennusta kiinteistöllä, ${state.buildings.length - n} naapureilla.`);
  }

  function suggestUse(b) {
    if (b.default_use === "tuotanto") return (b.footprint_m2 || 0) >= PROD_MIN_M2 ? state.mainUse : "korjaamo";
    return b.default_use || "muu";
  }

  function decorate(b, heated) {
    const use = suggestUse(b);
    const area = b.footprint_m2 ? Math.round(b.footprint_m2 * (b.floors || 1)) : 100;
    return {
      ...b,
      id: String(b.mtk_id),
      name: b.manual ? "Rakennus" : `${META.use_types[use]?.label || b.class_label}`,
      use,
      heated_m2: area,
      heated: heated,
      suggested: !b.manual,
      circuit: state.circuits[0].id,
      meter: state.meters[0].id,
      cycle: { batch_days: 35, empty_days: 12, preheat_days: 2, first_placement_doy: 5 },
    };
  }

  function setBuildings(list) {
    const isSuggestedHeated = (b) => b.on_property && (b.default_use === "asuin" || (b.default_use === "tuotanto" && (b.footprint_m2 || 0) >= PROD_MIN_M2));
    state.buildings = list.map((b) => decorate(b, isSuggestedHeated(b)));
    // number duplicate names: "Broilerikasvattamo 1", "… 2"
    const counts = {};
    state.buildings.forEach((b) => { if (b.on_property) counts[b.name] = (counts[b.name] || 0) + 1; });
    const seen = {};
    state.buildings.forEach((b) => {
      if (b.on_property && counts[b.name] > 1) { seen[b.name] = (seen[b.name] || 0) + 1; b.name = `${b.name} ${seen[b.name]}`; }
      if (!b.on_property) b.name = `Naapuri: ${b.class_label}`;
    });
    state.result = null;
    renderAll();
  }

  const SCOPE_TEXT = { both: "lämpö ja sähkö", heat: "vain lämpö", el: "vain sähkö" };
  function inCalc(b) {
    return b.heated ? `<b>mukana laskennassa</b> (${SCOPE_TEXT[b.scope || "both"] || "lämpö ja sähkö"})` : "ei mukana laskennassa";
  }

  function toggleHeated(id, value) {
    const b = state.buildings.find((x) => x.id === id);
    if (!b) return;
    b.heated = value === undefined ? !b.heated : value;
    b.suggested = false;
    state.result = null;
    renderAll();
  }

  function focusBuilding(id) {
    const el = document.querySelector(`.bitem[data-id="${CSS.escape(id)}"]`);
    if (!el) return;
    document.querySelectorAll(".bitem.focus").forEach((x) => x.classList.remove("focus"));
    el.classList.add("focus");
    el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  function useOptions(sel) {
    return Object.entries(META.use_types).map(([k, v]) => `<option value="${k}"${k === sel ? " selected" : ""}>${esc(v.label)}</option>`).join("");
  }
  function groupOptions(list, sel) {
    return list.map((g) => `<option value="${esc(g.id)}"${g.id === sel ? " selected" : ""}>${esc(g.name)}</option>`).join("");
  }

  function doyToDate(doy) {
    const d = new Date(Date.UTC(state.year, 0, 1 + Number(doy || 0)));
    return d.toISOString().slice(0, 10);
  }
  function dateToDoy(s) {
    const d = new Date(s + "T00:00:00Z");
    return Math.max(0, Math.round((d - Date.UTC(state.year, 0, 1)) / 86400000));
  }

  function renderBuildings() {
    const host = $("#buildingList");
    if (!state.buildings.length) {
      host.innerHTML = `<p class="empty">${state.area ? "Alueelta ei löytynyt rakennuksia. Lisää rakennus kartalle käsin." : "Hae ensin tila kohdassa 1."}</p>`;
      return;
    }
    host.innerHTML = state.buildings.map((b) => {
      const meta = [b.class_label, b.footprint_m2 ? `pohja ${fmt(b.footprint_m2)} m² × ${b.floors} krs` : "pistekohde, ala ei tiedossa"].join(", ");
      const body = b.heated ? `
        <div class="bbody">
          <label class="full">Nimi<input data-f="name" value="${esc(b.name)}"></label>
          <label>Käyttö<select data-f="use">${useOptions(b.use)}</select></label>
          <label>Mukana<select data-f="scope">${[["both", "lämpö ja sähkö"], ["heat", "vain lämpö"], ["el", "vain sähkö"]].map(([k, l]) => `<option value="${k}"${(b.scope || "both") === k ? " selected" : ""}>${l}</option>`).join("")}</select></label>
          <label>${(b.scope || "both") === "el" ? "Ala, m²" : "Lämmitetty ala, m²"}<input data-f="heated_m2" type="number" min="1" step="10" required value="${esc(b.heated_m2)}"></label>
          ${(b.scope || "both") !== "el" ? `<label>Lämmitysjärjestelmä<select data-f="circuit">${groupOptions(state.circuits, b.circuit)}</select></label>` : ""}
          ${(b.scope || "both") !== "heat" ? `<label>Sähkömittari<select data-f="meter">${groupOptions(state.meters, b.meter)}</select></label>` : ""}
          ${(b.scope || "both") !== "el" ? `<label title="Esim. rakennuksen oma kattila tai lämpömäärämittari (alamittari).">Tunnettu lämpö, MWh/v<input data-f="known_heat_mwh" type="number" min="0" step="any" placeholder="valinnainen" value="${esc(b.known_heat_mwh ?? "")}"></label>` : ""}
          ${(b.scope || "both") !== "heat" ? `<label>Tunnettu sähkö, MWh/v<input data-f="known_el_mwh" type="number" min="0" step="any" placeholder="valinnainen" value="${esc(b.known_el_mwh ?? "")}"></label>` : ""}
          ${b.known_heat_mwh || b.known_el_mwh ? `<p class="note">Tunnettu kulutus kohdistetaan tälle rakennukselle (esim. oma kattila tai alamittari). Mittarin tai piirin muu kulutus jaetaan muille rakennuksille.</p>` : ""}
          ${b.use === "broileri" ? `
          <label>Kasvatuserä, vrk<input data-c="batch_days" type="number" min="20" max="60" value="${b.cycle.batch_days}"></label>
          <label>Tyhjä jakso, vrk<input data-c="empty_days" type="number" min="1" max="40" value="${b.cycle.empty_days}"></label>
          <label>Ensimmäinen sisäänotto<input data-c="first_placement" type="date" value="${doyToDate(b.cycle.first_placement_doy)}"></label>
          <label>Esilämmitys, vrk<input data-c="preheat_days" type="number" min="0" max="5" value="${b.cycle.preheat_days}"></label>
          <p class="note">Lämmitys painottuu erän alkuun: asetuslämpö laskee 30 °C:sta 20 °C:een 27 vuorokaudessa (Aviagen 2025) ja lintujen lämmöntuotto kasvaa erän aikana. Tyhjänä halli pidetään +8 °C:ssa. Jos hallit ovat eri vaiheessa, anna niille eri sisäänottopäivä; muuten huiput osuvat päällekkäin.</p>` : ""}
          ${b.is_point && !b.manual ? `<p class="note">MML:ssä tästä rakennuksesta on vain piste. Anna lämmitetty ala itse.</p>` : ""}
          ${b.area_default ? `<p class="note warnline">Ala on oletus 100 m². Anna rakennuksen todellinen lämmitetty ala.</p>` : ""}
          ${b.manual ? `<p class="note"><button type="button" class="btn small" data-remove="1">Poista rakennus</button></p>` : ""}
        </div>` : "";
      return `<div class="bitem${b.heated ? " on" : ""}${b.on_property ? "" : " neighbour"}" data-id="${esc(b.id)}">
        <div class="bhead">
          <input type="checkbox" aria-label="Mukana laskennassa" ${b.heated ? "checked" : ""}>
          <div class="btitle"><strong>${esc(b.name)}${b.suggested && b.heated ? '<span class="tag">ehdotus</span>' : ""}</strong><span>${esc(meta)}</span></div>
          <div class="barea">${b.heated ? fmt(b.heated_m2) + " m²" : ""}</div>
        </div>${body}</div>`;
    }).join("");
  }

  $("#buildingList").addEventListener("click", (e) => {
    const item = e.target.closest(".bitem");
    if (!item) return;
    const id = item.dataset.id;
    if (e.target.dataset.remove) {
      state.buildings = state.buildings.filter((b) => b.id !== id);
      renderAll();
      return;
    }
    if (e.target.closest(".bhead")) {
      if (e.target.type === "checkbox") toggleHeated(id, e.target.checked);
      const lyr = shapes[id];
      if (lyr) {
        if (lyr.getBounds) map.fitBounds(lyr.getBounds(), { maxZoom: Math.max(map.getZoom(), 16), padding: [80, 80] });
        else map.panTo(lyr.getLatLng());
      }
    }
  });
  $("#buildingList").addEventListener("change", (e) => {
    const item = e.target.closest(".bitem");
    if (!item) return;
    const b = state.buildings.find((x) => x.id === item.dataset.id);
    if (!b) return;
    const f = e.target.dataset.f, c = e.target.dataset.c;
    const numeric = { heated_m2: true, known_heat_mwh: true, known_el_mwh: true };
    if (f === "heated_m2") {
      const v = Number(e.target.value);
      if (e.target.value === "" || !Number.isFinite(v) || v <= 0) {
        toast("Alan pitää olla suurempi kuin 0 m². Poista rakennus laskennasta valintaruudusta, jos se ei kuulu mukaan.", true);
        e.target.value = b.heated_m2;
        return;
      }
      b.area_default = false;
    }
    if ((f === "known_heat_mwh" || f === "known_el_mwh") && e.target.value !== "" && Number(e.target.value) < 0) {
      toast("Tunnettu kulutus ei voi olla negatiivinen.", true);
      e.target.value = b[f] ?? "";
      return;
    }
    if (f) b[f] = numeric[f] ? (e.target.value === "" ? null : Number(e.target.value)) : e.target.value;
    if (c === "first_placement") b.cycle.first_placement_doy = dateToDoy(e.target.value);
    else if (c) b.cycle[c] = Number(e.target.value) || 0;
    b.suggested = false;
    state.result = null;
    if (["use", "name", "scope", "known_heat_mwh", "known_el_mwh", "heated_m2"].includes(f)) renderAll(); else if (rendering) renderPending = true; else { saveDraft(); renderChecklist(); renderGroups(); drawBuildings(); renderResults(); }
  });

  // ------------------------------------------------------------------ energy data
  const KINDS = [["none", "Ei tietoa"], ["annual", "Vuosi"], ["monthly", "Kuukaudet"], ["hourly", "Tuntitiedosto"]];

  // Heating system of a circuit decides which units make sense; electric heating runs through an electricity meter.
  const SYSTEM_UNITS = {
    fuel: ["i-m3", "MWh_pa", "t_pelletti", "l_oljy", "kWh", "MWh"],
    district: ["MWh", "kWh"],
    electric: ["MWh_el", "kWh_el", "MWh", "kWh"],
    heatpump: ["MWh_el", "kWh_el", "MWh", "kWh"],
  };
  const isElectric = (d) => d.system === "electric" || d.system === "heatpump";
  // an electric circuit without its own data gets its heat from the meter's data
  const fromMeter = (g) => isElectric(g.data) && g.data.kind === "none" && !!elMeterOf(g) && hasGroupData(elMeterOf(g));
  function elMeterOf(g) { return state.meters.find((m) => m.id === g.data.el_meter) || state.meters[0]; }
  function hasGroupData(g) { return g.data.kind !== "none" && !(g.data.kind === "hourly" && !g.data.values); }

  function groupCard(g, type) {
    const list = type === "heat" ? state.circuits : state.meters;
    const inScope = (b) => (type === "heat" ? (b.scope || "both") !== "el" : (b.scope || "both") !== "heat");
    const members = state.buildings.filter((b) => b.heated && inScope(b) && (type === "heat" ? b.circuit : b.meter) === g.id);
    const d = g.data;
    const sys = d.system || "fuel";
    const unitKeys = type === "heat" ? SYSTEM_UNITS[sys] || SYSTEM_UNITS.fuel : ["kWh", "MWh"];
    if (!unitKeys.includes(d.unit)) d.unit = unitKeys[0];
    const units = unitKeys.map((k) => `<option value="${k}"${k === d.unit ? " selected" : ""}>${esc(type === "heat" ? META.heat_units[k] || k : k)}</option>`).join("");
    const unitSelect = `<select data-d="unit" aria-label="Yksikkö">${units}</select>`;
    const isFuel = type === "heat" && sys === "fuel" && !["kWh", "MWh"].includes(d.unit);
    const sysRow = type === "heat" ? `<div class="row wrap">
        <label class="inline">Lämmitystapa<select data-d="system">${Object.entries(META.heating_systems || { fuel: "Kattila" }).map(([k, v]) => `<option value="${k}"${k === sys ? " selected" : ""}>${esc(v)}</option>`).join("")}</select></label>
        ${isElectric(d) ? `<label class="inline">Sähkö mittarista<select data-d="el_meter">${state.meters.map((m) => `<option value="${esc(m.id)}"${m.id === elMeterOf(g)?.id ? " selected" : ""}>${esc(m.name)}</option>`).join("")}</select></label>` : ""}
        ${sys === "heatpump" ? `<label class="inline" title="Lämpöpumpun vuosihyötysuhde: lämpöä kWh sähkön kWh:ta kohden. Maalämpö tyypillisesti 3–3,5, ilma-vesi 2,5–3.">SCOP<input data-d="cop" type="number" min="1" max="6" step="0.1" value="${esc(d.cop ?? 3)}" style="width:72px"></label>` : ""}
      </div>` : "";
    let input = "";
    if (d.kind === "annual") {
      input = `<div class="row wrap"><input data-d="value" type="number" min="0" step="any" placeholder="Vuosikulutus" aria-label="Vuosikulutus" value="${esc(d.value ?? "")}" style="flex:1">
        ${unitSelect}</div>`;
    } else if (d.kind === "monthly") {
      const m = d.months || [];
      input = `<div class="row wrap"><span class="hint">Yksikkö</span>${unitSelect}</div>
        <div class="months">${MONTHS.map((n, i) => `<label>${n}<input data-m="${i}" type="number" min="0" step="any" value="${esc(m[i] ?? "")}"></label>`).join("")}</div>`;
    } else if (d.kind === "hourly") {
      const s = d.parsed;
      input = `${type === "heat" && isElectric(d) ? `<div class="row wrap"><span class="hint">Tiedoston sisältö</span><select data-d="unit" aria-label="Tiedoston sisältö">
          <option value="kWh_el"${d.unit === "kWh_el" || d.unit === "MWh_el" ? " selected" : ""}>lämmityssähkö (alamittari)</option>
          <option value="kWh"${d.unit === "kWh" || d.unit === "MWh" ? " selected" : ""}>lämpö (lämpömittari)</option></select></div>` : ""}
        ${!s ? `<p class="hint warnline">Tiedosto puuttuu${d.values === null ? " (vuoden vaihto poisti edellisen)" : ""}: valitse vuoden ${state.year} tiedosto.</p>` : ""}
        <label class="btn small file">${s ? "Vaihda tiedosto" : "Valitse tiedosto (Datahub tai mittarin CSV)"}<input type="file" data-file="1" accept=".csv,.txt,text/csv"></label>
        ${s ? `<div class="summary">${esc(s.file)}: <span class="nums">${fmt(s.hours_complete)}</span> / 8 760 tuntia,
          resoluutio ${s.resolution_min} min, yhteensä <span class="nums">${fmt(s.total_kwh / 1000, 1)}</span> MWh.
          ${s.hours_missing ? `Puuttuvat ${fmt(s.hours_missing)} tuntia täydennetään mallilla.` : ""}
          ${(s.notes || []).map((n) => `<br>${esc(n)}`).join("")}</div>` : ""}`;
    }
    const eff = isFuel && d.kind !== "hourly" && d.kind !== "none" ? `<div class="row wrap">
        <label class="inline">Kattilan hyötysuhde<input data-d="efficiency" type="number" min="0.3" max="1.1" step="0.01" value="${esc(d.efficiency ?? 0.85)}" style="width:80px"></label>
        ${d.unit === "i-m3" ? `<label class="inline">Hake, MWh/i-m³<input data-d="chip_density" type="number" min="0.5" max="1.2" step="0.05" value="${esc(d.chip_density ?? 0.8)}" style="width:80px"></label>` : ""}
      </div>` : "";
    const capLabel = sys === "heatpump" ? "Lämpöpumpun teho" : sys === "district" ? "Liittymäteho" : sys === "electric" ? "Lämmitysteho" : "Kattilan teho";
    const opts = type === "heat" ? `<div class="row wrap">
        ${d.kind === "annual" ? `<label class="inline" title="Käyttövesi, pesut ja muu säästä riippumaton lämpö. Tyhjä = mallin oletus.">Säästä riippumaton osuus, %<input data-d="base_share_pct" type="number" min="0" max="100" step="1" placeholder="oletus" value="${esc(d.base_share_pct ?? "")}" style="width:80px"></label>` : ""}
        <label class="inline" title="Nimellisteho (laskurin D14). Huipputehoa verrataan siihen.">${capLabel}, kW<input data-d="capacity_kw" type="number" min="0" step="10" placeholder="valinnainen" value="${esc(d.capacity_kw ?? "")}" style="width:90px"></label>
      </div>` : "";
    let noneHint = "";
    if (d.kind === "none") {
      noneHint = type === "heat" && fromMeter(g)
        ? `<p class="hint">Lämmityssähköä ei mitata erikseen: se erotetaan mittarin <em>${esc(elMeterOf(g).name)}</em> kulutuksesta sovitteella.</p>`
        : `<p class="hint">Ilman kulutustietoa tulos on mallin oletus eikä kuvaa tilaa.${type === "heat" && isElectric(d) ? " Anna mittarille kulutus, niin lämmityssähkö erotetaan siitä." : ""}</p>`;
    }
    const elHint = type === "heat" && isElectric(d) && d.kind !== "none"
      ? `<p class="hint">Lämmityssähkö vähennetään mittarin <em>${esc(elMeterOf(g)?.name || "")}</em> kulutuksesta, jotta sitä ei lasketa kahteen kertaan.</p>` : "";
    const elsewhere = type === "el" ? state.circuits.filter((c) => isElectric(c.data) && elMeterOf(c)?.id === g.id) : [];
    const meterHint = elsewhere.length ? `<p class="hint">Mittarin kautta kulkee myös lämmityssähkö: ${elsewhere.map((c) => esc(c.name)).join(", ")}. Anna mittarin koko kulutus; lämmityksen osuus erotetaan.</p>` : "";
    return `<div class="gcard" data-type="${type}" data-id="${esc(g.id)}">
      <header><span class="gtype ${type}"></span><input data-g="name" value="${esc(g.name)}" aria-label="${type === "heat" ? "Lämmitysjärjestelmän nimi" : "Sähkömittarin nimi"}">
        ${list.length > 1 ? `<button type="button" class="iconbtn" data-del="1" title="Poista" aria-label="Poista">×</button>` : ""}</header>
      <div class="gmembers">${type === "heat" ? "Lämpö" : "Sähkö"}: ${members.length ? members.map((b) => esc(b.name)).join(", ") : "ei rakennuksia"}</div>
      ${sysRow}
      <div class="seg" role="group" aria-label="Kulutustiedon tyyppi">${KINDS.map(([k, l]) => `<button type="button" data-kind="${k}" class="${d.kind === k ? "on" : ""}" aria-pressed="${d.kind === k}">${l}</button>`).join("")}</div>
      ${input}${eff}${opts}${noneHint}${elHint}${meterHint}
    </div>`;
  }

  function renderGroups() {
    $("#groupCards").innerHTML = state.circuits.map((g) => groupCard(g, "heat")).join("") + state.meters.map((g) => groupCard(g, "el")).join("");
  }

  function findGroup(card) {
    const list = card.dataset.type === "heat" ? state.circuits : state.meters;
    return { list, g: list.find((x) => x.id === card.dataset.id) };
  }

  $("#groupCards").addEventListener("click", (e) => {
    const card = e.target.closest(".gcard");
    if (!card) return;
    const { list, g } = findGroup(card);
    if (e.target.dataset.kind) { g.data.kind = e.target.dataset.kind; state.result = null; renderAll(); }
    if (e.target.dataset.del) {
      list.splice(list.indexOf(g), 1);
      const key = card.dataset.type === "heat" ? "circuit" : "meter";
      state.buildings.forEach((b) => { if (b[key] === g.id) b[key] = list[0].id; });
      renderAll();
    }
  });
  $("#groupCards").addEventListener("change", async (e) => {
    const card = e.target.closest(".gcard");
    if (!card) return;
    const { g } = findGroup(card);
    const t = e.target;
    if (t.dataset.g) g.name = t.value;
    if (t.dataset.d) g.data[t.dataset.d] = t.type === "number" ? (t.value === "" ? null : Number(t.value)) : t.value;
    if (t.dataset.m !== undefined) {
      g.data.months = g.data.months || Array(12).fill(null);
      g.data.months[Number(t.dataset.m)] = t.value === "" ? null : Number(t.value);
    }
    if (t.dataset.file && t.files[0]) {
      const f = t.files[0];
      await busy(null, "", async () => {
        const text = await f.text();
        const p = await api("/api/parse-series", { body: { text, kind: "energy", year: state.year } });
        g.data.values = p.values;
        g.data.parsed = { file: f.name, hours_complete: p.hours_complete, hours_missing: p.hours_missing, resolution_min: p.resolution_min, total_kwh: p.total_kwh, notes: p.notes };
        toast(`Luettu ${fmt(p.hours_complete)} tuntia (${p.value_column}).`);
      });
    }
    state.result = null;
    if (t.dataset.d === "system") { g.data.unit = (SYSTEM_UNITS[t.value] || SYSTEM_UNITS.fuel)[0]; if (t.value === "heatpump" && g.data.cop == null) g.data.cop = 3; }
    if (t.dataset.g || ["unit", "system", "el_meter", "cop"].includes(t.dataset.d) || t.dataset.file) renderAll(); else if (rendering) renderPending = true; else { saveDraft(); renderChecklist(); renderResults(); }
  });

  $("#addCircuit").onclick = () => {
    const id = "c" + (Date.now() % 1e6);
    state.circuits.push({ id, name: `Lämmitysjärjestelmä ${state.circuits.length + 1}`, data: { kind: "none", system: "fuel", unit: "i-m3", efficiency: 0.85 } });
    renderAll();
  };
  $("#addMeter").onclick = () => {
    const id = "m" + (Date.now() % 1e6);
    state.meters.push({ id, name: `Sähkömittari ${state.meters.length + 1}`, data: { kind: "none", unit: "kWh" } });
    renderAll();
  };

  // ------------------------------------------------------------------ weather
  async function loadStations() {
    if (!state.area || !state.area.center) return;
    const [lat, lon] = state.area.center;
    $("#stationList").innerHTML = `<p class="empty">Haetaan lähimpiä asemia…</p>`;
    try {
      const r = await api(`/api/weather/stations?lat=${lat}&lon=${lon}&year=${state.year}`);
      state.stations = r.stations;
    } catch (e) {
      state.stations = [];
      toast(e.message, true);
    }
    renderStations();
  }

  function renderStations() {
    const host = $("#stationList");
    if (!state.area) { host.innerHTML = `<p class="empty">Asemat haetaan, kun tila on valittu.</p>`; return; }
    const ch = state.weatherChoice || {};
    const rows = state.stations.map((s) => `
      <label class="station${ch.type === "fmi" && ch.fmisid === s.fmisid ? " on" : ""}">
        <input type="radio" name="wx" data-fmisid="${s.fmisid}" ${ch.type === "fmi" && ch.fmisid === s.fmisid ? "checked" : ""}>
        <span>${esc(s.name)}<small>FMI-asema ${s.fmisid}${s.begin ? `, havainnot vuodesta ${s.begin.slice(0, 4)}` : ""}</small></span>
        <span class="dist">${fmt(s.distance_km, 1)} km</span>
      </label>`).join("");
    host.innerHTML = rows + `
      <label class="station${ch.type === "open-meteo" ? " on" : ""}">
        <input type="radio" name="wx" data-om="1" ${ch.type === "open-meteo" ? "checked" : ""}>
        <span>Open-Meteo tilan kohdalla<small>ERA5-uudelleenanalyysi, ei havaintoasema</small></span>
        <span class="dist">0 km</span>
      </label>`;
  }

  $("#stationList").addEventListener("change", async (e) => {
    const t = e.target;
    if (t.name !== "wx" || !state.area) return;
    const [lat, lon] = state.area.center;
    const url = t.dataset.om
      ? `/api/weather/open-meteo?lat=${lat}&lon=${lon}&year=${state.year}`
      : `/api/weather/fmi?fmisid=${t.dataset.fmisid}&year=${state.year}&lat=${lat}&lon=${lon}`;
    state.weatherChoice = t.dataset.om ? { type: "open-meteo" } : { type: "fmi", fmisid: Number(t.dataset.fmisid) };
    renderStations();
    $("#weatherSummary").hidden = false;
    $("#weatherSummary").textContent = "Haetaan säätietoja vuodelta " + state.year + "…";
    await busy(null, "", async () => {
      const w = await api(url);
      const st = state.stations.find((s) => s.fmisid === state.weatherChoice.fmisid);
      w.label = t.dataset.om ? "Open-Meteo tilan kohdalla" : `${st ? st.name : "FMI"} (${fmt(st?.distance_km, 1)} km)`;
      setWeather(w);
    });
  });

  $("#tempFile").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    await busy(null, "", async () => {
      const p = await api("/api/parse-series", { body: { text: await f.text(), kind: "temperature", year: state.year } });
      state.weatherChoice = { type: "file" };
      const vals = p.values.filter((v) => v != null);
      setWeather({ label: f.name, source: "Oma tiedosto", attribution: "", values: p.values, missing: p.missing, interpolated: p.interpolated,
        mean: vals.reduce((a, b) => a + b, 0) / vals.length, min: Math.min(...vals), max: Math.max(...vals) });
      renderStations();
    });
    e.target.value = "";
  });

  function setWeather(w) {
    state.weather = w;
    state.result = null;
    renderWeather();
    renderChecklist();
    saveDraft();
    renderResults();
  }

  function renderWeather() {
    const w = state.weather, el = $("#weatherSummary");
    if (!w) { el.hidden = true; return; }
    el.hidden = false;
    el.innerHTML = `<strong>${esc(w.label)}</strong>, vuosi ${state.year}<br>
      <span class="nums">keskiarvo ${fmt(w.mean, 1)} °C, min ${fmt(w.min, 1)}, max ${fmt(w.max, 1)}</span><br>
      ${w.interpolated ? `${fmt(w.interpolated)} tuntia interpoloitu. ` : ""}${w.patched ? `${fmt(w.patched)} tuntia täydennetty Open-Meteosta. ` : ""}
      ${w.missing ? `<span style="color:var(--bad)">${fmt(w.missing)} tuntia puuttuu. Valitse toinen lähde.</span>` : "Sarja on täydellinen."}`;
  }

  // ------------------------------------------------------------------ model
  function projectPayload() {
    return {
      year: state.year,
      temperature: state.weather ? state.weather.values : [],
      buildings: state.buildings.filter((b) => b.heated).map((b) => ({
        id: b.id, name: b.name, use: b.use, heated_m2: b.heated_m2, heated: true, circuit: b.circuit, meter: b.meter,
        scope: b.scope || "both", known_heat_mwh: b.known_heat_mwh ?? null, known_el_mwh: b.known_el_mwh ?? null,
        cycle: b.use === "broileri" ? b.cycle : undefined,
      })),
      circuits: state.circuits.map((g) => ({ id: g.id, name: g.name, data: { ...g.data, parsed: undefined } })),
      meters: state.meters.map((g) => ({ id: g.id, name: g.name, data: { ...g.data, parsed: undefined } })),
    };
  }

  // ------------------------------------------------------------------ spot prices
  function renderPrices() {
    const p = state.prices[state.year], el = $("#priceSummary");
    $("#fetchPrices").textContent = `Hae vuoden ${state.year} hinnat`;
    const years = Object.keys(state.prices).map(Number).filter((y) => y >= 2023 && y <= 2026).sort();
    $("#priceActions").hidden = years.length === 0;
    if (!p && !years.length) { el.hidden = true; return; }
    el.hidden = false;
    const lines = [];
    if (p) {
      lines.push(`<strong>${state.year}</strong>: <span class="nums">${fmt(p.hours)}</span> / 8 760 tuntia, keskiarvo <span class="nums">${fmt(p.mean, 2)}</span> €/MWh,
        min <span class="nums">${fmt(p.min, 2)}</span>, max <span class="nums">${fmt(p.max, 2)}</span>, negatiivisia <span class="nums">${fmt(p.negative)}</span> h`);
      if (p.missing) lines.push(p.future >= p.missing - 1
        ? `Vuosi on kesken: ${fmt(p.missing)} tuntia puuttuu. Laskuri täyttää puuttuvat tunnit muiden vuosien keskiarvolla.`
        : `<span style="color:var(--warn)">${fmt(p.missing)} tuntia puuttuu lähteestä.</span>`);
    } else lines.push(`Vuoden ${state.year} hintoja ei ole haettu.`);
    if (years.length) lines.push(`Haettu Hintahistoriaan: ${years.join(", ")}`);
    el.innerHTML = lines.join("<br>");
  }
  async function fetchPriceYears(years, btn) {
    await busy(btn, "Haetaan…", async () => {
      for (const y of years) state.prices[y] = await api(`/api/prices?year=${y}`);
      renderPrices(); renderChecklist(); saveDraft();
      if (state.result && years.includes(state.result.year)) renderResults();
      toast(years.length > 1 ? `Hinnat haettu vuosille ${years.join(", ")}.` : `Vuoden ${years[0]} hinnat haettu.`);
    });
  }
  $("#fetchPrices").onclick = (e) => fetchPriceYears([state.year], e.currentTarget);
  $("#fetchAllPrices").onclick = (e) => {
    const cy = new Date().getFullYear();
    fetchPriceYears([2023, 2024, 2025, 2026].filter((y) => y <= cy), e.currentTarget);
  };
  const priceBody = () => ({ prices: Object.fromEntries(Object.entries(state.prices).map(([y, p]) => [y, p.values])) });
  $("#dlPrices").onclick = (e) => busy(e.currentTarget, "Ladataan…", async () => {
    download("hintahistoria_2023-2026.csv", await api("/api/export/hintahistoria", { body: priceBody() }), "text/csv;charset=utf-8");
  });
  $("#copyPrices").onclick = (e) => busy(e.currentTarget, "Kopioidaan…", async () => {
    const txt = await api("/api/export/paste-prices", { body: priceBody() });
    try { await navigator.clipboard.writeText(txt); toast("Hinnat kopioitu. Liitä Hintahistoria-välilehden soluun C2 (Liitä määräten → Arvot)."); }
    catch (_) { download("hintahistoria_C-F.txt", txt, "text/plain"); toast("Leikepöytä ei ollut käytettävissä; rivit tallennettiin tiedostoon."); }
  });

  function checks() {
    const heated = state.buildings.filter((b) => b.heated);
    const used = (g, key, scopes) => heated.some((b) => b[key] === g.id && scopes.includes(b.scope || "both"));
    const usedGroups = [...state.circuits.filter((g) => used(g, "circuit", ["both", "heat"])), ...state.meters.filter((g) => used(g, "meter", ["both", "el"]))];
    const noData = usedGroups.filter((g) => !hasGroupData(g) && !(state.circuits.includes(g) && fromMeter(g)));
    const defaults = heated.filter((b) => b.area_default);
    const dataCheck = !heated.length
      ? { ok: false, text: "Kulutustiedot: valitse ensin rakennukset" }
      : noData.length
        ? { ok: false, warn: true, text: `Kulutustieto puuttuu: ${noData.map((g) => g.name).join(", ")} (tulos on mallin oletus)` }
        : { ok: true, text: "Kulutustiedot annettu" };
    return [
      { ok: !!state.area, text: state.area ? `Alue: ${state.area.display}` : "Valitse tila" },
      { ok: heated.length > 0 && !defaults.length, warn: defaults.length > 0,
        text: !heated.length ? "Valitse rakennukset"
          : `${heated.length} rakennusta mukana, ${fmt(heated.filter((b) => (b.scope || "both") !== "el").reduce((a, b) => a + (b.heated_m2 || 0), 0))} m² lämmitettyä`
            + (defaults.length ? `; oletusala 100 m²: ${defaults.map((b) => b.name).join(", ")}` : "") },
      dataCheck,
      { ok: !!state.weather && !state.weather.missing, warn: !!state.weather && !!state.weather.missing,
        text: !state.weather ? "Valitse säätiedot" : state.weather.missing ? `Säätiedoista puuttuu ${fmt(state.weather.missing)} tuntia (kesken oleva vuosi?)` : `Sää: ${state.weather.label}` },
      { ok: !!state.prices[state.year], text: state.prices[state.year] ? `Pörssihinnat ${state.year}: ${fmt(state.prices[state.year].hours)} tuntia` : `Pörssihinnat ${state.year} (valinnainen, CSV:n sarake H)` },
    ];
  }

  function renderChecklist() {
    $("#checklist").innerHTML = checks().map((c) => `<div class="${c.ok ? "ok" : c.warn ? "warn" : ""}">${esc(c.text)}</div>`).join("");
    const c = checks();
    $("#step1").classList.toggle("done", c[0].ok);
    $("#step2").classList.toggle("done", c[1].ok);
    $("#step3").classList.toggle("done", c[2].ok);
    $("#step4").classList.toggle("done", c[3].ok);
    $("#stepPrice").classList.toggle("done", c[4].ok);
    $("#runModel").disabled = !(state.buildings.some((b) => b.heated) && c[3].ok);
  }

  $("#runModel").onclick = (e) => busy(e.currentTarget, "Lasketaan…", async () => {
    state.result = await api("/api/model", { body: { project: projectPayload() } });
    renderResults();
    saveDraft();
    refresh3d();
  });

  function cvPill(rep) {
    if (rep.kind === "none") return `<span class="pill none">mallin oletus</span>`;
    if (rep.kind === "annual") return `<span class="pill none">vuosisumma</span>`;
    if (rep.kind === "from_meter") return `<span class="pill none">erotettu mittarista</span>`;
    if (rep.kind === "hourly" && !rep.hours_filled) return `<span class="pill ok">mitattu, ${fmt(rep.hours_measured)} h</span>`;
    if (rep.cv_rmse == null) return `<span class="pill none">–</span>`;
    const good = rep.cv_rmse <= rep.limit;
    return `<span class="pill ${good ? "ok" : "warn"}">CV(RMSE) ${fmt(rep.cv_rmse * 100, 1)} %${good ? "" : ` > ${fmt(rep.limit * 100)} %`}</span>`;
  }

  function barChart(values, colorVar, unitLabel, title) {
    const W = 340, H = 150, padL = 36, padB = 18, padT = 8;
    const max = Math.max(1, ...values);
    const step = niceStep(max / 3);
    const top = Math.ceil(max / step) * step;
    const bw = (W - padL - 6) / 12;
    const y = (v) => padT + (H - padT - padB) * (1 - v / top);
    let g = "";
    for (let v = 0; v <= top + 1e-9; v += step) {
      g += `<line class="grid" x1="${padL}" x2="${W - 4}" y1="${y(v)}" y2="${y(v)}"/><text x="${padL - 5}" y="${y(v) + 3.5}" text-anchor="end">${fmt(v, step < 1 ? 1 : 0)}</text>`;
    }
    const bars = values.map((v, i) => {
      const x = padL + i * bw + 2, h = Math.max(0, y(0) - y(v));
      const r = Math.min(4, h / 2);
      const top_ = y(v);
      const path = h > 0 ? `M${x},${y(0)} V${top_ + r} Q${x},${top_} ${x + r},${top_} H${x + bw - 4 - r} Q${x + bw - 4},${top_} ${x + bw - 4},${top_ + r} V${y(0)} Z` : "";
      return `<path d="${path}" fill="var(${colorVar})"/>
        <rect x="${padL + i * bw}" y="${padT}" width="${bw}" height="${H - padT - padB}" fill="transparent" data-tip="${MONTHS[i]}: ${fmt(v, 1)} ${unitLabel}"/>
        <text x="${x + (bw - 4) / 2}" y="${H - 5}" text-anchor="middle">${MONTHS[i].slice(0, 1)}</text>`;
    }).join("");
    return `<div class="chart"><h4>${esc(title)}</h4><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">${g}${bars}</svg></div>`;
  }
  // Load duration curve: the year's hours sorted from the highest load down. Boilers, heat pumps and CHP are sized from it.
  function durationChart(series, colorVar, title, capKw, capLabel) {
    const W = 340, H = 170, padL = 40, padB = 22, padT = 10, padR = 6;
    const sorted = Float64Array.from(series).sort().reverse();
    const max = Math.max(1, sorted[0], capKw || 0);
    const step = niceStep(max / 3), top = Math.ceil(max / step) * step;
    const x = (h) => padL + (W - padL - padR) * h / 8760;
    const y = (v) => padT + (H - padT - padB) * (1 - v / top);
    let g = "";
    for (let v = 0; v <= top + 1e-9; v += step) g += `<line class="grid" x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}"/><text x="${padL - 5}" y="${y(v) + 3.5}" text-anchor="end">${fmt(v, step < 1 ? 1 : 0)}</text>`;
    for (let h = 0; h <= 8760; h += 2000) g += `<text x="${x(h)}" y="${H - 6}" text-anchor="middle">${fmt(h)}</text>`;
    const idx = [0];
    for (let k = 1; k <= 360; k++) idx.push(Math.min(8759, Math.round(k * 8759 / 360)));
    const pts = idx.map((h) => `${x(h).toFixed(1)},${y(sorted[h]).toFixed(1)}`).join(" ");
    const area = `M${x(0)},${y(0)} L${pts.split(" ").join(" L")} L${x(8759)},${y(0)} Z`;
    let cap = "", capNote = "";
    if (capKw > 0) {
      const over = sorted.filter((v) => v > capKw).length;
      cap = `<line class="cap" x1="${padL}" x2="${W - padR}" y1="${y(capKw)}" y2="${y(capKw)}"/><text x="${W - padR}" y="${y(capKw) - 4}" text-anchor="end">${esc(capLabel)} ${fmt(capKw)} kW</text>`;
      capNote = `${capLabel} ${fmt(capKw)} kW${over ? `: ylittyy ${fmt(over)} tuntina` : ": riittää kaikkina tunteina"}.`;
    }
    const at = (kw) => sorted.filter((v) => v > kw).length;
    const p = sorted[0];
    const desc = `Huippu ${fmt(p, 1)} kW. Yli puolet huipusta ${fmt(at(p / 2))} h, yli neljännes ${fmt(at(p / 4))} h.`;
    const tips = [0, 100, 500, 1000, 2000, 4000, 6000, 8000].map((h) => `<circle class="dur-pt" cx="${x(h)}" cy="${y(sorted[Math.min(h, 8759)])}" r="5" data-tip="${fmt(h)} h: ${fmt(sorted[Math.min(h, 8759)], 1)} kW"/>`).join("");
    return `<div class="chart"><h4>${esc(title)}</h4><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title + ". " + desc)}">${g}
      <path d="${area}" fill="var(${colorVar})" fill-opacity="0.18"/><polyline points="${pts}" fill="none" stroke="var(${colorVar})" stroke-width="2"/>${cap}${tips}</svg>
      <p class="chart-note">${esc(desc)}${capNote ? " " + esc(capNote) : ""} Vaaka-akseli: tunnit vuodessa, suurimmasta tehosta alkaen.</p></div>`;
  }
  function niceStep(x) {
    const p = Math.pow(10, Math.floor(Math.log10(x || 1)));
    const n = x / p;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
  }

  // A change to buildings, consumption or weather makes the result stale. The last result stays on screen, dimmed and
  // without exports, until the profile is recalculated: the panel does not collapse, so the map does not jump under the cursor.
  let lastResult = null;
  let renderedAs = { result: null, stale: false };
  function renderResults() {
    const host = $("#results");
    if (state.result) lastResult = state.result;
    const r = state.result || lastResult;
    const stale = !state.result;
    if (!r) {
      renderedAs = { result: null, stale: false };
      if (!host.hidden) { host.hidden = true; host.innerHTML = ""; refreshMap(); }
      return;
    }
    // Already showing this result as stale: leave the DOM alone. Re-rendering here would replace the
    // "Laske uudelleen" button between mousedown and click when a field's change event fires on blur.
    if (stale && renderedAs.result === r && renderedAs.stale && !host.hidden) return;
    renderedAs = { result: r, stale };
    const wasHidden = host.hidden;
    host.hidden = false;
    host.classList.toggle("stale", stale);
    const t = r.totals;
    const names = Object.fromEntries(state.buildings.map((b) => [b.id, b.name]));
    const grpRows = [...r.calibration.circuits.map((c) => ({ ...c, type: "Lämpö" })), ...r.calibration.meters.map((c) => ({ ...c, type: "Sähkö" }))]
      .map((c) => `<tr><td>${esc(c.name)}<br><small style="color:var(--ink-3)">${c.type}</small></td>
        <td class="n">${fmt(c.annual_kwh / 1000, 1)}</td><td class="n">${fmt(c.peak_kw, 1)}${c.capacity_kw ? `<br><small style="color:${c.hours_over_capacity ? "var(--warn)" : "var(--ink-3)"}">/ ${fmt(c.capacity_kw)}</small>` : ""}</td>
        <td>${cvPill(c)}${c.warning ? `<br><small class="warnline">${esc(c.warning)}</small>` : ""}${c.note ? `<br><small style="color:var(--ink-3)">${esc(c.note)}</small>` : ""}</td></tr>`).join("");
    // specific consumption kWh/m² shows whether the calibration split the total plausibly between buildings
    const bById = Object.fromEntries(state.buildings.map((b) => [b.id, b]));
    const bRows = r.buildings.map((b) => {
      const sb = bById[b.id], m2 = sb && sb.heated_m2 > 0 ? sb.heated_m2 : null;
      const spec = m2 && (sb.scope || "both") !== "el" ? b.heat_kwh / m2 : null;
      const odd = spec != null && (spec < 20 || spec > 800);
      return `<tr><td>${esc(names[b.id] || b.id)}</td><td class="n">${fmt(b.electricity_kwh / 1000, 1)}</td>
      <td class="n">${fmt(b.heat_kwh / 1000, 1)}</td><td class="n${odd ? " warnline" : ""}"${odd ? ' title="Epätavallinen arvo: tarkista ala, käyttötyyppi tai tunnettu kulutus."' : ""}>${spec == null ? "–" : fmt(spec)}</td><td class="n">${fmt(b.heat_peak_kw, 1)}</td></tr>`;
    }).join("");
    const helKwh = t.heating_el_kwh || 0;
    const capSum = r.calibration.circuits.reduce((a, c) => a + (+c.capacity_kw || 0), 0);
    const capSystems = new Set(r.calibration.circuits.filter((c) => +c.capacity_kw > 0).map((c) => c.system || "fuel"));
    const capLabel = capSystems.size === 1 ? ({ fuel: "Kattilan teho", heatpump: "Lämpöpumpun teho", district: "Liittymäteho", electric: "Lämmitysteho" })[[...capSystems][0]] : "Lämmitysteho yhteensä";
    host.innerHTML = `
      <div class="res-head">
        <h3>Tuntiprofiili ${r.year}${state.area?.display ? `, ${esc(state.area.display)}` : ""}</h3>
        <div class="res-actions">${stale
          ? `<button type="button" class="btn small primary" id="rerunModel"${$("#runModel").disabled ? " disabled" : ""}>Laske uudelleen</button>`
          : `<button type="button" class="btn small primary" id="dlCsv">Lataa CSV laskuriin</button>
          <button type="button" class="btn small" id="copyEF">Kopioi sarakkeet E:F</button>`}
        </div>
      </div>
      ${stale ? `<p class="stale-note" role="status">Valinnat ovat muuttuneet. Luvut ovat edellisestä laskennasta${$("#runModel").disabled ? "; valitse ensin rakennukset ja säätiedot" : ""}.</p>` : ""}
      <div class="kpis">
        <div class="kpi el"><b>${fmt(t.electricity_kwh / 1000, 1)}</b><span>${helKwh ? "Muu sähkö" : "Sähkö"}, MWh/v</span></div>
        <div class="kpi el"><b>${fmt(t.electricity_peak_kw, 1)}</b><span>Sähkön huipputeho, kW</span></div>
        <div class="kpi heat"><b>${fmt(t.heat_kwh / 1000, 1)}</b><span>Lämmöntarve, MWh/v</span></div>
        <div class="kpi heat"><b>${fmt(t.heat_peak_kw, 1)}</b><span>Lämmön huipputeho, kW</span></div>
      </div>
      ${helKwh ? `<p class="tcap">Lämmityssähkö nykyisin ${fmt(helKwh / 1000, 1)} MWh/v sisältyy lämmöntarpeeseen. Sitä ei ole sähkösarakkeessa, koska laskuri tuottaa lämmön omista lähteistään.</p>` : ""}
      <div class="charts">
        ${barChart(r.monthly.electricity.map((v) => v / 1000), "--el", "MWh", helKwh ? "Muu sähkö kuukausittain, MWh" : "Sähkö kuukausittain, MWh")}
        ${barChart(r.monthly.heat.map((v) => v / 1000), "--heat", "MWh", "Lämmöntarve kuukausittain, MWh")}
      </div>
      <div class="charts">
        ${durationChart(r.heat, "--heat", "Lämpötehon pysyvyyskäyrä, kW", capSum, capLabel)}
        ${durationChart(r.electricity, "--el", helKwh ? "Muun sähkön pysyvyyskäyrä, kW" : "Sähkötehon pysyvyyskäyrä, kW", 0, "")}
      </div>
      <div class="tables">
        <div class="tbl-wrap"><table><thead><tr><th>Mittari / lämmitys</th><th class="n">MWh/v</th><th class="n">Huippu kW</th><th>Kalibrointi</th></tr></thead><tbody>${grpRows}</tbody></table></div>
        <div class="tbl-wrap"><table><caption class="tcap">Rakennuskohtaiset luvut ovat mallin jakamia arvioita, paitsi kun rakennukselle on annettu tunnettu kulutus.</caption><thead><tr><th>Rakennus</th><th class="n">Sähkö MWh</th><th class="n">Lämpö MWh</th><th class="n">Lämpö kWh/m²</th><th class="n">Huippu kW</th></tr></thead><tbody>${bRows}</tbody></table></div>
      </div>
      <div class="howto"><strong>Laskuriin vienti</strong>
        <ol>
          <li>Avaa ladattu CSV Excelissä. Kopioi sen sarakkeet E–F (rivit 2–8 761) tai käytä painiketta <em>Kopioi sarakkeet E:F</em>.</li>
          <li>Liitä laskurin <em>Oma kulutusdata</em> -välilehdelle soluun E2: Liitä määräten → Arvot.</li>
          <li>Valitse Ohjauspaneelin solusta D4 <em>Oma data</em> ja tarkista K11–L11 sekä K14.</li>
          ${state.prices[r.year] ? `<li>Kopioi CSV:n sarake H (pörssihinta) ja liitä se <em>Hintahistoria</em>-välilehdelle vuoden ${r.year} sarakkeeseen riville 2 (${({2023: "C", 2024: "D", 2025: "E", 2026: "F"})[r.year] || "vuoden sarake"}2). Valitse Ohjauspaneelista K22 = Pörssihinta ja K49 = ${r.year}.</li>` : `<li>Pörssihinnat voi hakea kohdassa 5; ne tulevat CSV:n sarakkeeksi H.</li>`}
        </ol>
        Laskurin aurinkosähkö- ja lämpöpumppulaskenta käyttää vielä laskurin omaa esimerkkivuotta. Ulkolämpötila (sarake G) on mukana CSV:ssä myöhempää käyttöä varten.
      </div>`;
    if (stale) {
      const rr = $("#rerunModel");
      if (rr) rr.onclick = () => $("#runModel").click();
      if (wasHidden) refreshMap();
      return;
    }
    $("#dlCsv").onclick = (e) => busy(e.currentTarget, "Ladataan…", async () => {
      const pr = state.prices[r.year];
      const csv = await api("/api/export/csv", { body: { project: projectPayload(), prices: pr ? pr.values : null } });
      download(`oma_kulutusdata_${r.year}.csv`, csv, "text/csv;charset=utf-8");
    });
    $("#copyEF").onclick = (e) => busy(e.currentTarget, "Kopioidaan…", async () => {
      const txt = await api("/api/export/paste", { body: { project: projectPayload() } });
      try { await navigator.clipboard.writeText(txt); toast("8 760 riviä kopioitu. Liitä soluun E2."); }
      catch (_) { download(`sarakkeet_E-F_${r.year}.txt`, txt, "text/plain"); toast("Leikepöytä ei ollut käytettävissä; rivit tallennettiin tiedostoon."); }
    });
    if (wasHidden) refreshMap();
  }

  function refreshMap() {
    setTimeout(() => {
      map.invalidateSize();
      const heated = state.buildings.filter((b) => b.heated).map((b) => shapes[b.id]).filter(Boolean);
      const grp = heated.length ? L.featureGroup(heated) : layers.area;
      if (grp && grp.getBounds && grp.getBounds().isValid()) map.fitBounds(grp.getBounds(), { padding: [40, 40], maxZoom: 17 });
    }, 50);
  }

  function download(name, text, type) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    a.textContent = name;
    a.hidden = true;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  // chart tooltips
  document.addEventListener("mousemove", (e) => {
    const tip = $("#tip");
    const t = e.target.closest && e.target.closest("[data-tip]");
    if (!t) { tip.hidden = true; return; }
    tip.textContent = t.dataset.tip;
    tip.hidden = false;
    tip.style.left = Math.min(e.clientX + 12, innerWidth - tip.offsetWidth - 8) + "px";
    tip.style.top = (e.clientY - 30) + "px";
  });

  // ------------------------------------------------------------------ project save / load
  function serial() {
    const s = { ...state, stations: [], result: null };
    return s;
  }
  function saveDraft() {
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(serial())); } catch (_) { /* storage unavailable */ }
  }
  function loadState(s) {
    state = { ...blankState(), ...s, result: null, stations: [] };
    lastResult = null;
    $("#year").value = state.year;
    $("#mainUse").value = state.mainUse;
    drawArea();
    if (layers.area) map.fitBounds(layers.area.getBounds(), { padding: [30, 30], maxZoom: 17 });
    if (state.area) {
      const chip = $("#areaChip");
      chip.textContent = state.area.kind === "property" ? `Kiinteistö ${state.area.display}, ${fmt(state.area.area_ha, 1)} ha` : state.area.display;
      chip.hidden = false;
      $("#kt").value = state.area.kind === "property" ? state.area.display : "";
      loadStations();
    }
    renderAll();
    renderWeather();
  }
  $("#newProject").onclick = () => {
    const has = state.area || state.buildings.length;
    if (has && !window.confirm("Aloitetaanko uusi projekti? Nykyinen työ poistetaan tästä selaimesta. Tallenna projekti ensin, jos tarvitset sitä.")) return;
    try { localStorage.removeItem(DRAFT_KEY); } catch (_) { /* storage blocked */ }
    loadState({});
    $("#areaChip").hidden = true;
    $("#kt").value = "";
    $("#stationList").innerHTML = `<p class="empty">Asemat haetaan, kun tila on valittu.</p>`;
    map.setView([62.79, 22.84], 10);
    toast("Uusi projekti aloitettu.");
  };
  $("#saveProject").onclick = () => {
    const name = state.area?.display ? `rakennushaku_${state.area.display}_${state.year}.json` : `rakennushaku_${state.year}.json`;
    download(name, JSON.stringify(serial(), null, 1), "application/json");
  };
  $("#loadProject").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try { loadState(JSON.parse(await f.text())); toast("Projekti avattu."); }
    catch (err) { toast("Tiedostoa ei voitu avata projektina.", true); }
    e.target.value = "";
  });

  // ------------------------------------------------------------------ controls
  $("#ktForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const kt = $("#kt").value.trim();
    if (!kt) return;
    busy(e.submitter || $("#ktForm button"), "Haetaan…", async () => {
      const p = await api(`/api/property?kt=${encodeURIComponent(kt)}`);
      await useProperty(p);
    });
  });
  $("#pickProperty").onclick = () => mode === "pick-property" ? setMode("none") : setMode("pick-property", "Klikkaa kiinteistöä kartalla");
  $("#pickCircle").onclick = () => mode === "pick-circle" ? setMode("none") : setMode("pick-circle", "Klikkaa tilakeskusta: rakennukset haetaan 250 m säteeltä");
  $("#addBuilding").onclick = () => mode === "add-building" ? setMode("none") : setMode("add-building", "Klikkaa rakennuksen paikkaa kartalla");
  $("#mainUse").addEventListener("change", (e) => {
    state.mainUse = e.target.value;
    state.buildings.forEach((b) => {
      if (b.suggested && b.default_use === "tuotanto" && (b.footprint_m2 || 0) >= PROD_MIN_M2) {
        b.use = state.mainUse;
        b.name = b.name.replace(/^[^0-9]+/, META.use_types[b.use].label + " ").trim();
      }
    });
    renderAll();
  });
  $("#year").addEventListener("change", (e) => {
    state.year = Number(e.target.value);
    state.weather = null;
    state.weatherChoice = null;
    state.result = null;
    const cleared = [...state.circuits, ...state.meters].filter((g) => g.data.kind === "hourly" && g.data.values);
    cleared.forEach((g) => { g.data.values = null; g.data.parsed = null; });
    toast(`Tarkasteluvuosi ${state.year}: valitse säätiedot uudelleen${cleared.length ? ` ja tuntitiedostot (${cleared.map((g) => g.name).join(", ")})` : ""}.`, false, 9000);
    loadStations();
    renderAll();
    renderWeather();
  });

  // ------------------------------------------------------------------ 3D view
  // Buildings extruded to floors × FLOOR_H and coloured by the modelled demand. MapLibre GL by default, Cesium as an option.
  const FLOOR_H = 3.5;                       // m per storey; an estimate, MML gives floors but no heights
  const V3D_KEY = "rakennushaku.view3d.v1";  // per-viewer renderer and colour choice
  let view = "2d";
  let v3dChain = Promise.resolve();
  const v3dPrefs = { renderer: "maplibre", color: "heat" };
  try { Object.assign(v3dPrefs, JSON.parse(localStorage.getItem(V3D_KEY) || "{}")); } catch (_) { /* storage blocked */ }

  function hexRgb(h) {
    h = String(h).trim().replace("#", "");
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) || 0);
  }
  function mix(a, b, t) {
    const A = hexRgb(a), B = hexRgb(b);
    return "#" + A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, "0")).join("");
  }
  function footprint(b) {
    const g = b.geometry;
    if (g.type === "Polygon" || g.type === "MultiPolygon") return g;
    const c = g.type === "Point" ? g.coordinates : g.coordinates[0];  // point record: a 10 m square stands in
    const dy = 5 / 111320, dx = dy / Math.cos(c[1] * Math.PI / 180);
    return { type: "Polygon", coordinates: [[[c[0] - dx, c[1] - dy], [c[0] + dx, c[1] - dy], [c[0] + dx, c[1] + dy], [c[0] - dx, c[1] + dy], [c[0] - dx, c[1] - dy]]] };
  }

  function scene3d() {
    const list = state.buildings.filter((b) => b.geometry);
    if (!list.length) return null;
    const heatC = getCss("--heat"), elC = getCss("--el"), paper = getCss("--surface"), nb = getCss("--neighbour");
    const grey = mix(paper, nb, 0.7);
    const per = {};
    (state.result?.buildings || []).forEach((r) => { per[r.id] = r; });
    const colour = state.result ? v3dPrefs.color : "pick";
    const key = colour === "el" ? "electricity_kwh" : "heat_kwh";
    const hue = colour === "el" ? elC : heatC;
    const max = Math.max(0, ...Object.values(per).map((r) => r[key] || 0));
    const low = mix(paper, hue, 0.15);
    const features = list.map((b) => {
      const r = per[b.id];
      const h = Math.max(1, b.floors || 1) * FLOOR_H;
      const lines = [inCalc(b), esc(b.class_label), b.footprint_m2 ? `pohja ${fmt(b.footprint_m2)} m²` : "", `korkeus noin ${fmt(h, 1)} m`];
      if (r) lines.push(`sähkö ${fmt(r.electricity_kwh / 1000, 1)} MWh/v`, `lämpö ${fmt(r.heat_kwh / 1000, 1)} MWh/v`);
      let color;
      if (colour === "pick") color = b.heated ? ((b.scope || "both") === "el" ? elC : heatC) : b.on_property ? grey : nb;
      else color = r ? mix(low, hue, max > 0 ? (r[key] || 0) / max : 0) : b.on_property ? grey : nb;
      return { type: "Feature", geometry: footprint(b), properties: { id: b.id, name: esc(b.name), h, color, label: lines.filter(Boolean).join("<br>") } };
    });
    // frame the heated buildings, or everything when none is chosen
    const heatedIds = new Set(state.buildings.filter((b) => b.heated).map((b) => b.id));
    const framed = features.filter((f) => heatedIds.has(f.properties.id));
    let w = 180, s = 90, e = -180, n = -90;
    const walk = (c) => {
      if (typeof c[0] === "number") { w = Math.min(w, c[0]); e = Math.max(e, c[0]); s = Math.min(s, c[1]); n = Math.max(n, c[1]); }
      else c.forEach(walk);
    };
    (framed.length ? framed : features).forEach((f) => walk(f.geometry.coordinates));
    return { features: { type: "FeatureCollection", features }, bounds: [w, s, e, n], tiles: tileTemplate(), colour, max };
  }

  function renderLegend(sc) {
    const el = $("#v3dLegend");
    if (!sc) { el.innerHTML = ""; return; }
    const height = `<span class="v3d-hint">Korkeus: kerrokset × ${fmt(FLOOR_H, 1)} m (arvio)</span><span class="v3d-hint">Klikkaa rakennusta: mukaan tai pois</span>`;
    if (sc.colour === "pick") {
      el.innerHTML = `<span class="v3d-hint">${state.result ? "Väri: valinta" : "Laske tuntiprofiili, niin väri kertoo kulutuksen"}</span>` + height;
      return;
    }
    const cls = sc.colour === "el" ? "el" : "heat";
    el.innerHTML = `<span class="v3d-scale"><span class="ramp-label">0</span><span class="ramp ${cls}" aria-hidden="true"></span>`
      + `<span class="ramp-label">${fmt(sc.max / 1000, 1)} MWh/v</span></span>${height}`;
  }

  // Clicking a building in 3D puts it in or out of the calculation, as on the 2D map.
  RH3D.onPick = (id) => { toggleHeated(id); focusBuilding(id); return v3dChain; };

  function status3d(text, isError) {
    const el = $("#v3dStatus");
    el.textContent = text || "";
    el.classList.toggle("error", !!isError);
    el.hidden = !text;
  }

  function refresh3d() {
    if (view !== "3d") return v3dChain;
    const sc = scene3d();
    renderLegend(sc);
    if (!sc) { RH3D.destroy(); status3d("Hae ensin tila kohdassa 1."); return v3dChain; }
    const renderer = v3dPrefs.renderer;
    v3dChain = v3dChain.then(async () => {
      if (view !== "3d") return;
      if (RH3D.renderer !== renderer) status3d(renderer === "cesium" ? "Ladataan Cesiumia…" : "Ladataan 3D-näkymää…");
      try {
        await RH3D.show($("#map3d"), renderer, sc, "/static/");
        status3d("");
      } catch (e) {
        RH3D.destroy();
        status3d(`3D-näkymä ei käynnistynyt: ${e.message || e}. Selain ei ehkä tue WebGL:ää.`, true);
      }
    });
    return v3dChain;
  }

  function setView(v) {
    view = v;
    for (const btn of document.querySelectorAll("#viewSeg button")) {
      const on = btn.dataset.view === v;
      btn.classList.toggle("on", on);
      btn.setAttribute("aria-pressed", String(on));
    }
    $("#v3dOpts").hidden = v !== "3d";
    $("#map3d").hidden = v !== "3d";
    $("#v3dLegend").hidden = v !== "3d";
    if (v === "2d") {
      v3dChain = v3dChain.then(() => RH3D.destroy());
      status3d("");
      map.invalidateSize();
      return v3dChain;
    }
    return refresh3d();
  }

  function saveV3dPrefs() {
    try { localStorage.setItem(V3D_KEY, JSON.stringify(v3dPrefs)); } catch (_) { /* storage blocked */ }
  }
  $("#viewSeg").addEventListener("click", (e) => { const b = e.target.closest("button[data-view]"); if (b) setView(b.dataset.view); });
  // Cesium runs its workers as modules, which a page opened straight from disk (file://) cannot start.
  if (location.protocol === "file:") {
    const opt = $('#v3dRenderer option[value="cesium"]');
    opt.disabled = true;
    opt.textContent = "Cesium (vain verkossa julkaistussa versiossa)";
    v3dPrefs.renderer = "maplibre";
  }
  $("#v3dRenderer").value = v3dPrefs.renderer;
  $("#v3dColor").value = v3dPrefs.color;
  $("#v3dRenderer").addEventListener("change", (e) => { v3dPrefs.renderer = e.target.value; saveV3dPrefs(); refresh3d(); });
  $("#v3dColor").addEventListener("change", (e) => { v3dPrefs.color = e.target.value; saveV3dPrefs(); refresh3d(); });
  if (window.ResizeObserver) new ResizeObserver(() => { map.invalidateSize(); RH3D.resize(); }).observe($(".mapwrap"));

  // Replacing a list's HTML blurs the focused field inside it, and the field's change event can ask for another
  // render while the first is still running. Such a request waits until the running render has finished.
  let rendering = false, renderPending = false;
  function renderAll() {
    if (rendering) { renderPending = true; return; }
    rendering = true;
    try { renderAllNow(); } finally { rendering = false; }
    if (renderPending) { renderPending = false; queueMicrotask(renderAll); }
  }
  function renderAllNow() {
    renderPrices();
    renderBuildings();
    drawBuildings();
    renderGroups();
    renderStations();
    renderChecklist();
    renderResults();
    saveDraft();
    refresh3d();
  }

  // ------------------------------------------------------------------ boot
  // The map stage sits below the sticky top bar, whose height changes when it wraps.
  function syncTopHeight() { document.documentElement.style.setProperty("--top-h", $(".top").offsetHeight + "px"); }
  if (window.ResizeObserver) new ResizeObserver(syncTopHeight).observe($(".top"));
  else window.addEventListener("resize", syncTopHeight);

  async function boot() {
    syncTopHeight();
    const ys = $("#year");
    const cy = new Date().getFullYear();
    for (let y = cy; y >= cy - 8; y--) ys.insertAdjacentHTML("beforeend", `<option value="${y}">${y}</option>`);
    try { META = await api("/api/status"); } catch (e) { toast("Palvelimeen ei saatu yhteyttä.", true); }
    $("#mainUse").innerHTML = ["broileri", "lihasika", "emakko", "navetta", "muu"].map((k) => `<option value="${k}">${esc(META.use_types[k]?.label || k)}</option>`).join("");
    const kc = $("#keyChip");
    kc.className = "chip " + (META.has_mml_key ? "ok" : "warn");
    kc.textContent = META.has_mml_key ? "MML-avain käytössä" : "MML-avain puuttuu";
    if (!META.has_mml_key) {
      $("#step1Hint").innerHTML = "MML-rajapinta-avain puuttuu, joten kiinteistö- ja rakennushaku eivät toimi. Lisää <code>MML_API_KEY</code> tiedostoon <code>.env</code> ja käynnistä uudelleen, tai lisää rakennukset kartalle käsin kohdassa 2.";
    }
    const at = META.attribution || {};
    $("#attrib").innerHTML = [at.mml, at.fmi, at.open_meteo, at.prices].filter(Boolean).map((s) => `<span>${esc(s)}</span>`).join("") + `<span>Rakennushaku ${esc(META.version || "")}, prototyyppi ilman takuuta. Koodi MIT-lisenssillä.</span><span>SEAMK, Maatalous ja energia -tutkimusryhmä. EIP CHP Energiaälykäs eteläpohjalainen maatila -hanke.</span>`;
    initBaseLayers();
    let draft = null;
    try { draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null"); } catch (_) { draft = null; }
    if (draft && draft.buildings) loadState(draft);
    else { ys.value = state.year; $("#mainUse").value = state.mainUse; renderAll(); }
  }
  boot();
})();
