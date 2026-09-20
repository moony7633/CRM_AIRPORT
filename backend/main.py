# from locust import HttpUser, task, between
#
#
# class MyWebsiteUser(HttpUser):
#     # хост вашего сайта — сюда вставьте свой домен
#     host = "https://www.хакатоны.рус/tpost/f18ef78gj1-inzheneri-transporta/"
#
#     # пауза между запросами каждого "пользователя" (в секундах)
#     wait_time = between(1, 3)
#
#     @task
#     def open_homepage(self):
#         self.client.get("/")

from __future__ import annotations

import asyncio
import sqlite3
from datetime import datetime
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field


# =========================================================
# PATHS
# =========================================================

BASE_DIR = Path(__file__).resolve().parent.parent
FRONTEND_DIR = BASE_DIR / "frontend"
DB_PATH = BASE_DIR / "dispatch.db"


# =========================================================
# APP
# =========================================================

app = FastAPI(
    title="Умная диспетчеризация ОТО",
    version="1.0.0",
)

app.mount(
    "/static",
    StaticFiles(directory=FRONTEND_DIR),
    name="static",
)


# =========================================================
# CONSTANTS
# =========================================================

MAX_ETA_SECONDS = 15 * 60

REQUEST_STATUS_LABELS = {
    "waiting": "Ожидает назначения",
    "en_route": "В пути",
    "arrived": "Прибыл",
    "working": "В работе",
    "resolved": "Устранено",
    "suspended": "Приостановлена",
    "cancelled": "Отменена",
}

TECH_STATUS_LABELS = {
    "free": "Свободен",
    "moving": "В пути",
    "arrived": "Прибыл",
    "working": "Работает",
}

QUALIFICATION_LABELS = {
    "airframe": "Планер",
    "engine": "Двигатель",
    "avionics": "Авионика",
}

PRIORITY_LABELS = {
    "normal": "Обычная",
    "emergency": "ЧС",
}


# =========================================================
# DEMO TECHNICIANS
# =========================================================

technicians = {
    1: {
        "id": 1,
        "name": "Агент 1",
        "qualification": "airframe",
        "speed": 4.5,
        "position": "C3",
        "status": "free",
        "current_request_id": None,
    },
    2: {
        "id": 2,
        "name": "Агент 2",
        "qualification": "avionics",
        "speed": 4.0,
        "position": "M2",
        "status": "free",
        "current_request_id": None,
    },
    3: {
        "id": 3,
        "name": "Агент 3",
        "qualification": "engine",
        "speed": 5.2,
        "position": "M1",
        "status": "free",
        "current_request_id": None,
    },
}


# =========================================================
# DEMO DISTANCES
# =========================================================

# Условные расстояния для MVP.
# Когда появится интерактивная карта, этот блок заменится
# реальным графом аэропорта и Dijkstra.

DISTANCES = {
    1: {
        "ВС-01": 510,
        "ВС-02": 720,
        "ВС-03": 640,
        "ВС-04": 810,
        "ВС-05": 580,
    },
    2: {
        "ВС-01": 430,
        "ВС-02": 360,
        "ВС-03": 520,
        "ВС-04": 455,
        "ВС-05": 610,
    },
    3: {
        "ВС-01": 790,
        "ВС-02": 680,
        "ВС-03": 440,
        "ВС-04": 610,
        "ВС-05": 500,
    },
}


# =========================================================
# IN-MEMORY EVENTS / WEBSOCKETS
# =========================================================

events: list[dict] = []
connected_clients: set[WebSocket] = set()


def now_string() -> str:
    return datetime.now().strftime("%H:%M:%S")


def now_iso() -> str:
    return datetime.now().isoformat(timespec="seconds")


def add_event(message: str, level: str = "info") -> None:
    events.insert(
        0,
        {
            "time": now_string(),
            "message": message,
            "level": level,
        },
    )

    del events[30:]


# =========================================================
# DATABASE
# =========================================================

