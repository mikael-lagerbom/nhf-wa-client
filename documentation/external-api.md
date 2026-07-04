# External API Reference (`/api/external/v1`)

REST API for external integrations — primarily the WoW addon / companion app. All
responses are JSON. Source of truth: `backend/src/routes/external.ts` and
`backend/src/services/externalApiData.ts`.

Base URL: `https://<host>/api/external/v1`

## Authentication

Every endpoint requires a team-scoped API key passed as a Bearer token:

```
Authorization: Bearer nhf_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

- Keys are created by officers in **Team Settings → API Keys**. The plain token
  is shown **once** on creation; only a SHA-256 hash is stored.
- The key determines the team — there is no team parameter on any endpoint.
- Missing/invalid key → `401 { "error": "..." }`.

```sh
curl -H "Authorization: Bearer nhf_..." https://<host>/api/external/v1/seasons
```

## Common concepts

- **`seasonId` query param** — all data endpoints accept `?seasonId=` (e.g.
  `midnight-s2`). When omitted: the team's current season, falling back to the
  manifest default. Valid ids come from `GET /seasons`.
- **`bossId`** — roster boss uuid; the canonical join key across all endpoints.
  Boss names, images, and Blizzard ids live in `GET /season` → `bosses[]`; other
  endpoints reference bosses by `bossId` only.
- **`journalEncounterId`** — Blizzard journal encounter id (`EJ_*` APIs), exposed
  on season bosses for addon texture lookups.
- **`encounterId`** — Blizzard *dungeon* encounter id (`ENCOUNTER_START` /
  DBM/BigWigs), used on assignments so the addon can match live encounters.
- **Errors** — non-2xx responses use the envelope `{ "error": "message" }`
  (401 unauthorized, 500 internal).

---

## GET /seasons

The team's current season plus all seasons known to the app (id list only — use
`GET /season` for boss catalog).

```jsonc
{
  "teamId": "team-uuid",
  "currentSeasonId": "midnight-s2",
  "currentSeason": {
    "id": "midnight-s2",
    "name": "Midnight Season 2",
    "shortLabel": "S2",
    "expansion": "Midnight",
    "journalPath": "/journal/midnight-s2.json"
  },
  "defaultSeasonId": "midnight-s2",
  "seasons": [ /* same shape as currentSeason */ ]
}
```

---

## GET /season?seasonId=

Season metadata plus the **canonical boss catalog** for the season. Fetch this
first (or cache it) and join other endpoints on `bossId`.

```jsonc
{
  "teamId": "team-uuid",
  "seasonId": "midnight-s2",
  "season": {
    "id": "midnight-s2",
    "name": "Midnight Season 2",
    "shortLabel": "S2",
    "expansion": "Midnight",
    "journalPath": "/journal/midnight-s2.json"
  },
  "roster": {                       // null when no roster exists for the season
    "id": "roster-uuid",
    "name": "Mythic Roster",
    "displayName": "Mythic Roster",
    "raidDate": "2026-07-02",       // null when unset
    "updatedAt": "2026-07-01T18:22:03.000Z"
  },
  "bosses": [
    {
      "bossId": "boss-uuid",         // join key for rosters, assignments, raid plans
      "name": "Nak'zali",
      "journalEncounterId": 2888,    // null when not linked to the journal
      "dungeonEncounterId": 3470,    // null when unknown; use for ENCOUNTER_START matching
      "imageUrl": "https://<host>/images/nakzali.png"  // "" when unknown
    }
  ]
}
```

When multiple roster bosses share the same `journalEncounterId`, raid plan boards
for that journal boss resolve to the **first** roster boss in roster order.

---

## GET /rosters?seasonId=

Boss-by-boss roster: who plays and who sits, plus group setup and reminders from
the boss's primary assignment (lowest-order, non-hidden) when present. Boss
metadata is in `GET /season` — entries here reference `bossId` only.

```jsonc
{
  "teamId": "team-uuid",
  "seasonId": "midnight-s2",
  "roster": {                       // null when no roster exists for the season
    "id": "roster-uuid",
    "name": "Mythic Roster",
    "displayName": "Mythic Roster",
    "raidDate": "2026-07-02",       // null when unset
    "updatedAt": "2026-07-01T18:22:03.000Z"
  },
  "bosses": [
    {
      "bossId": "boss-uuid",
      "slots": [                     // playing roster
        { "playerName": "Healbot", "className": "Priest", "spec": "Holy" }
      ],
      "bench": [ /* same slot shape */ ],
      "groupSetup": {                // null when the primary assignment has none
        "groupCount": 4,             // 4 on mythic, 6 otherwise
        "groups": [ [ /* 5 slots per group; empty slots are {} */ ] ],
        "raidLeader": { "playerName": "..." },
        "raidAssistants": [ { "playerName": "..." } ]
      },
      "reminders": [                 // null when none
        {
          "forEveryone": false,
          "roles": ["healer"],       // only for role-targeted reminders
          "players": [ { "playerName": "...", "className": "..." } ],
          "mainText": "Pre-pot on pull",
          "subText": "…",            // omitted when empty
          "iconFileId": 135936       // omitted when unset
        }
      ]
    }
  ]
}
```

Slot fields (`slots`, `bench`, group setup slots, reminder players) are all
optional: `playerName` (always the **character** name, or custom text),
`className` (English class name, e.g. `"Mage"`), `spec`.

---

## GET /assignment-notes?seasonId=

Generated addon note strings (NSRT/WA format) per assignment, grouped by `bossId`,
plus references to any raid plans attached to the assignment's components. Boss
names and images are in `GET /season`.

```jsonc
{
  "teamId": "team-uuid",
  "seasonId": "midnight-s2",
  "bosses": [
    {
      "bossId": "boss-uuid",
      "assignments": [
        {
          "assignmentName": "Nak'zali Mythic",
          "encounterId": 3470,       // dungeon encounter id; null when unresolvable
          "difficulty": "mythic",    // null when unset
          "note": "nsrt-formatted note text…",
          "raidPlans": [             // omitted entirely when no raid plan is attached
            {
              "componentId": "comp-uuid",
              "componentType": "spell-assignment",  // "group" | "spell-assignment" | "note"
              "componentTitle": "Healing CDs",      // omitted when untitled
              "boardId": "board-uuid",              // joins to GET /raid-plans boards[].id
              "slideIds": ["slide-uuid-1"],         // null = all slides; [] = none
              "slots": [
                { "slotId": 1, "playerName": "Healbot", "className": "Priest", "spec": "Holy" },
                { "slotId": 2, "playerName": "Dpsguy", "className": "Mage" }
              ]
            }
          ]
        }
      ]
    }
  ]
}
```

### `raidPlans` semantics

- Present only when a component of the assignment has an **internal** raid plan
  board attached. Attachments to external raidstrats.gg plans are not exposed
  (the addon cannot render them).
- `slots` is the component's slot occupancy: slots flattened row-major
  (group components: grid rows; spell-assignment components: each set's slots
  as one row), 1-based flat index = `slotId`. Empty slots are skipped — `slotId`
  values may have gaps. `slotId` matches the `slotId` field on `icon` elements
  of the referenced raid plan board (see below).
- `playerName` is the character name (or custom slot text).

---

## GET /raid-plans?seasonId=

All raid plan boards for the season in a minimal, addon-friendly shape. Bulky
element types (freehand drawings, emoji, uploaded images) and elements hidden in
the editor are **excluded**; everything else carries enough data to redraw the
plan in-game.

```jsonc
{
  "teamId": "team-uuid",
  "seasonId": "midnight-s2",
  "stage": { "width": 1600, "height": 900 },   // logical coordinate space of all plans
  "assets": {
    "markers": [{ "index": 1, "iconUrl": "https://<host>/images/boss-insights/marker-1.png" }],
    "roles": [{ "role": "tank", "iconUrl": "https://<host>/images/tank.png" }],
    "classes": [{ "className": "Death Knight", "iconUrl": "https://wow.zamimg.com/..." }],
    "abilities": [{ "iconId": 123456, "iconUrl": "https://render.worldofwarcraft.com/..." }],
    "media": [{ "path": "/media/<teamId>/upload.png", "url": "https://<host>/media/<teamId>/upload.png" }]
  },
  "boards": [
    {
      "id": "board-uuid",
      "name": "Nak'zali Mythic",
      "bossId": "boss-uuid",         // joins to GET /season bosses[].bossId; null when unlinked
      "order": 0,                    // display order
      "updatedAt": "2026-07-01T18:22:03.000Z",
      "slides": [
        {
          "id": "slide-uuid",
          "name": "P1 positions",
          "backgroundUrl": "https://<host>/images/raid-plans/arenas/midnight-s2/nakzali-arena.jpg",
          "elements": [ /* see element reference below */ ]
        }
      ]
    }
  ]
}
```

### Assets (`assets`)

Downloadable image catalog for addon prefetch. **Markers, roles, and classes** list
every palette icon (all 8 markers, 3 roles, 13 classes) even when unused on any
board. **Abilities** and **media** include only images referenced on at least one
plan in this response (`abilities` from boss-ability icon elements; `media` from
uploaded team images on plans — media elements are still omitted from
`slides[].elements`, but their URLs appear here for out-of-game download).

| Key | Contents |
|---|---|
| `markers` | `{ index, iconUrl }` — raid target markers 1–8 |
| `roles` | `{ role, iconUrl }` — `tank` / `healer` / `dps` |
| `classes` | `{ className, iconUrl }` — all WoW classes |
| `abilities` | `{ iconId, iconUrl }` — boss ability icons used on plans |
| `media` | `{ path, url }` — `path` is the stored `/media/…` ref; `url` is absolute |

Per-element `icon.iconUrl` on slides duplicates the matching `assets` entry for
convenience; prefer `assets` for bulk prefetch.

### Coordinate space

- Fixed logical canvas of **1600 × 900** (`stage`), origin top-left, x right,
  y down. Scale uniformly to your render size.
- `x`/`y` is the element **center** for icons and shapes, and the **top-left
  corner** for text elements. Arrow/triangle `points` are **relative to** `x`/`y`.
- `rotation` in degrees (clockwise), `opacity` 0–1.
- Element array order is **z-order**: index 0 renders at the bottom.
- Colors are objects with **0–1 channel values**: `{ "r": 1, "g": 0.2, "b": 0.2 }`,
  with `"a"` included only when < 1 (omitted = fully opaque; `a: 0` = fully
  transparent, e.g. a shape with no fill). Values are ready for WoW's
  `SetVertexColor`/`SetColorTexture`-style APIs.

### Backgrounds

- `backgroundUrl` is an absolute URL to a 16:9 image (~1600×900 JPG/PNG) served
  by the web app; download and cache it. `null` = plain dark background.
- WoW addons cannot fetch URLs in-game — download images out-of-game (companion
  app / manual step) and ship them as addon media.

### Element reference

Common fields on every element:

| Field | Type | Notes |
|---|---|---|
| `type` | string | `icon`, `rect`, `circle`, `triangle`, `arrow`, `text` |
| `id` | string | stable element id |
| `x`, `y` | number | center position, logical px |
| `rotation` | number | degrees |
| `opacity` | number | 0–1 |
| `label` | object? | optional text label, see below |

`label`: `{ text, fontSize, color, position?, offsetY?, strokeColor?, strokeWidth? }`
— `color`/`strokeColor` are color objects (see above), `position` is `below`
(default) / `above` / `center` / `left` / `right`, `offsetY` is extra gap in px
from the anchor edge (default 4).

**`icon`** — markers, role/class icons, boss ability icons.

| Field | Type | Notes |
|---|---|---|
| `size` | number | square side, logical px |
| `icon` | object | see icon refs below |
| `slotId` | number? | 1-based assignment slot; joins to `raidPlans[].slots` in assignment-notes |
| `mask` | string? | `circle` clip for ability icons (default rectangular) |

Icon refs (`icon` field):

| `kind` | Fields | Meaning |
|---|---|---|
| `marker` | `index` 1–8, `iconUrl` | raid target marker (1 star, 2 circle, 3 diamond, 4 triangle, 5 moon, 6 square, 7 cross, 8 skull) |
| `role` | `role`, `iconUrl` | `tank` / `healer` / `dps` |
| `class` | `className`, `iconUrl?` | English class name, e.g. `"Death Knight"` |
| `ability` | `iconId`, `iconUrl` | boss ability icon; `iconId` is the WoW icon **FileDataID** (usable directly with texture APIs) |

`iconUrl` is an absolute URL to a PNG/JPG you can download and cache. Markers and roles
are served from the web app (`/images/boss-insights/marker-*.png`, `/images/<role>.png`);
class icons use the Wowhead CDN; ability icons use the WoW render CDN. For in-game
rendering you can still use built-in WoW textures from `kind`/`index`/`role`/`className`/
`iconId` when you prefer not to ship image files.

**`rect`** — `width`, `height`, `fill`, `stroke`, `strokeWidth`, `cornerRadius?`

**`circle`** — ellipse: `radiusX`, `radiusY`, `fill`, `stroke`, `strokeWidth`

**`triangle`** — `points` `[x0,y0,x1,y1,x2,y2]` relative to (x, y), `fill`, `stroke`, `strokeWidth`

**`arrow`** — `points` `[x1,y1,x2,y2]` relative to (x, y); tail at point 1, head at point 2; `stroke`, `strokeWidth`, `fill` (arrowhead), `pointerLength?`, `pointerWidth?` (arrowhead size, default 16 each)

**`text`** — `text`, `fontSize`, `color`, `backgroundColor?`, `strokeColor?` (outline), `strokeWidth?`, `fontStyle?` (`normal`/`bold`/`italic`/`bold italic`), `width?` (wrap width; absent = auto), `align?` (`left`/`center`/`right`)

All `fill`, `stroke`, `color`, `backgroundColor`, and `strokeColor` fields are
color objects: `{ "r": 0–1, "g": 0–1, "b": 0–1, "a"?: 0–1 }`.

Optional fields are omitted from the JSON when unset.

For exact rendering semantics (anchoring, stroke placement, label positioning,
slot-icon player substitution, WoW texture suggestions), see
`ADDON_RAID_PLAN_RENDERING.md`.

---

## Recreating an assignment's raid plan in-game

1. `GET /season` → build a `bossId` → boss lookup (names, images).
2. `GET /assignment-notes` → find the assignment → each entry in `raidPlans`.
3. `GET /raid-plans` → find the board with `id === raidPlans[].boardId`.
4. Filter the board's slides: `slideIds === null` → show all; otherwise show
   only slides whose `id` is in `slideIds` (empty array → none).
5. Render each slide: download/cached `backgroundUrl` (or plain dark), then draw
   `elements` in array order, scaling 1600×900 to your frame.
6. For `icon` elements with a `slotId`, look up the player in that
   `raidPlans[].slots` entry with the matching `slotId` to show who the icon
   represents (name/class coloring, highlighting "you", etc.).
