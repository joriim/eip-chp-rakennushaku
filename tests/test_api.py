from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from rakennushaku import app as appmod
from rakennushaku import weather
from rakennushaku.timebase import HOURS, hour_starts_utc

from fixtures import FakeSession, LAT0, LON0, synthetic_temp


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setattr(weather, "CACHE_DIR", tmp_path)
    monkeypatch.setattr(appmod, "_session", FakeSession())
    monkeypatch.setenv("MML_API_KEY", "key")
    return TestClient(appmod.app)


def test_status_and_index(client):
    s = client.get("/api/status").json()
    assert s["has_mml_key"] and "broileri" in s["use_types"]
    assert client.get("/").status_code == 200


def test_property_and_buildings_flow(client):
    p = client.get("/api/property", params={"kt": "999-401-3-25"}).json()
    b = client.post("/api/buildings", json={"geometry": p["geometry"]}).json()
    assert len(b["buildings"]) == 6
    assert client.get("/api/property", params={"kt": "1-1-1-1"}).status_code == 404
    assert client.get("/api/property", params={"kt": "abc"}).status_code == 400
    at = client.get("/api/property-at", params={"lat": LAT0, "lon": LON0}).json()
    assert at["display"] == "999-401-3-25"
    around = client.get("/api/buildings-around", params={"lat": LAT0, "lon": LON0, "r": 300}).json()
    assert around["area"]["type"] == "Polygon" and around["buildings"]


def test_missing_and_bad_key(client, monkeypatch):
    monkeypatch.setenv("MML_API_KEY", "")
    assert client.get("/api/property", params={"kt": "999-401-3-25"}).status_code == 503
    monkeypatch.setenv("MML_API_KEY", "bad")
    r = client.get("/api/property", params={"kt": "999-401-3-25"})
    assert r.status_code == 502 and "MML_API_KEY" in r.json()["detail"]


def test_weather_endpoints(client):
    st = client.get("/api/weather/stations", params={"lat": LAT0, "lon": LON0, "year": 2025}).json()
    assert st["stations"][0]["fmisid"] == 101486
    t = client.get("/api/weather/fmi", params={"fmisid": 101486, "year": 2025, "lat": LAT0, "lon": LON0}).json()
    assert t["missing"] == 0 and len(t["values"]) == HOURS
    om = client.get("/api/weather/open-meteo", params={"lat": LAT0, "lon": LON0, "year": 2025}).json()
    assert om["missing"] == 0


def _project():
    return {
        "year": 2025,
        "temperature": [synthetic_temp(x) for x in hour_starts_utc(2025)],
        "buildings": [
            {"id": "1001", "name": "Broilerihalli", "use": "broileri", "heated_m2": 1620, "heated": True, "circuit": "c1", "meter": "m1"},
            {"id": "1003", "name": "Asuinrakennus", "use": "asuin", "heated_m2": 280, "heated": True, "circuit": "poistettu", "meter": "m1"},
        ],
        "circuits": [{"id": "c1", "name": "Hakekattila", "data": {"kind": "annual", "value": 400, "unit": "i-m3", "efficiency": 0.85}}],
        "meters": [{"id": "m1", "name": "Päämittari", "data": {"kind": "monthly", "unit": "MWh",
                                                               "months": [14, 13, 12, 10, 9, 9, 9, 9, 9, "", 12, 14]}}],
    }


def test_model_and_exports(client):
    r = client.post("/api/model", json={"project": _project()})
    assert r.status_code == 200, r.text
    res = r.json()
    assert res["totals"]["heat_kwh"] == pytest.approx(400 * 800 * 0.85, rel=1e-6)
    met = res["calibration"]["meters"][0]
    assert met["months_used"] == 11 and met["cv_rmse"] is not None
    # building with a removed circuit falls back to the first circuit
    assert res["calibration"]["circuits"][0]["members"] == ["1001", "1003"]
    csv = client.post("/api/export/csv", json={"project": _project()})
    assert csv.headers["content-disposition"].endswith('oma_kulutusdata_2025.csv"')
    assert csv.text.count("\n") == HOURS + 1
    paste = client.post("/api/export/paste", json={"project": _project()}).text
    assert paste.count("\n") == HOURS - 1


