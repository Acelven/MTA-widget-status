# MTA Subway Status for the CORSAIR XENEON EDGE

A widget for the XENEON EDGE touchscreen that shows live NYC subway service
status per line plus next-train countdowns for the stops you care about, fed by
a small Docker container that polls the MTA's public real-time feeds.

```
MTA feeds ──▶ Docker container (Flask API + cached feeds) ──▶ iCUE widget on the XENEON EDGE
```

Two ways to put it on the screen:

| Mode | How | When to use |
| --- | --- | --- |
| **iFrame widget** | iCUE's built-in iFrame widget pointed at `http://<host>:8787/` | Fastest. No packaging, configure through the URL. |
| **Native widget** | Package the `widget/` folder into an `.icuewidget` and import it | Settings live in the iCUE panel (server URL, stops, colors, transparency). |

The MTA feeds no longer require an API key, so there is nothing to sign up for.

## 1. Run the container (Unraid or any Docker host)

A prebuilt image is published to GitHub Container Registry on every push to
`main` (amd64 and arm64):

```
ghcr.io/acelven/mta-widget-status:latest
```

Quickest start with plain Docker:

```bash
docker run -d --name mta-widget-status --restart unless-stopped \
  -p 8787:8787 -e MTA_STOPS=L08,127 -e TZ=America/New_York \
  ghcr.io/acelven/mta-widget-status:latest
```

Or with compose (pulls the same image):

```bash
cd MTA-widget-status
cp .env.example .env        # edit MTA_STOPS at minimum
docker compose up -d
```

To build from source instead, swap the `image:` line in `docker-compose.yml`
for `build: .` and run `docker compose up -d --build`.

Then open `http://<host>:8787/` in a browser. You should see the board render.

Environment variables (set in `.env` or the Unraid container template):

| Variable | Default | Meaning |
| --- | --- | --- |
| `MTA_STOPS` | `L08,127` | Comma-separated GTFS stop IDs to show arrivals for. |
| `MTA_ROUTES` | *(all)* | Limit the status board to these lines, e.g. `L,A,C,G`. |
| `REFRESH_SECONDS` | `30` | How often train positions are re-pulled. |
| `ALERTS_REFRESH_SECONDS` | `60` | How often service alerts are re-pulled. |
| `MAX_ARRIVALS` | `3` | Trains shown per direction (1 to 6). |
| `PORT` | `8787` | Listening port inside the container. |

### Finding your stop IDs

Stop IDs are the MTA's GTFS IDs, such as `L08` for Bedford Av or `127` for
Times Sq on the 1/2/3. The container has a search endpoint:

```
http://<host>:8787/api/stations?q=bedford
```

It returns the ID, name, lines, and direction labels. Note that a station
complex has one ID per line group: Times Sq is `127` for the 1/2/3 and `R16`
for the N/Q/R/W. Direction suffixes (`L08N`) are accepted and stripped.

### Unraid without compose

In the Docker tab, **Add Container** with repository
`ghcr.io/acelven/mta-widget-status:latest`, port `8787` mapped to `8787`,
and the environment variables above (at least `MTA_STOPS`). No build step is
needed; Unraid pulls the image directly.

## 2a. iFrame mode (quickest)

1. In iCUE, select the XENEON EDGE, open the Widgets panel, add an **iFrame** widget.
2. Set the URL to `http://<host>:8787/`.
3. Optional query parameters override the container defaults:

```
http://<host>:8787/?stops=L08,A41&routes=L,A,C,F&max=2&ticker=0&arrivals=0&refresh=20
```

## 2b. Native widget mode

