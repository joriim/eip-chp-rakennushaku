"""Property (kiinteistö) and building data from MML open OGC API Features.

Same endpoints as dkk-flightmanager (geo/properties.py, geo/buildings.py), but
requested in the default CRS84 (lon/lat) so the browser map needs no
reprojection. Areas are computed in a local metric projection.

Buildings: Maastotietokanta collection `rakennus`. MTK has footprint, class and
floor count only - no floor area, year or heating method. The class codes below
follow dkk-flightmanager (confirmed empirically there).
"""

from __future__ import annotations

import math
import os
from dataclasses import dataclass

import requests
from shapely.geometry import Point, mapping, shape
from shapely.geometry.base import BaseGeometry
from shapely import transform as _shp_transform
from shapely.ops import unary_union

MML_BASE = os.environ.get("RAKENNUSHAKU_MML_BASE", "https://avoin-paikkatieto.maanmittauslaitos.fi")
PROPERTY_URL = f"{MML_BASE}/kiinteisto-avoin/simple-features/v3/collections/PalstanSijaintitiedot/items"
BUILDING_URL = f"{MML_BASE}/maastotiedot/features/v1/collections/rakennus/items"
GEOCODE_URL = f"{MML_BASE}/geocoding/v2/pelias/search"
ATTRIBUTION = "Sisältää Maanmittauslaitoksen Maastotietokannan ja kiinteistörekisterikartan aineistoa (CC BY 4.0)."

# kohdeluokka // 10 -> (label, default use type)
CLASS_GROUPS = {
    4221: ("Asuinrakennus", "asuin"),
    4222: ("Liike- tai julkinen rakennus", "toimisto"),
    4223: ("Lomarakennus", "muu"),
    4224: ("Teollinen rakennus", "korjaamo"),
    4225: ("Kirkollinen rakennus", "muu"),
    4226: ("Maatalous- tai varastorakennus", "tuotanto"),
    4227: ("Muu rakennus", "muu"),
}


class PropertyNotFound(LookupError):
    pass


class MissingApiKey(RuntimeError):
    pass


