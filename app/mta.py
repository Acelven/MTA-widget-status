"""MTA subway data access: service alerts + GTFS-realtime arrivals, with caching.

Feeds are public and need no API key (MTA dropped keys in 2024).
"""
from __future__ import annotations

import csv
import logging
import threading
import time
from pathlib import Path

import requests
from google.transit import gtfs_realtime_pb2

log = logging.getLogger("mta")

BASE_URL = "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/"
ALERTS_URL = BASE_URL + "camsys%2Fsubway-alerts.json"

# GTFS-RT trip-update feeds, keyed by the lines they carry.
FEED_PATHS = {
    "1234567S": "nyct%2Fgtfs",
    "ACE": "nyct%2Fgtfs-ace",
    "BDFM": "nyct%2Fgtfs-bdfm",
    "G": "nyct%2Fgtfs-g",
    "JZ": "nyct%2Fgtfs-jz",
    "NQRW": "nyct%2Fgtfs-nqrw",
    "L": "nyct%2Fgtfs-l",
    "SI": "nyct%2Fgtfs-si",
}

_ROUTE_FEEDS: dict[str, list[str]] = {}
for _r in ("1", "2", "3", "4", "5", "6", "7", "6X", "7X", "GS"):
    _ROUTE_FEEDS[_r] = ["1234567S"]
for _r in ("A", "C", "E", "H", "FS"):
    _ROUTE_FEEDS[_r] = ["ACE"]
for _r in "BDFM":
    _ROUTE_FEEDS[_r] = ["BDFM"]
_ROUTE_FEEDS["G"] = ["G"]
for _r in "JZ":
    _ROUTE_FEEDS[_r] = ["JZ"]
for _r in "NQRW":
    _ROUTE_FEEDS[_r] = ["NQRW"]
_ROUTE_FEEDS["L"] = ["L"]
_ROUTE_FEEDS["SI"] = _ROUTE_FEEDS["SIR"] = ["SI"]
# The station list calls every shuttle "S"; the 42 St shuttle lives in the
# numbered feed while Franklin Av / Rockaway Park shuttles live in the ACE feed.
_ROUTE_FEEDS["S"] = ["1234567S", "ACE"]


def feeds_for_route(route: str) -> list[str]:
    return _ROUTE_FEEDS.get(route.upper(), [])


# Order of the status board, matching the MTA's own service-status page.
ROUTE_ORDER = ["1", "2", "3", "4", "5", "6", "7", "A", "C", "E", "B", "D", "F", "M",
               "G", "J", "Z", "L", "N", "Q", "R", "W", "GS", "SI"]

_C = {
    "red": "#EE352E", "green": "#00933C", "purple": "#B933AD", "blue": "#0039A6",
    "orange": "#FF6319", "lime": "#6CBE45", "brown": "#996633", "grey": "#A7A9AC",
    "yellow": "#FCCC0A", "shuttle": "#808183", "sir": "#0078C6",
}
ROUTE_COLORS = {
    "1": _C["red"], "2": _C["red"], "3": _C["red"],
    "4": _C["green"], "5": _C["green"], "6": _C["green"], "6X": _C["green"],
    "7": _C["purple"], "7X": _C["purple"],
    "A": _C["blue"], "C": _C["blue"], "E": _C["blue"],
    "B": _C["orange"], "D": _C["orange"], "F": _C["orange"], "M": _C["orange"],
    "G": _C["lime"], "J": _C["brown"], "Z": _C["brown"], "L": _C["grey"],
    "N": _C["yellow"], "Q": _C["yellow"], "R": _C["yellow"], "W": _C["yellow"],
    "GS": _C["shuttle"], "FS": _C["shuttle"], "H": _C["shuttle"], "S": _C["shuttle"],
    "SI": _C["sir"], "SIR": _C["sir"],
}
DARK_TEXT_ROUTES = {"N", "Q", "R", "W"}
ROUTE_LABELS = {"GS": "S", "FS": "S", "H": "S", "SI": "SIR", "SIR": "SIR", "6X": "6", "7X": "7"}
# Aliases people type -> board id
ROUTE_ALIASES = {"S": "GS", "SIR": "SI", "6X": "6", "7X": "7"}

