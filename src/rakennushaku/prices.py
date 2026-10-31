"""Finnish day-ahead spot prices for a year on the calculator's 8 760 h fixed-EET base.

Source: Sähkötin (Pakastin Oy), Nord Pool FI area, €/MWh without VAT, hourly with
UTC stamps (from 1.10.2025 the hour is the mean of the 15-minute prices). The free
API is for non-commercial use and Nord Pool owns the data: prices are fetched for
the user's own analysis and never bundled with the app.
"""

from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone

import numpy as np
import requests

from rakennushaku.timebase import EET, HOURS, calendar_columns, hour_index, hour_starts_utc

SAHKOTIN = os.environ.get("RAKENNUSHAKU_SAHKOTIN", "https://sahkotin.fi/prices.csv")
PRICE_YEARS = [2023, 2024, 2025, 2026]  # calculator Hintahistoria columns C–F
ATTR = "Pörssihinnat: Sähkötin (sahkotin.fi), Nord Pool FI-alue, €/MWh alv 0. Ilmainen rajapinta ei-kaupalliseen käyttöön."


def parse_price_csv(text: str, year: int) -> dict:
    acc = np.zeros(HOURS)
    cnt = np.zeros(HOURS, dtype=int)
    for line in text.splitlines()[1:]:
        parts = line.strip().split(",")
        if len(parts) < 2 or not parts[1].strip():
            continue
        try:
            t = datetime.fromisoformat(parts[0].replace("Z", "+00:00"))
            v = float(parts[1])
        except ValueError:
            continue
        idx = hour_index(t, year)
        if idx is None:
            continue
        acc[idx] += v
        cnt[idx] += 1
    values = [round(float(acc[i] / cnt[i]), 2) if cnt[i] else None for i in range(HOURS)]
    return stats(values, year)


def stats(values: list[float | None], year: int) -> dict:
    ok = [v for v in values if v is not None]
    soon = datetime.now(timezone.utc) + timedelta(hours=36)
    future = sum(1 for t, v in zip(hour_starts_utc(year), values) if v is None and t > soon)
    return {
        "year": year, "values": values, "hours": len(ok), "missing": HOURS - len(ok), "future": future,
        "mean": sum(ok) / len(ok) if ok else None, "min": min(ok) if ok else None, "max": max(ok) if ok else None,
        "negative": sum(1 for v in ok if v < 0), "source": "Sähkötin, Nord Pool FI",
    }


def fetch_prices(year: int, session: requests.Session | None = None) -> dict:
    sess = session or requests.Session()
    start = datetime(year, 1, 1, tzinfo=EET).astimezone(timezone.utc)
    end = datetime(year + 1, 1, 1, tzinfo=EET).astimezone(timezone.utc) - timedelta(milliseconds=1)
    iso = lambda d: d.strftime("%Y-%m-%dT%H:%M:%S.") + f"{d.microsecond // 1000:03d}Z"  # noqa: E731
    r = sess.get(SAHKOTIN, params={"start": iso(start), "end": iso(end)}, timeout=60)
    r.raise_for_status()
    return parse_price_csv(r.text, year)


def _fi(v: float | None, nd: int = 2) -> str:
    return "" if v is None else f"{v:.{nd}f}".replace(".", ",")


def hintahistoria_csv(by_year: dict) -> str:
    """Same columns as the calculator's Hintahistoria sheet (A Tunti, B Aika, C–F 2023–2026)."""
    cal = calendar_columns(2023)
    lines = ["Tunti;Aika (EET, UTC+2);" + ";".join(str(y) for y in PRICE_YEARS)]
    for i in range(HOURS):
        cols = [_fi((by_year.get(str(y)) or by_year.get(y) or [None] * HOURS)[i]) for y in PRICE_YEARS]
        lines.append(f"{i + 1};{cal['day'][i]:02d}.{cal['month'][i]:02d}. klo {cal['hour'][i]:02d};" + ";".join(cols))
    return "﻿" + "\r\n".join(lines) + "\r\n"


def paste_prices(by_year: dict) -> str:
    rows = []
    for i in range(HOURS):
        rows.append("\t".join(_fi((by_year.get(str(y)) or by_year.get(y) or [None] * HOURS)[i]) for y in PRICE_YEARS))
    return "\r\n".join(rows)
