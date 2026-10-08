# One Cut Atlas avatar API

This folder is the complete, dependency-free Node backend intended for [OneCutAtlas_Backend](https://github.com/Toooonyliu/OneCutAtlas_Backend). It is prepared locally; no cloud service or API credentials have been configured yet. Copy the **contents** of this folder to that repository's root when publishing.

## What it does

`POST /api/analyze-avatar` maps an authorized photo to colors and one existing fictional fighter silhouette. This Level 1 approximation does not generate sprite sheets, reproduce a face, identify a person, or create accounts. The game can continue with locally sampled colors if analysis is unavailable.

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

`style` is `kendo`, `suit`, `cowboy`, or `traveler`. `hairStyle` is `short`, `long`, or `covered`. Failures return an HTTP error and `{"error":"..."}`. Keep the user's local configuration on failure. A missing key/model returns 503. `GET /health` reports readiness without revealing secrets.

## Local checks and configuration

Use Node 22 or newer. Run `npm test` and `npm start`. The standalone service defaults to port 4174. Node can load a local environment file with `node --env-file=.env server.mjs`; `.env` is ignored by Git. Do not paste a key into a prompt, commit it, or put it in the frontend.

Environment variables:

| Variable | Purpose |
| --- | --- |
| `OPENAI_API_KEY` | Private server-side OpenAI project key |
| `OPENAI_MODEL` | Explicit model with image input and Structured Outputs; there is no hidden default |
| `PORT` / `HOST` | Render provides `PORT`; the service binds `0.0.0.0` by default |
| `ALLOWED_ORIGINS` | Comma-separated exact origins, defaulting to the portfolio and localhost:4173 |
| `AI_PER_MINUTE` | Per-IP request limit, default 5 per minute |
| `AI_MAX_CALLS` | Total analysis attempts per server process, default 50; resets on restart |

The limits are an initial demo budget guard, not durable per-user quotas or authentication. CORS permits the portfolio browser origin but does not prevent non-browser clients. If publicly promoting the service, add durable rate limiting and a spend limit in the OpenAI project.

## Render setup when credentials are ready

1. Publish these files to the backend repository.
2. Create a Render web service from the repository, or use its `render.yaml` Blueprint. Use Node, `npm install --omit=dev`, `npm start`, and `/health`.
3. Set `OPENAI_API_KEY` and `OPENAI_MODEL` privately in Render. Keep the allowed frontend origin `https://toooonyliu.github.io`.
4. Check `/health`, then configure the frontend with the HTTPS service URL. Test one authorized photo and also the unavailable-service fallback.

This repository has no uploaded photos, user accounts, database, or cloud history. The application handles a photo only in memory and does not log or persist the request. It sends the compressed image to OpenAI for analysis. `store:false` disables storage of the Responses API response as application state; it does not promise that provider abuse-monitoring retention is disabled. Review the provider's [data controls](https://developers.openai.com/api/docs/guides/your-data) before sharing the feature widely.

The Render scaffold follows its [Blueprint YAML reference](https://render.com/docs/blueprint-spec) and [web-service configuration](https://render.com/docs/web-services). Private environment values are entered in Render when creating the service.

The request format follows the official [image-input guide](https://developers.openai.com/api/docs/guides/images-vision?api-mode=responses), [Structured Outputs guide](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses), and [Responses migration guide](https://developers.openai.com/api/docs/guides/migrate-to-responses). The adapter validates the result again before returning it to the game.
