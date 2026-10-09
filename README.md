# One Cut Atlas avatar API

This is the dependency-free Node backend published in [OneCutAtlas_Backend](https://github.com/Toooonyliu/OneCutAtlas_Backend). It is deployed as a Render Free web service with OpenAI GPT-6 Luna for bounded photo-to-avatar appearance analysis.

**Live backend:** [https://one-cut-atlas-api.onrender.com](https://one-cut-atlas-api.onrender.com). Use this origin in the assignment's backend URL field. `GET /` describes the service and `GET /health` reports configuration presence. On October 8, 2026, a real compressed fictional-game-image request returned HTTP 200 with `source: ai`, palette colors and an outfit style. The project's private key is configured only in Render's environment settings; no key belongs in this repository or the frontend.

[Deploy the backend to Render](https://render.com/deploy?repo=https%3A%2F%2Fgithub.com%2FToooonyliu%2FOneCutAtlas_Backend)

## What it does

`POST /api/analyze-avatar` uses the OpenAI Responses API (`POST https://api.openai.com/v1/responses`) to analyze an authorized photo and return colors plus one existing fictional fighter silhouette. The game recolors an existing sprite; this Level 1 approximation does not generate sprite sheets, reproduce a face, identify a person, or create accounts. The game can continue with locally sampled colors if analysis is unavailable. `render.yaml` explicitly selects `gpt-6-luna`; the adapter uses its documented `reasoning.effort: none` for this small extraction task. Other compatible models can be configured explicitly with `OPENAI_MODEL`. Model availability must be verified in the actual API project.

Request (`Content-Type: application/json`):

```json
{"image":"data:image/jpeg;base64,..."}
```

The image must be a JPEG, PNG, or WebP data URL, no larger than 2 MB after decoding. Compress it in the browser first. Remote URLs are rejected. Response:

```json
{
  "avatar": {
    "palette": {"hair":"#24212b","skin":"#d5a380","outfit":"#596c76","accent":"#c89d54"},
    "style":"traveler",
    "hairStyle":"short",
    "summary":"An approximate traveler with a dark jacket and warm accessory colors."
  },
  "source":"ai"
}
```

`style` is `kendo`, `suit`, `cowboy`, or `traveler`. `hairStyle` is `short`, `long`, or `covered`; it is returned as metadata but is not rendered by the current game client. Failures return an HTTP error and `{"error":"..."}`. Keep the user's local configuration on failure. A missing key/model returns 503. `GET /health` reports configuration presence without revealing secrets: `avatarAnalysisConfigured`, `placeRecognitionConfigured` and `arenaPaintingConfigured`. A `true` value is not proof of valid billing, provider access or model compatibility.

## Photo arenas

Two further routes turn an authorized travel photo into a duel stage. Both reuse the same key, origin rules and body limits as the avatar route.

`POST /api/recognize-place` with `{"image":"data:image/jpeg;base64,...","zone":"east-asia"}` (zone optional, a hint from photo GPS or the player) asks the vision model to classify only the environment: landmark or place type, city and country when distinctive, interior or exterior, lighting, a short `scenePrompt` built from what is visible, and a travel `zone` from the game's eleven. People in the photo are ignored and never identified; text and logos are treated as untrusted image content. Response:

```json
{"place":{"recognized":true,"name":"Forbidden City","city":"Beijing","country":"China","zone":"east-asia","setting":"exterior","confidence":0.96,"elements":["red columns"],"lighting":"day","environment":"traditional_street","opponentStyle":"kendo","palette":{"sky":"#e8e9e7","accent":"#a85d32","ambient":"#555d5b"},"scenePrompt":"Empty palace courtyard ...","summary":"Forbidden City courtyard, Beijing."},"source":"ai"}
```

Recognition is a suggestion. In testing it ignored people reliably but matched a Guatemalan volcano to Mount Fuji, so the game always shows the result and lets the player change the zone before anything is painted.

`POST /api/scenes` with `{"image","zone","scenePrompt","setting","lighting","placeName"}` paints one 1536×864 backdrop with the image model through `POST /v1/images/edits`, attaching the three shipped stages in `assets/style/` as style references. The prompt is the exact brief used for the shipped zone stages plus the validated scene slot, the player-confirmed region and the ground line at 78 percent of the height. The route answers `202 {"jobId"}` at once; `GET /api/scenes/{jobId}` returns `{"status":"queued"|"painting"|"done"|"failed"}` with `backdrop` (a WebP data URL) on success. Jobs live in memory for ten minutes; a restart forgets them and the client is told to paint again. The browser downsamples the result to the 480×270 grid with a 32-color palette, so `SCENE_QUALITY=low` is the default: in a side-by-side test it was indistinguishable from medium after pixelization at roughly a third of the cost.

Measured on October 8, 2026 with `gpt-image-2`: about 16 s and $0.017 per low-quality painting including the reference images, 27 s and $0.046 at medium, plus a recognition call of roughly 1,100 tokens. `scripts/offline-style-test.mjs` reproduces the comparison; it is billable and reads the key from an env file that it never prints.

Painting guards: `SCENE_ENABLED` switches the route off, `SCENE_PER_HOUR` limits paintings per address, `SCENE_MAX_PER_DAY` caps the whole service, `SCENE_MAX_CONCURRENT` bounds in-flight provider calls, and identical photo-plus-prompt requests are served from a ten-minute cache instead of billed again. These counters reset on restart; the prepaid provider balance and the project's usage limits are the real ceiling.

## Local checks and configuration

Use Node 22 or newer. Run `npm test` and `npm start`. The standalone service defaults to port 4174. Node can load a local environment file with `node --env-file=.env server.mjs`; `.env` is ignored by Git. Do not paste a key into a prompt, commit it, or put it in the frontend.

Environment variables:

| Variable | Purpose |
| --- | --- |
| `OPENAI_API_KEY` | Private server-side OpenAI project key |
| `OPENAI_MODEL` | Explicit model with image input and Structured Outputs; Blueprint chooses `gpt-6-luna`, no hidden adapter default |
| `OPENAI_IMAGE_MODEL` | Image model for arena painting; defaults to `gpt-image-2` when unset, an empty value disables painting |
| `SCENE_QUALITY` | `low` (default), `medium` or `high` for painted arenas |
| `SCENE_ENABLED` | `false` switches arena painting off while recognition keeps working |
| `SCENE_PER_HOUR` / `SCENE_MAX_PER_DAY` / `SCENE_MAX_CONCURRENT` | Painting caps: per address per hour (3), per service per day (40), in flight (2) |
| `RECOGNIZE_PER_MINUTE` | Place recognition requests per address per minute, default 5 |
| `PORT` / `HOST` | Render provides `PORT`; the service binds `0.0.0.0` by default |
| `ALLOWED_ORIGINS` | Comma-separated exact origins, defaulting to the portfolio and localhost:4173 |
| `AI_PER_MINUTE` | Per-IP request limit, default 5 per minute |
| `AI_MAX_CALLS` | Total analysis attempts per server process, default 50; resets on restart |
| `AI_MAX_CONCURRENT` | Maximum simultaneous provider calls, default 2 |
| `AI_REQUIRE_ORIGIN` | Require an allowed browser Origin on photo requests; Blueprint sets true, local default false |

The limits are initial demo guards, not durable per-user quotas or authentication. Call counters are reserved before invoking the provider and in-flight calls are bounded. They reset on process restart, including free-service sleep. An Origin requirement does not prevent a non-browser client from spoofing that header. The socket address limit is deliberately conservative behind a proxy; unverified forwarding headers are not trusted. Before broad promotion, add real abuse protection and durable quotas. Configure the API project's usage controls and billing alerts; do not assume an alert is a hard spending cap.

## Deploy and connect

1. Sign in to Render, or connect its Codex integration. Use the deployment link above to import the published repository's `render.yaml`. Choose the Free compute service; no paid hosting upgrade is needed for the classroom demo.
2. The Blueprint sets Node 22, `npm install --omit=dev`, `npm start`, `/health`, `OPENAI_MODEL=gpt-6-luna`, and the exact allowed origin `https://toooonyliu.github.io`.
3. Set `OPENAI_API_KEY` in Render's private environment-variable field. Use a scoped OpenAI project key with the necessary model access and API billing. Never paste the key into chat, the repo, a frontend config or a screenshot. The deployment flow prompts for this unsynced secret.
4. Deploy, then copy the actual service HTTPS URL from Render. Do not guess it from the service name. Verify `/health` from the frontend origin and check `avatarAnalysisConfigured`; that field only confirms configuration presence.
5. Set the verified service origin in the frontend's `one-cut-api-base` meta tag and publish the frontend. The game warms `/health` before sending a compressed photo, shows wake-up/analysis status and does not automatically retry a potentially billable POST. Local colors remain available on failure.
6. Complete one real authorized-image analysis and confirm the returned colors/outfit visibly update the fighter. Save, play, return and reload to verify persistence. Also test unavailable-service fallback. The automated provider tests are mocked and do not prove live billing or model access.

Render's Free service sleeps after 15 idle minutes; waking takes about a minute. The startup wait is separate from the bounded provider request. Free hosting is suitable for this demonstration, not a production availability promise. GPT API calls are usage-billed; consult the current model pricing and account limits before enabling a public endpoint.

This repository has no uploaded photos, user accounts, database, or cloud history. The application handles a photo only in memory and does not log or persist the request. It sends the compressed image to OpenAI for analysis. `store:false` disables storage of the Responses API response as application state; it does not promise that provider abuse-monitoring retention is disabled. Review the provider's [data controls](https://developers.openai.com/api/docs/guides/your-data) before sharing the feature widely.

The Render scaffold follows its [Blueprint YAML reference](https://render.com/docs/blueprint-spec) and [web-service configuration](https://render.com/docs/web-services). Private environment values are entered in Render when creating the service.

The request format follows the official [image-input guide](https://developers.openai.com/api/docs/guides/images-vision?api-mode=responses), [Structured Outputs guide](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses), and [Responses migration guide](https://developers.openai.com/api/docs/guides/migrate-to-responses). The adapter validates the result again before returning it to the game.

Model choice follows the current [GPT-6 Luna model documentation](https://developers.openai.com/api/docs/models/gpt-6-luna): image input and Structured Outputs, with a focused extraction workload. The Render configuration follows its [free-service limitations](https://render.com/docs/free) and [Deploy to Render guide](https://render.com/docs/deploy-to-render). Live provider access was verified on October 8; availability and account credits can change, so the game retains its local fallback.
