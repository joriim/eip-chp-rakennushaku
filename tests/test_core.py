from __future__ import annotations

from datetime import datetime, timedelta, timezone

import numpy as np
import pytest

from rakennushaku import export, mml, model, weather
from rakennushaku.series_parser import parse_series
from rakennushaku.timebase import HOURS, hour_index, hour_starts_utc

from fixtures import FakeSession, LAT0, LON0, PROPERTY


@pytest.fixture(autouse=True)
def _tmp_cache(tmp_path, monkeypatch):
    monkeypatch.setattr(weather, "CACHE_DIR", tmp_path)


# --------------------------------------------------------------------------- time base

def test_hour_index_fixed_eet_and_leap_day():
    utc = timezone.utc
    assert hour_index(datetime(2024, 12, 31, 22, tzinfo=utc), 2025) == 0  # 1.1. 00 EET
    assert hour_index(datetime(2025, 12, 31, 21, tzinfo=utc), 2025) == HOURS - 1
    assert hour_index(datetime(2024, 2, 29, 12, tzinfo=utc), 2024) is None
    # 1.3.2024 00 EET is row 59*24 because 29.2. is removed
    assert hour_index(datetime(2024, 2, 29, 22, tzinfo=utc), 2024) == 59 * 24
    assert len(hour_starts_utc(2024)) == HOURS


# --------------------------------------------------------------------------- parser

def _datahub_15min_local(year: int, kw: float = 8.0) -> str:
    """Naive local-time 15-min rows with Finnish DST (spring gap, autumn repeat)."""
    from zoneinfo import ZoneInfo

    hel = ZoneInfo("Europe/Helsinki")
    t = datetime(year, 1, 1, tzinfo=hel).astimezone(timezone.utc)
    end = datetime(year + 1, 1, 1, tzinfo=hel).astimezone(timezone.utc)
    rows = ["Mittauspisteen tunnus;Alkuaika;Määrä (kWh);Laatu"]
    while t < end:
        loc = t.astimezone(hel).replace(tzinfo=None)
        val = f"{kw / 4:.3f}".replace(".", ",")
        rows.append(f"643007000000000000;{loc:%d.%m.%Y %H:%M};{val};OK")
        t += timedelta(minutes=15)
    return "\n".join(rows)


def test_datahub_quarter_hours_local_time_with_dst():
    p = parse_series(_datahub_15min_local(2025), kind="energy", year=2025)
    assert p.resolution_min == 15
    assert p.value_column.startswith("Määrä")
    assert p.hours_missing == 0, p.notes
    arr = p.array()
    assert np.allclose(arr, 8.0)  # every hour is exactly 4 quarters of 2 kWh
    assert abs(arr.sum() - 8.0 * HOURS) < 1e-6


def test_iso_utc_hourly_with_gap_and_wh_unit():
    t0 = datetime(2024, 12, 31, 22, tzinfo=timezone.utc)
    rows = ["time,energy_wh"]
    for i in range(HOURS):
        if 100 <= i < 103:
            continue
        rows.append(f"{(t0 + timedelta(hours=i)).strftime('%Y-%m-%dT%H:%M:%SZ')},{1500}")
    p = parse_series("\n".join(rows), kind="energy")
    assert p.year == 2025 and p.unit == "Wh"
    assert p.hours_missing == 3
    assert p.values[0] == pytest.approx(1.5)


def test_temperature_end_stamped():
    t0 = datetime(2025, 1, 1, 0, tzinfo=timezone(timedelta(hours=2)))
    rows = ["aika;lämpötila"] + [f"{(t0 + timedelta(hours=i + 1)).isoformat()};{-5.0 + i * 0.001:.3f}".replace(".", ",") for i in range(HOURS)]
    p = parse_series("\n".join(rows), kind="temperature", stamp_at="end")
    assert p.hours_missing == 0
    assert p.values[0] == pytest.approx(-5.0)


# --------------------------------------------------------------------------- MML

def test_normalise_kt():
    assert mml.normalise_kt("999-401-3-25") == "99940100030025"
    assert mml.display_kt("99940100030025") == "999-401-3-25"
    with pytest.raises(ValueError):
        mml.normalise_kt("999-401")