def test_parse_series_endpoint(client):
    text = "aika;kwh\n" + "\n".join(f"2025-01-01T{h:02d}:00:00+02:00;{h}" for h in range(24)) + "\n"
    r = client.post("/api/parse-series", json={"text": text, "kind": "energy"}).json()
    assert r["hours_complete"] == 24 and r["total_kwh"] == pytest.approx(sum(range(24)))
    bad = client.post("/api/parse-series", json={"text": "a\nb\nc\n", "kind": "energy"})
    assert bad.status_code == 422


def test_price_endpoints(client):
    p = client.get("/api/prices", params={"year": 2025}).json()
    assert p["hours"] == HOURS and p["negative"] >= 0
    csv = client.post("/api/export/csv", json={"project": _project(), "prices": p["values"]}).text
    assert "Pörssihinta 2025" in csv.splitlines()[0]
    hh = client.post("/api/export/hintahistoria", json={"prices": {"2025": p["values"]}})
    assert hh.status_code == 200 and hh.text.count("\n") == HOURS + 1
    pp = client.post("/api/export/paste-prices", json={"prices": {"2025": p["values"]}}).text
    assert pp.count("\n") == HOURS - 1


def test_3d_view_assets(client):
    """The 3D view's module and the bundled MapLibre are served; the single-file build carries both."""
    page = client.get("/").text
    assert 'id="map3d"' in page and "/static/view3d.js" in page
    v3d = client.get("/static/view3d.js")
    assert v3d.status_code == 200 and "RH3D" in v3d.text and 'CESIUM_VERSION = "1.146.0"' in v3d.text
    ml = client.get("/static/vendor/maplibre/maplibre-gl.js")
    assert ml.status_code == 200 and "MapLibre GL JS" in ml.text[:300]
    assert client.get("/static/vendor/maplibre/LICENSE.txt").status_code == 200
    from pathlib import Path
    built = (Path(__file__).resolve().parents[1] / "web" / "rakennushaku.html").read_text(encoding="utf-8")
    assert 'id="lib-maplibre"' in built and "window.RH3D" in built and "function tileTemplate()" in built


# --------------------------------------------------------------------------- laser scanning relay
def test_lidar_job_status_and_file(client):
    from fixtures import LIDAR_FIXTURE
    r = client.post("/api/lidar/job", json={"sheets": ["l4133b3"]})
    assert r.status_code == 200 and r.json() == {"job": "job-1"}
    url, params, body = appmod._session.posts[-1]
    assert url.endswith("/processes/laserkeilausaineisto_05_karttalehti/execution") and params["api-key"] == "key"
    # newest data set chosen from the process description; sheet normalised
    assert body["inputs"] == {"mapSheetInput": ["L4133B3"], "fileFormatInput": "LAZ", "dataSetInput": "laserkeilausaineisto_05_2023"}
    assert client.get("/api/lidar/job/job-1").json()["status"] == "running"
    st = client.get("/api/lidar/job/job-1").json()
    assert st["status"] == "successful" and len(st["files"]) == 1 and st["files"][0]["sheet"] == "L4133B3"
    f = client.get("/api/lidar/file", params={"url": st["files"][0]["path"]})
    assert f.status_code == 200 and f.content == LIDAR_FIXTURE.read_bytes()


def test_lidar_rejects_bad_input(client, monkeypatch):
    assert client.post("/api/lidar/job", json={"sheets": ["L4133B"]}).status_code == 400            # not a 1:5000 sheet
    assert client.post("/api/lidar/job", json={"sheets": [f"L4133B{i}" for i in range(1, 5)] + ["L4133D1", "L4133D2", "L4133D3"]}).status_code == 400
    assert client.get("/api/lidar/file", params={"url": "https://example.com/x.laz"}).status_code == 400   # no open proxy
    assert client.get("/api/lidar/job/..%2Fetc").status_code in (400, 404)
    monkeypatch.setenv("MML_API_KEY", "")
    assert client.post("/api/lidar/job", json={"sheets": ["L4133B3"]}).status_code == 503


def test_lidar_python_and_js_input_rules_agree():
    from fixtures import LIDAR_DESC
    from rakennushaku import lidar
    assert lidar.process_inputs(LIDAR_DESC, ["L4133B3"])["dataSetInput"] == "laserkeilausaineisto_05_2023"
    files = lidar.laz_files({"results": [{"path": "https://x/a/L4133B3_2019.laz"}, {"path": "https://x/a/L4133B3_2023.laz"}]})
    assert [f["year"] for f in files] == [2023]
