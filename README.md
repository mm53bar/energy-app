# energy-app

Personal home energy dashboard. Tracks electricity and gas bills from Alberta Co-operative Energy (ACE), monitors a 10.92 kW solar system via an APsystems ECU-B inverter, and logs fuel purchases.

## Features

- Bill history with electricity/gas breakdown
- Solar generation tracking (live from ECU + daily history)
- Solar ROI calculator (loan vs. export credits)
- Rate plan management
- Fuel purchase log

## Stack

Node.js + Express, SQLite via `better-sqlite3`, vanilla JS frontend.

## Running locally

```bash
npm install
npm start        # port 3007
npm run dev      # with --watch
```

Data is stored in `data/energy.db`. The `data/` directory is gitignored — create it on first run or mount an existing one.

## Deployment

Runs as a Docker container on Jumbo (192.168.0.56) via Arcane. The compose stack builds directly from this repo — no image registry involved.

To rebuild after pushing changes:

```bash
# On Jumbo
docker compose -f /app/data/projects/energy-app/compose.yaml build
docker compose -f /app/data/projects/energy-app/compose.yaml up -d
```

Data lives at `/volume1/docker/energy-app/data/` on the NAS and is mounted at `/app/data` inside the container.

## ECU

The APsystems ECU-B is expected at `http://192.168.0.58` on the LAN. The app syncs generation data on startup and nightly at 2am. If the ECU is offline, the app still starts — it just skips the sync.
