# Companion Client & Release API

HTTP API for the NHF desktop app (Tauri), WoW addon zip distribution, and LiquidReminders mirroring.

Release metadata endpoints use the same **Companion API key** authentication as the roster external API. Static release files and the Tauri auto-updater check endpoint are public so the updater can download signed binaries without custom headers.

---

## Authentication

Create a Companion API key on the site under **Profile → Companion API Keys**.

Send the key on protected requests:

```http
Authorization: Bearer nhf_your_key_here
```

Keys are team-scoped tokens prefixed with `nhf_`. Revoking a key in Profile invalidates it immediately.

### Errors (protected endpoints)

| Status | Meaning                                                          |
| ------ | ---------------------------------------------------------------- |
| `401`  | Missing header, malformed `Bearer` value, or invalid/revoked key |
| `404`  | No mirrored release exists for that channel yet                  |
| `500`  | Server error                                                     |

Error body: `{ "error": "..." }`

---

## Base URL

Use your deployment backend origin (same host that serves `/api/*`):

- Local dev: `http://localhost:5000`
- Production: `https://nhfguild.com` (or your configured `PUBLIC_BASE_URL`)

All endpoints below are under `/api/external/v1/...`.

Mirrored files are served at `/releases/...` on the same origin.

---

## Endpoints

### GET `/api/external/v1/status`

Health check for the desktop app or other companion clients. Confirms the server is reachable and the API key is valid.

#### Example

```bash
curl -s \
  -H "Authorization: Bearer nhf_your_key_here" \
  "https://nhfguild.com/api/external/v1/status"
```

#### Response

```json
{
  "status": "ok",
  "teamId": "uuid-of-team-linked-to-key",
  "timestamp": "2026-07-04T18:00:00.000Z"
}
```

| Field       | Description                             |
| ----------- | --------------------------------------- |
| `status`    | Always `"ok"` when the request succeeds |
| `teamId`    | Team the API key belongs to             |
| `timestamp` | Server time (ISO 8601)                  |

Returns `401` if the API key is missing or invalid.

---

### GET `/api/external/v1/releases/addon/latest`

Returns the latest mirrored WoW addon zip metadata.

#### Example

```bash
curl -s \
  -H "Authorization: Bearer nhf_your_key_here" \
  "https://nhfguild.com/api/external/v1/releases/addon/latest"
```

#### Response

```json
{
  "semVersion": "v1.2.0",
  "version": 3,
  "downloadUrl": "https://nhfguild.com/releases/addon/nhf-addon.zip"
}
```

| Field         | Description                                            |
| ------------- | ------------------------------------------------------ |
| `semVersion`  | GitHub release tag                                     |
| `version`     | Monotonic mirror counter (increments when tag changes) |
| `downloadUrl` | Direct download URL for the mirrored zip               |

---

### GET `/api/external/v1/releases/liquid-reminders/latest`

Same shape as addon latest, for the LiquidReminders zip.

```json
{
  "semVersion": "v2.0.1",
  "version": 5,
  "downloadUrl": "https://nhfguild.com/releases/liquid-reminders/liquid-reminders.zip"
}
```

---

### GET `/api/external/v1/releases/client/latest`

Returns the latest desktop client release manifest (Tauri `latest.json` format with mirrored URLs).

#### Example

```bash
curl -s \
  -H "Authorization: Bearer nhf_your_key_here" \
  "https://nhfguild.com/api/external/v1/releases/client/latest"
```

#### Response

```json
{
  "semVersion": "0.5.3",
  "version": 12,
  "pubDate": "2026-06-20T23:54:24.179Z",
  "notes": "See the assets to download this version and install.",
  "platforms": {
    "windows-x86_64-nsis": {
      "signature": "<base64 signature>",
      "url": "https://nhfguild.com/releases/client/NHF.Addon.Manager_0.5.3_x64-setup.exe"
    },
    "windows-x86_64-msi": {
      "signature": "<base64 signature>",
      "url": "https://nhfguild.com/releases/client/NHF.Addon.Manager_0.5.3_x64_en-US.msi"
    }
  }
}
```

When Linux builds are published to GitHub, new platform keys (for example `linux-x86_64-gnu`) appear here automatically after sync.

---

### GET `/api/external/v1/releases/client/update/:currentVersion`

**Public endpoint** — no `Authorization` header required.

Used by the Tauri updater plugin. Compares `:currentVersion` to the latest mirrored release tag.

| Result                  | Status           | Body                                                                                                                 |
| ----------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------- |
| Up to date              | `204 No Content` | empty                                                                                                                |
| Update available        | `200 OK`         | Full Tauri manifest JSON (same structure as `client/latest` platforms wrapper — version, notes, pub_date, platforms) |
| No release mirrored yet | `204 No Content` | empty                                                                                                                |

#### Example

```bash
curl -i "https://nhfguild.com/api/external/v1/releases/client/update/0.5.2"
```

When an update exists, response body matches Tauri’s expected update manifest:

