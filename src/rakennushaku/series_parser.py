"""Read a time-series file (Datahub export, heat meter log, weather CSV) into 8 760 h.

Handles:
- delimiter ; , or tab, decimal comma
- ISO timestamps with Z/offset, or naive local times (Europe/Helsinki with
  summer time; the repeated autumn hour is detected), or d.m.yyyy hh:mm
- 15/30/60-minute resolution: energy is summed into hours, temperature averaged
- Wh / kWh / MWh units
- timestamps marking the start (default, as in Datahub) or end of each interval
"""

from __future__ import annotations

import csv
import io
import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from statistics import median
from zoneinfo import ZoneInfo

import numpy as np

from rakennushaku.timebase import HOURS, hour_index

HEL = ZoneInfo("Europe/Helsinki")

_DT_PATTERNS = [
    (re.compile(r"^\d{4}-\d{2}-\d{2}[T ]\d{1,2}:\d{2}"), "iso"),
    (re.compile(r"^\d{1,2}\.\d{1,2}\.\d{4}\s+\d{1,2}[:.]\d{2}"), "fi"),
]
_VALUE_HINTS = re.compile(
    r"määrä|maara|kulutus|kwh|wh|energia|value|amount|lämpötila|lampotila|temp|°c|arvo",
    re.I,
)


@dataclass
class ParsedSeries:
    values: list[float | None]  # 8 760, None = missing
    year: int
    kind: str  # "energy" | "temperature"
    resolution_min: int
    rows_read: int
    rows_used: int
    hours_complete: int
    hours_missing: int
    timestamp_column: str
    value_column: str
    unit: str
    notes: list[str] = field(default_factory=list)

    def array(self) -> np.ndarray:
        return np.array([np.nan if v is None else v for v in self.values], dtype=float)


class SeriesParseError(ValueError):
    pass


def _sniff_delimiter(text: str) -> str:
    head = "\n".join(text.splitlines()[:20])
    counts = {d: head.count(d) for d in (";", "\t", ",")}
    # a decimal-comma file with ; delimiter has many commas too: prefer ; and tab
    if counts[";"] >= 5:
        return ";"
    if counts["\t"] >= 5:
        return "\t"
    return ","


def _to_float(s: str) -> float | None:
    s = s.strip().replace(" ", "").replace(" ", "")
    if not s or s.lower() in {"nan", "-", "null", "none"}:
        return None
    if "," in s and "." in s:
        s = s.replace(".", "").replace(",", ".") if s.rfind(",") > s.rfind(".") else s.replace(",", "")
    else:
        s = s.replace(",", ".")
    try:
        return float(s)
    except ValueError:
        return None


def _looks_dt(s: str) -> bool:
    s = s.strip()
    return any(p.match(s) for p, _ in _DT_PATTERNS)


def _parse_dt(s: str, naive_tz: str, prev_local: datetime | None) -> tuple[datetime, datetime | None]:
    """Return (aware UTC datetime, naive local datetime used for fold detection)."""
    s = s.strip()
    if re.match(r"^\d{1,2}\.\d{1,2}\.\d{4}", s):
        d, rest = s.split(None, 1) if " " in s else (s, "0:00")
        dd, mm, yyyy = d.split(".")
        rest = rest.replace(".", ":")
        parts = rest.split(":")
        hh, mi = int(parts[0]), int(parts[1]) if len(parts) > 1 else 0
        ss = int(parts[2]) if len(parts) > 2 else 0
        naive = datetime(int(yyyy), int(mm), int(dd), hh, mi, ss)
        aware = None
    else:
        iso = s.replace(" ", "T", 1)
        if iso.endswith("Z"):
            iso = iso[:-1] + "+00:00"
        dt = datetime.fromisoformat(iso)
        if dt.tzinfo is not None:
            return dt.astimezone(timezone.utc), None
        naive, aware = dt, None
    if naive_tz == "utc":
        return naive.replace(tzinfo=timezone.utc), naive
    if naive_tz == "eet":
        return naive.replace(tzinfo=timezone(timedelta(hours=2))).astimezone(timezone.utc), naive
    # Europe/Helsinki local time with summer time. In the repeated autumn hour
    # the local clock goes back: every stamp not past the latest one seen so
    # far belongs to the second pass (fold=1).
    fold = 1 if (prev_local is not None and naive <= prev_local) else 0
    local = naive.replace(tzinfo=HEL, fold=fold)
    return local.astimezone(timezone.utc), naive


