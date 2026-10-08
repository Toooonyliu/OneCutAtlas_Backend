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

`style` is `kendo`, `suit`, `cowboy`, or `traveler`. `hairStyle` is `short`, `long`, or `covered`; it is returned as metadata but is not rendered by the current game client. Failures return an HTTP error and `{"error":"..."}`. Keep the user's local configuration on failure. A missing key/model returns 503. `GET /health` reports configuration presence without revealing secrets; `avatarAnalysisConfigured: true` is not proof of valid billing, provider access or model compatibility.

## Local checks and configuration

Use Node 22 or newer. Run `npm test` and `npm start`. The standalone service defaults to port 4174. Node can load a local environment file with `node --env-file=.env server.mjs`; `.env` is ignored by Git. Do not paste a key into a prompt, commit it, or put it in the frontend.

Environment variables:

| Variable | Purpose |
| --- | --- |
| `OPENAI_API_KEY` | Private server-side OpenAI project key |
| `OPENAI_MODEL` | Explicit model with image input and Structured Outputs; Blueprint chooses `gpt-6-luna`, no hidden adapter default |
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
