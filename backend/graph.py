"""Граф рулёжных дорожек: алгоритм Дейкстры и движение по маршруту."""
import bisect
import heapq
import math

INF = float("inf")


class Route:
    """Ломаная линия маршрута; позиция по пройденному расстоянию."""

    def __init__(self, points):
        self.points = [tuple(p) for p in points]
        self.cum = [0.0]
        for (x1, y1), (x2, y2) in zip(self.points, self.points[1:]):
            self.cum.append(self.cum[-1] + math.hypot(x2 - x1, y2 - y1))
        self.total = self.cum[-1]

    def pos(self, d):
        if d >= self.total or len(self.points) == 1:
            return self.points[-1]
        i = bisect.bisect_right(self.cum, max(d, 0.0)) - 1
        i = max(0, min(i, len(self.points) - 2))
        seg = self.cum[i + 1] - self.cum[i]
        t = 0.0 if seg == 0 else (d - self.cum[i]) / seg
        (x1, y1), (x2, y2) = self.points[i], self.points[i + 1]
        return (x1 + (x2 - x1) * t, y1 + (y2 - y1) * t)

    def remaining(self, d):
        if d >= self.total:
            return []
        i = bisect.bisect_right(self.cum, max(d, 0.0)) - 1
        i = max(0, min(i, len(self.points) - 2))
        return [self.pos(d)] + self.points[i + 1:]


class Graph:
    def __init__(self, nodes, edges):
        self.nodes = {n["id"]: (float(n["x"]), float(n["y"])) for n in nodes}
        self.edges = {}
        self.adj = {nid: [] for nid in self.nodes}
        for e in edges:
            a, b = e["a"], e["b"]
            if a not in self.nodes or b not in self.nodes:
                raise ValueError(f"Ребро {e['id']}: неизвестный узел {a} или {b}")
            (x1, y1), (x2, y2) = self.nodes[a], self.nodes[b]
            length = float(e.get("length") or math.hypot(x2 - x1, y2 - y1))
            self.edges[e["id"]] = {**e, "length": length, "blocked": False}
            self.adj[a].append((b, e["id"]))
            self.adj[b].append((a, e["id"]))

    def tree(self, src):
        dist = {src: 0.0}
        prev = {}
        seen = set()
        pq = [(0.0, src)]
        while pq:
            d, u = heapq.heappop(pq)
            if u in seen:
                continue
            seen.add(u)
            for v, eid in self.adj[u]:
                e = self.edges[eid]
                if e["blocked"]:
                    continue
                nd = d + e["length"]
                if nd < dist.get(v, INF):
                    dist[v] = nd
                    prev[v] = u
                    heapq.heappush(pq, (nd, v))
        return dist, prev

    @staticmethod
    def path_to_source(prev, node, src):
        path = [node]
        while path[-1] != src:
            path.append(prev[path[-1]])
        return path

    @staticmethod
    def path_from_source(prev, node, src):
        return list(reversed(Graph.path_to_source(prev, node, src)))

    def nearest_node(self, x, y):
        return min(self.nodes, key=lambda n: math.hypot(self.nodes[n][0] - x, self.nodes[n][1] - y))

    def find_edge(self, a, b):
        for nbr, eid in self.adj.get(a, []):
            if nbr == b:
                return eid
        return None

    def set_blocked(self, edge_id, blocked):
        if edge_id not in self.edges:
            raise ValueError("Неизвестный участок дорожки")
        self.edges[edge_id]["blocked"] = bool(blocked)

    def blocked_ids(self):
        return [eid for eid, e in self.edges.items() if e["blocked"]]
