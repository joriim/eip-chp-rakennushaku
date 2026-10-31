"""Check that the browser engine (web/engine.js) gives the same results as the Python model.

Runs the same projects through both and compares hourly series and calibration
reports. Needs Node.js.   python web/check_equivalence.py
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / "src"), str(ROOT / "tests")]

from fixtures import synthetic_temp  # noqa: E402
from rakennushaku import app as appmod, model  # noqa: E402
from rakennushaku.timebase import HOURS, hour_starts_utc  # noqa: E402

T = [synthetic_temp(x) for x in hour_starts_utc(2025)]


def base(heat=None, el=None, **bmods):
    p = {
        "year": 2025, "temperature": T,
        "buildings": [
            {"id": "a", "name": "Halli 1", "use": "broileri", "heated_m2": 1829, "heated": True, "circuit": "c1", "meter": "m1",
             "cycle": {"batch_days": 36, "empty_days": 10, "preheat_days": 2, "first_placement_doy": 12}},
            {"id": "b", "name": "Halli 2", "use": "broileri", "heated_m2": 1690, "heated": True, "circuit": "c1", "meter": "m1",
             "cycle": {"batch_days": 36, "empty_days": 10, "preheat_days": 2, "first_placement_doy": 35}},
            {"id": "c", "name": "Asuin", "use": "asuin", "heated_m2": 173, "heated": True, "circuit": "c1", "meter": "m1"},
            {"id": "d", "name": "Konehalli", "use": "korjaamo", "heated_m2": 483, "heated": True, "scope": "el", "circuit": "c1", "meter": "m1"},
        ],
        "circuits": [{"id": "c1", "name": "Hake", "data": heat or {"kind": "none"}}],
        "meters": [{"id": "m1", "name": "Pää", "data": el or {"kind": "none"}}],
    }
    for bid, mods in bmods.items():
        next(b for b in p["buildings"] if b["id"] == bid).update(mods)
    return p


MONTHS = [62, 50, 45, 30, 15, 9, 7, 8, 14, 30, 42, "", ]
HOURLY = [None if i % 997 == 0 else 12 + (i % 24) * 0.5 for i in range(HOURS)]
CASES = {
    "annual_fuel": base({"kind": "annual", "value": 520, "unit": "i-m3", "efficiency": 0.85}),
    "annual_base_share": base({"kind": "annual", "value": 353.6, "unit": "MWh", "base_share_pct": 20, "capacity_kw": 120}),
    "known_house": base({"kind": "annual", "value": 520, "unit": "i-m3", "efficiency": 0.85}, c={"known_heat_mwh": 22}),
    "known_too_big": base({"kind": "annual", "value": 10, "unit": "MWh"}, c={"known_heat_mwh": 22}),
    "monthly_known": base({"kind": "monthly", "unit": "MWh", "months": MONTHS}, c={"known_heat_mwh": 15}),
    "hourly_el_known": base(None, {"kind": "hourly", "values": HOURLY}, d={"known_el_mwh": 20}),
    "dryer_el_only": base({"kind": "annual", "value": 400, "unit": "MWh"}, {"kind": "annual", "value": 150, "unit": "MWh"},
                          d={"use": "kuivuri", "scope": "both"}),
    "all_known": base({"kind": "annual", "value": 100, "unit": "MWh"}, a={"known_heat_mwh": 40}, b={"known_heat_mwh": 40}, c={"known_heat_mwh": 25}),
}

JS = """
globalThis.localStorage={getItem(){return null},setItem(){}};
require(process.argv[2]);
const cases=JSON.parse(require('fs').readFileSync(process.argv[3],'utf8')); const out={};
for (const [k,p] of Object.entries(cases)) out[k]=RH.run(RH.prepare(p));
process.stdout.write(JSON.stringify(out));
"""


def main() -> int:
    with tempfile.TemporaryDirectory() as td:
        cj = Path(td) / "cases.json"
        cj.write_text(json.dumps(CASES), encoding="utf-8")
        js = Path(td) / "run.js"
        js.write_text(JS, encoding="utf-8")
        out = subprocess.run(["node", str(js), str(ROOT / "web" / "engine.js"), str(cj)], capture_output=True, text=True, check=True)
    jsres = json.loads(out.stdout)
    bad = 0
    for name, proj in CASES.items():
        py = model.run(appmod._prepare(json.loads(json.dumps(proj))))
        j = jsres[name]
        dh = max(abs(a - b) for a, b in zip(py["heat"], j["heat"]))
        de = max(abs(a - b) for a, b in zip(py["electricity"], j["electricity"]))
        reps = []
        for g in ("circuits", "meters"):
            for rp, rj in zip(py["calibration"][g], j["calibration"][g]):
                for key in ("annual_kwh", "peak_kw", "known_kwh", "hours_over_capacity", "cv_rmse", "warning", "note"):
                    if rp.get(key) != rj.get(key):
                        reps.append(f"{g}.{key}: py={rp.get(key)!r} js={rj.get(key)!r}")
        bb = [(x["id"], x["heat_kwh"], x["electricity_kwh"]) for x in py["buildings"]]
        bj = [(x["id"], x["heat_kwh"], x["electricity_kwh"]) for x in j["buildings"]]
        ok = dh < 2e-3 and de < 2e-3 and not reps and bb == bj
        bad += not ok
        print(f"{'OK  ' if ok else 'DIFF'} {name:20s} heat {py['totals']['heat_kwh']:>9.0f} el {py['totals']['electricity_kwh']:>8.0f}"
              f"  max|Δ| {dh:.4f}/{de:.4f}" + ("" if ok else f"\n     {reps} {bb if bb != bj else ''} {bj if bb != bj else ''}"))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
