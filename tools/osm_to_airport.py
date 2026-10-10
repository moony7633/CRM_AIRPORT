"""Строит карту РЕАЛЬНОГО аэропорта из OpenStreetMap в формате проекта.

Примеры:
    python tools/osm_to_airport.py --icao UUWW --out data/airport_vnukovo.json
    python tools/osm_to_airport.py --icao UUWW --save-raw raw_uuww.json --out data/airport_vnukovo.json
    python tools/osm_to_airport.py --input raw_uuww.json --out data/airport_vnukovo.json   # без интернета

Запуск системы с новой картой:  python run.py --airport data/airport_vnukovo.json
Данные © участники OpenStreetMap (лицензия ODbL) — укажите это в презентации.

Что берётся: aeroway = runway, taxiway, taxilane, apron, terminal, hangar,
parking_position / gate / aircraft_stand. Рулёжные дорожки становятся рёбрами графа
(в узлах пересечения OSM-линии должны делить общий узел — так обычно и есть).
"""
import argparse
import json
import math
import urllib.request
from collections import deque

OVERPASS = "https://overpass-api.de/api/interpreter"
QUERY = """[out:json][timeout:90];
nwr["aeroway"="aerodrome"]["icao"="{icao}"];
map_to_area->.a;
(
  way(area.a)["aeroway"~"^(runway|taxiway|taxilane|apron|terminal|hangar)$"];
  nwr(area.a)["aeroway"~"^(parking_position|gate|aircraft_stand)$"];
);
out body;
>;
out skel qt;"""
STAND_TAGS = ("parking_position", "gate", "aircraft_stand")


def fetch(icao):
    req = urllib.request.Request(OVERPASS, data=("data=" + QUERY.format(icao=icao)).encode(),
                                 headers={"User-Agent": "dispatch-project/1.0"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)


def centroid(pts):
    return (sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts))


