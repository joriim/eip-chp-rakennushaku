"""FastAPI app: the browser UI and the data endpoints behind it.

External APIs are called from here, never from the browser, so the MML API key
stays on the server and the browser needs no CORS support from the sources.
"""

from __future__ import annotations

import math
import os
from collections import OrderedDict
from pathlib import Path

import requests
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, PlainTextResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from shapely.geometry import Point, mapping

from rakennushaku import __version__, export, mml, model, prices, weather
from rakennushaku.series_parser import SeriesParseError, parse_series

STATIC = Path(__file__).parent / "static"
WMTS = os.environ.get("RAKENNUSHAKU_WMTS", "https://avoin-karttakuva.maanmittauslaitos.fi/avoin/wmts")

app = FastAPI(title="Rakennushaku", version=__version__)
app.mount("/static", StaticFiles(directory=STATIC), name="static")
_session = requests.Session()
_session.headers["User-Agent"] = f"rakennushaku/{__version__} (SEAMK EIP CHP)"


def api_key() -> str:
    return os.environ.get("MML_API_KEY", "").strip()


def _upstream_error(exc: Exception, what: str) -> HTTPException:
    if isinstance(exc, requests.HTTPError) and exc.response is not None:
        code = exc.response.status_code
        if code in (401, 403):
            return HTTPException(502, f"{what}: rajapinta hylkäsi pyynnön ({code}). Tarkista MML_API_KEY.")
        return HTTPException(502, f"{what}: rajapinta vastasi virheellä {code}.")
    if isinstance(exc, requests.RequestException):
        return HTTPException(504, f"{what}: rajapintaan ei saatu yhteyttä ({type(exc).__name__}).")
    return HTTPException(500, f"{what}: {exc}")


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC / "index.html")


@app.get("/api/status")
def status() -> dict:
    return {
        "version": __version__,
        "has_mml_key": bool(api_key()),
        "use_types": {k: {kk: vv for kk, vv in v.items()} for k, v in model.USE_TYPES.items()},
        "heat_units": {k: v["label"] for k, v in export.HEAT_UNITS.items()},
        "attribution": {"mml": mml.ATTRIBUTION, "fmi": weather.FMI_ATTR, "open_meteo": weather.OM_ATTR,
                        "prices": prices.ATTR},
    }


# --------------------------------------------------------------------------- MML

@app.get("/api/property")
def get_property(kt: str) -> dict:
    try:
        return mml.fetch_property(kt, api_key(), _session)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except mml.MissingApiKey as e:
        raise HTTPException(503, str(e))
    except mml.PropertyNotFound as e:
        raise HTTPException(404, str(e))
    except Exception as e:  # noqa: BLE001
        raise _upstream_error(e, "Kiinteistöhaku")


@app.get("/api/property-at")
def get_property_at(lat: float, lon: float) -> dict:
    try:
        return mml.property_at(lon, lat, api_key(), _session)
    except mml.MissingApiKey as e:
        raise HTTPException(503, str(e))
    except mml.PropertyNotFound as e:
        raise HTTPException(404, str(e))
    except Exception as e:  # noqa: BLE001
        raise _upstream_error(e, "Kiinteistöhaku")


class AreaIn(BaseModel):
    geometry: dict


@app.post("/api/buildings")
def post_buildings(body: AreaIn) -> dict:
    try:
        return {"buildings": mml.buildings_for_area(body.geometry, api_key(), session=_session),
                "attribution": mml.ATTRIBUTION}
    except mml.MissingApiKey as e:
        raise HTTPException(503, str(e))
    except Exception as e:  # noqa: BLE001
        raise _upstream_error(e, "Rakennushaku")