```json
{
  "version": "0.5.3",
  "notes": "See the assets to download this version and install.",
  "pub_date": "2026-06-20T23:54:24.179Z",
  "platforms": {
    "windows-x86_64-nsis": {
      "signature": "...",
      "url": "https://nhfguild.com/releases/client/NHF.Addon.Manager_0.5.3_x64-setup.exe"
    }
  }
}
```

#### Tauri configuration

Point the updater endpoint at:

```json
{
  "plugins": {
    "updater": {
      "endpoints": [
        "https://nhfguild.com/api/external/v1/releases/client/update/{{current_version}}"
      ]
    }
  }
}
```

The updater downloads binaries from the `url` values in the response (under `/releases/client/...`).

---

## Static release files

Mirrored artifacts are served without authentication:

| Path                                              | Content                                              |
| ------------------------------------------------- | ---------------------------------------------------- |
| `/releases/client/*`                              | Desktop client installers, signatures, `latest.json` |
| `/releases/addon/nhf-addon.zip`                   | WoW addon zip                                        |
| `/releases/liquid-reminders/liquid-reminders.zip` | LiquidReminders zip                                  |

These URLs are also returned in API responses (`downloadUrl`, manifest `platforms.*.url`).

---

## Website session API (not for desktop app)

These routes use Discord session cookies instead of Bearer tokens:

| Method | Path                    | Access                                                            |
| ------ | ----------------------- | ----------------------------------------------------------------- |
| `GET`  | `/api/releases/catalog` | Any logged-in raider — profile download buttons                   |
| `GET`  | `/api/releases/status`  | Officers only — sync status dashboard                             |
| `POST` | `/api/releases/refresh` | Officers only — trigger GitHub mirror sync (waits for completion) |

---

## Release refresh hook (CI / publish pipelines)

Call this after publishing a GitHub release so the site mirrors new assets immediately.

| Method | Path                         | Access                                               |
| ------ | ---------------------------- | ---------------------------------------------------- |
| `GET`  | `/api/releases/hook/refresh` | Public by default; optional `RELEASE_REFRESH_SECRET` |

Returns immediately with `{ "message": "Refreshed" }` while sync runs in the background (same as legacy wa-server).

#### Example

```bash
curl "https://nhfguild.com/api/releases/hook/refresh"
```

When `RELEASE_REFRESH_SECRET` is set, pass the secret as a query param or header:

```bash
curl "https://nhfguild.com/api/releases/hook/refresh?key=your-secret"
# or
curl -H "Authorization: Bearer your-secret" \
  "https://nhfguild.com/api/releases/hook/refresh"
```

---

## Migration from nhf-wa-server / nhfmanager.sragia.com

The old Deno release server used different paths and a raw `Authorization` header (not Bearer). Update the desktop app as follows:

| Old (wa-server)                 | New (nhf-roster)                                                    |
| ------------------------------- | ------------------------------------------------------------------- |
| `Authorization: <AUTH_KEY>`     | `Authorization: Bearer nhf_...`                                     |
| `GET /ping`                     | `GET /api/external/v1/status`                                       |
| `GET /getLatestAddon`           | `GET /api/external/v1/releases/addon/latest`                        |
| `GET /getLatestClient`          | `GET /api/external/v1/releases/client/latest`                       |
| `GET /getLatestLiquidReminders` | `GET /api/external/v1/releases/liquid-reminders/latest`             |
| `GET /clientupdate/:version`    | `GET /api/external/v1/releases/client/update/:version`              |
| `GET /assets/client.exe`        | Use `platforms.*.url` from manifest (EXE, MSI, Linux, etc.)         |
| `GET /assets/addon.zip`         | `downloadUrl` from addon latest, or `/releases/addon/nhf-addon.zip` |
| `GET /refresh`                  | `GET /api/releases/hook/refresh`                                    |

### Desktop app checklist

1. Set API base URL to your nhfguild.com backend (or local dev host).
2. Replace the static app API key with a user-generated Companion API key from Profile.
3. Send `Authorization: Bearer <key>` on all metadata requests.
4. Update Tauri updater endpoint to `/api/external/v1/releases/client/update/{{current_version}}`.
5. Handle multi-platform manifest responses (NSIS `.exe`, MSI, future Linux targets) instead of assuming a single `client.exe`.

### Server configuration

Set these environment variables on the backend:

```env
GITHUB_TOKEN=                    # Required for private addon repo; recommended for all channels
GITHUB_LR_TOKEN=                 # Optional; falls back to GITHUB_TOKEN
RELEASE_CLIENT_REPO=sragia/nhf-wa-client
RELEASE_ADDON_REPO=sragia/nhf-wa-addon
RELEASE_LR_REPO=LiquidTools/LiquidReminders
PUBLIC_BASE_URL=https://nhfguild.com
RELEASE_SYNC_INTERVAL_MS=21600000
RELEASE_REFRESH_SECRET=          # Optional; protects /api/releases/hook/refresh
```

After deploy, an officer should open **Profile → Release Status** and click **Refresh now** (or wait for startup sync) to populate mirrored files.

---

## Related docs

- Roster data API: [`Documentation/external-api.md`](external-api.md)