def test_buildings_flagged_on_property():
    s = FakeSession()
    prop = mml.fetch_property("999-401-3-25", "key", s)
    assert prop["display"] == "999-401-3-25" and 25 < prop["area_ha"] < 35
    blds = mml.buildings_for_area(prop["geometry"], "key", session=s)
    by = {b["mtk_id"]: b for b in blds}
    assert by[2001]["on_property"] is False
    assert all(by[i]["on_property"] for i in (1001, 1002, 1003, 1004, 1005))
    assert by[1001]["footprint_m2"] == pytest.approx(90 * 18, rel=0.02)
    assert by[1003]["floors"] == 2 and by[1003]["default_use"] == "asuin"
    assert by[1005]["is_point"] and by[1005]["footprint_m2"] is None
    assert blds[0]["on_property"]  # on-property first, largest first


def test_missing_property():
    with pytest.raises(mml.PropertyNotFound):
        mml.fetch_property("1-1-1-1", "key", FakeSession())


# --------------------------------------------------------------------------- weather

def test_stations_nearest_and_closed_dropped():
    st = weather.nearest_stations(LAT0, LON0, 2025, session=FakeSession())
    ids = [s["fmisid"] for s in st]
    assert ids[0] == 101486 and 999999 not in ids
    assert st[0]["name"] == "Seinäjoki Pelmaa" and st[0]["distance_km"] == pytest.approx(11.1, abs=0.3)


def test_fmi_temperature_full_year_and_gap_fill():
    s = FakeSession(fmi_drop_every=500)
    res = weather.fmi_temperature(101486, 2025, session=s)
    assert res["missing"] == 0 and res["interpolated"] > 0
    assert -30 < res["min"] < -5 and 15 < res["max"] < 30
    # hour 0 (1.1. 00–01 EET) comes from the value stamped 22+1 h UTC on 31.12.
    assert len([c for c in s.calls if "hourly" in c[1].get("storedquery_id", "")]) == 14


def test_open_meteo_hour_means():
    res = weather.open_meteo_temperature(LAT0, LON0, 2025, session=FakeSession())
    assert res["missing"] == 0 and len(res["values"]) == HOURS


# --------------------------------------------------------------------------- model

def _project(data_heat=None, data_el=None):
    from fixtures import synthetic_temp

    t = [synthetic_temp(x) for x in hour_starts_utc(2025)]
    return {
        "year": 2025,
        "temperature": t,
        "buildings": [
            {"id": "1001", "name": "Broilerihalli 1", "use": "broileri", "heated_m2": 1620, "heated": True, "circuit": "c1", "meter": "m1"},
            {"id": "1003", "name": "Asuinrakennus", "use": "asuin", "heated_m2": 280, "heated": True, "circuit": "c1", "meter": "m1"},
            {"id": "1004", "name": "Konehalli", "use": "korjaamo", "heated_m2": 450, "heated": False, "circuit": "c1", "meter": "m1"},
        ],
        "circuits": [{"id": "c1", "name": "Hakekattila", "data": data_heat or {}}],
        "meters": [{"id": "m1", "name": "Päämittari", "data": data_el or {}}],
    }


def test_model_annual_calibration_hits_target():
    res = model.run(_project({"kind": "annual", "kwh": 300_000}, {"kind": "annual", "kwh": 120_000}))
    assert res["totals"]["heat_kwh"] == pytest.approx(300_000, rel=1e-6)
    assert res["totals"]["electricity_kwh"] == pytest.approx(120_000, rel=1e-6)
    assert len(res["heat"]) == HOURS
    # broiler: heat concentrated in winter, but also cyclical in summer
    m = res["monthly"]["heat"]
    assert m[0] > m[6]
    assert sum(b["heat_kwh"] for b in res["buildings"]) == pytest.approx(300_000, rel=1e-4)


def test_model_monthly_regression_recovers_known_split():
    p = _project()
    base = model.run(p)
    # build "measured" months as 1.3×weather part + 0.7×base part of the model
    t = np.array(p["temperature"])
    parts = [model.building_series(b, t, 2025) for b in p["buildings"] if b["heated"]]
    W = sum(x["heat_w"] for x in parts)
    B = sum(x["heat_b"] for x in parts)
    from rakennushaku.timebase import monthly_sum

    months = list(1.3 * monthly_sum(W, 2025) + 0.7 * monthly_sum(B, 2025))
    months[5] = None  # one missing month
    res = model.run(_project({"kind": "monthly", "kwh_months": months}))
    rep = res["calibration"]["circuits"][0]
    assert rep["a"] == pytest.approx(1.3, rel=1e-3)
    assert rep["months_used"] == 11 and rep["cv_rmse"] < 1e-6
    assert base["totals"]["heat_kwh"] > 0


