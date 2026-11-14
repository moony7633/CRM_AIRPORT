"""Калибровка geo по реальным OSM node ID из Overpass Turbo выгрузки.

Запуск: python data/calibrate_osm.py
Совместимо с Python 3.9+
"""
from __future__ import annotations

import json
import math
import time
import urllib.request
from pathlib import Path
from typing import Optional, Tuple, List, Dict

AIRPORT = Path(__file__).parent / "airport_sheremetyevo.json"

# Узлы, у которых будем спрашивать OSM координаты. Бери «разбросанные»
# по всей карте — так калибровка точнее.
NODE_IDS = [
    292209366,      # юго-запад карты
    245887859,      # восток (торец 24L)
    4231659011,     # северо-запад (торец 06L)
    1951355181,     # центр (BASE1)
    245887854,      # центр-запад
    7769441756,     # юг
    1947243888,     # восток
    5667200545,     # север
]


def fetch_osm(node_id: int) -> Optional[Tuple[float, float]]:
    """Возвращает (lat, lon) узла или None."""
    url = "https://api.openstreetmap.org/api/0.6/node/%d.json" % node_id
    req = urllib.request.Request(url, headers={"User-Agent": "calibrate-geo/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            d = json.load(r)
        el = (d.get("elements") or [None])[0]
        if el and "lat" in el:
            return el["lat"], el["lon"]
    except Exception as e:
        print("  ! node %d: %s" % (node_id, e))
    return None


def fit_least_squares(pairs: List[Tuple[float, float, float, float]]):
    """pairs: [(px, py, lat, lon), ...] -> (geo_dict, residuals_list).

    Модель:
        локальные пиксели → карта «y вверх» → поворот на rot_deg → масштаб
        → метры → lat/lon через 111320 м на градус.
    """
    # Базовая точка — первая пара. Все смещения считаем относительно неё.
    x0, y0, lat_r, lon_r = pairs[0]
    coslat = math.cos(math.radians(lat_r))

    # Собираем нормальные уравнения для (a = s*cos, b = s*sin):
    #   rx = a*vx - b*vy
    #   ry = b*vx + a*vy
    # где (vx, vy) — пиксельное смещение с инвертированным y,
    # а (rx, ry) — реальное смещение в метрах от базовой точки.
    A = []
    b = []
    for px, py, lat, lon in pairs:
        vx = px - x0
        vy = -(py - y0)
        rx = (lon - lon_r) * 111320.0 * coslat
        ry = (lat - lat_r) * 111320.0
        A.append((vx, -vy)); b.append(rx)
        A.append((vy,  vx)); b.append(ry)

    a11 = sum(r[0] * r[0] for r in A)
    a12 = sum(r[0] * r[1] for r in A)
    a22 = sum(r[1] * r[1] for r in A)
    b1 = sum(A[i][0] * b[i] for i in range(len(A)))
    b2 = sum(A[i][1] * b[i] for i in range(len(A)))

    det = a11 * a22 - a12 * a12
    if abs(det) < 1e-9:
        raise RuntimeError("Точки коллинеарны, добавь ещё")
    a = (b1 * a22 - b2 * a12) / det
    bb = (a11 * b2 - a12 * b1) / det

    scale = math.hypot(a, bb)
    rot = math.degrees(math.atan2(bb, a))

    # Восстанавливаем lat0/lon0 — координату пикселя (0,0):
    # от (x0,y0) к (0,0) в пикселях → в метры через ту же матрицу (a,bb)
    # → прибавляем к координате базовой точки.
    vx0, vy0 = -x0, y0
    mx = a * vx0 - bb * vy0
    my = bb * vx0 + a * vy0
    lat0 = lat_r + my / 111320.0
    lon0 = lon_r + mx / (111320.0 * coslat)

    # Остатки — оценка качества фита (в метрах).
    resid = []
    for px, py, lat, lon in pairs:
        vx, vy = px, -py
        lx = lat0 + (bb * vx + a * vy) / 111320.0
        ly = lon0 + (a * vx - bb * vy) / (111320.0 * coslat)
        dlat = (lx - lat) * 111320.0
        dlon = (ly - lon) * 111320.0 * coslat
        resid.append(math.hypot(dlat, dlon))

    return {
        "lat0": round(lat0, 6),
        "lon0": round(lon0, 6),
        "scale": round(scale, 4),
        "rot_deg": round(rot, 3),
    }, resid


def xy_to_gps(x: float, y: float, g: Dict[str, float]) -> Tuple[float, float]:
    """Ровно та же формула, что пойдёт в engine.py."""
    a = math.radians(g["rot_deg"])
    vx, vy = x, -y
    lat = g["lat0"] + (vx * math.sin(a) + vy * math.cos(a)) * g["scale"] / 111320.0
    lon = g["lon0"] + (vx * math.cos(a) - vy * math.sin(a)) * g["scale"] / (
        111320.0 * math.cos(math.radians(g["lat0"])))
    return round(lat, 6), round(lon, 6)


def main():
    data = json.loads(AIRPORT.read_text(encoding="utf-8"))
    nodes = {n["id"]: (n["x"], n["y"]) for n in data["nodes"]}

    # ── 1. Собираем пары (px, py, lat, lon) через OSM API ─────────────
    pairs = []
    for nid in NODE_IDS:
        osm_key = "N%d" % nid
        if osm_key not in nodes:
            print("x %s нет в JSON — пропускаю" % osm_key)
            continue
        px, py = nodes[osm_key]
        print("-> OSM node %d (пиксель %d,%d)..." % (nid, px, py))
        coord = fetch_osm(nid)
        if coord is None:
            print("  x OSM не отдал координаты")
            continue
        lat, lon = coord
        print("  ok %.6f, %.6f" % (lat, lon))
        pairs.append((px, py, lat, lon))
        time.sleep(1.1)   # вежливо к OSM API

    if len(pairs) < 3:
        print("\n! Получил только %d пар — нужно >=3" % len(pairs))
        raise SystemExit(1)

    # ── 2. Калибровка ────────────────────────────────────────────────
    print("\nКалибрую по %d точкам..." % len(pairs))
    geo, resid = fit_least_squares(pairs)

    print("\ngeo = %s\n" % geo)
    print("Остатки (промах каждой точки, метры):")
    for (px, py, lat, lon), r in zip(pairs, resid):
        print("  (%5d,%5d) -> %.6f,%.6f   ошибка %.1f м"
              % (px, py, lat, lon, r))

    max_err = max(resid)
    print("\nМаксимальная ошибка фита: %.1f м" % max_err)
    if max_err < 50:
        print("ОТЛИЧНО: калибровка точная")
    elif max_err < 200:
        print("ПРИЕМЛЕМО")
    else:
        print("ПЛОХО: есть выбросы; проверь, что все node ID реальные")

    # ── 3. Self-check: прогоняем те же точки через итоговый geo ─────
    print("\nПроверка: пересчёт исходных точек через итоговый geo")
    max_check = 0.0
    for px, py, lat, lon in pairs:
        plat, plon = xy_to_gps(px, py, geo)
        dlat = (plat - lat) * 111320.0
        dlon = (plon - lon) * 111320.0 * math.cos(math.radians(lat))
        err = math.hypot(dlat, dlon)
        max_check = max(max_check, err)
        print("  (%5d,%5d) -> %.6f,%.6f  ожидалось %.6f,%.6f   ошибка %.1f м"
              % (px, py, plat, plon, lat, lon, err))

    print("\nМакс. ошибка self-check: %.1f м" % max_check)
    if max_check < 30:
        print("ГОТОВО: geo валиден, вставляй в airport_sheremetyevo.json")
    elif max_check < 100:
        print("ОК, но можно улучшить, добавив ещё 2–3 узла")
    else:
        print("Плохо — что-то не так с формулой или с node ID; пришли вывод")

    # ── 4. Готовый блок для JSON ────────────────────────────────────
    print("\nВставь в airport_sheremetyevo.json (после \"source\"):")
    print('"geo": ' + json.dumps(geo, ensure_ascii=False) + ",")


if __name__ == "__main__":
    main()