def db_connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    conn = db_connect()

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            number TEXT NOT NULL,
            created_at TEXT NOT NULL,
            aircraft TEXT NOT NULL,
            defect TEXT NOT NULL,
            qualification TEXT NOT NULL,
            priority TEXT NOT NULL,
            status TEXT NOT NULL,
            technician_id INTEGER,
            distance REAL,
            eta_seconds INTEGER,
            eta_total_seconds INTEGER,
            notes TEXT,
            completed_at TEXT
        )
        """
    )

    conn.commit()
    conn.close()


def get_request(request_id: int) -> dict | None:
    conn = db_connect()

    row = conn.execute(
        "SELECT * FROM requests WHERE id = ?",
        (request_id,),
    ).fetchone()

    conn.close()

    if row is None:
        return None

    return dict(row)


def list_requests() -> list[dict]:
    conn = db_connect()

    rows = conn.execute(
        """
        SELECT *
        FROM requests
        ORDER BY id DESC
        """
    ).fetchall()

    conn.close()

    return [dict(row) for row in rows]


# =========================================================
# QUALIFICATION CLASSIFIER
# =========================================================

def classify_qualification(text: str) -> str | None:
    value = text.lower()

    engine_words = [
        "двигател",
        "мотор",
        "турбин",
        "масл",
        "вибрац",
        "тяга",
        "обороты",
        "топлив",
    ]

    avionics_words = [
        "авионик",
        "индикатор",
        "экран",
        "дисплей",
        "радио",
        "навигац",
        "датчик",
        "связь",
        "панель",
        "сигнал",
        "электр",
    ]

    airframe_words = [
        "фюзеляж",
        "крыл",
        "шасси",
        "двер",
        "люк",
        "обшив",
        "колес",
        "стойк",
        "механик",
    ]

    if any(word in value for word in engine_words):
        return "engine"

    if any(word in value for word in avionics_words):
        return "avionics"

    if any(word in value for word in airframe_words):
        return "airframe"

    return None


# =========================================================
# SCHEMAS
# =========================================================

class CreateRequest(BaseModel):
    aircraft: str = Field(min_length=1, max_length=50)
    defect: str = Field(min_length=3, max_length=500)
    qualification: Literal["auto", "airframe", "engine", "avionics"]
    priority: Literal["normal", "emergency"] = "normal"
    notes: str = Field(default="", max_length=500)


class RequestAction(BaseModel):
    action: Literal[
        "arrive",
        "start",
        "resolve",
        "cancel",
    ]


# =========================================================
# ACCESS
# =========================================================

def require_dispatcher(request: Request) -> None:
    role = request.headers.get("X-Role", "dispatcher")

    if role != "dispatcher":
        raise HTTPException(
            status_code=403,
            detail="Действие доступно только диспетчеру",
        )


# =========================================================
# DISPATCH LOGIC
# =========================================================

def calculate_eta(technician_id: int, aircraft: str) -> tuple[float, int]:
    distance = DISTANCES.get(technician_id, {}).get(aircraft, 650)

    speed = technicians[technician_id]["speed"]

    seconds = max(
        1,
        round(distance / speed),
    )

    return distance, seconds


def suitable_candidates(
    qualification: str,
    aircraft: str,
) -> list[dict]:
    candidates = []

    for technician in technicians.values():

        if technician["qualification"] != qualification:
            continue

        if technician["status"] != "free":
            continue

        distance, eta = calculate_eta(
            technician["id"],
            aircraft,
        )

        candidates.append(
            {
                "technician_id": technician["id"],
                "distance": distance,
                "eta": eta,
            }
        )

    candidates.sort(
        key=lambda item: item["eta"]
    )

    return candidates


def emergency_candidates(
    qualification: str,
    aircraft: str,
) -> list[dict]:
    candidates = []

    for technician in technicians.values():

        if technician["qualification"] != qualification:
            continue

        distance, eta = calculate_eta(
            technician["id"],
            aircraft,
        )

        candidates.append(
            {
                "technician_id": technician["id"],
                "distance": distance,
                "eta": eta,
                "busy": technician["status"] != "free",
            }
        )

    candidates.sort(
        key=lambda item: (
            item["busy"],
            item["eta"],
        )
    )

    return candidates


def update_technician_for_request(
    technician_id: int,
    request_id: int,
) -> None:
    technician = technicians[technician_id]

    technician["status"] = "moving"
    technician["current_request_id"] = request_id


def release_technician(technician_id: int) -> None:
    technician = technicians[technician_id]

    technician["status"] = "free"
    technician["current_request_id"] = None


def suspend_current_request(technician_id: int) -> None:
    current_request_id = technicians[technician_id]["current_request_id"]

    if current_request_id is None:
        return

    current_request = get_request(current_request_id)

    if current_request is None:
        return

    if current_request["status"] in {
        "resolved",
        "cancelled",
        "suspended",
    }:
        return

    conn = db_connect()

    conn.execute(
        """
        UPDATE requests
        SET status = 'suspended',
            technician_id = NULL
        WHERE id = ?
        """,
        (current_request_id,),
    )

    conn.commit()
    conn.close()

    add_event(
        f'Заявка #{current_request["number"]} приостановлена из-за ЧС',
        "warning",
    )


def create_request(data: CreateRequest) -> dict:
    qualification = data.qualification

    detected = classify_qualification(data.defect)

    if qualification == "auto":

        if detected is not None:
            qualification = detected

        else:
            raise HTTPException(
                status_code=422,
                detail=(
                    "Не удалось автоматически определить квалификацию. "
                    "Выберите её вручную."
                ),
            )

    conn = db_connect()

    next_row = conn.execute(
        "SELECT COUNT(*) AS count FROM requests"
    ).fetchone()

    request_number = 1001 + int(next_row["count"])

    conn.execute(
        """
        INSERT INTO requests (
            number,
            created_at,
            aircraft,
            defect,
            qualification,
            priority,
            status,
            technician_id,
            distance,
            eta_seconds,
            eta_total_seconds,
            notes
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            str(request_number),
            now_iso(),
            data.aircraft,
            data.defect,
            qualification,
            data.priority,
            "waiting",
            None,
            None,
            None,
            None,
            data.notes,
        ),
    )

    request_id = conn.execute(
        "SELECT last_insert_rowid()"
    ).fetchone()[0]

    conn.commit()
    conn.close()

    request = get_request(request_id)

    if request is None:
        raise HTTPException(
            status_code=500,
            detail="Не удалось создать заявку",
        )

    # =====================================================
    # NORMAL
    # =====================================================

    if data.priority == "normal":

        candidates = suitable_candidates(
            qualification,
            data.aircraft,
        )

        if not candidates:
            add_event(
                (
                    f'Заявка #{request["number"]}: '
                    "подходящего свободного техника в нормативе нет"
                ),
                "warning",
            )

            return request

        selected = candidates[0]

    # =====================================================
    # EMERGENCY
    # =====================================================

    else:

        candidates = emergency_candidates(
            qualification,
            data.aircraft,
        )

        if not candidates:
            add_event(
                (
                    f'ЧС-заявка #{request["number"]}: '
                    "подходящего техника нет"
                ),
                "error",
            )

            return request

        selected = candidates[0]

        if selected["busy"]:
            suspend_current_request(
                selected["technician_id"]
            )

    # =====================================================
    # ASSIGN
    # =====================================================

    technician_id = selected["technician_id"]
    distance = selected["distance"]
    eta = selected["eta"]

    conn = db_connect()

    conn.execute(
        """
        UPDATE requests
        SET status = 'en_route',
            technician_id = ?,
            distance = ?,
            eta_seconds = ?,
            eta_total_seconds = ?
        WHERE id = ?
        """,
        (
            technician_id,
            distance,
            eta,
            eta,
            request_id,
        ),
    )

    conn.commit()
    conn.close()

    update_technician_for_request(
        technician_id,
        request_id,
    )

    technician_name = technicians[technician_id]["name"]

    add_event(
        (
            f'Заявка #{request["number"]} назначена: '
            f"{technician_name}, ETA {format_eta(eta)}"
        ),
        "success",
    )

    return get_request(request_id)


