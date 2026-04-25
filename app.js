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
    // Quality section uses `*` (not `?`) so stacked markers like "-^"
    // for min-maj7 (iRealPro's encoding of Cm(maj7) = "C-^7") are
    // consumed together. Without the star, the "-" was matched and
    // the "^7" was left as unparseable garbage, so Cm(maj7) rendered
    // as plain "Cm" and was treated as pure minor for scale picking.
    [/^([A-GW])((?:[#b])?(?:\^|\-|h|o|\+|sus)*(?:\d+(?:sus)?)?(?:(?:[#b])\d+)*(?:sus\d?)?)(\/([A-G][#b]?))?/, 'chord'],
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

// Expand simple repeats and D.C./D.S. al Coda into a flat playback
// sequence of bars. "D.C. al Fine" is NOT handled here — it's
// already flattened at load time by expandDCAlFine() so the bars
// passed in literally include the ABA structure.
function expandForPlayback(bars) {
  let coda = -1, segno = -1;
  bars.forEach((b, i) => {
    if (b.markers.some(m => m.type === 'coda')) coda = i;
    if (b.markers.some(m => m.type === 'segno')) segno = i;
  });

  const out = [];
  let dcAlCoda = false, dsAlCoda = false;

  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];

    b.markers.forEach(m => {
      if (m.type !== 'comment') return;
      const t = (m.text || '').toLowerCase();
      if (t.includes('d.c. al coda') || t.includes('dc al coda')) dcAlCoda = true;
      if (t.includes('d.s. al coda') || t.includes('ds al coda')) dsAlCoda = true;
    });

    out.push({ bar: b, idx: i });

    if (b.rightBar === 'repeatEnd') {
      // Simple repeat once
      const startBar = bars.findIndex((x, idx) => idx <= i && x.leftBar === 'repeatStart');
      const s = startBar < 0 ? 0 : startBar;
      for (let j = s; j <= i; j++) out.push({ bar: bars[j], idx: j });
    }

    // D.C. / D.S. al Coda fire mid-loop: the coda tail at the end
    // of the chart is the branch target for the post-jump "al Coda"
    // leg, not part of the linear first pass.
    if (dcAlCoda && coda >= 0) {
      for (let j = 0; j < coda; j++) out.push({ bar: bars[j], idx: j });
      for (let j = coda; j < bars.length; j++) out.push({ bar: bars[j], idx: j });
      dcAlCoda = false;
      return out;
    }
    if (dsAlCoda && segno >= 0 && coda >= 0) {
      for (let j = segno; j < coda; j++) out.push({ bar: bars[j], idx: j });
      for (let j = coda; j < bars.length; j++) out.push({ bar: bars[j], idx: j });
      dsAlCoda = false;
      return out;
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

// Collapse awkward enharmonic spellings to a simpler one on the same
// pitch class. Two kinds of fixes:
//  1. Double-accidentals (F##, C##, ... / Cbb, Dbb, ...) — shifted up
//     or down a letter so the note renders as a single-accidental or
//     natural spelling (e.g. C## → D, Cbb → B♭). This matters after
//     Key-transpose, where a scale tone offset from a transposed
//     root can land in double-accidental territory.
//  2. The four remaining single-accidental corner cases — C♭, F♭,
//     E♯, B♯ — collapse to B, E, F, C respectively. Players read
//     these natural spellings faster.
// Applied up front in tpcToNoteName / tpcToLetterAcc so every
// downstream renderer (scale labels, chord-tone list, VexFlow note
// keys) picks up the nicer spelling automatically.
function normalizeEnharmonic(tpc) {
  const idx = (((tpc - 13) % 7) + 7) % 7;
  const acc = (tpc - 13 - idx) / 7; // -2=bb, -1=b, 0=nat, 1=#, 2=##
  if (acc >= 2) tpc -= 12;       // e.g. F## → G, C## → D, G## → A
  else if (acc <= -2) tpc += 12; // e.g. Cbb → B♭, Dbb → C, Ebb → D
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
  // Minor-major (e.g. Cm(maj7), C-Δ7, iRealPro "C-^7"): both the
  // textual "maj"/"ma" spelling and the symbolic Δ/∆/^ spelling
  // count as the major qualifier, paired with the minor quality
  // signal on the left (m/min/-).
  if (/^(m(?!a)|min|mi|\-|−)/i.test(q) && /maj|ma|Δ|∆|\^/i.test(q)) return SCALE_MELODIC_MINOR;
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

// Given a bar of `chordsInBar` chords across `beatsPerBar` beats, return
// the [startBeat, endBeat) range the chord at `chordIdxInBar` occupies.
//
// iRealPro convention: when the beat count doesn't divide evenly (e.g. 3
// chords in a 4-beat bar), the EARLIER chords absorb the extra beats,
// not the last one. So 3 chords / 4 beats → 2 + 1 + 1 (first gets the
// extra beat), matching how the lead sheet is engraved — e.g. Dream A
// Little Dream's "GMaj7 Eb7 D7" bar reads GMaj7 on beats 1-2, Eb7 on
// beat 3, D7 on beat 4 rather than 1-1-(2).
function chordBeatRange(chordsInBar, chordIdxInBar, beatsPerBar) {
  const n = Math.max(1, chordsInBar);
  const base = Math.floor(beatsPerBar / n);
  const extra = beatsPerBar - base * n;
  let startBeat = 0;
  for (let i = 0; i < chordIdxInBar; i++) {
    startBeat += (i < extra) ? base + 1 : base;
  }
  const len = (chordIdxInBar < extra) ? base + 1 : base;
  return { startBeat, endBeat: startBeat + len };
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

    // Beat range for this chord event (iRealPro spacing convention).
    const { startBeat, endBeat } = chordBeatRange(ce.chordsInBar, ce.chordIdxInBar, beatsPerBar);

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
    const { startBeat, endBeat } = chordBeatRange(ce.chordsInBar, ce.chordIdxInBar, beatsPerBar);
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
        // Find the closest new-scale tone to the virtual next-base pitch.
        // When two tones are equidistant from virtualBasePitch (a true
        // tie — e.g. virtual Ab sitting exactly between G and A in C
        // mixolydian), break the tie toward the CURRENT travel direction:
        // ascending prefers the higher tie, descending prefers the lower.
        // That keeps the broken-3rds zigzag flowing in its established
        // direction across chord boundaries rather than jumping over the
        // virtual base.
        //
        // Examples this resolves on Green Dolphin Street:
        //   - EbMaj7 ending ascending Ab-F-G-Bb (direction=+1 after the
        //     range-boundary flip): virtual Ab ties G/A in C mix → picks
        //     A → pairs A-C, Bb-D for a natural ascending continuation.
        //   - Ebm7 ending descending Eb-C (direction=-1): virtual Db
        //     ties C/D in F mix → picks C (same pitch as lastPitch), the
        //     conflict branch below then nudges to upper-neighbor D for
        //     the Eb-C-D-Bb enclosure.
        let bestIdx = 0, bestDiff = Math.abs(tones[0].pitch - virtualBasePitch);
        for (let i = 1; i < tones.length; i++) {
          const d = Math.abs(tones[i].pitch - virtualBasePitch);
          if (d < bestDiff) { bestDiff = d; bestIdx = i; }
          else if (d === bestDiff) {
            if (direction > 0 && tones[i].pitch > tones[bestIdx].pitch) bestIdx = i;
            else if (direction < 0 && tones[i].pitch < tones[bestIdx].pitch) bestIdx = i;
          }
        }
        baseIdx = bestIdx;
        // If the virtual next base lands on the LITERAL last note we just
        // played, nudge off so we don't sound the same pitch twice in a
        // row across the barline. Prefer the opposite-of-direction
        // neighbor (enclosure / upper-neighbor when descending, lower
        // when ascending); fall back to stepping further in the current
        // direction if the opposite-direction neighbor also conflicts
        // or is out of range. We only check `lastPitch`, NOT
        // `lastBasePitch` — a match with lastBasePitch means the pitch
        // was played two notes ago, which is not an immediate repeat
        // and is musically fine.
        const conflicts = (idx) => idx < 0 || idx >= tones.length ||
          tones[idx].pitch === lastPitch;
        if (conflicts(baseIdx)) {
          const up = baseIdx - direction;
          const down = baseIdx + direction;
          if (!conflicts(up)) baseIdx = up;
          else if (!conflicts(down)) baseIdx = down;
          else if (down >= 0 && down < tones.length) baseIdx = down;
        }
      } else {
        const cont = findSmoothContinuation(tones, lastPitch, lastTpc, direction);
        baseIdx = cont.idx;
        direction = cont.dir;
      }
      // NOTE: We intentionally do NOT reset `phase = 0` here. Preserving
      // phase across chord boundaries lets the zigzag continue naturally
      // when a chord change lands mid-pair (phase=1, a 3rd still pending).
      // In 4/4 with full-bar chords, every pair completes and phase is 0
      // at the boundary anyway — so preservation is a no-op. In 3/4 or
      // any partial-chord span where phase ends odd, preservation avoids
      // the "every chord starts on a base note" behavior that was causing
      // identical bars in a row (e.g. Alice in Wonderland's minor 251
      // `Bm7b5 | E7b9 | Am7` in 3/4: lastPitch=F2 going into each bar
      // → virtual F2 maps to F2 exact in each scale → conflict-nudged to
      // G2/G#2 → every bar plays `G* E F`). Preserving phase=1 instead
      // makes the first beat of each new chord play the pending 3rd
      // relative to the newly-mapped baseIdx, varying the line.
    }
    if (tones.length === 0) return;

    const { startBeat, endBeat } = chordBeatRange(ce.chordsInBar, ce.chordIdxInBar, beatsPerBar);

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
// Factory: builds a quarter-note arpeggio generator that walks a
// fixed set of chord-tone scale degrees (e.g. [0,2,4,6] for 1-3-5-7
// or [0,2,4] for 1-3-5), zig-zagging up/down the cello range with
// direction reversals every `N` notes (where N = degCount).
function makeQuarterNoteArpeggioGenerator(degScaleIdx) {
  const degCount = degScaleIdx.length;
  return function (bars, ts) {
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
      const { startBeat, endBeat } = chordBeatRange(ce.chordsInBar, ce.chordIdxInBar, beatsPerBar);
      return endBeat - startBeat;
    });

    let descending = true;           // start by descending from top of range
    let lastWrittenPitch = -1;

    chordEvents.forEach((ce, ci) => {
      // Chord tones come from the chord's OWN scale and root — NOT
      // from the parent major-key scale carried by `effective[]`.
      // That parent-key mapping is appropriate for scale-walking
      // (where you want every chord in a ii-V-I to share a single
      // diatonic scale) but wrong for arpeggios: F7 inside B♭ major
      // must still arpeggiate F-A-C, not B♭-D-F.
      const chordScale = exGetScale(chordToCanonical(ce.chord));
      const rootPC = ce.root.pitchClass;
      const rootTpc = ce.root.tpc;

      // Build the chord-tone degrees specified by this generator.
      const degrees = [];
      for (let d = 0; d < degCount; d++) {
        const si = degScaleIdx[d];
        if (si >= chordScale.length) continue;
        degrees.push({
          pc: ((rootPC + chordScale[si].s) % 12 + 12) % 12,
          tpc: rootTpc + chordScale[si].t
        });
      }
      if (degrees.length < degCount) return;

      const numQuarters = quartersPerEvent[ci];
      const notes = [];

      // Unified "pick the smoothest next chord tone" loop — no special
      // cases for 1- or 2-quarter chords. For short chords inside
      // multi-chord bars this means we use whatever chord tone creates
      // the smallest voice-leading jump from the previous note. For
      // long chords it preserves the zig-zag arpeggio with direction
      // reversals every `degCount` notes.
      //
      // Starting pitch / degree for this chord:
      //   - First chord of the piece: top of the cello range (descending).
      //   - Subsequent chords: pick the chord tone that is (a) closest
      //     to the previous note and (b) continues the current direction
      //     if possible; fall back to plain nearest-tone if neither helps.
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

      notes.push({ pitch: startPitch, tpc: degrees[startDegIdx].tpc });
      let prev = startPitch;
      let degIdx = startDegIdx;
      for (let q = 1; q < numQuarters; q++) {
        // Keep walking in the current direction — NO periodic reversal.
        // Direction only flips when the next chord tone in the current
        // direction would fall outside the cello range, i.e. when the
        // line has reached the top or the bottom of its travel. This
        // matches Scale Notes' "walk the full range until you hit a
        // wall" behavior so triads / 1-3-5-7 also climb all the way
        // down before coming back up, instead of zig-zagging every
        // 3-4 notes in the middle of the range.
        degIdx = descending ? (degIdx - 1 + degCount) % degCount
                            : (degIdx + 1) % degCount;
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
          // Reached the range boundary — flip direction and search the
          // other way. Also rewind the degree index so the flipped
          // direction starts at the same degree again (otherwise the
          // reversal would skip a chord tone).
          descending = !descending;
          degIdx = descending ? (degIdx + 1) % degCount
                              : (degIdx - 1 + degCount) % degCount;
          const pc2 = degrees[degIdx].pc;
          const all2 = pitchesForPC(pc2);
          if (descending) {
            for (let k = all2.length - 1; k >= 0; k--) {
              if (all2[k] < prev) { next = all2[k]; break; }
            }
          } else {
            for (let k = 0; k < all2.length; k++) {
              if (all2[k] > prev) { next = all2[k]; break; }
            }
          }
        }
        if (next < 0) break;
        notes.push({ pitch: next, tpc: degrees[degIdx].tpc });
        prev = next;
      }

      // Write the generated notes into results[barIdx][beat].
      const { startBeat } = chordBeatRange(ce.chordsInBar, ce.chordIdxInBar, beatsPerBar);
      for (let q = 0; q < notes.length; q++) {
        const b = startBeat + q;
        if (b >= beatsPerBar) break;
        results[ce.barIdx][b] = { pitch: notes[q].pitch, tpc: notes[q].tpc };
        lastWrittenPitch = notes[q].pitch;
      }
    });

    return { results, chordEvents, patterns, effective };
  };
}

// 1-3-5-7 arpeggio (Chord Tones exercise).
const generate1357QuarterNotes = makeQuarterNoteArpeggioGenerator([0, 2, 4, 6]);
// 1-3-5 arpeggio (Triads exercise).
const generateTriadsQuarterNotes = makeQuarterNoteArpeggioGenerator([0, 2, 4]);

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

// ===== Head (from MusicXML or MIDI file) =====
// Common note shape produced by both parsers so the generator
// doesn't need to know which source it came from:
//   { stepStart: int,      // 0 = bar 0 beat 1, in eighth-note units
//     durationSteps: num,  // length in eighth notes (may be fractional)
//     midi: int,           // sounding MIDI pitch
//     tpc: int,            // tonal pitch class (explicit spelling)
//     tieStart: bool,      // this note ties INTO the next one
//     tieStop: bool }      // this note continues a prior tie

// Try MusicXML first (explicit spelling + ties), fall back to MIDI.
// Returns { notes: [...] } or null.
async function loadSongHead(title) {
  if (!title) return null;
  const xml = await loadSongMusicXML(title);
  if (xml) return xml;
  const midi = await loadSongMidi(title);
  if (midi) return midiToHeadNotes(midi);
  return null;
}

async function loadSongMusicXML(title) {
  try {
    const url = `songs/${encodeURIComponent(title)}.musicxml`;
    const response = await fetch(url);
    if (!response.ok) return null;
    const text = await response.text();
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.querySelector('parsererror')) return null;
    return parseMusicXML(doc);
  } catch (e) {
    return null;
  }
}

// Parse a MusicXML document into a flat list of melody notes. Uses
// the first <part>, voice 1, first staff. Chord notes (<chord/>)
// collapse to the top voice — we keep the highest MIDI at each
// simultaneous position.
function parseMusicXML(doc) {
  const STEP_TO_SEMI = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const STEP_TO_TPC  = { C: 14, D: 16, E: 18, F: 13, G: 15, A: 17, B: 19 };
  const score = doc.querySelector('score-partwise') || doc.querySelector('score-timewise');
  if (!score) return null;
  const part = score.querySelector('part');
  if (!part) return null;

  const notes = [];
  let divisions = 1;   // ticks per quarter-note (from <attributes>)
  let absStep = 0;     // position at start of the CURRENT measure, in 8th notes
  let cursor = 0;      // absolute position in 8th notes (measure-relative = cursor - absStep)

  function readDurationSteps(el) {
    const d = el.querySelector('duration');
    if (!d) return 0;
    const ticks = parseInt(d.textContent, 10) || 0;
    // 24th-note resolution: 6 steps per quarter. This accommodates
    // triplets (quarter triplet = 4 steps, 8th triplet = 2 steps) as
    // whole integers alongside standard durations (quarter = 6, 8th = 3).
    return divisions > 0 ? (ticks * 6 / divisions) : 0;
  }

  function readPitch(pitchEl) {
    if (!pitchEl) return null;
    const stepEl   = pitchEl.querySelector('step');
    const octaveEl = pitchEl.querySelector('octave');
    if (!stepEl || !octaveEl) return null;
    const step = stepEl.textContent.trim();
    const alterEl = pitchEl.querySelector('alter');
    const alter = alterEl ? parseInt(alterEl.textContent, 10) : 0;
    const octave = parseInt(octaveEl.textContent, 10);
    const base = STEP_TO_SEMI[step];
    const tpcBase = STEP_TO_TPC[step];
    if (base == null || tpcBase == null || isNaN(octave)) return null;
    return {
      midi: (octave + 1) * 12 + base + alter,
      tpc:  tpcBase + 7 * alter
    };
  }

  const measures = part.querySelectorAll('measure');
  for (const measure of measures) {
    // Update divisions if declared in this measure.
    const div = measure.querySelector('attributes > divisions');
    if (div) divisions = parseInt(div.textContent, 10) || divisions;

    cursor = absStep;
    let measureEnd = absStep;

    for (const el of Array.from(measure.children)) {
      const tag = el.tagName;
      if (tag === 'note') {
        const voiceEl = el.querySelector('voice');
        const voice = voiceEl ? parseInt(voiceEl.textContent, 10) : 1;
        if (voice !== 1) continue; // only the primary voice
        const isRest = el.querySelector('rest') !== null;
        const isChord = el.querySelector('chord') !== null;
        const dSteps = readDurationSteps(el);

        if (isChord) {
          // Simultaneous with previous note → top-voice collapse.
          if (!isRest && notes.length > 0) {
            const p = readPitch(el.querySelector('pitch'));
            const prev = notes[notes.length - 1];
            if (p && p.midi > prev.midi) { prev.midi = p.midi; prev.tpc = p.tpc; }
          }
          // Don't advance cursor for chord-linked notes.
        } else if (isRest) {
          cursor += dSteps;
        } else {
          const p = readPitch(el.querySelector('pitch'));
          if (p) {
            let tieStart = false, tieStop = false;
            el.querySelectorAll('tie').forEach(t => {
              const type = t.getAttribute('type');
              if (type === 'start') tieStart = true;
              else if (type === 'stop') tieStop = true;
            });
            // Tuplet bracket markers (start/stop) from <notations><tuplet>.
            // Middle members of a tuplet carry neither flag.
            let tupletStart = false, tupletStop = false;
            el.querySelectorAll('notations > tuplet').forEach(t => {
              const type = t.getAttribute('type');
              if (type === 'start') tupletStart = true;
              else if (type === 'stop') tupletStop = true;
            });
            // `<time-modification>` tells us the ratio (e.g. 3:2 for
            // triplets). Its presence means this note is part of a
            // tuplet — even the middle members carry the modification.
            const tm = el.querySelector('time-modification');
            let tupletActual = null, tupletNormal = null;
            if (tm) {
              const a = tm.querySelector('actual-notes');
              const n = tm.querySelector('normal-notes');
              if (a && n) {
                tupletActual = parseInt(a.textContent, 10) || null;
                tupletNormal = parseInt(n.textContent, 10) || null;
              }
            }
            // Display type (quarter, eighth, etc.) — needed for tuplets
            // because the raw `duration` ticks don't match a standard
            // note value (a quarter triplet has 2/3 of a quarter's
            // duration but renders as a quarter glyph).
            const typeEl = el.querySelector('type');
            const displayType = typeEl ? (typeEl.textContent || '').trim() : null;
            notes.push({
              stepStart: Math.round(cursor),
              durationSteps: dSteps,
              midi: p.midi,
              tpc: p.tpc,
              tieStart,
              tieStop,
              tupletStart,
              tupletStop,
              tupletActual,
              tupletNormal,
              displayType
            });
          }
          cursor += dSteps;
        }
        if (cursor > measureEnd) measureEnd = cursor;
      } else if (tag === 'backup') {
        cursor -= readDurationSteps(el);
      } else if (tag === 'forward') {
        cursor += readDurationSteps(el);
        if (cursor > measureEnd) measureEnd = cursor;
      }
    }

    absStep = measureEnd;
  }

  return { notes };
}

// Convert a parsed @tonejs/midi Midi object to the same note shape
// used by the MusicXML parser. Picks the best "melody" track using
// the same scoring as before and collapses chord voicings to the
// top note at each tick.
function midiToHeadNotes(midi) {
  if (!midi || !midi.tracks) return null;
  function scoreTrack(t) {
    const name = (t.name || '').toLowerCase();
    let score = 0;
    if (/\b(melody|lead|solo|head|theme|tune|soprano)\b/.test(name)) score += 10000;
    if (/\b(bass|drum|chord|comp|accompan|harmony|piano|guitar|pad|strings?)\b/.test(name)) score -= 5000;
    const byTick = new Map();
    for (const n of t.notes) byTick.set(n.ticks, (byTick.get(n.ticks) || 0) + 1);
    let poly = 0;
    for (const c of byTick.values()) if (c > 1) poly += (c - 1);
    score -= (poly / Math.max(1, t.notes.length)) * 1000;
    score += t.notes.length;
    return score;
  }
  const candidates = midi.tracks.filter(t => t.notes && t.notes.length > 0 && t.channel !== 9);
  candidates.sort((a, b) => scoreTrack(b) - scoreTrack(a));
  const track = candidates[0];
  if (!track) return null;
  // Top-voice collapse.
  const topByTick = new Map();
  for (const n of track.notes) {
    const prev = topByTick.get(n.ticks);
    if (!prev || n.midi > prev.midi) topByTick.set(n.ticks, n);
  }
  const seq = Array.from(topByTick.values()).sort((a, b) => a.ticks - b.ticks);
  const ppq = (midi.header && midi.header.ppq) || 480;
  // 24th-note resolution matches the MusicXML head parser so both
  // pipelines feed the same downstream rendering/scheduling path.
  const ticksPerStep = ppq / 6;
  // Key-based enharmonic guess (MIDI has no spelling info).
  const SHARP_TPCS = [14, 21, 16, 23, 18, 13, 20, 15, 22, 17, 24, 19];
  const FLAT_TPCS  = [14,  9, 16, 11, 18, 13,  8, 15, 10, 17, 12, 19];
  const keyForPref = currentKey || 'C';
  const treatAsFlat =
    FLAT_KEYS.has(keyForPref) ||
    (!currentIsMinor && (keyForPref === 'C#' || keyForPref === 'F#' || keyForPref === 'G#'));
  const tpcMap = treatAsFlat ? FLAT_TPCS : SHARP_TPCS;
  const notes = seq.map(n => ({
    stepStart: Math.round(n.ticks / ticksPerStep),
    durationSteps: (n.durationTicks || ticksPerStep) / ticksPerStep,
    midi: n.midi,
    tpc: tpcMap[((n.midi % 12) + 12) % 12],
    // MIDI has no explicit ties — let the bar-crossing splitter add
    // them as needed. An extra "original-note ties forward" signal
    // isn't available from MIDI.
    tieStart: false,
    tieStop: false
  }));
  return { notes };
}

// Legacy wrapper kept for call sites still using the old name.
async function loadSongMidi(title) {
  if (typeof Midi === 'undefined' || !title) return null;
  try {
    const url = `songs/${encodeURIComponent(title)}.mid`;
    const response = await fetch(url);
    if (!response.ok) return null;
    const buffer = await response.arrayBuffer();
    return new Midi(buffer);
  } catch (e) {
    return null;
  }
}

// "Head" exercise — reads the melody from window.currentSong.head
// (loaded in loadFromURL via loadSongHead — MusicXML preferred, MIDI
// fallback) and places each note in its corresponding bar +
// eighth-note slot. Falls back to silence (a chart of rests) if no
// score is available for this song.
function generateHeadFromScore(bars, ts) {
  const beatsPerBar = ts.num;
  // 24th-note resolution (6 steps per quarter). Fine enough to express
  // triplets (quarter triplet = 4 steps, 8th triplet = 2 steps) as
  // integers alongside standard durations (quarter = 6, 8th = 3). The
  // renderer and scheduler detect subdiv=6 from stepsPerBar / beatsPerBar.
  const stepsPerBar = beatsPerBar * 6;
  const chordEvents = buildChordEventList(bars);
  const patterns = detectKeyPatterns(chordEvents);
  const effective = chordEvents.map((ce, i) => {
    const pat = patterns.find(p => i >= p.firstIdx && i <= p.lastIdx);
    if (pat && pat.keyMode === 'major') return { root: pat.keyRoot, scale: SCALE_IONIAN };
    return { root: ce.root, scale: exGetScale(chordToCanonical(ce.chord)) };
  });

  const results = bars.map(() => new Array(stepsPerBar).fill(null));
  const head = window.currentSong && window.currentSong.head;
  if (!head || !head.notes || !head.notes.length) {
    return { results, chordEvents, patterns, effective, subdivisions: 6 };
  }

  // Apply the current Key-seg transposition to the loaded melody.
  // The notes in `head` are stored at the song's ORIGINAL key (as
  // imported from the MusicXML/MIDI file); every key change recomputes
  // the transposed version here rather than mutating the cached data.
  //
  // Strategy:
  //   1. Apply the semitone shift for the key change (0..11 up —
  //      direction is irrelevant because step 2 picks the octave).
  //   2. Scan the ENTIRE transposed melody for its lowest pitch.
  //   3. Add/subtract 12 × N (any integer, positive or negative)
  //      such that the lowest pitch lands AS LOW AS POSSIBLE while
  //      still being ≥ F1 (EX_LOW = 29). That both pulls runaway-
  //      high transpositions back down and lifts below-range notes
  //      up when the original file itself has pitches under F1.
  //   4. Apply the combined shift (keyShift + octaveCorrection) to
  //      every note and re-spell TPCs for the target key.
  const rawOffset = (KEY_TO_PC[currentKey] - KEY_TO_PC[originalKey] + 12) % 12;
  const useFlats = FLAT_KEYS.has(currentKey)
    || (!currentIsMinor && (currentKey === 'C#' || currentKey === 'F#' || currentKey === 'G#'));
  const SHARP_TPCS = [14, 21, 16, 23, 18, 13, 20, 15, 22, 17, 24, 19];
  const FLAT_TPCS  = [14,  9, 16, 11, 18, 13,  8, 15, 10, 17, 12, 19];
  const tpcMapForTranspose = useFlats ? FLAT_TPCS : SHARP_TPCS;
  // Total shift (key change + octave correction) applied UNIFORMLY
  // to every note of the head. No per-note octave displacement —
  // the whole melody moves together.
  //
  //   No key change (rawOffset === 0): zero shift. The MusicXML
  //     source octaves are preserved as-is, even if some notes
  //     fall below F1. The user places notes where they want in
  //     the source file and we respect that.
  //
  //   Key change: transpose by rawOffset, then shift the whole
  //     melody down in whole-octave steps to land as low as
  //     possible while still keeping EVERY note ≥ F1. If the raw
  //     transpose leaves any note below F1, shift up instead.
  let totalShift = 0;
  if (rawOffset !== 0) {
    let minAfter = Infinity;
    for (const n of head.notes) {
      const p = n.midi + rawOffset;
      if (p < minAfter) minAfter = p;
    }
    const octShift = Math.ceil((EX_LOW - minAfter) / 12) * 12;
    totalShift = rawOffset + octShift;
  }
  const transposedNotes = head.notes.map(n => {
    const midi = n.midi + totalShift;
    const pc = ((midi % 12) + 12) % 12;
    // Preserve the ORIGINAL note's explicit spelling when the key
    // hasn't changed (rawOffset === 0) — the MusicXML-sourced TPC is
    // more precise than what a key-based lookup can infer.
    // Otherwise the target key's sharp/flat preference wins.
    const tpc = rawOffset === 0 ? n.tpc : tpcMapForTranspose[pc];
    return {
      stepStart: n.stepStart,
      durationSteps: n.durationSteps,
      tieStart: n.tieStart,
      tieStop: n.tieStop,
      tupletStart: n.tupletStart,
      tupletStop: n.tupletStop,
      tupletActual: n.tupletActual,
      tupletNormal: n.tupletNormal,
      displayType: n.displayType,
      midi, tpc
    };
  });

  // Break `stepsInBar` starting at `startStep` of `barIdx` into one
  // or more slot entries, using the longest standard duration that
  // fits at each position. Chains them with `tieFromPrev` /
  // `tieToNext` flags so the renderer can draw ties between pieces.
  //   `tieFromPrevChunk`: this chunk is the continuation of a prior
  //     chunk of the same note (cross-bar split, or cross-chunk
  //     within the bar), OR this note had an explicit XML tieStop
  //     when it's the first chunk of the first bar.
  //   `chunkTiesForward`: this chunk ties to the next chunk of the
  //     same note (more-bars-to-come), OR — on the very last chunk
  //     of the note — this note had an explicit XML tieStart.
  // Standard durations at 24th-note resolution: whole = 24, dotted-
  // half = 18, half = 12, dotted-quarter = 9, quarter = 6, eighth = 3.
  // (16ths would be 1.5 — non-integer at this resolution — but the Head
  // path doesn't currently emit them.)
  const DUR_FITS = [
    { dur: 'w',  steps: 24 },
    { dur: 'h.', steps: 18 },
    { dur: 'h',  steps: 12 },
    { dur: 'q.', steps: 9 },
    { dur: 'q',  steps: 6 },
    { dur: '8',  steps: 3 }
  ];
  function emitChunk(barIdx, startStep, stepsInBar, pitch, tpc, tieFromPrevChunk, chunkTiesForward) {
    if (barIdx < 0 || barIdx >= bars.length) return;
    let remaining = stepsInBar;
    let cur = startStep;
    let first = true;
    while (remaining > 0) {
      const opt = DUR_FITS.find(f => f.steps <= remaining);
      if (!opt) break;
      if (results[barIdx][cur]) break; // slot occupied — stop
      const isLastInChunk = (remaining === opt.steps);
      results[barIdx][cur] = {
        pitch,
        tpc,
        duration: opt.dur,
        tieFromPrev: first ? tieFromPrevChunk : true,
        tieToNext: !isLastInChunk || chunkTiesForward
      };
      cur += opt.steps;
      remaining -= opt.steps;
      first = false;
    }
  }

  // Map MusicXML <type> values to VexFlow duration tokens. Needed for
  // tuplet members because their raw <duration> doesn't equal a standard
  // note value — only <type> reveals the glyph (quarter triplets render
  // as quarter-note glyphs, 8th triplets as 8th-note glyphs).
  const TYPE_TO_VF = {
    'whole': 'w', 'half': 'h', 'quarter': 'q', 'eighth': '8', '16th': '16', '32nd': '32'
  };

  transposedNotes.forEach(note => {
    // Tuplet members bypass the bar-splitting / tie-chunking logic.
    // A tuplet is always contained within one bar and emits a single
    // slot per note — the renderer groups consecutive tuplet slots
    // into a VF.Tuplet. `stepsConsumed` carries the actual step
    // footprint (e.g. 4 for a quarter triplet at subdiv=6) since it
    // doesn't match the glyph's standard step count.
    if (note.tupletActual && note.tupletNormal && note.displayType) {
      const stepsConsumed = Math.max(1, Math.round(note.durationSteps));
      const vfDur = TYPE_TO_VF[note.displayType] || 'q';
      const barIdx = Math.floor(note.stepStart / stepsPerBar);
      const stepInBar = note.stepStart - barIdx * stepsPerBar;
      if (barIdx < 0 || barIdx >= bars.length) return;
      if (results[barIdx][stepInBar]) return;
      results[barIdx][stepInBar] = {
        pitch: note.midi,
        tpc: note.tpc,
        duration: vfDur,
        stepsConsumed,
        tieFromPrev: !!note.tieStop,
        tieToNext: !!note.tieStart,
        tuplet: {
          start: !!note.tupletStart,
          stop: !!note.tupletStop,
          actual: note.tupletActual,
          normal: note.tupletNormal
        }
      };
      return;
    }

    const totalSteps = Math.max(1, Math.round(note.durationSteps));
    // Walk across bar boundaries. When a note extends past the end
    // of its bar, split it: emit one chunk for the remainder of the
    // current bar, then continue into the next bar(s) with ties.
    let curStep = note.stepStart;
    let remaining = totalSteps;
    let firstBar = true;
    while (remaining > 0) {
      const barIdx = Math.floor(curStep / stepsPerBar);
      if (barIdx >= bars.length) break;
      const stepInBar = curStep - barIdx * stepsPerBar;
      const thisBarChunk = Math.min(remaining, stepsPerBar - stepInBar);
      const isLastBarOfNote = (thisBarChunk === remaining);
      emitChunk(
        barIdx, stepInBar, thisBarChunk,
        note.midi, note.tpc,
        // tieFromPrevChunk: continuation of a cross-bar split, OR
        // first-chunk-of-first-bar with an explicit XML tieStop.
        firstBar ? !!note.tieStop : true,
        // chunkTiesForward: more bars to emit, OR last chunk of note
        // with an explicit XML tieStart.
        !isLastBarOfNote || !!note.tieStart
      );
      curStep += thisBarChunk;
      remaining -= thisBarChunk;
      firstBar = false;
    }
  });

  return { results, chordEvents, patterns, effective, subdivisions: 6 };
}

// ===== Chord-tone eighth-note arpeggio factory =====
// Builds a generator that emits a fixed ascending set of chord-tone
// degrees as eighth notes — e.g. 1-2-3-5 or 3-5-7-9. Shorter chord
// slots shrink the pattern (2 steps → first 2 tones, 3 steps → first
// 3, 4+ steps → full pattern). A chord that owns enough steps to fit
// the pattern TWICE gets its back half marked as a simile repeat.
//
// Pattern selection per time signature: the 4-tone pattern is used
// in every meter EXCEPT 3/4, where a 3-tone pattern is used (a 4-tone
// pattern would spill past a 6-step waltz bar).
//
// First-tone octave selection:
//   - Target the middle of the cello range so the whole arpeggio
//     sits comfortably on the staff.
//   - When possible, pick the octave whose first tone falls between
//     the PREVIOUS pattern's first and last tones — so the prior
//     arpeggio "encloses" this chord's first tone, giving stepwise
//     voice-leading.
//   - If no candidate is enclosed, fall back to the octave closest
//     to the range midpoint.
//
// The returned `results[barIdx]` array has 2× entries per bar
// (eighth-note resolution). The renderer detects the length and
// switches to eighth-note engraving + beaming.
const CELLO_RANGE_MID = 41; // approximate MIDI midpoint of the cello
// `opts.target`: where the pattern should sit in the cello range.
//   'center' — aim the midpoint of the arpeggio at cello midpoint.
//              (Default — used by 1235.)
//   'upper'  — aim the top of the arpeggio just below F3, keeping the
//              line up in the cello's brighter register. (Used by 3579.)
function makeChordToneGenerator(pattern44, pattern34, opts = {}) {
  const targetMode = opts.target === 'upper' ? 'upper' : 'center';
  return function (bars, ts) {
    const beatsPerBar = ts.num;
    const stepsPerBar = beatsPerBar * 2;
    const chordEvents = buildChordEventList(bars);
    const patterns = detectKeyPatterns(chordEvents);
    const effective = chordEvents.map((ce, i) => {
      const pat = patterns.find(p => i >= p.firstIdx && i <= p.lastIdx);
      if (pat && pat.keyMode === 'major') return { root: pat.keyRoot, scale: SCALE_IONIAN };
      return { root: ce.root, scale: exGetScale(chordToCanonical(ce.chord)) };
    });

    const results = bars.map(() => new Array(stepsPerBar).fill(null));
    const degreeIdx = beatsPerBar === 3 ? pattern34 : pattern44;
    const patternLen = degreeIdx.length;
    let prevPitches = null;

    chordEvents.forEach((ce) => {
      // Chord tones come from the chord's OWN scale (so a D7 uses D
      // Mixolydian regardless of any major-key pattern context).
      const chordScale = exGetScale(chordToCanonical(ce.chord));
      const rootPc = ce.root.pitchClass;
      const rootTpc = ce.root.tpc;
      // For degrees past the end of the scale (e.g. the 9th = scale
      // index 8 against a 7-note scale), wrap the index AND bump the
      // semitone offset up by whole octaves so the tone genuinely
      // sits above the root — otherwise a 9th collapses into a 2nd
      // and the pattern span ends up negative, which breaks the
      // range-guard below.
      const tones = degreeIdx.map(idx => {
        const octaveShift = Math.floor(idx / chordScale.length);
        const scaleDeg = chordScale[idx % chordScale.length];
        return {
          semi: scaleDeg.s + octaveShift * 12,
          tpc: rootTpc + scaleDeg.t
        };
      });
      // Semitone span from the pattern's first tone to its last tone.
      // Used to leave enough headroom above the first-tone pitch so
      // the whole arpeggio stays inside the cello range.
      const patternSpan = tones[patternLen - 1].semi - tones[0].semi;
      const firstToneMaxMidi = EX_HIGH - patternSpan;
      // Target first-tone MIDI:
      //   'center' → arpeggio centered on cello midpoint (used by 1235).
      //   'upper'  → arpeggio's top tone sits ~2 semitones below F3
      //              so the line lives in the cello's upper register
      //              without ever crossing the limit (used by 3579).
      const firstToneTargetMidi = targetMode === 'upper'
        ? firstToneMaxMidi - 2
        : Math.round(CELLO_RANGE_MID - patternSpan / 2);
      const firstTonePc = (rootPc + tones[0].semi + 1200) % 12;

      // Allocate eighth-note range for this chord (iRealPro spacing:
      // for 3 chords in a 4-beat bar, first chord gets beats 1-2).
      const { startBeat, endBeat } = chordBeatRange(ce.chordsInBar, ce.chordIdxInBar, beatsPerBar);
      const startStep = startBeat * 2;
      const endStep   = endBeat   * 2;
      const numSteps  = endStep - startStep;

      // 2 steps → first 2 tones | 3 steps → first 3 | 4+ → full pattern.
      // Clamped to the pattern length so a 3/4 exercise never tries to
      // fit a 4-note pattern.
      let toneCount = numSteps <= 2 ? 2 : (numSteps === 3 ? 3 : patternLen);
      toneCount = Math.min(toneCount, patternLen);

      // All octaves of the pattern's first-tone pitch class that leave
      // room for the rest of the pattern above.
      const candidates = [];
      for (let oct = 0; oct < 8; oct++) {
        const p = firstTonePc + oct * 12;
        if (p >= EX_LOW && p <= firstToneMaxMidi) candidates.push(p);
      }
      if (candidates.length === 0) {
        // Relax the upper bound if nothing fits.
        for (let oct = 0; oct < 8; oct++) {
          const p = firstTonePc + oct * 12;
          if (p >= EX_LOW && p <= EX_HIGH) candidates.push(p);
        }
      }

      let firstPitch;
      if (!prevPitches) {
        candidates.sort((a, b) => Math.abs(a - firstToneTargetMidi) - Math.abs(b - firstToneTargetMidi));
        firstPitch = candidates[0] || (firstTonePc + 36);
      } else {
        // Prefer candidates enclosed by the previous pattern's span so
        // voice-leading stays inside the prior chord's footprint.
        const prevFirst = prevPitches[0];
        const prevLast  = prevPitches[prevPitches.length - 1];
        const enclosed = candidates.filter(p => p >= prevFirst && p <= prevLast);
        const pool = enclosed.length ? enclosed : candidates.slice();
        pool.sort((a, b) => Math.abs(a - firstToneTargetMidi) - Math.abs(b - firstToneTargetMidi));
        firstPitch = pool[0] || (firstTonePc + 36);
      }

      // Build ascending chord tones starting from firstPitch.
      const pitches = [firstPitch];
      const tpcs    = [tones[0].tpc];
      for (let j = 1; j < toneCount; j++) {
        const targetPc = (rootPc + tones[j].semi + 1200) % 12;
        let p = pitches[j - 1] + 1;
        while (p <= EX_HIGH + 12) {
          if (((p % 12) + 12) % 12 === targetPc) break;
          p++;
        }
        pitches.push(p);
        tpcs.push(tones[j].tpc);
      }
      // Safety clamp: if the arpeggio's top note still lands above
      // F3 (EX_HIGH) after all of the range-targeting heuristics,
      // shift the whole pattern down an octave. Ensures no note ever
      // exceeds the cello limit, even in edge cases where the only
      // enclosed candidate pushed the line too high.
      while (pitches[pitches.length - 1] > EX_HIGH && pitches[0] - 12 >= EX_LOW) {
        for (let j = 0; j < pitches.length; j++) pitches[j] -= 12;
      }

      // Write the tones into the result buffer at eighth-note slots.
      for (let j = 0; j < toneCount; j++) {
        const step = startStep + j;
        if (step >= endStep) break;
        results[ce.barIdx][step] = {
          pitch: pitches[j],
          tpc: tpcs[j],
          duration: '8'
        };
      }

      // When the chord owns a span that fits the pattern TWICE, repeat
      // it in the back half so the player plays a continuous line of
      // eighths. The RENDERER shows a simile slash in the back half
      // instead of redrawing the notes (see `simileStart` handling in
      // renderChart) — the chart stays uncluttered while playback
      // plays the pattern twice.
      if (toneCount === patternLen && numSteps >= 2 * patternLen) {
        for (let j = 0; j < patternLen; j++) {
          const step = startStep + patternLen + j;
          if (step >= endStep) break;
          results[ce.barIdx][step] = {
            pitch: pitches[j],
            tpc: tpcs[j],
            duration: '8'
          };
        }
        results[ce.barIdx].simileStart = startStep + patternLen;
      }

      prevPitches = pitches;
    });

    return { results, chordEvents, patterns, effective, subdivisions: 2 };
  };
}

// 1-2-3-5 (1-2-3 in 3/4) — e.g. C7 → C D E G. Centered on cello mid.
const generate1235EighthNotes = makeChordToneGenerator([0, 1, 2, 4], [0, 1, 2]);
// 3-5-7-9 (3-5-7 in 3/4) — e.g. C7 → E G Bb D, CMaj7 → E G B D. Aimed
// at the upper register since the arpeggio spans ~10 semitones; with
// the default center target it would sit too low.
const generate3579EighthNotes = makeChordToneGenerator(
  [2, 4, 6, 8], [2, 4, 6], { target: 'upper' }
);

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

// Decide sharp vs flat spelling from a chord root's TPC so that a
// root written with a sharp stays sharp-spelled in the note-info
// panel and on the fingerboard, and a root written with a flat stays
// flat-spelled — regardless of the pitch class's usual preference.
// Returns true (flats), false (sharps), or null (root is natural —
// defer to a pc-based decision).
function useFlatsForTpc(tpc) {
  if (tpc == null) return null;
  const idx = (((tpc - 13) % 7) + 7) % 7;
  const level = (tpc - 13 - idx) / 7;
  if (level > 0) return false; // sharp → sharps
  if (level < 0) return true;  // flat → flats
  return null;
}

// Relate-scale label: the parent major (or minor key name) for the effective
// scale at this chord. Matches the style used for the score's bracket labels.
function relatedScaleLabel(eff, patternKeyName) {
  if (patternKeyName) return patternKeyName;
  const sig = eff.scale.map(x => x.s).join(',');
  const rootPc = eff.root.pitchClass;
  const parent = parentMajorPc(eff);
  // Prefer the spelling that matches how the chord ROOT was written
  // (D#7 stays sharp-spelled: "D# Mixolydian (G# Major)"; Eb7 stays
  // flat-spelled: "Eb Mixolydian (Ab Major)"). Only fall back to the
  // parent-major-based preference when the root is a natural letter.
  const rootPref = useFlatsForTpc(eff.root.tpc);
  const useFlats = rootPref != null ? rootPref : FLAT_PARENT_PCS.has(parent);
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
  // Match the generator's time resolution — quarter-note generators
  // produce ts.num slots per bar; the 1235 generator produces 2×.
  const firstFilled = quarterNotes.find(a => a && a.length);
  const stepsPerBar = firstFilled ? firstFilled.length : ts.num;
  const subdiv      = Math.max(1, Math.round(stepsPerBar / ts.num));
  const beatInfo = bars.map(() => new Array(stepsPerBar).fill(null));
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
    // First check if the chord root's TPC (or the pattern keyRoot's
    // TPC) gives us an unambiguous sharp/flat preference — matches
    // how the chord was written (D#7 stays sharp, Eb7 stays flat).
    // Fall back to the pc-based FLAT_PARENT_PCS decision only when
    // the root letter is natural.
    const tpcPref = pat
      ? useFlatsForTpc(pat.keyRoot.tpc)
      : useFlatsForTpc(eff.root.tpc);
    const useFlats = tpcPref != null ? tpcPref : FLAT_PARENT_PCS.has(contextPc);
    const { startBeat, endBeat } = chordBeatRange(ce.chordsInBar, ce.chordIdxInBar, ts.num);
    // Convert beat range to step range so higher-resolution generators
    // (e.g. 1235 eighth notes) fill their extra slots too.
    const startStep = startBeat * subdiv;
    const endStep   = endBeat   * subdiv;
    for (let b = startStep; b < endStep; b++) {
      const bp = quarterNotes[ce.barIdx][b];
      beatInfo[ce.barIdx][b] = {
        pitch: bp ? bp.pitch : null,
        tpc: bp ? bp.tpc : null,
        // Carry the note's duration (as a VexFlow-style string, e.g.
        // 'q.', 'h') through so the playback scheduler can add up
        // per-chunk durations across a tied chain.
        duration: bp ? bp.duration : null,
        // Carry tie flags through so the playback scheduler can
        // treat a tied chain as a single sustained note (attack
        // once at the start, release at the end) instead of
        // re-attacking on every tied piece.
        tieFromPrev: bp ? !!bp.tieFromPrev : false,
        tieToNext:   bp ? !!bp.tieToNext   : false,
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
        // Ring color encodes THIS note's fingering position — blue
        // for 1st, red for half, green for upper. A bar in "upper"
        // can still have a lone note (out of the upper reach) that
        // plays in 1st; that note gets a blue ring even though its
        // siblings are green. Falls back to black if no per-pitch
        // color was supplied (early boot, etc.).
        const ringColor = state.ringColors && state.ringColors[midi]
          ? state.ringColors[midi]
          : '#000';
        ring.setAttribute('stroke', ringColor);
        ring.setAttribute('stroke-width', isOpen ? '3' : '2.2');
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
let chartSize = 180;
let songRepeats = 1;
let exerciseMode = 'scale'; // 'scale' = walk the scale, 'chord' = 1-3-5-7 arpeggio
const barElements = []; // [ { rowEl, x, y, w, h } ] per bar index, for highlighting

// Refresh the title line above the score: "{song name} ({exercise})".
// Called on song load and whenever the exercise picker changes, so the
// title always reflects what's currently being drawn. Takes an optional
// explicit song arg for the render-time case (renderChart fires before
// `window.currentSong` is assigned in loadSong); callers from elsewhere
// can fall back on the global.
function updateScoreTitle(songArg) {
  const el = document.getElementById('scoreTitle');
  if (!el) return;
  const song = songArg ||
    (window.currentSong && window.currentSong.song) || null;
  const title = (song && song.title) || '';
  const sel = document.getElementById('exerciseSelect');
  let exLabel = '';
  if (sel && sel.selectedIndex >= 0) {
    const opt = sel.options[sel.selectedIndex];
    if (opt) exLabel = opt.text || '';
  }
  el.textContent = title && exLabel ? `${title} (${exLabel})` : title || '';
}

// Split the input bars at the first coda (Q) marker and, when the
// song is set to repeat, emit body*N then coda*1 (not body+coda*N).
// iRealPro charts show the coda section once at the very bottom of
// the sheet — it's played only once even when the main body loops
// several times — so our expanded bar list should reflect that.
function expandBarsByRepeats(bars, n) {
  let codaStart = -1;
  for (let i = 0; i < bars.length - 1; i++) {
    if (bars[i].markers && bars[i].markers.some(m => m.type === 'coda')) {
      codaStart = i + 1;
      break;
    }
  }
  const hasCoda = codaStart >= 0;
  if (n <= 1 && !hasCoda) return bars.slice();
  const body = hasCoda ? bars.slice(0, codaStart) : bars;
  const coda = hasCoda ? bars.slice(codaStart) : [];
  const reps = Math.max(1, n);
  const out = [];
  for (let r = 0; r < reps; r++) for (let i = 0; i < body.length; i++) out.push(body[i]);
  for (let i = 0; i < coda.length; i++) out.push(coda[i]);
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
    // iRealPro encodes minor-major (e.g. Cm(maj7)) as "-^" followed
    // by the extension. Without this branch we'd swallow the "-"
    // and leave "^7" behind as an extension, which rendered as
    // plain "Cm" (the caret + 7 were lost in the accidental
    // substitution pass). Keep the Maj7 quality label consistent
    // with how "^7" alone renders elsewhere in the chart.
    if (r.startsWith('^')) {
      r = r.substring(1);
      if (r.startsWith('7')) { quality = 'mMaj7'; r = r.substring(1); }
      else { quality = 'mMaj'; }
    } else {
      quality = 'm';
    }
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

  // Song title line at the top of the score: "{song} ({exercise})".
  // The old in-button text label was replaced by a folder icon when
  // the song picker was converted to an icon-only button. Pass `song`
  // explicitly because renderChart runs BEFORE loadSong assigns
  // `window.currentSong`, so the global fallback isn't populated yet.
  updateScoreTitle(song);

  if (!window.Vex || !window.Vex.Flow) {
    chartEl.textContent = 'VexFlow failed to load.';
    return;
  }
  const VF = Vex.Flow;
  const ts = parseTimesig(timesigStr);

  // "Head" exercise with no matching .musicxml / .mid in the songs/
  // folder → short-circuit with a clear "No head found" message
  // instead of rendering empty staves that would confuse the user.
  // `headLoaded` guards against flashing the message during the
  // async fetch — only show it once the load actually resolved
  // with no data.
  if (exerciseMode === 'head'
      && window.currentSong
      && window.currentSong.headLoaded
      && !window.currentSong.head) {
    const msg = document.createElement('div');
    msg.className = 'no-head-message';
    msg.textContent = 'No head found';
    chartEl.appendChild(msg);
    return;
  }

  // Expand by song repeats and generate quarter notes across the whole thing.
  // Exercise mode switches which generator we use:
  //   - "scale"   → walk the current chord's scale (one note per beat)
  //   - "chord"   → arpeggiate 1-3-5-7 through the chord tones
  //   - "broken3" → alternating base / diatonic-3rd pairs, stepping through
  //                 the scale (MuseScore ExerciseBuilder "Broken 3rds")
  //   - "cantus"  → one descending scale tone per chord (Cantus Firmus)
  const bars = expandBarsByRepeats(barsIn, songRepeats);
  const gen = exerciseMode === 'head' ? generateHeadFromScore
            : exerciseMode === 'chord' ? generate1357QuarterNotes
            : exerciseMode === 'triads' ? generateTriadsQuarterNotes
            : exerciseMode === 'broken3' ? generateBroken3rdsQuarterNotes
            : exerciseMode === 'cantus' ? generateCantusFirmusQuarterNotes
            : exerciseMode === '1235' ? generate1235EighthNotes
            : exerciseMode === '3579' ? generate3579EighthNotes
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
  // Eighth-note exercises (1235 / 3579 / Head) pack up to 8 notes per
  // bar with lots of accidentals — give them ~1.6x the per-bar width
  // so VexFlow's formatter isn't forced to overflow the stave on the
  // right.
  const eighthNoteExercise =
    exerciseMode === '1235' || exerciseMode === '3579' || exerciseMode === 'head';
  const measureWidth = Math.round(chartSize * (eighthNoteExercise ? 1.6 : 1));
  const leftPadding = 14;
  const rightPadding = 14;
  const firstMeasureClefWidth = 68; // bass clef + 8vb + time sig on line 1
  // Previously reserved width for the bass clef on continuation rows.
  // We now omit the clef on every row after the first and redistribute
  // this width across the row's bars as extra note space.
  const clefOnlyExtra = 44;
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
  // Coda break-points: bar indices that should start a fresh row
  // because the previous bar carried a coda (Q) marker. iRealPro
  // renders the coda section on its own line at the bottom of the
  // chart; matching that layout here means the reader can see the
  // repeat body and the coda tail as visually distinct sections.
  const codaBreaks = new Set();
  bars.forEach((b, i) => {
    if (b.markers && b.markers.some(m => m.type === 'coda') && i + 1 < bars.length) {
      codaBreaks.add(i + 1);
    }
  });
  // Cross-ROW tie state. When a row finishes with an unmatched
  // outgoing tie (its last tied note had tieToNext and nothing in
  // that row consumed it), we stash the note + its row's drawing
  // context here. The next row's first note — if it's flagged
  // tieFromPrev — consumes this and triggers a pair of "partial"
  // ties: an outgoing slur off the right edge of the previous row
  // and an incoming slur coming in from the left edge of the next.
  let crossRowPending = null; // { note: VF.StaveNote, context }
  let rowStart = 0;
  while (rowStart < bars.length) {
    // Clip each row to the next pass boundary so repeats always break on a
    // new row and get their horizontal separator.
    const passIdx = Math.floor(rowStart / formSize);
    const passBoundary = Math.min(bars.length, (passIdx + 1) * formSize);
    let rowEnd = Math.min(rowStart + mpl, passBoundary);
    // Force a row break at any coda boundary inside this row's window.
    for (let k = rowStart + 1; k < rowEnd; k++) {
      if (codaBreaks.has(k)) { rowEnd = k; break; }
    }
    const rowBars = bars.slice(rowStart, rowEnd);
    const isFirstRow = rowStart === 0;
    // Only the first row shows the bass clef. Continuation rows omit it
    // entirely; the width that used to hold the clef is redistributed to
    // the row's measures as additional note space.
    const clefExtra = isFirstRow ? firstMeasureClefWidth : 0;
    const extraPerBar = isFirstRow ? 0 : Math.floor(clefOnlyExtra / mpl);
    const barWidth = measureWidth + extraPerBar;
    // Always size the row as if it were a full MPL row so short rows (last
    // row, end-of-pass) keep the same per-bar width as full rows and the
    // remainder of the staff sits as empty space to the right.
    const rowWidth = leftPadding + clefExtra + mpl * barWidth + rightPadding;

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
    // Cross-bar tie state: the most recent note in this row that was
    // flagged `tieToNext`. When the next bar's first note is flagged
    // `tieFromPrev`, we connect them with a StaveTie drawn on the row's
    // shared context.
    let pendingTieFromBar = null; // { note: VF.StaveNote }
    // Ties (within-bar and cross-bar) to draw after all bars render.
    const rowTies = [];
    // Tuplet groups (e.g. quarter triplets) collected per row. Each
    // entry is { notes: [VF.StaveNote, ...], ratio: { actual, normal } }
    // and gets wrapped in a VF.Tuplet + drawn after the voice.
    const rowTuplets = [];
    rowBars.forEach((bar, i) => {
      const barIdx = rowStart + i;
      const isFirstInRow = i === 0;
      const width = barWidth + (isFirstInRow ? clefExtra : 0);
      // left_bar/right_bar default to true in VexFlow, which draws grey
      // vertical edges at the stave's left and right — the "border" around
      // each measure. Turn them off; we manage measure boundaries via
      // Barline modifiers only (and only for repeats / final / double).
      const stave = new VF.Stave(x, staffY, width, { left_bar: false, right_bar: false });
      // Clef + time signature only on the very first measure of the score.
      // Continuation rows skip the clef to keep the reading surface dense
      // and to make more note space available inside each bar.
      if (isFirstRow && isFirstInRow) {
        stave.addClef('bass', undefined, '8vb');
        stave.addTimeSignature(ts.str);
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
      const rawBeatPitches = quarterNotes[barIdx] || [];
      // When the generator tagged this bar as a simile-repeat (a single
      // chord owning a full bar, pattern repeated for playback), drop
      // the duplicate back-half entries for rendering. The empty-slot
      // coalescer then emits a single half-rest there, and we overlay
      // a simile glyph on top after the voice draws.
      const simileStart = rawBeatPitches.simileStart;
      const beatPitches = (simileStart != null)
        ? rawBeatPitches.map((bp, idx) => idx >= simileStart ? null : bp)
        : rawBeatPitches;
      // Slot indexes of the rest(s) that cover the simile area. For 4/4
      // this is typically one half-rest; for 3/4 it's a quarter+eighth
      // pair. All of them get hidden when we paint the simile glyph.
      const simileRestSlots = [];
      const notes = [];
      // Parallel to `notes[]`: pitch per rendered note slot (null for
      // rests). Used by the fingering overlay so we can look up MIDI
      // pitches for each note-head in the bar.
      const barNoteData = [];
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

      // Detect subdivision from the generator's output. Quarter-note
      // generators return one slot per beat (length == ts.num); the
      // 1235 generator returns eighth notes (length == 2 * ts.num);
      // the Head generator uses 24ths (length == 6 * ts.num) so
      // triplets fit as integer step counts.
      const stepsPerBar = beatPitches.length || ts.num;
      const subdiv      = Math.max(1, Math.round(stepsPerBar / ts.num));
      const defaultDur  = subdiv >= 2 ? '8' : 'q';
      const restDur     = subdiv >= 2 ? '8r' : 'qr';
      // Steps-per-duration for each resolution. A quarter = 2 steps
      // at 8th resolution, 6 steps at 24th resolution, 1 step at
      // quarter resolution.
      const DUR_TO_STEPS = subdiv === 6
        ? { 'w': 24, 'h.': 18, 'h': 12, 'q.': 9, 'q': 6, '8': 3 }
        : subdiv === 2
        ? { 'w': 8,  'h.': 6,  'h': 4,  'q.': 3, 'q': 2, '8': 1 }
        : { 'w': 4,  'h.': 3,  'h': 2,  'q.': 1.5, 'q': 1 };
      // For each step in this bar, which entry of `notes[]` covers it?
      // Cantus firmus writes one long note across multiple beats, so the
      // same slot index can be referenced by several steps. Rests get -1.
      const beatToNoteSlot = new Array(stepsPerBar).fill(-1);
      // Tie bookkeeping: track the most recent note in THIS bar that
      // was flagged tieToNext (so the next note emitted with
      // tieFromPrev can be paired with it). The row-scoped
      // `pendingTieFromBar` covers the cross-bar case.
      let pendingTieInBar = null;
      // Tuplet bookkeeping: when a slot is flagged `tuplet.start`, we
      // collect subsequent tuplet notes into this array until we see
      // `tuplet.stop`, then build a VF.Tuplet that wraps them so VexFlow
      // renders the "3" bracket and proportional spacing.
      let currentTupletNotes = null;
      let currentTupletRatio = null;
      let b = 0;
      while (b < stepsPerBar) {
        const bp = beatPitches[b];
        if (bp) {
          const dur = bp.duration || defaultDur;
          // Tuplet members carry an explicit `stepsConsumed` because
          // their glyph's standard step count (e.g. 6 for a quarter at
          // subdiv=6) doesn't match their actual footprint (4 for a
          // quarter triplet). Non-tuplet notes fall back to the lookup.
          const consume = bp.stepsConsumed || DUR_TO_STEPS[dur] || 1;
          const { key, letterIdx, level, octave } = midiTpcToVexKey(bp.pitch, bp.tpc);
          const posKey = letterIdx + ':' + octave;
          // Stem direction: on/above middle line of the staff → stem down,
          // below middle line → stem up. Bass-clef middle line is D3 (MIDI 50);
          // we render an octave up (8vb), so written MIDI = sounding + 12.
          // Therefore sounding MIDI >= 38 (D2) → stem down.
          const stemDir = bp.pitch >= 38 ? VF.Stem.DOWN : VF.Stem.UP;
          // VexFlow 4's StaveNote doesn't accept dotted durations
          // ("q.", "h.") directly — dots are separate modifiers.
          // Strip trailing dots, remember the count, construct the
          // note with the undotted duration, then attach dot(s).
          let noteDur = dur;
          let dotCount = 0;
          while (noteDur.endsWith('.')) { dotCount++; noteDur = noteDur.slice(0, -1); }
          const n = new VF.StaveNote({ clef: 'bass', keys: [key], duration: noteDur, stem_direction: stemDir });
          if (dotCount > 0 && VF.Dot && VF.Dot.buildAndAttach) {
            VF.Dot.buildAndAttach([n], { all: true });
          }

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

          // Tie wiring: if this note consumes the tail of a previous
          // tied note (tieFromPrev), pair it with whichever tie is
          // pending — same bar first, cross-bar within row second,
          // cross-row (partial-tie pair) third.
          if (bp.tieFromPrev) {
            if (pendingTieInBar) {
              rowTies.push({ first: pendingTieInBar, last: n });
            } else if (pendingTieFromBar) {
              rowTies.push({ first: pendingTieFromBar, last: n });
              pendingTieFromBar = null;
            } else if (crossRowPending) {
              // Cross-row tie: queue an outgoing partial tie on the
              // PREVIOUS row (drawn on that row's context) and an
              // incoming partial tie on THIS row (drawn on this
              // row's context after voice.draw runs).
              rowTies.push({
                first: crossRowPending.note,
                last: null,
                altContext: crossRowPending.context
              });
              rowTies.push({ first: null, last: n });
              crossRowPending = null;
            }
          }
          pendingTieInBar = bp.tieToNext ? n : null;

          const slotIdx = notes.length;
          notes.push(n);
          // Keep the StaveNote ref alongside the pitch/tpc so the
          // fingering overlay can ask VexFlow directly for the
          // notehead position (getAbsoluteX / getYs) instead of
          // relying on DOM bounding-rect geometry — the latter
          // includes the accidental glyph and throws off centering
          // on sharps/flats. `duration` lets the overlay detect
          // hollow noteheads (whole / half) so it can swap to a
          // white-circle-on-black-text scheme that reads against a
          // transparent notehead.
          barNoteData.push({ pitch: bp.pitch, tpc: bp.tpc, staveNote: n, duration: noteDur });
          for (let bb = b; bb < b + consume && bb < stepsPerBar; bb++) {
            beatToNoteSlot[bb] = slotIdx;
          }
          // Tuplet collection: accumulate consecutive tuplet members
          // into a group, then construct the VF.Tuplet as soon as the
          // stop marker arrives. Construction (not just drawing) has to
          // happen BEFORE voice.draw runs so VexFlow's tick multiplier
          // (normal/actual) is applied to every member before the
          // Formatter positions them. The bracket gets drawn later,
          // after voice.draw, via `rowTuplets`.
          if (bp.tuplet) {
            if (bp.tuplet.start) {
              currentTupletNotes = [n];
              currentTupletRatio = { actual: bp.tuplet.actual, normal: bp.tuplet.normal };
            } else if (currentTupletNotes) {
              currentTupletNotes.push(n);
            }
            if (bp.tuplet.stop && currentTupletNotes) {
              const ratio = currentTupletRatio || { actual: 3, normal: 2 };
              const tupletObj = new VF.Tuplet(currentTupletNotes, {
                num_notes: ratio.actual,
                notes_occupied: ratio.normal,
                bracketed: true
              });
              rowTuplets.push({ tuplet: tupletObj });
              currentTupletNotes = null;
              currentTupletRatio = null;
            }
          }
          b += consume;
        } else {
          // Coalesce a run of empty eighth-note slots into the fewest
          // rests possible — avoids rendering 4 eighth rests when half
          // a bar is silent (e.g. after a 1-2-3-5 pattern). Find how
          // many consecutive empty steps start here, then peel off the
          // largest standard rest that fits without crossing a half-bar
          // (beat) boundary.
          let run = 0;
          while (b + run < stepsPerBar && !beatPitches[b + run]) run++;
          // Rests, largest first, measured in steps at the active
          // subdivision. Half-bar alignment prevents a half-rest
          // spanning beats 2-3 across the middle of the bar.
          const restOptions = subdiv === 6
            ? [ { dur: 'h', steps: 12 }, { dur: 'q', steps: 6 }, { dur: '8', steps: 3 } ]
            : subdiv === 2
            ? [ { dur: 'h', steps: 4  }, { dur: 'q', steps: 2 }, { dur: '8', steps: 1 } ]
            : [ { dur: 'h', steps: 2  }, { dur: 'q', steps: 1 } ];
          const halfBarSteps = stepsPerBar / 2;
          // Whole-bar shortcut: when the entire bar is silent and we're
          // starting at beat 1, emit ONE rest spanning the bar — a
          // whole rest in 4/4 or a dotted-half rest in 3/4 — instead
          // of subdividing into q+8+q+8 chunks.
          const fullBarRestDur = (b === 0 && run === stepsPerBar)
            ? (ts.num === 4 ? 'w' : ts.num === 3 ? 'h.' : null)
            : null;
          // Helper: build a rest StaveNote, stripping any trailing dots
          // and attaching them as Dot modifiers (VexFlow doesn't accept
          // dotted duration tokens directly, same as for dotted notes).
          const makeRestNote = (dur) => {
            let base = dur;
            let dots = 0;
            while (base.endsWith('.')) { dots++; base = base.slice(0, -1); }
            const r = new VF.StaveNote({ clef: 'bass', keys: ['d/3'], duration: base + 'r' });
            if (dots > 0 && VF.Dot && VF.Dot.buildAndAttach) {
              VF.Dot.buildAndAttach([r], { all: true });
            }
            return r;
          };
          if (fullBarRestDur) {
            if (simileStart != null && b >= simileStart) {
              simileRestSlots.push(notes.length);
            }
            notes.push(makeRestNote(fullBarRestDur));
            barNoteData.push(null);
            b += run;
            run = 0;
          }
          while (run > 0) {
            // Biggest rest that (a) fits in remaining run, (b) doesn't
            // cross the midpoint of the bar if starting in the first
            // half, and (c) starts on a boundary its duration requires.
            let chosen = restOptions[restOptions.length - 1]; // fallback
            for (const opt of restOptions) {
              if (opt.steps > run) continue;
              // Half rests must start on beat 1 or beat 3 (step 0 or halfBarSteps).
              if (opt.dur === 'h' && (b % halfBarSteps) !== 0) continue;
              // Don't span across the half-bar boundary.
              if (b < halfBarSteps && b + opt.steps > halfBarSteps) continue;
              chosen = opt;
              break;
            }
            if (simileStart != null && b >= simileStart) {
              // Remember every rest slot that falls inside the simile
              // region so we can hide them all and draw the slash
              // glyph on top. In 4/4 that's a single half-rest; in
              // 3/4 it's typically a quarter-rest + eighth-rest pair.
              simileRestSlots.push(notes.length);
            }
            notes.push(makeRestNote(chosen.dur));
            barNoteData.push(null);
            b += chosen.steps;
            run -= chosen.steps;
          }
        }
      }
      // Carry the last note of this bar to the next bar for the courtesy check.
      prevLastNote = lastNoteOfBar;
      // Carry the pending cross-bar tie. If this bar's last tie-flagged
      // note wasn't consumed within the bar, it waits for the first
      // note of the next bar (same row) to pair with.
      pendingTieFromBar = pendingTieInBar;
      const voice = new VF.Voice({ num_beats: ts.num, beat_value: ts.denom, resolution: VF.RESOLUTION });
      voice.setStrict(false);
      voice.addTickables(notes);
      // Generate beams BEFORE voice.draw — the Beam object attaches
      // to each note and tells it to render with a beam bar instead
      // of its own flag. Doing this after draw leaves each 8th note
      // with its flag already painted plus the beam on top.
      let barBeams = [];
      if (subdiv >= 2) {
        // Beam group size depends on the time signature:
        //   4/4 → 4 eighth notes per beam (4+4 across the bar), so a
        //         "4 eighths + 4 rests" bar produces a single 4-note
        //         beam followed by the rests.
        //   3/4 → 3 eighth notes per beam (3+3 across the bar),
        //         matching the waltz 1-2-3 / 1-2-3 grouping.
        // Rests naturally break beams so partial-bar chords still
        // engrave correctly.
        const beamFrac = ts.num === 3
          ? new VF.Fraction(3, 8)
          : new VF.Fraction(4, 8);
        barBeams = VF.Beam.generateBeams(notes, { groups: [beamFrac] });
      }
      const noteStart = stave.getNoteStartX();
      const noteEnd = stave.getNoteEndX();
      new VF.Formatter().joinVoices([voice]).format([voice], noteEnd - noteStart - 10);
      // Count the stavenote elements that already existed in this row's
      // SVG before the voice draws (previous bars in the row). After draw
      // we can slice off the newly-added ones.
      const beforeCount = rowEl.querySelectorAll('.vf-stavenote').length;
      voice.draw(context, stave);
      barBeams.forEach(beam => beam.setContext(context).draw());
      // Draw any tuplet brackets whose members live in this bar. The
      // VF.Tuplet objects were constructed during the slot loop (so
      // their tick multipliers fed into the Formatter) but drawing
      // must happen after voice.draw so the bracket overlays the
      // notes.
      rowTuplets.forEach(t => {
        if (t._drawn) return;
        t.tuplet.setContext(context).draw();
        t._drawn = true;
      });
      const allStaveNotes = rowEl.querySelectorAll('.vf-stavenote');
      const barNoteEls = Array.from(allStaveNotes).slice(beforeCount);

      // If this bar is a simile-repeat, hide the half-rest and draw a
      // "%"-style simile glyph centered on the staff: a thick diagonal
      // slash through the middle line, with one dot in the upper-left
      // corner and one in the lower-right corner (perpendicular to
      // the slash — together they read as a percent sign).
      if (simileStart != null && simileRestSlots.length > 0) {
        // Hide every rest that covers the simile region (may be more
        // than one in 3/4, where the back half = dotted-quarter worth
        // of silence splits into a quarter + eighth rest).
        simileRestSlots.forEach(slot => {
          const el = barNoteEls[slot];
          if (el) el.setAttribute('visibility', 'hidden');
        });
        const svgEl = rowEl.querySelector('svg');
        // Center of the simile region = midpoint of the bar's back
        // half. simileStart always sits at the midpoint of the bar's
        // note area, so 75% of the bar width works in 4/4 and 3/4.
        const simileX = noteStart + (noteEnd - noteStart) * 0.75;
        // Ask the stave itself for the middle-line y — VexFlow offsets
        // the stave internally so staffY isn't directly usable here.
        const midY = stave.getYForLine(2);
        const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        g.setAttribute('class', 'simile-mark');
        // Thick diagonal slash, lower-left to upper-right, spanning
        // roughly two staff spaces.
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', simileX - 11);
        line.setAttribute('y1', midY + 11);
        line.setAttribute('x2', simileX + 11);
        line.setAttribute('y2', midY - 11);
        line.setAttribute('stroke', '#000');
        line.setAttribute('stroke-width', '4.5');
        line.setAttribute('stroke-linecap', 'round');
        g.appendChild(line);
        // Dots: upper-left (negative x, negative y) and lower-right
        // (positive x, positive y) of the slash — the two corners the
        // slash leaves empty — forming a percent sign.
        [[-7, -7], [+7, +7]].forEach(([dx, dy]) => {
          const d = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
          d.setAttribute('cx', simileX + dx);
          d.setAttribute('cy', midY + dy);
          d.setAttribute('r', '2.4');
          d.setAttribute('fill', '#000');
          g.appendChild(d);
        });
        svgEl.appendChild(g);
      }

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
        const beatsPerBarLabel = ts.num;
        displayChords.forEach((ch, ci) => {
          // Chord label is anchored at the beat the chord actually falls on.
          // Use the same uneven-bar allocation the generators use so a
          // "GMaj7 Eb7 D7" bar reads with GMaj7 above beat 1, Eb7 above
          // beat 3, and D7 above beat 4 — not evenly spaced at 0, 1/3, 2/3.
          const { startBeat } = chordBeatRange(n, ci, beatsPerBarLabel);
          const cx = labelAreaX0 + (startBeat / beatsPerBarLabel) * labelAreaW;
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
        noteData: barNoteData,
        beatToNoteSlot
      };

      x += width;
    });

    // Draw all queued ties. Three shapes:
    //   - Within-bar / cross-bar (first + last both set) → single
    //     tie drawn on this row's context.
    //   - Outgoing partial (first set, last null, altContext is the
    //     previous row's context) → slur off the right edge of the
    //     previous row.
    //   - Incoming partial (first null, last set) → slur coming in
    //     from the left edge of this row to the note.
    rowTies.forEach(t => {
      if (!t.first && !t.last) return;
      const tie = new VF.StaveTie({
        first_note: t.first,
        last_note: t.last,
        first_indices: [0],
        last_indices: [0]
      });
      tie.setContext(t.altContext || context).draw();
    });

    // If this row ended with an unmatched tieToNext note, stash it
    // as the pending cross-row tie so the next row's first note can
    // consume it. Replaces any previous crossRowPending (if that one
    // wasn't consumed, the intended tie was malformed — drop it).
    crossRowPending = pendingTieFromBar
      ? { note: pendingTieFromBar, context }
      : null;

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
      // Translate chord indexes within a bar to beat positions using the
      // same uneven-bar allocation as the generators, so pattern underlines
      // line up with the chord labels (e.g. Eb7 on beat 3 of a 3-chord bar).
      let startX = leftBar.noteStartX;
      if (isPatternStart && firstCE.chordsInBar > 1) {
        const barW = leftBar.noteEndX - leftBar.noteStartX;
        const { startBeat } = chordBeatRange(firstCE.chordsInBar, firstCE.chordIdxInBar, ts.num);
        startX = leftBar.noteStartX + (startBeat / ts.num) * barW;
      }
      let endX = rightBar.noteEndX;
      if (isPatternEnd && lastCE.chordsInBar > 1) {
        const barW = rightBar.noteEndX - rightBar.noteStartX;
        const { endBeat } = chordBeatRange(lastCE.chordsInBar, lastCE.chordIdxInBar, ts.num);
        endX = rightBar.noteStartX + (endBeat / ts.num) * barW;
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

    // Add a horizontal separator between full-form repeats. Tag the
    // separator with the NEXT pass's label (e.g. "Repeat 2" for the
    // line that introduces the second pass) so the CSS can render
    // the text inline at the left edge. The first pass gets no
    // label — it's just the song body.
    if (rowEnd === passBoundary && passBoundary < bars.length) {
      const nextPassNumber = passIdx + 2;
      const sep = document.createElement('div');
      sep.className = 'form-separator';
      sep.dataset.repeatLabel = 'Repeat ' + nextPassNumber;
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
let transport, piano, hat, rideBody, rideBell, rideNoise, click, drumsOut, pianoOut, leadOut;
let realHihat, brushSweep, brushTap;
let guitar; // Sampler used by the "Play Score" switch.
// Real drum loops, looped via the Transport. Each entry records the source
// bpm so playbackRate can be adapted if the user-selected tempo differs.
const realLoops = {};  // key "ballad-4/4" → { player, sourceBpm }
let currentRealLoop = null;
let drumMode = 'ride'; // 'hat' | 'ride' | 'click'
let countInBars = 1;  // 0, 1, or 2 measures of click before the song starts
let loopCountIn = false; // when true, the count-in fires at the top of every loop iteration
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

  // Piano comping bus — Piano-row volume slider controls this gain.
  const initPianoVol = parseInt(document.getElementById('pianoVol').value, 10) / 100;
  pianoOut = new Tone.Gain(isFinite(initPianoVol) ? initPianoVol : 0.4).connect(reverb);

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
    // Base sampler volume lifted ~3 dB (≈ 40% louder in linear gain)
    // so the Piano slider at 40% sits at a comfortable level without
    // needing to move the slider.
    volume: -3
  }).connect(pianoOut);

  // Lead (Play Score) bus — Lead-row volume slider controls this gain.
  const initLeadVol = parseInt(document.getElementById('leadVol').value, 10) / 100;
  leadOut = new Tone.Gain(isFinite(initLeadVol) ? initLeadVol : 0.4).connect(reverb);

  // Clean electric (jazz) guitar sampler for the "Play Score" switch.
  // Uses the nbrosowsky/tonejs-instruments guitar-electric pack.
  // Tone.Sampler interpolates intermediate pitches from these
  // samples. Shares the same reverb bus as the piano comping.
  guitar = new Tone.Sampler({
    urls: {
      'C#2': 'Cs2.mp3',
      'E2':  'E2.mp3',
      'F#2': 'Fs2.mp3',
      'A2':  'A2.mp3',
      'C3':  'C3.mp3',
      'D#3': 'Ds3.mp3',
      'F#3': 'Fs3.mp3',
      'A3':  'A3.mp3',
      'C4':  'C4.mp3',
      'D#4': 'Ds4.mp3',
      'F#4': 'Fs4.mp3',
      'A4':  'A4.mp3',
      'C5':  'C5.mp3',
      'D#5': 'Ds5.mp3',
      'F#5': 'Fs5.mp3',
      'A5':  'A5.mp3',
      'C6':  'C6.mp3'
    },
    baseUrl: 'https://nbrosowsky.github.io/tonejs-instruments/samples/guitar-electric/',
    release: 0.6,
    volume: -2
  }).connect(leadOut);

  document.getElementById('status').textContent = 'Loading samples…';

  // Shared drum bus so a single slider controls all drum volumes.
  // Applied through a 0.9 trim — brings the drums down ~10% relative
  // to the slider reading so the 40% default sits at a more balanced
  // level against the piano without requiring the user to move the
  // slider. The listener below mirrors this scaling.
  const initVol = parseInt(document.getElementById('drumVol').value, 10) / 100;
  drumsOut = new Tone.Gain((isFinite(initVol) ? initVol : 0.4) * 0.9).toDestination();

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
  realLoops['ballad-3/4'] = {
    player: new Tone.Player({
      url: 'drums/ballad-3-4-80bpm.mp3',
      loop: true, autostart: false, fadeIn: 0.005, fadeOut: 0.005, volume: 0
    }).connect(drumsOut),
    beats: 12 // 4 bars of 3/4
  };
  realLoops['medium-3/4'] = {
    player: new Tone.Player({
      url: 'drums/medium-3-4-120bpm.mp3',
      loop: true, autostart: false, fadeIn: 0.005, fadeOut: 0.005, volume: 0
    }).connect(drumsOut),
    beats: 12 // 4 bars of 3/4
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
  realLoops['up-3/4'] = {
    player: new Tone.Player({
      url: 'drums/up-3-4-180bpm.mp3',
      loop: true, autostart: false, fadeIn: 0.005, fadeOut: 0.005, volume: 0
    }).connect(drumsOut),
    beats: 12 // 4 bars of 3/4
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
  // Clear any pending AudioParam events on pianoOut.gain. The loop
  // count-in cleanup callback schedules setValueAtTime(0) at the
  // start of each tail and setValueAtTime(sliderVol) at the next
  // loopStart — those are Web Audio scheduled events that survive
  // Transport.cancel(). Without this reset, a rebuild during a
  // tail leaves orphaned gain=0 events that fire later and mute
  // the piano mid-body.
  if (typeof pianoOut !== 'undefined' && pianoOut) {
    try {
      pianoOut.gain.cancelScheduledValues(Tone.now());
      const sliderVol = parseInt(document.getElementById('pianoVol').value, 10) / 100;
      pianoOut.gain.setValueAtTime(isFinite(sliderVol) ? sliderVol : 0.4, Tone.now());
    } catch (e) {}
  }
  playState = 'stopped';
  pauseContext = null;
  const btn = document.getElementById('playBtn');
  btn.querySelector('.play-glyph').textContent = '▶';
  btn.classList.remove('playing');
  clearHighlight();
  clearNoteHighlight();
  clearFingeringOverlay();
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

// ===== Fingering overlay =====
// 1st-position cello fingering table, ported from the MuseScore
// `cellofingering.qml` plugin. Key = sounding MIDI pitch, value =
// finger label. Each string spans 7 semitones:
//   open (Roman numeral), -1 extension, 1, 2, 3, 4, 4+ (pinky
//   extension up a half step).
const FINGERING = {
  29:'V',  30:'-1', 31:'1', 32:'2', 33:'3', 34:'4', 35:'4+',
  36:'IV', 37:'-1', 38:'1', 39:'2', 40:'3', 41:'4', 42:'4+',
  43:'III',44:'-1', 45:'1', 46:'2', 47:'3', 48:'4', 49:'4+',
  50:'II', 51:'-1', 52:'1', 53:'2', 54:'3', 55:'4', 56:'4+',
  57:'I',  58:'-1', 59:'1', 60:'2', 61:'3', 62:'4', 63:'4+'
};

// Half-position fingering table. "Half position" is hand-one-semitone-
// down from 1st position: finger 1 lands on what would be the -1
// back-extension in 1st position. Defined only for notes that have a
// natural half-position home on some string (positions 1..5 above
// the open string, i.e. semitones 1..5 above the open pitch).
//   F string:  F# G G# A A#   (30..34)
//   C string:  C# D D# E  F   (37..41)
//   G string:  G# A A# B  C   (44..48)
//   D string:  D# E F F# G    (51..55)
//   A string:  A# B C C# D    (58..62)
const HALF_FINGERING = {
  // Open strings — played unpressed in any position, so the label
  // stays the Roman numeral (V, IV, III, II, I) even when the bar
  // is in half position. Color picks up the half-position red.
  29:'V',  36:'IV', 43:'III', 50:'II', 57:'I',
  30:'1', 31:'2', 32:'3', 33:'4', 34:'4+',
  37:'1', 38:'2', 39:'3', 40:'4', 41:'4+',
  44:'1', 45:'2', 46:'3', 47:'4', 48:'4+',
  51:'1', 52:'2', 53:'3', 54:'4', 55:'4+',
  58:'1', 59:'2', 60:'3', 61:'4', 62:'4+'
};
// "Upper" position: hand one semitone ABOVE 1st position — finger 1
// lands at open+3 (what would be finger "2" in 1st position). Useful
// when several notes in a bar sit in the open+3..open+7 zone and
// 1st position would force a pinky extension (4+). The open+7 slot
// coincides with the NEXT string's open pitch (e.g. F+7 = C, which
// is the IV string open) — we label those as string numerals rather
// than "4+" because you'd just play the next open string rather than
// pinky-extending across strings.
const UPPER_FINGERING = {
  // Open strings (including the ones that the previous string could
  // reach as "4+") render as Roman numerals in the upper-position
  // color (green).
  29:'V',  36:'IV', 43:'III', 50:'II', 57:'I',
  32:'1', 33:'2', 34:'3', 35:'4',
  39:'1', 40:'2', 41:'3', 42:'4',
  46:'1', 47:'2', 48:'3', 49:'4',
  53:'1', 54:'2', 55:'3', 56:'4',
  60:'1', 61:'2', 62:'3', 63:'4'
};
// Open-string MIDI pitches (V, IV, III, II, I = F1, C2, G2, D3, A3).
// Used to identify which string a note "lives on" for the half-position
// trigger heuristic below.
const FB_OPEN_MIDIS = [29, 36, 43, 50, 57];
// Pick the string a note naturally sits on (the highest open pitch
// that's <= the note) and return the semitone offset from that open
// pitch. Returns null for notes outside the cello range.
function fbNoteStringOffset(midi) {
  let bestBase = -1;
  for (const base of FB_OPEN_MIDIS) {
    if (base <= midi && base > bestBase) bestBase = base;
  }
  if (bestBase < 0) return null;
  return { base: bestBase, offset: midi - bestBase };
}

let fingeringOn = false;
let fingeringOverlayEl = null;
let fingeringOverlayBarIdx = -1;

// Colors tied to each fingering position — reused by the overlay
// labels and by the Note Info panel's in-bar rings.
const POSITION_COLORS = { first: '#2e78ff', half: '#d83030', upper: '#168043' };

// (obsolete positionsActiveForCurrentKey helper removed — gating is
// now per-chord, not per-song-key.)

// Check whether a chord's effective scale (stored as scaleRoot +
// scaleIntervals on each beat info) is B Major, A Major, or E Major
// (the three sharp-heavy keys where half/upper fingering pays off).
const IONIAN_SEMIS = [0, 2, 4, 5, 7, 9, 11];
function isChordInBEAMajor(scaleRoot, scaleIntervals) {
  if (!scaleRoot || !scaleIntervals || scaleIntervals.length !== 7) return false;
  for (let i = 0; i < 7; i++) {
    if (scaleIntervals[i].s !== IONIAN_SEMIS[i]) return false;
  }
  const pc = scaleRoot.pitchClass;
  return pc === 11 /* B */ || pc === 9 /* A */ || pc === 4 /* E */;
}

// Per-note position assignments for a bar. Returns a plain map of
// { [midi pitch]: 'first' | 'half' | 'upper' } for every note in the
// bar.
//
// Gating is PER-CHORD (not per-song): a note only gets half/upper
// fingering when its OWNING chord's effective scale is B Major, A
// Major, or E Major. A single bar with a BMaj7 → E7 → … progression
// might have some notes in half/upper (under the BMaj7) and others
// in plain 1st (under a non-B/E/A chord that might follow).
//
// Per-note pick within a B/E/A chord:
//   - Half-only zone (offsets 1..2)  → half.
//   - Upper-only zone (offsets 6..7) → upper.
//   - Overlap zone (offsets 3..5)    → stay in previous position if
//     possible; default to half otherwise.
//   - Neither reaches                → 1st.
// prevPos resets when the chord context leaves a B/E/A major.
function barPositionAssignments(idx) {
  const bi = barElements[idx];
  if (!bi || !bi.noteData) return null;
  const map = {};
  const beatInfoArr = (typeof lastBeatInfo !== 'undefined' && lastBeatInfo)
    ? lastBeatInfo[idx] : null;
  // Without per-beat scale info we can't tell which chord owns each
  // note — everything defaults to 1st position.
  if (!beatInfoArr) {
    for (const nd of bi.noteData) if (nd) map[nd.pitch] = 'first';
    return map;
  }

  // First pass: build a flat list of in-BEA notes with their
  // string/offset info, preserving slot order for stickiness.
  // Non-BEA slots are tagged 'first' immediately.
  const seq = [];
  for (const info of beatInfoArr) {
    if (!info || info.pitch == null) continue;
    const inBEA = isChordInBEAMajor(info.scaleRoot, info.scaleIntervals);
    if (!inBEA) {
      map[info.pitch] = 'first';
      seq.push({ pitch: info.pitch, bea: false });
      continue;
    }
    const so = fbNoteStringOffset(info.pitch);
    seq.push({
      pitch: info.pitch,
      bea: true,
      stringBase: so ? so.base : null,
      offset: so ? so.offset : null
    });
  }

  // Second pass: group BEA notes by string. If a string has ≥3 notes
  // AND they all fit in one non-first position, commit the whole
  // string to that position so the player keeps a single hand shape.
  // This is the "cluster 3+ notes on one string" rule.
  const byString = {};
  for (const n of seq) {
    if (!n.bea || n.stringBase == null) continue;
    (byString[n.stringBase] = byString[n.stringBase] || []).push(n);
  }
  const stringCommit = {};
  for (const base of Object.keys(byString)) {
    const group = byString[base];
    if (group.length < 3) continue;
    const allFitHalf  = group.every(n => HALF_FINGERING[n.pitch]  != null);
    const allFitUpper = group.every(n => UPPER_FINGERING[n.pitch] != null);
    if (allFitHalf && allFitUpper) {
      // Both reach every note — pick the position whose reach is
      // better-centered on the group. avg offset <4 favors half,
      // ≥4 favors upper.
      const avg = group.reduce((s, n) => s + (n.offset || 0), 0) / group.length;
      stringCommit[base] = avg < 4 ? 'half' : 'upper';
    } else if (allFitUpper) {
      stringCommit[base] = 'upper';
    } else if (allFitHalf) {
      stringCommit[base] = 'half';
    }
  }

  // Third pass: assign each note. Committed strings win; otherwise
  // fall back to per-note picking with stickiness to the previous
  // note's position.
  let prevPos = null;
  for (const n of seq) {
    if (!n.bea) { prevPos = null; continue; }
    const committed = stringCommit[n.stringBase];
    let chosen;
    if (committed === 'half' && HALF_FINGERING[n.pitch] != null) {
      chosen = 'half';
    } else if (committed === 'upper' && UPPER_FINGERING[n.pitch] != null) {
      chosen = 'upper';
    } else {
      const canHalf  = HALF_FINGERING[n.pitch]  != null;
      const canUpper = UPPER_FINGERING[n.pitch] != null;
      if (canHalf && canUpper) {
        if (n.offset != null && n.offset <= 2) chosen = 'half';
        else if (n.offset != null && n.offset >= 6) chosen = 'upper';
        else if (prevPos === 'upper') chosen = 'upper';
        else chosen = 'half';
      } else if (canHalf) {
        chosen = 'half';
      } else if (canUpper) {
        chosen = 'upper';
      } else {
        chosen = 'first';
      }
    }
    map[n.pitch] = chosen;
    prevPos = chosen;
  }
  return map;
}

// Build a per-pitch ring-color map for the given bar. Each in-bar
// note's ring on the Note Info fingerboard gets colored by THAT
// note's own position. Lets a mixed half/upper bar display cleanly.
function barRingColors(idx) {
  const assignments = barPositionAssignments(idx);
  if (!assignments) return null;
  const map = {};
  for (const pitch of Object.keys(assignments)) {
    map[pitch] = POSITION_COLORS[assignments[pitch]];
  }
  return map;
}

function clearFingeringOverlay() {
  if (fingeringOverlayEl && fingeringOverlayEl.parentNode) {
    fingeringOverlayEl.parentNode.removeChild(fingeringOverlayEl);
  }
  fingeringOverlayEl = null;
  fingeringOverlayBarIdx = -1;
}

// Paint upper / half fingering labels above each note in the given
// bar. Labels stack — upper 1st on top, half below. For notes that
// sit on or below the top staff line (top line = written A3 = MIDI
// 57, here info.y + 40 in viewBox units), labels use a fixed Y just
// above the staff. For higher notes using ledger lines, the labels
// are pushed further up so they clear the note head + ledger lines.
function updateFingeringOverlay(barIdx) {
  if (!fingeringOn) { clearFingeringOverlay(); return; }
  if (barIdx == null || barIdx < 0) { clearFingeringOverlay(); return; }
  if (barIdx === fingeringOverlayBarIdx && fingeringOverlayEl) return;
  clearFingeringOverlay();
  const info = barElements[barIdx];
  if (!info || !info.noteEls || !info.noteData) return;
  const svg = info.rowEl.querySelector('svg');
  if (!svg) return;

  // Screen-rect → SVG user-space coord helper (handles viewBox).
  const svgRect = svg.getBoundingClientRect();
  const vb = svg.viewBox && svg.viewBox.baseVal;
  const vbOK = vb && vb.width > 0 && vb.height > 0;
  const vbSX = vbOK ? vb.width  / svgRect.width  : 1;
  const vbSY = vbOK ? vb.height / svgRect.height : 1;
  const vbOX = vbOK ? vb.x : 0;
  const vbOY = vbOK ? vb.y : 0;

  const topLineY = info.y + 40; // top of the 5-line staff
  const LABEL_Y  = info.y + 22; // default label Y when note is on/below staff
  const LIFT_GAP = 14;          // extra space above ledger-line notes

  const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  g.setAttribute('class', 'fingering-overlay');
  g.setAttribute('pointer-events', 'none');
  // Append the group to the SVG FIRST so getBBox() on the text
  // elements returns actual rendered dimensions (it returns zeros on
  // detached SVG nodes). We need those dimensions to size the white
  // backdrop rects that sit behind each label.
  svg.appendChild(g);

  // Per-note position assignments from the unified picker. Handles
  // key gating (non-B/E/A keys → all first) and within-bar mixing
  // (half and upper can both appear in one bar).
  const barAssignments = barPositionAssignments(barIdx) || {};
  // Last fingered note of the prior bar drives whether the FIRST
  // note of this bar announces a position change.
  function lastPositionOfBar(idx) {
    const bi = barElements[idx];
    if (!bi || !bi.noteData) return null;
    const prev = barPositionAssignments(idx);
    if (!prev) return null;
    let last = null;
    for (const nd of bi.noteData) {
      if (!nd) continue;
      if (prev[nd.pitch]) last = prev[nd.pitch];
    }
    return last;
  }
  let prevPos = barIdx > 0 ? lastPositionOfBar(barIdx - 1) : null;

  for (let i = 0; i < info.noteData.length; i++) {
    const nd = info.noteData[i];
    if (!nd) continue; // rest
    const noteEl = info.noteEls[i];
    if (!noteEl) continue;
    // Pick this note's position (first / half / upper) from the
    // bar-wide assignment map built above.
    const curPos = barAssignments[nd.pitch] || 'first';
    const label = curPos === 'half'  ? HALF_FINGERING[nd.pitch]
                : curPos === 'upper' ? UPPER_FINGERING[nd.pitch]
                :                      FINGERING[nd.pitch];
    if (!label) continue;
    const labelColor = POSITION_COLORS[curPos];
    const rect = noteEl.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    const noteX   = (rect.left + rect.width / 2 - svgRect.left) * vbSX + vbOX;
    const noteTop = (rect.top                   - svgRect.top ) * vbSY + vbOY;
    // Ask VexFlow directly for the notehead position. `getAbsoluteX()`
    // returns the x at the left edge of the notehead (after any
    // accidental glyph), and `getYs()[0]` returns the y of the
    // note's pitch line. These are in the SVG's viewBox coordinate
    // space — the same space our overlay group lives in, so no
    // client-space conversion is needed.
    let headCX = noteX;
    let headCY = (rect.top + rect.height / 2 - svgRect.top) * vbSY + vbOY;
    const sn = nd.staveNote;
    if (sn) {
      try {
        const absX = sn.getAbsoluteX();
        const ys   = sn.getYs && sn.getYs();
        const noteheadW = (sn.getGlyphWidth && sn.getGlyphWidth()) || 10;
        if (isFinite(absX) && ys && ys.length) {
          headCX = absX + noteheadW / 2;
          headCY = ys[0];
        }
      } catch (e) { /* fall back to DOM geometry */ }
    }

    // Note on/below top staff line → fixed Y above the staff.
    // Note above top line (ledger lines) → lift above the note head.
    const labelY = noteTop < topLineY ? noteTop - LIFT_GAP : LABEL_Y;
    appendFingeringLabel(g, noteX, labelY, label, labelColor);
    // Position-change tag: fires when this note's position differs
    // from the previous fingered note's position. Announces any
    // transition between first / half / upper — including mid-bar
    // half↔upper flips. A "first" at the very start (prevPos is
    // null) is suppressed because it's the default and would be
    // noise; transitions TO first from a non-first position still
    // announce ("first" label), and upper→half / half→upper do too.
    const isStartFirst = curPos === 'first' && prevPos == null;
    if (curPos !== prevPos && !isStartFirst) {
      appendFingeringLabel(g, noteX, labelY - 14, curPos, POSITION_COLORS[curPos]);
    }
    prevPos = curPos;
    // Note letter painted INSIDE the notehead. Filled noteheads
    // (quarter + shorter) carry white text directly on the black
    // glyph. HOLLOW noteheads (whole, half) are transparent inside,
    // so we paint a small white disc behind black text — that reads
    // against both the staff lines and whatever sits beyond.
    const fullName = nd.tpc != null ? tpcToNoteName(nd.tpc) : null;
    const letter = fullName ? fullName.charAt(0) : null;
    if (letter) {
      const isHollow = nd.duration === 'w' || nd.duration === 'h';
      if (isHollow) {
        // White ellipse matching the notehead's natural
        // wider-than-tall aspect so it fills the hollow interior
        // without poking above/below the glyph's ink. Half-note
        // heads are tilted -15° to match the engraver's slant.
        // VexFlow's whole-note glyph carries ~15° of clockwise
        // rotation in its path data, so specifying -30° lands it
        // visually at -15°, matching the half note.
        const tilt = nd.duration === 'w' ? -30 : -15;
        const disc = document.createElementNS('http://www.w3.org/2000/svg', 'ellipse');
        disc.setAttribute('cx', headCX);
        disc.setAttribute('cy', headCY);
        disc.setAttribute('rx', 5);
        disc.setAttribute('ry', 3.2);
        disc.setAttribute('transform', `rotate(${tilt} ${headCX} ${headCY})`);
        disc.setAttribute('fill', '#fff');
        disc.setAttribute('stroke', 'none');
        g.appendChild(disc);
      }
      const textColor = isHollow ? '#000' : '#fff';
      appendFingeringLabel(g, headCX, headCY, letter, textColor, {
        inside: true, fontSize: 7
      });
      const accidental = fullName && fullName.length > 1 ? fullName.slice(1) : null;
      if (accidental) {
        // Offset up-and-right from the notehead center. Tiny font so
        // the glyph reads but doesn't crowd the letter.
        appendFingeringLabel(g, headCX + 3.5, headCY - 2.5, accidental, textColor, {
          inside: true, fontSize: 5
        });
      }
    }
  }

  fingeringOverlayEl = g;
  fingeringOverlayBarIdx = barIdx;
}

function appendFingeringLabel(parent, x, y, txt, color, opts) {
  const fontSize = (opts && opts.fontSize) || 14;
  const inside = !!(opts && opts.inside);
  const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  t.setAttribute('x', x);
  t.setAttribute('y', y);
  t.setAttribute('text-anchor', 'middle');
  t.setAttribute('dominant-baseline', 'central');
  t.setAttribute('font-family', 'sans-serif');
  t.setAttribute('font-size', fontSize);
  t.setAttribute('font-weight', 'bold');
  t.setAttribute('fill', color || '#000');
  t.setAttribute('stroke', 'none');
  t.textContent = txt;
  parent.appendChild(t);
  // `inside: true` skips the white backdrop rect. Used for the note
  // letter overlaid on the black notehead — the glyph itself is the
  // background.
  if (inside) return;
  // Measure the rendered text (parent must already be in the DOM for
  // this to work) and drop a white rect behind it so the label reads
  // clearly when it overlaps chord symbols above the staff.
  let bbox = null;
  try { bbox = t.getBBox(); } catch (e) {}
  if (bbox && bbox.width > 0 && bbox.height > 0) {
    const padX = 3;
    const padY = 1;
    const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    bg.setAttribute('x', bbox.x - padX);
    bg.setAttribute('y', bbox.y - padY);
    bg.setAttribute('width',  bbox.width  + padX * 2);
    bg.setAttribute('height', bbox.height + padY * 2);
    bg.setAttribute('fill', '#fff');
    bg.setAttribute('stroke', 'none');
    parent.insertBefore(bg, t);
  }
}

// Bind the Upper / Half Fingering switch and kick off an initial
// overlay paint on the selected / playing bar when turned on.
(function bindFingeringSwitch() {
  const sw = document.getElementById('fingeringToggle');
  if (!sw) return;
  sw.addEventListener('change', (e) => {
    fingeringOn = e.target.checked;
    if (!fingeringOn) {
      clearFingeringOverlay();
      return;
    }
    // Decide which bar to label: the currently playing bar if we're
    // playing, otherwise the user's selected bar.
    const target = (playState === 'playing' && currentPlayingBar != null)
      ? currentPlayingBar
      : selectedBar;
    if (target != null) updateFingeringOverlay(target);
  });
})();

// Piano embellishment (extra randomized stabs). Defaults to on; when
// off, the piano plays a single stab on the downbeat of each chord
// and nothing else.
let embellishOn = true;
(function bindEmbellishSwitch() {
  const sw = document.getElementById('embellishToggle');
  if (!sw) return;
  embellishOn = sw.checked;
  sw.addEventListener('change', (e) => {
    embellishOn = e.target.checked;
  });
})();

// Play Score — when on, the exercise notes on the score sound through
// an acoustic contrabass sampler. Off by default so the app can be
// used as a silent reading aid with just piano comping + drums.
let playScoreOn = false;
(function bindPlayScoreSwitch() {
  const sw = document.getElementById('playScoreToggle');
  if (!sw) return;
  playScoreOn = sw.checked;
  sw.addEventListener('change', (e) => {
    playScoreOn = e.target.checked;
  });
})();

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
    // Tone.Part's internal scheduler doesn't cope well with having
    // its loopStart/loopEnd mutated mid-flight — stale event entries
    // from the old loop range can double-fire once the bounds change.
    // Cleanly tear down the paused Part and note the position in
    // `selectedBar` so the next Play button press re-creates a fresh
    // Part from that bar. Previously this branch mutated the Part in
    // place, which could cause two chords to sound on each bar for
    // the rest of the song after a Clear Loop / Change Loop click.
    stopPlayback();
    selectedBar = resumeBar;
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
    measurePitches,
    ringColors: barRingColors(idx)
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
    // Full playback rebuild at the selected bar. We used to take a
    // fast path here when seeking inside an active loop — just moving
    // Transport.position — but that leaves the real-drum Tone.Player
    // and piano comping scheduler at their previous buffer offsets,
    // so they end up out of phase with the new bar's downbeat. A
    // clean rebuild re-aligns the drum buffer to the target bar
    // (same math as the initial Play press). Brief (<100 ms) gap
    // while Tone tears down and re-queues events.
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
  // Refresh the Upper/Half fingering overlay so it follows the
  // current bar (or user-selected bar when paused/stopped).
  updateFingeringOverlay(idx);
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
  // Only auto-scroll during playback. When the user manually selects
  // a bar while paused or stopped, keep the view where they had it —
  // jumping the scroll position on click is disorienting (e.g. the
  // user scrolls down to read a later bar, taps it, and the view
  // yanks back up to center it).
  if (playState !== 'playing') return;
  const chartEl = document.getElementById('chart');
  if (!chartEl) return;
  // Compute the row's top relative to the scrollable chart container
  // using bounding rects — more reliable than `offsetTop` when SVG
  // scaling, CSS transforms, or nested offset parents come into play.
  const rowRect = info.rowEl.getBoundingClientRect();
  const chartRect = chartEl.getBoundingClientRect();
  const rowTop    = rowRect.top - chartRect.top + chartEl.scrollTop;
  const viewTop   = chartEl.scrollTop;
  const viewHeight = chartEl.clientHeight;

  // If a practice loop is active AND the entire loop span fits in
  // the currently-available chart viewport (which already accounts
  // for the Note Info / fingerboard panel when it's open, since
  // clientHeight shrinks accordingly), keep the loop framed and
  // don't chase individual bar rows. If the loop isn't currently
  // visible, scroll once to bring the whole range on screen, then
  // leave it alone as bars cycle.
  const hasLoop = loopIn != null && loopOut != null && loopIn <= loopOut;
  if (hasLoop) {
    const firstBar = barElements[loopIn];
    const lastBar  = barElements[loopOut];
    if (firstBar && lastBar && firstBar.rowEl && lastBar.rowEl) {
      const loopTop  = firstBar.rowEl.offsetTop;
      const loopBot  = lastBar.rowEl.offsetTop + lastBar.rowEl.offsetHeight;
      const loopSpan = loopBot - loopTop;
      if (loopSpan <= viewHeight - 8) {
        const loopFullyVisible =
          loopTop >= viewTop + 4 && loopBot <= viewTop + viewHeight - 4;
        if (loopFullyVisible) return;
        // Center the loop in the viewport.
        const padding = Math.max(0, (viewHeight - loopSpan) / 2);
        const target = Math.max(0, loopTop - padding);
        if (Math.abs(target - viewTop) >= 20) {
          chartEl.scrollTo({ top: target, behavior: 'smooth' });
        }
        return;
      }
      // Fall through: loop is bigger than the viewport — use the
      // normal per-row follow-scroll.
    }
  }

  // Default behavior: page-by-page scrolling. Stay put while the
  // current row is comfortably inside the visible viewport; only
  // scroll when the current row reaches the bottom of the page —
  // at which point jump so the current row lands at the TOP of the
  // new page. Feels like turning the page on a lead sheet instead
  // of smoothly creeping down.
  //
  // Trigger: when fewer than ~2 full rows remain below the current
  // row (i.e. the player is looking at the last line or two of the
  // page). Works identically whether the note-info/fingerboard
  // panel is open or closed because `clientHeight` already reflects
  // the panel's effect on the chart's visible area.
  const rowHeight = rowRect.height;
  const rowBottom = rowTop + rowHeight;
  const viewBottom = viewTop + viewHeight;

  // Top buffer: how far below the viewport's top edge the current
  // row should land after a page flip. Has to clear:
  //   - the .chart container's 10 px top padding
  //   - the chord-symbol labels rendered at SVG y ≈ 5–20 (which get
  //     scaled up when the SVG is wider than the chart — 24 px wasn't
  //     enough on narrower viewports where scaling pushes labels
  //     well above the staff in screen coordinates)
  //   - a little visual breathing room
  // 56 px has headroom even when the SVG scales to ~2× width-wise.
  const TOP_BUFFER = 56;

  // Current row above the visible area (loop wrapped back, user
  // scrolled down during playback, etc.) — page back to put the
  // current row at the top with the buffer.
  if (rowTop < viewTop - 2) {
    const target = Math.max(0, rowTop - TOP_BUFFER);
    if (Math.abs(target - viewTop) >= 20) {
      chartEl.scrollTo({ top: target, behavior: 'smooth' });
    }
    return;
  }

  // Current row nearing the bottom of the page — fewer than 2 full
  // rows of music visible after it. Page forward.
  const spaceBelow = viewBottom - rowBottom;
  if (spaceBelow < rowHeight * 2) {
    const target = Math.max(0, rowTop - TOP_BUFFER);
    if (Math.abs(target - viewTop) >= 20) {
      chartEl.scrollTo({ top: target, behavior: 'smooth' });
    }
    return;
  }

  // Row is comfortably inside the visible page — don't scroll.
}

async function startPlayback(song, bars, startBarIdx = 0, options = {}) {
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

    // Schedule a fingerboard-update event per note slot so the panel
    // follows the current note + scale as the song plays. The array
    // length tells us the time resolution — quarter notes (= beatsPerBar)
    // or eighths (= 2 × beatsPerBar for the 1235 exercise). Each slot
    // maps to a Transport time (beat:sixteenth).
    if (lastBeatInfo && lastBeatInfo[entry.idx]) {
      const stepsThisBar = lastBeatInfo[entry.idx].length;
      const stepsPerBeat = Math.max(1, Math.round(stepsThisBar / beatsPerBar));
      const sixteenthsPerStep = 4 / stepsPerBeat; // 4 = sixteenths-per-beat
      const secondsPerStep = (60 / currentTempo) / stepsPerBeat;
      const measurePitches = lastBeatInfo[entry.idx]
        .map(b => b && b.pitch)
        .filter(p => p != null);
      // How many steps this slot's individual chunk occupies. Used to
      // add up total duration across a tied chain so the Play-Score
      // sampler can trigger ONCE at the tie-start with a sustain
      // covering the whole chain instead of re-attacking on every
      // tied piece.
      // Map VexFlow duration tokens → step counts at the active
      // resolution. Head/tuplet-capable bars use 24ths (stepsPerBeat=6),
      // the 1235/3579 generators use 8ths (stepsPerBeat=2), and quarter
      // generators use 1. Tuplet notes carry `stepsConsumed` explicitly
      // since their actual footprint differs from the glyph's standard.
      const DUR_STEPS = stepsPerBeat === 6
        ? { 'w': 24, 'h.': 18, 'h': 12, 'q.': 9, 'q': 6, '8': 3 }
        : stepsPerBeat === 2
        ? { 'w': 8,  'h.': 6,  'h': 4,  'q.': 3, 'q': 2, '8': 1 }
        : { 'w': 4,  'h.': 3,  'h': 2,  'q.': 2, 'q': 1, '8': 1 };
      const stepsForChunk = (info) => {
        if (!info) return 1;
        if (info.stepsConsumed) return info.stepsConsumed;
        return DUR_STEPS[info.duration] || 1;
      };
      // Scan forward through slots (possibly crossing bars) from a
      // given (barNum, slot) until we reach the end of a tied chain.
      // Returns the chain's total length in steps.
      function chainSteps(barNum, startSlot) {
        const first = lastBeatInfo[playlist[barNum].idx][startSlot];
        let total = stepsForChunk(first);
        let curInfo = first;
        let curBarNum = barNum;
        let curSlot = startSlot;
        while (curInfo.tieToNext) {
          curSlot += stepsForChunk(curInfo);
          let curBarInfo = lastBeatInfo[playlist[curBarNum].idx];
          if (curSlot >= curBarInfo.length) {
            curBarNum++;
            if (curBarNum >= playlist.length) break;
            curBarInfo = lastBeatInfo[playlist[curBarNum].idx];
            curSlot = 0;
          }
          const nextInfo = curBarInfo[curSlot];
          if (!nextInfo || !nextInfo.tieFromPrev) break;
          total += stepsForChunk(nextInfo);
          curInfo = nextInfo;
        }
        return total;
      }
      for (let s = 0; s < stepsThisBar; s++) {
        const info = lastBeatInfo[entry.idx][s];
        if (!info) continue;
        const beat = Math.floor(s / stepsPerBeat);
        const sixteenth = (s % stepsPerBeat) * sixteenthsPerStep;
        // Attack-duration logic:
        //   tieFromPrev  → no new attack; this event still fires so the
        //                  fingerboard / highlight update, but Play Score
        //                  stays silent because the note is already
        //                  sounding.
        //   tieToNext    → scan forward through the chain, sum up the
        //                  total steps, sustain through it.
        //   otherwise    → play this chunk's own duration.
        let attackDurSec = 0;
        if (info.pitch != null && !info.tieFromPrev) {
          const totalSteps = info.tieToNext ? chainSteps(barNum, s) : stepsForChunk(info);
          attackDurSec = totalSteps * secondsPerStep;
        }
        events.push({
          time: `${absBar}:${beat}:${sixteenth}`,
          type: 'beat', idx: entry.idx, beat, info, measurePitches,
          attackDurSec
        });
      }
    }

    // Piano comping:
    //   - Always stab on each chord's downbeat (beat 1 of the chord),
    //     using the same uneven-bar allocation as the chord labels so
    //     GMaj7 stabs on beat 1 and D7 stabs on beat 4 in a
    //     "GMaj7 Eb7 D7" bar.
    //   - At most ONE "embellishment" stab per BAR, and only when the
    //     bar holds a SINGLE chord. In that case the "and" can land on
    //     any beat of the bar except the last (4/4 → and of 1, 2, or
    //     3). Bars with 2+ chords are already busy enough and get no
    //     embellishment.
    const chords = (bar.chords || []).filter(c => !c.slash && !c.nc);

    // Mandatory downbeat stabs for every chord.
    chords.forEach((ch, ci) => {
      const { startBeat } = chordBeatRange(chords.length, ci, beatsPerBar);
      const wb0 = Math.floor(startBeat);
      const sb0 = Math.round((startBeat - wb0) * 4);
      events.push({
        time: `${absBar}:${wb0}:${sb0}`,
        type: 'comp', ch, dur: '4n'
      });
    });

    // Build embellishment candidates — only for single-chord bars.
    const embellishCandidates = [];
    const maxAndBeat = beatsPerBar - 2; // never the bar's last beat
    if (chords.length === 1) {
      // Any "and" from the chord's downbeat up to the cap is fair game.
      const { startBeat } = chordBeatRange(1, 0, beatsPerBar);
      for (let b = startBeat; b <= maxAndBeat; b++) {
        embellishCandidates.push({ ch: chords[0], andBeat: b });
      }
    }
    // 0 or 2+ chords: leave embellishCandidates empty — no embellishment.

    // ~40% of bars with at least one candidate pick one and add an
    // "and" stab for it. ~20% of those use a swung upbeat (sixteenth
    // ≈ 2.67 instead of 2, matching jazz swing eighths).
    if (embellishOn && embellishCandidates.length > 0 && Math.random() < 0.4) {
      const pick = embellishCandidates[Math.floor(Math.random() * embellishCandidates.length)];
      const sixteenth = Math.random() < 0.2 ? 2.67 : 2;
      events.push({
        time: `${absBar}:${pick.andBeat}:${sixteenth}`,
        type: 'comp', ch: pick.ch, dur: '8n'
      });
    }

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

  // Loop count-in: when the user has a Loop In/Out pair AND the
  // "At Loop Start" checkbox is on AND a count-in is configured,
  // append click events at the END of the loop range so each pass
  // through the loop is preceded by N silent bars of click.
  // Implemented by extending the Part's loop window past loopOut by
  // countInBars and putting click events in those tail bars — Tone's
  // Part loop replays everything inside [loopStart, loopEnd) on each
  // iteration, so the clicks fire BEFORE re-entering loopStart.
  //
  // During the count-in tail we also:
  //   - emit a `barStart` event with idx=loopIn at the FIRST tail
  //     beat so the loop's first bar stays highlighted while the
  //     count clicks (matches user expectation: "the selected bar
  //     should be the first bar of the loop while it does the
  //     count-in").
  //   - schedule a periodic cleanup at the START of each tail to
  //     killl any sustaining piano notes and stop the real-drum
  //     loop, then restart the drum at the next loopStart so the
  //     count-in is genuinely silent except for the click.
  const _hasLoop = loopIn != null && loopOut != null && loopIn <= loopOut;
  const loopTailBars = (loopCountIn && _hasLoop && countInBars > 0) ? countInBars : 0;
  // Pre-roll filter: when starting mid-song with a count-in pre-roll
  // (rewind / play into a loop with At Loop Start on), strip out
  // playlist events for the bars we'll play click count-in over.
  // Belt-and-suspenders — Tone.Part with loop=true normally
  // already filters events outside [loopStart, loopEnd), but this
  // makes the behavior explicit and immune to edge cases.
  const _prerollActive =
    !!options.prerollCountIn && countInBars > 0 && startBarIdx >= countInBars;
  if (_prerollActive) {
    const prerollStart = startBarIdx - countInBars;
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      const m = ev.time && ev.time.match(/^(\d+):/);
      if (m) {
        const bar = parseInt(m[1], 10);
        if (bar >= prerollStart && bar < startBarIdx) events.splice(i, 1);
      }
    }
    // Belt-and-suspenders: when the pre-roll is active AND we have a
    // loop, also strip every event OUTSIDE the loop range. Tone.Part
    // with loop=true and Transport position < loopStart has shown
    // weird behavior where events from inside the loop (e.g. bar 8)
    // fire while Transport is still in the pre-roll bars (3, 4) —
    // apparently the loop wraparound maps "Transport position 3" to
    // "loopStart + 3 = bar 8" instead of leaving the Part dormant.
    // Stripping the outside-loop events from the array prevents
    // that mapping from finding anything to fire.
    if (_hasLoop) {
      const _loopEndBar = loopOut + 1 + loopTailBars;
      for (let i = events.length - 1; i >= 0; i--) {
        const ev = events[i];
        const m = ev.time && ev.time.match(/^(\d+):/);
        if (m) {
          const bar = parseInt(m[1], 10);
          if (bar < loopIn || bar >= _loopEndBar) events.splice(i, 1);
        }
      }
    }
  }
  if (loopTailBars > 0) {
    // Strip out any playlist events that fall in the count-in tail
    // range (bars loopOut+1 .. loopOut+loopTailBars). The Part's
    // extended loop window would otherwise re-fire those bars'
    // barStart / beat / comp events during the count-in, causing
    // the selection to jump past loopOut and the next bar's chord
    // to stab in the middle of the click track.
    const tailStart = loopOut + 1;
    const tailEnd = loopOut + loopTailBars; // inclusive
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i];
      const m = ev.time && ev.time.match(/^(\d+):/);
      if (m) {
        const bar = parseInt(m[1], 10);
        if (bar >= tailStart && bar <= tailEnd) events.splice(i, 1);
      }
    }
    // Highlight loopIn for the duration of the count-in tail. Flag
    // this event so the Part callback also forces a scroll-into-view
    // — the playback may have drifted off-screen during the loop
    // body, and the user wants to see the bar where the count-in
    // is happening.
    events.push({
      time: `${loopOut + 1}:0:0`,
      type: 'barStart',
      idx: loopIn,
      scrollIntoView: true
    });
    for (let cb = 0; cb < loopTailBars; cb++) {
      const tailBar = loopOut + 1 + cb;
      for (let beat = 0; beat < beatsPerBar; beat++) {
        events.push({
          time: `${tailBar}:${beat}:0`,
          type: 'click',
          accent: beat === 0
        });
      }
    }
  }

  playbackPart = new Tone.Part((time, ev) => {
    if (ev.type === 'barStart') {
      // Track the currently-playing bar so clear-loop / change-loop can
      // restart playback at the right spot (Transport.position keeps
      // climbing during looping and can't be trusted for this).
      currentPlayingBar = ev.idx;
      Tone.Draw.schedule(() => {
        highlightBar(ev.idx);
        // The count-in barStart event sets scrollIntoView so the
        // chart frames the loop's first bar regardless of where the
        // user had been looking. highlightBar's normal scroll only
        // fires when the row is off-screen — this forces it.
        if (ev.scrollIntoView) {
          const info = barElements[ev.idx];
          const chartEl = document.getElementById('chart');
          if (info && info.rowEl && chartEl) {
            const rowTop = info.rowEl.offsetTop;
            const rowH   = info.rowEl.offsetHeight;
            const viewH  = chartEl.clientHeight;
            const padding = Math.max(0, (viewH - rowH) / 2);
            chartEl.scrollTo({ top: Math.max(0, rowTop - padding), behavior: 'smooth' });
          }
        }
      }, time);
      return;
    }
    if (ev.type === 'beat') {
      // "Play Score" audio: sound the exercise note on the jazz
      // guitar sampler. Skipped when the switch is off or the current
      // step is a rest. The score is engraved 8vb (written = sounding
      // + 12); play the WRITTEN pitch so what you hear matches the
      // note you see on the staff.
      // Play Score: trigger the sampler only when this event carries
      // an attack (attackDurSec > 0). Tied notes split across slots
      // get attackDurSec=0 on continuations and the chain's full
      // sustain duration on the tie-start, so the whole tied note
      // sounds as a single sustained pluck instead of re-attacking
      // on every slot.
      if (playScoreOn && guitar && guitar.loaded
          && ev.info.pitch != null && ev.attackDurSec > 0) {
        const name = midiToName(ev.info.pitch + 12);
        guitar.triggerAttackRelease(name, ev.attackDurSec, time, 0.7);
      }
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
          measurePitches: ev.measurePitches,
          ringColors: barRingColors(ev.idx)
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
  // When loop count-in is on, extend the loop window past loopOut by
  // `loopTailBars` so the click-only count-in bars play before the
  // wrap back to loopStart. Otherwise just stop at loopOut+1 as
  // before.
  playbackPart.loopEnd = hasLoop
    ? `${loopOut + 1 + loopTailBars}:0:0`
    : `${playlist.length}:0:0`;
  // When pre-roll count-in is active, defer the Part's start until
  // Transport actually reaches startBarIdx — passing the same time as
  // both `time` and `offset` so events with absolute bar times (e.g.
  // event at bar 5 with time '5:0:0') still fire at Transport bar 5.
  // This is critical: if the Part is started at Transport time 0
  // while loop=true, Tone.Part's loop wraparound maps Transport
  // positions BEFORE loopStart into the loop range — so during the
  // pre-roll bars we'd hear chord stabs from inside the loop, AND
  // the cursor's barStart event would jump to a bar inside the loop
  // body instead of staying on the user's selected first-bar
  // highlight.
  if (_prerollActive) {
    playbackPart.start(`${startBarIdx}:0:0`, `${startBarIdx}:0:0`);
  } else {
    playbackPart.start(`${offset}:0:0`);
  }

  // If Real mode has a recorded drum loop for this tempo tier + time sig,
  // sync it to the Transport so it phase-locks with the bars. Adjust
  // playbackRate when the user tempo differs from the loop's source bpm.
  currentRealLoop = null;
  let midSongDrum = null; // set when we'll start the drum synchronously below
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
      if (startBarIdx > 0) {
        // Mid-song start (bar click, rewind to loopIn): stash the
        // entry + offset so we can start the Player in the same tick
        // as Tone.Transport.start() below. scheduleOnce'ing it at
        // `${startBarIdx}:0:0` is unreliable after we jump
        // Transport.position forward — Tone may treat the event as
        // "past" and skip it, which leaves the drums silent while
        // the Part keeps firing chord / beat events. Starting the
        // player directly bypasses that race.
        midSongDrum = { entry, bufOffset };
      } else {
        // Bar-0 start: let count-in play first, then drums kick in
        // at the top of bar 1. scheduleOnce is fine here because
        // Transport position stays at 0 — the event time is
        // genuinely in the future.
        Tone.Transport.scheduleOnce(t => {
          try { entry.player.start(t, bufOffset); } catch (e) {}
        }, `${offset}:0:0`);
      }
      currentRealLoop = entry;
    }
  }

  // Loop count-in cleanup: when At Loop Start is on, schedule a
  // periodic callback at the start of each count-in tail to silence
  // the piano + (if applicable) stop the real-drum loop, then
  // restore them at the next loopStart. Lifted OUTSIDE the
  // drumMode==='ride' block so the piano cleanup runs even for
  // synthetic drum modes (hat / click / no real drum file for the
  // current tempo tier) — those modes don't have a Player to stop,
  // but the chord sustain still needs to be cut.
  if (loopTailBars > 0 && hasLoop) {
    const loopWidthBars = loopOut + 1 + loopTailBars - loopIn;
    const tailSec = (60 / currentTempo) * beatsPerBar * loopTailBars;
    const cleanupAt = `${offset + loopOut + 1}:0:0`;
    // Resolve the active real-drum entry (may be null when drumMode
    // isn't 'ride' or no recorded loop exists for this tempo tier).
    const drumEntry = currentRealLoop;
    let loopBufOffset = 0;
    if (drumEntry && drumEntry.player.buffer) {
      const beatInLoop = (loopIn * beatsPerBar) % drumEntry.beats;
      loopBufOffset = (beatInLoop / drumEntry.beats) * drumEntry.player.buffer.duration;
    }
    Tone.Transport.scheduleRepeat(t => {
      // releaseAll alone leaves the sampler's 1.2 s release envelope
      // ringing; cut pianoOut's gain to 0 to silence every voice
      // instantly, then restore at the next loopStart from whatever
      // the slider currently reads.
      try { piano.releaseAll(t); } catch (e) {}
      if (pianoOut) {
        try {
          pianoOut.gain.cancelScheduledValues(t);
          pianoOut.gain.setValueAtTime(0, t);
          const sliderVol = parseInt(document.getElementById('pianoVol').value, 10) / 100;
          pianoOut.gain.setValueAtTime(isFinite(sliderVol) ? sliderVol : 0.4, t + tailSec);
        } catch (e) {}
      }
      if (drumEntry) {
        try { drumEntry.player.stop(t); } catch (e) {}
        // Restart drum at the next loopStart, aligned so each
        // iteration's downbeat lands on the loop's downbeat.
        try { drumEntry.player.start(t + tailSec, loopBufOffset); } catch (e) {}
      }
    }, `${loopWidthBars}m`, cleanupAt);
  }

  // Position the Transport and (optionally) pre-roll a count-in.
  //
  // Three flows:
  //   - bar-0 start with countInBars > 0: position=0, offset=countInBars
  //     (handled above via the per-bar scheduleOnce loop). Part starts
  //     at countInBars:0:0 so its events line up after the click track.
  //   - mid-song start with prerollCountIn: roll Transport BACK by
  //     countInBars and schedule click events at those bars via
  //     Tone.Transport.scheduleOnce. Cancelable via Transport.cancel,
  //     so a quick rewind during pre-roll won't double up. Drum start
  //     is also Transport-scheduled at the body's first bar.
  //   - mid-song start without count-in: jump straight to startBarIdx.
  const wantPrerollCountIn =
    !!options.prerollCountIn && countInBars > 0 && startBarIdx >= countInBars;
  if (wantPrerollCountIn) {
    const prerollStart = startBarIdx - countInBars;
    Tone.Transport.position = `${prerollStart}:0:0`;
    for (let cb = 0; cb < countInBars; cb++) {
      const barTime = prerollStart + cb;
      for (let beat = 0; beat < beatsPerBar; beat++) {
        const accent = beat === 0;
        Tone.Transport.scheduleOnce(t => {
          try { click.triggerAttackRelease('32n', t, accent ? 0.95 : 0.55); } catch (e) {}
        }, `${barTime}:${beat}:0`);
      }
    }
    if (midSongDrum) {
      const drumEntry = midSongDrum.entry;
      const drumOffset = midSongDrum.bufOffset;
      Tone.Transport.scheduleOnce(t => {
        try { drumEntry.player.start(t, drumOffset); } catch (e) {}
      }, `${startBarIdx}:0:0`);
    }
    // Force the cursor onto the loop's first bar BEFORE Transport
    // starts ticking — during pre-roll the Part is dormant and won't
    // fire any barStart events, so without this the previously-
    // highlighted bar would stay lit through the count-in. Also
    // scroll the chart so the user sees where playback will resume.
    currentPlayingBar = startBarIdx;
    highlightBar(startBarIdx);
    {
      const info = barElements[startBarIdx];
      const chartEl = document.getElementById('chart');
      if (info && info.rowEl && chartEl) {
        const rowTop = info.rowEl.offsetTop;
        const rowH   = info.rowEl.offsetHeight;
        const viewH  = chartEl.clientHeight;
        const padding = Math.max(0, (viewH - rowH) / 2);
        chartEl.scrollTo({ top: Math.max(0, rowTop - padding), behavior: 'smooth' });
      }
    }
    Tone.Transport.start();
  } else {
    Tone.Transport.position = startBarIdx > 0 ? `${startBarIdx}:0:0` : 0;
    if (midSongDrum) {
      try { midSongDrum.entry.player.start(undefined, midSongDrum.bufOffset); } catch (e) {}
    }
    Tone.Transport.start();
  }
  playState = 'playing';
  pauseContext = { offset, beatsPerBar };
  const btn = document.getElementById('playBtn');
  btn.querySelector('.play-glyph').textContent = '⏸';
  btn.classList.add('playing');
  document.getElementById('status').textContent = `Playing · ${playlist.length} bars`;
  updateLoopControls();
  // Mid-song starts: Tone's Part sometimes skips the `barStart` event
  // for the exact bar we jumped to (the event time equals the new
  // Transport position so it reads as "just fired"). Explicitly
  // highlight the target bar here so the clicked / rewound bar
  // shows as the active one instead of the viewer waiting for the
  // NEXT bar's event to repaint the overlay.
  if (startBarIdx > 0) {
    currentPlayingBar = startBarIdx;
    highlightBar(startBarIdx);
  }
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
// Expand a "D.C. al Fine" chart into ABA bars in place. After this
// runs, the score literally contains section A a second time (from
// bar 0 up to and including the Fine bar) appended to the end —
// so the renderer shows ABA and the exercise generators produce
// fresh notes for the second A pass (their running state —
// direction, last pitch, enclosure — continues naturally through
// the repeat instead of restarting from bar 0's starting conditions).
// Called AFTER expandIRealRepeats so {…} first/second-ending
// brackets are already flat.
function expandDCAlFine(bars) {
  const FINE_ONLY_RE = /^\s*fine\s*\.?\s*$/i;
  let fineIdx = -1;
  let hasDCAlFine = false;
  bars.forEach((b, i) => {
    (b.markers || []).forEach(m => {
      if (m.type !== 'comment') return;
      const text = (m.text || '').trim();
      if (FINE_ONLY_RE.test(text)) fineIdx = i;
      const lc = text.toLowerCase();
      if (lc.includes('d.c. al fine') || lc.includes('dc al fine')) hasDCAlFine = true;
    });
  });
  if (!hasDCAlFine || fineIdx < 0) return bars;
  const out = bars.slice();
  for (let j = 0; j <= fineIdx; j++) out.push(bars[j]);
  return out;
}

// Expand a "D.C. al 2nd ending" chart in place. Runs AFTER
// expandIRealRepeats so the N1/N2 markers survive on the bars that
// carried them (ending === "1" / ending === "2"). On the D.C. the
// player returns to bar 0, plays the COMMON bars of the first
// repeat group (i.e. up to but not including the first N1 bar),
// then jumps straight to the second ending (N2) — skipping N1.
//
// Canonical use: AABA charts like Alice in Wonderland where the B
// section's last bar is marked "D.C. al 2nd ending" and the N2
// bars (which often carry Fine) form the final A's tail.
//
// Algorithm:
//   1. Require a D.C.-al-2nd-ending marker somewhere in `bars`.
//   2. Find the FIRST N1 bar — everything before it is "common".
//   3. Collect consecutive N2 bars. If a Fine marker sits inside
//      the N2 range, trim the append to include it and stop.
//   4. Append `bars[0..firstN1-1] + n2Trimmed` to the output.
function expandDCAl2ndEnding(bars) {
  let hasDCAl2nd = false;
  bars.forEach(b => {
    (b.markers || []).forEach(m => {
      if (m.type !== 'comment') return;
      const lc = (m.text || '').toLowerCase();
      if (lc.includes('d.c. al 2nd ending') || lc.includes('dc al 2nd ending')) {
        hasDCAl2nd = true;
      }
    });
  });
  if (!hasDCAl2nd) return bars;

  // N1 (first ending) range: from the first bar tagged ending==1
  // to the last one. Loose equality because the parser stores
  // `ending` as a string ("1"/"2") while callers think in numbers.
  let firstN1Idx = -1, lastN1Idx = -1;
  for (let i = 0; i < bars.length; i++) {
    if (bars[i].ending == 1) {
      if (firstN1Idx < 0) firstN1Idx = i;
      lastN1Idx = i;
    }
  }
  // N2 (second ending) starts at the first bar tagged ending==2.
  // Its length matches N1 — iReal's expandIRealRepeats uses the
  // same convention, because Kcl / repeat-prev bars inside N2
  // don't carry the ending tag of their own.
  let firstN2Idx = -1;
  for (let i = 0; i < bars.length; i++) {
    if (bars[i].ending == 2) { firstN2Idx = i; break; }
  }
  if (firstN1Idx < 0 || firstN2Idx < 0) return bars;

  const n1Length = lastN1Idx - firstN1Idx + 1;
  const n2EndIdx = Math.min(firstN2Idx + n1Length - 1, bars.length - 1);

  // If a Fine marker sits inside the N2 range, cap the appended
  // second ending at that bar. Otherwise include every N2 bar.
  const FINE_RE = /^\s*fine\s*\.?\s*$/i;
  let effN2End = n2EndIdx;
  for (let k = firstN2Idx; k <= n2EndIdx; k++) {
    const b = bars[k];
    const hasFine = (b.markers || []).some(m =>
      m.type === 'comment' && FINE_RE.test((m.text || '').trim())
    );
    if (hasFine) { effN2End = k; break; }
  }

  const out = bars.slice();
  // Common bars 0..firstN1-1.
  for (let j = 0; j < firstN1Idx; j++) out.push(bars[j]);
  // Then N2 from its first bar up to (and including) the Fine bar.
  for (let k = firstN2Idx; k <= effN2End; k++) out.push(bars[k]);
  return out;
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

        // First pass: common bars plus N1 ending (bars i..j). Tag
        // EVERY bar in the N1 range with `ending = '1'` — iReal only
        // stores the marker on the first bar of the group, but later
        // passes (e.g. expandDCAl2ndEnding) need to know the full
        // extent. Kcl / repeat-prev bars inside the group otherwise
        // look untagged and get missed.
        for (let k = i; k <= j; k++) {
          const b = stripRepeatBarlines(bars[k]);
          if (n1Start >= 0 && k >= n1Start) b.ending = '1';
          out.push(b);
        }
        // Second pass: common bars, then jump to N2 (skipping N1).
        const commonEnd = n1Start >= 0 ? n1Start - 1 : j;
        for (let k = i; k <= commonEnd; k++) out.push(stripRepeatBarlines(bars[k]));
        if (n2Start >= 0) {
          for (let k = n2Start; k <= n2End; k++) {
            const b = stripRepeatBarlines(bars[k]);
            b.ending = '2';
            out.push(b);
          }
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

// ----- Key transpose -----
// iRealPro's song.key is a string like "A", "Bb", "C#m" (minor has a
// trailing "m" or "-"). We track the original key and the currently
// selected key. Transposition shifts every chord root and bass note
// by the pitch-class delta between them.
const KEY_NAMES  = ['A','Bb','B','C','C#','D','Eb','E','F','F#','G','G#'];
const KEY_TO_PC  = {
  'A':9, 'Bb':10, 'B':11, 'C':0, 'C#':1, 'D':2,
  'Eb':3, 'E':4, 'F':5, 'F#':6, 'G':7, 'G#':8
};
const FLAT_KEYS  = new Set(['Bb', 'Eb', 'F']);
const PC_SHARP_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const PC_FLAT_NAMES  = ['C','Db','D','Eb','E','F','Gb','G','Ab','A','Bb','B'];

// Normalize the iRealPro key string ("C#m", "Bb-", "F#") to one of
// our 12 canonical button labels and a minor flag. The minor suffix
// is stripped — we use the TONIC pitch class directly for
// transposition, so an A minor song selecting "D" transposes up a
// 4th (A→D), turning Am into Dm.
function normalizeKey(keyStr) {
  if (!keyStr) return { key: 'C', minor: false };
  const m = keyStr.match(/^([A-G][#b]?)(m|-)?/i);
  if (!m) return { key: 'C', minor: false };
  let root = m[1][0].toUpperCase() + (m[1][1] || '');
  // Rewrite uncommon enharmonic spellings to our button labels.
  const ALIAS = { 'Ab':'G#', 'Db':'C#', 'Gb':'F#' };
  if (ALIAS[root]) root = ALIAS[root];
  const minor = !!m[2];
  if (!(root in KEY_TO_PC)) return { key: 'C', minor };
  return { key: root, minor };
}

// Shift a "letter[accidental]..." string by `offset` semitones,
// picking a new letter+accidental per `useFlats`. Anything after the
// leading accidental is kept unchanged (e.g. "m7b5" stays "m7b5").
function shiftNoteName(str, offset, useFlats) {
  if (!str) return str;
  const m = str.match(/^([A-G])([#b])?(.*)$/);
  if (!m) return str;
  const letter = m[1];
  const acc    = m[2] || '';
  const tail   = m[3] || '';
  const letterPc = { C:0, D:2, E:4, F:5, G:7, A:9, B:11 }[letter];
  let pc = letterPc;
  if (acc === '#') pc++;
  if (acc === 'b') pc--;
  pc = ((pc + offset) % 12 + 12) % 12;
  const name = (useFlats ? PC_FLAT_NAMES : PC_SHARP_NAMES)[pc];
  return name + tail;
}

// Return a copy of `bars` with every chord root and bass transposed
// by `offset` semitones. Non-chord cells (rests, slashes, NC) pass
// through unchanged. The chord's `rest` string may start with a
// "#"/"b" accidental — we have to pull it off the root side, shift,
// then reattach any residual accidental.
function transposeBars(bars, offset, useFlats) {
  if (offset === 0) return bars;
  return bars.map(bar => ({
    ...bar,
    chords: (bar.chords || []).map(ch => {
      if (ch.nc || ch.slash) return ch;
      const restStr = ch.rest || '';
      const accMatch = restStr.match(/^([#b])(.*)/);
      const rootWithAcc = ch.root + (accMatch ? accMatch[1] : '');
      const qualityTail = accMatch ? accMatch[2] : restStr;
      const shiftedRootName = shiftNoteName(rootWithAcc, offset, useFlats);
      // Split back into a single-letter root and a rest string whose
      // leading character may again be "#"/"b".
      const newLetter = shiftedRootName[0];
      const newAcc    = shiftedRootName.slice(1); // "" | "#" | "b"
      return {
        ...ch,
        root: newLetter,
        rest: newAcc + qualityTail,
        bass: ch.bass ? shiftNoteName(ch.bass, offset, useFlats) : null
      };
    })
  }));
}

let currentKey = 'C';
let originalKey = 'C';
let currentIsMinor = false;
function syncKeySegActive(key) {
  document.querySelectorAll('#keySeg button').forEach(b => {
    b.classList.toggle('active', b.dataset.key === key);
  });
}
// Mark the button matching the song's original key with an "original"
// class so CSS can draw a circle around its label.
function syncKeySegOriginal(key) {
  document.querySelectorAll('#keySeg button').forEach(b => {
    b.classList.toggle('original', b.dataset.key === key);
  });
}
// Rebuild the labels on the key segmented control.
//  - Minor songs: append 'm' (Cm, Dm, etc.) and display sharp
//    variants for C#, F#, G#.
//  - Major songs: no 'm' suffix, and enharmonically swap the three
//    "sharp" buttons to flats (C# → Db, F# → Gb, G# → Ab) so the
//    row reads as the flat-side key names conventionally used for
//    major keys with those tonics.
// The underlying `data-key` stays the same (the source of truth for
// transpose math); only the displayed label changes.
// The label sits inside a <span class="key-label"> so CSS can target
// just the text (e.g. to draw a circle around the original-key
// button's text without circling the whole segment cell).
const KEY_MAJOR_FLAT_ALIAS = { 'C#': 'Db', 'F#': 'Gb', 'G#': 'Ab' };
function syncKeySegLabels(isMinor) {
  document.querySelectorAll('#keySeg button').forEach(b => {
    const key = b.dataset.key;
    const displayKey = isMinor ? key : (KEY_MAJOR_FLAT_ALIAS[key] || key);
    const base = displayKey.replace('b', '♭').replace('#', '♯');
    const txt  = isMinor ? base + 'm' : base;
    b.innerHTML = '';
    const span = document.createElement('span');
    span.className = 'key-label';
    span.textContent = txt;
    b.appendChild(span);
  });
}

function loadFromURL(url) {
  const song = parseIRealSong(url);
  const tokens = tokenize(song.body);
  let { bars, timesig } = buildBars(tokens);
  bars = expandIRealRepeats(bars);
  // Flatten D.C. al Fine so the score literally contains ABA —
  // this lets the renderer show the second A pass and lets the
  // exercise generators continue their running state (direction,
  // last pitch, enclosure) through the repeat with fresh notes.
  bars = expandDCAlFine(bars);
  // Same treatment for "D.C. al 2nd ending" — AABA charts like
  // Alice in Wonderland end B with this marker and expect the
  // renderer to append the common A bars plus the N2 ending.
  bars = expandDCAl2ndEnding(bars);
  const normalized = normalizeKey(song.key);
  originalKey = normalized.key;
  currentKey = originalKey;
  currentIsMinor = normalized.minor;
  syncKeySegLabels(currentIsMinor);
  syncKeySegOriginal(originalKey);
  syncKeySegActive(currentKey);
  renderChart(song, bars, timesig);
  // Store both the original (untransposed) bars and the currently
  // displayed bars. Key changes re-transpose from the original so
  // repeated key flips don't accumulate rounding errors.
  window.currentSong = {
    song, bars, timesig,
    originalBars: bars,
    head: null,
    // `headLoaded` stays false during the async fetch so the
    // "No head found" banner doesn't flash while we're still
    // waiting for the file. Set to true once the load resolves,
    // regardless of whether a head was found.
    headLoaded: false
  };
  document.getElementById('status').textContent = `Loaded: ${song.title} (${bars.length} bars)`;
  // Try to load a matching score file from the songs/ folder for the
  // "Head" exercise. Prefers <title>.musicxml (explicit spelling +
  // ties); falls back to <title>.mid if no XML is present. Fire-and-
  // forget: the render that just ran used whatever data was already
  // cached; we re-render once the load settles if Head is selected.
  loadSongHead(song.title).then(head => {
    if (!window.currentSong || window.currentSong.song !== song) return; // user changed songs
    window.currentSong.head = head;
    window.currentSong.headLoaded = true;
    if (exerciseMode === 'head') rerenderCurrent();
  });
  // A freshly loaded song should start at the top of the score. The
  // chart container holds the scroll position from the previously
  // loaded song, which can leave the user halfway down an unrelated
  // chart until they scroll back up themselves.
  const chartEl = document.getElementById('chart');
  if (chartEl) chartEl.scrollTop = 0;
}

async function applyKeyChange(targetKey) {
  if (!window.currentSong) return;
  if (!(targetKey in KEY_TO_PC)) return;
  currentKey = targetKey;
  syncKeySegActive(targetKey);
  const offset = (KEY_TO_PC[targetKey] - KEY_TO_PC[originalKey] + 12) % 12;
  // Spelling preference: always flat for Bb/Eb/F. For major songs
  // only, also flat for C#/F#/G# (because those keys display as
  // Db/Gb/Ab in major — the flat side of the enharmonic pair).
  // Minor songs keep sharps for C#/F#/G# (C# minor uses sharps, etc.)
  const useFlats = FLAT_KEYS.has(targetKey)
    || (!currentIsMinor && (targetKey === 'C#' || targetKey === 'F#' || targetKey === 'G#'));
  const bars = transposeBars(window.currentSong.originalBars, offset, useFlats);
  window.currentSong.bars = bars;
  renderChart(window.currentSong.song, bars, window.currentSong.timesig);
  // If playback is in progress, restart the scheduler at the bar we
  // were on so the audio follows the new key. Mirrors the exercise-
  // picker behavior — the Transport's already-queued events carry
  // OLD pitches, so we have to tear them down and re-queue from
  // the transposed bars.
  if (playState === 'playing' && window.currentSong) {
    const expanded = expandBarsByRepeats(window.currentSong.bars, songRepeats);
    await startPlayback(window.currentSong.song, expanded, currentPlayingBar);
  }
}

document.querySelectorAll('#keySeg button').forEach(btn => {
  btn.addEventListener('click', () => applyKeyChange(btn.dataset.key));
});

// ===== Event bindings =====
document.getElementById('playBtn').addEventListener('click', async () => {
  if (playState === 'playing') { pausePlayback(); return; }
  if (!window.currentSong) return;
  const hasLoop = loopIn != null && loopOut != null && loopIn <= loopOut;
  // Paused state → if a loop is set, restart cleanly at loopIn
  // (the user may have placed the loop while paused; resuming
  // the Transport mid-song would skip past it). Otherwise resume
  // from the pause point as before.
  if (playState === 'paused' && !hasLoop) { resumePlayback(); return; }
  const expanded = expandBarsByRepeats(window.currentSong.bars, songRepeats);
  // Pick a starting bar:
  //   - a complete Loop In / Loop Out pair wins → always start at
  //     loopIn (the first bar of the practice loop). If the user
  //     wants to start from a different bar inside the loop, they
  //     can click that bar during playback — the click seeks to it.
  //   - otherwise a tapped bar
  //   - otherwise the top
  let startAt;
  if (hasLoop) {
    startAt = loopIn;
  } else {
    startAt = selectedBar != null ? selectedBar : 0;
  }
  // When the user has "At Loop Start" on AND we're entering a loop
  // (startAt === loopIn), pre-roll a count-in before the loop body.
  // Without this, the very first iteration would skip count-in
  // because mid-song starts (startBarIdx > 0) suppress the regular
  // song-start count-in.
  const wantsLoopCountIn = hasLoop && loopCountIn && countInBars > 0
    && startAt === loopIn;
  await startPlayback(window.currentSong.song, expanded, startAt,
    { prerollCountIn: wantsLoopCountIn });
});
document.getElementById('rewindBtn').addEventListener('click', async () => {
  // Back to start. The target is the loop's first bar when a Loop In
  // bracket is placed, else bar 0.
  //
  //  - While PLAYING: do a FULL playback rebuild at the target bar
  //    via startPlayback — not the fast in-loop seek. The fast seek
  //    just moves Transport.position, which leaves the real-drum
  //    Tone.Player and any scheduled piano stabs at their previous
  //    buffer offsets, so they end up out of phase with the bar
  //    downbeats. A full rebuild tears everything down and re-syncs
  //    the drum loop's buffer offset to the target bar's downbeat.
  //  - While PAUSED or STOPPED: move the selection and highlight so
  //    the next Play press starts from the target.
  const target = loopIn != null ? loopIn : 0;
  // When "At Loop Start" is on AND we have a real Loop In/Out pair AND
  // the user has count-in configured, ask startPlayback to pre-roll a
  // count-in before re-entering the loop. Applies whether we're
  // currently playing OR stopped (next play will inherit it).
  const wantsLoopCountIn =
    loopCountIn && loopIn != null && loopOut != null && countInBars > 0;
  if (playState === 'playing') {
    selectedBar = target;
    if (window.currentSong) {
      const expanded = expandBarsByRepeats(window.currentSong.bars, songRepeats);
      await startPlayback(window.currentSong.song, expanded, target,
        { prerollCountIn: wantsLoopCountIn });
    }
  } else {
    stopPlayback();
    selectedBar = target;
    highlightBar(target);
    refreshFingerboardForBar(target);
    // For paused/stopped → next Play press: the play handler reads
    // `loopCountIn` directly, so any loop-start count-in is taken
    // care of there. No additional state needed.
  }
  const chartEl = document.getElementById('chart');
  if (chartEl) {
    if (loopIn != null) {
      // Scroll the loop's first bar into the center of the view.
      const info = barElements[loopIn];
      if (info && info.rowEl) {
        const rowTop = info.rowEl.offsetTop;
        const rowH   = info.rowEl.offsetHeight;
        const viewH  = chartEl.clientHeight;
        const padding = Math.max(0, (viewH - rowH) / 2);
        chartEl.scrollTo({ top: Math.max(0, rowTop - padding), behavior: 'smooth' });
      } else {
        chartEl.scrollTop = 0;
      }
    } else {
      chartEl.scrollTop = 0;
    }
  }
  updateLoopControls();
  if (playState !== 'playing') {
    document.getElementById('status').textContent = 'Ready';
  }
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
// Wake Lock defaults to ON in the HTML, but `navigator.wakeLock.request`
// requires a user gesture on most browsers. Attach a one-shot listener
// for the first click/tap so the lock takes effect automatically the
// moment the user interacts with the page (tapping Play, selecting a
// song, etc.) — no need to toggle the switch themselves.
document.addEventListener('pointerdown', function firstTouch() {
  const sw = document.getElementById('wakeLock');
  if (sw && sw.checked && !wakeLockSentinel) acquireWakeLock();
  document.removeEventListener('pointerdown', firstTouch);
}, { capture: true });

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
  // Same 0.9 trim as the init path so drag-changes match the default.
  if (drumsOut) drumsOut.gain.rampTo(v * 0.9, 0.05);
});

document.getElementById('pianoVol').addEventListener('input', e => {
  const v = parseInt(e.target.value, 10) / 100;
  if (pianoOut) pianoOut.gain.rampTo(v, 0.05);
});

document.getElementById('leadVol').addEventListener('input', e => {
  const v = parseInt(e.target.value, 10) / 100;
  if (leadOut) leadOut.gain.rampTo(v, 0.05);
});

// Options / Instruments panel toggles. The two panels are mutually
// exclusive in portrait — opening one closes the other so we don't
// end up with a wall of controls above the score.
(function () {
  const optToggle = document.getElementById('optionsToggle');
  const instToggle = document.getElementById('instrumentsToggle');
  const optPanel = document.getElementById('optionsPanel');
  const instPanel = document.getElementById('instrumentsPanel');
  function setOpen(panel, btn, open) {
    if (!panel || !btn) return;
    if (open) {
      panel.removeAttribute('hidden');
      btn.setAttribute('aria-expanded', 'true');
    } else {
      panel.setAttribute('hidden', '');
      btn.setAttribute('aria-expanded', 'false');
    }
  }
  if (optToggle && optPanel) {
    optToggle.addEventListener('click', () => {
      const opening = optPanel.hasAttribute('hidden');
      setOpen(optPanel, optToggle, opening);
      if (opening) setOpen(instPanel, instToggle, false);
    });
  }
  if (instToggle && instPanel) {
    instToggle.addEventListener('click', () => {
      const opening = instPanel.hasAttribute('hidden');
      setOpen(instPanel, instToggle, opening);
      if (opening) setOpen(optPanel, optToggle, false);
    });
  }
})();

document.querySelectorAll('#countInSeg button').forEach(b => {
  b.addEventListener('click', async () => {
    document.querySelectorAll('#countInSeg button').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    countInBars = parseInt(b.dataset.count, 10) || 0;
    // Mid-playback change: rebuild so the new count-in length is
    // baked into the looping Part's tail (only matters with the
    // "Loop" checkbox on, but rebuilding either way is harmless).
    if (playState === 'playing' && window.currentSong) {
      const expanded = expandBarsByRepeats(window.currentSong.bars, songRepeats);
      await startPlayback(window.currentSong.song, expanded, currentPlayingBar);
    }
  });
});

// Loop count-in toggle in the instruments panel. When checked AND a
// Loop In/Out pair is set, the count-in clicks at the end of every
// loop iteration before re-entering loopStart.
(function bindLoopCountInToggle() {
  const cb = document.getElementById('loopCountInToggle');
  if (!cb) return;
  cb.addEventListener('change', async () => {
    loopCountIn = cb.checked;
    // Rebuild on the fly so the change takes effect immediately
    // for the currently-running loop. If we're not playing, the
    // next Play press picks up the new value.
    if (playState === 'playing' && window.currentSong) {
      const expanded = expandBarsByRepeats(window.currentSong.bars, songRepeats);
      await startPlayback(window.currentSong.song, expanded, currentPlayingBar);
    }
  });
})();

// Exercise picker — regenerates the quarter notes with the selected
// algorithm (scale-walker vs. 1-3-5-7 arpeggio). If playback is running,
// restart so the audible notes match the re-rendered score.
(function bindExerciseSelect() {
  const sel = document.getElementById('exerciseSelect');
  if (!sel) return;
  sel.addEventListener('change', async () => {
    const ex = sel.value;
    exerciseMode = (ex === 'head' || ex === 'chord' || ex === 'triads' || ex === 'broken3' || ex === 'cantus' || ex === '1235' || ex === '3579')
      ? ex : 'scale';
    updateScoreTitle();
    rerenderCurrent();
    if (playState === 'playing' && window.currentSong) {
      const expanded = expandBarsByRepeats(window.currentSong.bars, songRepeats);
      await startPlayback(window.currentSong.song, expanded, currentPlayingBar);
    }
  });
})();

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
    // `cache: 'no-store'` bypasses browser + CDN caches so a freshly
    // pushed Songs.html shows up immediately. Without this, GitHub
    // Pages (or any static host) could keep serving the previous
    // version for up to 10 minutes after a deploy, which looks like
    // "my new song didn't appear on my phone".
    const res = await fetch('songs/Songs.html', { cache: 'no-store' });
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
      // Wrap the title in its own span so the filter can target just
      // the song name and ignore any HEAD badge we append below.
      const nameSpan = document.createElement('span');
      nameSpan.className = 'song-name';
      nameSpan.textContent = entry.title;
      li.appendChild(nameSpan);
      li.dataset.idx = String(i);
      li.setAttribute('role', 'option');
      li.addEventListener('click', () => {
        selectSongByIndex(i);
        // `closeSongPicker()` also clears the filter in portrait mode
        // so the next open starts fresh.
        closeSongPicker();
      });
      songListEl.appendChild(li);
      // Fire a HEAD request per song (in parallel) to detect a
      // companion .musicxml / .mid file in the songs/ folder. When
      // one exists, tag the list item with a small "HEAD" badge on
      // the right. We don't block list rendering on this — badges
      // appear as probes resolve.
      probeSongHasHead(entry.title).then(hasHead => {
        if (!hasHead) return;
        const badge = document.createElement('span');
        badge.className = 'head-badge';
        badge.textContent = 'HEAD';
        li.appendChild(badge);
      });
    }
  });

  // Safety-net the filter-input listeners — bindSongPickerControls
  // already ran once at script load, but if anything ever re-inserts
  // the input element these calls re-establish the handlers.
  ensureSongFilterBindings();

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

// Check whether a song has a companion head file (.musicxml or .mid)
// in the songs/ folder. Issues a HEAD request against each candidate
// URL — cheap, no body download — and returns true for the first one
// that responds 2xx. Used to decorate the song-picker list with a
// "HEAD" badge without having to actually load the head data.
async function probeSongHasHead(title) {
  if (!title) return false;
  for (const ext of ['musicxml', 'mid']) {
    const url = `songs/${encodeURIComponent(title)}.${ext}`;
    try {
      const res = await fetch(url, { method: 'HEAD' });
      if (res.ok) return true;
    } catch (e) { /* network error → try next ext */ }
  }
  return false;
}

// ----- Song picker popup (portrait) + filter (both layouts) -----
function isLandscape() {
  return document.body.classList.contains('layout-landscape');
}
function openSongPicker() {
  const panel = document.getElementById('songListPanel');
  if (!panel) return;
  // In landscape the panel is always in the sidebar — no modal open
  // needed. We DO NOT auto-focus the filter input: on mobile that
  // pops up the on-screen keyboard immediately and covers most of
  // the song list, forcing the user to dismiss it just to browse.
  if (!isLandscape()) panel.classList.add('open');
}
function closeSongPicker() {
  const panel = document.getElementById('songListPanel');
  if (!panel) return;
  // Clear the filter on portrait close so the next open shows the
  // full list. Landscape keeps the filter because the panel stays
  // open as a sidebar — clearing there would be surprising.
  if (!isLandscape()) {
    const f = document.getElementById('songFilter');
    if (f && f.value) { f.value = ''; applySongFilter(''); }
  }
  panel.classList.remove('open');
}
function applySongFilter(q) {
  const needle = (q || '').trim().toLowerCase();
  document.querySelectorAll('#songList li').forEach(li => {
    // Match against the song name only — the HEAD badge lives in a
    // sibling span, so `li.textContent` would also include "HEAD"
    // and any search for "h", "he", "head" would spuriously match
    // every song with a head file.
    const nameEl = li.querySelector('.song-name');
    const text = (nameEl ? nameEl.textContent : li.textContent).toLowerCase();
    const hit = !needle || text.includes(needle);
    li.hidden = !hit;
  });
  const clearBtn = document.getElementById('songFilterClear');
  if (clearBtn) clearBtn.hidden = !(q && q.length > 0);
}
// Document-level event delegation for the filter input and clear
// button. Bound ONCE on the document, so the handler fires regardless
// of whether the specific #songFilter element ever gets reparented,
// replaced, or re-rendered. Much more robust than per-element
// addEventListener.
let _songFilterDelegationBound = false;
function ensureSongFilterBindings() {
  if (_songFilterDelegationBound) return;
  _songFilterDelegationBound = true;
  document.addEventListener('input', e => {
    if (e.target && e.target.id === 'songFilter') {
      applySongFilter(e.target.value);
    }
  });
  document.addEventListener('keydown', e => {
    if (!e.target || e.target.id !== 'songFilter') return;
    if (e.key === 'Escape') {
      if (e.target.value) {
        e.target.value = '';
        applySongFilter('');
      } else if (!isLandscape()) {
        closeSongPicker();
      }
    }
  });
  document.addEventListener('click', e => {
    if (!e.target) return;
    // Walk up a couple of levels in case the click landed on the ✕
    // glyph inside the button element.
    let node = e.target;
    for (let i = 0; i < 3 && node; i++) {
      if (node.id === 'songFilterClear') {
        const f = document.getElementById('songFilter');
        if (f) { f.value = ''; applySongFilter(''); f.focus(); }
        return;
      }
      node = node.parentNode;
    }
  });
}
(function bindSongPickerControls() {
  const btn = document.getElementById('songPickerBtn');
  if (btn) btn.addEventListener('click', openSongPicker);
  const closeBtn = document.getElementById('songPickerClose');
  if (closeBtn) closeBtn.addEventListener('click', closeSongPicker);
  // Filter input + clear button listeners live in ensureSongFilterBindings
  // so initSongLibrary can re-establish them after a rebuild.
  ensureSongFilterBindings();
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
  const instrumentsPanel = document.getElementById('instrumentsPanel');
  const fbPanel = document.getElementById('fingerboardPanel');
  const songListPanel = document.getElementById('songListPanel');

  if (landscape) {
    body.classList.add('layout-landscape');
    sidebar.hidden = false;
    // Order (top → bottom): transport buttons, song list (fills),
    // options, instruments, note info panel.
    sidebar.appendChild(topRow);
    sidebar.appendChild(songListPanel);
    sidebar.appendChild(optionsPanel);
    if (instrumentsPanel) sidebar.appendChild(instrumentsPanel);
    sidebar.appendChild(fbPanel);
    // Always open in landscape — CSS uses `display: flex !important` to
    // defeat the `hidden` attribute that the toggles leave behind.
  } else {
    body.classList.remove('layout-landscape');
    sidebar.hidden = true;
    // Restore original mobile positions.
    header.insertBefore(topRow, header.firstChild);
    header.appendChild(optionsPanel);
    if (instrumentsPanel) header.appendChild(instrumentsPanel);
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
    const instToggleEl = document.getElementById('instrumentsToggle');
    if (instrumentsPanel && instToggleEl) {
      const instExp = instToggleEl.getAttribute('aria-expanded') === 'true';
      instrumentsPanel.hidden = !instExp;
    }
    const fbExp = document.getElementById('fbToggle').getAttribute('aria-expanded') === 'true';
    fbPanel.hidden = !fbExp;
  }
}

window.addEventListener('resize', applyLayoutMode);
applyLayoutMode();

initSongLibrary();
