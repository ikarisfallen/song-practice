# Song Practice — Vision Proxy Worker

A Cloudflare Worker that holds your Anthropic API key and forwards
photo + chord-progression data from the PWA to Claude's vision API,
returning structured note JSON.

The browser never sees the API key. CORS is locked to a hand-listed
set of origins (yours plus localhost ports for dev).

## One-time setup

1. **Install Wrangler** (Cloudflare's CLI):
   ```
   npm install -g wrangler
   ```

2. **Sign in to Cloudflare** (opens a browser):
   ```
   wrangler login
   ```

3. **Add your Anthropic API key as a Secret**:
   ```
   cd worker
   wrangler secret put ANTHROPIC_API_KEY
   ```
   Paste your `sk-ant-...` key when prompted. The secret is encrypted
   in Cloudflare's environment — it does not get committed to the
   repository.

4. **Edit `index.js`** and add your GitHub Pages origin to
   `ALLOWED_ORIGINS`. Default looks like:
   ```js
   const ALLOWED_ORIGINS = [
     'https://yourname.github.io',  // ← your GitHub Pages URL
     'http://localhost:8000',
     'http://127.0.0.1:8000',
     ...
   ];
   ```
   Without this, the browser will see CORS errors and the PWA's
   `Take Photo` button will fail with `Server error: 0`.

5. **Deploy**:
   ```
   wrangler deploy
   ```
   Wrangler prints a URL like
   `https://song-practice-vision.YOURNAME.workers.dev`.

6. **Wire the URL into the PWA**: edit `app.js` and replace
   ```js
   const TEST_ME_API_URL = '/api/check-photo';
   ```
   with your worker URL:
   ```js
   const TEST_ME_API_URL = 'https://song-practice-vision.YOURNAME.workers.dev';
   ```
   Bump the `?v=` cache-buster on the script tag in `index.html`,
   then commit and push to GitHub. Your PWA's Test Me button now
   talks to your Worker.

## Local development

`wrangler dev` runs the Worker locally:

```
cd worker
wrangler dev
```

It binds to `http://localhost:8787` by default. Set
`TEST_ME_API_URL = 'http://localhost:8787'` in `app.js` while you
iterate, then switch back to the deployed URL for production. Make
sure your dev URL is in `ALLOWED_ORIGINS` — `wrangler dev` reads
the same `index.js` you'll deploy.

## Updating

Make changes to `index.js`, then:

```
wrangler deploy
```

Cloudflare picks up the new code immediately. No PWA changes
needed unless you change the request/response shape.

## Cost

- **Cloudflare Workers**: 100,000 requests/day on the free plan.
  Plenty for personal use.
- **Anthropic API**: ~$0.02 per photo on Claude 3.5 Sonnet (~1500
  input tokens for the image + ~1000 output tokens for the JSON).
  Set up billing limits in your Anthropic Console if you want a
  hard cap.

## Switching models

The current model is set in `index.js`:

```js
const MODEL = 'claude-3-5-sonnet-20241022';
```

For cheaper-but-less-accurate runs, swap to Haiku
(`claude-3-5-haiku-20241022`). For higher accuracy when newer
models ship, update the constant.

## Request/response contract

The PWA sends:

```json
POST /
Content-Type: application/json

{
  "title": "A Foggy Day",
  "chordProgression": [
    ["FMaj7"], ["D7b9"], ["Gm7"], ["C7"],
    ["F6"],    ["Ab7"],  ["G7"],  ["C7"],
    ...
  ],
  "beatsPerBar": 4,
  "image": "data:image/jpeg;base64,..."
}
```

The Worker calls Claude's vision API with a tool-use schema and
returns:

```json
{
  "bars": [
    {
      "barIdx": 0,
      "notes": [
        { "beat": 0, "pitch": "F3", "duration": "q" },
        { "beat": 1, "pitch": "A3", "duration": "q" },
        { "beat": 2, "pitch": "C4", "duration": "q" },
        { "beat": 3, "pitch": "E4", "duration": "q" }
      ]
    },
    ...
  ]
}
```

Pitches are bass-clef "as written" (the client subtracts 12
internally to get the sounding pitch, since the staff is rendered
8vb).

## Troubleshooting

**`Server error: 0` or `NetworkError`** — usually CORS. Add your
origin to `ALLOWED_ORIGINS` and redeploy.

**`Anthropic 401`** — your API key isn't set or is wrong. Re-run
`wrangler secret put ANTHROPIC_API_KEY`.

**`Anthropic 413` (payload too large)** — the photo is bigger
than Anthropic's per-image limit (~5 MB). Take a smaller photo,
or add client-side downscaling before upload.

**Claude returns notes that aren't there, or misses obvious ones** —
prompt-engineering. Edit the system prompt at the top of
`index.js`. The current prompt is conservative; loosening it
("be less hesitant to include uncertain notes") trades misses for
false positives.
