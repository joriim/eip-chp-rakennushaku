"""Mock upstream responses shaped like the real MML, FMI and Open-Meteo APIs."""

from __future__ import annotations

import json
import math
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlparse

LAT0, LON0 = 62.79, 22.84  # Seinäjoki area


def rect(lon, lat, w_m, h_m):
    kx = 111_320.0 * math.cos(math.radians(lat))
    dx, dy = w_m / 2 / kx, h_m / 2 / 110_574.0
    return {"type": "Polygon", "coordinates": [[[lon - dx, lat - dy], [lon + dx, lat - dy], [lon + dx, lat + dy],
                                                 [lon - dx, lat + dy], [lon - dx, lat - dy]]]}


PROPERTY = {
    "type": "FeatureCollection",
    "features": [{
        "type": "Feature",
        "geometry": rect(LON0, LAT0, 600, 500),
        "properties": {"kiinteistotunnus": "99940100030025", "kiinteistotunnuksenEsitysmuoto": "999-401-3-25",
                       "kiinteistotunnuksenSijainti": {"type": "Point", "coordinates": [LON0, LAT0]}},
    }],
}

BUILDINGS = {
    "type": "FeatureCollection",
    "features": [
        {"type": "Feature", "geometry": rect(LON0 - 0.0015, LAT0, 90, 18),
         "properties": {"mtk_id": 1001, "kohdeluokka": 42261, "kerrosluku": 1, "alkupvm": "2019-05-01", "kayttotarkoitus": 6,
                        "kohderyhma": 64, "sijaintitarkkuus": 3000, "pohjankorkeus": None, "sijainti_piste": None}},
        {"type": "Feature", "geometry": rect(LON0 + 0.0010, LAT0 + 0.0003, 85, 18),
         "properties": {"mtk_id": 1002, "kohdeluokka": 42261, "kerrosluku": None, "alkupvm": "2015-03-01"}},
        {"type": "Feature", "geometry": rect(LON0 + 0.0002, LAT0 - 0.0012, 14, 10),
         "properties": {"mtk_id": 1003, "kohdeluokka": 42211, "kerrosluku": 2, "alkupvm": "2001-01-01"}},
        {"type": "Feature", "geometry": rect(LON0 - 0.0005, LAT0 - 0.0008, 30, 15),
         "properties": {"mtk_id": 1004, "kohdeluokka": 42261, "alkupvm": "2010-01-01"}},
        {"type": "Feature", "geometry": {"type": "Point", "coordinates": [LON0 + 0.0007, LAT0 - 0.0009]},
         "properties": {"mtk_id": 1005, "kohdeluokka": 42270, "alkupvm": "1990-01-01"}},
        # neighbour, outside the property
        {"type": "Feature", "geometry": rect(LON0 + 0.0062, LAT0, 12, 10),
         "properties": {"mtk_id": 2001, "kohdeluokka": 42211, "kerrosluku": 1, "alkupvm": "1980-01-01"}},
    ],
    "numberReturned": 6,
    "links": [{"rel": "self", "href": "x"}, {"rel": "alternate", "href": "y"}],
}

FMI_STATIONS = """<?xml version="1.0" encoding="UTF-8"?>
<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0" xmlns:ef="http://inspire.ec.europa.eu/schemas/ef/4.0"
 xmlns:gml="http://www.opengis.net/gml/3.2">
 <wfs:member><ef:EnvironmentalMonitoringFacility gml:id="s1">
  <gml:identifier codeSpace="http://xml.fmi.fi/namespace/stationcode/fmisid">101486</gml:identifier>
  <gml:name codeSpace="http://xml.fmi.fi/namespace/locationcode/name">Seinäjoki Pelmaa</gml:name>
  <gml:name codeSpace="http://xml.fmi.fi/namespace/locationcode/geoid">-16000080</gml:name>
  <ef:operationalActivityPeriod><ef:OperationalActivityPeriod><ef:activityTime><gml:TimePeriod>
   <gml:beginPosition>2006-11-15T00:00:00Z</gml:beginPosition><gml:endPosition indeterminatePosition="now"/>
  </gml:TimePeriod></ef:activityTime></ef:OperationalActivityPeriod></ef:operationalActivityPeriod>
  <ef:representativePoint><gml:Point gml:id="p1"><gml:pos>62.69 22.84</gml:pos></gml:Point></ef:representativePoint>
 </ef:EnvironmentalMonitoringFacility></wfs:member>
 <wfs:member><ef:EnvironmentalMonitoringFacility gml:id="s2">
  <gml:identifier codeSpace="http://xml.fmi.fi/namespace/stationcode/fmisid">101503</gml:identifier>
  <gml:name codeSpace="http://xml.fmi.fi/namespace/locationcode/name">Kauhava lentokenttä</gml:name>
  <ef:operationalActivityPeriod><ef:OperationalActivityPeriod><ef:activityTime><gml:TimePeriod>
   <gml:beginPosition>1952-01-01T00:00:00Z</gml:beginPosition><gml:endPosition indeterminatePosition="now"/>
  </gml:TimePeriod></ef:activityTime></ef:OperationalActivityPeriod></ef:operationalActivityPeriod>
  <ef:representativePoint><gml:Point gml:id="p2"><gml:pos>63.12 23.04</gml:pos></gml:Point></ef:representativePoint>
 </ef:EnvironmentalMonitoringFacility></wfs:member>
 <wfs:member><ef:EnvironmentalMonitoringFacility gml:id="s3">
  <gml:identifier codeSpace="http://xml.fmi.fi/namespace/stationcode/fmisid">999999</gml:identifier>
  <gml:name codeSpace="http://xml.fmi.fi/namespace/locationcode/name">Suljettu asema</gml:name>
  <ef:operationalActivityPeriod><ef:OperationalActivityPeriod><ef:activityTime><gml:TimePeriod>
   <gml:beginPosition>1960-01-01T00:00:00Z</gml:beginPosition><gml:endPosition>2010-12-31T00:00:00Z</gml:endPosition>
  </gml:TimePeriod></ef:activityTime></ef:OperationalActivityPeriod></ef:operationalActivityPeriod>
  <ef:representativePoint><gml:Point gml:id="p3"><gml:pos>62.80 22.85</gml:pos></gml:Point></ef:representativePoint>
 </ef:EnvironmentalMonitoringFacility></wfs:member>
</wfs:FeatureCollection>"""


