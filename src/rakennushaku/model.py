"""Hourly heat and electricity model for the farm's selected buildings.

Each building gets a weather-driven part and a base part:

    heat_h = A · [ H · max(0, T_set − ΔT_gain − T_out,h) + q_base ] · 1/1000      kWh
    el_h   = A · [ e_base + e_vent · max(0, T_out,h − 12 °C) ] · profile_h · 1/1000 kWh

A = heated floor area (m²), H = lumped heat-loss coefficient incl. ventilation
(W/m²K), ΔT_gain = temperature rise from animals, people and equipment. The
broiler house follows a batch cycle (set point falls and animal heat rises as
the birds grow; heating stops between batches except for pre-heating).

The default parameters are illustrative starting points for the profile
*shape*. Totals come from calibration against the farm's own data:

- annual total -> one scale factor (shape from the model)
- monthly totals -> least squares  E_m ≈ a·W_m + b·B_m  (weather and base part)
- hourly series -> the measured hours are used as such; a, b fitted on them
  fill the missing hours

Fit is reported as CV(RMSE) (ASHRAE Guideline 14: monthly ≤ 15 %, hourly ≤ 30 %).
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from rakennushaku.timebase import HOURS, calendar_columns, monthly_sum

USE_TYPES: dict[str, dict] = {
    "broileri": {"label": "Broilerikasvattamo", "t_set": 21.0, "gain": 0.0, "H": 2.2, "q_base": 0.0,
                 "e_base": 3.0, "e_vent": 0.25, "profile": "flat", "cycle": "broiler"},
    "lihasika": {"label": "Lihasikala", "t_set": 19.0, "gain": 11.0, "H": 1.6, "q_base": 0.0,
                 "e_base": 2.5, "e_vent": 0.30, "profile": "flat"},
    "emakko": {"label": "Emakko- tai porsastuotanto", "t_set": 22.0, "gain": 7.0, "H": 1.6, "q_base": 2.0,
               "e_base": 3.5, "e_vent": 0.30, "profile": "flat"},
    "navetta": {"label": "Navetta (lypsykarja)", "t_set": 10.0, "gain": 9.0, "H": 1.0, "q_base": 3.0,
                "e_base": 4.0, "e_vent": 0.20, "profile": "milking"},
    "asuin": {"label": "Asuinrakennus", "t_set": 21.0, "gain": 3.0, "H": 1.3, "q_base": 3.0,
              "e_base": 4.0, "e_vent": 0.0, "profile": "home"},
    "toimisto": {"label": "Toimisto tai sosiaalitila", "t_set": 21.0, "gain": 3.0, "H": 1.3, "q_base": 1.5,
                 "e_base": 3.0, "e_vent": 0.0, "profile": "workday"},
    "korjaamo": {"label": "Konehalli tai korjaamo", "t_set": 12.0, "gain": 1.0, "H": 0.9, "q_base": 0.0,
                 "e_base": 1.0, "e_vent": 0.0, "profile": "workday"},
    "kuivuri": {"label": "Viljankuivuri (elo–lokakuu)", "t_set": 0.0, "gain": 0.0, "H": 0.0, "q_base": 60.0,
                "e_base": 12.0, "e_vent": 0.0, "profile": "flat", "season": (212, 288)},
    "muu": {"label": "Muu lämmitetty tila", "t_set": 17.0, "gain": 2.0, "H": 1.0, "q_base": 0.0,
            "e_base": 1.5, "e_vent": 0.0, "profile": "flat"},
}

_PROFILES = {
    "flat": [1.0] * 24,
    "home": [0.6, 0.5, 0.5, 0.5, 0.5, 0.6, 0.9, 1.3, 1.2, 0.9, 0.8, 0.9,
             1.0, 0.9, 0.9, 1.0, 1.2, 1.5, 1.7, 1.6, 1.5, 1.3, 1.0, 0.8],
    "milking": [0.7, 0.7, 0.7, 0.7, 0.8, 1.5, 1.8, 1.7, 1.2, 0.9, 0.9, 0.9,
                0.9, 0.9, 0.9, 1.0, 1.5, 1.8, 1.7, 1.2, 0.9, 0.8, 0.7, 0.7],
}


def daily_profile(name: str, hour: np.ndarray, weekday: np.ndarray) -> np.ndarray:
    if name == "workday":
        base = np.where((hour >= 7) & (hour < 16), 1.8, 0.5)
        base = np.where(weekday >= 5, 0.5, base)
    else:
        base = np.array(_PROFILES.get(name, _PROFILES["flat"]))[hour]
    return base / base.mean()


FROST_T = 8.0  # °C kept in an empty broiler house (own assumption)
BROILER_T0, BROILER_T27 = 30.0, 20.0  # Aviagen Ross handbook 2025: 30 °C day 0, 20 °C from day 27


@dataclass
class BroilerCycle:
    batch_days: int = 35
    empty_days: int = 12
    preheat_days: int = 2
    first_placement_doy: int = 5  # day of year (0-based) of the first chick placement


def broiler_state(cycle: BroilerCycle, year_hours: int = HOURS) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Per hour: (heating on, set point °C, animal gain K, electricity multiplier).

    In a batch the set point falls 30 → 20 °C by day 27 and bird heat rises; between
    batches the house is held at FROST_T, and pre-heated to 32 °C before placement.
    """
    period = cycle.batch_days + cycle.empty_days
    day = np.arange(year_hours) / 24.0
    rel = (day - cycle.first_placement_doy) % period  # days since placement
    in_batch = rel < cycle.batch_days
    preheat = (~in_batch) & (rel >= period - cycle.preheat_days)
    frac = np.clip(rel / cycle.batch_days, 0, 1)
    # Set point: 30 °C at placement falling linearly to 20 °C at 27 days, then 20 °C
    # (linear approximation of Aviagen Ross Broiler Management Handbook 2025, Table 2.4,
    # whole-house brooding). Between batches the house is kept frost-free; pre-heating
    # brings it to 30 °C before placement.
    t_set = np.where(in_batch, BROILER_T0 - (BROILER_T0 - BROILER_T27) * np.clip(rel / 27.0, 0, 1),
                     np.where(preheat, BROILER_T0, FROST_T))
    gain = np.where(in_batch, 15.0 * frac ** 1.3, 0.0)
    on = np.ones(year_hours, dtype=bool)
    el_mult = np.where(in_batch, 1.0, np.where(preheat, 0.4, 0.15))
    return on, t_set, gain, el_mult


