# Kanji Academy Backend

Dependency-free Node.js API for Kanji Academy profile sync, avatar upload, and lesson progress.

## Run Locally

```powershell
cd backend
copy .env.example .env
npm test
npm start
```

Default API: `http://127.0.0.1:8787`

Connect the GitHub Pages frontend by opening:

```text
https://aslanakarzhaubay-source.github.io/kanji-basic-study/?api=https://YOUR_BACKEND_HOST
```

The frontend saves the API URL in `localStorage`. Without an API URL it keeps using the offline local profile.

## API

- `GET /health`
- `GET /api/v1/snapshot`
- `PATCH /api/v1/profile`
- `PUT /api/v1/progress`
- `POST /api/v1/profile/avatar`
- `GET /uploads/avatars/:file`

Every API request uses `X-Kanji-Device-Id`. If the header is absent or invalid, the backend creates a new device id and returns it in the same response header.

## Storage

Data is stored in `KANJI_DATA_DIR/kanji-academy.json` with atomic writes. Avatars are stored in `uploads/avatars`.

For multi-server production, put this API behind HTTPS and move the store to Postgres/object storage. The HTTP contract can remain unchanged.