STATUS_LABELS = {
    "good": "Good Service",
    "notice": "Notice",
    "planned": "Planned Work",
    "service-change": "Service Change",
    "delays": "Delays",
    "suspended": "Suspended",
}
STATUS_SEVERITY = {"good": 0, "notice": 1, "planned": 2, "service-change": 3, "delays": 4, "suspended": 5}

ERROR_RETRY_SECONDS = 10


def route_info(route: str) -> dict:
    r = (route or "").upper()
    return {
        "route": r,
        "label": ROUTE_LABELS.get(r, r),
        "color": ROUTE_COLORS.get(r, "#6d6e71"),
        "textColor": "#111111" if r in DARK_TEXT_ROUTES else "#ffffff",
        "express": r.endswith("X"),
    }


def classify(alert_type: str) -> str:
    """Map an MTA 'alert_type' string to one of our status buckets."""
    t = (alert_type or "").lower()
    planned = t.startswith("planned")
    if "suspend" in t:
        return "planned" if planned else "suspended"
    if "delay" in t:
        return "delays"
    if planned:
        return "planned"
    if any(k in t for k in ("reroute", "service change", "stops skipped", "express to local",
                            "local to express", "slow speed", "part suspended")):
        return "service-change"
    return "notice"


def _is_active(alert: dict, now: float) -> bool:
    periods = alert.get("active_period") or []
    if not periods:
        return True
    for p in periods:
        start = p.get("start", 0) or 0
        end = p.get("end")
        if start <= now and (end is None or now <= end):
            return True
    return False


def _text(field: dict | None, lang: str = "en") -> str:
    for tr in (field or {}).get("translation", []):
        if tr.get("language") == lang:
            return (tr.get("text") or "").strip()
    return ""


def normalize_routes(routes: list[str] | None) -> list[str] | None:
    if not routes:
        return None
    out = []
    for r in routes:
        r = ROUTE_ALIASES.get(r.upper(), r.upper())
        if r in ROUTE_ORDER and r not in out:
            out.append(r)
    return out or None


def build_status(alerts_json: dict, now: float, route_filter: list[str] | None = None) -> dict:
    board = [r for r in ROUTE_ORDER if not route_filter or r in route_filter]
    per_route: dict[str, dict[str, dict]] = {r: {} for r in board}
    all_alerts: dict[str, dict] = {}

    for ent in (alerts_json or {}).get("entity", []):
        alert = ent.get("alert") or {}
        if not _is_active(alert, now):
            continue
        merc = alert.get("transit_realtime.mercury_alert") or {}
        atype = merc.get("alert_type") or ""
        status = classify(atype)
        routes = sorted({ie.get("route_id") for ie in alert.get("informed_entity", []) if ie.get("route_id")})
        item = {
            "id": ent.get("id"),
            "type": atype,
            "status": status,
            "severity": STATUS_SEVERITY[status],
            "planned": atype.lower().startswith("planned"),
            "header": _text(alert.get("header_text")),
            "description": _text(alert.get("description_text")),
            "updated": merc.get("updated_at") or merc.get("created_at"),
            "routes": [route_info(r)["label"] for r in routes],
        }
        hit = False
        for r in routes:
            r = ROUTE_ALIASES.get(r, r)
            if r in per_route:
                per_route[r][item["id"]] = item
                hit = True
        if hit and item["id"] not in all_alerts:
            all_alerts[item["id"]] = item

    rows = []
    counts = {k: 0 for k in STATUS_LABELS}
    for r in board:
        alerts = sorted(per_route[r].values(), key=lambda a: (-a["severity"], -(a["updated"] or 0)))
        status = alerts[0]["status"] if alerts else "good"
        counts[status] += 1
        info = route_info(r)
        info.update({
            "id": r,
            "status": status,
            "statusLabel": STATUS_LABELS[status],
            "severity": STATUS_SEVERITY[status],
            "alerts": alerts,
        })
        rows.append(info)

    ticker = sorted(all_alerts.values(), key=lambda a: (a["planned"], -a["severity"], -(a["updated"] or 0)))
    return {
        "routes": rows,
        "alerts": ticker[:25],
        "summary": {
            "total": len(rows),
            "good": counts["good"],
            "issues": len(rows) - counts["good"],
            "byStatus": counts,
        },
    }


