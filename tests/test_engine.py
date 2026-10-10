"""Контрольные сценарии алгоритма. Запуск: python -m tests.test_engine  (или pytest)"""
import json
import pathlib

from backend.db import DB
from backend.engine import Engine, NORM_SEC, detect_qual

ROOT = pathlib.Path(__file__).resolve().parent.parent


def make(techs=None):
    airport = json.loads((ROOT / "data" / "airport_demo.json").read_text(encoding="utf-8"))
    cfg = techs or json.loads((ROOT / "data" / "technicians.json").read_text(encoding="utf-8"))
    return Engine(airport, cfg, DB(":memory:"))


def run(e, seconds, step=0.5):
    """Прокрутить модель на `seconds` модельных секунд."""
    n = int(seconds / (step * e.sim_speed)) + 1
    for _ in range(n):
        e.tick(step)


def test_1_basic_assignment():
    e = make()
    r = e.create_request("ВС-01", "Повреждение обшивки", "Планер")
    assert r["status"] == "enroute" and r["eta"] <= NORM_SEC


def test_2_different_quals():
    e = make()
    a = e.create_request("ВС-01", "x", "Планер")
    b = e.create_request("ВС-02", "x", "Авионика")
    c = e.create_request("ВС-03", "x", "Двигатель")
    assert len({a["tech_id"], b["tech_id"], c["tech_id"]}) == 3
    assert [e.techs[i]["qual"] if False else e.techs[i].qual for i in (a["tech_id"], b["tech_id"], c["tech_id"])] \
        == ["Планер", "Авионика", "Двигатель"]


def test_3_min_dist_preferred():
    """Теперь предпочитается ближайший по пути, а не самый быстрый."""
    cfg = [{"name": "А", "qual": "Планер", "speed": 2.0, "base": "BASE3"},
           {"name": "Б", "qual": "Планер", "speed": 5.2, "base": "BASE1"}]
    e = make(cfg)
    r = e.create_request("ВС-02", "x", "Планер")
    cand = {c["name"]: c for c in r["candidates"]}
    assert cand["А"]["dist"] < cand["Б"]["dist"]          # А ближе
    assert cand["А"]["eta"] > cand["Б"]["eta"]            # но Б быстрее
    # Теперь выбирается ближайший по пути
    assert e.techs[r["tech_id"]].name == "А"

def test_4_norm_filter():
    cfg = [{"name": "Медленный", "qual": "Планер", "speed": 0.5, "base": "BASE1"}]
    e = make(cfg)
    r = e.create_request("ВС-05", "x", "Планер")
    assert r["status"] == "waiting" and r["tech_id"] is None


def test_5_busy_tech_not_reassigned():
    e = make([{"name": "Один", "qual": "Планер", "speed": 5.0, "base": "BASE1"}])
    a = e.create_request("ВС-01", "x", "Планер")
    b = e.create_request("ВС-02", "x", "Планер")
    assert a["status"] == "enroute" and b["status"] == "waiting"
    e.mark_arrived(a["id"]); e.start_work(a["id"]); e.resolve(a["id"])
    e.tick(0.1)  # dirty -> dispatch_waiting
    assert b["status"] == "enroute"


def test_6_several_requests():
    e = make()
    a = e.create_request("ВС-01", "x", "Планер")
    b = e.create_request("ВС-02", "x", "Планер")
    assert a["tech_id"] != b["tech_id"]


def test_movement_and_auto_arrival():
    e = make()
    r = e.create_request("ВС-03", "x", "Планер")
    t = e.techs[r["tech_id"]]
    run(e, r["eta"] + 5)
    assert r["status"] == "arrived" and t.route is None
    assert r["within_norm"] is True and r["response_sec"] <= NORM_SEC


def test_full_cycle_and_history():
    e = make()
    r = e.create_request("ВС-01", "x", "Авионика")
    e.mark_arrived(r["id"]); e.start_work(r["id"]); e.resolve(r["id"])
    snap = e.snapshot()
    assert snap["active"] == [] and snap["history"][0]["id"] == r["id"]
    assert snap["stats"]["done"] == 1 and snap["stats"]["techs_free"] == 9


def test_invalid_transitions():
    e = make()
    r = e.create_request("ВС-01", "x", "Планер")
    for fn in (e.start_work, e.resolve):
        try:
            fn(r["id"]); assert False
        except ValueError:
            pass


def test_blocked_edge_reroutes_or_blocks():
    e = make([{"name": "Т", "qual": "Планер", "speed": 5.0, "base": "BASE1"}])
    open_eta = e.evaluate({"stand": "ВС-05", "qual": "Планер"})[0][0]["eta"]
    e.set_edge_blocked("EB2", True)  # участок B между B2 и B3
    rows, _ = e.evaluate({"stand": "ВС-05", "qual": "Планер"})
    assert rows[0]["eta"] > open_eta  # объезд по дорожке A длиннее
    for eid in ("EB1", "EL1"):
        e.set_edge_blocked(eid, True)  # база отрезана полностью
    rows, _ = e.evaluate({"stand": "ВС-05", "qual": "Планер"})
    assert rows[0]["eta"] is None


def test_emergency_preempts_busy_tech():
    e = make([{"name": "Единственный", "qual": "Двигатель", "speed": 5.0, "base": "BASE1"}])
    a = e.create_request("ВС-01", "x", "Двигатель")
    em = e.create_request("ВС-04", "пожар двигателя", "Двигатель", priority="emergency")
    assert em["status"] == "enroute" and a["status"] == "waiting"
    assert "ЧС" in a["note"]
    e.mark_arrived(em["id"]); e.start_work(em["id"]); e.resolve(em["id"])
    e.tick(0.1)
    assert a["status"] == "enroute"  # прерванная заявка получила техника


def test_emergency_when_norm_unreachable_still_assigns():
    e = make([{"name": "Медленный", "qual": "Планер", "speed": 0.5, "base": "BASE1"}])
    em = e.create_request("ВС-05", "x", "Планер", priority="emergency")
    assert em["status"] == "enroute" and em["violation"] is True


def test_waiting_queue_emergency_first():
    e = make([{"name": "Один", "qual": "Планер", "speed": 5.0, "base": "BASE1"}])
    a = e.create_request("ВС-01", "x", "Планер")
    n = e.create_request("ВС-02", "x", "Планер")
    em = e.create_request("ВС-03", "x", "Планер", priority="emergency")
    assert em["status"] == "enroute"          # перехватил у a
    assert a["status"] == "waiting" and n["status"] == "waiting"
    e.mark_arrived(em["id"]); e.start_work(em["id"]); e.resolve(em["id"])
    e.tick(0.1)
    assert a["status"] == "enroute" and n["status"] == "waiting"  # раньше созданная идёт первой


def test_detect_qual():
    assert detect_qual("Вибрация правого двигателя") == "Двигатель"
    assert detect_qual("Не работает навигационный дисплей") == "Авионика"
    assert detect_qual("Трещина обшивки у шасси") == "Планер"
    assert detect_qual("что-то странное") is None


def test_auto_qual_error_message():
    e = make()
    try:
        e.create_request("ВС-01", "что-то странное", "auto"); assert False
    except ValueError as ex:
        assert "вручную" in str(ex)


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in fns:
        fn(); print("OK  ", fn.__name__)
    print(f"\nВсе {len(fns)} тестов пройдены")