@app.get("/api/buildings-around")
def buildings_around(lat: float, lon: float, r: float = Query(250, ge=20, le=1500)) -> dict:
    """Buildings within r metres of a point, for when the property ID is not known."""
    kx = 111_320.0 * math.cos(math.radians(lat))
    circle = Point(0, 0).buffer(r, 32)
    poly = type(circle)([(lon + x / kx, lat + y / 110_574.0) for x, y in circle.exterior.coords])
    return post_buildings(AreaIn(geometry=mapping(poly))) | {"area": mapping(poly)}


_tile_cache: OrderedDict[str, tuple[bytes, str]] = OrderedDict()


@app.get("/tiles/{layer}/{z}/{x}/{y}")
def tile(layer: str, z: int, x: int, y: int) -> Response:
    if layer not in ("ortokuva", "taustakartta") or not api_key():
        raise HTTPException(404)
    key = f"{layer}/{z}/{x}/{y}"
    if key in _tile_cache:
        _tile_cache.move_to_end(key)
        data, ctype = _tile_cache[key]
        return Response(data, media_type=ctype, headers={"Cache-Control": "max-age=86400"})
    fmt = "image/jpeg" if layer == "ortokuva" else "image/png"
    params = {"SERVICE": "WMTS", "REQUEST": "GetTile", "VERSION": "1.0.0", "LAYER": layer, "STYLE": "default",
              "TILEMATRIXSET": "WGS84_Pseudo-Mercator", "TILEMATRIX": z, "TILEROW": y, "TILECOL": x,
              "FORMAT": fmt, "api-key": api_key()}
    try:
        r = _session.get(WMTS, params=params, timeout=20)
        r.raise_for_status()
    except requests.RequestException:
        raise HTTPException(502)
    ctype = r.headers.get("Content-Type", fmt)
    _tile_cache[key] = (r.content, ctype)
    if len(_tile_cache) > 3000:
        _tile_cache.popitem(last=False)
    return Response(r.content, media_type=ctype, headers={"Cache-Control": "max-age=86400"})


# --------------------------------------------------------------------------- weather

@app.get("/api/weather/stations")
def stations(lat: float, lon: float, year: int) -> dict:
    try:
        return {"stations": weather.nearest_stations(lat, lon, year, session=_session), "attribution": weather.FMI_ATTR}
    except Exception as e:  # noqa: BLE001
        raise _upstream_error(e, "FMI:n asemahaku")


@app.get("/api/weather/fmi")
def fmi(fmisid: int, year: int, lat: float | None = None, lon: float | None = None) -> dict:
    try:
        res = weather.fmi_temperature(fmisid, year, session=_session)
    except Exception as e:  # noqa: BLE001
        raise _upstream_error(e, "FMI:n havaintohaku")
    if res["missing"] and lat is not None and lon is not None:
        try:
            res = weather.patch_gaps(res, weather.open_meteo_temperature(lat, lon, year, session=_session))
        except Exception:  # noqa: BLE001 - patching is best effort
            pass
    return res


@app.get("/api/weather/open-meteo")
def open_meteo(lat: float, lon: float, year: int) -> dict:
    try:
        return weather.open_meteo_temperature(lat, lon, year, session=_session)
    except Exception as e:  # noqa: BLE001
        raise _upstream_error(e, "Open-Meteo")


class SeriesIn(BaseModel):
    text: str
    kind: str = "energy"
    year: int | None = None
    unit: str = "auto"
    naive_tz: str = "local"
    stamp_at: str = "start"
    timestamp_column: str | None = None
    value_column: str | None = None


@app.post("/api/parse-series")
def parse(body: SeriesIn) -> dict:
    try:
        p = parse_series(body.text, kind=body.kind, year=body.year, unit=body.unit, naive_tz=body.naive_tz,
                         stamp_at=body.stamp_at, timestamp_column=body.timestamp_column,
                         value_column=body.value_column)
    except SeriesParseError as e:
        raise HTTPException(422, str(e))
    out = p.__dict__.copy()
    if p.kind == "temperature":
        filled, n_interp, still = weather.fill_gaps(p.array(), 6)
        out["values"] = [None if v != v else round(float(v), 2) for v in filled]
        out["interpolated"] = n_interp
        out["missing"] = still
    else:
        out["total_kwh"] = round(sum(v for v in p.values if v is not None), 1)
    return out


