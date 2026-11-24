// Lidar module tests: node tests/js/test_lidar.js   (needs laz-perf 0.0.7: npm i --no-save laz-perf@0.0.7)
"use strict";
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const RHL = require("../../src/rakennushaku/static/lidar.js");

const lazModule = process.env.LAZPERF_NODE || "laz-perf";
const { createLazPerf } = require(lazModule);
const DATA = path.join(__dirname, "..", "data");
let failed = 0;
const check = (name, fn) => Promise.resolve().then(fn).then(() => console.log("ok", name), (e) => { failed++; console.error("FAIL", name, "\n ", e.message); });
const near = (a, b, tol, what) => assert(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b} ± ${tol}`);

(async () => {
  await check("TM35 round trip", () => {
    const [e, n] = RHL.toTm35(22.84, 62.79);
    const [lon, lat] = RHL.fromTm35(e, n);
    near(lon, 22.84, 1e-7, "lon"); near(lat, 62.79, 1e-7, "lat");
  });
  await check("map sheet names (1:5000, 3 × 3 km)", () => {
    assert.strictEqual(RHL.sheetName(385784, 6672298), "L4133B3");
    assert.strictEqual(RHL.sheetName(386000, 6672000), "L4133D1");
    assert.deepStrictEqual(RHL.sheetsForBox(385000, 6674000, 386500, 6675500), ["L4133B3", "L4133B4", "L4133D1", "L4133D2"]);
  });
  await check("process inputs and result parsing", () => {
    const desc = { inputs: { mapSheetInput: { schema: { type: "array" } }, fileFormatInput: { schema: { type: "string", enum: ["LAZ"] } },
      dataSetInput: { schema: { type: "string", enum: ["laserkeilaus_05_2021", "laserkeilaus_05_2023"] } } } };
    const inp = RHL.processInputs(desc, ["L4133B3"]);
    assert.deepStrictEqual(inp, { mapSheetInput: ["L4133B3"], fileFormatInput: "LAZ", dataSetInput: "laserkeilaus_05_2023" });
    const files = RHL.lazFiles({ results: [
      { path: "https://x/dl/v1/j/L4133B3_2019.laz", mapSheetNumber: "L4133B3", length: 10 },
      { path: "https://x/dl/v1/j/L4133B3_2023.laz", mapSheetNumber: "L4133B3", length: 12 },
      { path: "https://x/dl/v1/j/metadata.xml" }], zipPath: "https://x/zip" });
    assert.strictEqual(files.length, 1); assert(files[0].path.endsWith("2023.laz"));
  });

  const wasmBinary = undefined;
  const buf = fs.readFileSync(path.join(DATA, "lidar_fixture.laz"));
  const blds = JSON.parse(fs.readFileSync(path.join(DATA, "lidar_fixture_buildings.json"), "utf8"));
  const boxes = [[383900, 6672900, 384300, 6673300]];
  let pts;
  await check("LAZ decoding with laz-perf", async () => {
    pts = await RHL.decodeLaz(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length), boxes, { factory: createLazPerf, wasmBinary });
    assert.strictEqual(pts.header.year, 2023);
    assert.strictEqual(pts.x.length, pts.header.count);
    assert(pts.x.length > 17000, "points " + pts.x.length);
    const classes = new Set(pts.cls); assert(classes.has(1) && classes.has(2) && classes.has(5));
  });
  const res = {};
  for (const b of blds) res[b.id] = RHL.analyseBuilding(b, pts, 2023);
  await check("gable hall: shape, eaves, ridge, pitch", () => {
    const r = res.halli;
    assert.strictEqual(r.status, "ok"); assert.strictEqual(r.roof, "harjakatto");
    near(r.eave_h, 4.0, 0.4, "eave"); near(r.ridge_h, 7.0, 0.3, "ridge"); near(r.pitch_deg, 16.7, 2, "pitch");
    near(r.axis_deg, 30, 3, "axis"); near(r.mean_h, 5.5, 0.3, "mean height");
    near(r.ground_z, 40.0 + 0.01 * 70, 0.3, "ground");
    near(r.lidar_area_m2 / r.area_mml_m2, 1, 0.2, "lidar area");
  });
  await check("flat house", () => {
    const r = res.asuin;
    assert.strictEqual(r.roof, "tasakatto"); near(r.mean_h, 6.2, 0.2, "height"); near(r.ridge_h, 6.2, 0.3, "p95");
  });
  await check("demolished building is reported, not measured", () => {
    assert.strictEqual(res.purettu.status, "not_seen"); assert(/purettu/.test(res.purettu.notes.join(" ")));
  });
  await check("extended building: mono-pitch roof and a larger lidar footprint", () => {
    const r = res.laajennettu;
    assert.strictEqual(r.roof, "pulpettikatto"); near(r.eave_h, 3.5, 0.4, "low side"); near(r.ridge_h, 5.0, 0.4, "high side");
    assert(r.lidar_area_m2 > 1.25 * r.area_mml_m2, `lidar ${r.lidar_area_m2} vs ${r.area_mml_m2}`);
    assert(/suurempi/.test(r.notes.join(" ")));
  });
  await check("roof strips follow the gable", () => {
    const s = RHL.roofStrips(blds.find((b) => b.id === "halli"), res.halli, 10);
    assert.strictEqual(s.length, 10);
    const hs = s.map((x) => x.h);
    assert(Math.max(...hs) > 6.4 && Math.min(...hs) < 4.6, hs.join(","));
    const area = s.reduce((a, x) => a + ringAreaM2(x.ring), 0);
    near(area / 1200, 1, 0.02, "strips cover the footprint");
  });
  console.log(JSON.stringify(Object.fromEntries(Object.entries(res).map(([k, v]) => [k, { status: v.status, roof: v.roof, eave: v.eave_h, ridge: v.ridge_h, pitch: v.pitch_deg, mean: v.mean_h, area: v.area_mml_m2, lidar: v.lidar_area_m2 }]))));
  if (failed) { console.error(`${failed} failed`); process.exit(1); }
})();

function ringAreaM2(ring) {
  const tm = ring.map((p) => RHL.toTm35(p[0], p[1]));
  let a = 0; for (let i = 0, j = tm.length - 1; i < tm.length; j = i++) a += (tm[j][0] + tm[i][0]) * (tm[j][1] - tm[i][1]);
  return Math.abs(a / 2);
}
