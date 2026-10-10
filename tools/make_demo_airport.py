"""Генерирует data/airport_demo.json — условная схема аэропорта (по мотивам Внуково).

Это ШАБЛОН формата карты. Реальный аэропорт собирается из OpenStreetMap:
    python tools/osm_to_airport.py --icao UUWW --out data/airport_vnukovo.json
"""
import json
from pathlib import Path

nodes, edges, stands, bases = [], [], [], []


def node(nid, x, y):
    nodes.append({"id": nid, "x": x, "y": y})


def edge(eid, a, b, kind="taxiway", name=""):
    edges.append({"id": eid, "a": a, "b": b, "kind": kind, "name": name})


# Рулёжная дорожка A (y=480) и перронная дорожка B (y=900)
A_X = [300, 900, 1500, 2100, 2800]
B_X = [300, 900, 1300, 1500, 1700, 2100, 2500, 2800]
for i, x in enumerate(A_X, 1):
    node(f"A{i}", x, 480)
for i, x in enumerate(B_X, 1):
    node(f"B{i}", x, 900)
for i in range(len(A_X) - 1):
    edge(f"EA{i+1}", f"A{i+1}", f"A{i+2}", "taxiway", "A")
for i in range(len(B_X) - 1):
    edge(f"EB{i+1}", f"B{i+1}", f"B{i+2}", "taxiway", "B")
# Связки A <-> B
for k, (a, b) in enumerate([("A1", "B1"), ("A2", "B2"), ("A3", "B4"), ("A4", "B6"), ("A5", "B8")], 1):
    edge(f"EL{k}", a, b, "taxiway", f"C{k}")

# Стоянки ВС-01…ВС-05 (заход с дорожки B)
for k, bx in enumerate([900, 1300, 1700, 2100, 2500], 1):
    nid = f"S{k}"
    b_idx = B_X.index(bx) + 1
    node(nid, bx, 1100)
    edge(f"ES{k}", f"B{b_idx}", nid, "apron", "")
    stands.append({"id": f"ВС-0{k}", "node": nid, "heading": 180})

# Базы техников
node("BASE1", 350, 1060)
edge("EBASE1", "B1", "BASE1", "apron")
node("BASE2", 2850, 1060)
edge("EBASE2", "B8", "BASE2", "apron")
node("BASE3", 1500, 1260)
edge("EBASE3", "B4", "BASE3", "apron")
bases += [
    {"id": "BASE1", "name": "Ангар ТО (запад)", "node": "BASE1"},
    {"id": "BASE2", "name": "Пункт ТО (восток)", "node": "BASE2"},
    {"id": "BASE3", "name": "Пост у терминала", "node": "BASE3"},
]

data = {
    "name": "Демо-аэропорт (условная схема по мотивам Внуково)",
    "schematic": True,
    "width": 3200,
    "height": 1600,
    "runways": [{"name": "06/24", "points": [[150, 300], [3050, 300]], "width": 60}],
    "areas": [
        {"kind": "terminal", "name": "Терминал", "points": [[1000, 1330], [2300, 1330], [2300, 1520], [1000, 1520]]},
        {"kind": "apron", "name": "Перрон", "points": [[700, 840], [2700, 840], [2700, 1200], [700, 1200]]},
        {"kind": "hangar", "name": "Ангар", "points": [[150, 1130], [450, 1130], [450, 1260], [150, 1260]]},
    ],
    "nodes": nodes,
    "edges": edges,
    "stands": stands,
    "bases": bases,
}
out = Path(__file__).resolve().parent.parent / "data" / "airport_demo.json"
out.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
print("OK:", out, len(nodes), "узлов,", len(edges), "рёбер")