@dataclass
class Building:
    mtk_id: int
    kohdeluokka: int
    kerrosluku: int | None
    geometry: BaseGeometry  # CRS84
    alkupvm: str | None

    @property
    def class_label(self) -> str:
        return CLASS_GROUPS.get(self.kohdeluokka // 10, (f"Rakennus ({self.kohdeluokka})", "muu"))[0]

    @property
    def default_use(self) -> str:
        return CLASS_GROUPS.get(self.kohdeluokka // 10, ("", "muu"))[1]

    @property
    def floors(self) -> int:
        if self.kerrosluku and self.kerrosluku > 0:
            return int(self.kerrosluku)
        return 3 if self.kohdeluokka % 10 == 2 else 1

    @property
    def is_point(self) -> bool:
        return self.geometry.geom_type in ("Point", "MultiPoint")

    @property
    def footprint_m2(self) -> float | None:
        return None if self.is_point else area_m2(self.geometry)


def normalise_kt(tunnus: str) -> str:
    """'399-891-1-1' or '39989100010001' -> '39989100010001' (as in flightmanager)."""
    t = tunnus.strip().replace(" ", "")
    if "-" in t:
        parts = t.split("-")
        if len(parts) != 4 or not all(p.isdigit() for p in parts):
            raise ValueError("Kiinteistötunnus muodossa KKK-RRR-YYYY-XXXX tai 14 numeroa.")
        k, r, y, x = parts
        return k.zfill(3) + r.zfill(3) + y.zfill(4) + x.zfill(4)
    if len(t) == 14 and t.isdigit():
        return t
    raise ValueError("Kiinteistötunnus muodossa KKK-RRR-YYYY-XXXX tai 14 numeroa.")


def display_kt(numeric: str) -> str:
    return f"{int(numeric[0:3])}-{int(numeric[3:6])}-{int(numeric[6:10])}-{int(numeric[10:14])}"


def _local_metric(geom: BaseGeometry) -> BaseGeometry:
    c = geom.centroid
    lat0 = math.radians(c.y)
    kx = 111_320.0 * math.cos(lat0)
    ky = 110_574.0
    import numpy as np

    return _shp_transform(geom, lambda xy: np.column_stack([(xy[:, 0] - c.x) * kx, (xy[:, 1] - c.y) * ky]))


def area_m2(geom: BaseGeometry) -> float:
    return float(_local_metric(geom).area)


def _get_features(url: str, params: dict, session: requests.Session, timeout: int = 60) -> list[dict]:
    feats: list[dict] = []
    offset = 0
    limit = params.get("limit", 1000)
    next_url: str | None = None
    while True:
        if next_url:
            resp = session.get(next_url, timeout=timeout)
        else:
            p = dict(params)
            if offset:
                p["offset"] = offset
            resp = session.get(url, params=p, timeout=timeout)
        resp.raise_for_status()
        data = resp.json()
        page = data.get("features") or []
        feats.extend(page)
        nxt = [ln.get("href") for ln in data.get("links", []) if ln.get("rel") == "next"]
        if nxt and page:
            next_url = nxt[0]
            if "api-key=" not in next_url and params.get("api-key"):
                next_url += ("&" if "?" in next_url else "?") + "api-key=" + params["api-key"]
            continue
        if len(page) < limit:
            break
        offset += len(page)
        next_url = None
    return feats


def fetch_property(kt: str, api_key: str, session: requests.Session | None = None) -> dict:
    if not api_key:
        raise MissingApiKey("MML-rajapinta-avain puuttuu (MML_API_KEY).")
    num = normalise_kt(kt)
    sess = session or requests.Session()
    feats = _get_features(PROPERTY_URL, {"kiinteistotunnus": num, "limit": 100, "api-key": api_key}, sess)
    if not feats:
        raise PropertyNotFound(f"Kiinteistöä {display_kt(num)} ei löytynyt.")
    geom = unary_union([shape(f["geometry"]) for f in feats])
    return {
        "kiinteistotunnus": num,
        "display": display_kt(num),
        "area_ha": round(area_m2(geom) / 10_000, 2),
        "parts": len(feats),
        "geometry": mapping(geom),
    }


def looks_like_kt(text: str) -> bool:
    """Property ID (KKK-RRR-YYYY-XXXX or 14 digits) rather than a street address."""
    import re
    t = (text or "").strip()
    return bool(re.fullmatch(r"\d{1,3}-\d{1,3}-\d{1,4}-\d{1,4}", t) or re.fullmatch(r"\d{14}", t))


def geocode(text: str, api_key: str, session: requests.Session | None = None) -> list[dict]:
    """Street addresses matching *text* (NLS geocoding service, Pelias API)."""
    if not api_key:
        raise MissingApiKey("MML-rajapinta-avain puuttuu (MML_API_KEY).")
    sess = session or requests.Session()
    r = sess.get(GEOCODE_URL, params={"text": text, "sources": "addresses", "crs": "EPSG:4326", "size": 5,
                                      "lang": "fin", "api-key": api_key}, timeout=20)
    r.raise_for_status()
    out = []
    for f in r.json().get("features") or []:
        c = (f.get("geometry") or {}).get("coordinates") or []
        if len(c) >= 2:
            out.append({"label": (f.get("properties") or {}).get("label") or text, "lon": float(c[0]), "lat": float(c[1])})
    return out


def property_at(lon: float, lat: float, api_key: str, session: requests.Session | None = None) -> dict:
    """Find the property (palsta) containing a clicked point."""
    if not api_key:
        raise MissingApiKey("MML-rajapinta-avain puuttuu (MML_API_KEY).")
    sess = session or requests.Session()
    d = 0.0008
    feats = _get_features(
        PROPERTY_URL,
        {"bbox": f"{lon - d},{lat - d},{lon + d},{lat + d}", "limit": 100, "api-key": api_key},
        sess,
    )
    pt = Point(lon, lat)
    for f in feats:
        if shape(f["geometry"]).contains(pt):
            props = f.get("properties") or {}
            kt = str(props.get("kiinteistotunnus") or "")
            if kt:
                return fetch_property(kt, api_key, sess)
    raise PropertyNotFound("Pisteestä ei löytynyt kiinteistöä.")


def fetch_buildings(bbox: tuple[float, float, float, float], api_key: str, session: requests.Session | None = None) -> list[Building]:
    if not api_key:
        raise MissingApiKey("MML-rajapinta-avain puuttuu (MML_API_KEY).")
    sess = session or requests.Session()
    feats = _get_features(
        BUILDING_URL,
        {"bbox": ",".join(f"{v:.6f}" for v in bbox), "limit": 1000, "api-key": api_key},
        sess,
    )
    out: dict[int, Building] = {}
    for f in feats:
        try:
            p = f.get("properties") or {}
            mid = int(p["mtk_id"])
            kl = p.get("kerrosluku")
            out[mid] = Building(
                mtk_id=mid,
                kohdeluokka=int(p.get("kohdeluokka") or 0),
                kerrosluku=int(kl) if kl not in (None, "") else None,
                geometry=shape(f["geometry"]),
                alkupvm=p.get("alkupvm"),
            )
        except (KeyError, ValueError, TypeError):
            continue
    return list(out.values())


def buildings_for_area(area_geojson: dict, api_key: str, buffer_m: float = 60.0, session: requests.Session | None = None) -> list[dict]:
    """Buildings in the area's bbox (+buffer); each flagged on_property or neighbour.

    A building counts as on the property when its centroid lies inside the
    property or within 5 m of its boundary - MTK footprints and cadastral
    boundaries do not line up exactly.
    """
    area = shape(area_geojson)
    c = area.centroid
    dlat = buffer_m / 110_574.0
    dlon = buffer_m / (111_320.0 * math.cos(math.radians(c.y)))
    minx, miny, maxx, maxy = area.bounds
    bbox = (minx - dlon, miny - dlat, maxx + dlon, maxy + dlat)
    blds = fetch_buildings(bbox, api_key, session)
    tol = 5.0 / 110_574.0
    area_tol = area.buffer(tol)
    out = []
    for b in blds:
        on = area_tol.contains(b.geometry.centroid)  # same rule as the browser version
        fp = b.footprint_m2
        out.append(
            {
                "mtk_id": b.mtk_id,
                "kohdeluokka": b.kohdeluokka,
                "class_label": b.class_label,
                "default_use": b.default_use,
                "kerrosluku": b.kerrosluku,
                "floors": b.floors,
                "footprint_m2": round(fp, 1) if fp is not None else None,
                "is_point": b.is_point,
                "on_property": bool(on),
                "alkupvm": b.alkupvm,
                "geometry": mapping(b.geometry),
            }
        )
    out.sort(key=lambda d: (not d["on_property"], -(d["footprint_m2"] or 0)))
    return out