def synthetic_temp(t_utc: datetime) -> float:
    """Plausible Seinäjoki-like temperature: annual + daily cycle."""
    doy = t_utc.timetuple().tm_yday + t_utc.hour / 24
    return 3.5 - 14.0 * math.cos(2 * math.pi * (doy - 20) / 365) + 3.0 * math.sin(2 * math.pi * (t_utc.hour - 9) / 24)


def fmi_simple(start: str, end: str, drop_every: int = 0) -> str:
    t0 = datetime.fromisoformat(start.replace("Z", "+00:00"))
    t1 = datetime.fromisoformat(end.replace("Z", "+00:00"))
    els = []
    t = t0
    k = 0
    while t <= t1:
        v = "NaN" if drop_every and k % drop_every == 0 else f"{synthetic_temp(t - timedelta(minutes=30)):.1f}"
        els.append(
            "<wfs:member><BsWfs:BsWfsElement><BsWfs:Location><gml:Point><gml:pos>62.69 22.84</gml:pos></gml:Point>"
            f"</BsWfs:Location><BsWfs:Time>{t.strftime('%Y-%m-%dT%H:%M:%SZ')}</BsWfs:Time>"
            "<BsWfs:ParameterName>TA_PT1H_AVG</BsWfs:ParameterName>"
            f"<BsWfs:ParameterValue>{v}</BsWfs:ParameterValue></BsWfs:BsWfsElement></wfs:member>"
        )
        t += timedelta(hours=1)
        k += 1
    return ('<?xml version="1.0"?><wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0" '
            'xmlns:BsWfs="http://xml.fmi.fi/schema/wfs/2.0" xmlns:gml="http://www.opengis.net/gml/3.2">'
            + "".join(els) + "</wfs:FeatureCollection>")


def open_meteo(start_date: str, end_date: str) -> str:
    t = datetime.fromisoformat(start_date).replace(tzinfo=timezone.utc)
    t1 = datetime.fromisoformat(end_date).replace(tzinfo=timezone.utc) + timedelta(hours=23)
    times, temps = [], []
    while t <= t1:
        times.append(t.strftime("%Y-%m-%dT%H:%M"))
        temps.append(round(synthetic_temp(t), 1))
        t += timedelta(hours=1)
    return json.dumps({"hourly": {"time": times, "temperature_2m": temps}})


def synthetic_price(t_utc: datetime) -> float:
    return round(45 + 30 * math.sin(2 * math.pi * (t_utc.hour - 6) / 24) - 0.5 * t_utc.day, 2)


def sahkotin_csv(start: str, end: str) -> str:
    t = datetime.fromisoformat(start.replace("Z", "+00:00"))
    t1 = datetime.fromisoformat(end.replace("Z", "+00:00"))
    rows = ["hour,price"]
    while t <= t1:
        rows.append(f"{t.strftime('%Y-%m-%dT%H:%M:%S.000Z')},{synthetic_price(t)}")
        t += timedelta(hours=1)
    return "\r\n".join(rows)


