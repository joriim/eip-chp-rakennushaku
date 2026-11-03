/* Rakennushaku 3D view. Two interchangeable renderers for the same scene:
   - MapLibre GL JS 5.24.0 (BSD-3-Clause), the default: extruded footprints on a tilted map.
     Bundled with the app; loaded only when the 3D view is first opened.
   - CesiumJS 1.146.0 (Apache-2.0), optional: a 3D globe. Loaded on demand from the jsDelivr CDN (or window.RH_CESIUM_BASE),
     no Cesium ion token, no ion terrain: buildings stand on the ellipsoid.
   A scene is {features: GeoJSON FeatureCollection, bounds: [w, s, e, n], tiles: {url, maxzoom, attribution}}.
   Each feature carries properties {id, name, h (m), color (hex), label (HTML-safe text)}. */
(function () {
  "use strict";

  const CESIUM_VERSION = "1.146.0";
  // A self-hosted copy (an intranet, or an offline test) can be used by setting window.RH_CESIUM_BASE before opening the view.
  const cesiumBase = () => window.RH_CESIUM_BASE || `https://cdn.jsdelivr.net/npm/cesium@${CESIUM_VERSION}/Build/Cesium/`;
  const plain = (html) => String(html).replace(/&copy;/g, "©").replace(/<[^>]+>/g, "");
  const loaded = {};

  // Load a library once. A <script type="text/plain" id="lib-…"> in the page (single-file build) wins over a URL.
  function loadScript(key, inlineId, url) {
    if (!loaded[key]) {
      loaded[key] = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        const inline = document.getElementById(inlineId);
        if (inline) { s.textContent = inline.textContent; document.head.appendChild(s); resolve(); return; }
        s.src = url; s.async = true;
        s.onload = () => resolve();
        s.onerror = () => { delete loaded[key]; reject(new Error(`Kirjaston lataus epäonnistui: ${url}`)); };
        document.head.appendChild(s);
      });
    }
    return loaded[key];
  }
  function loadCss(key, inlineId, url) {
    if (loaded["css:" + key]) return;
    loaded["css:" + key] = true;
    const inline = document.getElementById(inlineId);
    if (inline) { const st = document.createElement("style"); st.textContent = inline.textContent; document.head.appendChild(st); return; }
    const l = document.createElement("link"); l.rel = "stylesheet"; l.href = url; document.head.appendChild(l);
  }

  let current = null; // {kind, destroy()}

  function destroy() {
    if (current) { try { current.destroy(); } catch (_) { /* already gone */ } current = null; }
  }

  // ---------------------------------------------------------------- MapLibre GL
  async function showMapLibre(el, scene, base) {
    loadCss("maplibre", "lib-maplibre-css", base + "vendor/maplibre/maplibre-gl.css");
    await loadScript("maplibre", "lib-maplibre", base + "vendor/maplibre/maplibre-gl.js");
    const ml = window.maplibregl;
    const map = new ml.Map({
      container: el,
      style: {
        version: 8,
        sources: {
          base: { type: "raster", tiles: [scene.tiles.url], tileSize: 256, maxzoom: scene.tiles.maxzoom, attribution: scene.tiles.attribution },
          buildings: { type: "geojson", data: scene.features },
        },
        layers: [
          { id: "base", type: "raster", source: "base" },
          {
            id: "buildings", type: "fill-extrusion", source: "buildings",
            paint: { "fill-extrusion-color": ["get", "color"], "fill-extrusion-height": ["get", "h"], "fill-extrusion-base": 0, "fill-extrusion-opacity": 0.92 },
          },
        ],
      },
      bounds: scene.bounds,
      fitBoundsOptions: { padding: 60, maxZoom: 18 },
      pitch: 55,
      bearing: -20,
      maxPitch: 75,
      attributionControl: { compact: true },
    });
    map.addControl(new ml.NavigationControl({ visualizePitch: true }), "top-right");
    const popup = new ml.Popup({ closeButton: true, maxWidth: "260px" });
    map.on("click", "buildings", (e) => {
      const p = e.features[0].properties;
      popup.setLngLat(e.lngLat).setHTML(`<strong>${p.name}</strong><br>${p.label}`).addTo(map);
    });
    map.on("mouseenter", "buildings", () => { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", "buildings", () => { map.getCanvas().style.cursor = ""; });
    await new Promise((resolve) => map.once("load", resolve));
    el.dataset.ready = "maplibre";
    return {
      kind: "maplibre",
      native: map,
      update(sc) { map.getSource("buildings").setData(sc.features); },
      resize() { map.resize(); },
      destroy() { map.remove(); delete el.dataset.ready; },
    };
  }

  // ---------------------------------------------------------------- CesiumJS
  async function showCesium(el, scene) {
    const base = cesiumBase();
    window.CESIUM_BASE_URL = base;
    loadCss("cesium", "lib-cesium-css", base + "Widgets/widgets.css");
    await loadScript("cesium", "lib-cesium", base + "Cesium.js");
    const C = window.Cesium;
    const viewer = new C.Viewer(el, {
      baseLayer: new C.ImageryLayer(new C.UrlTemplateImageryProvider({
        url: scene.tiles.url, maximumLevel: scene.tiles.maxzoom, credit: plain(scene.tiles.attribution),
      })),
      terrainProvider: new C.EllipsoidTerrainProvider(),
      baseLayerPicker: false, geocoder: false, sceneModePicker: false, navigationHelpButton: false,
      animation: false, timeline: false, fullscreenButton: false, homeButton: true,
      // Cesium's InfoBox writes into an iframe, which a page opened from disk may not reach; a plain popup replaces it
      infoBox: false, selectionIndicator: false,
    });
    viewer.scene.globe.depthTestAgainstTerrain = false;
    const pop = document.createElement("div");
    pop.className = "v3d-pop"; pop.hidden = true; pop.setAttribute("role", "status");
    el.appendChild(pop);
    const info = {};
    const clicks = new C.ScreenSpaceEventHandler(viewer.scene.canvas);
    clicks.setInputAction((ev) => {
      const hit = viewer.scene.pick(ev.position);
      const p = hit && hit.id && info[hit.id.id];
      if (!p) { pop.hidden = true; return; }
      pop.innerHTML = `<strong>${p.name}</strong><br>${p.label}`;
      pop.style.left = `${ev.position.x + 12}px`;
      pop.style.top = `${ev.position.y + 12}px`;
      pop.hidden = false;
    }, C.ScreenSpaceEventType.LEFT_CLICK);

    function addFeatures(sc) {
      viewer.entities.removeAll();
      for (const k in info) delete info[k];
      pop.hidden = true;
      for (const f of sc.features.features) {
        const polys = f.geometry.type === "MultiPolygon" ? f.geometry.coordinates : [f.geometry.coordinates];
        polys.forEach((rings, i) => {
          info[`${f.properties.id}-${i}`] = f.properties;
          viewer.entities.add({
            id: `${f.properties.id}-${i}`,
            name: plain(f.properties.name),
            polygon: {
              hierarchy: C.Cartesian3.fromDegreesArray(rings[0].flat()),
              height: 0,
              extrudedHeight: f.properties.h,
              material: C.Color.fromCssColorString(f.properties.color).withAlpha(0.92),
              outline: true,
              outlineColor: C.Color.BLACK.withAlpha(0.35),
            },
          });
        });
      }
    }
    addFeatures(scene);
    const [w, s, e, n] = scene.bounds;
    const centre = C.Cartesian3.fromDegrees((w + e) / 2, (s + n) / 2, 0);
    const span = C.Cartesian3.distance(C.Cartesian3.fromDegrees(w, s), C.Cartesian3.fromDegrees(e, n));
    viewer.camera.lookAt(centre, new C.HeadingPitchRange(C.Math.toRadians(-20), C.Math.toRadians(-35), Math.max(250, span * 1.3)));
    viewer.camera.lookAtTransform(C.Matrix4.IDENTITY);
    el.dataset.ready = "cesium";
    return {
      kind: "cesium",
      native: viewer,
      update: addFeatures,
      resize() { viewer.resize(); },
      destroy() { clicks.destroy(); viewer.destroy(); pop.remove(); delete el.dataset.ready; },
    };
  }

  // ---------------------------------------------------------------- public
  async function show(el, renderer, scene, base) {
    if (current && current.kind === renderer) { current.update(scene); return; }
    destroy();
    el.innerHTML = "";
    current = renderer === "cesium" ? await showCesium(el, scene) : await showMapLibre(el, scene, base || "/static/");
  }

  window.RH3D = {
    show,
    destroy,
    resize() { if (current) current.resize(); },
    get renderer() { return current ? current.kind : null; },
    get native() { return current ? current.native : null; },  // the MapLibre map or Cesium viewer, for tests
    CESIUM_VERSION,
  };
})();