# =========================================================
# FORMATTERS
# =========================================================

def format_eta(seconds: int | None) -> str:
    if seconds is None:
        return "—"

    minutes = seconds // 60
    remaining = seconds % 60

    return f"{minutes:02d}:{remaining:02d}"


def serialize_technicians() -> list[dict]:
    result = []

    for technician in technicians.values():

        data = technician.copy()

        data["qualification_label"] = QUALIFICATION_LABELS[
            technician["qualification"]
        ]

        data["status_label"] = TECH_STATUS_LABELS[
            technician["status"]
        ]

        result.append(data)

    return result


def serialize_request(item: dict) -> dict:
    data = item.copy()

    data["qualification_label"] = QUALIFICATION_LABELS[
        item["qualification"]
    ]

    data["priority_label"] = PRIORITY_LABELS[
        item["priority"]
    ]

    data["status_label"] = REQUEST_STATUS_LABELS[
        item["status"]
    ]

    data["eta_label"] = format_eta(
        item["eta_seconds"]
    )

    return data


# =========================================================
# STATE
# =========================================================

def get_state() -> dict:
    all_requests = [
        serialize_request(item)
        for item in list_requests()
    ]

    active_statuses = {
        "waiting",
        "en_route",
        "arrived",
        "working",
        "suspended",
    }

    active_requests = [
        item
        for item in all_requests
        if item["status"] in active_statuses
    ]

    history = [
        item
        for item in all_requests
        if item["status"] in {
            "resolved",
            "cancelled",
        }
    ][:20]

    stats = {
        "technicians_total": len(technicians),
        "technicians_free": sum(
            1
            for item in technicians.values()
            if item["status"] == "free"
        ),
        "technicians_busy": sum(
            1
            for item in technicians.values()
            if item["status"] != "free"
        ),
        "active_requests": len(active_requests),
        "resolved_requests": len(history),
        "emergency_requests": sum(
            1
            for item in all_requests
            if item["priority"] == "emergency"
        ),
    }

    return {
        "technicians": serialize_technicians(),
        "active_requests": active_requests,
        "history": history,
        "events": events,
        "stats": stats,
        "qualifications": QUALIFICATION_LABELS,
        "statuses": REQUEST_STATUS_LABELS,
    }