def building_series(b: dict, t_out: np.ndarray, year: int) -> dict[str, np.ndarray]:
    """Weather and base parts of heat and electricity for one building (kWh/h)."""
    ut = USE_TYPES.get(b.get("use", "muu"), USE_TYPES["muu"])
    p = {**ut, **{k: v for k, v in (b.get("params") or {}).items() if v is not None}}
    area = float(b.get("heated_m2") or 0.0)
    cal = calendar_columns(year)
    prof = daily_profile(p["profile"], cal["hour"], cal["weekday"])
    if p.get("cycle") == "broiler":
        c = BroilerCycle(**(b.get("cycle") or {}))
        on, t_set, gain, el_mult = broiler_state(c)
    else:
        on = np.ones(HOURS, dtype=bool)
        t_set = np.full(HOURS, p["t_set"])
        gain = np.full(HOURS, p["gain"])
        el_mult = np.ones(HOURS)
    season = p.get("season")
    if season:  # process load only in its season (day of year, 0-based, end exclusive)
        doy = np.arange(HOURS) // 24
        in_season = (doy >= season[0]) & (doy < season[1])
        on = on & in_season
        el_mult = el_mult * in_season
    dT = np.maximum(0.0, t_set - gain - t_out)
    heat_w = np.where(on, area * p["H"] * dT, 0.0) / 1000.0
    heat_b = np.where(on, area * p["q_base"], 0.0) / 1000.0 * np.ones(HOURS)
    el_b = area * p["e_base"] * prof * el_mult / 1000.0
    el_w = area * p["e_vent"] * np.maximum(0.0, t_out - 12.0) * prof * el_mult / 1000.0
    return {"heat_w": heat_w, "heat_b": heat_b, "el_w": el_w, "el_b": el_b}


# --------------------------------------------------------------------------- calibration

def _cv_rmse(y: np.ndarray, yhat: np.ndarray, p: int) -> float | None:
    n = len(y)
    if n <= p or y.mean() <= 0:
        return None
    return float(np.sqrt(((y - yhat) ** 2).sum() / (n - p)) / y.mean())


