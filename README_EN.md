# World Cup Collector — Simulation & Prediction

Lightweight data collector, learning and simulation project for the 2026 World Cup. It runs a zero-dependency HTTP server (Node.js native modules) that serves both API endpoints and a static front-end.

Key features
- Zero-dependency HTTP server providing APIs and static UI.
- Background jobs for learning reviews and odds refreshes (configurable).
- Persistent data stored in the `data/` directory (odds history, learning reports, snapshots).

Quick start

Requirements: Node.js >= 20

Install (if needed):

```bash
npm install
```

Start the server:

```bash
npm start
# or
node src/server.js
```

Useful npm scripts
- `npm run check` — run `src/verify.js` for checks
- `npm run learn` — run `src/learn.js` to trigger learning
- `npm run hourly` — run `src/jobs/hourly-learning.js`
- `npm run odds` — run `src/jobs/odds-refresh.js`

APIs (examples)
- `GET /api/health` — health check
- `GET /api/overview` — dashboard data (add `?refresh=1` to force refresh; admin required for force)
- `POST /api/refresh` — trigger full refresh (POST and admin required)
- `GET /api/learning` — learning report
- `GET /api/odds-history?eventId=...` — odds history for an event

Security & config
- Admin endpoints validate requests using the `refreshToken` logic in `src/api/security.js`. Do not commit real secrets to the repo.
- Configuration options (port, host, data paths, intervals) live in `src/config.js`.

Data & sensitive files
- `data/` may contain large files and sensitive snapshots. Consider adding large or private data to `.gitignore` before publishing.

License
- This repository is licensed under the MIT License. See `LICENSE` for details.

Contributing
- Issues and PRs are welcome. Please remove sensitive files or credentials before submitting.