def load_stations(path: Path) -> dict[str, dict]:
    stations: dict[str, dict] = {}
    if not path.exists():
        log.warning("station list %s missing; arrivals will show raw stop IDs", path)
        return stations
    with path.open(newline="", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            sid = (row.get("GTFS Stop ID") or "").strip()
            if not sid:
                continue
            stations[sid] = {
                "id": sid,
                "name": (row.get("Stop Name") or sid).strip(),
                "borough": (row.get("Borough") or "").strip(),
                "routes": (row.get("Daytime Routes") or "").split(),
                "north": (row.get("North Direction Label") or "Northbound").strip() or "Northbound",
                "south": (row.get("South Direction Label") or "Southbound").strip() or "Southbound",
            }
    return stations


class MTAClient:
    def __init__(self, stations_path: Path, refresh_seconds: int = 30, alerts_refresh_seconds: int = 60,
                 timeout: float = 15.0):
        self.stations = load_stations(stations_path)
        self.refresh_seconds = max(10, int(refresh_seconds))
        self.alerts_refresh_seconds = max(15, int(alerts_refresh_seconds))
        self.timeout = timeout
        self.session = requests.Session()
        self.session.headers["User-Agent"] = "mta-widget-status/1.0"
        self._cache: dict[str, dict] = {}
        self._locks: dict[str, threading.Lock] = {}
        self._glock = threading.Lock()

    # ---- caching ---------------------------------------------------------
    def _lock_for(self, key: str) -> threading.Lock:
        with self._glock:
            return self._locks.setdefault(key, threading.Lock())

    def _cached(self, key: str, ttl: int, loader):
        with self._lock_for(key):
            ent = self._cache.setdefault(key, {"ts": 0.0, "value": None, "error": None, "error_ts": 0.0})
            now = time.time()
            fresh = ent["value"] is not None and now - ent["ts"] < ttl
            backoff = ent["error"] and now - ent["error_ts"] < ERROR_RETRY_SECONDS
            if fresh or backoff:
                return ent
            try:
                ent["value"] = loader()
                ent["ts"] = now
                ent["error"] = None
            except Exception as exc:  # network / parse errors: keep stale data
                ent["error"] = f"{type(exc).__name__}: {exc}"
                ent["error_ts"] = now
                log.warning("fetch %s failed: %s", key, ent["error"])
            return ent

    def _load_alerts(self) -> dict:
        resp = self.session.get(ALERTS_URL, timeout=self.timeout)
        resp.raise_for_status()
        return resp.json()

    def _load_feed(self, key: str) -> gtfs_realtime_pb2.FeedMessage:
        resp = self.session.get(BASE_URL + FEED_PATHS[key], timeout=self.timeout)
        resp.raise_for_status()
        msg = gtfs_realtime_pb2.FeedMessage()
        msg.ParseFromString(resp.content)
        return msg

    # ---- public API ------------------------------------------------------
    def status(self, routes: list[str] | None = None) -> dict:
        ent = self._cached("alerts", self.alerts_refresh_seconds, self._load_alerts)
        now = time.time()
        data = ent["value"] or {}
        out = build_status(data, now, normalize_routes(routes))
        out.update({
            "updated": ent["ts"] or None,
            "feedTimestamp": (data.get("header") or {}).get("timestamp"),
            "error": ent["error"],
        })
        return out

    def normalize_stop(self, stop: str) -> str | None:
        s = (stop or "").strip().upper()
        if not s:
            return None
        if s not in self.stations and s[-1:] in ("N", "S") and s[:-1] in self.stations:
            s = s[:-1]
        return s

    def arrivals(self, stops: list[str], max_per_direction: int = 3) -> dict:
        ids: list[str] = []
        for s in stops:
            n = self.normalize_stop(s)
            if n and n not in ids:
                ids.append(n)
        now = time.time()
        result: dict[str, dict] = {}
        feeds_needed: set[str] = set()
        for sid in ids:
            st = self.stations.get(sid)
            routes = st["routes"] if st else []
            if routes:
                for r in routes:
                    feeds_needed.update(feeds_for_route(r))
            else:
                feeds_needed.update(FEED_PATHS)  # unknown stop: scan everything
            result[sid] = {
                "id": sid,
                "name": st["name"] if st else sid,
                "borough": st["borough"] if st else "",
                "routes": [route_info(r) for r in routes],
                "north": {"label": st["north"] if st else "Northbound", "arrivals": []},
                "south": {"label": st["south"] if st else "Southbound", "arrivals": []},
            }

        errors: list[str] = []
        feed_ts: dict[str, int] = {}
        for key in sorted(feeds_needed):
            ent = self._cached("feed:" + key, self.refresh_seconds, lambda k=key: self._load_feed(k))
            if ent["error"]:
                errors.append(f"{key}: {ent['error']}")
            msg = ent["value"]
            if msg is None:
                continue
            feed_ts[key] = msg.header.timestamp
            for e in msg.entity:
                if not e.HasField("trip_update"):
                    continue
                tu = e.trip_update
                route = tu.trip.route_id
                for stu in tu.stop_time_update:
                    base, d = stu.stop_id[:-1], stu.stop_id[-1:]
                    if base not in result or d not in ("N", "S"):
                        continue
                    t = stu.arrival.time if stu.HasField("arrival") and stu.arrival.time else 0
                    if not t and stu.HasField("departure"):
                        t = stu.departure.time
                    if not t or t < now - 30:
                        continue
                    item = route_info(route)
                    item.update({
                        "time": int(t),
                        "seconds": int(t - now),
                        "minutes": max(0, int((t - now) // 60)),
                        "trip": tu.trip.trip_id,
                    })
                    result[base]["north" if d == "N" else "south"]["arrivals"].append(item)

        for stop in result.values():
            for d in ("north", "south"):
                arr = sorted(stop[d]["arrivals"], key=lambda a: a["time"])
                stop[d]["arrivals"] = arr[:max_per_direction]

        return {
            "stops": [result[s] for s in ids],
            "feedTimestamps": feed_ts,
            "error": "; ".join(errors) if errors else None,
            "updated": now,
        }

    def search_stations(self, query: str, limit: int = 25) -> list[dict]:
        q = (query or "").strip().lower()
        if not q:
            return []
        hits = []
        for st in self.stations.values():
            if q == st["id"].lower() or q in st["name"].lower():
                hits.append({k: st[k] for k in ("id", "name", "borough", "routes", "north", "south")})
        hits.sort(key=lambda s: (not s["name"].lower().startswith(q), s["name"]))
        return hits[:limit]

    # ---- background warmer -----------------------------------------------
    def start_background(self, default_stops: list[str], default_routes: list[str] | None) -> threading.Thread:
        def loop():
            while True:
                try:
                    self.status(default_routes)
                    if default_stops:
                        self.arrivals(default_stops)
                except Exception:  # never let the warmer die
                    log.exception("background refresh failed")
                time.sleep(max(5, min(self.refresh_seconds, self.alerts_refresh_seconds)))

        th = threading.Thread(target=loop, name="mta-warmer", daemon=True)
        th.start()
        return th