# =========================================================
# WEBSOCKET
# =========================================================

async def broadcast_state() -> None:
    if not connected_clients:
        return

    data = get_state()

    disconnected = []

    for client in connected_clients:

        try:
            await client.send_json(data)

        except Exception:
            disconnected.append(client)

    for client in disconnected:
        connected_clients.discard(client)


# =========================================================
# SIMULATION
# =========================================================

async def simulation_loop() -> None:

    while True:

        await asyncio.sleep(1)

        changed = False
        arrivals: list[tuple[int, int]] = []

        requests = list_requests()

        for item in requests:

            if item["status"] != "en_route":
                continue

            if item["eta_seconds"] is None:
                continue

            new_eta = max(
                0,
                item["eta_seconds"] - 1,
            )

            conn = db_connect()

            if new_eta <= 0:

                conn.execute(
                    """
                    UPDATE requests
                    SET eta_seconds = 0,
                        status = 'arrived'
                    WHERE id = ?
                    """,
                    (item["id"],),
                )

                arrivals.append(
                    (
                        item["id"],
                        item["technician_id"],
                    )
                )

            else:

                conn.execute(
                    """
                    UPDATE requests
                    SET eta_seconds = ?
                    WHERE id = ?
                    """,
                    (
                        new_eta,
                        item["id"],
                    ),
                )

            conn.commit()
            conn.close()

            changed = True

        for request_id, technician_id in arrivals:

            if technician_id is None:
                continue

            technician = technicians.get(technician_id)

            if technician is None:
                continue

            technician["status"] = "arrived"

            add_event(
                (
                    f'Агент #{technician_id} прибыл '
                    f"к заявке #{request_id}"
                ),
                "success",
            )

        if changed:
            await broadcast_state()


# =========================================================
# STARTUP
# =========================================================

def restore_assignments() -> None:

    for technician in technicians.values():

        technician["status"] = "free"
        technician["current_request_id"] = None

    for request in list_requests():

        if request["technician_id"] is None:
            continue

        if request["status"] in {
            "resolved",
            "cancelled",
            "suspended",
        }:
            continue

        technician = technicians.get(
            request["technician_id"]
        )

        if technician is None:
            continue

        technician["current_request_id"] = request["id"]

        if request["status"] == "en_route":
            technician["status"] = "moving"

        elif request["status"] == "arrived":
            technician["status"] = "arrived"

        elif request["status"] == "working":
            technician["status"] = "working"


