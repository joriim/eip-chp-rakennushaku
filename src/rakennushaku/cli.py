"""Käynnistys: `rakennushaku` (tai `python -m rakennushaku`)."""

from __future__ import annotations

import argparse
import os
import threading
import webbrowser
from pathlib import Path


def _load_dotenv(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def main() -> None:
    ap = argparse.ArgumentParser(prog="rakennushaku", description="Tilan rakennukset ja energiaprofiili hybridienergialaskuriin")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--env", default=".env", help="tiedosto, josta MML_API_KEY luetaan (oletus .env)")
    ap.add_argument("--no-browser", action="store_true")
    a = ap.parse_args()
    _load_dotenv(Path(a.env))
    if not os.environ.get("MML_API_KEY"):
        print("Huom: MML_API_KEY puuttuu. Kiinteistö- ja rakennushaku eivät toimi ilman sitä;"
              " rakennuksia voi lisätä kartalle käsin.")
    import uvicorn

    url = f"http://{a.host}:{a.port}/"
    if not a.no_browser:
        threading.Timer(1.2, lambda: webbrowser.open(url)).start()
    print(f"Rakennushaku käynnissä: {url}")
    uvicorn.run("rakennushaku.app:app", host=a.host, port=a.port, log_level="warning")


if __name__ == "__main__":
    main()
