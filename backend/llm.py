"""Генератор карточек рейсов.

Провайдеры по приоритету:
1. Ollama / любой OpenAI-совместимый сервер — LLM_BASE_URL (без лимитов).
2. Google Gemini — GEMINI_API_KEY (если задан, используется как fallback).
3. Встроенный шаблон — работает всегда и мгновенно.

Все запросы к LLM идут через одну очередь и один воркер-поток:
- никогда нет одновременных запросов — не будет 503 от конкурентности;
- между запросами выдерживается пауза MIN_INTERVAL.
"""
import json
import os
import queue
import random
import re
import threading
import time
import urllib.error
import urllib.request

try:
    from dotenv import load_dotenv
    load_dotenv()
except Exception:
    pass

# ---------- Ollama / OpenAI-совместимый ----------
OPENAI_BASE_URL = os.environ.get("LLM_BASE_URL", "").strip().rstrip("/")
OPENAI_API_KEY = os.environ.get("LLM_API_KEY", "").strip()
OPENAI_MODEL = os.environ.get("LLM_MODEL", "qwen2.5:7b").strip()

# ---------- Gemini (fallback) ----------
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "").strip()
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-flash-latest").strip()

TIMEOUT = float(os.environ.get("LLM_TIMEOUT", "60"))
MIN_INTERVAL = float(os.environ.get("LLM_MIN_INTERVAL", "1.5"))
QUEUE_MAX = int(os.environ.get("LLM_QUEUE_MAX", "8"))
DEBUG = os.environ.get("LLM_DEBUG", "1") == "1"


def _log(msg):
    if DEBUG:
        print(f"[LLM] {time.strftime('%H:%M:%S')} {msg}", flush=True)


# ---------- Данные шаблона ----------
AIRLINES = [
    "Аэрофлот", "Россия", "Победа", "S7 Airlines", "Уральские авиалинии",
    "Nordwind", "Azur Air", "Smartavia", "ЮТэйр", "Red Wings",
]

CITIES = [
    ("Москва", "Шереметьево", "SVO"),
    ("Санкт-Петербург", "Пулково", "LED"),
    ("Сочи", "Адлер", "AER"),
    ("Казань", "Казань", "KZN"),
    ("Екатеринбург", "Кольцово", "SVX"),
    ("Новосибирск", "Толмачёво", "OVB"),
    ("Калининград", "Храброво", "KGD"),
    ("Мурманск", "Мурманск", "MMK"),
    ("Владивосток", "Кневичи", "VVO"),
    ("Краснодар", "Пашковский", "KRR"),
    ("Иркутск", "Иркутск", "IKT"),
    ("Дубай", "DXB", "DXB"),
    ("Стамбул", "IST", "IST"),
    ("Белград", "BEG", "BEG"),
    ("Ереван", "EVN", "EVN"),
    ("Ташкент", "TAS", "TAS"),
    ("Пекин", "PEK", "PEK"),
    ("Шанхай", "PVG", "PVG"),
    ("Дели", "DEL", "DEL"),
    ("Анталья", "AYT", "AYT"),
]

NOTES = [
    "Стыковка с рейсом из LED, не задерживать посадку",
    "Трансферные пассажиры, приоритет по гейту",
    "Медицинский груз, обработка по регламенту",
    "Первый рейс после ТО, повышенное внимание",
    "Загрузка 92%, плотное расписание",
    "VIP-пассажир на борту, экипаж предупреждён",
    "Чартер, туристическая группа",
    "Возврат борта на базу, коммерческой загрузки нет",
    "Грузовой рейс, опасный груз класса 3",
    "Плановая ротация экипажа",
]


def _cfg_for_model(model):
    m = (model or "").upper()
    if "777" in m:        return {"pax": (330, 400), "crew": 14, "cargo": (2500, 7000)}
    if "350" in m:        return {"pax": (280, 330), "crew": 12, "cargo": (2000, 6000)}
    if "330" in m:        return {"pax": (250, 300), "crew": 11, "cargo": (1500, 5000)}
    if "320" in m or "737" in m:
                          return {"pax": (140, 189), "crew": 6,  "cargo": (500, 3000)}
    if "SSJ" in m:        return {"pax": (78, 98),   "crew": 5,  "cargo": (200, 1200)}
    return {"pax": (100, 200), "crew": 6, "cargo": (500, 3000)}