@app.on_event("startup")
async def startup() -> None:
    init_db()
    restore_assignments()
    add_event(
        "Система диспетчеризации запущена",
        "success",
    )
    asyncio.create_task(simulation_loop())


# =========================================================
# ROUTES
# =========================================================

@app.get("/")
async def index():
    return FileResponse(
        FRONTEND_DIR / "index.html"
    )


@app.get("/api/state")
async def api_state():
    return get_state()


@app.post("/api/requests")
async def api_create_request(
    data: CreateRequest,
    request: Request,
):
    require_dispatcher(request)

    result = create_request(data)

    await broadcast_state()

    return serialize_request(result)


@app.post("/api/requests/{request_id}/action")
async def api_request_action(
    request_id: int,
    data: RequestAction,
    request: Request,
):
    require_dispatcher(request)

    item = get_request(request_id)

    if item is None:
        raise HTTPException(
            status_code=404,
            detail="Заявка не найдена",
        )

    technician_id = item["technician_id"]

    # =============================================
    # ARRIVE
    # =============================================

    if data.action == "arrive":

        if item["status"] != "en_route":
            raise HTTPException(
                status_code=400,
                detail="Заявка не находится в статусе 'В пути'",
            )

        conn = db_connect()

        conn.execute(
            """
            UPDATE requests
            SET eta_seconds = 0,
                status = 'arrived'
            WHERE id = ?
            """,
            (request_id,),
        )

        conn.commit()
        conn.close()

        if technician_id in technicians:
            technicians[technician_id]["status"] = "arrived"

        add_event(
            f'Заявка #{item["number"]}: техник прибыл',
            "success",
        )

    # =============================================
    # START WORK
    # =============================================

    elif data.action == "start":

        if item["status"] != "arrived":
            raise HTTPException(
                status_code=400,
                detail="Сначала техник должен прибыть",
            )

        conn = db_connect()

        conn.execute(
            """
            UPDATE requests
            SET status = 'working'
            WHERE id = ?
            """,
            (request_id,),
        )

        conn.commit()
        conn.close()

        if technician_id in technicians:
            technicians[technician_id]["status"] = "working"

        add_event(
            f'Заявка #{item["number"]}: начата работа',
            "info",
        )

    # =============================================
    # RESOLVE
    # =============================================

    elif data.action == "resolve":

        if item["status"] != "working":
            raise HTTPException(
                status_code=400,
                detail="Начните работу перед завершением заявки",
            )

        conn = db_connect()

        conn.execute(
            """
            UPDATE requests
            SET status = 'resolved',
                completed_at = ?
            WHERE id = ?
            """,
            (
                now_iso(),
                request_id,
            ),
        )

        conn.commit()
        conn.close()

        if technician_id in technicians:
            release_technician(technician_id)

        add_event(
            f'Заявка #{item["number"]}: дефект устранён',
            "success",
        )

    # =============================================
    # CANCEL
    # =============================================

    elif data.action == "cancel":

        if item["status"] in {
            "resolved",
            "cancelled",
        }:
            raise HTTPException(
                status_code=400,
                detail="Заявка уже завершена",
            )

        conn = db_connect()

        conn.execute(
            """
            UPDATE requests
            SET status = 'cancelled',
                completed_at = ?
            WHERE id = ?
            """,
            (
                now_iso(),
                request_id,
            ),
        )

        conn.commit()
        conn.close()

        if technician_id in technicians:
            release_technician(technician_id)

        add_event(
            f'Заявка #{item["number"]}: отменена',
            "warning",
        )

    await broadcast_state()

    result = get_request(request_id)

    if result is None:
        raise HTTPException(
            status_code=404,
            detail="Заявка не найдена после изменения",
        )

    return serialize_request(result)


@app.websocket("/ws")
async def websocket_endpoint(
    websocket: WebSocket,
):
    await websocket.accept()

    connected_clients.add(websocket)

    await websocket.send_json(
        get_state()
    )

    try:

        while True:
            await websocket.receive_text()

    except WebSocketDisconnect:

        connected_clients.discard(
            websocket
        )