def _nnls2(W: np.ndarray, B: np.ndarray, y: np.ndarray) -> tuple[float, float]:
    """Least squares y ≈ a·W + b·B with a, b ≥ 0 (two-variable active set)."""
    X = np.column_stack([W, B])
    sol, *_ = np.linalg.lstsq(X, y, rcond=None)
    a, b = sol
    if a >= 0 and b >= 0:
        return float(a), float(b)
    cands = []
    if (W ** 2).sum() > 0:
        aa = max(0.0, float((W @ y) / (W @ W)))
        cands.append((aa, 0.0, ((y - aa * W) ** 2).sum()))
    if (B ** 2).sum() > 0:
        bb = max(0.0, float((B @ y) / (B @ B)))
        cands.append((0.0, bb, ((y - bb * B) ** 2).sum()))
    if not cands:
        return 0.0, 0.0
    a, b, _ = min(cands, key=lambda c: c[2])
    return a, b


def calibrate(W: np.ndarray, B: np.ndarray, data: dict | None, year: int) -> tuple[np.ndarray, dict]:
    """Return (hourly kWh series, calibration report) for one meter or heat circuit."""
    model = W + B
    total_model = float(model.sum())
    kind = (data or {}).get("kind", "none")
    rep: dict = {"kind": kind, "model_total_kwh": round(total_model, 0)}

    if kind == "annual":
        target = float(data.get("kwh") or 0)
        if target <= 0 or total_model <= 0:
            rep["warning"] = "Vuosikulutus tai mallin tulos on nolla; mallin oletus käytössä."
            return model, rep
        share = data.get("base_share")
        if share is not None and share != "":
            share = min(1.0, max(0.0, float(share)))
            Wt, Bt = float(W.sum()), float(B.sum())
            tb, tw = share * target, (1.0 - share) * target
            Bs = B * (tb / Bt) if Bt > 0 else np.full(HOURS, tb / HOURS)
            if Wt > 0:
                Ws = W * (tw / Wt)
            else:
                Ws = np.zeros(HOURS)
                Bs = Bs * (target / tb) if tb > 0 else np.full(HOURS, target / HOURS)
                rep["warning"] = "Mallin sääosa on nolla; koko vuosisumma jaettiin tasaisesti."
            rep.update({"base_share": round(share, 3), "target_kwh": round(target, 0),
                        "note": f"Vuosisumma kalibroitu; säästä riippumaton osuus {share * 100:.0f} % käyttäjältä."})
            return Ws + Bs, rep
        k = target / total_model
        rep.update({"scale": round(k, 3), "target_kwh": round(target, 0),
                    "note": "Vuosisumma kalibroitu; tuntiprofiilin muoto tulee mallista."})
        return model * k, rep

    if kind == "monthly":
        months = data.get("kwh_months") or []
        y = np.array([np.nan if v in (None, "") else float(v) for v in months] + [np.nan] * (12 - len(months)))[:12]
        ok = ~np.isnan(y)
        Wm, Bm = monthly_sum(W, year), monthly_sum(B, year)
        if ok.sum() < 3:
            rep["warning"] = "Kuukausiarvoja on alle kolme; mallin oletus käytössä."
            return model, rep
        a, b = _nnls2(Wm[ok], Bm[ok], y[ok])
        fit = a * Wm + b * Bm
        rep.update({"a": round(a, 3), "b": round(b, 3), "months_used": int(ok.sum()),
                    "cv_rmse": _round(_cv_rmse(y[ok], fit[ok], 2)), "limit": 0.15,
                    "target_kwh": round(float(np.nansum(y)), 0),
                    "measured_months": [None if np.isnan(v) else round(float(v), 0) for v in y],
                    "fitted_months": [round(float(v), 0) for v in fit]})
        if ok.sum() < 12:
            rep["note"] = f"{12 - int(ok.sum())} kuukautta täydennetty sovitteella."
        return a * W + b * B, rep

    if kind == "hourly":
        vals = np.array([np.nan if v is None else float(v) for v in data.get("values") or []], dtype=float)
        if len(vals) != HOURS:
            rep["warning"] = "Tuntisarjan pituus ei ole 8 760; mallin oletus käytössä."
            return model, rep
        ok = ~np.isnan(vals)
        if ok.sum() < 24 * 14:
            rep["warning"] = "Mitattuja tunteja on alle kaksi viikkoa; mallin oletus käytössä."
            return model, rep
        a, b = _nnls2(W[ok], B[ok], vals[ok])
        fit = a * W + b * B
        out = np.where(ok, vals, fit)
        rep.update({"a": round(a, 3), "b": round(b, 3), "hours_measured": int(ok.sum()),
                    "hours_filled": int((~ok).sum()), "cv_rmse": _round(_cv_rmse(vals[ok], fit[ok], 2)),
                    "limit": 0.30, "target_kwh": round(float(out.sum()), 0),
                    "note": "Mitatut tunnit käytetään sellaisenaan"
                            + ("; puuttuvat tunnit täydennetty sovitteella." if (~ok).any() else ".")})
        return out, rep

    rep["note"] = "Ei kulutustietoa: tulos on mallin oletus, ei tilan kulutus."
    return model, rep