def template_now(flight, model):
    cfg = _cfg_for_model(model)
    origin, destination = random.sample(CITIES, 2)
    return {
        "airline": random.choice(AIRLINES),
        "flight_number": flight,
        "registration": f"RA-{random.randint(10000, 99999)}",
        "origin": {"city": origin[0], "airport": origin[1], "iata": origin[2]},
        "destination": {"city": destination[0], "airport": destination[1], "iata": destination[2]},
        "gate": f"{random.choice(['A','B','C'])}{random.randint(1, 30)}",
        "passengers": random.randint(*cfg["pax"]),
        "crew": cfg["crew"],
        "cargo_kg": random.randint(*cfg["cargo"]),
        "note": random.choice(NOTES),
        "source": "template",
    }


def _build_prompt(flight, model, status):
    return (
        f"Ты — система генерации данных аэропортового табло России. "
        f"Сгенерируй реалистичную карточку рейса {flight} на самолёте {model} "
        f"(статус: {status}).\n\n"
        f"Все текстовые поля — СТРОГО НА РУССКОМ ЯЗЫКЕ.\n"
        f"Верни СТРОГО валидный JSON без markdown:\n"
        f'{{'
        f'"airline": "Аэрофлот", '
        f'"flight_number": "SU 1234", '
        f'"registration": "RA-12345", '
        f'"origin": {{"city": "Москва", "airport": "Шереметьево", "iata": "SVO"}}, '
        f'"destination": {{"city": "Сочи", "airport": "Адлер", "iata": "AER"}}, '
        f'"gate": "A12", '
        f'"passengers": 174, "crew": 6, "cargo_kg": 2340, '
        f'"note": "Стыковка с рейсом из LED, не задерживать посадку"'
        f'}}\n\n'
        f"Правила:\n"
        f"- Пассажиры: 78-98 для SSJ-100; 140-189 для A320/B737; "
        f"250-300 для A330; 280-330 для A350; 330-400 для B777.\n"
        f"- Экипаж: 5 для SSJ-100; 6 для узкофюзеляжных; 10-14 для широкофюзеляжных.\n"
        f"- Груз: 200-1200 для SSJ; 500-3000 для A320/B737; 1500-7000 для широкофюзеляжных.\n"
        f"- Регистрация: строго RA-XXXXX (5 цифр).\n"
        f"- gate: одна буква A/B/C и число 1-30.\n"
        f"- origin и destination — РАЗНЫЕ города."
    )


def _parse_json(text):
    text = (text or "").strip()
    m = re.search(r"```(?:json)?\s*(.+?)\s*```", text, re.DOTALL)
    if m:
        text = m.group(1).strip()
    m = re.search(r"\{.*\}", text, re.DOTALL)
    if m:
        text = m.group(0)
    return json.loads(text)


def _normalize(result):
    def _pair(v):
        if isinstance(v, dict):
            return {
                "city": str(v.get("city", "") or "")[:40],
                "airport": str(v.get("airport", "") or "")[:60],
                "iata": str(v.get("iata", "") or "").upper()[:4],
            }
        return {"city": str(v or "")[:40], "airport": "", "iata": ""}

    reg = str(result.get("registration", "") or "").upper()
    if not re.match(r"^RA-\d{5}$", reg):
        reg = f"RA-{random.randint(10000, 99999)}"
    gate = str(result.get("gate", "") or "")
    if not re.match(r"^[A-C]\d{1,2}$", gate):
        gate = f"{random.choice(['A','B','C'])}{random.randint(1, 30)}"

    def _int(v):
        try:
            return int(v)
        except Exception:
            return 0

    return {
        "airline": str(result.get("airline", "") or "—")[:60],
        "flight_number": str(result.get("flight_number", "") or "")[:12],
        "registration": reg,
        "origin": _pair(result.get("origin")),
        "destination": _pair(result.get("destination")),
        "gate": gate,
        "passengers": _int(result.get("passengers")),
        "crew": _int(result.get("crew")),
        "cargo_kg": _int(result.get("cargo_kg")),
        "note": str(result.get("note", "") or "")[:200],
        "source": result.get("source", "llm"),
    }


def _openai_generate(flight, model, status):
    body = {
        "model": OPENAI_MODEL,
        "messages": [
            {"role": "system",
             "content": "Ты авиационный диспетчер. Отвечай только JSON, без markdown."},
            {"role": "user", "content": _build_prompt(flight, model, status)},
        ],
        "temperature": 1.0,
    }
    headers = {"Content-Type": "application/json"}
    if OPENAI_API_KEY:
        headers["Authorization"] = f"Bearer {OPENAI_API_KEY}"
    req = urllib.request.Request(
        f"{OPENAI_BASE_URL}/chat/completions",
        data=json.dumps(body).encode("utf-8"),
        headers=headers,
    )
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        data = json.load(r)
    text = data["choices"][0]["message"]["content"]
    return _normalize({**_parse_json(text), "source": "llm"})


