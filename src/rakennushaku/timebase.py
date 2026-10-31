"""Laskurin aikakanta: 8 760 tuntia kiinteässä EET-ajassa (UTC+2).

Rivi 0 = 1.1. klo 00–01 EET, rivi 8759 = 31.12. klo 23–24 EET.
Kesäaikaa ei käytetä, karkausvuoden 29.2. poistetaan. Sama aikakanta kuin
Maatilan hybridienergialaskurin Oma kulutusdata -välilehdellä.
"""

from __future__ import annotations

import calendar
from datetime import date, datetime, timedelta, timezone

import numpy as np

HOURS = 8760
EET = timezone(timedelta(hours=2))


def hour_index(ts_utc: datetime, year: int) -> int | None:
    """Return the 0-based row for the hour that *starts* at ts_utc, or None.

    ts_utc must be timezone-aware. Hours outside the EET year and on 29.2.
    return None.
    """
    e = ts_utc.astimezone(EET)
    if e.year != year:
        return None
    if e.month == 2 and e.day == 29:
        return None
    doy = (e.date() - date(year, 1, 1)).days
    if calendar.isleap(year) and e.month > 2:
        doy -= 1
    return doy * 24 + e.hour


def hour_starts_utc(year: int) -> list[datetime]:
    """UTC start time of every row (8 760 values)."""
    out = []
    t = datetime(year, 1, 1, tzinfo=EET)
    end = datetime(year + 1, 1, 1, tzinfo=EET)
    while t < end:
        if not (t.month == 2 and t.day == 29):
            out.append(t.astimezone(timezone.utc))
        t += timedelta(hours=1)
    assert len(out) == HOURS
    return out


def calendar_columns(year: int) -> dict[str, np.ndarray]:
    """Month (1–12), day of month, hour of day (EET) and weekday (0 = Mon)."""
    months, days, hours, wdays = [], [], [], []
    for t in hour_starts_utc(year):
        e = t.astimezone(EET)
        months.append(e.month)
        days.append(e.day)
        hours.append(e.hour)
        wdays.append(e.weekday())
    return {
        "month": np.array(months),
        "day": np.array(days),
        "hour": np.array(hours),
        "weekday": np.array(wdays),
    }


def monthly_sum(series: np.ndarray, year: int) -> np.ndarray:
    m = calendar_columns(year)["month"]
    return np.array([np.nansum(series[m == k]) for k in range(1, 13)])


def fill_gaps(series: np.ndarray, max_gap: int = 6) -> tuple[np.ndarray, int, int]:
    """Linear interpolation over gaps of at most max_gap hours.

    Returns (filled, n_interpolated, n_still_missing).
    """
    s = series.astype(float).copy()
    isnan = np.isnan(s)
    if not isnan.any():
        return s, 0, 0
    n_interp = 0
    i = 0
    n = len(s)
    while i < n:
        if not isnan[i]:
            i += 1
            continue
        j = i
        while j < n and isnan[j]:
            j += 1
        gap = j - i
        if gap <= max_gap and i > 0 and j < n:
            s[i:j] = np.linspace(s[i - 1], s[j], gap + 2)[1:-1]
            n_interp += gap
        elif gap <= max_gap and (i > 0 or j < n):  # short gap at the start or end of the year
            s[i:j] = s[j] if i == 0 else s[i - 1]
            n_interp += gap
        i = j
    return s, n_interp, int(np.isnan(s).sum())