def _round(v: float | None) -> float | None:
    return None if v is None else round(v, 3)


# --------------------------------------------------------------------------- whole farm

def _mwh(kwh: float) -> str:
    return f"{kwh / 1000:.1f}".replace(".", ",")


def _subtract_known(data: dict | None, K: np.ndarray, year: int) -> tuple[dict | None, str | None]:
    """Remove the known buildings' share from a group's measured data."""
    if not data or K.sum() <= 0:
        return data, None
    kind = data.get("kind", "none")
    d = dict(data)
    if kind == "annual":
        rest = float(data.get("kwh") or 0) - float(K.sum())
        d["kwh"] = rest
        if rest <= 0:
            return d, (f"Tunnettujen rakennusten kulutus ({_mwh(K.sum())} MWh) on vähintään piirin "
                       f"kulutus ({_mwh(float(data.get('kwh') or 0))} MWh); muille ei jää lämpöä.")
        return d, None
    if kind == "monthly":
        km = monthly_sum(K, year)
        months = list(data.get("kwh_months") or []) + [None] * 12
        out, neg = [], 0
        for i in range(12):
            v = months[i]
            if v in (None, ""):
                out.append(None)
                continue
            r = float(v) - float(km[i])
            if r < 0:
                neg += 1
                r = 0.0
            out.append(r)
        d["kwh_months"] = out
        return d, (f"{neg} kuukautena tunnettujen rakennusten osuus ylitti mitatun; erotus rajattiin nollaan." if neg else None)
    if kind == "hourly":
        vals = data.get("values") or []
        out, neg = [], 0
        for i, v in enumerate(vals):
            if v is None:
                out.append(None)
                continue
            r = float(v) - float(K[i]) if i < HOURS else float(v)
            if r < 0:
                neg += 1
                r = 0.0
            out.append(r)
        d["values"] = out
        return d, (f"{neg} tuntina tunnettujen rakennusten osuus ylitti mitatun; erotus rajattiin nollaan." if neg else None)
    return d, None


def _scaled(m: np.ndarray, total: float) -> np.ndarray:
    s = float(m.sum())
    return m * (total / s) if s > 0 else np.full(HOURS, total / HOURS)


def _group(members: list[dict], parts: dict, pw: str, pb: str, known_key: str, data: dict | None, year: int):
    """Series for one heat circuit or meter, its per-building split and a report."""
    per = {b["id"]: np.zeros(HOURS) for b in members}
    known = [b for b in members if float(b.get(known_key) or 0) > 0]
    rest = [b for b in members if b not in known]
    K = np.zeros(HOURS)
    for b in known:
        sb = _scaled(parts[b["id"]][pw] + parts[b["id"]][pb], float(b[known_key]))
        per[b["id"]] = sb
        K += sb
    notes = []
    if rest:
        W = sum(parts[b["id"]][pw] for b in rest)
        B = sum(parts[b["id"]][pb] for b in rest)
        d, warn = _subtract_known(data, K, year)
        if d and d.get("kind") == "annual" and float(d.get("kwh") or 0) <= 0:
            R = np.zeros(HOURS)
            rep = {"kind": "annual", "model_total_kwh": round(float((W + B).sum()), 0)}
        else:
            R, rep = calibrate(W, B, d, year)
            R = np.maximum(R, 0.0)
        if warn:
            rep["warning"] = warn
        model = W + B
        for b in rest:
            share = np.divide(parts[b["id"]][pw] + parts[b["id"]][pb], model,
                              out=np.full(HOURS, 1.0 / len(rest)), where=model > 0)
            per[b["id"]] = R * share
    else:
        R = np.zeros(HOURS)
        rep = {"kind": (data or {}).get("kind", "none"), "note": "Kaikille rakennuksille on annettu tunnettu kulutus."}
        if data and data.get("kind") == "annual" and data.get("kwh"):
            diff = float(K.sum()) - float(data["kwh"])
            if abs(diff) > 0.01 * float(data["kwh"]):
                rep["warning"] = f"Rakennusten tunnettu kulutus poikkeaa piirin vuosisummasta {'+' if diff >= 0 else '−'}{_mwh(abs(diff))} MWh."
    series = K + R
    if known:
        notes.append(f"Tunnettu kulutus {_mwh(K.sum())} MWh: " + ", ".join(b.get("name", b["id"]) for b in known) + ".")
        if rep.get("note"):
            notes.append(rep["note"])
        rep["note"] = " ".join(notes)
        rep["known_kwh"] = round(float(K.sum()), 0)
    return series, per, rep


