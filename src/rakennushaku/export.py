"""Output in the calculator's own formats, and conversion of fuel amounts to heat."""

from __future__ import annotations

from rakennushaku.timebase import HOURS, calendar_columns

# Fuel energy content; delivered heat = fuel energy x boiler efficiency.
# Chip density matches the calculator default (Ohjauspaneeli K35, 0,8 MWh/i-m³).
HEAT_UNITS = {
    "kWh": {"label": "kWh lämpöä", "kwh_per_unit": 1.0, "fuel": False},
    "MWh": {"label": "MWh lämpöä", "kwh_per_unit": 1000.0, "fuel": False},
    "i-m3": {"label": "i-m³ haketta", "kwh_per_unit": 800.0, "fuel": True},
    "MWh_pa": {"label": "MWh polttoainetta", "kwh_per_unit": 1000.0, "fuel": True},
    "t_pelletti": {"label": "t pellettiä", "kwh_per_unit": 4700.0, "fuel": True},
    "l_oljy": {"label": "l kevyttä polttoöljyä", "kwh_per_unit": 10.0, "fuel": True},
    # electric heating: electricity used for heating (sub-meter); heat = electricity × COP
    "kWh_el": {"label": "kWh sähköä lämmitykseen", "kwh_per_unit": 1.0, "fuel": False, "el": True},
    "MWh_el": {"label": "MWh sähköä lämmitykseen", "kwh_per_unit": 1000.0, "fuel": False, "el": True},
}
EL_UNITS = {"kWh": 1.0, "MWh": 1000.0}


def heat_to_kwh(value: float, unit: str, efficiency: float = 0.85, chip_mwh_per_m3: float = 0.8, cop: float = 1.0) -> float:
    u = HEAT_UNITS[unit]
    k = u["kwh_per_unit"]
    if unit == "i-m3":
        k = chip_mwh_per_m3 * 1000.0
    if u.get("el"):
        return float(value) * k * cop
    return float(value) * k * (efficiency if u["fuel"] else 1.0)


def _fi(v: float, nd: int = 3) -> str:
    return f"{v:.{nd}f}".replace(".", ",")


def oma_kulutusdata_csv(result: dict, prices: list | None = None) -> str:
    """CSV with the same columns as the calculator's Oma kulutusdata sheet (A–F) plus T.

    ; separated, decimal comma, UTF-8 BOM so Finnish Excel opens it directly.
    """
    year = result["year"]
    cal = calendar_columns(year)
    p = prices if prices is not None and len(prices) == HOURS else None
    head = "Tunti;Kk;Pv;Klo;Sähkö (kWh/h);Lämpö (kWh/h);Ulkolämpötila (°C)"
    if p:
        head += f";Pörssihinta {year} (€/MWh, alv 0)"
    lines = [head]
    for i in range(HOURS):
        row = (f"{i + 1};{cal['month'][i]};{cal['day'][i]};{cal['hour'][i]};"
               f"{_fi(result['electricity'][i])};{_fi(result['heat'][i])};{_fi(result['temperature'][i], 1)}")
        if p:
            row += ";" + ("" if p[i] is None else _fi(p[i], 2))
        lines.append(row)
    return "\ufeff" + "\r\n".join(lines) + "\r\n"


def paste_block(result: dict) -> str:
    """Two tab-separated columns (electricity, heat) for pasting into E2:F8761."""
    return "\r\n".join(f"{_fi(e)}\t{_fi(h)}" for e, h in zip(result["electricity"], result["heat"]))
