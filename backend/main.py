"""FastAPI: REST + WebSocket. Запуск: python run.py"""
import asyncio
import json
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .db import DB
from .engine import Engine

ROOT = Path(__file__).resolve().parent.parent
AIRPORT_FILE = Path(os.environ.get("AIRPORT_FILE", ROOT / "data" / "airport_demo.json"))
TECHS_FILE = Path(os.environ.get("TECHS_FILE", ROOT / "data" / "technicians.json"))
DB_FILE = os.environ.get("DB_FILE", str(ROOT / "dispatch.db"))

airport = json.loads(AIRPORT_FILE.read_text(encoding="utf-8"))
engine = Engine(airport, json.loads(TECHS_FILE.read_text(encoding="utf-8")), DB(DB_FILE))
clients: set[WebSocket] = set()


async def broadcast():
    if not clients:
        return
    msg = json.dumps(engine.snapshot(), ensure_ascii=False)
    for ws in list(clients):
        try:
            await ws.send_text(msg)
        except Exception:
            clients.discard(ws)


async def sim_loop():
    last = time.monotonic()
    since_push = 0.0
    while True:
        await asyncio.sleep(0.2)
        now = time.monotonic()
        dt, last = now - last, now
        engine.tick(dt)
        since_push += dt
        if since_push >= 0.4:
            since_push = 0.0
            await broadcast()


@asynccontextmanager
async def lifespan(_):
    task = asyncio.create_task(sim_loop())
    yield
    task.cancel()


app = FastAPI(title="Умная диспетчеризация ОТО", lifespan=lifespan)


def dispatcher_only(x_role: str = Header(default="")):
    if x_role != "dispatcher":
        raise HTTPException(403, "Роль «Наблюдатель»: изменение данных запрещено")


async def act(fn, *args, **kw):
    try:
        result = fn(*args, **kw)
    except ValueError as e:
        raise HTTPException(400, str(e))
    await broadcast()
    return result


class NewRequest(BaseModel):
    stand: str
    description: str
    qual: str = "auto"
    extra: str = ""
    priority: str = "normal"


class BlockBody(BaseModel):
    blocked: bool


class SpeedBody(BaseModel):
    speed: int


@app.get("/api/airport")
def get_airport():
    edges = [{**e, "length": round(e["length"], 1)} for e in engine.graph.edges.values()]
    return {**airport, "edges": edges}


@app.get("/api/state")
def get_state():
    return engine.snapshot()


@app.post("/api/requests", dependencies=[Depends(dispatcher_only)])
async def create_request(body: NewRequest):
    req = await act(engine.create_request, body.stand, body.description, body.qual, body.extra, body.priority)
    return {"id": req["id"], "status": req["status"]}


@app.post("/api/requests/{rid}/arrive", dependencies=[Depends(dispatcher_only)])
async def arrive(rid: int):
    await act(engine.mark_arrived, rid)
    return {"ok": True}


@app.post("/api/requests/{rid}/start", dependencies=[Depends(dispatcher_only)])
async def start(rid: int):
    await act(engine.start_work, rid)
    return {"ok": True}


@app.post("/api/requests/{rid}/resolve", dependencies=[Depends(dispatcher_only)])
async def resolve(rid: int):
    await act(engine.resolve, rid)
    return {"ok": True}


@app.post("/api/requests/{rid}/cancel", dependencies=[Depends(dispatcher_only)])
async def cancel(rid: int):
    await act(engine.cancel, rid)
    return {"ok": True}


@app.post("/api/edges/{edge_id}/block", dependencies=[Depends(dispatcher_only)])
async def block_edge(edge_id: str, body: BlockBody):
    await act(engine.set_edge_blocked, edge_id, body.blocked)
    return {"ok": True}


@app.post("/api/sim", dependencies=[Depends(dispatcher_only)])
async def set_sim(body: SpeedBody):
    await act(engine.set_speed, body.speed)
    return {"ok": True}


@app.post("/api/reset", dependencies=[Depends(dispatcher_only)])
async def reset():
    await act(engine.reset)
    return {"ok": True}


@app.post("/api/aircraft/spawn", dependencies=[Depends(dispatcher_only)])
async def spawn_aircraft():
    ac = await act(engine.spawn_aircraft_manual)
    return {"id": ac.id if ac else None, "flight": ac.flight if ac else None}


@app.post("/api/aircraft/{aid}/depart", dependencies=[Depends(dispatcher_only)])
async def depart_aircraft(aid: int):
    await act(engine.force_depart, aid)
    return {"ok": True}


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    clients.add(ws)
    try:
        await ws.send_text(json.dumps(engine.snapshot(), ensure_ascii=False))
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        clients.discard(ws)


@app.get("/")
def index():
    return FileResponse(ROOT / "frontend" / "index.html")


app.mount("/static", StaticFiles(directory=ROOT / "frontend"), name="static")
