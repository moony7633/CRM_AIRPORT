"""SQLite: заявки (JSON) и журнал событий."""
import json
import sqlite3


class DB:
    def __init__(self, path):
        self.c = sqlite3.connect(path, check_same_thread=False)
        self.c.executescript(
            """
            CREATE TABLE IF NOT EXISTS requests (id INTEGER PRIMARY KEY, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS events (
                id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, text TEXT, request_id INTEGER, kind TEXT);
            """
        )
        self.c.commit()

    def save_request(self, req):
        self.c.execute(
            "INSERT OR REPLACE INTO requests (id, data) VALUES (?, ?)",
            (req["id"], json.dumps(req, ensure_ascii=False)),
        )
        self.c.commit()

    def load_requests(self):
        return [json.loads(r[0]) for r in self.c.execute("SELECT data FROM requests ORDER BY id")]

    def add_event(self, ts, text, request_id, kind):
        cur = self.c.execute(
            "INSERT INTO events (ts, text, request_id, kind) VALUES (?, ?, ?, ?)", (ts, text, request_id, kind)
        )
        self.c.commit()
        return cur.lastrowid

    def load_events(self, limit=200):
        rows = self.c.execute(
            "SELECT id, ts, text, request_id, kind FROM events ORDER BY id DESC LIMIT ?", (limit,)
        ).fetchall()
        return [{"id": r[0], "ts": r[1], "text": r[2], "request_id": r[3], "kind": r[4]} for r in rows]

    def reset(self):
        self.c.executescript("DELETE FROM requests; DELETE FROM events;")
        self.c.commit()
