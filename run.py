"""Запуск одной командой:  python run.py   →  http://127.0.0.1:8000

Другой аэропорт:  python run.py --airport data/airport_vnukovo.json
"""
import argparse
import os

import uvicorn

p = argparse.ArgumentParser()
p.add_argument("--airport", help="JSON карты аэропорта (по умолчанию data/airport_demo.json)")
p.add_argument("--host", default="127.0.0.1")
p.add_argument("--port", type=int, default=8000)
a = p.parse_args()
if a.airport:
    os.environ["AIRPORT_FILE"] = a.airport

if __name__ == "__main__":
    uvicorn.run("backend.main:app", host=a.host, port=a.port)