def _gemini_generate(flight, model, status):
    url = (f"https://generativelanguage.googleapis.com/v1beta/models/"
           f"{GEMINI_MODEL}:generateContent")
    body = {
        "contents": [{"parts": [{"text": _build_prompt(flight, model, status)}]}],
        "generationConfig": {"temperature": 1.0, "responseMimeType": "application/json"},
    }
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "X-goog-api-key": GEMINI_API_KEY,
            "User-Agent": "dispatch-project/1.0",
        },
    )
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        data = json.load(r)
    text = data["candidates"][0]["content"]["parts"][0]["text"]
    return _normalize({**_parse_json(text), "source": "llm"})


def _generate(flight, model, status):
    errors = []

    # 1) Ollama / локальный сервер — раньше Gemini
    if OPENAI_BASE_URL:
        try:
            _log(f"→ {OPENAI_MODEL} @ {OPENAI_BASE_URL}: {flight}")
            res = _openai_generate(flight, model, status)
            _log(f"✓ {OPENAI_MODEL} ok: {flight} → {res.get('airline')}")
            return res
        except Exception as e:
            errors.append(f"openai: {type(e).__name__}")
            _log(f"✗ openai {type(e).__name__}: {e}")

    # 2) Gemini
    if GEMINI_API_KEY:
        try:
            _log(f"→ gemini {GEMINI_MODEL}: {flight}")
            res = _gemini_generate(flight, model, status)
            _log(f"✓ gemini ok: {flight}")
            return res
        except Exception as e:
            errors.append(f"gemini: {type(e).__name__}")
            _log(f"✗ gemini {type(e).__name__}: {e}")

    if not GEMINI_API_KEY and not OPENAI_BASE_URL:
        _log("LLM не настроена — используется шаблон")

    result = template_now(flight, model)
    if errors:
        result["error"] = "; ".join(errors)[:300]
    return result


# ---------- Очередь и воркер ----------
_task_queue: "queue.Queue" = queue.Queue(maxsize=QUEUE_MAX)
_worker_started = False
_worker_lock = threading.Lock()


def _worker_loop():
    last_call = 0.0
    while True:
        flight, model, status, on_done = _task_queue.get()
        gap = time.monotonic() - last_call
        if gap < MIN_INTERVAL:
            time.sleep(MIN_INTERVAL - gap)
        try:
            result = _generate(flight, model, status)
        except Exception as e:
            _log(f"✗ генерация упала: {e}")
            result = template_now(flight, model)
            result["error"] = f"{type(e).__name__}: {e}"[:200]
        last_call = time.monotonic()
        try:
            on_done(result)
        except Exception as e:
            _log(f"✗ on_done упал: {e}")
        finally:
            _task_queue.task_done()


def _ensure_worker():
    global _worker_started
    with _worker_lock:
        if _worker_started:
            return
        t = threading.Thread(target=_worker_loop, daemon=True, name="llm-worker")
        t.start()
        _worker_started = True


def generate_async(flight, model, status, on_done):
    _ensure_worker()
    try:
        _task_queue.put_nowait((flight, model, status, on_done))
        if DEBUG:
            _log(f"⊕ в очередь: {flight} (в очереди {_task_queue.qsize()})")
    except queue.Full:
        _log(f"⚠ очередь LLM переполнена ({QUEUE_MAX}) — {flight} получает шаблон")
        result = template_now(flight, model)
        result["error"] = "очередь LLM переполнена"
        try:
            on_done(result)
        except Exception:
            pass


def status_info():
    if OPENAI_BASE_URL:
        provider = "ollama" if ("11434" in OPENAI_BASE_URL or "ollama" in OPENAI_BASE_URL.lower()) else "openai"
        return {"mode": "llm", "provider": provider,
                "model": OPENAI_MODEL, "url": OPENAI_BASE_URL}
    if GEMINI_API_KEY:
        return {"mode": "llm", "provider": "gemini",
                "model": GEMINI_MODEL, "url": "generativelanguage.googleapis.com"}
    return {"mode": "template", "provider": "template", "model": "встроенный", "url": ""}
