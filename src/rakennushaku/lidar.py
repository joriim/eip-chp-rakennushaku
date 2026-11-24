"""Laser scanning data (NLS Laserkeilausaineisto 0,5 p) through the NLS file service.

The server version only relays: it submits the OGC API Processes job with the server's key, reports its
status and streams the LAZ files to the browser, which decodes and analyses them (static/lidar.js).
The input and result handling mirrors lidar.js (processInputs, lazFiles).
"""
from __future__ import annotations

import os
import re
from typing import Any, Iterable

import requests

from .mml import MML_BASE, MissingApiKey

PROC_URL = f"{MML_BASE}/tiedostopalvelu/ogcproc/v1"
PROCESS = "laserkeilausaineisto_05_karttalehti"
FILE_PREFIX = f"{MML_BASE}/tiedostopalvelu/"
SHEET_RE = re.compile(r"^[K-X][2-6][1-4]{3}[A-H][1-4]$")
MAX_SHEETS = 6


def process_inputs(desc: dict | None, sheets: list[str]) -> dict:
    """Map sheets and LAZ, plus the newest value of any other required choice in the process description."""
    inputs: dict[str, Any] = {"mapSheetInput": sheets}
    defs = (desc or {}).get("inputs") or {}
    items = defs if isinstance(defs, list) else [{"id": k, **(v or {})} for k, v in defs.items()]
    for d in items:
        iid = d.get("id")
        if not iid or iid == "mapSheetInput":
            continue
        sch = d.get("schema") or {}
        en = sch.get("enum") or (sch.get("items") or {}).get("enum")
        if iid == "fileFormatInput":
            inputs[iid] = en[0] if en and "LAZ" not in en else "LAZ"
            continue
        required = (1 if d.get("minOccurs") is None else d["minOccurs"]) > 0
        if required and en:
            inputs[iid] = [en[-1]] if sch.get("type") == "array" else en[-1]
        elif required and sch.get("default") is not None:
            inputs[iid] = sch["default"]
    inputs.setdefault("fileFormatInput", "LAZ")
    return inputs


def laz_files(results: Any) -> list[dict]:
    """LAZ download links from a results document; the newest file per map sheet."""
    found: list[dict] = []

    def walk(o: Any) -> None:
        if isinstance(o, list):
            for v in o:
                walk(v)
            return
        if not isinstance(o, dict):
            return
        path = o.get("path") or o.get("href") or o.get("url")
        if isinstance(path, str) and (re.search(r"\.laz(\?|$)", path, re.I) or "laz" in str(o.get("format") or o.get("type") or "").lower()):
            m = re.search(r"([K-X]\d{4}[A-H]\d)", path)
            sheet = o.get("mapSheetNumber") or o.get("mapSheet") or (m.group(1) if m else "")
            y = re.search(r"(20\d\d)", str(o.get("year") or o.get("productionYear") or path))
            found.append({"path": path, "sheet": sheet, "year": int(y.group(1)) if y else 0,
                          "length": o.get("length") or o.get("size"), "name": path.split("/")[-1].split("?")[0]})
        for k, v in o.items():
            if k != "path":
                walk(v)

    walk(results)
    best: dict[str, dict] = {}
    for f in found:
        k = f["sheet"] or f["name"]
        if k not in best or f["year"] > best[k]["year"]:
            best[k] = f
    return list(best.values())


def _check_sheets(sheets: Iterable[str]) -> list[str]:
    out = sorted({str(s).strip().upper() for s in sheets})
    if not out:
        raise ValueError("Karttalehtiä ei annettu.")
    if len(out) > MAX_SHEETS:
        raise ValueError(f"Enintään {MAX_SHEETS} karttalehteä kerralla.")
    bad = [s for s in out if not SHEET_RE.match(s)]
    if bad:
        raise ValueError(f"Virheellinen karttalehti: {', '.join(bad)} (odotettu 1:5000-lehti, esim. L4133B3).")
    return out


def submit(sheets: Iterable[str], api_key: str, session: requests.Session) -> str:
    if not api_key:
        raise MissingApiKey("MML-rajapinta-avain puuttuu (MML_API_KEY).")
    sheets = _check_sheets(sheets)
    try:
        r = session.get(f"{PROC_URL}/processes/{PROCESS}", params={"api-key": api_key}, timeout=20)
        r.raise_for_status()
        desc = r.json()
    except (requests.RequestException, ValueError):
        desc = None
    body = {"id": PROCESS, "inputs": process_inputs(desc, sheets)}
    r = session.post(f"{PROC_URL}/processes/{PROCESS}/execution", params={"api-key": api_key}, json=body, timeout=30)
    r.raise_for_status()
    js = r.json()
    job = js.get("jobID") or js.get("jobId") or js.get("id")
    if not job:
        raise ValueError("MML:n tiedostopalvelu ei palauttanut työn tunnistetta.")
    return str(job)


def status(job: str, api_key: str, session: requests.Session) -> dict:
    if not re.match(r"^[\w.-]{1,100}$", job):
        raise ValueError("Virheellinen työn tunniste.")
    r = session.get(f"{PROC_URL}/jobs/{job}", params={"api-key": api_key}, timeout=20)
    r.raise_for_status()
    s = r.json()
    out = {"status": s.get("status"), "progress": s.get("progress"), "message": s.get("message")}
    if s.get("status") == "successful":
        r = session.get(f"{PROC_URL}/jobs/{job}/results", params={"api-key": api_key}, timeout=20)
        r.raise_for_status()
        out["files"] = laz_files(r.json())
    return out


def allowed_file(url: str) -> bool:
    """Only NLS file service downloads are relayed (no open proxy)."""
    return isinstance(url, str) and url.startswith(FILE_PREFIX) and ".." not in url


def open_file(url: str, api_key: str, session: requests.Session) -> requests.Response:
    r = session.get(url, params={"api-key": api_key}, stream=True, timeout=60)
    r.raise_for_status()
    return r