def test_model_hourly_keeps_measured_values():
    p = _project()
    vals = [10.0] * HOURS
    vals[50] = None
    res = model.run(_project(data_el={"kind": "hourly", "values": vals}))
    assert res["electricity"][0] == pytest.approx(10.0)
    assert res["electricity"][50] > 0
    assert res["calibration"]["meters"][0]["hours_filled"] == 1


def test_no_heated_building_is_an_error():
    p = _project()
    for b in p["buildings"]:
        b["heated"] = False
    with pytest.raises(ValueError):
        model.run(p)


# --------------------------------------------------------------------------- export

def test_heat_units():
    assert export.heat_to_kwh(100, "i-m3", 0.85, 0.8) == pytest.approx(68_000)
    assert export.heat_to_kwh(2, "MWh") == pytest.approx(2000)
    assert export.heat_to_kwh(1000, "l_oljy", 0.9) == pytest.approx(9000)


def test_csv_matches_calculator_layout():
    res = model.run(_project({"kind": "annual", "kwh": 300_000}))
    csv = export.oma_kulutusdata_csv(res)
    lines = csv.lstrip("﻿").strip().split("\r\n")
    assert len(lines) == HOURS + 1
    assert lines[0].startswith("Tunti;Kk;Pv;Klo;Sähkö (kWh/h);Lämpö (kWh/h)")
    assert lines[1].startswith("1;1;1;0;") and lines[-1].startswith("8760;12;31;23;")
    paste = export.paste_block(res).split("\r\n")
    assert len(paste) == HOURS and "\t" in paste[0] and "," in paste[0]


# --------------------------------------------------------------------------- prices

def test_prices_full_year_leap_day_removed():
    from rakennushaku import prices

    r = prices.fetch_prices(2024, session=FakeSession())
    assert r["hours"] == HOURS and r["missing"] == 0  # 8 784 h in, 29.2. dropped
    from fixtures import synthetic_price

    assert r["values"][0] == synthetic_price(datetime(2023, 12, 31, 22, tzinfo=timezone.utc))


def test_price_csv_quarter_hours_averaged_and_partial_year():
    from rakennushaku import prices

    text = "hour,price\n2025-01-01T00:00:00.000Z,10\n2025-01-01T00:15:00.000Z,20\n2025-01-01T00:30:00.000Z,30\n2025-01-01T00:45:00.000Z,40\n"
    r = prices.parse_price_csv(text, 2025)
    assert r["values"][2] == 25.0  # 02–03 EET = 00 UTC, mean of four quarters
    assert r["hours"] == 1 and r["missing"] == HOURS - 1


def test_hintahistoria_layout():
    from rakennushaku import prices

    vals = [1.5] * HOURS
    csv = prices.hintahistoria_csv({"2025": vals})
    lines = csv.lstrip("﻿").strip().split("\r\n")
    assert lines[0] == "Tunti;Aika (EET, UTC+2);2023;2024;2025;2026"
    assert lines[1] == "1;01.01. klo 00;;;1,50;"
    assert lines[-1].startswith("8760;31.12. klo 23;")
    paste = prices.paste_prices({"2025": vals}).split("\r\n")
    assert len(paste) == HOURS and paste[0] == "\t\t1,50\t"


def test_csv_with_price_column():
    res = model.run(_project({"kind": "annual", "kwh": 300_000}))
    csv = export.oma_kulutusdata_csv(res, [42.0] * HOURS)
    lines = csv.lstrip("﻿").split("\r\n")
    assert lines[0].endswith(";Pörssihinta 2025 (€/MWh, alv 0)")
    assert lines[1].endswith(";42,00")


# --------------------------------------------------------------------------- options (0.4)