Download `mta-subway-status.icuewidget` from the
[latest release](https://github.com/Acelven/MTA-widget-status/releases/latest)
and import it through the **+** button in the iCUE Widgets panel (or
double-click the file). Needs iCUE 5.47 or newer.

To rebuild the package yourself after editing `widget/` (requires Node.js):

```bash
npm install -g icuewidget-cli
icuewidget validate widget
icuewidget package widget      # emits mta-subway-status.icuewidget
```

Bump `version` in `widget/manifest.json` before re-packaging so iCUE treats it
as a new build, and remove the old widget from iCUE before importing the new one.

Then in the widget's settings:

- **Server URL**: `http://<host>:8787` (the container's LAN address).
- **Stop IDs** and **Lines to show**: leave blank to use the container's
  defaults, or override here.
- **Widget Personalization**: text, accent, and background colors, plus
  background transparency.

The API sends `Access-Control-Allow-Origin: *`, so the natively hosted widget
can fetch from the container without extra proxying.

## 2c. Tablet / kiosk dashboard

A separate full-screen dashboard for an always-on tablet is served by the same
container. It doesn't change the iCUE widget, which keeps living at `/`.

```
http://<host>:8787/dashboard/
```

Tap the gear to set it up. Settings are saved on that tablet.

- **Stations**: search by name, reorder, and pick one direction per station
  (for example only Manhattan-bound) or both. A station shows every line
  that stops there, so Times Sq lists the 1/2/3, 7, A/C/E, N/Q/R/W and
  shuttle together, with same-named directions like "Uptown" merged into one
  row. Use **Lines here** to narrow a station to a single platform group.
- **Lines**: choose which lines the status board and alerts cover, or tap
  "Use lines at my stations". None selected means every line.
- **Display**: trains per direction, whether to show good-service lines,
  whether planned work counts as a problem, alerts panel on or off, refresh
  rate, dark/light theme, 12 or 24-hour clock.
- **Night dimming**: darkens the screen between two times.
- **Kiosk link**: a URL carrying all of the above. Open it on another tablet
  to copy the setup. A tablet applies a given link once, then keeps its own
  edits, so a kiosk app that always reopens the same start URL won't undo
  changes. Add `&apply=1` to force a link to apply again.

Example link:

```
http://<host>:8787/dashboard/?stops=L08-N,A41&routes=A,C,F,L&max=4&planned=0
```

| Parameter | Example | Meaning |
| --- | --- | --- |
| `stops` | `L08-N,A41` | Stations in order. `-N` or `-S` keeps one direction. |
| `solo` | `R16` | Show only this platform's lines instead of the whole station. |
| `routes` | `A,C,F,L` | Lines for status and alerts. Omit for all. |
| `max` | `4` | Trains per direction, 1 to 5. |
| `good` | `0` | Hide the good-service bullets. |
| `planned` | `0` | Don't flag lines that only have planned work. |
| `alerts` | `0` | Hide the alerts panel. Tapping a line still shows its alerts. |
| `refresh` | `60` | Seconds between updates, 15 to 300. |
| `theme` | `light` | `dark`, `light`, or `auto`. |
| `clock` | `24` | 24-hour clock. |
| `dim` | `23:00-06:00-60` | Dim from 23:00 to 06:00 at 60%. |

Kiosk tips:

- **Android**: Fully Kiosk Browser (or similar) with the start URL set to the
  kiosk link gives true full screen, auto-start on boot, and keep-screen-on.
  In plain Chrome, use "Add to Home screen" and launch it from the icon.
- **iPad**: open in Safari, Share, "Add to Home Screen", then launch from the
  icon. Use Guided Access to lock it to the dashboard, and set Auto-Lock to
  Never.
- **Screen on**: the page asks the browser to keep the screen awake, but
  browsers only allow that over HTTPS. Over a plain `http://192.168...`
  address, rely on the tablet's or kiosk app's stay-awake setting.
- The page reloads itself twice a day and shifts by a few pixels every few
  minutes to limit screen burn-in.

## What the widget shows

- **Status board**: one chip per line in the MTA's order, colored bullet plus
  a status of Good Service, Notice, Planned Work, Service Change, Delays, or
  Suspended, derived from the active alerts on the MTA alerts feed.
- **Arrivals**: for each configured stop, the next trains in each direction
  with the MTA's own direction labels (Uptown/Downtown, Manhattan/Outbound...).
  "Now" means under 45 seconds.
- **Ticker**: scrolling headlines of active alerts, unplanned ones first.
- **Tap a line** with an issue to read the full alert text. The overlay closes
  on tap or after 20 seconds.
- **Offline handling**: if the container cannot be reached the last data stays
  on screen with an orange "offline" stamp. If the MTA feed is down the
  container keeps serving its last good copy.

Layout adapts from the Small landscape slot (840×344) to the XL slot
(2536×696) and to portrait slots.

## API reference

| Endpoint | Returns |
| --- | --- |
| `GET /api/all?stops=&routes=&max=&arrivals=` | Everything the widget needs in one call. |
| `GET /api/status?routes=` | Per-line status plus ticker alerts. |
| `GET /api/arrivals?stops=&max=` | Next trains per direction for the stops. |
| `GET /api/stations?q=` | Stop ID lookup by name. `?ids=L08,127` looks up specific IDs. |
| `GET /api/lines` | Every line with its bullet color, in the MTA's order. |
| `GET /dashboard/` | The tablet / kiosk dashboard. |
| `GET /api/config` | The container's effective defaults. |
| `GET /healthz` | Liveness check used by the Docker healthcheck. |

## Project layout

```
MTA-widget-status/
├── Dockerfile, docker-compose.yml, .env.example
├── app/
│   ├── server.py          Flask API, serves widget/ for iFrame mode
│   ├── mta.py             feed fetching, caching, status + arrivals logic
│   └── data/stations.csv  MTA station list (IDs, names, direction labels)
├── dashboard/             tablet / kiosk page served at /dashboard/
└── widget/                the iCUE widget (package this folder)
    ├── index.html, manifest.json
    ├── scripts/mta.js, styles/mta.css
    └── resources/icon.svg, preview.png
```

## Running without Docker

```bash
pip install -r requirements.txt
MTA_STOPS=L08,127 python -m app.server
```

## Data sources

- Alerts: `https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/camsys%2Fsubway-alerts.json`
- Trip updates: `https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs[-ace|-bdfm|-g|-jz|-nqrw|-l|-si]`
- Station list: NY Open Data "MTA Subway Stations" dataset (bundled as `app/data/stations.csv`; refresh it if the MTA renames stops).
