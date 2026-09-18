"""HTTP front end: JSON API for the widget + serves the widget page for iFrame mode."""
from __future__ import annotations

import logging
import os
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory
from waitress import serve

from .mta import MTAClient, ROUTE_ORDER, STATUS_LABELS

ROOT = Path(__file__).resolve().parent
WIDGET_DIR = ROOT.parent / "widget"
STATIONS_CSV = ROOT / "data" / "stations.csv"


def _env_list(name: str) -> list[str]:
    return [x.strip().upper() for x in os.environ.get(name, "").split(",") if x.strip()]


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, "") or default)
    except ValueError:
        return default


CONFIG = {
    "stops": _env_list("MTA_STOPS"),
    "routes": _env_list("MTA_ROUTES") or None,
    "refresh": _env_int("REFRESH_SECONDS", 30),
    "alerts_refresh": _env_int("ALERTS_REFRESH_SECONDS", 60),
    "max_arrivals": max(1, min(6, _env_int("MAX_ARRIVALS", 3))),
    "port": _env_int("PORT", 8787),
}

app = Flask(__name__, static_folder=str(WIDGET_DIR), static_url_path="")
client = MTAClient(STATIONS_CSV, CONFIG["refresh"], CONFIG["alerts_refresh"])


def _list_arg(name: str, default: list[str] | None) -> list[str] | None:
    raw = request.args.get(name)
    if raw is None:
        return default
    return [x.strip().upper() for x in raw.split(",") if x.strip()] or None


def _int_arg(name: str, default: int, lo: int, hi: int) -> int:
    try:
        return max(lo, min(hi, int(request.args.get(name, default))))
    except (TypeError, ValueError):
        return default


@app.after_request
def _headers(resp):
    if request.path.startswith("/api/") or request.path == "/healthz":
        resp.headers["Access-Control-Allow-Origin"] = "*"
        resp.headers["Access-Control-Allow-Methods"] = "GET, OPTIONS"
        resp.headers["Access-Control-Allow-Headers"] = "*"
    resp.headers["Cache-Control"] = "no-store"
    return resp


@app.get("/")
def index():
    return send_from_directory(WIDGET_DIR, "index.html")


@app.get("/healthz")
def healthz():
    return jsonify({"ok": True})


@app.get("/api/config")
def api_config():
    return jsonify({
        "stops": CONFIG["stops"],
        "routes": CONFIG["routes"],
        "refreshSeconds": CONFIG["refresh"],
        "alertsRefreshSeconds": CONFIG["alerts_refresh"],
        "maxArrivals": CONFIG["max_arrivals"],
        "routeOrder": ROUTE_ORDER,
        "statusLabels": STATUS_LABELS,
    })


@app.get("/api/status")
def api_status():
    return jsonify(client.status(_list_arg("routes", CONFIG["routes"])))


@app.get("/api/arrivals")
def api_arrivals():
    stops = _list_arg("stops", CONFIG["stops"]) or []
    return jsonify(client.arrivals(stops, _int_arg("max", CONFIG["max_arrivals"], 1, 6)))


@app.get("/api/all")
def api_all():
    """Single call used by the widget: status board + arrivals + ticker alerts."""
    status = client.status(_list_arg("routes", CONFIG["routes"]))
    want_arrivals = request.args.get("arrivals", "1") != "0"
    stops = _list_arg("stops", CONFIG["stops"]) or []
    arrivals = client.arrivals(stops, _int_arg("max", CONFIG["max_arrivals"], 1, 6)) if (want_arrivals and stops) else None
    return jsonify({
        "updated": status["updated"],
        "status": status,
        "arrivals": arrivals,
        "errors": [e for e in (status.get("error"), arrivals and arrivals.get("error")) if e],
    })


@app.get("/api/stations")
def api_stations():
    return jsonify({"results": client.search_stations(request.args.get("q", ""))})


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    log = logging.getLogger("server")
    log.info("config: %s", CONFIG)
    client.start_background(CONFIG["stops"], CONFIG["routes"])
    log.info("serving widget + API on http://0.0.0.0:%d", CONFIG["port"])
    serve(app, host="0.0.0.0", port=CONFIG["port"], threads=8)


if __name__ == "__main__":
    main()
