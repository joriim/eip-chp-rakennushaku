"""Hourly outdoor temperature for a year, on the calculator's 8 760 h fixed-EET base.

Sources
- FMI open data (Ilmatieteen laitos, CC BY 4.0): nearest weather stations and
  their hourly mean temperature TA_PT1H_AVG. The value stamped at t is the mean
  of the hour ending at t.
- Open-Meteo historical archive (ERA5-based reanalysis at the farm's
  coordinates, CC BY 4.0). Free API for non-commercial use.
- The user's own CSV (parsed with series_parser).

Responses are cached on disk; a past year never changes.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import requests

from rakennushaku.timebase import HOURS, fill_gaps, hour_index

FMI_WFS = os.environ.get("RAKENNUSHAKU_FMI_WFS", "https://opendata.fmi.fi/wfs")
OPEN_METEO = os.environ.get("RAKENNUSHAKU_OPEN_METEO", "https://archive-api.open-meteo.com/v1/archive")
CACHE_DIR = Path(os.environ.get("RAKENNUSHAKU_CACHE", Path.home() / ".cache" / "rakennushaku"))

FMI_ATTR = "Ilmatieteen laitos, avoin data (CC BY 4.0)"
OM_ATTR = "Open-Meteo.com, ERA5-uudelleenanalyysi (CC BY 4.0)"


# --------------------------------------------------------------------------- cache

def _cache_get(key: str, max_age_s: float | None) -> str | None:
    p = CACHE_DIR / (hashlib.sha1(key.encode()).hexdigest() + ".txt")
    if not p.exists():
        return None
    if max_age_s is not None and time.time() - p.stat().st_mtime > max_age_s:
        return None
    return p.read_text(encoding="utf-8")


def _cache_put(key: str, text: str) -> None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    p = CACHE_DIR / (hashlib.sha1(key.encode()).hexdigest() + ".txt")
    tmp = p.with_suffix(".tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(p)


def _get_text(url: str, params: dict, session: requests.Session, max_age_s: float | None) -> str:
    key = url + "?" + json.dumps(params, sort_keys=True)
    hit = _cache_get(key, max_age_s)
    if hit is not None:
        return hit
    r = session.get(url, params=params, timeout=90)
    r.raise_for_status()
    _cache_put(key, r.text)
    return r.text


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


# --------------------------------------------------------------------------- FMI

def parse_fmi_stations(xml_text: str) -> list[dict]:
    root = ET.fromstring(xml_text)
    out = []
    for fac in root.iter():
        if _local(fac.tag) != "EnvironmentalMonitoringFacility":
            continue
        st: dict = {"fmisid": None, "name": None, "lat": None, "lon": None, "begin": None, "end": None}
        for el in fac.iter():
            t = _local(el.tag)
            cs = el.attrib.get("codeSpace", "")
            if t == "identifier" and "fmisid" in cs:
                st["fmisid"] = int(el.text)
            elif t == "name" and st["name"] is None and (cs.endswith("/name") or not cs):
                st["name"] = (el.text or "").strip()
            elif t == "pos" and st["lat"] is None:
                a, b = (float(v) for v in el.text.split()[:2])
                st["lat"], st["lon"] = a, b
            elif t == "beginPosition" and st["begin"] is None:
                st["begin"] = (el.text or "")[:10] or None
            elif t == "endPosition" and st["end"] is None:
                st["end"] = (el.text or "")[:10] or el.attrib.get("indeterminatePosition")
        if st["fmisid"] and st["lat"] is not None:
            out.append(st)
    return out


def fmi_stations(session: requests.Session | None = None) -> list[dict]:
    sess = session or requests.Session()
    xml = _get_text(
        FMI_WFS,
        {"service": "WFS", "version": "2.0.0", "request": "getFeature",
         "storedquery_id": "fmi::ef::stations", "networkid": "121"},
        sess,
        max_age_s=30 * 86400,
    )
    return parse_fmi_stations(xml)


def nearest_stations(lat: float, lon: float, year: int, n: int = 6, session: requests.Session | None = None) -> list[dict]:
    out = []
    for st in fmi_stations(session):
        # skip stations closed before the year or opened after it
        if st.get("begin") and st["begin"][:4].isdigit() and int(st["begin"][:4]) > year:
            continue
        end = st.get("end")
        if end and end[:4].isdigit() and int(end[:4]) < year:
            continue
        d = haversine_km(lat, lon, st["lat"], st["lon"])
        out.append({**st, "distance_km": round(d, 1)})
    out.sort(key=lambda s: s["distance_km"])
    return out[:n]


def parse_fmi_simple(xml_text: str) -> list[tuple[datetime, float | None]]:
    root = ET.fromstring(xml_text)
    out = []
    for el in root.iter():
        if _local(el.tag) != "BsWfsElement":
            continue
        t = v = None
        for c in el:
            name = _local(c.tag)
            if name == "Time":
                t = datetime.fromisoformat(c.text.replace("Z", "+00:00"))
            elif name == "ParameterValue":
                try:
                    v = float(c.text)
                    if math.isnan(v):
                        v = None
                except (TypeError, ValueError):
                    v = None
        if t is not None:
            out.append((t, v))
    return out


def fmi_temperature(fmisid: int, year: int, session: requests.Session | None = None) -> dict:
    sess = session or requests.Session()
    start = datetime(year, 1, 1, tzinfo=timezone(timedelta(hours=2))).astimezone(timezone.utc)
    end = datetime(year + 1, 1, 1, tzinfo=timezone(timedelta(hours=2))).astimezone(timezone.utc)
    now = datetime.now(timezone.utc)
    series = np.full(HOURS, np.nan)
    t0 = start
    while t0 < end:
        t1 = min(t0 + timedelta(days=28), end)
        if t0 > now:
            break
        past = t1 < now - timedelta(days=2)
        xml = _get_text(
            FMI_WFS,
            {"service": "WFS", "version": "2.0.0", "request": "getFeature",
             "storedquery_id": "fmi::observations::weather::hourly::simple",
             "fmisid": str(fmisid), "parameters": "TA_PT1H_AVG",
             "starttime": (t0 + timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ"),
             "endtime": t1.strftime("%Y-%m-%dT%H:%M:%SZ"), "timestep": "60"},
            sess,
            max_age_s=None if past else 3600,
        )
        for t, v in parse_fmi_simple(xml):
            idx = hour_index(t - timedelta(hours=1), year)  # value = mean of hour ending at t
            if idx is not None and v is not None:
                series[idx] = v
        t0 = t1
    return _finish(series, source=f"FMI asema {fmisid}", attribution=FMI_ATTR)


# --------------------------------------------------------------------------- Open-Meteo

def open_meteo_temperature(lat: float, lon: float, year: int, session: requests.Session | None = None) -> dict:
    sess = session or requests.Session()
    past = year < datetime.now().year
    text = _get_text(
        OPEN_METEO,
        {"latitude": round(lat, 4), "longitude": round(lon, 4),
         "start_date": f"{year - 1}-12-31", "end_date": f"{year}-12-31",
         "hourly": "temperature_2m", "timezone": "GMT"},
        sess,
        max_age_s=None if past else 86400,
    )
    data = json.loads(text)
    times = data["hourly"]["time"]
    temps = data["hourly"]["temperature_2m"]
    inst = {}
    for t, v in zip(times, temps):
        if v is not None:
            inst[datetime.fromisoformat(t).replace(tzinfo=timezone.utc)] = float(v)
    series = np.full(HOURS, np.nan)
    for t, v in inst.items():
        idx = hour_index(t, year)
        if idx is None:
            continue
        nxt = inst.get(t + timedelta(hours=1))
        series[idx] = v if nxt is None else 0.5 * (v + nxt)  # instantaneous -> hour mean
    return _finish(series, source=f"Open-Meteo {lat:.3f}, {lon:.3f}", attribution=OM_ATTR)


# --------------------------------------------------------------------------- common

def _finish(series: np.ndarray, source: str, attribution: str) -> dict:
    raw_missing = int(np.isnan(series).sum())
    filled, n_interp, still = fill_gaps(series, max_gap=6)
    return {
        "source": source,
        "attribution": attribution,
        "values": [None if np.isnan(v) else round(float(v), 2) for v in filled],
        "missing_raw": raw_missing,
        "interpolated": n_interp,
        "missing": still,
        "mean": round(float(np.nanmean(filled)), 2) if still < HOURS else None,
        "min": round(float(np.nanmin(filled)), 1) if still < HOURS else None,
        "max": round(float(np.nanmax(filled)), 1) if still < HOURS else None,
    }


def patch_gaps(primary: dict, secondary: dict) -> dict:
    """Fill hours still missing in primary from secondary (e.g. FMI <- Open-Meteo)."""
    vals = list(primary["values"])
    n = 0
    for i, v in enumerate(vals):
        if v is None and secondary["values"][i] is not None:
            vals[i] = secondary["values"][i]
            n += 1
    out = dict(primary)
    out["values"] = vals
    out["missing"] = sum(v is None for v in vals)
    out["patched_from"] = secondary["source"] if n else None
    out["patched"] = n
    return out