def build(raw, name, max_stands):
    nodes = {e["id"]: e for e in raw["elements"] if e["type"] == "node"}
    ways = [e for e in raw["elements"] if e["type"] == "way" and e.get("tags")]
    taxi = [w for w in ways if w["tags"].get("aeroway") in ("taxiway", "taxilane")]
    if not taxi:
        raise SystemExit("В данных нет рулёжных дорожек (aeroway=taxiway/taxilane)")

    ref_pts = [(nodes[n]["lat"], nodes[n]["lon"]) for w in taxi for n in w["nodes"] if n in nodes]
    lat0, lon0 = centroid(ref_pts)
    kx, ky = 111320 * math.cos(math.radians(lat0)), 110540

    def proj(n):
        return ((n["lon"] - lon0) * kx, -(n["lat"] - lat0) * ky)

    # --- граф рулёжных дорожек
    N, E = {}, []
    for w in taxi:
        ids = [n for n in w["nodes"] if n in nodes]
        for n in ids:
            N.setdefault(f"N{n}", proj(nodes[n]))
        for a, b in zip(ids, ids[1:]):
            if a != b:
                E.append({"a": f"N{a}", "b": f"N{b}", "kind": "taxiway", "name": w["tags"].get("ref", "")})
    adj = {}
    for e in E:
        adj.setdefault(e["a"], []).append(e["b"])
        adj.setdefault(e["b"], []).append(e["a"])
    # крупнейшая компонента связности
    seen, best = set(), []
    for s in adj:
        if s in seen:
            continue
        comp, q = [], deque([s])
        seen.add(s)
        while q:
            u = q.popleft()
            comp.append(u)
            for v in adj[u]:
                if v not in seen:
                    seen.add(v)
                    q.append(v)
        if len(comp) > len(best):
            best = comp
    keep = set(best)
    N = {k: v for k, v in N.items() if k in keep}
    E = [e for e in E if e["a"] in keep and e["b"] in keep]
    for i, e in enumerate(E, 1):
        e["id"] = f"E{i}"

    def nearest(pt):
        k = min(N, key=lambda n: math.hypot(N[n][0] - pt[0], N[n][1] - pt[1]))
        return k, math.hypot(N[k][0] - pt[0], N[k][1] - pt[1])

    # --- ВПП и площади
    runways, areas = [], []
    for w in ways:
        t = w["tags"]
        pts = [proj(nodes[n]) for n in w["nodes"] if n in nodes]
        if len(pts) < 2:
            continue
        if t.get("aeroway") == "runway":
            try:
                width = float(str(t.get("width", "45")).split()[0])
            except ValueError:
                width = 45
            runways.append({"name": t.get("ref", ""), "points": [[round(x), round(y)] for x, y in pts], "width": width})
        elif t.get("aeroway") in ("apron", "terminal", "hangar") and len(pts) >= 3:
            areas.append({"kind": t["aeroway"], "name": t.get("name", t.get("ref", "")),
                          "points": [[round(x), round(y)] for x, y in pts]})

    # --- стоянки
    cands = []
    for e in raw["elements"]:
        t = e.get("tags") or {}
        if t.get("aeroway") not in STAND_TAGS:
            continue
        if e["type"] == "node":
            pt = proj(e)
        elif e["type"] == "way":
            pts = [proj(nodes[n]) for n in e["nodes"] if n in nodes]
            if not pts:
                continue
            pt = centroid(pts)
        else:
            continue
        k, d = nearest(pt)
        if d <= 250:
            cands.append((pt, t.get("ref") or t.get("name") or "", k))
    cands.sort(key=lambda c: c[0][0])
    if len(cands) > max_stands:  # равномерная выборка вдоль перрона
        step = len(cands) / max_stands
        cands = [cands[int(i * step)] for i in range(max_stands)]
    stands, used = [], set()
    for i, (pt, ref, k) in enumerate(cands, 1):
        sid = f"ВС-{ref}" if ref else f"ВС-{i:02d}"
        if sid in used:
            sid = f"ВС-{i:02d}"
        used.add(sid)
        N[f"S{i}"] = pt
        E.append({"id": f"ES{i}", "a": k, "b": f"S{i}", "kind": "apron", "name": ""})
        stands.append({"id": sid, "node": f"S{i}", "heading": 0})

    # --- базы техников: ангары, иначе узлы по краям и в середине
    bases = []
    hangars = [a for a in areas if a["kind"] == "hangar"][:3]
    for i, h in enumerate(hangars, 1):
        pt = centroid(h["points"])
        k, _ = nearest(pt)
        N[f"BASE{i}"] = pt
        E.append({"id": f"EBASE{i}", "a": k, "b": f"BASE{i}", "kind": "apron", "name": ""})
        bases.append({"id": f"BASE{i}", "name": h["name"] or f"Ангар {i}", "node": f"BASE{i}"})
    if len(bases) < 3:
        taxi_nodes = sorted((n for n in N if n.startswith("N")), key=lambda n: N[n][0])
        for j, pos in enumerate((0, len(taxi_nodes) - 1, len(taxi_nodes) // 2)):
            if len(bases) >= 3:
                break
            i = len(bases) + 1
            nid = taxi_nodes[pos]
            x, y = N[nid]
            N[f"BASE{i}"] = (x, y + 60)
            E.append({"id": f"EBASE{i}", "a": nid, "b": f"BASE{i}", "kind": "apron", "name": ""})
            bases.append({"id": f"BASE{i}", "name": f"Пост ТО {i}", "node": f"BASE{i}"})

    # --- сдвиг в положительные координаты
    xs = [p[0] for p in N.values()] + [q[0] for r in runways for q in r["points"]] + [q[0] for a in areas for q in a["points"]]
    ys = [p[1] for p in N.values()] + [q[1] for r in runways for q in r["points"]] + [q[1] for a in areas for q in a["points"]]
    ox, oy, m = min(xs) - 150, min(ys) - 150, 0
    sh = lambda x, y: [round(x - ox), round(y - oy)]
    for r in runways:
        r["points"] = [sh(x, y) for x, y in r["points"]]
    for a in areas:
        a["points"] = [sh(x, y) for x, y in a["points"]]
    return {
        "name": name, "schematic": False, "source": "© участники OpenStreetMap (ODbL)",
        "width": round(max(xs) - ox + 150), "height": round(max(ys) - oy + 150),
        "runways": runways, "areas": areas,
        "nodes": [{"id": k, "x": sh(*v)[0], "y": sh(*v)[1]} for k, v in N.items()],
        "edges": E, "stands": stands, "bases": bases,
    }


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--icao", help="ICAO-код аэропорта: UUWW — Внуково, UUEE — Шереметьево, UUDD — Домодедово")
    p.add_argument("--input", help="готовый JSON-ответ Overpass (вместо загрузки из сети)")
    p.add_argument("--save-raw", help="сохранить сырой ответ Overpass в файл")
    p.add_argument("--out", required=True)
    p.add_argument("--name", help="название на карте")
    p.add_argument("--max-stands", type=int, default=15)
    a = p.parse_args()
    if a.input:
        raw = json.load(open(a.input, encoding="utf-8"))
    elif a.icao:
        raw = fetch(a.icao)
        if a.save_raw:
            json.dump(raw, open(a.save_raw, "w", encoding="utf-8"), ensure_ascii=False)
    else:
        p.error("нужен --icao или --input")
    data = build(raw, a.name or a.icao or "Аэропорт", a.max_stands)
    json.dump(data, open(a.out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"Готово: {a.out}: {len(data['nodes'])} узлов, {len(data['edges'])} рёбер, "
          f"{len(data['stands'])} стоянок, {len(data['bases'])} баз, {len(data['runways'])} ВПП")


if __name__ == "__main__":
    main()
