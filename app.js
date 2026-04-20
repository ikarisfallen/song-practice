// ===== iReal Pro unscramble =====
// Algorithm from https://github.com/pianosnake/ireal-reader (MIT)
function unscrambleIReal(s) {
  let r = '', p;
  while (s.length > 50) {
    p = s.substring(0, 50);
    s = s.substring(50);
    if (s.length < 2) r += p;
    else r += obfusc50(p);
  }
  return r + s;
}
function obfusc50(s) {
  const a = s.split('');
  for (let i = 0; i < 5; i++) { a[49 - i] = s[i]; a[i] = s[49 - i]; }
  for (let i = 10; i < 24; i++) { a[49 - i] = s[i]; a[i] = s[49 - i]; }
  return a.join('');
}

// ===== Song parser =====
// Parses an iRealPro song URL (irealb://...) into structured data.
function parseIRealSong(url) {
  const decoded = decodeURIComponent(url.replace(/^irealb:\/\//, ''));
  const parts = decoded.split('=');
  // title=composer==style=key=??=body=style=bpm=repeats
  const title = parts[0];
  const composer = parts[1];
  const style = parts[3];
  const key = parts[4];
  const bodyRaw = parts[6] || '';
  const styleFull = parts[7];
  const bpm = parseInt(parts[8] || '120', 10) || 120;
  const repeats = parseInt(parts[9] || '1', 10) || 1;

  // Strip prefix "1r34LbKcu7" (v2 obfuscator marker)
  let body = bodyRaw;
  if (body.startsWith('1r34LbKcu7')) body = body.substring(10);
  body = unscrambleIReal(body);

  return { title, composer, style, key, bpm, repeats, body, styleFull };
}

// ===== Token parser =====
// Produces a flat sequence of "cells" (4-beat slots) for display AND playback.
// Also tracks navigation markers (segno/coda/fine/DC/DS) for expansion.
function tokenize(body) {
  // Strip iRealPro alternate-chord groups (chords in parentheses). They're
  // meant to be shown as small substitute chords above the main one — for
  // this app we only use the main chords.
  body = body.replace(/\([^()]*\)/g, '');
  // returns array of tokens
  const tokens = [];
  let i = 0;
  const rules = [
    [/^\{/, 'repeatStart'],
    [/^\}/, 'repeatEnd'],
    [/^\[/, 'doubleStart'],
    [/^\]/, 'doubleEnd'],
    [/^\|/, 'bar'],
    [/^LZ/, 'bar'],
    [/^Z/, 'finalBar'],
    [/^\*([A-Za-z])/, 'section'], // *A, *B
    [/^T(\d\d)/, 'timesig'],
    [/^N(\d)/, 'ending'],
    [/^S/, 'segno'],
    [/^Q/, 'coda'],
    [/^U/, 'endMarker'],
    [/^<(.*?)>/, 'comment'],
    [/^XyQ/, 'space'],
    [/^Kcl/, 'kcl'], // repeat measure, new measure
    [/^x/, 'xrepeat'], // repeat prev measure in-place
    [/^r/, 'rrepeat'], // repeat prev 2 measures
    [/^Y+/, 'spacer'],
    [/^n/, 'nc'], // No Chord
    [/^p/, 'pause'],
    [/^,/, 'comma'],
    // chord: root [quality] [extensions] [alterations] [sus] [/bass]
    [/^([A-GW])((?:[#b])?(?:\^|\-|h|o|\+|sus)?(?:\d+(?:sus)?)?(?:(?:[#b])\d+)*(?:sus\d?)?)(\/([A-G][#b]?))?/, 'chord'],
  ];
  let s = body;
  let guard = 0;
  while (s.length && guard++ < 20000) {
    let matched = false;
    for (const [re, type] of rules) {
      const m = s.match(re);
      if (m) {
        tokens.push({ type, text: m[0], m });
        s = s.substring(m[0].length);
        matched = true;
        break;
      }
    }
    if (!matched) {
      // skip unknown char (usually whitespace)
      s = s.substring(1);
    }
  }
  return tokens;
}

// Build "bars" for display. Each bar: { chords:[], leftBar, rightBar, section, ending, markers:[] }
function buildBars(tokens) {
  const bars = [];
  let cur = null;
  let pendingLeft = null;
  let pendingSection = null;
  let pendingEnding = null;
  let pendingMarkers = [];
  let pendingTimesig = null;
  let lastChord = null;
  let timesig = null;

  function startBar() {
    if (cur) bars.push(cur);
    cur = { chords: [], leftBar: pendingLeft || 'single', rightBar: 'single',
            section: pendingSection, ending: pendingEnding,
            markers: pendingMarkers, timesig: pendingTimesig };
    pendingLeft = null; pendingSection = null; pendingEnding = null; pendingMarkers = []; pendingTimesig = null;
  }
  function endBar(type) {
    if (cur) { cur.rightBar = type; bars.push(cur); cur = null; }
    // A strong closing barline (repeat/double/final) can arrive after Kcl
    // already pushed the last bar — in that case stamp it onto that bar.
    else if (bars.length > 0 && type !== 'single' && bars[bars.length - 1].rightBar === 'single') {
      bars[bars.length - 1].rightBar = type;
    }
  }

  for (const t of tokens) {
    switch (t.type) {
      case 'timesig':
        timesig = t.m[1];
        if (!cur) pendingTimesig = timesig; else cur.timesig = timesig;
        break;
      case 'repeatStart':
        endBar('single'); pendingLeft = 'repeatStart';
        break;
      case 'repeatEnd':
        endBar('repeatEnd');
        break;
      case 'doubleStart':
        endBar('single'); pendingLeft = 'double';
        break;
      case 'doubleEnd':
        endBar('double');
        break;
      case 'bar':
        endBar('single');
        break;
      case 'finalBar':
        endBar('final');
        break;
      case 'section':
        if (!cur) pendingSection = t.m[1]; else cur.section = t.m[1];
        break;
      case 'ending':
        if (!cur) pendingEnding = t.m[1]; else cur.ending = t.m[1];
        break;
      case 'segno':
      case 'coda':
      case 'endMarker':
      case 'comment': {
        // Attach the marker to the current bar if one is open; otherwise
        // stamp it onto the last completed bar (avoids inventing an empty
        // placeholder bar just to hold a stray <Fine>/<D.C.>/coda marker
        // between a Kcl/barline and a trailing `Z`).
        const marker = t.type === 'comment'
          ? { type: 'comment', text: t.m[1] }
          : { type: t.type };
        if (cur) {
          cur.markers.push(marker);
        } else if (bars.length > 0) {
          bars[bars.length - 1].markers.push(marker);
        } else {
          startBar();
          cur.markers.push(marker);
        }
        break;
      }
      case 'space':
        // empty beat — placeholder
        break;
      case 'spacer':
        break;
      case 'nc':
        if (!cur) startBar();
        cur.chords.push({ nc: true });
        break;
      case 'pause':
        if (!cur) startBar();
        cur.chords.push({ slash: true });
        break;
      case 'xrepeat':
        // 'x' repeats previous measure inside CURRENT measure
        if (!cur) startBar();
        cur.repeatPrev = 1;
        break;
      case 'kcl':
        // Kcl = close current bar, then emit a new bar that's a repeat of it
        endBar('single');
        startBar();
        cur.repeatPrev = 1;
        endBar('single');
        break;
      case 'rrepeat':
        // 'r' = repeat previous two measures. Close current, emit two repeat bars.
        endBar('single');
        startBar(); cur.repeatPrev = 2; endBar('single');
        startBar(); cur.repeatPrev = 2; endBar('single');
        break;
      case 'chord': {
        if (!cur) startBar();
        let root = t.m[1], rest = t.m[2] || '', bass = t.m[4] || null;
        if (root === 'W' && lastChord) {
          root = lastChord.root; rest = lastChord.rest;
        } else {
          lastChord = { root, rest };
        }
        cur.chords.push({ root, rest, bass });
        break;
      }
      case 'comma':
        break;
      default: break;
    }
  }
  if (cur) bars.push(cur);
  // Filter zero-chord bars that were created only by marker-holding (keep if holding markers)
  return { bars, timesig: timesig || '44' };
}

// Expand repeats, DC/DS, codas into a flat playback sequence of bars
function expandForPlayback(bars) {
  // Find positions
  let startRepeat = 0;
  let coda = -1, segno = -1, fine = -1;
  bars.forEach((b, i) => {
    if (b.markers.some(m => m.type === 'coda')) coda = i;
    if (b.markers.some(m => m.type === 'segno')) segno = i;
    if (b.markers.some(m => m.type === 'comment' && /fine/i.test(m.text))) fine = i;
  });

  const out = [];
  let dcAlCoda = false, dsAlCoda = false, dcAlFine = false;
  let repeatStart = 0;

  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (b.leftBar === 'repeatStart') repeatStart = out.length;

    // Handle comments to set DC/DS flags for after this bar
    b.markers.forEach(m => {
      if (m.type !== 'comment') return;
      const t = m.text.toLowerCase();
      if (t.includes('d.c. al coda') || t.includes('dc al coda')) dcAlCoda = true;
      if (t.includes('d.s. al coda') || t.includes('ds al coda')) dsAlCoda = true;
      if (t.includes('d.c. al fine') || t.includes('dc al fine')) dcAlFine = true;
    });

    out.push({ bar: b, idx: i });

    if (b.rightBar === 'repeatEnd') {
      // Simple repeat once
      const startBar = bars.findIndex((x, idx) => idx <= i && x.leftBar === 'repeatStart');
      const s = startBar < 0 ? 0 : startBar;
      for (let j = s; j <= i; j++) out.push({ bar: bars[j], idx: j });
    }

    // After bar, check DC/DS/Fine
    if (dcAlFine && fine >= 0) {
      for (let j = 0; j <= fine; j++) out.push({ bar: bars[j], idx: j });
      dcAlFine = false;
      break;
    }
    if (dcAlCoda && coda >= 0) {
      for (let j = 0; j < coda; j++) out.push({ bar: bars[j], idx: j });
      // then jump to coda and continue
      for (let j = coda; j < bars.length; j++) out.push({ bar: bars[j], idx: j });
      dcAlCoda = false;
      break;
    }
    if (dsAlCoda && segno >= 0 && coda >= 0) {
      for (let j = segno; j < coda; j++) out.push({ bar: bars[j], idx: j });
      for (let j = coda; j < bars.length; j++) out.push({ bar: bars[j], idx: j });
      dsAlCoda = false;
      break;
    }
  }
  return out;
}

// ===== Exercise generator (Quarter Notes, ported from ExerciseBuilder.qml) =====
// Cello range for the line
const EX_LOW = 29;   // F1
const EX_HIGH = 53;  // F3

// Scale definitions: s = semitone offset, t = TPC offset from root
const SCALE_DORIAN =           [{s:0,t:0},{s:2,t:2},{s:3,t:-3},{s:5,t:-1},{s:7,t:1},{s:9,t:3},{s:10,t:-2}];
const SCALE_IONIAN =           [{s:0,t:0},{s:2,t:2},{s:4,t:4},{s:5,t:-1},{s:7,t:1},{s:9,t:3},{s:11,t:5}];
const SCALE_MIXOLYDIAN =       [{s:0,t:0},{s:2,t:2},{s:4,t:4},{s:5,t:-1},{s:7,t:1},{s:9,t:3},{s:10,t:-2}];
const SCALE_LOCRIAN =          [{s:0,t:0},{s:1,t:-5},{s:3,t:-3},{s:5,t:-1},{s:6,t:-6},{s:8,t:-4},{s:10,t:-2}];
const SCALE_DIMINISHED =       [{s:0,t:0},{s:2,t:2},{s:3,t:-3},{s:5,t:-1},{s:6,t:-6},{s:8,t:-4},{s:9,t:3},{s:11,t:5}];
const SCALE_MELODIC_MINOR =    [{s:0,t:0},{s:2,t:2},{s:3,t:-3},{s:5,t:-1},{s:7,t:1},{s:9,t:3},{s:11,t:5}];
const SCALE_PHRYGIAN_DOMINANT =[{s:0,t:0},{s:1,t:-5},{s:4,t:4},{s:5,t:-1},{s:7,t:1},{s:8,t:-4},{s:10,t:-2}];

function exParseRoot(chordText) {
  const letterToSemi = { C:0, D:2, E:4, F:5, G:7, A:9, B:11 };
  const letterToTpc  = { C:14, D:16, E:18, F:13, G:15, A:17, B:19 };
  const m = chordText.match(/^([A-Ga-g])([#♯])?([b♭])?/);
  if (!m) return null;
  const letter = m[1].toUpperCase();
  const sharp = !!m[2];
  const flat = !!m[3];
  let semi = letterToSemi[letter];
  if (semi === undefined) return null;
  let tpc = letterToTpc[letter];
  if (sharp) { semi++; tpc += 7; }
  if (flat)  { semi--; tpc -= 7; }
  semi = ((semi % 12) + 12) % 12;
  return { pitchClass: semi, tpc };
}

// Classify chord quality for pattern detection (ii-V-I etc.)
function getChordType(chordText) {
  const q = chordText.replace(/^[A-Ga-g][#♯b♭]?/, '');
  if (/[øØ]/.test(q)) return 'halfdim';
  if (/m7[b♭]5|min7[b♭]5|mi7[b♭]5/i.test(q)) return 'halfdim';
  if (/^h/i.test(q)) return 'halfdim'; // iRealPro half-dim
  if (/dim|°/i.test(q)) return 'other';
  if (/^o/i.test(q)) return 'other';
  if (/^(m(?!a)|min|mi|\-|−)/i.test(q) && /maj|ma/i.test(q)) return 'other';
  if (/maj|ma/i.test(q)) return 'major';
  if (/^M([0-9]|$)/.test(q)) return 'major';
  if (/[Δ∆\^]/.test(q)) return 'major';
  if (/^m|^-|^−/i.test(q)) return 'minor';
  if (/^6/.test(q)) return 'major';
  if (/^[0-9]/.test(q)) return 'dominant';
  if (/sus/i.test(q)) return 'dominant';
  if (/aug|\+/i.test(q)) return 'other';
  return 'major';
}

// Collapse the four "awkward" enharmonic spellings — C♭, F♭, E♯, B♯ — to
// their natural-letter equivalents (B, E, F, C). These come up whenever a
// scale calculation lands in Gb major / D♭m / F♯ Ionian territory, and
// players generally read them faster as the natural spelling. Applied up
// front in tpcToNoteName / tpcToLetterAcc so every downstream renderer
// (scale labels, chord-tone list, VexFlow note keys) picks up the nicer
// spelling automatically.
function normalizeEnharmonic(tpc) {
  if (tpc === 7)  return 19; // Cb → B
  if (tpc === 6)  return 18; // Fb → E
  if (tpc === 25) return 13; // E# → F
  if (tpc === 26) return 14; // B# → C
  return tpc;
}

// TPC → readable note name (e.g. 11 → "E♭")
function tpcToNoteName(tpc) {
  tpc = normalizeEnharmonic(tpc);
  const letters = ['F','C','G','D','A','E','B'];
  const idx = (((tpc - 13) % 7) + 7) % 7;
  const name = letters[idx];
  const acc = (tpc - 13 - idx) / 7;
  if (acc <= -2) return name + '♭♭';
  if (acc === -1) return name + '♭';
  if (acc === 1) return name + '♯';
  if (acc >= 2) return name + '♯♯';
  return name;
}

function exGetScale(chordText) {
  const q = chordText.replace(/^[A-Ga-g][#♯b♭]?/, '');
  if (/[øØ]/.test(q)) return SCALE_LOCRIAN;
  if (/m7[b♭]5|min7[b♭]5|mi7[b♭]5/i.test(q)) return SCALE_LOCRIAN;
  if (/^h/i.test(q)) return SCALE_LOCRIAN; // iRealPro half-dim
  if (/dim|°/i.test(q)) return SCALE_DIMINISHED;
  if (/^o/i.test(q)) return SCALE_DIMINISHED; // iRealPro fully-dim
  if (/^(m(?!a)|min|mi|\-|−)/i.test(q) && /maj|ma/i.test(q)) return SCALE_MELODIC_MINOR;
  if (/maj|ma/i.test(q)) return SCALE_IONIAN;
  if (/^M([0-9]|$)/.test(q)) return SCALE_IONIAN;
  if (/[Δ∆\^]/.test(q)) return SCALE_IONIAN;
  if (/^m|^-|^−/i.test(q)) return SCALE_DORIAN;
  if (/^6/.test(q)) return SCALE_IONIAN;
  if (/^[0-9]/.test(q) && /[b♭]9/.test(q)) return SCALE_PHRYGIAN_DOMINANT;
  if (/^[0-9]/.test(q)) return SCALE_MIXOLYDIAN;
  if (/sus/i.test(q)) return SCALE_MIXOLYDIAN;
  if (/aug|\+/i.test(q)) return SCALE_IONIAN;
  return SCALE_IONIAN;
}

function buildScaleTones(rootPc, rootTpc, scale) {
  const tones = [];
  for (let oct = 1; oct <= 6; oct++) {
    const base = oct * 12;
    for (let i = 0; i < scale.length; i++) {
      const pitch = base + rootPc + scale[i].s;
      const tpc = rootTpc + scale[i].t;
      if (pitch >= EX_LOW && pitch <= EX_HIGH) tones.push({ pitch, tpc });
    }
  }
  tones.sort((a, b) => a.pitch - b.pitch);
  return tones;
}

function findClosestIndex(tones, target) {
  let best = 0, bestDiff = Math.abs(tones[0].pitch - target);
  for (let i = 1; i < tones.length; i++) {
    const d = Math.abs(tones[i].pitch - target);
    if (d < bestDiff) { bestDiff = d; best = i; }
  }
  return best;
}

// Like findContinuationIndex, but at a chord boundary prefer a move that
// isn't a "same-letter" chromatic step (F → F♯, B → B♭, etc.). Those reads
// as a single letter being sharpened/flattened, which feels awkward and
// visually confusing on the staff. If the natural continuation would be
// such a move, try the opposite direction first.
function findSmoothContinuation(tones, lastPitch, lastTpc, dir) {
  // At a chord-scale boundary, just pick the closest tone in the new
  // scale to lastPitch. `findContinuationIndex` already prefers the
  // current direction (returns the first tone strictly above lastPitch
  // when dir=+1, strictly below when dir=-1) and only falls back to
  // the opposite direction when no tone exists in the current one.
  //
  // Earlier versions tried to "skip" a same-letter chromatic step
  // (C → C#, F → F#) under the assumption it sounded awkward, but
  // across a chord change that step is just the new key's accidental,
  // and the closest tone is musically the right landing. The skip
  // was making the algorithm jump over legitimate close notes (e.g.
  // EbMaj7/G ending on C, next F#m7 landing on D# instead of C#).
  return findContinuationIndex(tones, lastPitch, dir);
}

function findContinuationIndex(tones, lastPitch, dir) {
  if (dir === 1) {
    for (let i = 0; i < tones.length; i++)
      if (tones[i].pitch > lastPitch) return { idx: i, dir };
    for (let i = tones.length - 1; i >= 0; i--)
      if (tones[i].pitch < lastPitch) return { idx: i, dir: -1 };
  } else {
    for (let i = tones.length - 1; i >= 0; i--)
      if (tones[i].pitch < lastPitch) return { idx: i, dir };
    for (let i = 0; i < tones.length; i++)
      if (tones[i].pitch > lastPitch) return { idx: i, dir: 1 };
  }
  return { idx: findClosestIndex(tones, lastPitch), dir };
}

// Internal iRealPro rest → canonical text for exGetScale/exParseRoot
function chordToCanonical(ch) {
  return ch.root + (ch.rest || '');
}

// Build a flat list of chord events from bars. Kcl/repeat-prev bars inherit
// the source bar's chords so patterns still register correctly.
function buildChordEventList(bars) {
  const out = [];
  // Walk backwards through repeat-prev bars until we find real chords. Handles
  // iRealPro's `Kcl`/`x` chains like "G7 | Kcl | x | x" where every bar after
  // the first points at a repeat-prev bar that itself has no chord list.
  const chordsForBar = (bi) => {
    let cursor = bi;
    while (cursor >= 0) {
      const b = bars[cursor];
      const cs = (b.chords || []).filter(c => !c.slash && !c.nc);
      if (cs.length) return cs;
      if (!b.repeatPrev || cursor - b.repeatPrev < 0) return [];
      cursor -= b.repeatPrev;
    }
    return [];
  };
  for (let bi = 0; bi < bars.length; bi++) {
    const bar = bars[bi];
    let chords = (bar.chords || []).filter(c => !c.slash && !c.nc);
    if (chords.length === 0 && bar.repeatPrev) {
      chords = chordsForBar(bi);
    }
    const chordsInBar = chords.length;
    chords.forEach((ch, ci) => {
      const root = exParseRoot(chordToCanonical(ch));
      if (!root) return;
      out.push({
        barIdx: bi,
        chordIdxInBar: ci,
        chordsInBar,
        chord: ch,
        root,
        type: getChordType(chordToCanonical(ch))
      });
    });
  }
  return out;
}

// Detect ii-V-I (251), ii-V (25), V-I (51) patterns with optional 6 before ii
// and 4 after I extensions. Returns [{ firstIdx, lastIdx, keyRoot, keyMode,
// keyName }] where firstIdx/lastIdx index into the flat chord event list.
function detectKeyPatterns(chordEvents) {
  const used = chordEvents.map(() => false);
  const isP4Up = (a, b) => b === (a + 5) % 12;
  const raw = [];

  function scanTriple(iType, iiType, iiiType, mode) {
    for (let i = 0; i < chordEvents.length - 2; i++) {
      if (used[i] || used[i+1] || used[i+2]) continue;
      if (chordEvents[i].type === iType &&
          chordEvents[i+1].type === iiType &&
          chordEvents[i+2].type === iiiType &&
          isP4Up(chordEvents[i].root.pitchClass, chordEvents[i+1].root.pitchClass) &&
          isP4Up(chordEvents[i+1].root.pitchClass, chordEvents[i+2].root.pitchClass)) {
        const iChord = chordEvents[i+2];
        let keyName, keyRoot;
        if (mode === 'major') {
          keyName = tpcToNoteName(iChord.root.tpc) + 'Maj';
          keyRoot = iChord.root;
        } else {
          const relMaj = tpcToNoteName(iChord.root.tpc - 3);
          keyName = tpcToNoteName(iChord.root.tpc) + 'm (' + relMaj + 'Maj)';
          keyRoot = iChord.root;
        }
        raw.push({
          type: '251', keyMode: mode,
          firstIdx: i, lastIdx: i+2,
          iiIdx: i, iIdx: i+2,
          keyRoot, keyName
        });
        used[i] = used[i+1] = used[i+2] = true;
      }
    }
  }

  function scanPair(aType, bType, kind, mode) {
    for (let i = 0; i < chordEvents.length - 1; i++) {
      if (used[i] || used[i+1]) continue;
      if (chordEvents[i].type === aType &&
          chordEvents[i+1].type === bType &&
          isP4Up(chordEvents[i].root.pitchClass, chordEvents[i+1].root.pitchClass)) {
        let keyRoot, keyName, iiIdx = -1, iIdx = -1;
        if (kind === '25') {
          // Key is a P4 above the V (= V tpc - 1 in circle of fifths)
          const keyTpc = chordEvents[i+1].root.tpc - 1;
          const keyPc = (chordEvents[i+1].root.pitchClass + 5) % 12;
          keyRoot = { pitchClass: keyPc, tpc: keyTpc };
          if (mode === 'major') keyName = tpcToNoteName(keyTpc) + 'Maj';
          else keyName = tpcToNoteName(keyTpc) + 'm (' + tpcToNoteName(keyTpc - 3) + 'Maj)';
          iiIdx = i;
        } else {
          // 51: key is the I chord
          keyRoot = chordEvents[i+1].root;
          if (mode === 'major') keyName = tpcToNoteName(keyRoot.tpc) + 'Maj';
          else keyName = tpcToNoteName(keyRoot.tpc) + 'm (' + tpcToNoteName(keyRoot.tpc - 3) + 'Maj)';
          iIdx = i+1;
        }
        raw.push({
          type: kind, keyMode: mode,
          firstIdx: i, lastIdx: i+1,
          iiIdx, iIdx,
          keyRoot, keyName
        });
        used[i] = used[i+1] = true;
      }
    }
  }

  // Pass 1-2: ii-V-I in major / minor
  scanTriple('minor',   'dominant', 'major', 'major');
  scanTriple('halfdim', 'dominant', 'minor', 'minor');
  // Pass 3-4: ii-V
  scanPair('minor',   'dominant', '25', 'major');
  scanPair('halfdim', 'dominant', '25', 'minor');
  // Pass 5-6: V-I
  scanPair('dominant', 'major', '51', 'major');
  scanPair('dominant', 'minor', '51', 'minor');

  // Phase 2: extend with 6 before ii and 4 after I.
  // Process raw patterns in chart order (by firstIdx) rather than scan order
  // (251-major, 251-minor, 25, 51). Otherwise a later BbMaj 251 whose "6
  // before ii" extension can reach backward into the previous Gm pattern's
  // repeated-I bar (Gm6 is P4 below Cm7) would steal it before Gm's own
  // "Repeated I" gets to claim it.
  raw.sort((a, b) => a.firstIdx - b.firstIdx);
  const patterns = [];
  for (const pat of raw) {
    let startIdx = pat.firstIdx;
    let endIdx = pat.lastIdx;
    // 6 before ii
    if (pat.iiIdx >= 0) {
      const b = pat.iiIdx - 1;
      if (b >= 0 && !used[b] &&
          chordEvents[b].type === 'minor' &&
          isP4Up(chordEvents[b].root.pitchClass, chordEvents[pat.iiIdx].root.pitchClass)) {
        startIdx = b;
        used[b] = true;
      }
    }
    // 4 after I
    if (pat.iIdx >= 0) {
      const after = pat.iIdx + 1;
      const reqType = pat.keyMode === 'major' ? 'major' : 'minor';
      if (after < chordEvents.length && !used[after] &&
          chordEvents[after].type === reqType &&
          isP4Up(chordEvents[pat.iIdx].root.pitchClass, chordEvents[after].root.pitchClass)) {
        endIdx = after;
        used[after] = true;
      }
    }
    // Repeated I: absorb identical-chord Kcl/repeat-bar duplicates right after
    // the I so they're claimed before phase 3's diatonic extension runs — which
    // would otherwise pull them into a neighboring pattern's bVII/etc.
    if (pat.iIdx >= 0 && endIdx === pat.lastIdx) {
      let next = pat.iIdx + 1;
      while (next < chordEvents.length && !used[next] &&
             chordEvents[next].root.pitchClass === chordEvents[pat.iIdx].root.pitchClass &&
             chordEvents[next].type === chordEvents[pat.iIdx].type) {
        endIdx = next;
        used[next] = true;
        next++;
      }
    }
    patterns.push({
      firstIdx: startIdx, lastIdx: endIdx,
      keyRoot: pat.keyRoot,
      keyMode: pat.keyMode,
      keyName: pat.keyName
    });
  }

  // Phase 3: greedily absorb adjacent UNUSED chords that are diatonic to the
  // pattern's key — e.g. in C major, Dm7→G7 (a 25) extends through an
  // unused Em7 (iii) and Am7 (vi) since all four sit in C Ionian.
  // Chords already claimed by another pattern are left alone so a following
  // Am7♭5→D7→Gm isn't pulled into an adjacent B♭-major group.
  //
  // Also: a chord that IS the tonic of some other detected pattern is left
  // alone. e.g. a lone Gm6 between a Gm-key region and a Bb-major region
  // shouldn't be swallowed by BbMaj as its vi — it's really the i of Gm.
  const otherTonicPcs = new Set();
  for (const p of patterns) otherTonicPcs.add(p.keyRoot.pitchClass);
  const isDiatonic = (ev, keyPc, keyMode) => {
    // Don't absorb a chord that is some other pattern's tonic.
    if (ev.root.pitchClass !== keyPc && otherTonicPcs.has(ev.root.pitchClass)) return false;
    const deg = (((ev.root.pitchClass - keyPc) % 12) + 12) % 12;
    const t = ev.type;
    if (keyMode === 'major') {
      if (deg === 0)  return t === 'major';
      if (deg === 2)  return t === 'minor';
      if (deg === 4)  return t === 'minor';
      if (deg === 5)  return t === 'major';
      if (deg === 7)  return t === 'dominant';
      if (deg === 9)  return t === 'minor';
      if (deg === 11) return t === 'halfdim';
    } else {
      // Jazz minor "kit": natural + harmonic + melodic functions.
      if (deg === 0)  return t === 'minor';
      if (deg === 2)  return t === 'halfdim';
      if (deg === 3)  return t === 'major';
      if (deg === 5)  return t === 'minor';
      if (deg === 7)  return t === 'dominant';
      if (deg === 8)  return t === 'major';
      if (deg === 10) return t === 'dominant' || t === 'major';
    }
    return false;
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (const pat of patterns) {
      const before = pat.firstIdx - 1;
      if (before >= 0 && !used[before] &&
          isDiatonic(chordEvents[before], pat.keyRoot.pitchClass, pat.keyMode)) {
        pat.firstIdx = before;
        used[before] = true;
        changed = true;
      }
      const after = pat.lastIdx + 1;
      if (after < chordEvents.length && !used[after] &&
          isDiatonic(chordEvents[after], pat.keyRoot.pitchClass, pat.keyMode)) {
        pat.lastIdx = after;
        used[after] = true;
        changed = true;
      }
    }
  }

  // Phase 4: merge adjacent patterns that share the same key name.
  patterns.sort((a, b) => a.firstIdx - b.firstIdx);
  const merged = [];
  for (const pat of patterns) {
    const last = merged[merged.length - 1];
    if (last && last.keyName === pat.keyName && last.lastIdx + 1 === pat.firstIdx) {
      last.lastIdx = pat.lastIdx;
    } else {
      merged.push(pat);
    }
  }
  return merged;
}

// Scale to use for a detected key. Major → Ionian (no Ab on EbMaj7 as IV of
// BbMaj). Minor → melodic minor so V7 has its leading tone AND i6 has its
// natural 6th.
function scaleForKey(keyRoot, keyMode) {
  if (keyMode === 'major') return { root: keyRoot, scale: SCALE_IONIAN };
  return { root: keyRoot, scale: SCALE_MELODIC_MINOR };
}

// Walk the chord-event sequence and generate quarter-note pitches. When a
// chord is inside a detected key pattern, the whole pattern uses the key's
// scale (major → Ionian, minor → melodic minor) instead of each chord's own
// mode — so borrowed chords (e.g. EbMaj7 as IV of BbMaj) draw from the key
// scale, avoiding out-of-key notes.
// Returns { results, chordEvents, patterns, effectiveScales }.
function generateQuarterNotes(bars, ts) {
  const beatsPerBar = ts.num;
  const chordEvents = buildChordEventList(bars);
  const patterns = detectKeyPatterns(chordEvents);
  const effective = chordEvents.map((ce, i) => {
    const pat = patterns.find(p => i >= p.firstIdx && i <= p.lastIdx);
    // Major-key patterns: use the key's Ionian for every chord. All diatonic
    // modes share the same pitch classes, so each chord's notes stay inside
    // the parent major (e.g. Eb^7 as IV of Bb uses A, not Ab).
    if (pat && pat.keyMode === 'major') {
      return { root: pat.keyRoot, scale: SCALE_IONIAN };
    }
    // Minor-key patterns and standalone chords: use the chord's OWN scale,
    // because the three chords of a minor ii°-V-i use genuinely different
    // pitch classes (Am7b5 Locrian has F natural, D7 Mixolydian has F#, etc.)
    return { root: ce.root, scale: exGetScale(chordToCanonical(ce.chord)) };
  });

  const results = bars.map(() => new Array(beatsPerBar).fill(null));
  let direction = -1;
  let tones = [];
  let toneIdx = 0;
  let lastPitch = -1;
  let lastTpc = -1;       // letter of the last note, for smooth continuation
  let lastSig = null;

  chordEvents.forEach((ce, i) => {
    const eff = effective[i];
    // Full scale signature so scales with the same root but different
    // intervals (e.g. G melodic minor vs G Mixolydian) still trigger a rebuild.
    const sig = eff.root.pitchClass + '|' + eff.root.tpc + '|' + eff.scale.map(x => x.s).join(',');
    if (sig !== lastSig) {
      tones = buildScaleTones(eff.root.pitchClass, eff.root.tpc, eff.scale);
      lastSig = sig;
      if (tones.length === 0) return;
      if (lastPitch < 0) {
        let sp = eff.root.pitchClass + 48;
        while (sp < EX_LOW) sp += 12;
        while (sp > EX_HIGH) sp -= 12;
        toneIdx = findClosestIndex(tones, sp);
      } else {
        const cont = findSmoothContinuation(tones, lastPitch, lastTpc, direction);
        toneIdx = cont.idx;
        direction = cont.dir;
      }
    }
    if (tones.length === 0) return;

    // Beat range for this chord event
    const beatsPerChord = Math.max(1, Math.floor(beatsPerBar / ce.chordsInBar));
    const startBeat = ce.chordIdxInBar * beatsPerChord;
    const endBeat = (ce.chordIdxInBar === ce.chordsInBar - 1)
      ? beatsPerBar : startBeat + beatsPerChord;

    for (let b = startBeat; b < endBeat; b++) {
      let p = tones[toneIdx].pitch;
      let t = tones[toneIdx].tpc;
      if (p === lastPitch && tones.length > 1) {
        let ti = toneIdx + direction;
        if (ti < 0) { direction = 1; ti = toneIdx + 1; }
        else if (ti >= tones.length) { direction = -1; ti = toneIdx - 1; }
        if (ti >= 0 && ti < tones.length && tones[ti].pitch !== lastPitch) {
          toneIdx = ti; p = tones[ti].pitch; t = tones[ti].tpc;
        }
      }
      results[ce.barIdx][b] = { pitch: p, tpc: t };
      lastPitch = p;
      lastTpc = t;

      let ni = toneIdx + direction;
      if (ni < 0) { direction = 1; ni = toneIdx + 1; }
      else if (ni >= tones.length) { direction = -1; ni = toneIdx - 1; }
      if (ni < 0) ni = 0;
      if (ni >= tones.length) ni = tones.length - 1;
      toneIdx = ni;
    }
  });

  return { results, chordEvents, patterns, effective };
}

// Cantus Firmus generator: one tone per chord, held for the chord's full
// duration by repeating the same pitch on every beat. The melody descends
// slowly — the next note is the lowest diatonic tone within a whole step
// below the previous one. When no such tone exists, it jumps to the top of
// the cello range and continues descending from there. Ported from the
// MuseScore ExerciseBuilder "Cantus Firmus" plugin.
function generateCantusFirmusQuarterNotes(bars, ts) {
  const beatsPerBar = ts.num;
  const chordEvents = buildChordEventList(bars);
  const patterns = detectKeyPatterns(chordEvents);
  const effective = chordEvents.map((ce, i) => {
    const pat = patterns.find(p => i >= p.firstIdx && i <= p.lastIdx);
    if (pat && pat.keyMode === 'major') return { root: pat.keyRoot, scale: SCALE_IONIAN };
    return { root: ce.root, scale: exGetScale(chordToCanonical(ce.chord)) };
  });

  const results = bars.map(() => new Array(beatsPerBar).fill(null));
  let lastPitch = -1;

  chordEvents.forEach((ce, i) => {
    const eff = effective[i];
    const tones = buildScaleTones(eff.root.pitchClass, eff.root.tpc, eff.scale);
    if (tones.length === 0) return;

    let notePitch, noteTpc;
    if (lastPitch < 0) {
      // First chord: comfortable starting pitch on the chord's root.
      let sp = eff.root.pitchClass + 48;
      while (sp < EX_LOW) sp += 12;
      while (sp > EX_HIGH) sp -= 12;
      const idx = findClosestIndex(tones, sp);
      notePitch = tones[idx].pitch;
      noteTpc = tones[idx].tpc;
    } else {
      // Find the lowest diatonic tone in [lastPitch - 2, lastPitch) — i.e.
      // at most a whole step below the previous note.
      let bestIdx = -1;
      let bestPitch = 9999;
      for (let t = 0; t < tones.length; t++) {
        if (tones[t].pitch >= lastPitch - 2 && tones[t].pitch < lastPitch) {
          if (bestIdx < 0 || tones[t].pitch < bestPitch) {
            bestIdx = t;
            bestPitch = tones[t].pitch;
          }
        }
      }
      if (bestIdx >= 0) {
        notePitch = tones[bestIdx].pitch;
        noteTpc = tones[bestIdx].tpc;
      } else {
        // No tone within a step below — jump to the highest available tone
        // (reset to the top of the cello range) and continue descending.
        notePitch = tones[tones.length - 1].pitch;
        noteTpc = tones[tones.length - 1].tpc;
      }
    }

    // One sustained note per chord — the note value matches the chord's
    // duration. A single chord in a 4/4 bar = whole note; two chords = two
    // half notes; 4/4 with 3 chords splits as quarter+half or similar
    // depending on where the chord boundaries fall.
    const beatsPerChord = Math.max(1, Math.floor(beatsPerBar / ce.chordsInBar));
    const startBeat = ce.chordIdxInBar * beatsPerChord;
    const endBeat = (ce.chordIdxInBar === ce.chordsInBar - 1)
      ? beatsPerBar : startBeat + beatsPerChord;
    const beatCount = endBeat - startBeat;
    const duration = beatCount >= 4 ? 'w'
                   : beatCount === 3 ? 'h.'
                   : beatCount === 2 ? 'h'
                   : 'q';
    // First beat carries the note + duration (score renders one long note).
    // Subsequent beats repeat the pitch (no duration) so the fingerboard /
    // scale-view stay lit through the sustained section.
    results[ce.barIdx][startBeat] = { pitch: notePitch, tpc: noteTpc, duration };
    for (let b = startBeat + 1; b < endBeat; b++) {
      results[ce.barIdx][b] = { pitch: notePitch, tpc: noteTpc };
    }
    lastPitch = notePitch;
  });

  return { results, chordEvents, patterns, effective };
}

// Broken 3rds generator: alternates a base scale tone with the diatonic
// 3rd in the current direction, then steps the base up/down by one scale
// degree and repeats. Ported from the MuseScore ExerciseBuilder
// "Broken 3rds" option (generateNotes called with brokenThirds=true).
// Returns the same { results, chordEvents, patterns, effective } shape as
// generateQuarterNotes so it slots into the renderer and playback directly.
function generateBroken3rdsQuarterNotes(bars, ts) {
  const beatsPerBar = ts.num;
  const chordEvents = buildChordEventList(bars);
  const patterns = detectKeyPatterns(chordEvents);
  const effective = chordEvents.map((ce, i) => {
    const pat = patterns.find(p => i >= p.firstIdx && i <= p.lastIdx);
    if (pat && pat.keyMode === 'major') return { root: pat.keyRoot, scale: SCALE_IONIAN };
    return { root: ce.root, scale: exGetScale(chordToCanonical(ce.chord)) };
  });

  const results = bars.map(() => new Array(beatsPerBar).fill(null));
  let direction = -1;
  let tones = [];
  let baseIdx = 0;
  let phase = 0;          // 0 = base note, 1 = the 3rd
  let lastPitch = -1;
  let lastTpc = -1;
  let lastBasePitch = -1; // pitch of the most recently played phase-0 (base) note
  let lastSig = null;

  chordEvents.forEach((ce, i) => {
    const eff = effective[i];
    const sig = eff.root.pitchClass + '|' + eff.root.tpc + '|' + eff.scale.map(x => x.s).join(',');
    if (sig !== lastSig) {
      // Capture the "virtual next base" pitch from the OLD scale before we
      // rebuild tones — baseIdx always points at where the next phase-0 note
      // would have landed. Using this instead of lastPitch (the 3rd we just
      // played) keeps the broken-3rds base-step flow across chord changes.
      let virtualBasePitch = -1;
      if (tones.length > 0 && baseIdx >= 0 && baseIdx < tones.length) {
        virtualBasePitch = tones[baseIdx].pitch;
      }
      tones = buildScaleTones(eff.root.pitchClass, eff.root.tpc, eff.scale);
      lastSig = sig;
      if (tones.length === 0) return;
      if (lastPitch < 0) {
        let sp = eff.root.pitchClass + 48;
        while (sp < EX_LOW) sp += 12;
        while (sp > EX_HIGH) sp -= 12;
        baseIdx = findClosestIndex(tones, sp);
      } else if (virtualBasePitch >= 0) {
        baseIdx = findClosestIndex(tones, virtualBasePitch);
        // If the virtual next base lands on the same pitch we just played
        // (either the last base OR the last 3rd — i.e. the literal last
        // note of the previous bar), step one more scale degree in the
        // current direction so we don't sound the same pitch twice in a
        // row across the barline.
        if (tones[baseIdx].pitch === lastPitch || tones[baseIdx].pitch === lastBasePitch) {
          const adv = baseIdx + direction;
          if (adv >= 0 && adv < tones.length) baseIdx = adv;
        }
      } else {
        const cont = findSmoothContinuation(tones, lastPitch, lastTpc, direction);
        baseIdx = cont.idx;
        direction = cont.dir;
      }
      phase = 0; // every chord change starts on a fresh base note
    }
    if (tones.length === 0) return;

    const beatsPerChord = Math.max(1, Math.floor(beatsPerBar / ce.chordsInBar));
    const startBeat = ce.chordIdxInBar * beatsPerChord;
    const endBeat = (ce.chordIdxInBar === ce.chordsInBar - 1)
      ? beatsPerBar : startBeat + beatsPerChord;

    for (let b = startBeat; b < endBeat; b++) {
      let noteIdx;
      if (phase === 0) {
        noteIdx = baseIdx;
      } else {
        let thirdIdx = baseIdx + 2 * direction;
        if (thirdIdx < 0 || thirdIdx >= tones.length) {
          direction = -direction;
          thirdIdx = baseIdx + 2 * direction;
        }
        if (thirdIdx < 0) thirdIdx = 0;
        if (thirdIdx >= tones.length) thirdIdx = tones.length - 1;
        noteIdx = thirdIdx;
      }
      results[ce.barIdx][b] = { pitch: tones[noteIdx].pitch, tpc: tones[noteIdx].tpc };
      lastPitch = tones[noteIdx].pitch;
      lastTpc = tones[noteIdx].tpc;
      if (phase === 0) lastBasePitch = tones[noteIdx].pitch;

      // Flip phase each step; after the 3rd, step the base forward.
      if (phase === 0) {
        phase = 1;
      } else {
        phase = 0;
        baseIdx += direction;
        if (baseIdx < 0) { baseIdx = 0; direction = 1; }
        if (baseIdx >= tones.length) { baseIdx = tones.length - 1; direction = -1; }
      }
    }
  });

  return { results, chordEvents, patterns, effective };
}

// Alternative quarter-note generator that cycles through each chord's 1-3-5-7
// chord tones instead of the full scale. Ported from the MuseScore
// ExerciseBuilder "1357" plugin (Dropbox/MuseScore/Plugins/ExerciseBuilder.qml)
// — same direction / enclosure / group-reversal logic. Returns the same
// { results, chordEvents, patterns, effective } shape as generateQuarterNotes.
function generate1357QuarterNotes(bars, ts) {
  const beatsPerBar = ts.num;
  const chordEvents = buildChordEventList(bars);
  const patterns = detectKeyPatterns(chordEvents);
  const effective = chordEvents.map((ce, i) => {
    const pat = patterns.find(p => i >= p.firstIdx && i <= p.lastIdx);
    if (pat && pat.keyMode === 'major') return { root: pat.keyRoot, scale: SCALE_IONIAN };
    return { root: ce.root, scale: exGetScale(chordToCanonical(ce.chord)) };
  });

  const results = bars.map(() => new Array(beatsPerBar).fill(null));

  // All MIDI pitches in the cello range that match a given pitch class.
  function pitchesForPC(pc) {
    const arr = [];
    for (let oc = 0; oc <= 7; oc++) {
      const p = pc + oc * 12;
      if (p >= EX_LOW && p <= EX_HIGH) arr.push(p);
    }
    return arr;
  }

  // Number of quarter-note slots each chord event gets.
  const quartersPerEvent = chordEvents.map(ce => {
    const beatsPerChord = Math.max(1, Math.floor(beatsPerBar / ce.chordsInBar));
    const endBeat = (ce.chordIdxInBar === ce.chordsInBar - 1)
      ? beatsPerBar : (ce.chordIdxInBar + 1) * beatsPerChord;
    return endBeat - ce.chordIdxInBar * beatsPerChord;
  });

  let descending = true;           // start by descending from top of range
  let lastWrittenPitch = -1;
  let secondLastWrittenPitch = -1;

  chordEvents.forEach((ce, ci) => {
    const eff = effective[ci];
    const scale = eff.scale;
    const rootPC = eff.root.pitchClass;
    const rootTpc = eff.root.tpc;

    // Build 4 chord-tone degrees: root(0), 3rd(1), 5th(2), 7th(3).
    const degScaleIdx = [0, 2, 4, 6];
    const degrees = [];
    for (let d = 0; d < 4; d++) {
      const si = degScaleIdx[d];
      if (si >= scale.length) continue;
      degrees.push({
        pc: ((rootPC + scale[si].s) % 12 + 12) % 12,
        tpc: rootTpc + scale[si].t
      });
    }
    if (degrees.length < 4) return;

    const numQuarters = quartersPerEvent[ci];
    const notes = [];

    // Unified "pick the smoothest next chord tone" loop — no special cases
    // for 1- or 2-quarter chords. For short chords inside multi-chord bars
    // this means we use whatever tone of 1/3/5/7 creates the smallest voice-
    // leading jump from the previous note, rather than forcing the 3rd or
    // the 3rd/7th pair. For long chords it preserves the zig-zag 1-3-5-7
    // arpeggio with direction reversals every 4 notes.
    //
    // Starting pitch / degree for this chord:
    //   - First chord of the piece: top of the cello range (descending).
    //   - Subsequent chords: pick the chord tone that is (a) closest to the
    //     previous note and (b) continues the current direction if possible;
    //     fall back to plain nearest-tone if neither helps.
    let startPitch = -1, startDegIdx = 0;

    if (ci === 0) {
      for (let d = 0; d < degrees.length; d++) {
        const all = pitchesForPC(degrees[d].pc);
        for (let k = 0; k < all.length; k++) {
          if (all[k] > startPitch) { startPitch = all[k]; startDegIdx = d; }
        }
      }
      descending = true;
    } else {
      // First pass: nearest chord tone in the current direction.
      let bestDirD = 9999;
      for (let d = 0; d < degrees.length; d++) {
        const all = pitchesForPC(degrees[d].pc);
        for (let k = 0; k < all.length; k++) {
          if (all[k] === lastWrittenPitch) continue;
          const inDir = descending ? all[k] < lastWrittenPitch : all[k] > lastWrittenPitch;
          if (!inDir) continue;
          const dist = Math.abs(all[k] - lastWrittenPitch);
          if (dist < bestDirD) { bestDirD = dist; startPitch = all[k]; startDegIdx = d; }
        }
      }
      // Fallback: absolute nearest chord tone (may reverse direction).
      if (startPitch < 0) {
        let bestD = 9999;
        for (let d = 0; d < degrees.length; d++) {
          const all = pitchesForPC(degrees[d].pc);
          for (let k = 0; k < all.length; k++) {
            if (all[k] === lastWrittenPitch) continue;
            const dist = Math.abs(all[k] - lastWrittenPitch);
            if (dist < bestD) { bestD = dist; startPitch = all[k]; startDegIdx = d; }
          }
        }
        // Flip direction if the nearest tone went against us.
        if (startPitch >= 0 && lastWrittenPitch >= 0) {
          descending = startPitch < lastWrittenPitch;
        }
      }
    }
    if (startPitch < 0) return;

    // Validate direction: if we can't take 4 steps in the current direction
    // from here, flip it. (Protects long chords near range boundaries.)
    const firstGroup = Math.min(numQuarters, 4);
    let checkPrev = startPitch;
    let checkDeg = startDegIdx;
    let dirOK = true;
    for (let q = 1; q < firstGroup; q++) {
      checkDeg = descending ? (checkDeg - 1 + 4) % 4 : (checkDeg + 1) % 4;
      const chkAll = pitchesForPC(degrees[checkDeg].pc);
      let found = false;
      if (descending) {
        for (let k = chkAll.length - 1; k >= 0; k--) {
          if (chkAll[k] < checkPrev) { checkPrev = chkAll[k]; found = true; break; }
        }
      } else {
        for (let k = 0; k < chkAll.length; k++) {
          if (chkAll[k] > checkPrev) { checkPrev = chkAll[k]; found = true; break; }
        }
      }
      if (!found) { dirOK = false; break; }
    }
    if (!dirOK) descending = !descending;

    notes.push({ pitch: startPitch, tpc: degrees[startDegIdx].tpc });
    let prev = startPitch;
    let degIdx = startDegIdx;
    for (let q = 1; q < numQuarters; q++) {
      // Reverse every 4 notes so long chords zig-zag instead of running off.
      if (q % 4 === 0) descending = !descending;
      degIdx = descending ? (degIdx - 1 + 4) % 4 : (degIdx + 1) % 4;
      const pc = degrees[degIdx].pc;
      const all = pitchesForPC(pc);
      let next = -1;
      if (descending) {
        for (let k = all.length - 1; k >= 0; k--) {
          if (all[k] < prev) { next = all[k]; break; }
        }
      } else {
        for (let k = 0; k < all.length; k++) {
          if (all[k] > prev) { next = all[k]; break; }
        }
      }
      if (next < 0) {
        // Reverse if stuck at the range boundary.
        descending = !descending;
        if (descending) {
          for (let k = all.length - 1; k >= 0; k--) {
            if (all[k] < prev) { next = all[k]; break; }
          }
        } else {
          for (let k = 0; k < all.length; k++) {
            if (all[k] > prev) { next = all[k]; break; }
          }
        }
      }
      if (next < 0) break;
      notes.push({ pitch: next, tpc: degrees[degIdx].tpc });
      prev = next;
    }

    // Write the generated notes into results[barIdx][beat].
    const beatsPerChord = Math.max(1, Math.floor(beatsPerBar / ce.chordsInBar));
    const startBeat = ce.chordIdxInBar * beatsPerChord;
    for (let q = 0; q < notes.length; q++) {
      const b = startBeat + q;
      if (b >= beatsPerBar) break;
      results[ce.barIdx][b] = { pitch: notes[q].pitch, tpc: notes[q].tpc };
      secondLastWrittenPitch = lastWrittenPitch;
      lastWrittenPitch = notes[q].pitch;
    }
  });

  return { results, chordEvents, patterns, effective };
}

// TPC → letter + accidental (e.g. TPC 7 → { letter:'C', acc:'b' }). The
// awkward enharmonics (Cb/Fb/E#/B#) are collapsed first so VexFlow renders
// them on the adjacent natural line instead.
function tpcToLetterAcc(tpc) {
  tpc = normalizeEnharmonic(tpc);
  const letters = ['F','C','G','D','A','E','B'];
  const letterIdx = (((tpc + 1) % 7) + 7) % 7;
  const altLevel = Math.floor((tpc - 6) / 7); // -1=bb, 0=b, 1=nat, 2=#, 3=##
  const accMap = { '-1': 'bb', '0': 'b', '1': '', '2': '#', '3': '##' };
  return { letter: letters[letterIdx], acc: accMap[String(altLevel)] || '' };
}

// Build VexFlow key like "c#/4" for the given sounding MIDI + TPC, using
// the 8vb bass clef (so written = sounding + 1 octave).
// Returns { key, acc, letterIdx, level } where letterIdx matches the
// ExerciseBuilder convention 0=F,1=C,2=G,3=D,4=A,5=E,6=B and level is
// -2=bb, -1=b, 0=natural, 1=#, 2=##.
function midiTpcToVexKey(soundingMidi, tpc) {
  const { letter, acc } = tpcToLetterAcc(tpc);
  const altAdjust = { 'bb': -2, 'b': -1, '': 0, '#': 1, '##': 2 }[acc];
  const writtenMidi = soundingMidi + 12;
  const letterRef = writtenMidi - altAdjust;
  const octave = Math.floor(letterRef / 12) - 1;
  const key = letter.toLowerCase() + acc + '/' + octave;
  const LETTER_IDX = { F: 0, C: 1, G: 2, D: 3, A: 4, E: 5, B: 6 };
  return { key, acc, letterIdx: LETTER_IDX[letter], level: altAdjust, octave };
}

// ===== Cello fingerboard =====
// 5-string cello tuned F C G D A. Each string has 7 positions (0-6 semitones
// from the open string). The panel renders an SVG diagram where circles appear
// only for notes that are either currently being played or part of the current
// scale. Chord tones get a degree label ("1"/"3"/"5"/"7") inside the circle.
const FB_STRING_BASES = [29, 36, 43, 50, 57]; // F1, C2, G2, D3, A3 (sounding MIDI)
const FB_STRING_NAMES = ['F', 'C', 'G', 'D', 'A'];
const FB_FRETS = 7;

function buildFingerboardSVG() {
  // Columns packed tight: 18px circle with a few px of air between adjacent
  // strings. Total width = 5*22 + 4*4 = 126. We extend the viewBox by a
  // few pixels on each side so the r=12 "in-bar" rings on the leftmost and
  // rightmost strings don't get clipped.
  const colW = 22;
  const gap = 4;
  const cols = FB_STRING_BASES.length;
  const rowH = 22;
  const totalW = cols * colW + (cols - 1) * gap;
  const totalH = FB_FRETS * rowH + 4;
  const padX = 4;

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-padX} 0 ${totalW + 2 * padX} ${totalH}" preserveAspectRatio="xMidYMid meet">`;
  const gridTop = 0;
  // Horizontal fret lines spanning all columns (nut is thicker)
  const fretYs = [1, 2, 3, 4, 5, 6].map(i => gridTop + i * rowH + 1);
  const gridLeft = -3;
  const gridRight = totalW + 3;
  fretYs.forEach((y, i) => {
    const t = i === 0 ? 2 : 1;
    svg += `<rect x="${gridLeft}" y="${y}" width="${gridRight - gridLeft}" height="${t}" fill="#000" stroke="none"/>`;
  });
  // Per-string vertical line and circle placeholders
  for (let c = 0; c < cols; c++) {
    const cx = c * (colW + gap) + colW / 2;
    const firstCy = gridTop + rowH - 9; // circle center for row 0
    const lastCy = gridTop + 6 * rowH + (rowH - 9);
    // String line (3px black, behind circles)
    svg += `<rect x="${cx - 1.5}" y="${firstCy}" width="3" height="${lastCy - firstCy}" fill="#000" stroke="none"/>`;
    for (let r = 0; r < FB_FRETS; r++) {
      const cy = gridTop + r * rowH + (rowH - 9);
      const midi = FB_STRING_BASES[c] + r;
      svg += `<g class="fb-cell" data-midi="${midi}" data-pc="${((midi % 12) + 12) % 12}" data-fret="${r}">` +
             // Outer ring — drawn around the filled circle when this note is
             // one of the quarter notes played in the current bar.
             `<circle cx="${cx}" cy="${cy}" r="12" fill="none" stroke="#000" stroke-width="1.2" class="fb-ring" style="display:none"/>` +
             `<circle cx="${cx}" cy="${cy}" r="9" fill="#000" stroke="#000" stroke-width="1" class="fb-circle" style="display:none"/>` +
             `<text x="${cx}" y="${cy + 3}" text-anchor="middle" font-family="sans-serif" font-size="8" font-weight="bold" fill="#fff" stroke="none" class="fb-degree"></text>` +
             `</g>`;
    }
  }
  svg += `</svg>`;
  return svg;
}

const PC_NAMES_SHARP = ['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B'];
const PC_NAMES_FLAT  = ['C','D♭','D','E♭','E','F','G♭','G','A♭','A','B♭','B'];

function pcNameForChord(pc, chordRest) {
  // Prefer flats for chords with 'b' in rest, sharps for '#'
  const r = chordRest || '';
  if (r.indexOf('b') >= 0 && r.indexOf('#') < 0) return PC_NAMES_FLAT[pc];
  if (r.indexOf('#') >= 0 && r.indexOf('b') < 0) return PC_NAMES_SHARP[pc];
  return PC_NAMES_FLAT[pc];
}

// Circle-of-fifths TPC offset for each semitone interval within a chord,
// following standard jazz/classical spelling conventions (e.g. the m7 of C
// is always spelled B♭, never A♯; the M3 of B is always D♯, never E♭).
// This lets us derive each chord tone's correct letter-and-accidental by
// adding the offset to the chord root's TPC.
function intervalTpcOffset(semi, rest) {
  const r = rest || '';
  const isDim = /(^|[^a-z])o(?![a-z])|dim|°/.test(r);
  const isAug = /\+|aug|#5/i.test(r);
  switch (semi) {
    case 0:  return 0;    // root
    case 1:  return -5;   // ♭9 / ♭2
    case 2:  return 2;    // 9 / 2
    case 3:  return -3;   // ♭3 (minor third)
    case 4:  return 4;    // 3 (major third)
    case 5:  return -1;   // 4 (perfect fourth, sus4)
    case 6:  return -6;   // ♭5 (diminished / half-dim / 7♭5)
    case 7:  return 1;    // 5 (perfect fifth)
    case 8:  return isAug ? 8 : -4; // ♯5 for aug, else ♭6 / ♭13
    case 9:  return isDim ? -9 : 3; // ♭♭7 for dim7, else 6
    case 10: return -2;   // ♭7 (minor seventh, dominant)
    case 11: return 5;    // 7 (major seventh)
    default: return 0;
  }
}

function degreeFromInterval(iv, chordRest) {
  const rest = chordRest || '';
  if (iv === 0) return '1';
  if (iv === 3 || iv === 4) return '3';
  if (iv === 5) return '4';
  if (iv === 6 || iv === 7 || iv === 8) return '5';
  if (iv === 9) {
    // In dim7 chords the "9" (bb7) represents the 7th; in 6/m6 chords it's the 6th.
    if (/(^|[^a-z])o|dim|°/.test(rest)) return '7';
    return '6';
  }
  if (iv === 10 || iv === 11) return '7';
  return '';
}

function chordTonesMap(ch) {
  if (!ch || ch.nc || ch.slash) return { byPc: {}, names: [] };
  const rootPc = pcFromChord(ch);
  // Use the parsed root's TPC so each chord tone is spelled with the correct
  // letter + accidental (e.g. BMaj7 → B D♯ F♯ A♯, not B E♭ G♭ B♭).
  const rootParsed = exParseRoot(chordToCanonical(ch));
  const rootTpc = rootParsed ? rootParsed.tpc : 14;
  const ivs = intervalsFor(ch.rest || '').filter(i => i < 12);
  const byPc = {};
  const names = [];
  ivs.forEach(i => {
    const pc = (rootPc + i) % 12;
    const deg = degreeFromInterval(i, ch.rest || '');
    if (deg && !(pc in byPc)) byPc[pc] = deg;
    const tpc = rootTpc + intervalTpcOffset(i, ch.rest || '');
    names.push(tpcToNoteName(tpc));
  });
  return { byPc, names };
}

// Mode offset table: subtract from mode root to get the parent major root.
// E.g., G Mixolydian is the 5th mode of C major; offset 7, so C = G − 7.
const MODE_PARENT_OFFSET = {
  '0,2,4,5,7,9,11': 0,   // Ionian (itself)
  '0,2,3,5,7,9,10': 2,   // Dorian
  '0,1,3,5,7,8,10': 4,   // Phrygian
  '0,2,4,6,7,9,11': 5,   // Lydian
  '0,2,4,5,7,9,10': 7,   // Mixolydian
  '0,2,3,5,7,8,10': 9,   // Aeolian
  '0,1,3,5,6,8,10': 11   // Locrian
};

// Display name for each mode (used in the note-info panel label). The
// Ionian entry is null so that Ionian reads as just "X Major" instead
// of "X Ionian (X Major)" — since the mode and its parent are the same.
// Aeolian reads as "X Minor" rather than "X Aeolian" because that's the
// common name jazz/classical players use for natural minor.
const MODE_NAMES = {
  '0,2,4,5,7,9,11': null,          // Ionian — just "X Major"
  '0,2,3,5,7,9,10': 'Dorian',
  '0,1,3,5,7,8,10': 'Phrygian',
  '0,2,4,6,7,9,11': 'Lydian',
  '0,2,4,5,7,9,10': 'Mixolydian',
  '0,2,3,5,7,8,10': 'Minor',
  '0,1,3,5,6,8,10': 'Locrian'
};

// Phrygian Dominant is the 5th mode of harmonic minor (not any major
// scale). For D Phrygian Dominant the parent is G harmonic minor
// (G A Bb C D Eb F#). We label these separately from MODE_PARENT_OFFSET
// because their parent isn't a major scale — writing "GMaj" would be
// wrong (G major has B♮ and E♮, not Bb/Eb).
const PHRYGIAN_DOMINANT_SIG = '0,1,4,5,7,8,10';

// Parent-major root PC for the effective scale (used to pick flat/sharp
// spelling on the fingerboard).
function parentMajorPc(eff) {
  const sig = eff.scale.map(x => x.s).join(',');
  if (sig === '0,2,3,5,7,9,11') {
    // Melodic minor → relative major = root + 3
    return (eff.root.pitchClass + 3) % 12;
  }
  const offset = MODE_PARENT_OFFSET[sig];
  if (offset !== undefined) {
    return (((eff.root.pitchClass - offset) % 12) + 12) % 12;
  }
  return eff.root.pitchClass;
}

// Keys that write with flats (F, B♭, E♭, A♭, D♭, G♭).
const FLAT_PARENT_PCS = new Set([5, 10, 3, 8, 1, 6]);

// Relate-scale label: the parent major (or minor key name) for the effective
// scale at this chord. Matches the style used for the score's bracket labels.
function relatedScaleLabel(eff, patternKeyName) {
  if (patternKeyName) return patternKeyName;
  const sig = eff.scale.map(x => x.s).join(',');
  const rootPc = eff.root.pitchClass;
  const parent = parentMajorPc(eff);
  const useFlats = FLAT_PARENT_PCS.has(parent);
  const names = useFlats ? PC_NAMES_FLAT : PC_NAMES_SHARP;
  // Melodic minor — named directly on its own root. No parent major in
  // parens because melodic minor doesn't align with any major scale.
  if (sig === '0,2,3,5,7,9,11') {
    return names[rootPc] + ' Melodic Minor';
  }
  // Phrygian Dominant — 5th mode of harmonic minor; parent key is the
  // harmonic minor a fifth below (e.g. D Phrygian Dominant → G Harmonic
  // Minor, which contains Bb, Eb, F#).
  if (sig === PHRYGIAN_DOMINANT_SIG) {
    const hmRoot = (((rootPc - 7) % 12) + 12) % 12;
    const hmUseFlats = FLAT_PARENT_PCS.has((hmRoot + 3) % 12);
    const hmNames = hmUseFlats ? PC_NAMES_FLAT : PC_NAMES_SHARP;
    return names[rootPc] + ' Phrygian Dominant (' + hmNames[hmRoot] + ' Harmonic Minor)';
  }
  // Diatonic mode of a major scale — name the mode on its own root and
  // show the parent major in parens so the reader sees both the modal
  // character (how to phrase the notes) and the key signature:
  //   C Ionian     → "C Major"
  //   D Dorian     → "D Dorian (C Major)"
  //   A Aeolian    → "A Minor (C Major)"
  //   G Mixolydian → "G Mixolydian (C Major)"
  // Ionian is a special case — we show just "X Major" since the mode
  // and its parent are the same scale.
  if (MODE_PARENT_OFFSET[sig] !== undefined) {
    const modeName = MODE_NAMES[sig];
    if (modeName === null) return names[rootPc] + ' Major';
    return names[rootPc] + ' ' + modeName + ' (' + names[parent] + ' Major)';
  }
  return names[rootPc];
}

function buildBeatInfo(bars, ts, quarterNotes, chordEvents, effective, patterns) {
  const beatInfo = bars.map(() => new Array(ts.num).fill(null));
  // Which pattern (if any) claims each chord event
  const patternByIdx = {};
  patterns.forEach(p => {
    for (let i = p.firstIdx; i <= p.lastIdx; i++) patternByIdx[i] = p;
  });
  chordEvents.forEach((ce, i) => {
    const eff = effective[i];
    const pat = patternByIdx[i];
    const scalePcs = new Set(eff.scale.map(x => ((eff.root.pitchClass + x.s) % 12 + 12) % 12));
    const tones = chordTonesMap(ce.chord);
    const chordSymbol = chordText(ce.chord);
    // Note-info-panel scale label: always use the PARENT MAJOR of this
    // specific chord's effective scale, never the pattern's keyName.
    // For minor 251 patterns (e.g. "Gm (B♭Maj)") the pattern name reads
    // as the song key, but per-chord it's more useful to see the
    // actual scale being played — A Locrian → BbMaj, D Phrygian
    // Dominant → GMaj, etc.
    const scaleLabel = relatedScaleLabel(eff, null);
    const chordNotesLabel = tones.names.join(' ');
    // Flats/sharps follow the SONG context (pattern key) when in a pattern,
    // so all chords of a Gm (B♭Maj) 251 read with flats even though D
    // Mixolydian on its own would prefer sharps.
    const contextPc = pat
      ? (pat.keyMode === 'major' ? pat.keyRoot.pitchClass : (pat.keyRoot.pitchClass + 3) % 12)
      : parentMajorPc(eff);
    const useFlats = FLAT_PARENT_PCS.has(contextPc);
    const beatsPerChord = Math.max(1, Math.floor(ts.num / ce.chordsInBar));
    const startBeat = ce.chordIdxInBar * beatsPerChord;
    const endBeat = (ce.chordIdxInBar === ce.chordsInBar - 1) ? ts.num : startBeat + beatsPerChord;
    for (let b = startBeat; b < endBeat; b++) {
      const bp = quarterNotes[ce.barIdx][b];
      beatInfo[ce.barIdx][b] = {
        pitch: bp ? bp.pitch : null,
        tpc: bp ? bp.tpc : null,
        scalePcs,
        chordTonesByPc: tones.byPc,
        chordSymbol,
        chordNotesLabel,
        scaleLabel,
        useFlats,
        // For the "Notes" mode of the info panel: we need the scale's root
        // TPC + intervals to spell every scale note correctly (e.g. E♭ vs D♯).
        scaleRoot: eff.root,
        scaleIntervals: eff.scale,
        // Chord's own root (distinct from scale root when a pattern swaps in
        // its tonic, e.g. Dm7 inside a CMaj 251 uses a C-Ionian scale but the
        // chord root is still D). Used to pick the "home octave" to emphasize
        // in the Notes-mode measure.
        chordRoot: ce.root
      };
    }
  });
  return beatInfo;
}

function initFingerboard() {
  const host = document.getElementById('fbGrid');
  if (host) host.innerHTML = buildFingerboardSVG();
  const toggle = document.getElementById('fbToggle');
  const panel = document.getElementById('fingerboardPanel');
  if (toggle && panel) {
    toggle.addEventListener('click', () => {
      const hidden = panel.hasAttribute('hidden');
      if (hidden) {
        panel.removeAttribute('hidden');
        toggle.setAttribute('aria-expanded', 'true');
      } else {
        panel.setAttribute('hidden', '');
        toggle.setAttribute('aria-expanded', 'false');
      }
    });
  }
}
initFingerboard();

// Render a one-line VexFlow staff showing exactly the 7 scale degrees from
// the chord root up through the 7th (one octave). The current beat's pitch
// class lights up in blue. 8vb bass clef to match the chart.
let lastNotesSig = null;
function buildNotesMeasureSVG(state) {
  const host = document.getElementById('fbNotesMeasure');
  if (!host) return;
  const scaleRoot = state.scaleRoot;
  const scaleIntervals = state.scaleIntervals;
  const chordRoot = state.chordRoot;
  if (!scaleRoot || !scaleIntervals || !chordRoot || !window.Vex || !window.Vex.Flow) {
    host.innerHTML = '';
    lastNotesSig = null;
    return;
  }
  const VF = Vex.Flow;

  // Rotate the scale so it starts at the chord root: find the interval whose
  // pitch-class matches the chord root, then walk the scale's intervals in
  // order, wrapping semitones into the next octave past the chord root.
  const scaleRootPc = scaleRoot.pitchClass;
  const chordRootPc = chordRoot.pitchClass;
  const offset = ((chordRootPc - scaleRootPc) % 12 + 12) % 12;
  let startIdx = scaleIntervals.findIndex(iv => iv.s === offset);
  // If the chord root isn't a scale tone (altered dominant, etc.), fall back
  // to starting at the scale root so we still render something sensible.
  let baseTpc = chordRoot.tpc;
  if (startIdx < 0) { startIdx = 0; baseTpc = scaleRoot.tpc; }
  const len = scaleIntervals.length;
  const startIv = scaleIntervals[startIdx];
  const rotated = [];
  for (let k = 0; k < len; k++) {
    const iv = scaleIntervals[(startIdx + k) % len];
    let semi = iv.s - startIv.s;
    if (k > 0 && semi <= 0) semi += 12;
    const tpc = iv.t - startIv.t; // fifths-axis offset from chord root
    rotated.push({ semi, tpc });
  }

  // Pick a chord-root MIDI in the cello's low-F..high-F range, preferring
  // the lowest one so the full octave fits on the staff.
  const LOW = 29, HIGH = 53;
  let rootMidi = LOW;
  while (rootMidi <= HIGH && ((rootMidi % 12 + 12) % 12) !== chordRootPc) rootMidi++;
  if (rootMidi > HIGH) { host.innerHTML = ''; return; }

  const tones = rotated.map(r => ({ pitch: rootMidi + r.semi, tpc: baseTpc + r.tpc }));

  // Current lit pitch class (if any) for blue highlight. We match by pitch
  // class so a playing pitch in a different octave still lights the right
  // scale degree on this one-octave display.
  const litMidis = state.litMidis || [];
  const litPc = litMidis.length > 0 ? ((litMidis[0] % 12 + 12) % 12) : -1;

  // Cache signature: scale + chord root + currently-lit PC. Changes in any
  // of these require a rebuild; bar-to-bar redraws are free otherwise.
  const sig = chordRootPc + ':' + baseTpc + ':' + scaleRootPc + ':' +
              scaleIntervals.map(x => x.s + ',' + x.t).join(';') + ':' + litPc;
  if (sig === lastNotesSig) return;
  lastNotesSig = sig;
  host.innerHTML = '';

  // Tight vertical budget: just enough for two ledger lines above the staff
  // (for an E-root scale's top note, Eb4 written) and one ledger line below
  // (for an F-root scale's low F2 written). No clef is drawn, so the stave
  // starts flush left.
  const leftPad = 10;
  const rightPad = 10;
  const perNote = 28;
  const width = leftPad + tones.length * perNote + rightPad;
  const staveY = 25;
  const height = 80;

  const renderer = new VF.Renderer(host, VF.Renderer.Backends.SVG);
  renderer.resize(width, height);
  const ctx = renderer.getContext();
  ctx.setFont('Arial', 10);

  // `space_above/below_staff_ln` default to 4 (×10 = 40px each), which would
  // bump the first staff line down to staveY+40 and push the whole staff
  // off the bottom of our compact 80px viewBox. Zero them out so the staff
  // draws starting exactly at staveY. left_bar/right_bar disable the grey
  // vertical edge lines VexFlow draws by default.
  const stave = new VF.Stave(leftPad, staveY, width - leftPad - rightPad, {
    space_above_staff_ln: 0,
    space_below_staff_ln: 0,
    left_bar: false,
    right_bar: false
  });
  // Intentionally no clef — positions are still computed as 8vb bass under
  // the hood (so notes fall on the "right" lines), we just don't draw the
  // symbol.
  stave.setBegBarType(VF.Barline.type.NONE);
  stave.setEndBarType(VF.Barline.type.NONE);
  stave.setContext(ctx).draw();

  const seenAcc = {};
  const ACC_GLYPH = { '-2': 'bb', '-1': 'b', '0': 'n', '1': '#', '2': '##' };
  const BLUE = { fillStyle: '#2e78ff', strokeStyle: '#1a4bb8' };
  const vfNotes = tones.map(t => {
    const { key, letterIdx, level, octave } = midiTpcToVexKey(t.pitch, t.tpc);
    // Stemless filled quarter-note heads.
    const n = new VF.StaveNote({ clef: 'bass', keys: [key], duration: 'q', stem_direction: VF.Stem.UP });
    n.drawStem = function () {};
    const posKey = letterIdx + ':' + octave;
    let showLevel = null;
    if (!(posKey in seenAcc)) {
      if (level !== 0) showLevel = level;
      seenAcc[posKey] = level;
    } else if (seenAcc[posKey] !== level) {
      showLevel = level;
      seenAcc[posKey] = level;
    }
    let acc = null;
    if (showLevel !== null) {
      acc = new VF.Accidental(ACC_GLYPH[String(showLevel)]);
      n.addModifier(acc, 0);
    }
    // Blue highlight for the currently-playing scale degree (matched by
    // pitch class across octaves).
    const notePc = ((t.pitch % 12) + 12) % 12;
    if (litPc >= 0 && notePc === litPc) {
      n.setStyle(BLUE);
      if (acc && acc.setStyle) acc.setStyle(BLUE);
    }
    return n;
  });

  const voice = new VF.Voice({ num_beats: tones.length, beat_value: 4, resolution: VF.RESOLUTION });
  voice.setStrict(false);
  voice.addTickables(vfNotes);
  new VF.Formatter().joinVoices([voice]).format([voice], width - leftPad - rightPad - 10);
  voice.draw(ctx, stave);

  // Scale to panel width like the chart rows do.
  const svgEl = host.querySelector('svg');
  if (svgEl) {
    svgEl.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svgEl.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svgEl.removeAttribute('width');
    svgEl.removeAttribute('height');
    svgEl.style.width = '100%';
    svgEl.style.height = 'auto';
  }
}
let lastFbState = null;

// Detect Android once at load and flag <html> so CSS can target
// Android-specific flat kerning. Also used by appendChordLabelTspans
// to emit dx kerning on the SVG ♭ only on Android, where the system
// music-symbol font has generous side bearings.
const IS_ANDROID = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);
if (IS_ANDROID && typeof document !== 'undefined') {
  document.documentElement.classList.add('is-android');
}

// Set an SVG <text> element's content, giving any flat (♭) characters
// their own tspan so we can force a regular sans-serif font on just
// that glyph. On Pixel/Android we also pull in the flat with negative
// dx so the visible whitespace from font-fallback metrics disappears.
// Desktop/iOS don't need any kerning.
function setSvgTextWithFlatFix(textEl, str) {
  // Clear any previous children / textContent first.
  while (textEl.firstChild) textEl.removeChild(textEl.firstChild);
  const s = String(str || '');
  const parts = s.split(/(♭)/);
  for (const part of parts) {
    if (!part) continue;
    const tspan = document.createElementNS('http://www.w3.org/2000/svg', 'tspan');
    if (part === '♭') {
      tspan.setAttribute('font-family',
        'Arial, Helvetica, "Segoe UI", Roboto, sans-serif');
      if (IS_ANDROID) tspan.setAttribute('dx', '-2');
    }
    tspan.textContent = part;
    textEl.appendChild(tspan);
    if (part === '♭' && IS_ANDROID) {
      // Pull the character AFTER the flat back by roughly the same
      // amount so the label doesn't end up with a gap where the
      // flat's original advance width was.
      const reset = document.createElementNS('http://www.w3.org/2000/svg', 'tspan');
      reset.setAttribute('dx', '-2');
      reset.textContent = '';
      textEl.appendChild(reset);
    }
  }
}
// Back-compat alias for the chord label call site.
const appendChordLabelTspans = setSvgTextWithFlatFix;

// Wrap each Unicode flat (♭) in a <span class="fl"> so CSS can pull
// it in with negative margins. On some platforms (notably Pixel /
// Android) the ♭ glyph falls back to a music-symbol font that has
// extra side bearings, making "Bb" look like "B  b". We don't wrap
// sharps (♯) because they tend to render cleanly from the regular
// sans/serif font. Escapes HTML special chars in the non-flat parts.
function markupFlats(text) {
  if (text == null) return '';
  const s = String(text);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '♭') {
      out += '<span class="fl">♭</span>';
    } else if (c === '&') out += '&amp;';
    else if (c === '<') out += '&lt;';
    else if (c === '>') out += '&gt;';
    else if (c === '"') out += '&quot;';
    else if (c === "'") out += '&#39;';
    else out += c;
  }
  return out;
}
let lastBeatInfo = null; // per-bar per-beat fingerboard info; populated by renderChart

// Update the fingerboard SVG to reflect the current beat.
// state = { litMidis: number[], scalePcs: Set<number>, chordTonesByPc: {pc:degree}, scaleLabel, chordNotesLabel }
function updateFingerboard(state) {
  lastFbState = state;
  const host = document.getElementById('fbGrid');
  if (!host) return;
  const chordNameEl = document.getElementById('fbChordName');
  const chordNotesEl = document.getElementById('fbChordNotes');
  const scaleEl = document.getElementById('fbScale');
  if (chordNameEl) chordNameEl.innerHTML = markupFlats(state.chordSymbol || '');
  if (chordNotesEl) {
    // Chord tones shown inline next to the chord name, in parentheses.
    chordNotesEl.innerHTML = state.chordNotesLabel
      ? '(' + markupFlats(state.chordNotesLabel) + ')' : '';
  }
  if (scaleEl) {
    // When the label has a parenthetical parent in it ("D Mixolydian
    // (G Major)"), break the paren onto its own line so longer labels
    // like "D Phrygian Dominant (G Harmonic Minor)" don't spill past
    // the panel width. Labels without parens ("C Major", "G Melodic
    // Minor") render unchanged.
    scaleEl.innerHTML = '';
    const label = state.scaleLabel || '';
    const m = label.match(/^(.+?)\s*(\(.+\))\s*$/);
    if (m) {
      const head = document.createElement('span');
      head.innerHTML = markupFlats(m[1]);
      scaleEl.appendChild(head);
      scaleEl.appendChild(document.createElement('br'));
      const tail = document.createElement('span');
      tail.innerHTML = markupFlats(m[2]);
      scaleEl.appendChild(tail);
    } else {
      scaleEl.innerHTML = markupFlats(label);
    }
  }

  // Scale-measure view (left side).
  buildNotesMeasureSVG(state);

  // Fingerboard view (right side). Visibility tiers:
  //   - currently-lit pitch → blue filled circle (also ringed, since it's in
  //     the bar by definition)
  //   - any pitch played elsewhere in this bar → ringed; filled black when
  //     the pitch's class belongs to the current chord's scale, filled grey
  //     when it belongs only to another chord in the same bar
  //   - other current-chord scale notes → plain black circle (no ring)
  //   - everything else → hidden
  // Out-of-scale in-bar notes use the opposite sharp/flat spelling so e.g.
  // an F♯ played by a D7 shows as "F♯" even when the active chord (Am7♭5)
  // prefers flats.
  const cells = host.querySelectorAll('.fb-cell');
  const lit = new Set(state.litMidis || []);
  const measure = new Set(state.measurePitches || []);
  const scale = state.scalePcs instanceof Set ? state.scalePcs : new Set(state.scalePcs || []);
  const names = state.useFlats ? PC_NAMES_FLAT : PC_NAMES_SHARP;
  const altNames = state.useFlats ? PC_NAMES_SHARP : PC_NAMES_FLAT;
  cells.forEach(cell => {
    const midi = parseInt(cell.dataset.midi, 10);
    const pc = parseInt(cell.dataset.pc, 10);
    const fret = parseInt(cell.dataset.fret, 10);
    const isOpen = fret === 0; // first row = unfretted / open string
    const ring = cell.querySelector('.fb-ring');
    const circle = cell.querySelector('.fb-circle');
    const text = cell.querySelector('.fb-degree');
    const isLit = lit.has(midi);
    const inMeasure = measure.has(midi);
    const inScale = scale.has(pc);
    if (isLit || inMeasure || inScale) {
      circle.style.display = '';
      circle.setAttribute('fill-opacity', '1');
      circle.setAttribute('stroke-opacity', '1');
      // Tone of the circle/text — black for in-scale, grey for out-of-scale.
      const tone = inScale || isLit ? '#000' : '#9a9a9a';
      if (isLit) {
        // Lit note always renders as a filled blue disc with white text,
        // regardless of whether the position is open or fretted — matches
        // the highlight used elsewhere.
        circle.setAttribute('fill', '#2e78ff');
        circle.setAttribute('stroke', '#1a4bb8');
        circle.setAttribute('stroke-width', '1');
        text.setAttribute('fill', '#fff');
      } else if (isOpen) {
        // Open-string row: hollow circle with a dark outline (like open
        // strings on a traditional chord diagram) and matching dark text
        // so the letter reads on the white interior.
        circle.setAttribute('fill', '#fff');
        circle.setAttribute('stroke', tone);
        circle.setAttribute('stroke-width', '2');
        text.setAttribute('fill', tone);
      } else if (inScale) {
        circle.setAttribute('fill', '#000');
        circle.setAttribute('stroke', '#000');
        circle.setAttribute('stroke-width', '1');
        text.setAttribute('fill', '#fff');
      } else {
        // In the bar but outside the current chord's scale → light grey
        // fill with black text so the letter reads clearly at the
        // lighter tone.
        circle.setAttribute('fill', '#d0d0d0');
        circle.setAttribute('stroke', '#d0d0d0');
        circle.setAttribute('stroke-width', '1');
        text.setAttribute('fill', '#000');
      }
      if (inMeasure) {
        ring.style.display = '';
        // Ring is always black — it encodes "this note is in the current
        // bar" regardless of whether the filled circle underneath is black
        // (in scale) or grey (in the bar but outside the current chord's
        // scale). A grey ring on a grey circle is hard to see.
        ring.setAttribute('stroke', '#000');
        ring.setAttribute('stroke-width', isOpen ? '2' : '1.2');
      } else {
        ring.style.display = 'none';
      }
      const useAlt = inMeasure && !inScale;
      setSvgTextWithFlatFix(text, (useAlt ? altNames : names)[pc]);
      text.style.display = '';
      text.setAttribute('fill-opacity', '1');
    } else {
      circle.style.display = 'none';
      ring.style.display = 'none';
      text.style.display = 'none';
    }
  });
}

// ===== Render (sheet music via VexFlow) =====
let measuresPerLine = 2;
// Per-measure viewBox width in VexFlow units. The "Size" segmented
// control sets this. A SMALLER value squeezes each measure's notes
// into fewer viewBox units; since the SVG still stretches to fill
// the container, the scale factor goes UP and everything (staff
// lines, note heads, clefs) renders BIGGER on screen. So Size=L / XL
// corresponds to a smaller measureWidth, giving a big-notes look at
// any Per line count. Tight internal spacing is fine for sparse
// exercises like Cantus Firmus.
let chartSize = 240;
let songRepeats = 1;
let exerciseMode = 'scale'; // 'scale' = walk the scale, 'chord' = 1-3-5-7 arpeggio
const barElements = []; // [ { rowEl, x, y, w, h } ] per bar index, for highlighting

function expandBarsByRepeats(bars, n) {
  if (n <= 1) return bars.slice();
  const out = [];
  for (let r = 0; r < n; r++) for (let i = 0; i < bars.length; i++) out.push(bars[i]);
  return out;
}

function chordText(ch) {
  if (!ch) return '';
  if (ch.nc) return 'N.C.';
  if (ch.slash) return '/';
  const rootLetter = ch.root;
  let r = ch.rest || '';
  // Leading accidental on the root (e.g. "Bb^7" → root='B', rest='b^7')
  let rootAcc = '';
  if (r[0] === 'b') { rootAcc = '♭'; r = r.substring(1); }
  else if (r[0] === '#') { rootAcc = '♯'; r = r.substring(1); }
  // Quality
  let quality = '';
  if (r.startsWith('^')) {
    r = r.substring(1);
    if (r.startsWith('7')) { quality = 'Maj7'; r = r.substring(1); }
    else { quality = 'Maj'; }
  } else if (r.startsWith('-')) {
    r = r.substring(1);
    quality = 'm';
  } else if (r.startsWith('h')) {
    r = r.replace(/^h7?/, '');
    quality = 'm7♭5';
  } else if (r.startsWith('o')) {
    r = r.replace(/^o7?/, '');
    quality = 'dim7';
  } else if (r.startsWith('+')) {
    r = r.substring(1);
    quality = 'aug';
  }
  // Remaining extensions + alterations: convert accidentals to pretty glyphs
  r = r.replace(/#/g, '♯').replace(/b/g, '♭');
  let out = rootLetter + rootAcc + quality + r;
  if (ch.bass) out += '/' + ch.bass.replace('b', '♭').replace('#', '♯');
  return out;
}

function parseTimesig(ts) {
  if (!ts) return { num: 4, denom: 4, str: '4/4' };
  let num, denom;
  if (ts.length === 2) { num = parseInt(ts[0], 10); denom = parseInt(ts[1], 10); }
  else { num = parseInt(ts.slice(0, -1), 10); denom = parseInt(ts.slice(-1), 10); }
  return { num, denom, str: `${num}/${denom}` };
}

function renderChart(song, barsIn, timesigStr) {
  const chartEl = document.getElementById('chart');
  chartEl.innerHTML = '';
  barElements.length = 0;
  // A fresh render invalidates any previous bar selection (song changed, or
  // options toggled the bar count).
  selectedBar = null;

  // Song title lives in the top bar (between Clear Loop and the song
  // picker) — set it here so it refreshes on every song load.
  const nameEl = document.getElementById('songName');
  if (nameEl) nameEl.textContent = (song && song.title) || '';

  if (!window.Vex || !window.Vex.Flow) {
    chartEl.textContent = 'VexFlow failed to load.';
    return;
  }
  const VF = Vex.Flow;
  const ts = parseTimesig(timesigStr);

  // Expand by song repeats and generate quarter notes across the whole thing.
  // Exercise mode switches which generator we use:
  //   - "scale"   → walk the current chord's scale (one note per beat)
  //   - "chord"   → arpeggiate 1-3-5-7 through the chord tones
  //   - "broken3" → alternating base / diatonic-3rd pairs, stepping through
  //                 the scale (MuseScore ExerciseBuilder "Broken 3rds")
  //   - "cantus"  → one descending scale tone per chord (Cantus Firmus)
  const bars = expandBarsByRepeats(barsIn, songRepeats);
  const gen = exerciseMode === 'chord' ? generate1357QuarterNotes
            : exerciseMode === 'broken3' ? generateBroken3rdsQuarterNotes
            : exerciseMode === 'cantus' ? generateCantusFirmusQuarterNotes
            : generateQuarterNotes;
  const { results: quarterNotes, chordEvents, patterns, effective } = gen(bars, ts);
  // Per-bar/per-beat info for the fingerboard panel, keyed by expanded-bar idx.
  lastBeatInfo = buildBeatInfo(bars, ts, quarterNotes, chordEvents, effective, patterns);

  // Each unique key-pattern name gets a stable color from a rotating palette.
  // Same key across the score → same color.
  const PATTERN_COLORS = [
    '#1e6fd4', '#c92a2a', '#2b8a3e', '#862e9c',
    '#d9480f', '#087f5b', '#9c6e00', '#d6336c'
  ];
  const keyColor = {};
  let nextColorIdx = 0;
  function colorFor(name) {
    if (!(name in keyColor)) {
      keyColor[name] = PATTERN_COLORS[nextColorIdx % PATTERN_COLORS.length];
      nextColorIdx++;
    }
    return keyColor[name];
  }

  // State for courtesy accidentals, carried across bars.
  // letter index: 0=F,1=C,2=G,3=D,4=A,5=E,6=B (same as ExerciseBuilder.qml noteName)
  // level: -2=bb, -1=b, 0=natural, 1=#, 2=##
  // In C major (no key sig) the default level for every letter is 0.
  // Track only the LAST note of the previous bar — courtesy accidentals fire
  // only when that last note was altered and the first note of the next bar
  // is a natural at the same staff position.
  let prevLastNote = null; // { posKey, level } | null

  const mpl = measuresPerLine;
  const measureWidth = chartSize;
  const leftPadding = 14;
  const rightPadding = 14;
  const firstMeasureClefWidth = 68; // bass clef + 8vb + time sig on line 1
  const clefOnlyExtra = 44; // bass clef + 8vb on other lines
  const staffY = 26;
  // VexFlow's bass-clef staff lines end up at y ≈ 66 (top) .. 106 (bottom).
  // The lowest F the generator can produce (written F2 via the 8vb clef) sits
  // around y = 111–116. Push the scale label a bit further below that so
  // it can't overlap the note head, then the colored line just below the
  // label as its underline.
  const patternTextY = 134;         // baseline of the scale label
  const patternLineY = patternTextY + 6; // underline just below descenders
  const staffHeight  = patternLineY + 10;

  const formSize = barsIn.length; // length of one pass of the form
  let rowStart = 0;
  while (rowStart < bars.length) {
    // Clip each row to the next pass boundary so repeats always break on a
    // new row and get their horizontal separator.
    const passIdx = Math.floor(rowStart / formSize);
    const passBoundary = Math.min(bars.length, (passIdx + 1) * formSize);
    const rowEnd = Math.min(rowStart + mpl, passBoundary);
    const rowBars = bars.slice(rowStart, rowEnd);
    const isFirstRow = rowStart === 0;
    const clefExtra = isFirstRow ? firstMeasureClefWidth : clefOnlyExtra;
    // Always size the row as if it were a full MPL row so short rows (last
    // row, end-of-pass) keep the same per-bar width as full rows and the
    // remainder of the staff sits as empty space to the right.
    const rowWidth = leftPadding + clefExtra + mpl * measureWidth + rightPadding;

    const rowEl = document.createElement('div');
    rowEl.className = 'staff-row';
    chartEl.appendChild(rowEl);

    const renderer = new VF.Renderer(rowEl, VF.Renderer.Backends.SVG);
    renderer.resize(rowWidth, staffHeight);
    const context = renderer.getContext();
    context.setFont('Arial', 10);

    // Measure number
    const num = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    num.setAttribute('x', 4);
    num.setAttribute('y', staffY + 2);
    num.setAttribute('font-family', 'serif');
    num.setAttribute('font-style', 'italic');
    num.setAttribute('font-size', 11);
    num.setAttribute('fill', '#000');
    num.textContent = rowStart + 1;
    // insertion happens after svg exists below

    let x = leftPadding;
    const barPosInRow = []; // { barIdx, noteStartX, noteEndX } for pattern overlays
    rowBars.forEach((bar, i) => {
      const barIdx = rowStart + i;
      const isFirstInRow = i === 0;
      const width = measureWidth + (isFirstInRow ? clefExtra : 0);
      // left_bar/right_bar default to true in VexFlow, which draws grey
      // vertical edges at the stave's left and right — the "border" around
      // each measure. Turn them off; we manage measure boundaries via
      // Barline modifiers only (and only for repeats / final / double).
      const stave = new VF.Stave(x, staffY, width, { left_bar: false, right_bar: false });
      if (isFirstInRow) {
        stave.addClef('bass', undefined, '8vb');
        if (isFirstRow) stave.addTimeSignature(ts.str);
      }
      // Barlines
      // Begin barline only for repeat starts — otherwise we'd draw a line
      // at every measure's left edge AND the previous measure's right edge,
      // doubling up. Let the right barline (SINGLE by default) serve as the
      // divider between adjacent measures.
      if (bar.leftBar === 'repeatStart') stave.setBegBarType(VF.Barline.type.REPEAT_BEGIN);
      else stave.setBegBarType(VF.Barline.type.NONE);

      if (bar.rightBar === 'repeatEnd') stave.setEndBarType(VF.Barline.type.REPEAT_END);
      else if (bar.rightBar === 'final') stave.setEndBarType(VF.Barline.type.END);
      else if (bar.rightBar === 'double') stave.setEndBarType(VF.Barline.type.DOUBLE);
      else stave.setEndBarType(VF.Barline.type.SINGLE);

      // iRealPro N1/N2 ending brackets aren't meaningful here since repeats
      // are already expanded into literal bars; skip them to avoid stray
      // horizontal lines above the chord labels.
      stave.setContext(context).draw();

      // Render the rehearsal letter ourselves, tucked up into the left margin
      // so it doesn't share a column with the chord label at beat 1.
      if (bar.section) {
        const svgForSection = rowEl.querySelector('svg');
        const bx = stave.getX() + 2;
        const by = 2;
        const bw = 13, bh = 13;
        const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        r.setAttribute('x', bx); r.setAttribute('y', by);
        r.setAttribute('width', bw); r.setAttribute('height', bh);
        r.setAttribute('fill', '#000');
        r.setAttribute('stroke', 'none');
        svgForSection.appendChild(r);
        const st = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        st.setAttribute('x', bx + bw / 2);
        st.setAttribute('y', by + bh - 2);
        st.setAttribute('text-anchor', 'middle');
        st.setAttribute('font-family', 'serif');
        st.setAttribute('font-weight', 'bold');
        st.setAttribute('font-size', 10);
        st.setAttribute('fill', '#fff');
        st.setAttribute('stroke', 'none');
        st.textContent = bar.section;
        svgForSection.appendChild(st);
      }

      // Quarter notes per beat (generated from chord scales).
      const beatPitches = quarterNotes[barIdx] || [];
      const notes = [];
      // Per-measure courtesy-accidental state. Keyed by "letter:octave" (the
      // specific staff position) so a courtesy only fires when the same line
      // or space was altered in the previous bar — not just the same letter
      // in a distant octave.
      const currMeasureSeen = {};       // "letter:octave" → level seen so far
      const ACC_GLYPH = { '-2': 'bb', '-1': 'b', '0': 'n', '1': '#', '2': '##' };
      // A new section (rehearsal letter) is a hard reset for the reader —
      // don't carry courtesy accidentals across it.
      if (bar.section) prevLastNote = null;
      let isFirstNoteOfBar = true;
      let lastNoteOfBar = null;

      // Walk the bar's beat slots. For beats whose pitch object has an
      // explicit `duration` (Cantus Firmus emits 'w'/'h.'/'h'/'q'), render
      // one long note and consume the subsequent beats it covers.
      // Pitch-but-no-duration slots render as quarters (the default for all
      // the other generators). Null slots become quarter rests.
      const DUR_TO_BEATS = { 'w': 4, 'h.': 3, 'h': 2, 'q': 1 };
      // For each beat in this bar, which entry of `notes[]` covers it?
      // Cantus firmus writes one long note across multiple beats, so the
      // same slot index can be referenced by several beats. Rests get -1.
      const beatToNoteSlot = new Array(ts.num).fill(-1);
      let b = 0;
      while (b < ts.num) {
        const bp = beatPitches[b];
        if (bp) {
          const dur = bp.duration || 'q';
          const consume = DUR_TO_BEATS[dur] || 1;
          const { key, letterIdx, level, octave } = midiTpcToVexKey(bp.pitch, bp.tpc);
          const posKey = letterIdx + ':' + octave;
          // Stem direction: on/above middle line of the staff → stem down,
          // below middle line → stem up. Bass-clef middle line is D3 (MIDI 50);
          // we render an octave up (8vb), so written MIDI = sounding + 12.
          // Therefore sounding MIDI >= 38 (D2) → stem down.
          const stemDir = bp.pitch >= 38 ? VF.Stem.DOWN : VF.Stem.UP;
          const n = new VF.StaveNote({ clef: 'bass', keys: [key], duration: dur, stem_direction: stemDir });

          // Decide whether to show an accidental on this note.
          const keyDefault = 0;
          let showLevel = null;
          if (!(posKey in currMeasureSeen)) {
            if (level !== keyDefault) {
              showLevel = level; // sharp/flat must always be drawn the first time
            } else if (isFirstNoteOfBar && prevLastNote &&
                       prevLastNote.posKey === posKey &&
                       prevLastNote.level !== keyDefault) {
              // Previous bar's last note was altered at this same staff
              // position and this first note is natural → courtesy natural.
              showLevel = 0;
            }
            currMeasureSeen[posKey] = level;
          } else if (currMeasureSeen[posKey] !== level) {
            showLevel = level;
            currMeasureSeen[posKey] = level;
          }
          if (showLevel !== null) {
            n.addModifier(new VF.Accidental(ACC_GLYPH[String(showLevel)]), 0);
          }
          lastNoteOfBar = { posKey, level };
          isFirstNoteOfBar = false;

          const slotIdx = notes.length;
          notes.push(n);
          for (let bb = b; bb < b + consume && bb < ts.num; bb++) {
            beatToNoteSlot[bb] = slotIdx;
          }
          b += consume;
        } else {
          notes.push(new VF.StaveNote({ clef: 'bass', keys: ['d/3'], duration: 'qr' }));
          b++;
        }
      }
      // Carry the last note of this bar to the next bar for the courtesy check.
      prevLastNote = lastNoteOfBar;
      const voice = new VF.Voice({ num_beats: ts.num, beat_value: ts.denom, resolution: VF.RESOLUTION });
      voice.setStrict(false);
      voice.addTickables(notes);
      const noteStart = stave.getNoteStartX();
      const noteEnd = stave.getNoteEndX();
      new VF.Formatter().joinVoices([voice]).format([voice], noteEnd - noteStart - 10);
      // Count the stavenote elements that already existed in this row's
      // SVG before the voice draws (previous bars in the row). After draw
      // we can slice off the newly-added ones.
      const beforeCount = rowEl.querySelectorAll('.vf-stavenote').length;
      voice.draw(context, stave);
      const allStaveNotes = rowEl.querySelectorAll('.vf-stavenote');
      const barNoteEls = Array.from(allStaveNotes).slice(beforeCount);

      // Manual chord symbol labels above the staff, evenly spaced over the note area.
      const svg = rowEl.querySelector('svg');
      // For Kcl/x "repeat prev measure" chains, walk backwards until we find a
      // bar that actually has chords so the label matches the generated notes.
      let displayChords = (bar.chords || []).filter(c => !c.slash);
      if (!displayChords.length && bar.repeatPrev) {
        let cursor = barIdx;
        while (cursor >= 0) {
          const b = bars[cursor];
          const cs = (b.chords || []).filter(c => !c.slash);
          if (cs.length) { displayChords = cs; break; }
          if (!b.repeatPrev || cursor - b.repeatPrev < 0) break;
          cursor -= b.repeatPrev;
        }
      }
      const labelAreaX0 = noteStart;
      const labelAreaW = noteEnd - noteStart;
      {
        const n = Math.max(1, displayChords.length);
        displayChords.forEach((ch, ci) => {
          // Chord label is anchored at the beat the chord falls on — chord ci
          // of n starts at fraction ci/n of the note area (so a single chord
          // sits at the left, two chords at beats 1 and 3, etc.)
          const cx = labelAreaX0 + (ci / n) * labelAreaW;
          const cy = staffY - 6;
          const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
          t.setAttribute('x', cx);
          t.setAttribute('y', cy);
          t.setAttribute('text-anchor', 'start');
          t.setAttribute('font-family', 'serif');
          t.setAttribute('font-size', 15);
          t.setAttribute('fill', '#000');
          t.setAttribute('stroke', 'none');
          // Wrap flats in a <tspan> with negative dx/dx after so the
          // ♭ glyph doesn't sit inside a wide metric box on Android.
          appendChordLabelTspans(t, chordText(ch));
          svg.appendChild(t);
        });
      }

      // Track bar geometry for the per-row pattern overlay drawn after the loop
      barPosInRow.push({
        barIdx,
        noteStartX: stave.getNoteStartX(),
        noteEndX: stave.getNoteEndX()
      });

      // Record bounds for highlighting. Extend the highlight down past the
      // lowest F on the staff to just above the scale-line text.
      // Highlight height runs from just above the staff all the way down
      // past the scale label and underline, so the current-measure blue
      // wash visibly covers both the staff and the key label under it.
      barElements[barIdx] = {
        rowEl, x, y: staffY, w: width,
        h: patternLineY + 3 - (staffY - 4),
        noteStartX: stave.getNoteStartX(),
        noteEndX: stave.getNoteEndX(),
        noteEls: barNoteEls,
        beatToNoteSlot
      };

      x += width;
    });

    // Bar click handling: listen on the row container instead of stamping
    // invisible <rect>s into the SVG for each bar. That keeps the DOM clean
    // — no overlay rects to confuse dev-tools selection or pick up stray
    // browser hover/focus styling.
    rowEl.style.cursor = 'pointer';
    const rowStartLocal = rowStart;
    const rowBarHits = rowBars.map((_, i) => barElements[rowStartLocal + i]);
    rowEl.addEventListener('click', (ev) => {
      const svgRect = rowEl.querySelector('svg');
      if (!svgRect) return;
      // Convert the click's client X into SVG viewBox coordinates so we can
      // match it against each bar's recorded x/w (which are in viewBox units).
      const r = svgRect.getBoundingClientRect();
      const vbAttr = svgRect.getAttribute('viewBox');
      if (!vbAttr) return;
      const vbW = parseFloat(vbAttr.split(/\s+/)[2]);
      const svgX = (ev.clientX - r.left) * (vbW / r.width);
      for (let i = 0; i < rowBarHits.length; i++) {
        const info = rowBarHits[i];
        if (!info) continue;
        if (svgX >= info.x && svgX < info.x + info.w) {
          selectBar(rowStartLocal + i);
          break;
        }
      }
    });

    // Draw pattern overlays (bold key name + underline spanning the pattern).
    // For patterns that cross row boundaries, each row draws its own segment.
    const rowSvg = rowEl.querySelector('svg');
    const rowFirstBar = rowStart;
    const rowLastBar = rowStart + rowBars.length - 1;
    patterns.forEach(pat => {
      const firstCE = chordEvents[pat.firstIdx];
      const lastCE = chordEvents[pat.lastIdx];
      const patFirst = firstCE.barIdx;
      const patLast = lastCE.barIdx;
      const iFirst = Math.max(rowFirstBar, patFirst);
      const iLast = Math.min(rowLastBar, patLast);
      if (iFirst > iLast) return;
      const leftBar = barPosInRow.find(b => b.barIdx === iFirst);
      const rightBar = barPosInRow.find(b => b.barIdx === iLast);
      if (!leftBar || !rightBar) return;
      const isPatternStart = iFirst === patFirst;
      const isPatternEnd = iLast === patLast;
      // Position the line at the specific chord within each bar — otherwise
      // a V-I that straddles a bar line looks like it covers the whole bar.
      let startX = leftBar.noteStartX;
      if (isPatternStart && firstCE.chordsInBar > 1) {
        const w = (leftBar.noteEndX - leftBar.noteStartX) / firstCE.chordsInBar;
        startX = leftBar.noteStartX + firstCE.chordIdxInBar * w;
      }
      let endX = rightBar.noteEndX;
      if (isPatternEnd && lastCE.chordsInBar > 1) {
        const w = (rightBar.noteEndX - rightBar.noteStartX) / lastCE.chordsInBar;
        endX = rightBar.noteStartX + (lastCE.chordIdxInBar + 1) * w;
      }
      const color = colorFor(pat.keyName);

      // Pull the horizontal line in by a small margin on each side so
      // two patterns that butt up against each other have a visible
      // gap between their underlines (instead of looking like one
      // continuous line of mixed colors).
      const GAP = 2;
      const TICK_HEIGHT = 6; // tick extends this many px ABOVE the line only
      const lineStartX = startX + GAP;
      const lineEndX   = endX   - GAP;

      // Horizontal underline for the pattern.
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', lineStartX);
      line.setAttribute('y1', patternLineY);
      line.setAttribute('x2', lineEndX);
      line.setAttribute('y2', patternLineY);
      line.setAttribute('stroke', color);
      line.setAttribute('stroke-width', 2);
      line.setAttribute('stroke-linecap', 'round');
      rowSvg.appendChild(line);

      // Vertical ticks ONLY at the true start and end of the whole
      // pattern — not at every row-boundary segment. If a pattern
      // continues onto a new row, the left tick is suppressed there
      // (and similarly for the right tick on the row the pattern
      // continues from). Result: ⌐─────  ──────┐  where the middle
      // rows have no tick, and only the outermost row-ends carry one.
      const ticks = [];
      if (isPatternStart) ticks.push(lineStartX);
      if (isPatternEnd)   ticks.push(lineEndX);
      ticks.forEach(tx => {
        const tick = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        tick.setAttribute('x1', tx);
        tick.setAttribute('y1', patternLineY - TICK_HEIGHT);
        tick.setAttribute('x2', tx);
        tick.setAttribute('y2', patternLineY);
        tick.setAttribute('stroke', color);
        tick.setAttribute('stroke-width', 2);
        tick.setAttribute('stroke-linecap', 'round');
        rowSvg.appendChild(tick);
      });

      // Key-name text just under the line, aligned with the measure's left
      // edge — only on the row where the pattern actually starts. Shifted
      // a few pixels past the left tick so they don't collide.
      if (isPatternStart) {
        const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        t.setAttribute('x', lineStartX + 4);
        t.setAttribute('y', patternTextY);
        t.setAttribute('text-anchor', 'start');
        t.setAttribute('font-family', 'serif');
        t.setAttribute('font-weight', 'bold');
        t.setAttribute('font-size', 16);
        t.setAttribute('fill', color);
        // VexFlow's SVG context sets a default stroke, which produces a
        // black outline around bold glyphs. Force stroke:none so the whole
        // text is filled with `color`.
        t.setAttribute('stroke', 'none');
        setSvgTextWithFlatFix(t, pat.keyName);
        rowSvg.appendChild(t);
      }
    });

    // Insert measure number text
    const svgEl = rowEl.querySelector('svg');
    if (svgEl) {
      svgEl.appendChild(num);
      // Make the SVG scale responsively: use viewBox + remove fixed width/height
      svgEl.setAttribute('viewBox', `0 0 ${rowWidth} ${staffHeight}`);
      svgEl.setAttribute('preserveAspectRatio', 'xMidYMid meet');
      svgEl.removeAttribute('width');
      svgEl.removeAttribute('height');
      // VexFlow sets inline width/height styles — clear them so CSS can scale
      svgEl.style.width = '100%';
      svgEl.style.height = 'auto';

      // Thicken VexFlow's 1-unit staff lines and barlines so they stay
      // readable when the SVG is scaled down on a phone. We do this in
      // geometry (rect height / width) rather than CSS stroke, because
      // the rects have no stroke by default and a stroke on a thin filled
      // rect doesn't always render reliably across browsers.
      const LINE_MUL = 2.2;
      svgEl.querySelectorAll('.vf-stave rect').forEach(r => {
        const h = parseFloat(r.getAttribute('height') || '1');
        const y = parseFloat(r.getAttribute('y') || '0');
        const newH = h * LINE_MUL;
        r.setAttribute('height', newH);
        r.setAttribute('y', y - (newH - h) / 2);
      });
      svgEl.querySelectorAll('.vf-stavebarline rect').forEach(r => {
        const w = parseFloat(r.getAttribute('width') || '1');
        // Only thicken the thin single-barline rects; leave the wider
        // repeat/end barline rectangles alone.
        if (w > 2) return;
        const x = parseFloat(r.getAttribute('x') || '0');
        const newW = w * LINE_MUL;
        r.setAttribute('width', newW);
        r.setAttribute('x', x - (newW - w) / 2);
      });

      // SVG layering is by document order — later siblings paint on top.
      // When multiple staves live in one row, stave-2's horizontal lines
      // are drawn after stave-1's barline and can paint over it at the
      // intersection. Re-append every barline group to the end of the SVG
      // so barlines sit on top of all staff lines.
      svgEl.querySelectorAll('.vf-stavebarline').forEach(g => svgEl.appendChild(g));
    }

    // Add a horizontal separator between full-form repeats.
    if (rowEnd === passBoundary && passBoundary < bars.length) {
      const sep = document.createElement('div');
      sep.className = 'form-separator';
      chartEl.appendChild(sep);
    }
    rowStart = rowEnd;
  }

  // Seed the info panel with the first bar's chord/scale so the scale SVG
  // and fingerboard have something to draw even before playback starts.
  refreshFingerboardForBar(0);

  // Preserve loop brackets across re-renders (options panel changes, etc.),
  // but drop any endpoint that's now out of range for the new bar count.
  const totalBars = bars.length;
  if (loopIn != null && loopIn >= totalBars) loopIn = null;
  if (loopOut != null && loopOut >= totalBars) loopOut = null;
  redrawLoopBrackets();
}

// ===== Chord-to-notes =====
const NOTE_MAP = { C:0, D:2, E:4, F:5, G:7, A:9, B:11 };
function pcFromRoot(root) {
  const m = root.match(/^([A-G])([#b]?)$/);
  if (!m) return 0;
  let pc = NOTE_MAP[m[1]];
  if (m[2] === '#') pc++; else if (m[2] === 'b') pc--;
  return ((pc % 12) + 12) % 12;
}
// Chord pitch class: the parser stores the root as a single letter and keeps
// the accidental as the first char of rest (e.g. Bb^7 → root='B', rest='b^7').
// Combine them here so playback uses the correct root.
function pcFromChord(ch) {
  let pc = NOTE_MAP[ch.root];
  if (pc === undefined) return 0;
  const rest = ch.rest || '';
  if (rest[0] === '#') pc++;
  else if (rest[0] === 'b') pc--;
  return ((pc % 12) + 12) % 12;
}
// Return intervals from root (semitones) for the chord voicing
function intervalsFor(rest) {
  const s = rest || '';
  const has = (p) => s.includes(p);
  const matchAlt = (interval) => {
    // returns true if rest has #interval or bInterval via regex
    return { sharp: new RegExp('#' + interval).test(s), flat: new RegExp('b' + interval).test(s) };
  };

  // determine quality
  let third = 4; // major by default
  let fifth = 7;
  let seventh = null; // null = no 7
  const ivs = new Set();

  if (has('-') || /m(?!aj)/.test(s)) third = 3;
  if (has('h')) { third = 3; fifth = 6; seventh = 10; } // half-dim m7b5
  if (has('o')) { third = 3; fifth = 6; seventh = 9; } // dim7
  if (has('+')) { fifth = 8; }
  if (has('sus2')) { third = 2; }
  else if (has('sus')) { third = 5; } // sus4

  // 7th: ^ => maj7, -^ => min-maj, plain numeric => dom7 if 7
  const hasMaj = has('^');
  const num = s.match(/(\d+)/);
  const n = num ? parseInt(num[1], 10) : null;
  if (n === 7 || n === 9 || n === 11 || n === 13) {
    seventh = hasMaj ? 11 : 10;
    if (third === 3 && hasMaj) seventh = 11; // min-maj7
    if (has('o') && !hasMaj) seventh = 9; // dim7 already set
  } else if (n === 6) {
    seventh = 9; // 6th chord: add 6
  } else if (hasMaj) {
    seventh = 11;
  }

  // alterations on 5
  const alt5 = matchAlt('5');
  if (alt5.sharp) fifth = 8;
  if (alt5.flat) fifth = 6;

  ivs.add(0);
  ivs.add(third);
  ivs.add(fifth);
  if (seventh !== null) ivs.add(seventh);

  // Extensions
  if (n === 9 || has('b9') || has('#9') || /(?<!\d)9/.test(s)) {
    let ninth = 14;
    if (/#9/.test(s)) ninth = 15;
    if (/b9/.test(s)) ninth = 13;
    ivs.add(ninth);
  }
  if (n === 11 || has('#11')) {
    let eleventh = 17;
    if (has('#11')) eleventh = 18;
    ivs.add(eleventh);
  }
  if (n === 13 || has('b13')) {
    let thirteenth = 21;
    if (has('b13')) thirteenth = 20;
    ivs.add(thirteenth);
    // 13 implies 7
    if (seventh === null) ivs.add(10);
  }

  return Array.from(ivs).sort((a,b) => a-b);
}
function chordNotes(ch, octave = 4) {
  if (ch.nc || ch.slash) return null;
  const pc = pcFromChord(ch);
  const ivs = intervalsFor(ch.rest || '');
  // Build MIDI pitch numbers around given octave
  const rootMidi = 12 * (octave + 1) + pc; // C4 = 60
  return ivs.map(i => rootMidi + i);
}

// Jazz voicing: full chord (root + 3/5/7) with an optional random tension,
// in close voicing around the middle of the piano, randomized inversions.
function jazzVoicing(ch) {
  if (!ch || ch.nc || ch.slash) return null;
  const pc = pcFromChord(ch);
  const ivs = intervalsFor(ch.rest || '');
  // Keep root + chord tones in one octave, plus up to one higher tension
  const chordTones = ivs.filter(i => i < 12);
  const tensions = ivs.filter(i => i >= 12);
  let intervals = [...chordTones];
  if (tensions.length) {
    intervals.push(tensions[Math.floor(Math.random() * tensions.length)]);
  }
  intervals = intervals.slice(0, 5);
  // Place the root in the low-middle piano register (C3..B3)
  const rootMidi = 12 * 4 + pc;
  let notes = intervals.map(i => rootMidi + i);
  // Random inversion: rotate bottom note(s) up an octave
  const inv = Math.floor(Math.random() * Math.min(notes.length, 3));
  for (let k = 0; k < inv; k++) {
    const bottom = notes.shift();
    notes.push(bottom + 12);
  }
  notes.sort((a, b) => a - b);
  return notes;
}

// Comping rhythm patterns. Each entry is a list of 16th-note offsets (0..15) within a 4/4 bar.
const COMPING_PATTERNS = [
  [0, 6, 12],          // 1, and-of-2, 4
  [2, 8],              // and-of-1, 3
  [0, 4, 10],          // 1, 2, and-of-3
  [6, 14],             // and-of-2, and-of-4
  [0, 14],             // 1, and-of-4
  [0, 8],              // 1, 3
  [6, 10],             // and-of-2, and-of-3
  [4, 12],             // 2, 4 (Freddie Green feel)
  [0, 6, 10, 14],      // 1, &2, &3, &4
  [2, 6, 10, 14],      // all ands
  [0, 4, 8, 12],       // every beat
  [0, 6],              // 1, and-of-2
  [6, 8, 14],          // &2 3 &4
  [2, 10],             // &1, &3
];
function bassNote(ch, octave = 2) {
  if (ch.nc || ch.slash) return null;
  const pc = ch.bass ? pcFromRoot(ch.bass) : pcFromChord(ch);
  return 12 * (octave + 1) + pc;
}
function midiToName(m) {
  const names = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  const n = names[m % 12];
  const o = Math.floor(m / 12) - 1;
  return n + o;
}

// ===== Tone.js playback =====
let transport, piano, hat, rideBody, rideBell, rideNoise, click, drumsOut;
let realHihat, brushSweep, brushTap;
// Real drum loops, looped via the Transport. Each entry records the source
// bpm so playbackRate can be adapted if the user-selected tempo differs.
const realLoops = {};  // key "ballad-4/4" → { player, sourceBpm }
let currentRealLoop = null;
let drumMode = 'ride'; // 'hat' | 'ride' | 'click'
let countInBars = 0;  // 0, 1, or 2 measures of click before the song starts
let playbackPart;
let playState = 'stopped'; // 'stopped' | 'playing' | 'paused'
let pauseContext = null;   // { offset, beatsPerBar } captured at startPlayback; used by resume
let currentPlaylist = []; // sequence of { bar, idx } one entry = one bar
let currentBeatHighlight = null;
let selectedBar = null;   // user-tapped bar index; when set, play starts here
let loopIn = null;        // inclusive start bar of practice loop (null = no loop)
let loopOut = null;       // inclusive end bar of practice loop (null = no loop)
let currentPlayingBar = 0; // latest bar index the Part's barStart event fired for

async function initAudio() {
  if (piano) return;
  await Tone.start();
  const reverb = new Tone.Reverb({ decay: 2.2, wet: 0.18 }).toDestination();

  // Salamander Grand Piano samples hosted by the Tone.js project
  piano = new Tone.Sampler({
    urls: {
      A0: 'A0.mp3', C1: 'C1.mp3', 'D#1': 'Ds1.mp3', 'F#1': 'Fs1.mp3',
      A1: 'A1.mp3', C2: 'C2.mp3', 'D#2': 'Ds2.mp3', 'F#2': 'Fs2.mp3',
      A2: 'A2.mp3', C3: 'C3.mp3', 'D#3': 'Ds3.mp3', 'F#3': 'Fs3.mp3',
      A3: 'A3.mp3', C4: 'C4.mp3', 'D#4': 'Ds4.mp3', 'F#4': 'Fs4.mp3',
      A4: 'A4.mp3', C5: 'C5.mp3', 'D#5': 'Ds5.mp3', 'F#5': 'Fs5.mp3',
      A5: 'A5.mp3', C6: 'C6.mp3', 'D#6': 'Ds6.mp3', 'F#6': 'Fs6.mp3',
      A6: 'A6.mp3', C7: 'C7.mp3'
    },
    release: 1.2,
    baseUrl: 'https://tonejs.github.io/audio/salamander/',
    volume: -6
  }).connect(reverb);
  document.getElementById('status').textContent = 'Loading samples…';

  // Shared drum bus so a single slider controls all drum volumes
  const initVol = parseInt(document.getElementById('drumVol').value, 10) / 100;
  drumsOut = new Tone.Gain(isFinite(initVol) ? initVol : 0.75).toDestination();

  const hatFilter = new Tone.Filter({ type: 'highpass', frequency: 7000, Q: 0.8 }).connect(drumsOut);
  hat = new Tone.NoiseSynth({
    noise: { type: 'white' },
    envelope: { attack: 0.001, decay: 0.06, sustain: 0, release: 0.05 },
    volume: -6
  }).connect(hatFilter);

  // Metronome click: short high-pass-filtered noise burst. Pre-filter level
  // is cranked so the click sits at roughly the same perceived loudness as
  // the sampled hat/ride — the very short decay and narrow high-pass
  // frequency band need a lot of gain to read as "present" on the bus.
  const clickFilter = new Tone.Filter({ type: 'highpass', frequency: 2500, Q: 0.8 }).connect(drumsOut);
  click = new Tone.NoiseSynth({
    noise: { type: 'white' },
    envelope: { attack: 0.0001, decay: 0.04, sustain: 0, release: 0.01 },
    volume: 6
  }).connect(clickFilter);

  // Ride cymbal = body (long metallic wash) + bell (bright ping) + noise shimmer
  const rideVerb = new Tone.Reverb({ decay: 1.4, wet: 0.2 }).connect(drumsOut);
  rideBody = new Tone.MetalSynth({
    frequency: 220,
    envelope: { attack: 0.001, decay: 1.2, release: 0.6 },
    harmonicity: 5.1,
    modulationIndex: 48,
    resonance: 4500,
    octaves: 1.6,
    volume: -22
  }).connect(rideVerb);
  rideBell = new Tone.MetalSynth({
    frequency: 560,
    envelope: { attack: 0.001, decay: 0.18, release: 0.1 },
    harmonicity: 8,
    modulationIndex: 30,
    resonance: 7500,
    octaves: 0.8,
    volume: -26
  }).connect(rideVerb);
  const rideHP = new Tone.Filter({ type: 'highpass', frequency: 5000, Q: 1.2 }).connect(drumsOut);
  rideNoise = new Tone.NoiseSynth({
    noise: { type: 'white' },
    envelope: { attack: 0.001, decay: 0.35, sustain: 0.05, release: 0.6 },
    volume: -30
  }).connect(rideHP);

  // Real drum samples from the Tone.js acoustic drum kit (CORS-friendly).
  // Used by the "Real" drum mode, which picks a pattern based on tempo tier.
  const drumBase = 'https://tonejs.github.io/audio/drum-samples/acoustic-kit/';
  realHihat = new Tone.Sampler({
    urls: { C4: 'hihat.mp3' },
    baseUrl: drumBase,
    volume: -2
  }).connect(drumsOut);

  // Brush layer: synthesized with pink noise (the continuous sweep) and white
  // noise (the sharper tap), routed through filters so they sit in the right
  // frequency band on top of the bus.
  const brushSweepFilter = new Tone.Filter({ type: 'bandpass', frequency: 2600, Q: 0.8 }).connect(drumsOut);
  brushSweep = new Tone.NoiseSynth({
    noise: { type: 'pink' },
    envelope: { attack: 0.06, decay: 0.35, sustain: 0, release: 0.25 },
    volume: -8
  }).connect(brushSweepFilter);
  const brushTapFilter = new Tone.Filter({ type: 'highpass', frequency: 3500, Q: 0.7 }).connect(drumsOut);
  brushTap = new Tone.NoiseSynth({
    noise: { type: 'white' },
    envelope: { attack: 0.001, decay: 0.12, sustain: 0, release: 0.08 },
    volume: -6
  }).connect(brushTapFilter);

  // Real drum loops. Add an entry per {tier, timesig}. Each loop is seamless
  // across its full duration (must be an exact whole number of bars) and is
  // played back on the Transport so it stays phase-locked with the song.
  // Each loop declares the number of beats (bars × beats-per-bar) it contains.
  // That's all we need — the true source bpm is derived from the file's
  // actual duration, so minor cropping errors can't drift the loop out of
  // sync: playbackRate compensates automatically and the loop plays for
  // exactly N beats at the Transport tempo.
  realLoops['ballad-4/4'] = {
    player: new Tone.Player({
      url: 'drums/ballad-4-4-80bpm.mp3',
      loop: true, autostart: false, fadeIn: 0.005, fadeOut: 0.005, volume: 0
    }).connect(drumsOut),
    beats: 16 // 4 bars of 4/4
  };
  realLoops['medium-4/4'] = {
    player: new Tone.Player({
      url: 'drums/medium-4-4-120bpm.mp3',
      loop: true, autostart: false, fadeIn: 0.005, fadeOut: 0.005, volume: 0
    }).connect(drumsOut),
    beats: 16 // 4 bars of 4/4
  };
  realLoops['up-4/4'] = {
    player: new Tone.Player({
      url: 'drums/up-4-4-180bpm.mp3',
      loop: true, autostart: false, fadeIn: 0.005, fadeOut: 0.005, volume: 0
    }).connect(drumsOut),
    beats: 16 // 4 bars of 4/4
  };

  await Tone.loaded();
  document.getElementById('status').textContent = 'Ready';
}

function stopPlayback() {
  if (playbackPart) { playbackPart.stop(); playbackPart.dispose(); playbackPart = null; }
  if (currentRealLoop) {
    try { currentRealLoop.player.stop(); currentRealLoop.player.unsync(); } catch (e) {}
    currentRealLoop = null;
  }
  Tone.Transport.stop();
  Tone.Transport.cancel();
  Tone.Transport.position = 0;
  playState = 'stopped';
  pauseContext = null;
  const btn = document.getElementById('playBtn');
  btn.querySelector('.play-glyph').textContent = '▶';
  btn.classList.remove('playing');
  clearHighlight();
  clearNoteHighlight();
  updateLoopControls();
  updateChordNav();
}

function pausePlayback() {
  if (playState !== 'playing') return;
  // Tone.Player has no pause, so stop it; we'll restart it at the right
  // buffer offset on resume. The Part and all scheduled events naturally
  // pause with the Transport.
  if (currentRealLoop) {
    try { currentRealLoop.player.stop(); } catch (e) {}
  }
  Tone.Transport.pause();
  playState = 'paused';
  const btn = document.getElementById('playBtn');
  btn.querySelector('.play-glyph').textContent = '▶';
  btn.classList.remove('playing');
  document.getElementById('status').textContent = 'Paused';
  updateLoopControls();
  updateChordNav();
}

function resumePlayback() {
  if (playState !== 'paused') return;
  // If we have an active drum loop, re-align it to Transport position.
  // Count-in bars are the part of Transport before the song proper starts.
  if (currentRealLoop && pauseContext) {
    const entry = currentRealLoop;
    const { offset, beatsPerBar } = pauseContext;
    if (entry.player.loaded && entry.player.buffer) {
      const transportSec = Tone.Transport.seconds;
      const countInSec = (offset * beatsPerBar * 60) / currentTempo;
      if (transportSec >= countInSec) {
        // Already past count-in: start the loop immediately at the right
        // offset into the buffer so it picks up mid-loop where we left off.
        const rate = entry.player.playbackRate;
        const loopLenSec = entry.player.buffer.duration / rate;
        const songSec = transportSec - countInSec;
        const bufOffsetSec = (songSec % loopLenSec) * rate;
        try { entry.player.start(undefined, bufOffsetSec); } catch (e) {}
      } else {
        // Still in count-in: schedule the loop to start at song bar 0
        // (same as the initial launch).
        Tone.Transport.scheduleOnce(t => {
          try { entry.player.start(t); } catch (e) {}
        }, `${offset}:0:0`);
      }
    }
  }
  Tone.Transport.start();
  playState = 'playing';
  const btn = document.getElementById('playBtn');
  btn.querySelector('.play-glyph').textContent = '⏸';
  btn.classList.add('playing');
  document.getElementById('status').textContent = 'Playing';
  updateLoopControls();
  updateChordNav();
}

function clearHighlight() {
  document.querySelectorAll('svg .hi-overlay').forEach(el => el.remove());
}

// ===== Current-note highlight in the score =====
// Paint the currently-playing note's stavenote group blue so the reader
// can track it, same way the scale diagram in the note-info panel lights
// up its current note. The CSS rule for `.vf-stavenote.lit` forces fill
// and stroke to the playback-highlight blue.
let lastLitNoteEl = null;
function clearNoteHighlight() {
  if (lastLitNoteEl) lastLitNoteEl.classList.remove('lit');
  lastLitNoteEl = null;
}
function updateNoteHighlight(barIdx, beat) {
  // Per-note highlight disabled — the current-measure blue wash is
  // enough visual guidance, and a second blue tint on the note head
  // was noisy. Kept as a no-op so the rest of the playback loop can
  // still call it without a null check.
  if (lastLitNoteEl) lastLitNoteEl.classList.remove('lit');
  lastLitNoteEl = null;
}

// Draw a practice-loop bracket on the specified bar. `side` is "in" (hollow
// bracket on the left edge) or "out" (thicker bracket on the right edge).
// Drawn as an SVG <path> on the row's SVG so it scales with the viewBox.
function drawLoopBracket(barIdx, side) {
  const info = barElements[barIdx];
  if (!info) return;
  const svg = info.rowEl.querySelector('svg');
  if (!svg) return;
  const armLen = 14;
  const yTop = info.y - 4;
  const yBot = info.y + info.h - 2;
  let d;
  if (side === 'in') {
    const x = info.x + 2;
    d = `M ${x + armLen} ${yTop} L ${x} ${yTop} L ${x} ${yBot} L ${x + armLen} ${yBot}`;
  } else {
    const x = info.x + info.w - 2;
    d = `M ${x - armLen} ${yTop} L ${x} ${yTop} L ${x} ${yBot} L ${x - armLen} ${yBot}`;
  }
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', d);
  path.setAttribute('class', 'loop-bracket loop-' + side);
  svg.appendChild(path);
}
function clearLoopBrackets() {
  document.querySelectorAll('svg .loop-bracket').forEach(el => el.remove());
}
function redrawLoopBrackets() {
  clearLoopBrackets();
  if (loopIn != null) drawLoopBracket(loopIn, 'in');
  if (loopOut != null) drawLoopBracket(loopOut, 'out');
  updateLoopControls();
}

// Keep UI elements that depend on loop state in sync:
//   - Loop-in / loop-out need a selected bar to know which measure to mark,
//     and are disabled while playback is running (editing the loop mid-play
//     would re-seed the Part and cause audible jumps).
//   - Clear-loop button is disabled when there's no loop or while playing.
//   - Play button shows a small loop glyph when both brackets are placed.
function updateLoopControls() {
  const playing = playState === 'playing';
  const noSelection = selectedBar == null;
  const loopInBtn = document.getElementById('loopInBtn');
  const loopOutBtn = document.getElementById('loopOutBtn');
  if (loopInBtn) loopInBtn.disabled = playing || noSelection;
  if (loopOutBtn) loopOutBtn.disabled = playing || noSelection;
  const clearBtn = document.getElementById('clearLoopBtn');
  if (clearBtn) clearBtn.disabled = playing || (loopIn == null && loopOut == null);
  const playBtn = document.getElementById('playBtn');
  if (playBtn) {
    const hasLoop = loopIn != null && loopOut != null && loopIn <= loopOut;
    playBtn.classList.toggle('has-loop', hasLoop);
  }
}

// Push the current loopIn/loopOut values into the running Part so that any
// change the user makes during playback (set, move, or clear a bracket)
// takes effect immediately. When not playing, we just cache the values and
// let the next startPlayback pick them up. When playing, we restart the
// Part from the currently-playing bar — mutating Part.loopEnd in-flight
// leaves the Part's internal scheduler in an inconsistent state (it'll
// jump ahead by some multiple of the old loop length), so a clean restart
// at the same bar is the reliable way to update the loop range.
function applyLoopBoundsToPart() {
  const hasLoop = loopIn != null && loopOut != null && loopIn <= loopOut;
  // Audible current bar, clamped into the new loop range so a brand-new
  // loop doesn't leave the playhead stranded outside its bounds.
  let resumeBar = currentPlayingBar;
  if (hasLoop && (resumeBar < loopIn || resumeBar > loopOut)) resumeBar = loopIn;

  if (playState === 'playing' && window.currentSong) {
    // Restart cleanly at the audible bar — mutating Part.loopEnd while the
    // Part is in flight leaves its internal scheduler inconsistent and can
    // make playback jump forward.
    const expanded = expandBarsByRepeats(window.currentSong.bars, songRepeats);
    startPlayback(window.currentSong.song, expanded, resumeBar);
    return;
  }
  if (playState === 'paused' && playbackPart) {
    // Part is built but Transport is paused. It's safe to mutate the Part
    // directly here, but we also need to snap Tone.Transport.position back
    // to the audible bar: it's been climbing monotonically through loop
    // cycles, so just "resume" would leave the Part mapping the stale
    // Transport time through the new (longer) loop and jumping forward.
    const totalBars = currentPlaylist ? currentPlaylist.length : 0;
    playbackPart.loopStart = hasLoop ? `${loopIn}:0:0` : 0;
    playbackPart.loopEnd = hasLoop
      ? `${loopOut + 1}:0:0`
      : (totalBars > 0 ? `${totalBars}:0:0` : playbackPart.loopEnd);
    const offset = (pauseContext && pauseContext.offset) || 0;
    Tone.Transport.position = `${offset + resumeBar}:0:0`;
  }
}

// Walk a bar's beatInfo and return the start-beat of each distinct
// chord in the bar (by chord symbol). For a one-chord bar this is just
// [firstNonNullBeat]; for a bar with two chords it's two beats, etc.
function chordStartBeatsForBar(idx) {
  const bar = lastBeatInfo && lastBeatInfo[idx];
  if (!bar) return [];
  const starts = [];
  let lastSymbol = null;
  for (let b = 0; b < bar.length; b++) {
    const info = bar[b];
    if (!info) continue;
    if (info.chordSymbol !== lastSymbol) {
      starts.push(b);
      lastSymbol = info.chordSymbol;
    }
  }
  return starts;
}

// Which chord index within the currently-selected bar is shown in the
// note-info panel. Reset to 0 on every bar selection and advanced by
// the Prev/Next buttons below the fb-left column.
let selectedChordIdxInBar = 0;

// Push a specific beat-info from the given bar into the note info
// panel. When `beatInChord` is omitted we pick the first non-null beat
// in the bar (matches the pre-existing "seed the panel" behavior).
function refreshFingerboardForBar(idx, beatInBar) {
  const bar = lastBeatInfo && lastBeatInfo[idx];
  const info = (beatInBar != null && bar && bar[beatInBar])
    ? bar[beatInBar]
    : (bar && bar.find(b => b));
  if (!info) return;
  const measurePitches = bar.map(b => b && b.pitch).filter(p => p != null);
  updateFingerboard({
    litMidis: [],
    scalePcs: info.scalePcs,
    chordTonesByPc: info.chordTonesByPc,
    chordSymbol: info.chordSymbol,
    chordNotesLabel: info.chordNotesLabel,
    scaleLabel: info.scaleLabel,
    useFlats: info.useFlats,
    scaleRoot: info.scaleRoot,
    scaleIntervals: info.scaleIntervals,
    chordRoot: info.chordRoot,
    measurePitches
  });
}

// Show/hide and enable/disable the Prev/Next chord buttons based on
// how many distinct chords the currently-selected bar has and which
// one is currently displayed. Hidden entirely for 1-chord bars.
function updateChordNav() {
  const nav  = document.getElementById('fbChordNav');
  const prev = document.getElementById('fbChordPrev');
  const next = document.getElementById('fbChordNext');
  if (!nav || !prev || !next) return;
  // Only shown while stopped or paused. During playback the panel
  // updates per-beat automatically — the buttons would fight the
  // incoming beat events.
  if (playState === 'playing' || selectedBar == null) {
    nav.hidden = true;
    return;
  }
  const starts = chordStartBeatsForBar(selectedBar);
  if (starts.length <= 1) { nav.hidden = true; return; }
  nav.hidden = false;
  // Clamp the chord index in case the bar changed under us.
  if (selectedChordIdxInBar < 0) selectedChordIdxInBar = 0;
  if (selectedChordIdxInBar >= starts.length) selectedChordIdxInBar = starts.length - 1;
  prev.disabled = selectedChordIdxInBar === 0;
  next.disabled = selectedChordIdxInBar === starts.length - 1;
}
(function bindChordNav() {
  const prev = document.getElementById('fbChordPrev');
  const next = document.getElementById('fbChordNext');
  if (!prev || !next) return;
  const step = (delta) => {
    if (selectedBar == null) return;
    const starts = chordStartBeatsForBar(selectedBar);
    if (starts.length <= 1) return;
    const newIdx = selectedChordIdxInBar + delta;
    if (newIdx < 0 || newIdx >= starts.length) return;
    selectedChordIdxInBar = newIdx;
    refreshFingerboardForBar(selectedBar, starts[newIdx]);
    updateChordNav();
  };
  prev.addEventListener('click', () => step(-1));
  next.addEventListener('click', () => step(+1));
})();

// User tapped a bar in the score. Stow it as the next playback start point,
// paint the blue highlight, and update the note-info panel to reflect that
// bar's chord/scale.
//   - While playing: immediately jump playback to that bar (restarts the
//     Transport so the drum-loop phase re-aligns cleanly).
//   - While paused: discard the pause state so the next play starts fresh
//     from the tapped bar rather than resuming where we paused.
//   - While stopped: just remember the selection and repaint the highlight.
// While a loop is active AND playback is running, taps outside the loop
// range are ignored so the user can't jump playback into a bar the loop
// wouldn't play (which would otherwise cause confused/silent audio).
// When paused or stopped, any bar is selectable — the user might want to
// move the selection (e.g. to set a new Loop In / Loop Out) even if it's
// outside the current loop.
function selectBar(idx) {
  const hasLoop = loopIn != null && loopOut != null && loopIn <= loopOut;
  if (hasLoop && playState === 'playing' && (idx < loopIn || idx > loopOut)) return;
  selectedBar = idx;
  updateLoopControls();
  if (playState === 'playing') {
    if (!window.currentSong) return;
    const expanded = expandBarsByRepeats(window.currentSong.bars, songRepeats);
    // Fire-and-forget: startPlayback is async only for initAudio(), which
    // has already resolved by the time we're playing. The first barStart /
    // beat events on the new bar will repaint the highlight and info panel,
    // so we don't need to do it here.
    startPlayback(window.currentSong.song, expanded, idx);
    return;
  }
  if (playState === 'paused') stopPlayback();
  highlightBar(idx);
  // New bar selection → reset the chord nav to the first chord in
  // the bar. The prev/next buttons let the user step through the
  // remaining chords without starting playback.
  selectedChordIdxInBar = 0;
  refreshFingerboardForBar(idx);
  updateChordNav();
}
function highlightBar(idx) {
  clearHighlight();
  const info = barElements[idx];
  if (!info) return;
  const svg = info.rowEl.querySelector('svg');
  if (!svg) return;
  const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  rect.setAttribute('class', 'hi-overlay');
  rect.setAttribute('x', info.x);
  // Extend the top of the highlight above the staff so it covers the
  // chord-symbol labels that sit at y ≈ staffY − 6. Baseline of that label
  // is 6 px above the staff and it's ~14 px tall, so reaching ~20 px above
  // info.y gets the whole label strip inside the blue wash.
  const TOP_EXTEND = 20;
  rect.setAttribute('y', info.y - TOP_EXTEND);
  rect.setAttribute('width', info.w);
  rect.setAttribute('height', info.h + TOP_EXTEND - 4);
  rect.setAttribute('rx', 2);
  svg.appendChild(rect);
  // During a practice loop, keep the scroll position the user set up
  // to view the looped section. Auto-scrolling on every bar would
  // bounce between the first and last bar of the loop — scrolling the
  // score up to the top and back down on every wrap — which is jarring
  // and defeats the point of seeing the loop framed on screen.
  const hasLoop = loopIn != null && loopOut != null && loopIn <= loopOut;
  if (hasLoop && idx >= loopIn && idx <= loopOut) return;
  // Center the current row vertically inside the scrollable .chart
  // container so the user can see the next measure(s) coming up,
  // rather than the row being pushed to the bottom edge (which was
  // what `scrollIntoView({block:'center'})` could produce depending
  // on sizing). We compute the target scrollTop explicitly and only
  // animate when the row has actually drifted out of a comfortable
  // center zone.
  const chartEl = document.getElementById('chart');
  if (!chartEl) return;
  const rowTop    = info.rowEl.offsetTop;          // relative to .chart
  const rowHeight = info.rowEl.offsetHeight;
  const viewHeight = chartEl.clientHeight;
  // Bias the current row a bit above the vertical center so more of
  // the upcoming row(s) are visible below. Uses a fraction of the
  // viewport height — feels consistent across screen sizes.
  const leadBias = viewHeight * 0.22;
  const targetScrollTop = Math.max(0,
    rowTop + rowHeight / 2 - viewHeight / 2 + leadBias);
  // Only scroll if the current row isn't already roughly centered —
  // avoids a jitter of tiny smooth-scrolls on consecutive bars that
  // live in the same visual row.
  const drift = Math.abs(chartEl.scrollTop - targetScrollTop);
  if (drift > 20) {
    chartEl.scrollTo({ top: targetScrollTop, behavior: 'smooth' });
  }
}

async function startPlayback(song, bars, startBarIdx = 0) {
  await initAudio();
  stopPlayback();

  const isSwing = /swing|jazz|bossa|bop/i.test(song.styleFull || song.style || '');
  const isFunk = /funk|fusion/i.test(song.styleFull || song.style || '');
  Tone.Transport.bpm.value = currentTempo;
  Tone.Transport.swing = isSwing ? 0.55 : 0;
  Tone.Transport.swingSubdivision = '8n';

  // Honor the song's time signature so bar:beat:sixteenth positions in the
  // scheduled events line up correctly (especially for 3/4 waltzes).
  const ts = parseTimesig((window.currentSong && window.currentSong.timesig) || '44');
  Tone.Transport.timeSignature = ts.num;

  const playlist = expandForPlayback(bars);
  currentPlaylist = playlist;
  if (!playlist.length) return;

  const beatsPerBar = ts.num;
  const events = [];
  let tick = 0;
  let lastResolved = null;

  // Count-in: N bars of click before the song starts. These are scheduled
  // directly on the Transport (not on the looping Part) so they fire once
  // and aren't filtered out by Part's [loopStart, loopEnd) range. Count-in
  // is skipped when starting mid-song from a user-selected bar — we assume
  // the player already knows where they are.
  const offset = startBarIdx > 0 ? 0 : countInBars;
  for (let cb = 0; cb < offset; cb++) {
    for (let beat = 0; beat < beatsPerBar; beat++) {
      const accent = beat === 0;
      Tone.Transport.scheduleOnce(t => {
        click.triggerAttackRelease('32n', t, accent ? 0.95 : 0.55);
      }, `${cb}:${beat}:0`);
    }
  }

  for (let barNum = 0; barNum < playlist.length; barNum++) {
    const entry = playlist[barNum];
    let bar = entry.bar;
    // resolve repeats
    if (bar.repeatPrev === 1 && lastResolved) bar = lastResolved;
    else if (bar.repeatPrev === 2 && playlist[barNum - 2]) bar = playlist[barNum - 2].bar;
    else lastResolved = bar;

    // Schedule events at times RELATIVE to the Part (which starts at Transport
    // position `${offset}:0:0`). That way Part.loopStart can stay at 0 and
    // events don't wrap to the wrong positions on the first pass.
    const absBar = barNum;
    events.push({ time: absBar + ':0:0', type: 'barStart', idx: entry.idx });

    // Schedule a fingerboard-update event per beat so the panel follows the
    // current quarter note + scale as the song plays. measurePitches
    // captures every quarter note played in this bar so the fingerboard can
    // emphasize just those positions while the bar is active.
    if (lastBeatInfo && lastBeatInfo[entry.idx]) {
      const measurePitches = lastBeatInfo[entry.idx]
        .map(b => b && b.pitch)
        .filter(p => p != null);
      for (let b = 0; b < beatsPerBar; b++) {
        const info = lastBeatInfo[entry.idx][b];
        if (info) events.push({ time: `${absBar}:${b}:0`, type: 'beat', idx: entry.idx, beat: b, info, measurePitches });
      }
    }

    // One stab per chord symbol, placed at the same beat as the chord
    // sits visually in the measure.
    const chords = (bar.chords || []).filter(c => !c.slash && !c.nc);
    chords.forEach((ch, ci) => {
      const beat = ci * beatsPerBar / chords.length;
      const wholeBeat = Math.floor(beat);
      const sixteenth = Math.round((beat - wholeBeat) * 4);
      events.push({
        time: `${absBar}:${wholeBeat}:${sixteenth}`,
        type: 'comp', ch, dur: '4n'
      });
    });

    // Drums — patterns adapt to the current time signature (4/4, 3/4, etc.)
    if (drumMode === 'hat') {
      if (beatsPerBar === 4) {
        // Classic hi-hat on 2 and 4
        events.push({ time: `${absBar}:1:0`, type: 'hat' });
        events.push({ time: `${absBar}:3:0`, type: 'hat' });
      } else if (beatsPerBar === 3) {
        // Waltz: hi-hat on beats 2 and 3
        events.push({ time: `${absBar}:1:0`, type: 'hat' });
        events.push({ time: `${absBar}:2:0`, type: 'hat' });
      } else {
        // Generic: on every beat except 1
        for (let b = 1; b < beatsPerBar; b++) {
          events.push({ time: `${absBar}:${b}:0`, type: 'hat' });
        }
      }
    } else if (drumMode === 'click') {
      // Metronome on every quarter note; accent beat 1
      for (let beat = 0; beat < beatsPerBar; beat++) {
        events.push({ time: `${absBar}:${beat}:0`, type: 'click', accent: beat === 0 });
      }
    } else if (drumMode === 'ride') {
      // "Real" mode — pick a groove based on the tempo tier.
      //   Ballad (≤ 100): brush sweep + taps on 2 & 4
      //   Medium (≤ 150): crisp hi-hat ride (spang-a-lang with real hihat sample)
      //   Up (> 150):     quick brush shuffle (swung 8ths on brush tap)
      const tempoTier = currentTempo < 100 ? 'ballad' : (currentTempo < 150 ? 'medium' : 'up');

      if (tempoTier === 'ballad') {
        // Prefer the real recorded loop when we have one for this time sig.
        // Otherwise fall back to the synthesized brush layer.
        const loopKey = 'ballad-' + ts.str;
        if (realLoops[loopKey] && realLoops[loopKey].player.loaded) {
          // nothing to push — the player is started once after the event loop.
        } else if (beatsPerBar === 4) {
          events.push({ time: `${absBar}:0:0`, type: 'brushSweep' });
          events.push({ time: `${absBar}:2:0`, type: 'brushSweep' });
          events.push({ time: `${absBar}:1:0`, type: 'brushTap' });
          events.push({ time: `${absBar}:3:0`, type: 'brushTap' });
        } else if (beatsPerBar === 3) {
          events.push({ time: `${absBar}:0:0`, type: 'brushSweep' });
          events.push({ time: `${absBar}:1:0`, type: 'brushTap' });
          events.push({ time: `${absBar}:2:0`, type: 'brushTap' });
        } else {
          events.push({ time: `${absBar}:0:0`, type: 'brushSweep' });
          for (let b = 1; b < beatsPerBar; b++) {
            events.push({ time: `${absBar}:${b}:0`, type: 'brushTap' });
          }
        }
      } else if (tempoTier === 'medium') {
        // Prefer the real recorded loop for this time sig; otherwise fall
        // back to the synthesized crisp hi-hat spang-a-lang.
        const loopKey = 'medium-' + ts.str;
        if (realLoops[loopKey] && realLoops[loopKey].player.loaded) {
          // handled by the loop sync after the event loop
        } else if (beatsPerBar === 4) {
          events.push({ time: `${absBar}:0:0`, type: 'realHihat' });
          events.push({ time: `${absBar}:1:0`, type: 'realHihat' });
          events.push({ time: `${absBar}:1:2`, type: 'realHihat', accent: true });
          events.push({ time: `${absBar}:2:0`, type: 'realHihat' });
          events.push({ time: `${absBar}:3:0`, type: 'realHihat' });
          events.push({ time: `${absBar}:3:2`, type: 'realHihat', accent: true });
        } else if (beatsPerBar === 3) {
          events.push({ time: `${absBar}:0:0`, type: 'realHihat' });
          events.push({ time: `${absBar}:1:0`, type: 'realHihat' });
          events.push({ time: `${absBar}:2:0`, type: 'realHihat' });
          events.push({ time: `${absBar}:2:2`, type: 'realHihat', accent: true });
        } else {
          for (let b = 0; b < beatsPerBar; b++) {
            events.push({ time: `${absBar}:${b}:0`, type: 'realHihat' });
          }
        }
      } else {
        // Up tempo: prefer the recorded loop; otherwise synthesized brush shuffle.
        const loopKey = 'up-' + ts.str;
        if (realLoops[loopKey] && realLoops[loopKey].player.loaded) {
          // handled by the loop sync after the event loop
        } else {
          for (let b = 0; b < beatsPerBar; b++) {
            events.push({ time: `${absBar}:${b}:0`, type: 'brushTap', accent: b === 0 });
            events.push({ time: `${absBar}:${b}:2`, type: 'brushTap' });
          }
        }
      }
    }
  }

  playbackPart = new Tone.Part((time, ev) => {
    if (ev.type === 'barStart') {
      // Track the currently-playing bar so clear-loop / change-loop can
      // restart playback at the right spot (Transport.position keeps
      // climbing during looping and can't be trusted for this).
      currentPlayingBar = ev.idx;
      Tone.Draw.schedule(() => highlightBar(ev.idx), time);
      return;
    }
    if (ev.type === 'beat') {
      Tone.Draw.schedule(() => {
        updateFingerboard({
          litMidis: ev.info.pitch != null ? [ev.info.pitch] : [],
          scalePcs: ev.info.scalePcs,
          chordTonesByPc: ev.info.chordTonesByPc,
          chordSymbol: ev.info.chordSymbol,
          chordNotesLabel: ev.info.chordNotesLabel,
          scaleLabel: ev.info.scaleLabel,
          useFlats: ev.info.useFlats,
          scaleRoot: ev.info.scaleRoot,
          scaleIntervals: ev.info.scaleIntervals,
          chordRoot: ev.info.chordRoot,
          measurePitches: ev.measurePitches
        });
        updateNoteHighlight(ev.idx, ev.beat);
      }, time);
      return;
    }
    if (ev.type === 'comp') {
      const notes = jazzVoicing(ev.ch);
      if (notes && notes.length) {
        const names = notes.map(midiToName);
        const vel = 0.45 + Math.random() * 0.35;
        piano.triggerAttackRelease(names, ev.dur || '8n', time, vel);
      }
    }
    if (ev.type === 'hat') hat.triggerAttackRelease('16n', time, 0.6);
    if (ev.type === 'hatFoot') hat.triggerAttackRelease('32n', time, 0.25);
    if (ev.type === 'click') click.triggerAttackRelease('32n', time, ev.accent ? 0.95 : 0.55);
    if (ev.type === 'realHihat') {
      // Crisp hi-hat sample — accent (skip notes) slightly softer for the
      // "spang-a-lang" feel where the "a" is lighter than the downbeat.
      const vel = ev.accent ? 0.55 : 0.85;
      realHihat.triggerAttackRelease('C4', '8n', time, vel);
    }
    if (ev.type === 'brushSweep') {
      brushSweep.triggerAttackRelease('4n', time, 0.7 + Math.random() * 0.15);
    }
    if (ev.type === 'brushTap') {
      const vel = ev.accent ? 0.8 : 0.55 + Math.random() * 0.15;
      brushTap.triggerAttackRelease('16n', time, vel);
    }
  }, events.map(e => [e.time, e]));

  // Loop the song indefinitely. Part events are scheduled in Part-relative
  // time (bar 0 = first song bar), so we start the Part itself at Transport
  // position `${offset}:0:0` to line up after the count-in. If the user has
  // set Loop In / Loop Out brackets, narrow the loop range to just those
  // bars so playback cycles between them.
  const hasLoop = loopIn != null && loopOut != null && loopIn <= loopOut;
  playbackPart.loop = true;
  playbackPart.loopStart = hasLoop ? `${loopIn}:0:0` : 0;
  playbackPart.loopEnd = hasLoop ? `${loopOut + 1}:0:0` : `${playlist.length}:0:0`;
  playbackPart.start(`${offset}:0:0`);

  // If Real mode has a recorded drum loop for this tempo tier + time sig,
  // sync it to the Transport so it phase-locks with the bars. Adjust
  // playbackRate when the user tempo differs from the loop's source bpm.
  currentRealLoop = null;
  if (drumMode === 'ride') {
    const tempoTier2 = currentTempo < 100 ? 'ballad' : (currentTempo < 150 ? 'medium' : 'up');
    const key = tempoTier2 + '-' + ts.str;
    const entry = realLoops[key];
    if (entry && entry.player.loaded && entry.player.buffer) {
      // Derive the loop's actual bpm from its audio duration so any tiny
      // cropping error gets absorbed by playbackRate. Result: the loop plays
      // for exactly entry.beats at Transport tempo, forever — no drift.
      const effectiveSourceBpm = (60 * entry.beats) / entry.player.buffer.duration;
      entry.player.playbackRate = currentTempo / effectiveSourceBpm;
      entry.player.unsync();
      // Starting mid-song? Align the drum buffer to the right phase so the
      // downbeat of the selected bar lines up with the loop's downbeat.
      let bufOffset = 0;
      if (startBarIdx > 0) {
        const beatInLoop = (startBarIdx * beatsPerBar) % entry.beats;
        bufOffset = (beatInLoop / entry.beats) * entry.player.buffer.duration;
      }
      const drumStartPos = startBarIdx > 0
        ? `${startBarIdx}:0:0`
        : `${offset}:0:0`;
      Tone.Transport.scheduleOnce(t => {
        try { entry.player.start(t, bufOffset); } catch (e) {}
      }, drumStartPos);
      currentRealLoop = entry;
    }
  }

  // Position the Transport:
  //   - starting from bar 0 → position 0, so count-in fires first
  //   - starting mid-song → jump straight to the selected bar (no count-in)
  Tone.Transport.position = startBarIdx > 0 ? `${startBarIdx}:0:0` : 0;
  Tone.Transport.start();
  playState = 'playing';
  pauseContext = { offset, beatsPerBar };
  const btn = document.getElementById('playBtn');
  btn.querySelector('.play-glyph').textContent = '⏸';
  btn.classList.add('playing');
  document.getElementById('status').textContent = `Playing · ${playlist.length} bars`;
  updateLoopControls();
}

// ===== File loading =====
function extractAllIrealURLs(text) {
  const urls = [];
  const re = /irealb:\/\/[^"'<>\s]+/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    // A single iRealPro "playlist" link stores every song in one URL,
    // separated by "===". Split them back into individual songs.
    const body = m[0].replace(/^irealb:\/\//, '');
    for (const part of body.split('===')) {
      if (part.trim().length) urls.push('irealb://' + part);
    }
  }
  return urls;
}
function titleFromIrealURL(url) {
  const decoded = decodeURIComponent(url.replace(/^irealb:\/\//, ''));
  return decoded.split('=')[0];
}
async function loadFromHTMLText(text) {
  const urls = extractAllIrealURLs(text);
  if (urls.length === 0) { alert('No iRealPro song URL found in file.'); return; }
  return loadFromURL(urls[0]);
}
// Expand iReal Pro repeat markers ({ ... }) into two literal copies of the
// bars so the chord sequence shows twice and the quarter-note walker can
// continue through the second pass with different notes. Non-repeated bars
// pass through unchanged.
function expandIRealRepeats(bars) {
  const out = [];
  let i = 0;
  const stripRepeatBarlines = (src) => {
    const b = { ...src, markers: src.markers ? [...src.markers] : [] };
    if (b.leftBar === 'repeatStart') b.leftBar = 'single';
    if (b.rightBar === 'repeatEnd') b.rightBar = 'single';
    return b;
  };
  const endingMatches = (b, n) => b && (b.ending == n); // == intentional (string vs number)
  while (i < bars.length) {
    if (bars[i].leftBar === 'repeatStart') {
      let j = i;
      while (j < bars.length && bars[j].rightBar !== 'repeatEnd') j++;
      if (j < bars.length) {
        // Look for an N1 bar inside [i, j] — marks the split between
        // "common" bars and the first-ending bars.
        let n1Start = -1;
        for (let k = i; k <= j; k++) {
          if (endingMatches(bars[k], 1)) { n1Start = k; break; }
        }
        // And an N2 bar just after the repeatEnd — the second-ending.
        let n2Start = -1, n2End = -1;
        for (let k = j + 1; k < bars.length; k++) {
          if (endingMatches(bars[k], 2)) {
            n2Start = k;
            // N2 runs for the same number of bars as N1 (standard iReal
            // layout); if there's no N1, extend until the next section
            // boundary or a strong barline.
            const n1Length = n1Start >= 0 ? (j - n1Start + 1) : 0;
            if (n1Length > 0) {
              n2End = Math.min(n2Start + n1Length - 1, bars.length - 1);
            } else {
              n2End = n2Start;
              while (n2End + 1 < bars.length
                     && !bars[n2End + 1].section
                     && !bars[n2End + 1].ending
                     && bars[n2End + 1].leftBar !== 'repeatStart'
                     && bars[n2End].rightBar !== 'final'
                     && bars[n2End].rightBar !== 'double') {
                n2End++;
              }
            }
            break;
          }
        }

        // First pass: common bars plus N1 ending (bars i..j).
        for (let k = i; k <= j; k++) out.push(stripRepeatBarlines(bars[k]));
        // Second pass: common bars, then jump to N2 (skipping N1).
        const commonEnd = n1Start >= 0 ? n1Start - 1 : j;
        for (let k = i; k <= commonEnd; k++) out.push(stripRepeatBarlines(bars[k]));
        if (n2Start >= 0) {
          for (let k = n2Start; k <= n2End; k++) out.push(stripRepeatBarlines(bars[k]));
          i = n2End + 1;
        } else {
          i = j + 1;
        }
        continue;
      }
    }
    out.push(bars[i]);
    i++;
  }
  return out;
}

function loadFromURL(url) {
  const song = parseIRealSong(url);
  const tokens = tokenize(song.body);
  let { bars, timesig } = buildBars(tokens);
  bars = expandIRealRepeats(bars);
  renderChart(song, bars, timesig);
  window.currentSong = { song, bars, timesig };
  document.getElementById('status').textContent = `Loaded: ${song.title} (${bars.length} bars)`;
  // A freshly loaded song should start at the top of the score. The
  // chart container holds the scroll position from the previously
  // loaded song, which can leave the user halfway down an unrelated
  // chart until they scroll back up themselves.
  const chartEl = document.getElementById('chart');
  if (chartEl) chartEl.scrollTop = 0;
}

// ===== Event bindings =====
document.getElementById('playBtn').addEventListener('click', async () => {
  if (playState === 'playing') { pausePlayback(); return; }
  if (playState === 'paused') { resumePlayback(); return; }
  if (!window.currentSong) return;
  const expanded = expandBarsByRepeats(window.currentSong.bars, songRepeats);
  // Pick a starting bar:
  //   - a complete Loop In / Loop Out pair wins (pinned to loopIn unless the
  //     user's selection already sits inside the loop range)
  //   - otherwise a tapped bar
  //   - otherwise the top
  const hasLoop = loopIn != null && loopOut != null && loopIn <= loopOut;
  let startAt;
  if (hasLoop) {
    if (selectedBar != null && selectedBar >= loopIn && selectedBar <= loopOut) {
      startAt = selectedBar;
    } else {
      startAt = loopIn;
    }
  } else {
    startAt = selectedBar != null ? selectedBar : 0;
  }
  await startPlayback(window.currentSong.song, expanded, startAt);
});
document.getElementById('rewindBtn').addEventListener('click', () => {
  // Back to start. With a Loop In bracket placed, "start" means the loop's
  // beginning so the next play resumes the practice section. Otherwise it
  // drops the bar selection and resets to the top of the song. Either way,
  // playback stops — user taps play to resume.
  stopPlayback();
  if (loopIn != null) {
    selectedBar = loopIn;
    highlightBar(loopIn);
    refreshFingerboardForBar(loopIn);
  } else {
    selectedBar = null;
  }
  updateLoopControls();
  document.getElementById('status').textContent = 'Ready';
});

// Loop controls. Loop In / Loop Out operate on the currently-selected bar.
// If the new Loop Out comes before an existing Loop In (or vice-versa), the
// conflicting endpoint is cleared so the bracket pair always reads left→right.
document.getElementById('loopInBtn').addEventListener('click', () => {
  if (selectedBar == null) return;
  if (loopOut != null && loopOut < selectedBar) loopOut = null;
  loopIn = selectedBar;
  redrawLoopBrackets();
  applyLoopBoundsToPart();
});
document.getElementById('loopOutBtn').addEventListener('click', () => {
  if (selectedBar == null) return;
  if (loopIn != null && loopIn > selectedBar) loopIn = null;
  loopOut = selectedBar;
  redrawLoopBrackets();
  applyLoopBoundsToPart();
});
document.getElementById('clearLoopBtn').addEventListener('click', () => {
  loopIn = null;
  loopOut = null;
  clearLoopBrackets();
  updateLoopControls();
  applyLoopBoundsToPart();
});
let currentTempo = 120;
document.querySelectorAll('#tempoSeg button').forEach(b => {
  b.addEventListener('click', async () => {
    document.querySelectorAll('#tempoSeg button').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    const prevTempo = currentTempo;
    currentTempo = parseInt(b.dataset.bpm, 10) || 120;
    if (Tone.Transport) Tone.Transport.bpm.value = currentTempo;
    // The "Real" drum mode picks its pattern (brushes / hi-hat / shuffle)
    // based on tempo tier, so we need to rebuild the part when the tier
    // actually changes during playback.
    const tier = (t) => t < 100 ? 'ballad' : (t < 150 ? 'medium' : 'up');
    if (playState === 'playing' && window.currentSong && drumMode === 'ride' &&
        tier(prevTempo) !== tier(currentTempo)) {
      const expanded = expandBarsByRepeats(window.currentSong.bars, songRepeats);
      await startPlayback(window.currentSong.song, expanded);
    }
  });
});
// ===== Wake Lock (prevent phone sleep while practicing) =====
let wakeLockSentinel = null;
async function acquireWakeLock() {
  if (!('wakeLock' in navigator)) {
    document.getElementById('status').textContent = 'Wake lock not supported on this browser.';
    return false;
  }
  try {
    wakeLockSentinel = await navigator.wakeLock.request('screen');
    wakeLockSentinel.addEventListener('release', () => { wakeLockSentinel = null; });
    return true;
  } catch (e) {
    document.getElementById('status').textContent = 'Wake lock failed: ' + e.message;
    return false;
  }
}
async function releaseWakeLock() {
  if (wakeLockSentinel) {
    try { await wakeLockSentinel.release(); } catch (e) {}
    wakeLockSentinel = null;
  }
}
document.getElementById('wakeLock').addEventListener('change', async e => {
  if (e.target.checked) {
    const ok = await acquireWakeLock();
    if (!ok) e.target.checked = false;
  } else {
    await releaseWakeLock();
  }
});
// Re-acquire after tab/screen visibility changes — the browser auto-releases
// the lock when the page is hidden.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible'
      && document.getElementById('wakeLock').checked
      && !wakeLockSentinel) {
    acquireWakeLock();
  }
});

function rerenderCurrent() {
  if (!window.currentSong) return;
  const { song, bars, timesig } = window.currentSong;
  renderChart(song, bars, timesig);
}

document.querySelectorAll('#mplSeg button').forEach(b => {
  b.addEventListener('click', () => {
    document.querySelectorAll('#mplSeg button').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    measuresPerLine = parseInt(b.dataset.mpl, 10) || 4;
    rerenderCurrent();
  });
});

document.querySelectorAll('#sizeSeg button').forEach(b => {
  b.addEventListener('click', () => {
    document.querySelectorAll('#sizeSeg button').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    chartSize = parseInt(b.dataset.size, 10) || 240;
    rerenderCurrent();
  });
});

document.querySelectorAll('#repeatSeg button').forEach(b => {
  b.addEventListener('click', async () => {
    document.querySelectorAll('#repeatSeg button').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    songRepeats = parseInt(b.dataset.r, 10) || 1;
    rerenderCurrent();
    if (playState === 'playing' && window.currentSong) {
      const expanded = expandBarsByRepeats(window.currentSong.bars, songRepeats);
      await startPlayback(window.currentSong.song, expanded);
    }
  });
});

document.getElementById('drumVol').addEventListener('input', e => {
  const v = parseInt(e.target.value, 10) / 100;
  if (drumsOut) drumsOut.gain.rampTo(v, 0.05);
});

// Options panel toggle
(function () {
  const toggle = document.getElementById('optionsToggle');
  const panel = document.getElementById('optionsPanel');
  if (!toggle || !panel) return;
  toggle.addEventListener('click', () => {
    const hidden = panel.hasAttribute('hidden');
    if (hidden) {
      panel.removeAttribute('hidden');
      toggle.setAttribute('aria-expanded', 'true');
    } else {
      panel.setAttribute('hidden', '');
      toggle.setAttribute('aria-expanded', 'false');
    }
  });
})();

document.querySelectorAll('#countInSeg button').forEach(b => {
  b.addEventListener('click', () => {
    document.querySelectorAll('#countInSeg button').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    countInBars = parseInt(b.dataset.count, 10) || 0;
  });
});

// Exercise picker — regenerates the quarter notes with the selected
// algorithm (scale-walker vs. 1-3-5-7 arpeggio). If playback is running,
// restart so the audible notes match the re-rendered score.
document.querySelectorAll('#exerciseSeg button').forEach(b => {
  b.addEventListener('click', async () => {
    document.querySelectorAll('#exerciseSeg button').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    const ex = b.dataset.ex;
    exerciseMode = (ex === 'chord' || ex === 'broken3' || ex === 'cantus') ? ex : 'scale';
    rerenderCurrent();
    if (playState === 'playing' && window.currentSong) {
      const expanded = expandBarsByRepeats(window.currentSong.bars, songRepeats);
      await startPlayback(window.currentSong.song, expanded, currentPlayingBar);
    }
  });
});

document.querySelectorAll('#drumSeg button').forEach(b => {
  b.addEventListener('click', async () => {
    document.querySelectorAll('#drumSeg button').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    drumMode = b.dataset.mode;
    if (playState === 'playing' && window.currentSong) {
      // restart with the new pattern so the change is immediate
      const expanded = expandBarsByRepeats(window.currentSong.bars, songRepeats);
      await startPlayback(window.currentSong.song, expanded);
    }
  });
});

// ===== Song library =====
// All songs come from a single iRealPro playlist export —
// songs/Songs.html. On load we fetch that file, extract every
// iRealPro URL embedded in it, and build the song list from the
// titles encoded in those URLs. To change the songs: export a new
// playlist from iRealPro as HTML, drop it in as songs/Songs.html.

// Parsed song-library state: each entry is { title, url }. Kept in
// closure scope by initSongLibrary and referenced by the handlers.
let librarySongs = [];

async function initSongLibrary() {
  try {
    const res = await fetch('songs/Songs.html');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = await res.text();
    let urls = extractAllIrealURLs(text);
    if (urls.length === 0) throw new Error('no iRealPro URLs in Songs.html');
    // iRealPro playlist exports always append a stub entry named after
    // the playlist itself (e.g. "Favorites", "Lansdowne") as the last
    // URL — it isn't a real song. Drop it.
    if (urls.length > 1) urls = urls.slice(0, -1);
    librarySongs = urls
      .map(url => ({ title: titleFromIrealURL(url), url }))
      // Present the library alphabetically by title, regardless of the
      // order in the playlist file. Case-insensitive, natural compare.
      .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
  } catch (e) {
    document.getElementById('status').textContent =
      'Could not load songs/Songs.html: ' + e.message;
    return;
  }

  const songListEl = document.getElementById('songList');
  if (songListEl) songListEl.innerHTML = '';
  librarySongs.forEach((entry, i) => {
    if (songListEl) {
      const li = document.createElement('li');
      li.textContent = entry.title;
      li.dataset.idx = String(i);
      li.setAttribute('role', 'option');
      li.addEventListener('click', () => {
        selectSongByIndex(i);
        closeSongPicker();
      });
      songListEl.appendChild(li);
    }
  });

  try {
    loadFromURL(librarySongs[0].url);
  } catch (e) {
    document.getElementById('status').textContent =
      'Failed to load ' + librarySongs[0].title + ': ' + e.message;
  }
  syncSongSelectionUI(0);
}

// Shared song-change handler — used by both the portrait popup list
// and the landscape sidebar list click.
function selectSongByIndex(idx) {
  if (playState !== 'stopped') stopPlayback();
  loopIn = null;
  loopOut = null;
  updateLoopControls();
  syncSongSelectionUI(idx);
  try {
    loadFromURL(librarySongs[idx].url);
  } catch (e) {
    document.getElementById('status').textContent =
      'Failed to load ' + librarySongs[idx].title + ': ' + e.message;
  }
}

// ----- Song picker popup (portrait) + filter (both layouts) -----
function isLandscape() {
  return document.body.classList.contains('layout-landscape');
}
function openSongPicker() {
  const panel = document.getElementById('songListPanel');
  if (!panel) return;
  // In landscape the panel is always in the sidebar — no modal open
  // needed. Focus the filter input so the user can start typing right
  // away in both modes.
  if (!isLandscape()) panel.classList.add('open');
  const filter = document.getElementById('songFilter');
  if (filter) {
    // A tiny delay ensures the panel has finished its display flip
    // before we try to focus (Safari is finicky about focus during
    // layout changes).
    setTimeout(() => { filter.focus(); filter.select(); }, 0);
  }
}
function closeSongPicker() {
  const panel = document.getElementById('songListPanel');
  if (!panel) return;
  panel.classList.remove('open');
}
function applySongFilter(q) {
  const needle = (q || '').trim().toLowerCase();
  document.querySelectorAll('#songList li').forEach(li => {
    const hit = !needle || li.textContent.toLowerCase().includes(needle);
    li.hidden = !hit;
  });
  const clearBtn = document.getElementById('songFilterClear');
  if (clearBtn) clearBtn.hidden = !(q && q.length > 0);
}
(function bindSongPickerControls() {
  const btn = document.getElementById('songPickerBtn');
  if (btn) btn.addEventListener('click', openSongPicker);
  const closeBtn = document.getElementById('songPickerClose');
  if (closeBtn) closeBtn.addEventListener('click', closeSongPicker);
  const filter = document.getElementById('songFilter');
  if (filter) {
    filter.addEventListener('input', e => applySongFilter(e.target.value));
    filter.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        if (filter.value) {
          filter.value = '';
          applySongFilter('');
        } else if (!isLandscape()) {
          closeSongPicker();
        }
      }
    });
  }
  const clearBtn = document.getElementById('songFilterClear');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      const f = document.getElementById('songFilter');
      if (f) { f.value = ''; applySongFilter(''); f.focus(); }
    });
  }
})();

function syncSongSelectionUI(idx) {
  document.querySelectorAll('#songList li').forEach((li, i) => {
    li.classList.toggle('active', i === idx);
  });
}

// ===== Responsive layout: left sidebar on wide screens =====
// On viewports wider than tall (and with enough horizontal room), pull the
// transport buttons, options controls, song list, and note-info panel into
// a persistent left sidebar and hide the mobile header / fingerboard
// section. The DOM elements are re-parented between the sidebar and the
// main area so we don't have to duplicate HTML or event wiring.
function applyLayoutMode() {
  const landscape = window.innerWidth > window.innerHeight && window.innerWidth >= 800;
  const body = document.body;
  const isLandscape = body.classList.contains('layout-landscape');
  if (landscape === isLandscape) return;

  const sidebar = document.getElementById('sidebar');
  const header = document.querySelector('header');
  const fbSection = document.querySelector('.fingerboard-section');
  const topRow = document.querySelector('.top-row');
  const optionsPanel = document.getElementById('optionsPanel');
  const fbPanel = document.getElementById('fingerboardPanel');
  const songListPanel = document.getElementById('songListPanel');

  if (landscape) {
    body.classList.add('layout-landscape');
    sidebar.hidden = false;
    // Order (top → bottom): transport buttons, options, song list (fills),
    // note info panel.
    sidebar.appendChild(topRow);
    sidebar.appendChild(optionsPanel);
    sidebar.appendChild(songListPanel);
    sidebar.appendChild(fbPanel);
    // Always open in landscape — CSS uses `display: flex !important` to
    // defeat the `hidden` attribute that the toggles leave behind.
  } else {
    body.classList.remove('layout-landscape');
    sidebar.hidden = true;
    // Restore original mobile positions.
    header.insertBefore(topRow, header.firstChild);
    header.appendChild(optionsPanel);
    fbSection.appendChild(fbPanel);
    // Pull songListPanel BACK OUT of the sidebar in portrait — if it
    // stayed inside `<aside id="sidebar" hidden>`, the `display: none`
    // on the hidden ancestor would defeat the .open overlay class we
    // use as the portrait modal. #app is the right place: the panel
    // sits alongside sidebar / mainArea and can float freely when
    // positioned fixed via CSS.
    const appEl = document.getElementById('app');
    if (appEl) appEl.appendChild(songListPanel);
    // Restore the hidden state that the toggle buttons expect.
    const optExp = document.getElementById('optionsToggle').getAttribute('aria-expanded') === 'true';
    optionsPanel.hidden = !optExp;
    const fbExp = document.getElementById('fbToggle').getAttribute('aria-expanded') === 'true';
    fbPanel.hidden = !fbExp;
  }
}

window.addEventListener('resize', applyLayoutMode);
applyLayoutMode();

initSongLibrary();
