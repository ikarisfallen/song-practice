// Cloudflare Worker — vision proxy for the Test Me feature.
//
// The PWA POSTs a photo + chord-progression context here; this
// Worker forwards the request to Anthropic's vision API (using the
// API key stored as a Cloudflare Secret), and returns the parsed
// notes JSON back to the browser. The browser never sees the API
// key — it lives only inside Cloudflare's environment.
//
// Setup:
//   1. cd worker
//   2. npm install -g wrangler
//   3. wrangler login
//   4. wrangler secret put ANTHROPIC_API_KEY        (paste your key)
//   5. wrangler deploy
//   6. Note the *.workers.dev URL it prints — copy it into
//      app.js: `const TEST_ME_API_URL = '<your-worker-url>';`
//   7. Add your GitHub Pages origin to ALLOWED_ORIGINS below.
//
// Cost: each request burns roughly 1500 input tokens (image) +
// ~1000 output tokens (parsed notes JSON) on Claude 3.5 Sonnet,
// which works out to ~$0.02 per photo at current pricing. The
// free tier on Cloudflare Workers covers 100K requests/day, so
// the only spend is the Anthropic API itself.

// CORS: list every origin you want to accept POSTs from. Includes
// localhost ports for dev. Update the GitHub Pages URL to match
// your username + repo. Requests from other origins get rejected
// with no Access-Control-Allow-Origin header (the browser then
// blocks the response).
const ALLOWED_ORIGINS = [
  // Production: the GitHub Pages site that serves the PWA.
  'https://ikarisfallen.github.io',
  // Localhost ports for development.
  'http://localhost:8000',
  'http://127.0.0.1:8000',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  'http://localhost:8787',         // wrangler dev default
];

