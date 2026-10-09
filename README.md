# One Cut Atlas — backend

The dependency-free Node service behind [One Cut Atlas](https://toooonyliu.github.io/projects/one-cut-atlas/), a pixel-art travel and sword-duel game. It turns a player's travel photo into a duel stage: it recognizes the place, then paints an original pixel-art arena of it. It also powers **AI Colors**, a fighter palette suggestion. API keys live only in this server's environment, never in the browser or this repository.

**Live:** [one-cut-atlas-api.onrender.com](https://one-cut-atlas-api.onrender.com) (Render Free) ·
**Frontend source:** [toooonyliu.github.io/projects/one-cut-atlas](https://github.com/Toooonyliu/toooonyliu.github.io/tree/main/projects/one-cut-atlas) ·
[Deploy your own to Render](https://render.com/deploy?repo=https%3A%2F%2Fgithub.com%2FToooonyliu%2FOneCutAtlas_Backend)

## How a photo becomes a stage

```
browser                         this service                          OpenAI
compress photo ──POST /api/recognize-place──▶ vision model, strict JSON ──▶ gpt-6-luna
◀── place: name, city, zone, scene description
globe unlocks the zone; player taps Challenge
──POST /api/scenes──▶ 202 {jobId} ──▶ image edit with style references ──▶ gpt-image-2
──GET /api/scenes/{jobId} (poll)──▶ {status:"done", backdrop}
snap to 960×540, 48 colors; duel
```

1. **Recognize.** The vision model works like a geolocation scout: it lists 3–6 visible clues first (architecture and materials, the script on signs, vegetation, road layout), then names the place, city, country, approximate coordinates, one of the game's eleven travel zones, interior or exterior, lighting, and a short scene description built only from what is visible. People in the photo are ignored and never described or identified. Sign text may be read as a clue but is never copied into the output, and nothing in the photo is treated as an instruction. Photo GPS, when the browser sends it, is treated as reliable. A "scan again" can exclude up to three earlier answers.
2. **Paint.** The player's photo is not sent to the image model. It receives the exact brief used for the game's shipped stages, the validated scene description, the confirmed region, and the three shipped stages in `assets/style/` as style references. It returns a 1536×864 WebP. Painting runs as a polled job so a slow provider call never hits a proxy timeout; jobs live in memory for ten minutes.
3. **Pixelize** happens in the browser, which snaps the painting to the game's grid and stores it with the stage, so replays never paint again.

Measured with the developer's own photos on October 8–9, 2026: recognition at high image detail put eight of nine photos in the right city (low detail had misread Sapporo as Osaka; a volcano without signage stays unrecognized, which the game shows as an uncharted stage). A medium-quality painting took about 27 s and cost about $0.046 including the reference images; recognition is roughly 2,450 tokens per call.

## API

All photo routes take JSON with a JPEG, PNG or WebP data URL, at most 2 MB after decoding; remote URLs, mismatched formats and oversized dimensions are rejected before any provider call. Errors are `{"error":"..."}` with a matching HTTP status; provider details never reach the client.

| Route | Purpose |
| --- | --- |
| `GET /` · `GET /health` | Service info and configuration presence: `avatarAnalysisConfigured`, `placeRecognitionConfigured`, `arenaPaintingConfigured`. `true` means configured, not proof of billing or model access. |
| `POST /api/recognize-place` | `{"image", "zone"?, "gps"?: {lat, lon}, "exclude"?: [names]}` → `{"place": {...}, "source": "ai"}` |
| `POST /api/scenes` | `{"image", "zone", "scenePrompt", "setting", "lighting", "placeName"?}` → `202 {"jobId", "estimatedSeconds"}` |
| `GET /api/scenes/{jobId}` | `{"status": "queued" \| "painting" \| "done" \| "failed", "backdrop"?, "error"?}`; 404 once expired |
| `POST /api/analyze-avatar` | `{"image"}` → `{"avatar": {palette, style, hairStyle, summary}, "source": "ai"}` — four colors and one of the four existing outfits; no face reconstruction or sprite generation |

Example place (the clues are from a real response; other values abridged):

```json
{"place":{"evidence":["Japanese kana and kanji appear on many illuminated commercial signs.","Snow piled beside wet pavement suggests a cold, snowy climate."],"recognized":true,"name":"Susukino Crossing","city":"Sapporo","country":"Japan","latitude":43.055,"longitude":141.353,"zone":"east-asia","setting":"exterior","confidence":0.98,"lighting":"night","environment":"modern_city","opponentStyle":"suit","palette":{"sky":"#141822","accent":"#d8402f","ambient":"#0d1016"},"scenePrompt":"Empty night crossing with tall neon billboards, wet asphalt and snow banks under a black sky.","summary":"Susukino Crossing, Sapporo."},"source":"ai"}
```

Every model response is validated again here against a strict schema before it reaches the game: unknown fields, zones, colors or styles are rejected, and the scene description is limited to plain letters, digits and simple punctuation so it cannot carry markup or instructions into the painting prompt.

## Cost and abuse guards

These are demo guards held in memory; they reset when the free service sleeps or restarts. The prepaid provider balance and the OpenAI project's usage limits are the real ceiling.

- Painting: 3 per address per hour, 40 per service per day, 2 in flight, and identical photo-plus-prompt requests within ten minutes are served from cache instead of billed again. `SCENE_ENABLED=false` turns painting off while recognition keeps working.
- Recognition: 5 per address per minute. AI Colors: 5 per address per minute and 50 per process.
- Requests must come from an allowed browser origin in production (`AI_REQUIRE_ORIGIN=true`). This reduces casual misuse; it is not authentication, since a non-browser client can spoof the header.
- Billable requests are never retried automatically, by the server or by the game client.

## Run locally

Node 22 or newer, no dependencies.

```sh
npm test                                   # 27 tests, providers mocked
node --env-file=.env server.mjs            # http://localhost:4174
```

`.env` is ignored by Git; copy `.env.example`. Two billable scripts reproduce the measurements above and read the key from the env file without printing it: `scripts/recognition-accuracy.mjs` (compares recognition settings on a folder of photos) and `scripts/offline-style-test.mjs` (paints test arenas at several qualities).

| Variable | Purpose | Default |
| --- | --- | --- |
| `OPENAI_API_KEY` | Server-side OpenAI project key | — |
| `OPENAI_MODEL` | Vision model for recognition and AI Colors | Blueprint: `gpt-6-luna` |
| `OPENAI_IMAGE_MODEL` | Arena painter; empty disables painting | `gpt-image-2` |
| `SCENE_QUALITY` | `low`, `medium` or `high` | `medium` |
| `RECOGNIZE_DETAIL` / `RECOGNIZE_REASONING` | Vision image detail / reasoning effort | `high` / `none` |
| `SCENE_ENABLED`, `SCENE_PER_HOUR`, `SCENE_MAX_PER_DAY`, `SCENE_MAX_CONCURRENT` | Painting switch and caps | `true`, 3, 40, 2 |
| `RECOGNIZE_PER_MINUTE` | Recognition rate per address | 5 |
| `AI_PER_MINUTE`, `AI_MAX_CALLS`, `AI_MAX_CONCURRENT` | AI Colors limits | 5, 50, 2 |
| `ALLOWED_ORIGINS`, `AI_REQUIRE_ORIGIN` | Exact allowed origins; require an Origin | portfolio + localhost:4173; Blueprint `true` |
| `MODELSCOPE_API_KEY`, `MODELSCOPE_IMAGE_MODEL`, `SCENE_PROVIDER`, `SCENE_FALLBACK`, `STYLE_REFERENCE_URLS` | Optional free Qwen painter (below) | unset |
| `PORT` / `HOST` | Render provides `PORT` | 4174 / `0.0.0.0` |

**Optional free painter.** When `MODELSCOPE_API_KEY` is set, painting first tries ModelScope API-Inference with a Qwen image model, sending only the text prompt and the public URLs of the game's own stages, never the player's photo, and falls back to OpenAI on failure. It is not active on the live service: registration needs a mainland China phone number and an Alibaba Cloud account with real-name verification, and its request shape still needs one live check.

## Deploy

1. Import this repository's `render.yaml` with the deploy link above and choose the Free plan. The Blueprint sets Node 22, `npm start`, the `/health` check, the models, the caps and the allowed origin `https://toooonyliu.github.io`.
2. Enter `OPENAI_API_KEY` in Render's private environment settings. Never paste a key into chat, the repository, the frontend or a screenshot.
3. Copy the service URL from Render, confirm `/health`, and set it in the frontend's `one-cut-api-base` meta tag.

Render's free service sleeps after 15 idle minutes and takes about a minute to wake; the game warms `/health` and shows progress before sending a photo.

## Privacy

There are no accounts, database or stored photos. A photo is handled in memory for one request. It is sent to OpenAI only for place recognition and AI Colors; the painter never receives it, only a text description and the game's own stages (`/api/scenes` uses the photo solely as part of its short-lived cache key). Requests use `store: false`, which does not by itself disable the provider's own abuse-monitoring retention. Only use photos you own or may share. See OpenAI's [data controls](https://developers.openai.com/api/docs/guides/your-data).

## Layout

```
server.mjs            HTTP server wiring
server/scene.js       Recognition and painting adapters, prompts, schemas
server/scene-http.js  Photo-stage routes, caps, cache, jobs
server/jobs.js        In-memory job store
server/avatar.js      AI Colors adapter
server/http.js        AI Colors route, CORS, body limits, /health
server/image.js       Image validation (format, size, dimensions)
assets/style/         The game's own stages, sent as style references
scripts/              Billable measurement scripts
tests/                node:test suites with mocked providers
render.yaml           Render Blueprint
```