class FakeResponse:
    def __init__(self, text: str | bytes, status: int = 200, ctype: str = "application/json"):
        self.content = text if isinstance(text, bytes) else text.encode()
        self.text = text if isinstance(text, str) else ""
        self.status_code = status
        self.headers = {"Content-Type": ctype, "Content-Length": str(len(self.content))}

    def iter_content(self, size=65536):
        for i in range(0, len(self.content), size):
            yield self.content[i:i + size]

    def json(self):
        return json.loads(self.text)

    def raise_for_status(self):
        if self.status_code >= 400:
            import requests

            err = requests.HTTPError(f"{self.status_code}")
            err.response = self
            raise err


class FakeSession:
    """Routes requests.Session.get calls to the fixtures above."""

    def __init__(self, fmi_drop_every: int = 0):
        self.calls: list[tuple[str, dict]] = []
        self.posts: list[tuple[str, dict, dict]] = []
        self.headers: dict = {}
        self.fmi_drop_every = fmi_drop_every
        self.lidar_polls = 0

    def post(self, url, params=None, json=None, timeout=None):
        params = dict(params or {})
        self.posts.append((url, params, json))
        if params.get("api-key") == "bad":
            return FakeResponse("forbidden", 403)
        if url.endswith("/processes/laserkeilausaineisto_05_karttalehti/execution"):
            return FakeResponse(json_dumps({"jobID": "job-1", "status": "accepted"}), 201)
        return FakeResponse("not found", 404)

    def get(self, url, params=None, timeout=None, stream=False):
        params = dict(params or {})
        if "?" in url:
            params.update({k: v[0] for k, v in parse_qs(urlparse(url).query).items()})
        self.calls.append((url, params))
        if params.get("api-key") == "bad":
            return FakeResponse("forbidden", 403)
        if "/tiedostopalvelu/" in url:
            return self._lidar(url)
        if "PalstanSijaintitiedot" in url:
            if "kiinteistotunnus" in params and params["kiinteistotunnus"] != "99940100030025":
                return FakeResponse(json.dumps({"type": "FeatureCollection", "features": []}))
            return FakeResponse(json.dumps(PROPERTY))
        if "rakennus" in url:
            return FakeResponse(json.dumps(BUILDINGS))
        if "wfs" in url:
            q = params.get("storedquery_id")
            if q == "fmi::ef::stations":
                return FakeResponse(FMI_STATIONS, ctype="text/xml")
            return FakeResponse(fmi_simple(params["starttime"], params["endtime"], self.fmi_drop_every), ctype="text/xml")
        if "sahkotin" in url:
            return FakeResponse(sahkotin_csv(params["start"], params["end"]), ctype="text/csv")
        if "archive" in url:
            return FakeResponse(open_meteo(params["start_date"], params["end_date"]))
        return FakeResponse("not found", 404)


# --------------------------------------------------------------------------- NLS file service (laser scanning)
from json import dumps as json_dumps  # noqa: E402

LIDAR_FIXTURE = Path(__file__).parent / "data" / "lidar_fixture.laz"
LIDAR_DESC = {"id": "laserkeilausaineisto_05_karttalehti", "inputs": {
    "mapSheetInput": {"schema": {"type": "array", "items": {"type": "string"}}},
    "fileFormatInput": {"schema": {"type": "string", "enum": ["LAZ"]}},
    "dataSetInput": {"minOccurs": 1, "schema": {"type": "string", "enum": ["laserkeilausaineisto_05_2022", "laserkeilausaineisto_05_2023"]}}}}


def _lidar(self, url):
    base = "https://avoin-paikkatieto.maanmittauslaitos.fi/tiedostopalvelu"
    if url.endswith("/processes/laserkeilausaineisto_05_karttalehti"):
        return FakeResponse(json_dumps(LIDAR_DESC))
    if url.endswith("/jobs/job-1"):
        self.lidar_polls += 1
        if self.lidar_polls == 1:
            return FakeResponse(json_dumps({"jobID": "job-1", "status": "running", "progress": 40}))
        return FakeResponse(json_dumps({"jobID": "job-1", "status": "successful", "progress": 100}))
    if url.endswith("/jobs/job-1/results"):
        return FakeResponse(json_dumps({"results": [
            {"path": f"{base}/dl/v1/job-1/L4133B3.laz", "format": "LAZ", "mapSheetNumber": "L4133B3", "length": LIDAR_FIXTURE.stat().st_size},
            {"path": f"{base}/dl/v1/job-1/L4133B3_metadata.xml", "format": "XML"}],
            "zipPath": f"{base}/dl/v1/uncompressed/job-1"}))
    if url.endswith("/dl/v1/job-1/L4133B3.laz"):
        return FakeResponse(LIDAR_FIXTURE.read_bytes(), ctype="application/octet-stream")
    return FakeResponse("not found", 404)


FakeSession._lidar = _lidar