def test_known_building_heat_takes_its_share_rest_to_others():
    p = _project({"kind": "annual", "kwh": 300_000})
    p["buildings"][1]["known_heat_kwh"] = 25_000  # house on its own known amount
    res = model.run(p)
    by = {b["id"]: b for b in res["buildings"]}
    assert by["1003"]["heat_kwh"] == pytest.approx(25_000, rel=1e-6)
    assert by["1001"]["heat_kwh"] == pytest.approx(275_000, rel=1e-6)
    assert res["totals"]["heat_kwh"] == pytest.approx(300_000, rel=1e-6)
    assert res["calibration"]["circuits"][0]["known_kwh"] == 25_000


def test_known_exceeding_circuit_total_warns():
    p = _project({"kind": "annual", "kwh": 20_000})
    p["buildings"][1]["known_heat_kwh"] = 25_000
    res = model.run(p)
    rep = res["calibration"]["circuits"][0]
    assert "vähintään piirin" in rep["warning"] and "25,0 MWh" in rep["warning"]
    assert {b["id"]: b for b in res["buildings"]}["1001"]["heat_kwh"] == 0


def test_base_share_sets_weather_independent_part():
    p = _project({"kind": "annual", "kwh": 300_000, "base_share": 0.3})
    res = model.run(p)
    assert res["totals"]["heat_kwh"] == pytest.approx(300_000, rel=1e-6)
    t = np.array(p["temperature"])
    parts = [model.building_series(b, t, 2025) for b in p["buildings"] if b["heated"]]
    B = sum(x["heat_b"] for x in parts)
    W = sum(x["heat_w"] for x in parts)
    expect = W * (210_000 / W.sum()) + B * (90_000 / B.sum())
    assert np.allclose(res["heat"], np.round(expect, 3), atol=1e-3)
    # summer gets more heat than with a plain scale factor
    plain = model.run(_project({"kind": "annual", "kwh": 300_000}))
    assert res["monthly"]["heat"][6] > plain["monthly"]["heat"][6]


def test_capacity_warning():
    p = _project({"kind": "annual", "kwh": 300_000, "capacity_kw": 50})
    rep = model.run(p)["calibration"]["circuits"][0]
    assert rep["hours_over_capacity"] > 0 and "ylittää kattilan tehon" in rep["warning"]
    ok = model.run(_project({"kind": "annual", "kwh": 300_000, "capacity_kw": 5000}))["calibration"]["circuits"][0]
    assert ok["hours_over_capacity"] == 0 and "warning" not in ok


def test_scope_electricity_only_building():
    p = _project({"kind": "annual", "kwh": 300_000}, {"kind": "annual", "kwh": 120_000})
    p["buildings"][2]["heated"] = True
    p["buildings"][2]["scope"] = "el"  # machine hall: electricity only
    res = model.run(p)
    by = {b["id"]: b for b in res["buildings"]}
    assert by["1004"]["heat_kwh"] == 0 and by["1004"]["electricity_kwh"] > 0
    assert res["calibration"]["circuits"][0]["members"] == ["1001", "1003"]
    assert res["totals"]["electricity_kwh"] == pytest.approx(120_000, rel=1e-6)


def test_empty_broiler_house_kept_frost_free():
    t = np.full(HOURS, -15.0)
    s = model.building_series({"use": "broileri", "heated_m2": 1000,
                               "cycle": {"batch_days": 35, "empty_days": 12, "preheat_days": 2, "first_placement_doy": 0}}, t, 2025)
    empty_hour = int(40 * 24)  # day 40: empty, before pre-heating
    assert s["heat_w"][empty_hour] == pytest.approx(1000 * 2.2 * (8 + 15) / 1000)


def test_monthly_with_known_building():
    p = _project()
    t = np.array(p["temperature"])
    parts = [model.building_series(b, t, 2025) for b in p["buildings"] if b["heated"]]
    from rakennushaku.timebase import monthly_sum

    months = list(monthly_sum(sum(x["heat_w"] + x["heat_b"] for x in parts), 2025))
    p2 = _project({"kind": "monthly", "kwh_months": months})
    p2["buildings"][1]["known_heat_kwh"] = 20_000
    res = model.run(p2)
    assert {b["id"]: b for b in res["buildings"]}["1003"]["heat_kwh"] == pytest.approx(20_000, rel=1e-6)
    assert res["totals"]["heat_kwh"] == pytest.approx(sum(months), rel=0.02)