// Pick the cheapest model that still reads handwritten music
// reliably. Sonnet is the sweet spot today; Haiku is cheaper but
// drops accidentals on handwriting. Switch by editing this string —
// no other code changes needed.
const MODEL = 'claude-3-5-sonnet-20241022';

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : '';

    // CORS preflight: browsers fire OPTIONS before the real POST
    // when the request includes a Content-Type header that's not
    // form-encoded.
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(allowedOrigin),
      });
    }
    if (request.method !== 'POST') {
      return jsonResponse({ error: 'Method not allowed' }, 405, allowedOrigin);
    }

    // Parse the request body. Reject early on bad input.
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return jsonResponse({ error: 'Invalid JSON body' }, 400, allowedOrigin);
    }
    const { title, chordProgression, beatsPerBar, image } = body || {};
    if (!image || !Array.isArray(chordProgression)) {
      return jsonResponse(
        { error: 'Body must include `image` (data URL) and `chordProgression` (array)' },
        400, allowedOrigin
      );
    }
    if (!env.ANTHROPIC_API_KEY) {
      return jsonResponse(
        { error: 'Server misconfigured: ANTHROPIC_API_KEY secret not set.' },
        500, allowedOrigin
      );
    }

    // Pull the media type + base64 payload out of the data URL.
    // Anthropic accepts image/jpeg, image/png, image/gif, image/webp.
    const m = /^data:(image\/(?:jpeg|png|gif|webp));base64,(.+)$/.exec(image);
    if (!m) {
      return jsonResponse(
        { error: 'image must be a data URL of type image/jpeg|png|gif|webp' },
        400, allowedOrigin
      );
    }
    const mediaType = m[1];
    const base64    = m[2];

    // Build a chord list that's easy for Claude to scan against the
    // bars in the photo. Includes 0-indexed bar numbers so the model
    // returns indexes that match what the client uses internally.
    const chordListLines = chordProgression.map((chords, i) => {
      const chordsArr = Array.isArray(chords) ? chords : [];
      const text = chordsArr.length ? chordsArr.join(' / ') : '(continues prev)';
      return `  Bar ${i}: ${text}`;
    }).join('\n');

    const ts = Number.isFinite(beatsPerBar) ? beatsPerBar : 4;

    const systemPrompt = [
      'You are a music transcription helper for a jazz practice app.',
      'The user prints a worksheet with chord changes above empty staves,',
      'writes notes by hand on the staves, then photographs the page.',
      'Your job is to identify each handwritten note and report its bar',
      'index, beat, pitch, and duration.',
      '',
      'Guidelines:',
      '- The staves are bass clef. Read pitches AS YOU SEE THEM on the',
      '  staff — IGNORE the 8vb sign if present. Middle C = C4.',
      '- Pitch format: letter + optional accidental + octave (no spaces).',
      '  Use # for sharps and b for flats. Examples: "F3", "Bb2", "C#4".',
      '- Bars are 0-indexed in your output; the chord-progression list',
      '  below is also 0-indexed. Match handwritten notes to bars by',
      '  the printed chord symbol above each bar.',
      '- Beats are 0-indexed within each bar. Estimate from horizontal',
      '  position: bar split into the time signature\'s beat count.',
      '- Duration tokens: "w", "h", "q", "8". Default to "q" when',
      '  unsure — getting the pitch right matters more than duration.',
      '- Skip bars with no handwritten notes (don\'t include empty entries).',
      '- The printed clef, time signature, bar lines, and chord symbols',
      '  are NOT handwritten — ignore them.',
      '- Be conservative: it is better to skip an ambiguous mark than to',
      '  report a wrong pitch. The user can re-photograph if too few',
      '  notes come back.',
    ].join('\n');

    const userText = [
      `Song: ${title || '(untitled)'}`,
      `Time signature: ${ts}/4`,
      'Chord progression by bar (0-indexed):',
      chordListLines,
      '',
      'Identify every handwritten note on the staves and call the',
      'report_notes tool with the result.',
    ].join('\n');

    // Tool-use forces structured JSON output. Without this, Claude
    // sometimes returns prose around the JSON, which we'd have to
    // post-process. The tool call's `input` IS the structured data.
    const tools = [{
      name: 'report_notes',
      description: 'Report all handwritten notes detected on the worksheet.',
      input_schema: {
        type: 'object',
        properties: {
          bars: {
            type: 'array',
            description: 'One entry per bar that contains at least one handwritten note.',
            items: {
              type: 'object',
              properties: {
                barIdx: {
                  type: 'integer',
                  description: '0-indexed bar number, matching the chord-progression list.',
                },
                notes: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      beat: {
                        type: 'integer',
                        description: '0-indexed beat within the bar (0 to beatsPerBar-1).',
                      },
                      pitch: {
                        type: 'string',
                        description: 'Letter + optional #/b + octave, e.g. "F3", "Bb2", "C#4". Bass clef as written, ignore 8vb.',
                      },
                      duration: {
                        type: 'string',
                        enum: ['w', 'h', 'q', '8'],
                        description: 'Note duration token. Default "q" if unsure.',
                      },
                    },
                    required: ['beat', 'pitch'],
                  },
                },
              },
              required: ['barIdx', 'notes'],
            },
          },
        },
        required: ['bars'],
      },
    }];

    // Call Anthropic. We use `tool_choice: { type: 'tool', name: ... }`
    // so the response is guaranteed to be a tool call (not free text)
    // and matches the schema above.
    let claudeResponse;
    try {
      claudeResponse = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 4096,
          system: systemPrompt,
          tools,
          tool_choice: { type: 'tool', name: 'report_notes' },
          messages: [{
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: mediaType, data: base64 },
              },
              { type: 'text', text: userText },
            ],
          }],
        }),
      });
    } catch (err) {
      return jsonResponse(
        { error: 'Network error reaching Anthropic: ' + String(err) },
        502, allowedOrigin
      );
    }

    if (!claudeResponse.ok) {
      // Pass through the upstream status code so the client can
      // distinguish 401 (bad key) from 429 (rate limit) from 500.
      let detail = '';
      try { detail = await claudeResponse.text(); } catch (e) { /* ignore */ }
      return jsonResponse(
        { error: `Anthropic ${claudeResponse.status}`, detail },
        claudeResponse.status, allowedOrigin
      );
    }

    const claudeJson = await claudeResponse.json();
    // Find the report_notes tool_use block. Claude's content is an
    // array of blocks (text, tool_use, etc.); we only care about the
    // tool call.
    const toolUse = (claudeJson.content || []).find(
      (c) => c && c.type === 'tool_use' && c.name === 'report_notes'
    );
    if (!toolUse || !toolUse.input || !Array.isArray(toolUse.input.bars)) {
      return jsonResponse(
        { error: 'Claude did not return a report_notes tool call.', raw: claudeJson },
        502, allowedOrigin
      );
    }

    // The tool input IS the response shape the PWA expects.
    return jsonResponse(toolUse.input, 200, allowedOrigin);
  },
};

function corsHeaders(origin) {
  const headers = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
  if (origin) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

function jsonResponse(obj, status, origin) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(origin),
    },
  });
}