def parse_series(
    text: str,
    *,
    kind: str = "energy",
    year: int | None = None,
    unit: str = "auto",
    naive_tz: str = "local",
    stamp_at: str = "start",
    timestamp_column: str | None = None,
    value_column: str | None = None,
) -> ParsedSeries:
    """Parse *text* into an 8 760-hour series for *year* (default: the most common year)."""
    if text.startswith("﻿"):
        text = text[1:]
    lines = [ln for ln in text.splitlines() if ln.strip()]
    if len(lines) < 3:
        raise SeriesParseError("Tiedostossa on liian vähän rivejä.")
    delim = _sniff_delimiter(text)
    rows = list(csv.reader(io.StringIO("\n".join(lines)), delimiter=delim))

    # header = first row whose cells are mostly non-numeric and not timestamps
    first = rows[0]
    has_header = not any(_looks_dt(c) for c in first) and sum(_to_float(c) is not None for c in first) < len(first) / 2
    header = [c.strip() for c in first] if has_header else [f"sarake {i + 1}" for i in range(len(first))]
    data = rows[1:] if has_header else rows
    ncol = max(len(r) for r in data)
    header += [f"sarake {i + 1}" for i in range(len(header), ncol)]

    def col_index(name: str | None, role: str) -> int | None:
        if name is None:
            return None
        if name in header:
            return header.index(name)
        raise SeriesParseError(f"Saraketta '{name}' ei löydy ({role}).")

    sample = data[: min(len(data), 200)]
    ti = col_index(timestamp_column, "aika")
    if ti is None:
        scores = [sum(_looks_dt(r[i]) for r in sample if i < len(r)) for i in range(ncol)]
        ti = int(np.argmax(scores))
        if scores[ti] < len(sample) * 0.8:
            raise SeriesParseError("Aikaleimasaraketta ei tunnistettu. Valitse se käsin.")
    vi = col_index(value_column, "arvo")
    if vi is None:
        numeric = [
            i for i in range(ncol)
            if i != ti and sum(_to_float(r[i]) is not None for r in sample if i < len(r)) >= len(sample) * 0.6
        ]
        if not numeric:
            raise SeriesParseError("Numeerista arvosaraketta ei löytynyt.")
        hinted = [i for i in numeric if _VALUE_HINTS.search(header[i])]
        # drop ID-like columns (huge constant numbers such as metering point IDs)
        def is_id(i: int) -> bool:
            vals = {r[i].strip() for r in sample if i < len(r)}
            return len(vals) == 1 and len(next(iter(vals))) > 10
        candidates = [i for i in (hinted or numeric) if not is_id(i)] or numeric
        vi = candidates[-1] if not hinted else candidates[0]

    notes: list[str] = []
    stamps: list[datetime] = []
    vals: list[float | None] = []
    prev_local = None
    for r in data:
        if ti >= len(r) or not _looks_dt(r[ti]):
            continue
        try:
            t, prev_local_new = _parse_dt(r[ti], naive_tz, prev_local)
        except ValueError:
            continue
        if prev_local_new is not None:
            prev_local = prev_local_new if prev_local is None else max(prev_local, prev_local_new)
        stamps.append(t)
        vals.append(_to_float(r[vi]) if vi < len(r) else None)
    if len(stamps) < 3:
        raise SeriesParseError("Aikaleimoja ei saatu luettua.")

    diffs = [
        (b - a).total_seconds() / 60
        for a, b in zip(stamps[:200], stamps[1:201])
        if (b - a).total_seconds() > 0
    ]
    res = int(round(median(diffs))) if diffs else 60
    if res not in (5, 10, 15, 30, 60):
        notes.append(f"Epätavallinen aika-askel {res} min; käsitelty sellaisenaan.")
    if res > 60:
        raise SeriesParseError(f"Aika-askel {res} min on liian pitkä tuntisarjaksi. Käytä kuukausi- tai vuosisummaa.")

    if stamp_at == "end":
        stamps = [t - timedelta(minutes=res) for t in stamps]

    # unit scaling for energy
    hname = header[vi].lower()
    if kind == "energy":
        if unit == "auto":
            unit = "MWh" if "mwh" in hname else ("Wh" if re.search(r"(?<![km])wh", hname) else "kWh")
        scale = {"Wh": 0.001, "kWh": 1.0, "MWh": 1000.0}[unit]
    else:
        unit = "°C"
        scale = 1.0

    if year is None:
        years = [t.astimezone(timezone(timedelta(hours=2))).year for t in stamps]
        year = max(set(years), key=years.count)

    per_hour = 60 // res if res in (5, 10, 15, 30, 60) else 1
    acc = np.zeros(HOURS)
    cnt = np.zeros(HOURS, dtype=int)
    used = 0
    for t, v in zip(stamps, vals):
        if v is None:
            continue
        idx = hour_index(t, year)
        if idx is None:
            continue
        acc[idx] += v * scale
        cnt[idx] += 1
        used += 1

    out: list[float | None] = [None] * HOURS
    complete = 0
    partial = 0
    for i in range(HOURS):
        if cnt[i] == 0:
            continue
        if kind == "energy":
            if cnt[i] >= per_hour:
                out[i] = float(acc[i]) * per_hour / cnt[i]  # cnt>per_hour only on bad duplicates
                complete += 1
            else:
                partial += 1
        else:
            out[i] = float(acc[i] / cnt[i])
            complete += 1
    if partial:
        notes.append(f"{partial} tuntia oli vajaita (puuttuvia varttiarvoja); ne käsitellään puuttuvina.")
    dup = int((cnt > per_hour).sum())
    if dup:
        notes.append(f"{dup} tunnilla oli tavallista enemmän rivejä; arvot skaalattiin tunnin tasolle.")

    return ParsedSeries(
        values=out,
        year=year,
        kind=kind,
        resolution_min=res,
        rows_read=len(data),
        rows_used=used,
        hours_complete=complete,
        hours_missing=HOURS - complete,
        timestamp_column=header[ti],
        value_column=header[vi],
        unit=unit,
        notes=notes,
    )
