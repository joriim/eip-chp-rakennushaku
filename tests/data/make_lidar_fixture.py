"""Synthetic laser scanning fixture for the lidar tests (developer tool; needs laspy, lazrs and pyproj).

Writes lidar_fixture.laz (LAS 1.2, point format 1, about 0.5 points/m² like the NLS 0,5 p data) and
lidar_fixture_buildings.json (NLS-like footprints in lon/lat). Ground slopes 1 %; classes as in the NLS data:
1 unclassified (roofs), 2 ground, 5 high vegetation.

  halli       60 × 20 m, rotated 30°, gable roof: eaves 4.0 m, ridge 7.0 m (pitch 16.7°)
  asuin       12 × 10 m, flat roof at 6.2 m
  purettu     15 × 8 m in the NLS data, but nothing in the point cloud (demolished)
  laajennettu NLS footprint 20 × 12 m, point cloud 30 × 12 m; mono-pitch roof 3.5 → 5.0 m
  a tree (class 5) next to the hall
"""
import datetime
import json
import math
from pathlib import Path

import laspy
import numpy as np
from pyproj import Transformer

HERE = Path(__file__).parent
E0, N0 = 384000.0, 6673000.0          # inside map sheet L4133B3
W, H = 220.0, 160.0
rng = np.random.default_rng(42)


def rect(cx, cy, length, width, angle_deg):
    a = math.radians(angle_deg)
    ca, sa = math.cos(a), math.sin(a)
    pts = [(-length / 2, -width / 2), (length / 2, -width / 2), (length / 2, width / 2), (-length / 2, width / 2)]
    return [(cx + x * ca - y * sa, cy + x * sa + y * ca) for x, y in pts]


def local(poly, angle_deg, cx, cy):
    a = math.radians(angle_deg)
    return lambda x, y: ((x - cx) * math.cos(a) + (y - cy) * math.sin(a), -(x - cx) * math.sin(a) + (y - cy) * math.cos(a))


def inside(x, y, poly):
    c = False
    for i in range(len(poly)):
        (x1, y1), (x2, y2) = poly[i - 1], poly[i]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            c = not c
    return c


ground = lambda x, y: 40.0 + 0.01 * (x - E0)
B = {
    "halli": dict(c=(E0 + 70, N0 + 60), L=60, Wd=20, ang=30),
    "asuin": dict(c=(E0 + 160, N0 + 40), L=12, Wd=10, ang=0),
    "purettu": dict(c=(E0 + 170, N0 + 120), L=15, Wd=8, ang=0),
    "laajennettu": dict(c=(E0 + 60, N0 + 125), L=20, Wd=12, ang=0),
}
real_ext = rect(E0 + 65, N0 + 125, 30, 12, 0)     # the extension: 10 m more to the east


def roof_height(x, y):
    """Roof height above ground at (x, y), or None outside the real buildings."""
    h = B["halli"]
    poly = rect(*h["c"], h["L"], h["Wd"], h["ang"])
    if inside(x, y, poly):
        u, v = local(poly, h["ang"], *h["c"])(x, y)
        return 7.0 - 0.3 * abs(v)
    a = B["asuin"]
    if inside(x, y, rect(*a["c"], a["L"], a["Wd"], a["ang"])):
        return 6.2
    if inside(x, y, real_ext):
        v = y - (N0 + 125)                      # across the width, −6 … 6
        return 3.5 + (v + 6) / 12 * 1.5
    return None


n = int(W * H * 0.5)
xs = E0 + rng.random(n) * W
ys = N0 + rng.random(n) * H
zs, cls = np.empty(n), np.empty(n, dtype=np.uint8)
for i in range(n):
    h = roof_height(xs[i], ys[i])
    if h is None:
        zs[i], cls[i] = ground(xs[i], ys[i]) + rng.normal(0, 0.04), 2
    else:
        zs[i], cls[i] = ground(xs[i], ys[i]) + h + rng.normal(0, 0.05), 1
# a tree next to the hall
tx, ty = E0 + 110, N0 + 85
k = 60
ang, rad = rng.random(k) * 2 * math.pi, rng.random(k) * 3.5
xs = np.concatenate([xs, tx + rad * np.cos(ang)])
ys = np.concatenate([ys, ty + rad * np.sin(ang)])
zs = np.concatenate([zs, ground(tx, ty) + 6 + rng.random(k) * 8])
cls = np.concatenate([cls, np.full(k, 5, dtype=np.uint8)])

hdr = laspy.LasHeader(point_format=1, version="1.2")
hdr.scales = np.array([0.01, 0.01, 0.01])
hdr.offsets = np.array([E0, N0, 0.0])
hdr.date = datetime.date(2023, 6, 1)
las = laspy.LasData(hdr)
las.x, las.y, las.z = xs, ys, zs
las.classification = cls
las.write(HERE / "lidar_fixture.laz")

to_ll = Transformer.from_crs("EPSG:3067", "EPSG:4326", always_xy=True)
features = []
for bid, d in B.items():
    ring = rect(*d["c"], d["L"], d["Wd"], d["ang"])
    ring = [list(to_ll.transform(x, y)) for x, y in ring]
    ring.append(ring[0])
    features.append({"id": bid, "name": bid, "geometry": {"type": "Polygon", "coordinates": [ring]}})
(HERE / "lidar_fixture_buildings.json").write_text(json.dumps(features, indent=1))
print(f"{len(xs)} points, {(HERE / 'lidar_fixture.laz').stat().st_size} bytes")