def test_grain_dryer_runs_only_in_season():
    t = np.full(HOURS, 0.0)
    s = model.building_series({"use": "kuivuri", "heated_m2": 100}, t, 2025)
    jan, sep = 10 * 24, 250 * 24
    assert s["heat_b"][jan] == 0 and s["el_b"][jan] == 0
    assert s["heat_b"][sep] == pytest.approx(6.0) and s["el_b"][sep] == pytest.approx(1.2)


def test_incomplete_weather_message_counts_missing_hours():
    p = _project()
    p["temperature"] = list(p["temperature"])
    for i in range(100):
        p["temperature"][-1 - i] = None
    with pytest.raises(ValueError, match="puuttuu 100 tuntia"):
        model.run(p)


# --------------------------------------------------------------------------- heating systems
def _hs_project(heat: dict, el: dict) -> dict:
    from fixtures import synthetic_temp
    from rakennushaku import app as appmod
    t = [synthetic_temp(x) for x in hour_starts_utc(2025)]
    p = {"year": 2025, "temperature": t,
         "buildings": [
             {"id": "h", "name": "Halli", "use": "lihasika", "heated_m2": 1500, "heated": True, "circuit": "c1", "meter": "m1"},
             {"id": "k", "name": "Koti", "use": "asuin", "heated_m2": 180, "heated": True, "circuit": "c1", "meter": "m1"}],
         "circuits": [{"id": "c1", "name": "Lämpö", "data": heat}],
         "meters": [{"id": "m1", "name": "Liittymä", "data": el}]}
    return model.run(appmod._prepare(p))


def test_heat_pump_submeter_is_subtracted_from_the_meter():
    r = _hs_project({"kind": "annual", "value": 50, "unit": "MWh_el", "system": "heatpump", "cop": 3.0},
                    {"kind": "annual", "value": 200, "unit": "MWh"})
    assert r["totals"]["heat_kwh"] == pytest.approx(150_000, abs=1)          # 50 MWh × COP 3
    assert r["totals"]["heating_el_kwh"] == pytest.approx(50_000, abs=1)
    assert r["totals"]["electricity_kwh"] == pytest.approx(150_000, abs=1)   # 200 − 50: other electricity only
    assert "vähennetty" in r["calibration"]["meters"][0]["note"]


def test_electric_heating_without_submeter_is_separated_from_meter_data():
    months = [40, 34, 30, 21, 13, 9, 8, 9, 12, 19, 27, 36]
    r = _hs_project({"kind": "none", "system": "electric"}, {"kind": "monthly", "unit": "MWh", "months": months})
    total = sum(months) * 1000
    # the meter's measured electricity = other electricity + heating electricity
    assert r["totals"]["electricity_kwh"] + r["totals"]["heating_el_kwh"] == pytest.approx(total, rel=0.02)
    assert r["totals"]["heat_kwh"] == pytest.approx(r["totals"]["heating_el_kwh"], abs=1)   # direct electric: COP 1
    circ = r["calibration"]["circuits"][0]
    assert circ["kind"] == "from_meter" and "erotettu" in circ["note"]
    # heating electricity is the seasonal part: more in January than in July
    assert r["monthly"]["heat"][0] > 5 * r["monthly"]["heat"][6]


def test_district_heat_uses_heat_units_as_is():
    r = _hs_project({"kind": "annual", "value": 120, "unit": "MWh", "system": "district"}, {"kind": "none"})
    assert r["totals"]["heat_kwh"] == pytest.approx(120_000, abs=1)
    assert r["totals"]["heating_el_kwh"] == 0


def test_nnls_cols_matches_two_variable_solver():
    rng = np.random.default_rng(3)
    W, B = rng.random(50), rng.random(50)
    y = 2.0 * W + 0.5 * B + rng.normal(0, 0.01, 50)
    a, b = model._nnls2(W, B, y)
    c = model._nnls_cols([W, B], y)
    assert c[0] == pytest.approx(a, rel=1e-9) and c[1] == pytest.approx(b, rel=1e-9)
    # a negative unconstrained coefficient is clipped to the best non-negative subset
    y2 = 1.5 * W - 0.8 * B
    c2 = model._nnls_cols([W, B], y2)
    assert min(c2) >= 0