# --------------------------------------------------------------------------- model

class ProjectIn(BaseModel):
    project: dict
    prices: list | None = None


class PricesIn(BaseModel):
    prices: dict = {}


@app.get("/api/prices")
def get_prices(year: int) -> dict:
    try:
        return prices.fetch_prices(year, session=_session)
    except Exception as e:  # noqa: BLE001
        raise _upstream_error(e, "Pörssihintahaku")


@app.post("/api/export/hintahistoria")
def export_hintahistoria(body: PricesIn) -> Response:
    return Response(prices.hintahistoria_csv(body.prices), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": 'attachment; filename="hintahistoria_2023-2026.csv"'})


@app.post("/api/export/paste-prices")
def export_paste_prices(body: PricesIn) -> PlainTextResponse:
    return PlainTextResponse(prices.paste_prices(body.prices))


def _prepare(project: dict) -> dict:
    """Convert fuel and unit inputs to delivered kWh before the model runs."""
    pr = dict(project)
    circuits = []
    for c in project.get("circuits", []):
        c = dict(c)
        d = dict(c.get("data") or {})
        eff = float(d.get("efficiency") or 0.85)
        dens = float(d.get("chip_density") or 0.8)
        unit = d.get("unit") or "kWh"
        if d.get("kind") == "annual" and d.get("value") not in (None, ""):
            d["kwh"] = export.heat_to_kwh(float(d["value"]), unit, eff, dens)
        if d.get("base_share_pct") not in (None, ""):
            d["base_share"] = float(d["base_share_pct"]) / 100.0
        if d.get("kind") == "monthly":
            d["kwh_months"] = [None if v in (None, "") else export.heat_to_kwh(float(v), unit, eff, dens)
                               for v in d.get("months") or []]
        c["data"] = d
        circuits.append(c)
    meters = []
    for m in project.get("meters", []):
        m = dict(m)
        d = dict(m.get("data") or {})
        k = export.EL_UNITS.get(d.get("unit") or "kWh", 1.0)
        if d.get("kind") == "annual" and d.get("value") not in (None, ""):
            d["kwh"] = float(d["value"]) * k
        if d.get("kind") == "monthly":
            d["kwh_months"] = [None if v in (None, "") else float(v) * k for v in d.get("months") or []]
        m["data"] = d
        meters.append(m)
    # buildings pointing at a removed group fall back to the first group
    cids = [c["id"] for c in circuits]
    mids = [m["id"] for m in meters]
    blds = []
    for b in project.get("buildings", []):
        b = dict(b)
        for src, dst in (("known_heat_mwh", "known_heat_kwh"), ("known_el_mwh", "known_el_kwh")):
            v = b.get(src)
            if v not in (None, "") and dst not in b:
                b[dst] = float(v) * 1000.0
        if cids and b.get("circuit") not in cids:
            b["circuit"] = cids[0]
        if mids and b.get("meter") not in mids:
            b["meter"] = mids[0]
        blds.append(b)
    pr.update(circuits=circuits, meters=meters, buildings=blds)
    return pr


def _run(project: dict) -> dict:
    try:
        return model.run(_prepare(project))
    except (ValueError, KeyError, TypeError) as e:
        raise HTTPException(422, str(e))


@app.post("/api/model")
def run_model(body: ProjectIn) -> dict:
    return _run(body.project)


@app.post("/api/export/csv")
def export_csv(body: ProjectIn) -> Response:
    res = _run(body.project)
    name = f"oma_kulutusdata_{res['year']}.csv"
    return Response(export.oma_kulutusdata_csv(res, body.prices), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="{name}"'})


@app.post("/api/export/paste")
def export_paste(body: ProjectIn) -> PlainTextResponse:
    return PlainTextResponse(export.paste_block(_run(body.project)))