def run(project: dict) -> dict:
    """Compute 8 760 h series for the project's selected buildings.

    project = {year, temperature: [8760], buildings: [{id, name, use, heated_m2,
    heated, scope?, circuit, meter, known_heat_kwh?, known_el_kwh?, params?, cycle?}],
    circuits: [{id, name, data}], meters: [{id, name, data}]}

    scope: "both" (default), "heat" or "el" - an unheated machine hall or dryer can
    be included in the electricity only. data.capacity_kw (heat circuits) checks
    the modelled peak against the boiler.
    """
    year = int(project["year"])
    t = np.array([np.nan if v is None else float(v) for v in project["temperature"]], dtype=float)
    if len(t) != HOURS:
        raise ValueError("Ulkolämpötilasarjassa pitää olla 8 760 tuntiarvoa.")
    if np.isnan(t).any():
        raise ValueError(f"Ulkolämpötilasarjasta puuttuu {int(np.isnan(t).sum())} tuntia. "
                         "Valitse päättynyt vuosi, toinen sääasema tai Open-Meteo.")
    blds = [b for b in project.get("buildings", []) if b.get("heated")]
    if not blds:
        raise ValueError("Valitse vähintään yksi rakennus.")

    parts = {b["id"]: building_series(b, t, year) for b in blds}
    heat_total = np.zeros(HOURS)
    el_total = np.zeros(HOURS)
    per_building = {b["id"]: {"heat": np.zeros(HOURS), "el": np.zeros(HOURS)} for b in blds}
    reports = {"circuits": [], "meters": []}

    for grp_key, part_w, part_b, out_key, tot, gid, scope_ok, known_key in (
        ("circuits", "heat_w", "heat_b", "heat", heat_total, "circuit", ("both", "heat"), "known_heat_kwh"),
        ("meters", "el_w", "el_b", "el", el_total, "meter", ("both", "el"), "known_el_kwh"),
    ):
        for g in project.get(grp_key) or []:
            members = [b for b in blds if b.get(gid) == g["id"] and b.get("scope", "both") in scope_ok]
            if not members:
                continue
            series, per, rep = _group(members, parts, part_w, part_b, known_key, g.get("data"), year)
            tot += series
            for bid, sb in per.items():
                per_building[bid][out_key] += sb
            rep.update({"id": g["id"], "name": g.get("name", g["id"]), "members": [b["id"] for b in members],
                        "annual_kwh": round(float(series.sum()), 0), "peak_kw": round(float(series.max()), 1)})
            cap = (g.get("data") or {}).get("capacity_kw")
            if cap not in (None, "") and float(cap) > 0:
                over = int((series > float(cap)).sum())
                rep["capacity_kw"] = float(cap)
                rep["hours_over_capacity"] = over
                if over:
                    msg = (f"Huipputeho {series.max():.0f} kW ylittää kattilan tehon {float(cap):.0f} kW "
                           f"{over} tuntina. Tarkista profiili (esim. broilerierien ajoitus) tai kattilan teho.")
                    rep["warning"] = (rep["warning"] + " " + msg) if rep.get("warning") else msg
            reports[grp_key].append(rep)

    cal = calendar_columns(year)
    return {
        "year": year,
        "electricity": [round(float(v), 3) for v in el_total],
        "heat": [round(float(v), 3) for v in heat_total],
        "temperature": [round(float(v), 2) for v in t],
        "monthly": {
            "electricity": [round(float(v), 0) for v in monthly_sum(el_total, year)],
            "heat": [round(float(v), 0) for v in monthly_sum(heat_total, year)],
            "temperature": [round(float(t[cal["month"] == m].mean()), 1) for m in range(1, 13)],
        },
        "totals": {
            "electricity_kwh": round(float(el_total.sum()), 0),
            "heat_kwh": round(float(heat_total.sum()), 0),
            "electricity_peak_kw": round(float(el_total.max()), 1),
            "heat_peak_kw": round(float(heat_total.max()), 1),
        },
        "buildings": [
            {"id": bid, "electricity_kwh": round(float(v["el"].sum()), 0),
             "heat_kwh": round(float(v["heat"].sum()), 0), "heat_peak_kw": round(float(v["heat"].max()), 1)}
            for bid, v in per_building.items()
        ],
        "calibration": reports,
    }
