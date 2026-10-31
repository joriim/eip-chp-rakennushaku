"""Build docs/MENETELMAT_JA_LAHTEET.md and its HTML versions from docs/menetelmat_src.md.

The parameter table is generated from the model code so the document cannot drift
from it. HTML needs pandoc; the generated files are committed so users do not need it.

    python docs/build_docs.py
"""

from __future__ import annotations

import datetime as dt
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from rakennushaku import __version__  # noqa: E402
from rakennushaku.model import USE_TYPES  # noqa: E402

PROFILES = {"flat": "tasainen", "home": "asuinrakennus", "milking": "lypsy", "workday": "arkipäivä"}


def fi(v: float) -> str:
    return f"{v:g}".replace(".", ",")


def table() -> str:
    rows = ["| Käyttötyyppi | T_aset °C | ΔT_sis K | H W/m²K | q_perus W/m² | e_perus W/m² | e_ilmanv W/m²K | Profiili | Lähde |",
            "|---|---|---|---|---|---|---|---|---|"]
    for k, u in USE_TYPES.items():
        tset = "30 → 20 (erä)" if u.get("cycle") == "broiler" else fi(u["t_set"])
        gain = "0 → 15 (erä)" if u.get("cycle") == "broiler" else fi(u["gain"])
        prof = PROFILES.get(u["profile"], u["profile"]) + (", erärytmi" if u.get("cycle") else "") + (", kausi 1.8.–15.10." if u.get("season") else "")
        src = "T_aset [20], muut oma oletus" if u.get("cycle") == "broiler" else "Oma oletus"
        rows.append(f"| {u['label']} | {tset} | {gain} | {fi(u['H'])} | {fi(u['q_base'])} | {fi(u['e_base'])} | {fi(u['e_vent'])} | {prof} | {src} |")
    return "\n".join(rows)


def main() -> None:
    src = (ROOT / "docs" / "menetelmat_src.md").read_text(encoding="utf-8")
    md = (src.replace("{{VERSION}}", __version__).replace("{{DATE}}", dt.date.today().strftime("%-d.%-m.%Y"))
          .replace("{{USE_TYPES_TABLE}}", table()))
    out = ROOT / "docs" / "MENETELMAT_JA_LAHTEET.md"
    body = md.split("---\n", 2)[2] if md.startswith("---") else md
    out.write_text(body.lstrip(), encoding="utf-8")
    if not shutil.which("pandoc"):
        print("pandoc puuttuu: HTML-versioita ei päivitetty")
        return
    frag = subprocess.run(["pandoc", "-f", "markdown+autolink_bare_uris", "-t", "html5", "--shift-heading-level-by=0"],
                          input=body, capture_output=True, text=True, check=True).stdout
    frag = frag.replace('<a href="http', '<a target="_blank" rel="noopener" href="http')
    (ROOT / "web" / "menetelmat_fragment.html").write_text(frag, encoding="utf-8")
    css = ("<style>body{font:15px/1.55 'Public Sans',system-ui,sans-serif;max-width:860px;margin:2rem auto;padding:0 16px;color:#1d231f;background:#fff}"
           "h1,h2{color:#2e6b3f}table{border-collapse:collapse;font-size:13px;display:block;overflow-x:auto}th,td{border-bottom:1px solid #d9ded8;padding:4px 6px;text-align:left;vertical-align:top}"
           "pre{background:#eef1ec;padding:10px;overflow-x:auto}code{font-family:ui-monospace,Consolas,monospace}"
           "@media (prefers-color-scheme:dark){body{background:#141715;color:#e7ebe7}h1,h2{color:#6fb183}pre{background:#232824}th,td{border-color:#333a35}a{color:#9ccfab}}</style>")
    page = (f"<!doctype html><html lang=\"fi\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
            f"<title>Rakennushaku – menetelmät ja lähteet</title>{css}</head><body>{frag}</body></html>")
    (ROOT / "src" / "rakennushaku" / "static" / "menetelmat.html").write_text(page, encoding="utf-8")
    print(out, "+ HTML")


if __name__ == "__main__":
    main()
