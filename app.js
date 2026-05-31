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
// 1 ♭2 3 4 5 6 ♭7 — Mixolydian with a flatted 9. Used over a 7♭9
// chord that resolves to a MAJOR chord (instead of minor); the
// natural 6 foreshadows the resolution's major 3rd. Differs from
// Phrygian Dominant only in its 6th degree (♮6 vs ♭6).
const SCALE_MIXOLYDIAN_B9 =    [{s:0,t:0},{s:1,t:-5},{s:4,t:4},{s:5,t:-1},{s:7,t:1},{s:9,t:3},{s:10,t:-2}];
// 1 ♭9 ♭3 3 ♯11 5 13 ♭7 — Half-Whole Diminished, the symmetric 8-note
// scale that contains every chord tone of a 7♭9 (root, 3rd, 5th, ♭7,
// ♭9), plus the ♯9, ♯11, and 13 as fully usable color tones. Spelled
// here with b3 (matches the chord's ♯9) and ♯11 (above the 5) for the
// most common Levine/Aebersold reading. Spans semitones
// 0,1,3,4,6,7,9,10.
const SCALE_HALF_WHOLE_DIMINISHED =
                               [{s:0,t:0},{s:1,t:-5},{s:3,t:-3},{s:4,t:4},{s:6,t:6},{s:7,t:1},{s:9,t:3},{s:10,t:-2}];

// Translate a "diatonic scale index" (0=R, 1=2, 2=3, 3=4, 4=5, 5=6,
// 6=7, 7=R+oct, 8=2+oct, …) into the actual index in the given
// scale. Diatonic 7-note scales pass straight through. Half-Whole
// Diminished is the only special case: its 8 notes interleave chord
// tones with passing tones, so logical "3" maps to HW index 3 (the
// chord's major 3rd) instead of HW index 2 (the b3/#9 passing tone),
// "5" to HW index 5 instead of 4 (#11), and "7" to HW index 7 instead
// of 6 (13). Used by every chord-tone arpeggiator (1235, 3579, range
// 3579) so a "1-2-3-5" over D7♭9 reads D-E♭-F♯-A, not D-E♭-F-G♯.
const HW_DIATONIC_REMAP = [0, 1, 3, 4, 5, 6, 7]; // diatonic 0..6 → HW 0..7
function diatonicIndexInScale(diatonicIdx, scale) {
  if (!scale || scale.length !== 8) return diatonicIdx;
  const sig = scale.map(x => x.s).join(',');
  // HW diminished — used by 7♭9 chords. Diatonic-octave wrap is 7
  // (R, 2, 3, 4, 5, 6, 7, then R+oct); HW-octave wrap is 8 (the
  // scale itself has 8 entries before the next R). So idx 8 (=
  // "9th" in diatonic terms) becomes HW idx 1 + 1 octave = 9 raw.
  // The remap also skips HW idx 2 so a "3rd of 7♭9" lands on the
  // chord's MAJOR 3rd (HW[3]) rather than the b3/♯9 passing tone.
  if (sig === '0,1,3,4,6,7,9,10') {
    const oct = Math.floor(diatonicIdx / 7);
    const within = ((diatonicIdx % 7) + 7) % 7;
    return HW_DIATONIC_REMAP[within] + oct * 8;
  }
  // WH diminished — used by fully-diminished (dim7 / °7) chords. The
  // 8-note scale's positions ALREADY line up with diatonic chord
  // tones (scale[2] = b3, scale[4] = b5, scale[6] = bb7), so no
  // per-position remap is needed — but the octave wrap still has
  // to translate diatonic-7 → scale-8 so the "9th" of a dim7 lands
  // on the 2 + octave (scale[1] + 8) and not the root + octave
  // (scale[0] + 8, which would be just the 1 again).
  if (sig === '0,2,3,5,6,8,9,11') {
    const oct = Math.floor(diatonicIdx / 7);
    const within = ((diatonicIdx % 7) + 7) % 7;
    return within + oct * 8;
  }
  return diatonicIdx;
}

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
  // 7♭9 → Half-Whole Diminished. Contains all chord tones (R, 3, 5,
  // ♭7, ♭9) plus ♯9 / ♯11 / 13 as color tones, regardless of whether
  // the chord resolves to major or minor. Replaces the older
  // Phrygian-Dominant / Mixolydian-♭9 split.
  if (/^[0-9]/.test(q) && /[b♭]9/.test(q)) return SCALE_HALF_WHOLE_DIMINISHED;
  if (/^[0-9]/.test(q)) return SCALE_MIXOLYDIAN;
  if (/sus/i.test(q)) return SCALE_MIXOLYDIAN;
  if (/aug|\+/i.test(q)) return SCALE_IONIAN;
  return SCALE_IONIAN;
}

// True if a chord is "minor-resolving" — i.e. a 7♭9 that lands on
// it should treat the resolution as V → minor i. Covers plain
// minor (m / min / mi / hyphen), half-diminished (ø / m7♭5 / h),
// and fully-diminished (dim / °).
function isMinorResolutionChord(chordTextStr) {
  if (!chordTextStr) return false;
  const q = String(chordTextStr).replace(/^[A-Ga-g][#♯b♭]?/, '');
  if (/[øØ]/.test(q)) return true;
  if (/m7[b♭]5|min7[b♭]5|mi7[b♭]5/i.test(q)) return true;
  if (/^h/i.test(q)) return true;
  if (/dim|°/i.test(q)) return true;
  if (/^o/i.test(q)) return true;
  if (/^(m(?!a)|min|mi|\-|−)/i.test(q)) return true;
  return false;
}

// Context-aware scale lookup. Identical to exGetScale now that 7♭9
// uses Half-Whole Diminished regardless of resolution direction —
// the previous Phrygian Dominant (V → minor i) vs Mixolydian ♭9
// (V → major I) split has been collapsed. The signature is kept so
// existing callers don't need to change.
function exGetScaleContextual(chordTextStr, nextChordTextStr) {
  return exGetScale(chordTextStr);
}

// Effective scale for a chord event when the song is being read inside
// a key pattern. Major-key patterns ordinarily flatten every chord to
// the parent's Ionian (so an Eb^7 in a Bb-major 251 reads as Bb major,
// not Eb Lydian) — but a 7♭9 chord must KEEP its own Half-Whole
// Diminished scale even when nested inside a major pattern, otherwise
// the b9 (and the rest of the altered tones) drop out of the scale
// set. Used by every generator's `effective` map and by the
// note-info-panel's per-chord scale label.
function pickEffectiveScale(ce, pat) {
  const canonical = chordToCanonical(ce.chord);
  const restRaw = String(canonical).replace(/^[A-Ga-g][#♯b♭]?/, '');
  // 7♭9 detection: dominant-flavoured quality (numeric) with a ♭9
  // alteration. ALWAYS uses HW Diminished, pattern or not.
  const is7b9 = /^[0-9]/.test(restRaw) && /[b♭]9/.test(restRaw);
  if (is7b9) {
    return { root: ce.root, scale: SCALE_HALF_WHOLE_DIMINISHED };
  }
  if (pat && pat.keyMode === 'major') {
    return { root: pat.keyRoot, scale: SCALE_IONIAN };
  }
  return { root: ce.root, scale: exGetScale(canonical) };
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
    // the parent major (e.g. Eb^7 as IV of Bb uses A, not Ab). 7♭9 chords
    // are an exception — they keep their own Half-Whole Diminished scale
    // even inside a major pattern (handled inside pickEffectiveScale).
    return pickEffectiveScale(ce, pat);
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

// Scale Chromatic generator: a diatonic scale walk that fills only
// the FIRST `beatsPerBar - 1` beats of each bar (3 in 4/4, 2 in
// 3/4) — the last beat of each bar is reserved for a half-step
// chromatic approach to the FIRST note of the NEXT bar. Treating
// the last beat as "rest in the base pattern, replaced by a
// chromatic" (rather than "scale step replaced by chromatic") is
// what keeps the bar-to-bar continuity matching the spec — bar 2
// starts on G after bar 1 ends on F (not on A, which is what a
// 4-note walk would produce).
//
// Worked examples from the spec:
//   Dm7  → G7   → CMaj7
//   D E F F♯  | G A B D♭ | C D E F …
//
// Direction rule for the chromatic note:
//   - line ascending (the bar's scale walk is going up)  →
//     approach the next bar's first note FROM BELOW
//     (chromatic-below = leading-tone-up).
//   - line descending → approach FROM ABOVE
//     (chromatic-above = leading-tone-down).
//   - if the chosen direction's chromatic pitch class would be
//     the SAME as the bar's last scale note (e.g. ascending
//     toward C with the previous beat already on B — chromatic-
//     below C is also B, a duplicate), flip to the opposite
//     direction. That's exactly what bumps bar 2's chromatic in
//     the example off "B" and onto "D♭".
// Walk Triad generator. The first beat of every chord event lands on
// one of that chord's 1, 3, or 5. Each chord's target is the 1/3/5
// pitch CLOSEST (within an octave) to the previous chord's target,
// excluding the same pitch class — that keeps the line moving and
// avoids static "stay on the same note" transitions. The remaining
// beats inside the chord's range walk smoothly toward the NEXT
// chord's target via the chord's own scale: middle beats step
// through scale tones, and the LAST beat of the chord's range
// lands 1 or 2 semitones from the next chord's target so the
// arrival note sounds like a leading tone or natural neighbor.
//
// Worked example (4/4, all chords own a full bar):
//   Dm7   → G7    → CMaj7
//   target  D       B (closest of G/B/D to D, excluding D)  C (closest of C/E/G to B)
//   bar1:   D - - X (X = approach to G7's B, e.g. C above or A♯ below)
//   bar2:   B - - X (approach to C)
//   bar3:   C - - … (final chord, no approach needed)
function generateWalkTriadQuarterNotes(bars, ts) {
  const beatsPerBar = ts.num;
  const chordEvents = buildChordEventList(bars);
  const patterns = detectKeyPatterns(chordEvents);
  const effective = chordEvents.map((ce, i) => {
    const pat = patterns.find(p => i >= p.firstIdx && i <= p.lastIdx);
    return pickEffectiveScale(ce, pat);
  });

  const results = bars.map(() => new Array(beatsPerBar).fill(null));
  // Spelling preference for non-scale chromatic approach tones.
  // Falls back to flats for flat-key songs / keys, sharps otherwise.
  const _useFlats = (typeof FLAT_KEYS !== 'undefined'
    && typeof currentKey === 'string' && FLAT_KEYS.has(currentKey))
    || (typeof currentIsMinor !== 'undefined' && currentIsMinor === false
        && (currentKey === 'C#' || currentKey === 'F#' || currentKey === 'G#'));
  const SHARP_TPCS = [14, 21, 16, 23, 18, 13, 20, 15, 22, 17, 24, 19];
  const FLAT_TPCS  = [14,  9, 16, 11, 18, 13,  8, 15, 10, 17, 12, 19];
  const tpcMap = _useFlats ? FLAT_TPCS : SHARP_TPCS;

  // 1, 3, 5 of a chord — uses diatonicIndexInScale so HW Diminished
  // (over 7♭9 chords) maps to the chord's REAL 3 / 5 instead of the
  // ♭3 / ♯11 passing tones. Returns [{pc, tpc}, ...].
  function get135Tones(ce) {
    const chordScale = exGetScale(chordToCanonical(ce.chord));
    if (!chordScale || chordScale.length === 0) return [];
    const rootPc = ce.root.pitchClass;
    const rootTpc = ce.root.tpc;
    const tones = [];
    for (const d of [0, 2, 4]) {
      const idx = diatonicIndexInScale(d, chordScale);
      if (idx >= chordScale.length) continue;
      const sd = chordScale[idx];
      tones.push({
        pc: ((rootPc + sd.s) % 12 + 12) % 12,
        tpc: rootTpc + sd.t
      });
    }
    return tones;
  }

  function pitchesForPC(pc) {
    const opts = [];
    for (let p = EX_LOW; p <= EX_HIGH; p++) {
      if ((((p % 12) + 12) % 12) === pc) opts.push(p);
    }
    return opts;
  }

  // Pick a target pitch (1, 3, or 5) for every chord event in order.
  // First chord: the chord-tone pitch closest to the cello midrange
  // (~F2 = MIDI 41) so the line starts in a comfortable register.
  // Subsequent chords: rank the available chord-tone PCs (excluding
  // same-pc-as-previous) by closest-pitch distance to the previous
  // target, and most of the time pick the closest one — but with a
  // ~35% chance pick the SECOND-closest instead. The wider interval
  // forces the in-between fills to scale-walk through more notes
  // rather than always sitting as a tight enclosure pair, which is
  // the variety the user asked for.
  //
  // Determinism: seeded by chord index so the same song renders
  // identically across renders, but switches it up across chords.
  function pickWithVariety(candidates, ci) {
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];
    // Knuth-multiplier hash → 0..99 from chord index.
    const seed = ((ci + 1) * 2654435761) >>> 0;
    const r = seed % 100;
    if (r < 35) return candidates[1]; // 35% second-closest
    return candidates[0];
  }
  // Build a pc-grouped, distance-ranked candidate list. Each entry
  // is the BEST pitch-octave for one pc, with its distance to the
  // reference. Sorting by distance and picking 1st vs 2nd gives the
  // "step further away" variety.
  function rankCandidates(tones, refPitch, excludePc) {
    const list = [];
    for (const t of tones) {
      if (excludePc != null && t.pc === excludePc) continue;
      let bestPitch = null, bestDist = Infinity;
      for (const p of pitchesForPC(t.pc)) {
        const d = Math.abs(p - refPitch);
        if (d < bestDist) { bestDist = d; bestPitch = p; }
      }
      if (bestPitch != null) {
        list.push({ pitch: bestPitch, tpc: t.tpc, pc: t.pc, dist: bestDist });
      }
    }
    list.sort((a, b) => a.dist - b.dist);
    return list;
  }
  const targets = [];
  let prevTarget = null;
  for (let ci = 0; ci < chordEvents.length; ci++) {
    const ce = chordEvents[ci];
    const tones = get135Tones(ce);
    if (tones.length === 0) { targets.push(null); continue; }
    let chosen = null;
    if (prevTarget == null) {
      // First chord — rank against the cello midrange (no prevTarget
      // to step away from). No same-pc exclusion needed.
      const ranked = rankCandidates(tones, 41, null);
      chosen = pickWithVariety(ranked, ci);
    } else {
      const ranked = rankCandidates(tones, prevTarget.pitch, prevTarget.pc);
      chosen = pickWithVariety(ranked, ci);
      if (!chosen) {
        // All chord tones share a pc with prevTarget — fall back to
        // any chord tone (allow same-pc).
        const fallbackRanked = rankCandidates(tones, prevTarget.pitch, null);
        chosen = pickWithVariety(fallbackRanked, ci);
      }
    }
    targets.push(chosen);
    prevTarget = chosen;
  }

  // Helper: scale tones in cello range for a chord (sorted ascending).
  function scaleTonesFor(ce) {
    const scale = exGetScale(chordToCanonical(ce.chord));
    const rootPc = ce.root.pitchClass;
    const rootTpc = ce.root.tpc;
    const tones = [];
    for (let oct = 0; oct <= 7; oct++) {
      for (const sd of scale) {
        const pitch = rootPc + sd.s + oct * 12;
        if (pitch < EX_LOW || pitch > EX_HIGH) continue;
        tones.push({ pitch, tpc: rootTpc + sd.t });
      }
    }
    tones.sort((a, b) => a.pitch - b.pitch);
    return tones;
  }

  // Pick a single neighbor of `nextPitch` on a given side (+1 above,
  // -1 below). Prefers a scale tone of the current chord at 1 or 2
  // semitones distance, and SKIPS any candidate that equals
  // `avoidPitch` (= the chord's target) — without this guard, a
  // target like F over a coming F♯ would pick F itself as the
  // 1-semitone-below enclosure, making the line uselessly return to
  // its starting pitch. Falls back to chromatic, then "any neighbor
  // in range" as last resorts.
  function pickNeighborOnSide(nextPitch, side, scalePcs, avoidPitch) {
    const candidates = [nextPitch + side * 1, nextPitch + side * 2];
    // Pass 1: scale tone, ≠ avoidPitch.
    for (const c of candidates) {
      if (c < EX_LOW || c > EX_HIGH) continue;
      if (avoidPitch != null && c === avoidPitch) continue;
      const cpc = ((c % 12) + 12) % 12;
      if (scalePcs.has(cpc)) return c;
    }
    // Pass 2: chromatic, ≠ avoidPitch.
    for (const c of candidates) {
      if (c < EX_LOW || c > EX_HIGH) continue;
      if (avoidPitch != null && c === avoidPitch) continue;
      return c;
    }
    // Pass 3: any in-range candidate, even if = avoidPitch.
    for (const c of candidates) {
      if (c >= EX_LOW && c <= EX_HIGH) return c;
    }
    return null;
  }

  // TPC-of-pitch helper: prefer the chord's scale-tone tpc when the
  // pitch's PC is in the scale; otherwise fall back to the song's
  // flat/sharp preference table.
  function tpcOfPitch(pitch, chordScale, rootPc, rootTpc) {
    const pc = ((pitch % 12) + 12) % 12;
    for (const sd of chordScale) {
      if (((rootPc + sd.s) % 12 + 12) % 12 === pc) return rootTpc + sd.t;
    }
    return tpcMap[pc];
  }

  // Pick scale-tone walk pitches between `fromPitch` and `toPitch`,
  // avoiding two collision sources:
  //   1. The previous pitch (`avoidStart` initially, then the
  //      previous chosen note) — keeps consecutive beats different.
  //   2. The pitch the walk is HEADING TOWARD (`avoidEnd`) — keeps
  //      the walk slot from landing on the upcoming enclosure note,
  //      which would either repeat at placement time or get
  //      chromatically nudged to a non-scale tone (the bug that
  //      produced an A♭ over FMaj7 walking up to G).
  // Each pick lands on the closest scale tone to the linear-
  // interpolation target. On a collision with either avoid-pitch,
  // the index shifts ±1, ±2 looking for a clean alternative.
  function walkScaleTonesNoRepeat(fromPitch, toPitch, n, scaleTones, avoidStart, avoidEnd) {
    if (n <= 0) return [];
    if (scaleTones.length === 0) return new Array(n).fill(fromPitch);
    function closestIdx(p) {
      let best = 0, bestDist = Infinity;
      for (let i = 0; i < scaleTones.length; i++) {
        const d = Math.abs(scaleTones[i].pitch - p);
        if (d < bestDist) { bestDist = d; best = i; }
      }
      return best;
    }
    const sIdx = closestIdx(fromPitch);
    const eIdx = closestIdx(toPitch);
    const dir = eIdx >= sIdx ? 1 : -1;
    const result = [];
    let prevPitch = avoidStart;
    for (let i = 1; i <= n; i++) {
      const t = i / (n + 1);
      let idx = Math.round(sIdx + (eIdx - sIdx) * t);
      idx = Math.max(0, Math.min(scaleTones.length - 1, idx));
      const collides = (idx) => {
        if (idx < 0 || idx >= scaleTones.length) return true;
        const p = scaleTones[idx].pitch;
        if (p === prevPitch) return true;
        if (avoidEnd != null && p === avoidEnd) return true;
        return false;
      };
      // Try shifting ±1, ±2 (in walk direction first) until a
      // collision-free index is found.
      if (collides(idx)) {
        const tries = [idx + dir, idx - dir, idx + 2 * dir, idx - 2 * dir];
        for (const t2 of tries) {
          if (!collides(t2)) { idx = t2; break; }
        }
      }
      idx = Math.max(0, Math.min(scaleTones.length - 1, idx));
      result.push(scaleTones[idx]);
      prevPitch = scaleTones[idx].pitch;
    }
    return result;
  }

  // Place notes for each chord event.
  for (let ci = 0; ci < chordEvents.length; ci++) {
    const ce = chordEvents[ci];
    const target = targets[ci];
    if (!target) continue;
    const { startBeat, endBeat } = chordBeatRange(ce.chordsInBar, ce.chordIdxInBar, beatsPerBar);
    const numBeats = endBeat - startBeat;
    if (numBeats <= 0) continue;
    const barIdx = ce.barIdx;

    // Beat 1 of this chord = the target.
    results[barIdx][startBeat] = { pitch: target.pitch, tpc: target.tpc, duration: 'q' };
    if (numBeats === 1) continue;

    const chordScale = exGetScale(chordToCanonical(ce.chord));
    const rootPc = ce.root.pitchClass;
    const rootTpc = ce.root.tpc;
    const scalePcs = new Set(chordScale.map(sd => ((rootPc + sd.s) % 12 + 12) % 12));
    const sTones = scaleTonesFor(ce);
    const nextTarget = targets[ci + 1];

    // Last chord (no successor): no enclosure / approach needed.
    // Fill remaining beats with a scale walk descending from target.
    if (!nextTarget) {
      const fills = walkScaleTonesNoRepeat(
        target.pitch, target.pitch - 4, numBeats - 1, sTones, target.pitch, null
      );
      for (let i = 0; i < fills.length; i++) {
        const f = fills[i];
        if (!f) continue;
        results[barIdx][startBeat + 1 + i] = { pitch: f.pitch, tpc: f.tpc, duration: 'q' };
      }
      continue;
    }

    // Build the enclosure pair around nextTarget: one note on each
    // side at 1 or 2 semitones distance. The "above" and "below"
    // tones together "enclose" the next-chord target — the user's
    // requested approach style. When numBeats >= 3 we use BOTH; for
    // numBeats === 2 we have only one beat for an approach, so we
    // pick the side that matches the walk direction. Each side's
    // pick excludes `target.pitch` so a target like F walking up
    // to a coming F♯ never "approaches" via F itself.
    const above = pickNeighborOnSide(nextTarget.pitch, +1, scalePcs, target.pitch);
    const below = pickNeighborOnSide(nextTarget.pitch, -1, scalePcs, target.pitch);
    const walkUp = nextTarget.pitch >= target.pitch;

    // Helper: add tpc to a pitch + write into results at a given beat.
    // Re-checks "no repeat" against `prevPitch`; if the chosen pitch
    // collides, nudge up or down by 1 semitone (chromatic) so the
    // line keeps moving.
    function placeAt(beatIdx, pitch, prevPitch) {
      if (pitch == null) return prevPitch;
      let p = pitch;
      if (p === prevPitch) {
        // Try +1 then -1 (chromatic neighbors)
        if (p + 1 <= EX_HIGH && p + 1 !== prevPitch) p = p + 1;
        else if (p - 1 >= EX_LOW && p - 1 !== prevPitch) p = p - 1;
      }
      const tpc = tpcOfPitch(p, chordScale, rootPc, rootTpc);
      results[barIdx][beatIdx] = { pitch: p, tpc, duration: 'q' };
      return p;
    }

    if (numBeats === 2) {
      // Single approach beat. Match walk direction: walking up →
      // approach FROM BELOW; walking down → approach FROM ABOVE.
      let approach = walkUp ? below : above;
      // If that side's neighbor would repeat the target, flip sides.
      if (approach === target.pitch) approach = walkUp ? above : below;
      placeAt(endBeat - 1, approach, target.pitch);
      continue;
    }

    // Choose between two fill styles per chord:
    //   - WALKDOWN: scale-walk from target straight toward nextTarget,
    //     ending on a single approach tone 1 or 2 semitones from
    //     next-target. NO above/below enclosure pair — just a clean
    //     run, classic jazz walking-bass shape.
    //   - ENCLOSURE: target → walk → encl_above → encl_below → next.
    //     Sits down into the next target by visiting both sides.
    // Hashing the chord index gives a stable ~50/50 distribution
    // across the song. Walkdown is attempted first (when wanted);
    // if there isn't enough room for a clean run (e.g. narrow
    // intervals like target == next-target ± 2), falls through to
    // enclosure.
    const styleSeed = ((ci + 13) * 2654435761) >>> 0;
    const wantWalkdown = numBeats >= 3 && (styleSeed % 100) < 50;

    let prevPitch = target.pitch;

    // Try to build a clean walkdown. Approach priority:
    //   1. DIATONIC 2-semitone (whole step in the chord's scale)
    //      — produces the user's "A | G" style landing.
    //   2. CHROMATIC 1-semitone leading tone — classic jazz bass.
    //   3. Diatonic-2 chromatic (out-of-scale 2-semitone) as a
    //      last resort.
    // For each candidate, we run walkScaleTonesNoRepeat and check
    // that the resulting fills don't collapse into consecutive
    // repeats or land on the approach itself. Returns null when
    // no candidate produces a valid walk → caller falls back to
    // enclosure.
    function tryBuildWalkdown() {
      const sideDir = walkUp ? -1 : +1;
      const fillSlots = numBeats - 2;
      if (fillSlots < 1) return null;
      const cand2 = nextTarget.pitch + sideDir * 2;
      const cand1 = nextTarget.pitch + sideDir * 1;
      const cand2Pc = ((cand2 % 12) + 12) % 12;
      const candList = [];
      if (cand2 !== target.pitch && cand2 >= EX_LOW && cand2 <= EX_HIGH && scalePcs.has(cand2Pc)) {
        candList.push(cand2);
      }
      if (cand1 !== target.pitch && cand1 >= EX_LOW && cand1 <= EX_HIGH) {
        candList.push(cand1);
      }
      if (cand2 !== target.pitch && cand2 >= EX_LOW && cand2 <= EX_HIGH && !scalePcs.has(cand2Pc)) {
        candList.push(cand2);
      }
      for (const approachTry of candList) {
        const walks = walkScaleTonesNoRepeat(
          target.pitch, approachTry, fillSlots, sTones,
          target.pitch, approachTry
        );
        if (!walks || walks.length !== fillSlots) continue;
        // Validate: no consecutive repeats, last walk note ≠ approach.
        let p = target.pitch;
        let valid = true;
        for (const w of walks) {
          if (!w || w.pitch === p) { valid = false; break; }
          p = w.pitch;
        }
        if (!valid) continue;
        if (p === approachTry) continue;
        return { walks, approach: approachTry };
      }
      return null;
    }

    if (wantWalkdown) {
      const wd = tryBuildWalkdown();
      if (wd) {
        for (let i = 0; i < wd.walks.length; i++) {
          const w = wd.walks[i];
          if (!w) continue;
          prevPitch = placeAt(startBeat + 1 + i, w.pitch, prevPitch);
        }
        prevPitch = placeAt(endBeat - 1, wd.approach, prevPitch);
        continue;
      }
      // Walkdown didn't fit cleanly — fall through to enclosure.
    }

    // ENCLOSURE STYLE — target on beat 1, walking middle beats,
    // then encl_above + encl_below on the last two beats. Order by
    // walk direction so the final beat ends opposite the walk side
    // (walking up → above first, below last → rises into next).
    const enclFirst  = walkUp ? above : below;
    const enclSecond = walkUp ? below : above;

    // Walking middle beats from target toward enclFirst. The walk
    // also avoids enclFirst itself as an end-pitch — without that
    // guard, a 1-walkSlot interval like F→G (only 2 semitones, no
    // in-scale tone strictly between) would land on G, then beat 3
    // would also be G, and the no-repeat fallback would chromatically
    // nudge to A♭ — outside the chord's scale. With the avoidEnd in
    // place, the walk picks a wider scale tone like A instead.
    const walkSlots = numBeats - 3;
    if (walkSlots > 0) {
      const walks = walkScaleTonesNoRepeat(
        target.pitch, enclFirst != null ? enclFirst : nextTarget.pitch,
        walkSlots, sTones, target.pitch, enclFirst
      );
      for (let i = 0; i < walkSlots; i++) {
        const w = walks[i];
        if (!w) continue;
        prevPitch = placeAt(startBeat + 1 + i, w.pitch, prevPitch);
      }
    }
    // First enclosure note.
    prevPitch = placeAt(startBeat + numBeats - 2, enclFirst, prevPitch);
    // Second enclosure note (the actual approach to nextTarget).
    prevPitch = placeAt(startBeat + numBeats - 1, enclSecond, prevPitch);
  }

  return { results, chordEvents, patterns, effective };
}

// "Mixed Triads": for each chord, plays a non-linear permutation of
// the 1, 3, 5 chord tones. Each bar visits the 3 chord-tone degrees
// with one degree repeated (sometimes as a back-to-back octave move).
//
// User-supplied patterns for a 4-beat bar over one chord:
//   "1 5 3 1"       — root, fifth, third, root
//   "1 3 1 5"       — root, third, root, fifth
//   "5 1 3 5"       — fifth, root, third, fifth
//   "1 1(oct) 5 3"  — root, root an octave away, fifth, third
//   "5 5(oct) 1 3"  — fifth, fifth an octave away, root, third
//
// Each beat's pitch is the chord-tone-of-target-degree closest to the
// PREVIOUS beat's pitch. When two adjacent beats share the same degree
// (e.g. "1 1(oct)") the realizer forces an octave shift so the line
// never repeats the same pitch back-to-back. Beat 1 of each chord is
// voice-led from the previous chord's LAST beat (chained across bars)
// with a sine-wave drift center for gentle ascending/descending shape.
function generateMixedTriadsQuarterNotes(bars, ts) {
  const beatsPerBar = ts.num;
  const chordEvents = buildChordEventList(bars);
  const patterns = detectKeyPatterns(chordEvents);
  const effective = chordEvents.map((ce, i) => {
    const pat = patterns.find(p => i >= p.firstIdx && i <= p.lastIdx);
    return pickEffectiveScale(ce, pat);
  });

  const results = bars.map(() => new Array(beatsPerBar).fill(null));

  // Seeded PRNG (mulberry32) for deterministic output across re-renders.
  function mulberry32(a) {
    return function() {
      let t = a += 0x6D2B79F5;
      t = Math.imul(t ^ t >>> 15, t | 1);
      t ^= t + Math.imul(t ^ t >>> 7, t | 61);
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  const rng = mulberry32(0x4D495854); // "MIXT"

  // Chord tones grouped by degree: { 0: [{pitch,tpc,...}, ...], 2: [...], 4: [...] }
  // for the 1, 3, 5 chord tones. Uses diatonicIndexInScale so HW
  // Diminished (over 7♭9 chords) still maps to the chord's REAL 3/5.
  function chordTonesByDegree(ce) {
    const chordScale = exGetScale(chordToCanonical(ce.chord));
    const byDeg = {};
    if (!chordScale || chordScale.length === 0) return byDeg;
    const rootPc = ce.root.pitchClass;
    const rootTpc = ce.root.tpc;
    for (const d of [0, 2, 4]) {
      const idx = diatonicIndexInScale(d, chordScale);
      if (idx >= chordScale.length) continue;
      const sd = chordScale[idx];
      const pc = ((rootPc + sd.s) % 12 + 12) % 12;
      const tpc = rootTpc + sd.t;
      const pitches = [];
      for (let p = EX_LOW; p <= EX_HIGH; p++) {
        if ((((p % 12) + 12) % 12) === pc) {
          pitches.push({ pitch: p, tpc, pc, degree: d });
        }
      }
      if (pitches.length > 0) byDeg[d] = pitches;
    }
    return byDeg;
  }
  const tonesByDeg = chordEvents.map(chordTonesByDegree);

  // Closest pitch of a specific degree to refPitch.
  function pitchForDegree(byDeg, degree, refPitch) {
    const cands = byDeg[degree];
    if (!cands || cands.length === 0) return null;
    let best = cands[0];
    let bestDist = Math.abs(best.pitch - refPitch);
    for (let i = 1; i < cands.length; i++) {
      const d = Math.abs(cands[i].pitch - refPitch);
      if (d < bestDist) { bestDist = d; best = cands[i]; }
    }
    return best;
  }

  // Drift center: oscillates between low and high cello register so
  // the line gently ascends and descends across the song instead of
  // grinding on one register.
  const driftLow = EX_LOW + 4;
  const driftHigh = EX_HIGH - 4;
  const driftRange = driftHigh - driftLow;
  function driftCenter(ci) {
    const phase = (ci / 14) * 2 * Math.PI;
    const v = (Math.sin(phase) + 1) / 2;
    return driftLow + v * driftRange;
  }

  // Pick a degree sequence (length numBeats) starting with beat1Deg.
  // For 4-beat bars, samples from the user-supplied patterns
  // ("1 5 3 1", "1 3 1 5", "5 1 3 5", "1 1(oct) 5 3", "5 5(oct) 1 3").
  // Shorter/longer bars get adapted variants that still visit each
  // chord-tone degree at least once when possible.
  function pickDegreeSequence(beat1Deg, otherDegs, numBeats) {
    if (numBeats <= 1) return [beat1Deg];
    if (otherDegs.length === 0) {
      // Only one chord-tone degree available — fill with the same
      // degree everywhere; the realizer will octave-displace adjacent
      // duplicates so it doesn't stagnate on one pitch.
      return new Array(numBeats).fill(beat1Deg);
    }
    if (otherDegs.length === 1) {
      const o = otherDegs[0];
      if (numBeats === 2) return [beat1Deg, o];
      if (numBeats === 3) return [beat1Deg, o, beat1Deg];
      if (numBeats === 4) {
        // Spread the available 2 degrees: d, o, d, o or d, d(oct), o, o(oct)
        return rng() < 0.5 ? [beat1Deg, o, beat1Deg, o] : [beat1Deg, beat1Deg, o, o];
      }
      const seq = [];
      for (let i = 0; i < numBeats; i++) seq.push(i % 2 === 0 ? beat1Deg : o);
      return seq;
    }
    // 2+ other degrees: shuffle once
    const others = otherDegs.slice();
    if (rng() < 0.5) [others[0], others[1]] = [others[1], others[0]];
    const a = others[0], b = others[1];

    if (numBeats === 2) {
      return [beat1Deg, rng() < 0.5 ? a : b];
    }
    if (numBeats === 3) {
      const r = rng();
      if (r < 0.4)  return [beat1Deg, a, b];
      if (r < 0.75) return [beat1Deg, b, a];
      return [beat1Deg, beat1Deg, rng() < 0.5 ? a : b]; // d d(oct) x
    }
    if (numBeats === 4) {
      const r = rng();
      if (r < 0.20) return [beat1Deg, b, a, beat1Deg];  // "1 5 3 1"
      if (r < 0.40) return [beat1Deg, a, beat1Deg, b];  // "1 3 1 5"
      if (r < 0.60) return [beat1Deg, a, b, beat1Deg];  // "5 1 3 5"
      if (r < 0.80) return [beat1Deg, beat1Deg, b, a];  // "1 1(oct) 5 3"
      return [beat1Deg, beat1Deg, a, b];                // "5 5(oct) 1 3"
    }
    // 5+ beats: walk through {beat1Deg, a, b} avoiding same-degree repeats.
    const seq = [beat1Deg];
    for (let i = 1; i < numBeats; i++) {
      const prev = seq[seq.length - 1];
      const choices = [beat1Deg, a, b].filter(c => c !== prev);
      seq.push(choices[Math.floor(rng() * choices.length)]);
    }
    return seq;
  }

  // Pre-pick beat-1 degree for each chord: 50% root, 25% fifth, 25%
  // third. Falls back to any available degree if the chosen one isn't
  // present (rare). Doesn't bias toward root strongly — beat-1 can be
  // any chord tone per "It doesn't have to start on the root."
  const firstDegs = new Array(chordEvents.length).fill(-1);
  for (let ci = 0; ci < chordEvents.length; ci++) {
    const byDeg = tonesByDeg[ci];
    const avail = [0, 2, 4].filter(d => byDeg[d] && byDeg[d].length > 0);
    if (avail.length === 0) continue;
    const r = rng();
    let deg;
    if (r < 0.5)       deg = 0;
    else if (r < 0.75) deg = 4;
    else               deg = 2;
    if (!byDeg[deg]) deg = avail[0];
    firstDegs[ci] = deg;
  }

  // Main pass: walk chord events in order. For each chord:
  //   1. Pick beat-1 pitch by closest-degree to running pitch
  //      (blended with drift center).
  //   2. Build a degree sequence (the user-supplied patterns).
  //   3. Realize each degree as the chord-tone pitch closest to the
  //      previous beat's pitch. If consecutive beats share a degree
  //      (or otherwise land on the same pitch), force an octave shift.
  //   4. Update runningPitch = last beat's pitch so the next chord's
  //      beat-1 voice-leads from there.
  let runningPitch = null;
  for (let ci = 0; ci < chordEvents.length; ci++) {
    const ce = chordEvents[ci];
    const byDeg = tonesByDeg[ci];
    const firstDeg = firstDegs[ci];
    if (firstDeg < 0) continue;

    const { startBeat, endBeat } =
      chordBeatRange(ce.chordsInBar, ce.chordIdxInBar, beatsPerBar);
    const numBeats = endBeat - startBeat;
    if (numBeats <= 0) continue;
    const barIdx = ce.barIdx;

    // Beat-1 reference: 70% running pitch, 30% drift center.
    const refPitch = (runningPitch != null)
      ? runningPitch * 0.7 + driftCenter(ci) * 0.3
      : driftCenter(ci);
    const beat1 = pitchForDegree(byDeg, firstDeg, refPitch);
    if (!beat1) continue;

    // Degree sequence for this bar.
    const otherDegs = [0, 2, 4].filter(d =>
      d !== firstDeg && byDeg[d] && byDeg[d].length > 0);
    const seq = pickDegreeSequence(firstDeg, otherDegs, numBeats);

    // Realize each degree slot as a chord-tone pitch closest to the
    // PREVIOUS beat's pitch. When the chosen pitch equals the previous
    // beat's pitch (typically because the degree repeated), force an
    // octave shift (prefer up, fall back down).
    const placed = new Array(numBeats).fill(null);
    placed[0] = beat1;
    results[barIdx][startBeat] = { pitch: beat1.pitch, tpc: beat1.tpc, duration: 'q' };
    let prevPitch = beat1.pitch;
    let prevTpc = beat1.tpc;
    for (let i = 1; i < numBeats; i++) {
      const deg = seq[i];
      let chosen = pitchForDegree(byDeg, deg, prevPitch);
      if (!chosen) continue;
      if (chosen.pitch === prevPitch) {
        // Octave-displace: prefer UP, fall back DOWN.
        let alt = null;
        if (chosen.pitch + 12 <= EX_HIGH) alt = chosen.pitch + 12;
        else if (chosen.pitch - 12 >= EX_LOW) alt = chosen.pitch - 12;
        if (alt != null) chosen = { pitch: alt, tpc: chosen.tpc, pc: chosen.pc, degree: chosen.degree };
      }
      placed[i] = chosen;
      results[barIdx][startBeat + i] = { pitch: chosen.pitch, tpc: chosen.tpc, duration: 'q' };
      prevPitch = chosen.pitch;
      prevTpc = chosen.tpc;
    }

    // Update running pitch for the next chord.
    runningPitch = prevPitch;
  }

  // Post-pass: octave-displace any consecutive same-pitch notes so the
  // line never repeats the exact same pitch back-to-back. Walks all
  // sounding notes in order across every bar — catches within-bar
  // repeats (e.g. an enclosure note that happened to match beat 1)
  // AND across-bar repeats (e.g. the last beat of one chord equaling
  // the first beat of the next). Prefers shifting UP an octave (per
  // the user's "F1 G1 G2 A2" example); falls back to DOWN if out of
  // range. If neither octave fits in cello range the note is left
  // alone — a 2-octave cello span means this is essentially never hit.
  {
    let prevPitch = null;
    for (let bi = 0; bi < results.length; bi++) {
      const bar = results[bi];
      if (!bar) continue;
      for (let beat = 0; beat < bar.length; beat++) {
        const n = bar[beat];
        if (!n) continue;
        if (prevPitch != null && n.pitch === prevPitch) {
          if (n.pitch + 12 <= EX_HIGH) {
            n.pitch += 12;
          } else if (n.pitch - 12 >= EX_LOW) {
            n.pitch -= 12;
          }
        }
        prevPitch = n.pitch;
      }
    }
  }

  return { results, chordEvents, patterns, effective };
}

// "Landmarks": quarter notes on beats 1 and 3 only, beats 2 and 4
// left empty (rests) for the user to fill in. The notes are picked
// to outline the harmony with chord tones (1 / 3 / 5 / 7) while
// tracing a smooth linear arc from F1 up to F3 and back down again
// across the song.
//
// Per-bar landmark selection:
//   - 1-chord bar: beat 1 picks from priority [1, 5, 3, 7]; beat 3
//     picks from priority [3, 7, 5, 1] (jazz-line convention —
//     downbeats prefer stable tones, weak beats prefer color tones).
//   - 2+ chord bar: beats 1 and 3 each fall on whichever chord owns
//     that beat; BOTH use the beat-1 priority [1, 5, 3, 7].
//
// Direction wins over priority. From a running pitch the picker
// chooses the next chord tone IN the current direction (ascending
// or descending), regardless of where it sits in the priority
// list. The priority kicks in only for the very first note of the
// song (no previous direction to follow) and as a tiebreak when
// multiple chord tones share the same distance.
//
// The direction reverses when the picker hits within 2 semitones
// of the cello range extreme, producing a steady sawtooth-shaped
// landmark line over the form.
// Three Seven generator: each chord plays its 3 and 7 alternating
// (e.g. A#1 D#2 A#1 D#2 for BMaj7), using EXACTLY two pitches per
// chord — both the 3 and the 7 sit at one specific octave that's
// fixed for the entire duration of that chord (no octave hopping
// within a single chord).
//
// Direction is per-chord and alternates: chord 1 ascends relative to
// chord 0 (its two pitches sit higher overall), chord 2 descends
// relative to chord 1, etc.
//
// Enclosure preference: pick octaves so that the FIRST played note
// of each new chord sits BETWEEN the previous chord's two pitches —
// e.g. BMaj7 plays A#1 D#2 (34, 39), then Bb7 starts on D2 (38)
// which is bracketed by A#1 and D#2, before continuing up to Ab2
// (44). When no enclosing option exists, a chromatic-neighbor bonus
// of prev's last pitch is the next-best preference; the direction
// score and overall distance act as additional tiebreakers. Stays
// inside the F1..F3 cello range.
function generateThreeSevenQuarterNotes(bars, ts) {
  const beatsPerBar = ts.num;
  const chordEvents = buildChordEventList(bars);
  const patterns = detectKeyPatterns(chordEvents);
  const effective = chordEvents.map((ce, i) => {
    const pat = patterns.find(p => i >= p.firstIdx && i <= p.lastIdx);
    return pickEffectiveScale(ce, pat);
  });

  const results = bars.map(() => new Array(beatsPerBar).fill(null));

  // Resolve the chord's actual 3 and 7 via diatonicIndexInScale, so
  // altered/HW chords still yield their real 3 and b7 rather than a
  // passing-tone enharmonic.
  function get3And7(ce) {
    const chordScale = exGetScale(chordToCanonical(ce.chord));
    if (!chordScale || chordScale.length === 0) return null;
    const rootPc = ce.root.pitchClass;
    const rootTpc = ce.root.tpc;
    const out = {};
    for (const d of [2, 6]) {
      const idx = diatonicIndexInScale(d, chordScale);
      if (idx >= chordScale.length) continue;
      const sd = chordScale[idx];
      out[d] = {
        pc: ((rootPc + sd.s) % 12 + 12) % 12,
        tpc: rootTpc + sd.t
      };
    }
    return out;
  }

  // Enumerate every (3-octave, 7-octave) pair in the F1..F3 range.
  // Internal play order is always ascending (lower pitch first) so
  // the chord plays low→high→low→high — matches the user's example
  // pattern (A#1 D#2 A#1 D#2 for BMaj7).
  function getChordOptions(ce) {
    const t = get3And7(ce);
    if (!t || !t[2] || !t[6]) return [];
    const cA = [], cB = [];
    for (let p = EX_LOW; p <= EX_HIGH; p++) {
      const pc = ((p % 12) + 12) % 12;
      if (pc === t[2].pc) cA.push({ pitch: p, tpc: t[2].tpc });
      if (pc === t[6].pc) cB.push({ pitch: p, tpc: t[6].tpc });
    }
    const opts = [];
    for (const a of cA) for (const b of cB) {
      if (a.pitch === b.pitch) continue;
      const lo = Math.min(a.pitch, b.pitch);
      const hi = Math.max(a.pitch, b.pitch);
      const loTone = (a.pitch < b.pitch) ? a : b;
      const hiTone = (a.pitch < b.pitch) ? b : a;
      opts.push({ first: loTone, second: hiTone, lo, hi });
    }
    return opts;
  }

  // First chord: lowest pair, tightest interval.
  function scoreFirst(opt) {
    return -opt.lo - (opt.hi - opt.lo) * 2;
  }

  // Subsequent chord scoring.
  //   - REPEAT (forbidden): the first played note of the new chord
  //     must not equal the previous chord's last played pitch.
  //   - INTERVAL TIGHTNESS (heavy): wider-than-minimum intervals get
  //     a large penalty. For a Maj7 chord the tightest pair sits a
  //     perfect 4th apart (5 semitones); the alternative octave
  //     placement gives a perfect 5th (7 semitones), which is what
  //     we want to avoid when a tight option exists.
  //   - ENCLOSURE: first note strictly between prev chord's two
  //     pitches — preferred but not required.
  //   - CHROMATIC NEIGHBOR: first note a half-step from prev's last.
  //   - SMOOTHNESS: distance from prev's last pitch.
  //   - DIRECTION: chord center above/below prev center per the
  //     alternating-direction pattern. Subordinate to tightness.
  function scoreSubsequent(opt, prev, desiredDir, minInterval) {
    if (opt.first.pitch === prev.lastPitch) return -Infinity;
    let score = 0;
    const dist = Math.abs(opt.first.pitch - prev.lastPitch);
    score -= dist * 3;
    if (opt.first.pitch > prev.lo && opt.first.pitch < prev.hi) score += 60;
    if (dist === 1) score += 40;
    score -= ((opt.hi - opt.lo) - minInterval) * 80;
    const myAvg = (opt.lo + opt.hi) / 2;
    const prevAvg = (prev.lo + prev.hi) / 2;
    if ((desiredDir > 0 && myAvg > prevAvg) || (desiredDir < 0 && myAvg < prevAvg)) {
      score += 20;
    }
    return score;
  }

  let prevState = null;
  // direction = sign the NEXT subsequent chord should move relative
  // to the previous chord. First subsequent chord (ci=1) ascends.
  let direction = +1;

  for (let ci = 0; ci < chordEvents.length; ci++) {
    const ce = chordEvents[ci];
    const range = chordBeatRange(ce.chordsInBar, ce.chordIdxInBar, beatsPerBar);
    const opts = getChordOptions(ce);
    if (opts.length === 0) continue;

    // Tightest available interval for this chord — anything wider
    // gets a heavy penalty in scoreSubsequent.
    let minInterval = Infinity;
    for (const opt of opts) minInterval = Math.min(minInterval, opt.hi - opt.lo);

    const isFirst = !prevState;
    let best = null;
    let bestScore = -Infinity;
    for (const opt of opts) {
      const s = isFirst ? scoreFirst(opt)
                        : scoreSubsequent(opt, prevState, direction, minInterval);
      if (s > bestScore) { bestScore = s; best = opt; }
    }
    if (!best) continue;

    const nBeats = range.endBeat - range.startBeat;
    for (let i = 0; i < nBeats; i++) {
      const beat = range.startBeat + i;
      const tone = (i % 2 === 0) ? best.first : best.second;
      results[ce.barIdx][beat] = { pitch: tone.pitch, tpc: tone.tpc, duration: 'q' };
    }
    const lastTone = ((nBeats - 1) % 2 === 0) ? best.first : best.second;
    prevState = { lo: best.lo, hi: best.hi, lastPitch: lastTone.pitch };

    // Flip alternation only after a subsequent chord — the first
    // chord doesn't establish a direction yet.
    if (!isFirst) direction = -direction;
  }

  return { results, chordEvents, patterns, effective };
}

function generateLandmarksQuarterNotes(bars, ts) {
  return generateLandmarksCore(bars, ts, /*fillPassingTones=*/true);
}

// Landmarks-1-3: identical landmark-placement rules (beats 1 & 3 only),
// but with NO passing-tone fills on beats 2 & 4 — those stay as quarter
// rests. Useful for isolating the 1/3 chord-tone targets without the
// connecting line.
function generateLandmarks13QuarterNotes(bars, ts) {
  return generateLandmarksCore(bars, ts, /*fillPassingTones=*/false);
}

function generateLandmarksCore(bars, ts, fillPassingTones) {
  const beatsPerBar = ts.num;
  const chordEvents = buildChordEventList(bars);
  const patterns = detectKeyPatterns(chordEvents);
  const effective = chordEvents.map((ce, i) => {
    const pat = patterns.find(p => i >= p.firstIdx && i <= p.lastIdx);
    return pickEffectiveScale(ce, pat);
  });

  const results = bars.map(() => new Array(beatsPerBar).fill(null));

  // (barIdx, beat) → chordEventIndex for fast "what chord owns this
  // beat?" lookup. Mirrors the structure used by the game-mode
  // chord-tagger.
  const chordEventAtBeat = {};
  chordEvents.forEach((ce, ci) => {
    const range = chordBeatRange(ce.chordsInBar, ce.chordIdxInBar, beatsPerBar);
    for (let b = range.startBeat; b < range.endBeat; b++) {
      chordEventAtBeat[ce.barIdx + ':' + b] = ci;
    }
  });

  // Build the chord-tone dictionary for one chord event:
  // degree (0=1, 2=3, 4=5, 6=7) → { pc, tpc }.
  // Uses diatonicIndexInScale so 7♭9 / HW Diminished chords still
  // resolve to the chord's real 3 / 5 / 7 (not the b3 passing tone).
  function getChordTones(ce) {
    const chordScale = exGetScale(chordToCanonical(ce.chord));
    const tones = {};
    if (!chordScale || chordScale.length === 0) return tones;
    const rootPc = ce.root.pitchClass;
    const rootTpc = ce.root.tpc;
    for (const d of [0, 2, 4, 6]) {
      const idx = diatonicIndexInScale(d, chordScale);
      if (idx >= chordScale.length) continue;
      const sd = chordScale[idx];
      tones[d] = {
        pc: ((rootPc + sd.s) % 12 + 12) % 12,
        tpc: rootTpc + sd.t,
        degree: d
      };
    }
    return tones;
  }

  // Closest chord tone STRICTLY in the given direction from
  // prevPitch. Returns null if no chord tone exists past prevPitch
  // in that direction within the cello range (caller flips
  // direction in that case).
  function nextChordToneInDirection(prevPitch, direction, tones) {
    const all = [];
    for (const d in tones) {
      const pc = tones[d].pc;
      for (let p = EX_LOW; p <= EX_HIGH; p++) {
        if (((p % 12) + 12) % 12 === pc) {
          all.push({ pitch: p, tpc: tones[d].tpc, degree: tones[d].degree });
        }
      }
    }
    all.sort((a, b) => a.pitch - b.pitch);
    if (direction > 0) {
      for (const c of all) if (c.pitch > prevPitch) return c;
    } else {
      for (let i = all.length - 1; i >= 0; i--) if (all[i].pitch < prevPitch) return all[i];
    }
    return null;
  }

  // First-note pick: priority alone (no previous pitch to walk
  // from). Picks the LOWEST in-range octave so the line starts
  // near F1 and has room to ascend.
  function pickFirstNote(tones, priorityOrder) {
    for (const d of priorityOrder) {
      if (!(d in tones)) continue;
      const pc = tones[d].pc;
      for (let p = EX_LOW; p <= EX_HIGH; p++) {
        if (((p % 12) + 12) % 12 === pc) {
          return { pitch: p, tpc: tones[d].tpc, degree: tones[d].degree };
        }
      }
    }
    return null;
  }

  const BEAT_1_PRIORITY = [0, 4, 2, 6]; // 1, 5, 3, 7
  const BEAT_3_PRIORITY = [2, 6, 4, 0]; // 3, 7, 5, 1

  let prevPitch = null;
  let direction = +1; // start ascending

  for (let bi = 0; bi < bars.length; bi++) {
    // Landmarks land on beats 1 and 3 (0-indexed: 0 and 2). For
    // meters with fewer than 3 beats (rare), drop the beat-3 slot.
    const landmarkBeats = [0];
    if (beatsPerBar >= 3) landmarkBeats.push(2);

    for (const beat of landmarkBeats) {
      const ceIdx = chordEventAtBeat[bi + ':' + beat];
      if (ceIdx == null) continue;
      const ce = chordEvents[ceIdx];
      if (!ce) continue;
      const tones = getChordTones(ce);
      if (Object.keys(tones).length === 0) continue;

      // Pick the priority order:
      //   - beat 1 always uses [1, 5, 3, 7]
      //   - beat 3 uses [3, 7, 5, 1] IFF the chord on beat 3 also
      //     owned beat 1 (i.e., it's a 1-chord bar OR the same
      //     chord spans both landmark beats). When beat 3 falls on
      //     a DIFFERENT chord event (2-chord bar where chord 2
      //     starts on beat 3), use the beat-1 priority instead.
      let priorityOrder;
      if (beat === 0) {
        priorityOrder = BEAT_1_PRIORITY;
      } else {
        const beat0Ce = chordEventAtBeat[bi + ':' + 0];
        priorityOrder = (beat0Ce === ceIdx) ? BEAT_3_PRIORITY : BEAT_1_PRIORITY;
      }

      let note;
      if (prevPitch == null) {
        note = pickFirstNote(tones, priorityOrder);
      } else {
        note = nextChordToneInDirection(prevPitch, direction, tones);
        if (!note) {
          // Hit the range extreme; flip direction and try again.
          direction = -direction;
          note = nextChordToneInDirection(prevPitch, direction, tones);
        }
        // Still nothing? Fall back to the priority-based pick.
        if (!note) note = pickFirstNote(tones, priorityOrder);
      }
      if (!note) continue;

      // Safety net: guarantee the chosen pitch's PC is actually one
      // of the chord's 1/3/5/7 PCs. Both the in-direction picker and
      // the priority picker SHOULD only ever return chord tones —
      // but this assert-then-recover behavior ensures the staff
      // never displays a stray tension (9/11/13/etc.) even if a
      // future scale-table tweak shifts how `getChordTones` indexes
      // into a custom chord scale.
      const validPcs = new Set();
      for (const d in tones) validPcs.add(tones[d].pc);
      const notePc = ((note.pitch % 12) + 12) % 12;
      if (!validPcs.has(notePc)) {
        // Snap to the closest chord tone, ignoring direction.
        let snap = null, bestDist = Infinity;
        for (const d in tones) {
          const pc = tones[d].pc;
          for (let p = EX_LOW; p <= EX_HIGH; p++) {
            if (((p % 12) + 12) % 12 !== pc) continue;
            const dist = Math.abs(p - note.pitch);
            if (dist < bestDist) {
              bestDist = dist;
              snap = { pitch: p, tpc: tones[d].tpc, degree: tones[d].degree };
            }
          }
        }
        if (snap) note = snap;
      }

      results[bi][beat] = { pitch: note.pitch, tpc: note.tpc, duration: 'q' };
      prevPitch = note.pitch;

      // Direction reversal at extremes — within 2 semitones of
      // F1 / F3 we flip so the next landmark moves the other way.
      if (prevPitch >= EX_HIGH - 2) direction = -1;
      if (prevPitch <= EX_LOW + 2) direction = +1;
    }
  }

  // === Pass 2: fill non-landmark beats with passing tones ===
  // Skipped entirely when fillPassingTones is false (Landmarks-1-3
  // variant), in which case beats 2 & 4 remain quarter rests.
  //
  // Rule for each empty beat:
  //   1. Prefer a DIATONIC chord-scale tone strictly between prev/next
  //      (closest to prev so we move by one scale step).
  //   2. If no diatonic step exists (prev & next are a half-step or
  //      same), fall back to CHROMATIC:
  //        ascending  → half-step BELOW next (e.g. F → F# → G);
  //        descending → half-step ABOVE next.
  //      If that chromatic equals prev, flip to the opposite side
  //      (e.g. B → Db → C across the bar line when the half-step below
  //      C would just repeat B).
  //   3. Never repeat prev or next.
  // Everything stays inside F1..F3.
  if (fillPassingTones) {
  function getScalePitchesInRange(ce) {
    const chordScale = exGetScale(chordToCanonical(ce.chord));
    if (!chordScale || chordScale.length === 0) return [];
    const rootPc = ce.root.pitchClass;
    const rootTpc = ce.root.tpc;
    const out = [];
    for (const sd of chordScale) {
      const pc = ((rootPc + sd.s) % 12 + 12) % 12;
      const tpc = rootTpc + sd.t;
      for (let p = EX_LOW; p <= EX_HIGH; p++) {
        if (((p % 12) + 12) % 12 === pc) out.push({ pitch: p, tpc });
      }
    }
    out.sort((a, b) => a.pitch - b.pitch);
    return out;
  }

  function nextScaleToneInDirection(prev, dir, scalePitches) {
    if (dir > 0) {
      for (const sp of scalePitches) if (sp.pitch > prev) return sp;
    } else {
      for (let i = scalePitches.length - 1; i >= 0; i--) {
        if (scalePitches[i].pitch < prev) return scalePitches[i];
      }
    }
    return null;
  }

  // Chromatic spelling — same TPC rules as generateScaleChromaticQuarterNotes
  // so accidentals read consistently across exercises.
  function chromBelow(targetMidi, targetTpc) {
    const altLevel = Math.floor((targetTpc - 6) / 7);
    const tpc = altLevel >= 2 ? targetTpc - 7 : targetTpc + 5;
    return { pitch: targetMidi - 1, tpc };
  }
  function chromAbove(targetMidi, targetTpc) {
    const altLevel = Math.floor((targetTpc - 6) / 7);
    const tpc = altLevel <= 0 ? targetTpc + 7 : targetTpc - 5;
    return { pitch: targetMidi + 1, tpc };
  }
  function inRange(p) { return p >= EX_LOW && p <= EX_HIGH; }

  function pickPassingTone(prev, next, nextTpc, scalePitches) {
    if (prev != null && next != null) {
      if (next > prev) {
        // Ascending: strictly-between diatonic, closest to prev.
        const strict = scalePitches.filter(sp => sp.pitch > prev && sp.pitch < next);
        if (strict.length) return strict[0];
        // Chromatic: leading-tone below next.
        if (nextTpc != null) {
          const below = chromBelow(next, nextTpc);
          if (below.pitch !== prev && inRange(below.pitch)) return below;
          // Opposite — chromatic upper neighbor of next.
          const above = chromAbove(next, nextTpc);
          if (above.pitch !== prev && inRange(above.pitch)) return above;
        }
        return null;
      } else if (next < prev) {
        // Descending: strictly-between diatonic, closest to prev.
        const strict = scalePitches.filter(sp => sp.pitch < prev && sp.pitch > next);
        if (strict.length) return strict[strict.length - 1];
        // Chromatic: leading-tone above next.
        if (nextTpc != null) {
          const above = chromAbove(next, nextTpc);
          if (above.pitch !== prev && inRange(above.pitch)) return above;
          const below = chromBelow(next, nextTpc);
          if (below.pitch !== prev && inRange(below.pitch)) return below;
        }
        return null;
      } else {
        // prev == next — upper diatonic neighbor (then lower).
        const upper = nextScaleToneInDirection(prev, +1, scalePitches);
        if (upper && upper.pitch !== prev) return upper;
        const lower = nextScaleToneInDirection(prev, -1, scalePitches);
        if (lower && lower.pitch !== prev) return lower;
        return null;
      }
    }
    if (prev != null) {
      return nextScaleToneInDirection(prev, +1, scalePitches)
          || nextScaleToneInDirection(prev, -1, scalePitches);
    }
    if (next != null) {
      return nextScaleToneInDirection(next, -1, scalePitches)
          || nextScaleToneInDirection(next, +1, scalePitches);
    }
    if (scalePitches.length) return scalePitches[Math.floor(scalePitches.length / 2)];
    return null;
  }

  function findPrevPitched(bi, beat) {
    for (let b = beat - 1; b >= 0; b--) {
      if (results[bi][b]) return results[bi][b];
    }
    for (let pb = bi - 1; pb >= 0; pb--) {
      for (let b = results[pb].length - 1; b >= 0; b--) {
        if (results[pb][b]) return results[pb][b];
      }
    }
    return null;
  }

  function findNextPitched(bi, beat) {
    for (let b = beat + 1; b < results[bi].length; b++) {
      if (results[bi][b]) return results[bi][b];
    }
    for (let nb = bi + 1; nb < bars.length; nb++) {
      for (let b = 0; b < results[nb].length; b++) {
        if (results[nb][b]) return results[nb][b];
      }
    }
    return null;
  }

  for (let bi = 0; bi < bars.length; bi++) {
    for (let beat = 0; beat < beatsPerBar; beat++) {
      if (results[bi][beat]) continue;
      const ceIdx = chordEventAtBeat[bi + ':' + beat];
      if (ceIdx == null) continue;
      const ce = chordEvents[ceIdx];
      if (!ce) continue;
      const scalePitches = getScalePitchesInRange(ce);
      const prev = findPrevPitched(bi, beat);
      const next = findNextPitched(bi, beat);
      const passing = pickPassingTone(
        prev ? prev.pitch : null,
        next ? next.pitch : null,
        next ? next.tpc : null,
        scalePitches
      );
      if (passing && inRange(passing.pitch)) {
        results[bi][beat] = { pitch: passing.pitch, tpc: passing.tpc, duration: 'q' };
      }
    }
  }
  } // end if (fillPassingTones)

  return { results, chordEvents, patterns, effective };
}

function generateScaleChromaticQuarterNotes(bars, ts) {
  const beatsPerBar = ts.num;
  // Number of scale notes per bar before the chromatic seat. 4/4 → 3,
  // 3/4 → 2. Shorter meters fall back to a normal scale walk since
  // there'd be nowhere to fit the chromatic.
  const scaleNotes = beatsPerBar - 1;
  if (scaleNotes < 1) return generateQuarterNotes(bars, ts);

  const chordEvents = buildChordEventList(bars);
  const patterns = detectKeyPatterns(chordEvents);
  const effective = chordEvents.map((ce, i) => {
    const pat = patterns.find(p => i >= p.firstIdx && i <= p.lastIdx);
    return pickEffectiveScale(ce, pat);
  });

  const results = bars.map(() => new Array(beatsPerBar).fill(null));
  // Direction at the END of each bar's scale walk (after the last
  // scale note is placed). Used by the pass-2 chromatic chooser.
  const barEndDir = new Array(bars.length).fill(1);

  // === Pass 1: scale walk into beats 0..scaleNotes-1 of each bar ===
  // This mirrors generateQuarterNotes' walk verbatim except for two
  // things: chord events that fall entirely on the chromatic-reserved
  // beat (e.g. a chord starting on beat 3 of a 4/4 bar) are skipped so
  // they don't perturb the walk, and the per-chord beat range is
  // capped at `scaleNotes` so the chromatic seat stays empty for
  // pass 2 to fill.
  let direction = -1;
  let tones = [];
  let toneIdx = 0;
  let lastPitch = -1;
  let lastTpc = -1;
  let lastSig = null;

  chordEvents.forEach((ce, i) => {
    const eff = effective[i];
    const { startBeat, endBeat } = chordBeatRange(ce.chordsInBar, ce.chordIdxInBar, beatsPerBar);
    const cap = Math.min(endBeat, scaleNotes);
    if (startBeat >= cap) return; // entirely inside the chromatic seat — skip.

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

    for (let b = startBeat; b < cap; b++) {
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
      // Keep barEndDir in sync with whatever direction is current at
      // each beat write. The last write for a bar wins → this ends
      // up as the direction at the bar's last scale note, which is
      // what pass 2 wants when choosing chromatic above vs. below.
      barEndDir[ce.barIdx] = direction;
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

  // Spelling helpers — mirror the rules used in the Enclosures
  // generators so accidentals read consistently across exercises.
  function chromBelow(targetMidi, targetTpc) {
    // half-step BELOW target, spelled as a leading-tone-up.
    // TPC+5 for naturals & flats (B→A♯, F→E, E♭→D, etc.); TPC−7
    // for sharps (C♯→C, F♯→F).
    const altLevel = Math.floor((targetTpc - 6) / 7);
    const tpc = altLevel >= 2 ? targetTpc - 7 : targetTpc + 5;
    return { pitch: targetMidi - 1, tpc };
  }
  function chromAbove(targetMidi, targetTpc) {
    // half-step ABOVE target, spelled as a leading-tone-down.
    // TPC−5 for naturals & sharps (C→D♭, E→F, B→C, F♯→G); TPC+7
    // for flats (E♭→E, B♭→B).
    const altLevel = Math.floor((targetTpc - 6) / 7);
    const tpc = altLevel <= 0 ? targetTpc + 7 : targetTpc - 5;
    return { pitch: targetMidi + 1, tpc };
  }

  // === Pass 2: place a chromatic on beat `scaleNotes` of every
  // bar except the last (no next bar to lead into → leave as rest). ===
  for (let bi = 0; bi < bars.length - 1; bi++) {
    const cur = results[bi];
    const next = results[bi + 1];
    if (!cur || !next) continue;
    // Find the bar's last placed scale note (within the scale-walk
    // beats only — ignore any future writes to the chromatic seat).
    let lastBeat = -1;
    for (let b = scaleNotes - 1; b >= 0; b--) {
      if (cur[b]) { lastBeat = b; break; }
    }
    if (lastBeat < 0) continue;
    // Find the next bar's first placed note. Will sit at beat 0 in
    // typical scale-walk output, but a bar with a chord starting only
    // on beat 2 (rare for our generators, but possible upstream) will
    // have the first note further in.
    let firstBeatNext = -1;
    for (let b = 0; b < next.length; b++) {
      if (next[b]) { firstBeatNext = b; break; }
    }
    if (firstBeatNext < 0) continue;
    const target = next[firstBeatNext];
    if (typeof target.pitch !== 'number' || typeof target.tpc !== 'number') continue;

    const below = chromBelow(target.pitch, target.tpc);
    const above = chromAbove(target.pitch, target.tpc);

    // Direction-driven default: ascending → below; descending →
    // above. If the default lands on the same pitch class the bar
    // just played (last scale note), flip to the opposite. This is
    // the "if already a half step in that direction, use the
    // opposite" rule the spec describes.
    const prev = cur[lastBeat];
    const prevPc  = (((prev.pitch  % 12) + 12) % 12);
    const belowPc = (((below.pitch % 12) + 12) % 12);
    const abovePc = (((above.pitch % 12) + 12) % 12);
    const dir = barEndDir[bi];
    let chosen;
    if (dir > 0) {
      chosen = (belowPc === prevPc) ? above : below;
    } else {
      chosen = (abovePc === prevPc) ? below : above;
    }
    cur[scaleNotes] = { pitch: chosen.pitch, tpc: chosen.tpc };
  }

  return { results, chordEvents, patterns, effective };
}

// Blank Staff generator: emits NO notes — every bar gets an invisible
// whole rest (or dotted-half rest in 3/4) which keeps the voice's tick
// count valid for VexFlow but paints nothing. The result is a clean
// staff with clef, key signature, time signature, bar lines, and the
// chord symbols above each bar — perfect for printing as practice
// manuscript paper or for hand-writing your own line over the changes.
//
// The "blank" flag is recognized by renderChart (search for `bp.blank`)
// which builds the rest tickable with a transparent style. Beat
// markers and the Notes overlay still respect their own dropdown
// toggles, so a print-ready worksheet is just: pick Blank Staff,
// turn the overlays off, and Print.
function generateBlankExercise(bars, ts) {
  const beatsPerBar = ts.num;
  const chordEvents = buildChordEventList(bars);
  const patterns = detectKeyPatterns(chordEvents);
  const effective = chordEvents.map((ce, i) => {
    const pat = patterns.find(p => i >= p.firstIdx && i <= p.lastIdx);
    return pickEffectiveScale(ce, pat);
  });

  // Pick a duration that exactly fills the bar so VexFlow doesn't
  // complain about mismatched ticks. 4/4 → whole; 3/4 → dotted half;
  // 2/4 → half; anything else falls back to whole and lets the
  // formatter loosen up via setStrict(false).
  const blankDur = beatsPerBar === 3 ? 'h.'
                 : beatsPerBar === 2 ? 'h'
                 : 'w';
  const results = bars.map(() => {
    const arr = new Array(beatsPerBar).fill(null);
    arr[0] = { blank: true, duration: blankDur };
    return arr;
  });

  return { results, chordEvents, patterns, effective };
}

// Descending generator: at every PAIR of bars (1-2, 3-4, 5-6, ...) the
// line restarts on the highest 1, 3, or 5 of the pair's first chord
// (whichever of the three lands highest in the F1..F3 cello range)
// and then walks down ONE diatonic scale step per beat. Each step's
// scale comes from the chord active at that beat, so the descent
// follows the harmony — e.g. on FMaj7 → D7♭9 the line might go
// F3 E3 D3 C3 | B♭2 A2 G2 F♯2 (F major's E,D,C in bar 1, then
// D7♭9's Phrygian Dominant tones B♭, A, G, F♯ in bar 2).
//
// "Restart on the highest" each pair means odd-numbered pairs jump
// back UP to a new starting tone — there's an audible reset every
// 2 bars. The 8 quarter notes in between (4+4 in 4/4, 3+3 in 3/4)
// are stepwise descending.
function generateDescendingQuarterNotes(bars, ts) {
  const beatsPerBar = ts.num;
  const chordEvents = buildChordEventList(bars);
  const patterns = detectKeyPatterns(chordEvents);
  const effective = chordEvents.map((ce, i) => {
    const pat = patterns.find(p => i >= p.firstIdx && i <= p.lastIdx);
    return pickEffectiveScale(ce, pat);
  });

  const results = bars.map(() => new Array(beatsPerBar).fill(null));

  // Effective scale at a (barIdx, beatIdx). Used by the DESCENT
  // step — for major-key patterns the effective scale is the
  // parent key's Ionian, which has the same pitch set as the
  // chord's own mode but anchors the descent inside the key
  // signature without surprise alterations.
  function effAtBeat(barIdx, beatIdx) {
    for (let i = 0; i < chordEvents.length; i++) {
      const ce = chordEvents[i];
      if (ce.barIdx !== barIdx) continue;
      const r = chordBeatRange(ce.chordsInBar, ce.chordIdxInBar, beatsPerBar);
      if (beatIdx >= r.startBeat && beatIdx < r.endBeat) return effective[i];
    }
    return null;
  }
  // Chord event at (barIdx, beatIdx). Used to read the chord's OWN
  // root and scale for the start-tone pick — "1, 3, or 5 of the
  // chord" must mean the chord's own 1/3/5, NOT the parent key's
  // (e.g. Cm7 inside B♭ major: chord 1/3/5 is C/E♭/G, parent-key
  // 1/3/5 would be B♭/D/F — wrong starting note).
  function chordAtBeat(barIdx, beatIdx) {
    for (let i = 0; i < chordEvents.length; i++) {
      const ce = chordEvents[i];
      if (ce.barIdx !== barIdx) continue;
      const r = chordBeatRange(ce.chordsInBar, ce.chordIdxInBar, beatsPerBar);
      if (beatIdx >= r.startBeat && beatIdx < r.endBeat) return ce;
    }
    return null;
  }

  // Highest pitch among the chord's own 1, 3, and 5 that fits in
  // the cello range. Reads the chord's own scale (via exGetScale)
  // so the result is always rooted at the actual chord root —
  // independent of any major-key pattern grouping that might
  // recolor the descent later.
  function highestRootThirdFifth(ce) {
    if (!ce) return null;
    const scale = exGetScale(chordToCanonical(ce.chord));
    if (!scale || !scale.length) return null;
    const rootPc  = ce.root.pitchClass;
    const rootTpc = ce.root.tpc;
    let best = null;
    for (const di of [0, 2, 4]) {
      if (di >= scale.length) continue;
      const sd = scale[di];
      const pc = (((rootPc + sd.s) % 12) + 12) % 12;
      const tpc = rootTpc + sd.t;
      let highest = -1;
      for (let p = EX_LOW; p <= EX_HIGH; p++) {
        if ((((p % 12) + 12) % 12) === pc) highest = p;
      }
      if (highest >= 0 && (best === null || highest > best.pitch)) {
        best = { pitch: highest, tpc };
      }
    }
    return best;
  }

  // Highest scale tone strictly LOWER than `abovePitch`, in the
  // given scale, within the cello range. Returns null if nothing
  // qualifies (the line has reached the bottom of the range — the
  // remaining beats stay null and render as rests).
  function diatonicBelow(scale, rootPc, rootTpc, abovePitch) {
    let best = null;
    for (let oct = 0; oct <= 7; oct++) {
      for (let i = 0; i < scale.length; i++) {
        const pitch = rootPc + scale[i].s + oct * 12;
        if (pitch < EX_LOW || pitch > EX_HIGH) continue;
        if (pitch >= abovePitch) continue;
        if (best === null || pitch > best.pitch) {
          best = { pitch, tpc: rootTpc + scale[i].t };
        }
      }
    }
    return best;
  }

  for (let pairStart = 0; pairStart < bars.length; pairStart += 2) {
    const pairEnd = Math.min(pairStart + 2, bars.length);
    // Read the chord event (not the effective scale) so the start
    // tone is "1/3/5 of the chord written above the bar", not 1/3/5
    // of the parent key.
    const startCe = chordAtBeat(pairStart, 0);
    if (!startCe) continue;
    const startTone = highestRootThirdFifth(startCe);
    if (!startTone) continue;

    // First note of the pair: the start tone exactly. Subsequent
    // beats step down one scale degree at a time, picking the
    // scale of whichever chord owns each beat.
    let prevPitch = startTone.pitch;
    let placed = false;
    pair: for (let bi = pairStart; bi < pairEnd; bi++) {
      for (let beat = 0; beat < beatsPerBar; beat++) {
        if (!placed) {
          results[bi][beat] = { pitch: startTone.pitch, tpc: startTone.tpc };
          prevPitch = startTone.pitch;
          placed = true;
          continue;
        }
        const eff = effAtBeat(bi, beat);
        if (!eff) continue;
        const next = diatonicBelow(
          eff.scale, eff.root.pitchClass, eff.root.tpc, prevPitch
        );
        if (!next) {
          // Bottom of the cello range — stop the descent; the
          // remaining beats in this pair stay rests.
          break pair;
        }
        results[bi][beat] = { pitch: next.pitch, tpc: next.tpc };
        prevPitch = next.pitch;
      }
    }
  }

  return { results, chordEvents, patterns, effective };
}

// Render a pickup-bar stave at (x, staffY) with the given total
// width. Carries the bass clef + time signature on row 1, then any
// pickup notes from the head (in Head mode) or just rests (other
// modes). Returns the constructed stave so the caller can position
// downstream bars after it.
//
// Used by renderChart's row-1 layout when currentSong.head.leadInBeats
// > 0. Phase 2 of pickup support: makes the user's MusicXML pickup
// melody actually appear on the chart, while keeping the iRealPro-
// chart `bars[]` indexing untouched (pickup is a phantom prefix
// outside of `bars[]`, so fingerings keyed by bar index don't shift).
function renderPickupStave(context, x, staffY, totalWidth, leadInBeats, ts, isHeadMode, pickupNotes) {
  // VF is defined locally inside renderChart, not globally — pull it
  // from the same Vex.Flow source so this helper is self-contained.
  if (!window.Vex || !window.Vex.Flow) return null;
  const VF = window.Vex.Flow;
  const stave = new VF.Stave(x, staffY, totalWidth, { left_bar: false, right_bar: false });
  stave.addClef('bass', undefined, '8vb');
  stave.addTimeSignature(ts.str);
  stave.setBegBarType(VF.Barline.type.NONE);
  // Double barline (two thin lines) at the boundary with bar 1 —
  // a clean section-divider glyph that demarcates the pickup from
  // the form proper without the heaviness of an end-of-piece
  // (thin + thick) barline.
  stave.setEndBarType(VF.Barline.type.DOUBLE);
  stave.setContext(context).draw();

  // Build a per-step array (24th-note resolution, matching the head
  // generator) covering the pickup span. Notes go in their stepStart
  // slots; empty slots will become rests.
  const pickupSteps = leadInBeats * 6;
  const beatPitches = new Array(pickupSteps).fill(null);
  if (isHeadMode && Array.isArray(pickupNotes)) {
    for (const n of pickupNotes) {
      const slot = Math.round(n.stepStart || 0);
      if (slot < 0 || slot >= pickupSteps) continue;
      // Map durationSteps → standard duration token. Picks the
      // largest token that fits; falls back to 8th for fragments.
      const ds = Math.round(n.durationSteps || 6);
      const dur = ds >= 24 ? 'w'
                : ds >= 18 ? 'h.'
                : ds >= 12 ? 'h'
                : ds >= 9  ? 'q.'
                : ds >= 6  ? 'q'
                : '8';
      beatPitches[slot] = { pitch: n.midi, tpc: n.tpc, duration: dur };
    }
  }

  // Walk the slot array, building VF.StaveNote tickables. Pitched
  // notes use midiTpcToVexKey + an Accidental modifier when needed;
  // empty runs are coalesced into the largest standard rest that fits.
  const DUR_TO_STEPS = { 'w': 24, 'h.': 18, 'h': 12, 'q.': 9, 'q': 6, '8': 3 };
  const ACC_GLYPH = { '-2': 'bb', '-1': 'b', '0': 'n', '1': '#', '2': '##' };
  const restOpts = [
    { dur: 'h', steps: 12 },
    { dur: 'q', steps: 6 },
    { dur: '8', steps: 3 }
  ];
  const notes = [];
  let b = 0;
  while (b < pickupSteps) {
    const bp = beatPitches[b];
    if (bp) {
      const dur = bp.duration || 'q';
      const consume = DUR_TO_STEPS[dur] || 6;
      const { key, level } = midiTpcToVexKey(bp.pitch, bp.tpc);
      const stemDir = bp.pitch >= 38 ? VF.Stem.DOWN : VF.Stem.UP;
      let baseDur = dur;
      let dotCount = 0;
      while (baseDur.endsWith('.')) { dotCount++; baseDur = baseDur.slice(0, -1); }
      const sn = new VF.StaveNote({
        clef: 'bass', keys: [key], duration: baseDur, stem_direction: stemDir
      });
      if (dotCount > 0 && VF.Dot && VF.Dot.buildAndAttach) {
        VF.Dot.buildAndAttach([sn], { all: true });
      }
      if (level !== 0) {
        sn.addModifier(new VF.Accidental(ACC_GLYPH[String(level)]), 0);
      }
      notes.push(sn);
      b += consume;
    } else {
      let run = 0;
      while (b + run < pickupSteps && !beatPitches[b + run]) run++;
      while (run > 0) {
        let chosen = restOpts[restOpts.length - 1];
        for (const opt of restOpts) {
          if (opt.steps <= run) { chosen = opt; break; }
        }
        notes.push(new VF.StaveNote({
          clef: 'bass', keys: ['d/3'], duration: chosen.dur + 'r'
        }));
        b += chosen.steps;
        run -= chosen.steps;
      }
    }
  }

  // Build beams over consecutive 8th notes within a half-bar group,
  // matching the main renderer's grouping (4 eighths in 4/4, 3 eighths
  // in 3/4) so a long pickup reads as one or two clean beams. The
  // pickup is the TAIL of an imaginary preceding bar, so group
  // boundaries line up to that bar's half-bar grid — not to the
  // pickup-local step 0. Concretely: a 3.5-beat pickup in 4/4 starts
  // at beat 0.5 of the imaginary bar (local step 0 = imaginary step
  // 3), so the first group break falls 9 local steps in, producing
  // a 3-then-4 grouping that matches how the rest of the chart
  // would be beamed.
  const pickupBeams = [];
  {
    // group span in 24th-note steps: 4/4 → 12 steps (half-bar / 4
    // eighths), 3/4 → 9 steps (3 eighths). Anything else falls back
    // to a half-bar group based on the time signature's numerator.
    const groupSteps = ts.num === 3 ? 9 : 12;
    // Offset from the imaginary preceding bar's start to the pickup's
    // first step. The pickup occupies the LAST `leadInBeats` of that
    // bar, so the offset is (beatsPerBar - leadInBeats) * 6 steps.
    const barStartOffsetSteps = Math.round((ts.num - leadInBeats) * 6);
    let pending = [];
    let pendingGroup = -1;
    let stepCursor = 0;
    const flush = () => {
      if (pending.length >= 2) pickupBeams.push(new VF.Beam(pending.slice(), true));
      pending = [];
      pendingGroup = -1;
    };
    let i = 0;
    let bb = 0;
    while (bb < pickupSteps) {
      const bp = beatPitches[bb];
      if (bp) {
        const consume = DUR_TO_STEPS[bp.duration] || 6;
        const note = notes[i++];
        if (bp.duration === '8' && note && !(note.isRest && note.isRest())) {
          const absStart = stepCursor + barStartOffsetSteps;
          const groupAtStart = Math.floor(absStart / groupSteps);
          const groupAtEnd   = Math.floor((absStart + consume - 1) / groupSteps);
          if (pending.length > 0 && pendingGroup !== groupAtStart) flush();
          if (pending.length > 0 && groupAtStart !== groupAtEnd) flush();
          pending.push(note);
          pendingGroup = groupAtStart;
        } else {
          flush();
        }
        bb += consume;
        stepCursor += consume;
      } else {
        // Rest run: walk and skip the rest tickables we generated.
        let run = 0;
        while (bb + run < pickupSteps && !beatPitches[bb + run]) run++;
        flush();
        while (run > 0) {
          let chosenSteps = 3;
          if (12 <= run) chosenSteps = 12;
          else if (6 <= run) chosenSteps = 6;
          i++; // skip the rest tickable
          bb += chosenSteps;
          stepCursor += chosenSteps;
          run -= chosenSteps;
        }
      }
    }
    flush();
  }

  // Voice and draw. setStrict(false) tolerates whatever rounding the
  // duration tokens introduced; the formatter packs notes into the
  // stave's note-area (between getNoteStartX and getNoteEndX). Using
  // those VexFlow-reported boundaries — with a small right-margin —
  // keeps notes from crowding the closing double barline.
  const voice = new VF.Voice({
    num_beats: leadInBeats, beat_value: ts.denom, resolution: VF.RESOLUTION
  });
  voice.setStrict(false);
  voice.addTickables(notes);
  const noteStartX = stave.getNoteStartX();
  const noteEndX = stave.getNoteEndX();
  const fmtWidth = Math.max(20, (noteEndX - noteStartX) - 14);
  new VF.Formatter().joinVoices([voice]).format([voice], fmtWidth);
  voice.draw(context, stave);
  pickupBeams.forEach(beam => beam.setContext(context).draw());
  return stave;
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
    return pickEffectiveScale(ce, pat);
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
    // First beat carries the note + duration (score renders one long note,
    // with the renderer's `b += consume` jump skipping the subsequent
    // slots so they never spawn duplicate stavenotes).
    // Subsequent beats repeat the pitch (no duration) so the fingerboard /
    // scale-view stay lit through the sustained section, AND they carry
    // `tieFromPrev: true` so the Lead playback scheduler treats the run
    // as one sustained attack instead of re-striking on every beat. The
    // attack duration on the first slot already covers the full chord
    // span (`'w'` → 4 steps, `'h'` → 2, etc.), so we don't need a
    // chainSteps walk — `tieFromPrev` alone is enough to silence the
    // re-attacks on beats 2-N.
    results[ce.barIdx][startBeat] = { pitch: notePitch, tpc: noteTpc, duration };
    for (let b = startBeat + 1; b < endBeat; b++) {
      results[ce.barIdx][b] = { pitch: notePitch, tpc: noteTpc, tieFromPrev: true };
    }
    lastPitch = notePitch;
  });

  return { results, chordEvents, patterns, effective };
}

// Target Triad generator. One sustained note per chord, always
// either the 1, 3, or 5 of that chord — uses `diatonicIndexInScale`
// so HW Diminished over 7♭9 chords still picks the chord's REAL
// 3 / 5 (e.g. F♯ / A on D7♭9), not the ♭3 / ♯11 passing tones.
//
// Direction: oscillating sawtooth. The line starts at the highest
// 1/3/5 in cello range and DESCENDS — each chord picks the
// CLOSEST 1/3/5 strictly below the previous note. When no chord
// tone fits below (the line has bottomed out), direction flips to
// ASCEND — each subsequent chord picks the closest 1/3/5 strictly
// above. When the ascent runs out, direction flips back, and so on.
// Result: a continuous up-down-up sweep through the chord-tones,
// hitting the floor and ceiling of available range each pass.
function generateTargetTriadQuarterNotes(bars, ts) {
  const beatsPerBar = ts.num;
  const chordEvents = buildChordEventList(bars);
  const patterns = detectKeyPatterns(chordEvents);
  const effective = chordEvents.map((ce, i) => {
    const pat = patterns.find(p => i >= p.firstIdx && i <= p.lastIdx);
    return pickEffectiveScale(ce, pat);
  });

  const results = bars.map(() => new Array(beatsPerBar).fill(null));
  let lastPitch = -1;
  let direction = -1; // -1 = descending, +1 = ascending

  // 1, 3, 5 tones across the cello range for a given chord. Pulls
  // from the CHORD'S OWN scale (not the parent-key effective scale)
  // so a Cm7 inside B♭ major still arpeggiates C-E♭-G, never B♭-D-F.
  function build135Tones(ce) {
    const chordScale = exGetScale(chordToCanonical(ce.chord));
    if (!chordScale || !chordScale.length) return [];
    const rootPc = ce.root.pitchClass;
    const rootTpc = ce.root.tpc;
    const tones = [];
    for (const d of [0, 2, 4]) {
      const idx = diatonicIndexInScale(d, chordScale);
      if (idx >= chordScale.length) continue;
      const sd = chordScale[idx];
      const pc = ((rootPc + sd.s) % 12 + 12) % 12;
      const tpc = rootTpc + sd.t;
      for (let p = EX_LOW; p <= EX_HIGH; p++) {
        if ((((p % 12) + 12) % 12) === pc) tones.push({ pitch: p, tpc });
      }
    }
    tones.sort((a, b) => a.pitch - b.pitch);
    return tones;
  }

  // Closest tone strictly in `dir` direction (-1 below / +1 above)
  // from `fromPitch`. Returns null when no tone qualifies — caller
  // uses that as the cue to flip direction.
  function pickClosestInDirection(tones, fromPitch, dir) {
    let best = null;
    let bestDist = Infinity;
    for (const t of tones) {
      if (dir < 0 && t.pitch >= fromPitch) continue;
      if (dir > 0 && t.pitch <= fromPitch) continue;
      const dist = Math.abs(t.pitch - fromPitch);
      if (dist < bestDist) { bestDist = dist; best = t; }
    }
    return best;
  }

  chordEvents.forEach((ce, i) => {
    const tones = build135Tones(ce);
    if (tones.length === 0) return;

    let notePitch, noteTpc;
    if (lastPitch < 0) {
      // First chord: start at the HIGHEST 1/3/5 in range so the
      // first sweep is a descent.
      const top = tones[tones.length - 1];
      notePitch = top.pitch;
      noteTpc = top.tpc;
      direction = -1;
    } else {
      // Try the current direction; flip if we've hit a wall (no
      // chord tone left in that direction). Edge case where flipping
      // also yields nothing (rare — chord tones all on lastPitch's
      // pc): fall back to absolute closest.
      let best = pickClosestInDirection(tones, lastPitch, direction);
      if (!best) {
        direction = -direction;
        best = pickClosestInDirection(tones, lastPitch, direction);
      }
      if (!best) {
        const idx = findClosestIndex(tones, lastPitch);
        best = tones[idx];
      }
      notePitch = best.pitch;
      noteTpc = best.tpc;
    }

    const { startBeat, endBeat } = chordBeatRange(ce.chordsInBar, ce.chordIdxInBar, beatsPerBar);
    const beatCount = endBeat - startBeat;
    const duration = beatCount >= 4 ? 'w'
                   : beatCount === 3 ? 'h.'
                   : beatCount === 2 ? 'h'
                   : 'q';
    results[ce.barIdx][startBeat] = { pitch: notePitch, tpc: noteTpc, duration };
    for (let b = startBeat + 1; b < endBeat; b++) {
      results[ce.barIdx][b] = { pitch: notePitch, tpc: noteTpc, tieFromPrev: true };
    }
    lastPitch = notePitch;
  });

  return { results, chordEvents, patterns, effective };
}

// Walking Bassline generator: like Target Triad — each chord opens
// on a 1/3/5 chord-tone "target" placed on its first beat, with the
// next chord's target chosen to be the closest 1/3/5 to the previous
// in a continuing direction. Differs in that EVERY beat is a quarter
// note: the slots between two targets are filled with diatonic
// walking notes that lead the line from the current target to the
// next.
//
// Walking-line rules (per chord transition):
//   - direction = sign(next.pitch − current.pitch); ascending or
//     descending. Equal targets default to descending.
//   - walkBeats = how many beats sit between targets (e.g. 3 in a
//     4/4 bar with one chord). The last walking note is always a
//     half-step "leading tone" placed one semitone before the next
//     target in the direction of motion (F♯ before G ascending,
//     F before E descending).
//   - The OTHER walking notes are scale tones strictly between
//     current and next, walked stepwise toward the target.
//   - When the diatonic gap is too small to fill `walkBeats` notes
//     (e.g. F → G with 3 walking slots — no scale tone in between),
//     the line uses a diatonic-enclosure pattern: scale-step OPPOSITE
//     to the walk direction, then current target, then the chromatic
//     leading tone. So F → G fills as "F | E F F♯ | G" — descend a
//     scale step (E), back to F, half-step lead (F♯), G.
function generateWalkingBasslineQuarterNotes(bars, ts) {
  const beatsPerBar = ts.num;
  const chordEvents = buildChordEventList(bars);
  const patterns = detectKeyPatterns(chordEvents);
  const effective = chordEvents.map((ce, i) => {
    const pat = patterns.find(p => i >= p.firstIdx && i <= p.lastIdx);
    return pickEffectiveScale(ce, pat);
  });

  const results = bars.map(() => new Array(beatsPerBar).fill(null));

  // Same 1/3/5 picker the Target Triad exercise uses, kept verbatim
  // so the two exercises agree on which "target" each chord lands on.
  function build135Tones(ce) {
    const chordScale = exGetScale(chordToCanonical(ce.chord));
    if (!chordScale || !chordScale.length) return [];
    const rootPc = ce.root.pitchClass;
    const rootTpc = ce.root.tpc;
    const tones = [];
    for (const d of [0, 2, 4]) {
      const idx = diatonicIndexInScale(d, chordScale);
      if (idx >= chordScale.length) continue;
      const sd = chordScale[idx];
      const pc = ((rootPc + sd.s) % 12 + 12) % 12;
      const tpc = rootTpc + sd.t;
      for (let p = EX_LOW; p <= EX_HIGH; p++) {
        if ((((p % 12) + 12) % 12) === pc) tones.push({ pitch: p, tpc });
      }
    }
    tones.sort((a, b) => a.pitch - b.pitch);
    return tones;
  }
  function pickClosestInDirection(tones, fromPitch, dir) {
    let best = null;
    let bestDist = Infinity;
    for (const t of tones) {
      if (dir < 0 && t.pitch >= fromPitch) continue;
      if (dir > 0 && t.pitch <= fromPitch) continue;
      const dist = Math.abs(t.pitch - fromPitch);
      if (dist < bestDist) { bestDist = dist; best = t; }
    }
    return best;
  }

  // Phase 1: pick a target 1/3/5 for every chord event in order.
  // Identical to the Target Triad pass.
  const targets = [];
  let lastPitch = -1;
  let direction = -1;
  chordEvents.forEach(ce => {
    const tones = build135Tones(ce);
    if (!tones.length) { targets.push(null); return; }
    let notePitch, noteTpc;
    if (lastPitch < 0) {
      const top = tones[tones.length - 1];
      notePitch = top.pitch; noteTpc = top.tpc;
      direction = -1;
    } else {
      let best = pickClosestInDirection(tones, lastPitch, direction);
      if (!best) { direction = -direction; best = pickClosestInDirection(tones, lastPitch, direction); }
      if (!best) {
        const idx = findClosestIndex(tones, lastPitch);
        best = tones[idx];
      }
      notePitch = best.pitch; noteTpc = best.tpc;
    }
    targets.push({ pitch: notePitch, tpc: noteTpc });
    lastPitch = notePitch;
  });

  // Phase 2: for each chord, place the target on beat 1 and fill the
  // remaining beats with a walking line to the NEXT chord's target.
  chordEvents.forEach((ce, i) => {
    const target = targets[i];
    if (!target) return;
    const nextTarget = targets[i + 1] || null;
    const { startBeat, endBeat } = chordBeatRange(ce.chordsInBar, ce.chordIdxInBar, beatsPerBar);
    const beatCount = endBeat - startBeat;

    // Beat 1: the target — a quarter note (no sustain, every beat is
    // its own quarter note in this exercise).
    results[ce.barIdx][startBeat] = { pitch: target.pitch, tpc: target.tpc, duration: 'q' };

    if (beatCount <= 1) return;

    const walkBeats = beatCount - 1;
    // Last chord (or any chord with no next target) — fill remaining
    // beats by repeating the target so the bar still has quarter
    // notes everywhere instead of trailing rests.
    if (!nextTarget) {
      for (let k = 0; k < walkBeats; k++) {
        results[ce.barIdx][startBeat + 1 + k] = { pitch: target.pitch, tpc: target.tpc, duration: 'q' };
      }
      return;
    }

    // Build the walking line. We pick scale tones from the EFFECTIVE
    // scale (parent-key Ionian when inside a major-key pattern, the
    // chord's own scale otherwise) so the diatonic walk follows
    // whatever scale governs that bar.
    const eff = effective[i];
    const scaleRootPc = eff.root.pitchClass;
    const scaleRootTpc = eff.root.tpc;
    const allScaleTones = buildScaleTones(scaleRootPc, scaleRootTpc, eff.scale);
    if (!allScaleTones.length) {
      // Defensive fallback — repeat target.
      for (let k = 0; k < walkBeats; k++) {
        results[ce.barIdx][startBeat + 1 + k] = { pitch: target.pitch, tpc: target.tpc, duration: 'q' };
      }
      return;
    }

    // Approach-tone selection: alternate between a chromatic and a
    // diatonic lead so the line gets melodic variety instead of a
    // chromatic on every chord change. Both approaches sit on the
    // SAME side of the next target (above for ascending walks,
    // below for descending walks); they just differ in interval.
    //   - chromatic: a half-step from next target (e.g. G♯ → G
    //     ascending, D♭ → D descending). Same-letter + accidental
    //     spelling, normalized to a single-letter form.
    //   - diatonic: the next scale tone past the next target in
    //     the approach direction (e.g. A → G ascending in F Ionian,
    //     C → D descending in F Ionian). Falls back to chromatic
    //     when no in-range scale tone exists on that side.
    // Alternation is index-based so the choice is stable across
    // re-renders rather than drifting on every redraw.
    const overallDir = nextTarget.pitch > target.pitch ? +1
                    : nextTarget.pitch < target.pitch ? -1 : -1;
    const useDiatonicLead = (i % 2 === 1);
    let lead = null;
    if (useDiatonicLead) {
      // First in-range scale tone strictly past nextTarget in the
      // approach direction. Searched on the parent-key effective
      // scale so the note belongs to the bar's harmonic context.
      if (overallDir > 0) {
        for (const t of allScaleTones) {
          if (t.pitch > nextTarget.pitch) { lead = t; break; }
        }
      } else {
        for (let k = allScaleTones.length - 1; k >= 0; k--) {
          if (allScaleTones[k].pitch < nextTarget.pitch) { lead = allScaleTones[k]; break; }
        }
      }
    }
    if (!lead) {
      // Either we asked for chromatic or no diatonic approach tone
      // was reachable (range edge). Use the chromatic half-step.
      const leadTpc = (overallDir > 0)
        ? normalizeEnharmonic(nextTarget.tpc + 7)
        : normalizeEnharmonic(nextTarget.tpc - 7);
      lead = { pitch: nextTarget.pitch + overallDir, tpc: leadTpc };
    }
    const chromaticLead = lead; // name kept for the rest of the routine

    // Walk direction is from target → chromaticLead (= one semi
    // below next). For ascending overall walks where next is only
    // one semi above target, dir2 may even flip sign relative to
    // overallDir — that's fine, the line just descends a step then
    // climbs back via the chromatic lead (matches the user's
    // "F | E F F♯ | G" enclosure example).
    const dir2 = chromaticLead.pitch > target.pitch ? +1
              : chromaticLead.pitch < target.pitch ? -1 : -1;

    // Scale tones strictly between target and chromaticLead, sorted
    // in dir2 (closest to target first). On a long descent like
    // D → B♭ this captures the C/B passing tones; on a short walk
    // like F → G it's empty (no scale tones between F and F♯).
    const between = allScaleTones.filter(t =>
      dir2 > 0 ? (t.pitch > target.pitch && t.pitch < chromaticLead.pitch) :
                 (t.pitch < target.pitch && t.pitch > chromaticLead.pitch));
    between.sort((a, b) => dir2 * (a.pitch - b.pitch));

    const need = walkBeats - 1; // walking notes BEFORE the chromaticLead
    const walking = [];

    if (between.length >= need) {
      // Wide enough gap — linear scale walk + chromaticLead at end.
      // Take the first `need` tones (closest to target) so the walk
      // progresses stepwise from current pitch toward next.
      for (let k = 0; k < need; k++) walking.push(between[k]);
      walking.push(chromaticLead);
    } else {
      // Short gap — pad with enclosure. Use a scale-step neighbor of
      // target in the OPPOSITE direction from dir2 as the filler.
      // When that neighbor lies outside the cello range (target sits
      // at the top/bottom edge), substitute a chromatic neighbor in
      // the same opposite direction so we don't fall back to target
      // itself and emit consecutive duplicate pitches.
      const oppDir2 = -dir2;
      let neighborOpp = null;
      if (oppDir2 > 0) {
        for (const t of allScaleTones) if (t.pitch > target.pitch) { neighborOpp = t; break; }
      } else {
        for (let k = allScaleTones.length - 1; k >= 0; k--) if (allScaleTones[k].pitch < target.pitch) { neighborOpp = allScaleTones[k]; break; }
      }
      if (!neighborOpp) {
        // Range edge — use a chromatic neighbor instead. Falls back
        // to a tone in dir2 (further from edge) if even the chromatic
        // step lies outside the range.
        const chromPitch = target.pitch + oppDir2;
        if (chromPitch >= EX_LOW && chromPitch <= EX_HIGH) {
          neighborOpp = {
            pitch: chromPitch,
            tpc: target.tpc + (oppDir2 > 0 ? 7 : -7)
          };
        } else {
          // Last resort: scale-step in dir2 (away from edge).
          if (dir2 > 0) {
            for (const t of allScaleTones) if (t.pitch > target.pitch) { neighborOpp = t; break; }
          } else {
            for (let k = allScaleTones.length - 1; k >= 0; k--) if (allScaleTones[k].pitch < target.pitch) { neighborOpp = allScaleTones[k]; break; }
          }
          if (!neighborOpp) neighborOpp = target; // truly stuck
        }
      }
      const fillerCount = need - between.length;
      for (let k = 0; k < fillerCount; k++) {
        walking.push(k % 2 === 0 ? neighborOpp : target);
      }
      for (const b of between) walking.push(b);
      walking.push(chromaticLead);
    }

    // Final safety pass: if any consecutive walking notes (or the
    // target → first walking note hand-off) end up on the same
    // pitch, nudge the offender by ±1 semitone to break the
    // duplicate. Direction of nudge follows dir2 so the line keeps
    // moving toward chromaticLead. This catches edge cases where
    // the enclosure fillers and the scale-tone walk happened to
    // line up identically.
    const fullLine = [target, ...walking];
    for (let k = 1; k < fullLine.length; k++) {
      if (fullLine[k].pitch === fullLine[k - 1].pitch) {
        const nudged = fullLine[k].pitch + dir2;
        if (nudged >= EX_LOW && nudged <= EX_HIGH) {
          fullLine[k] = {
            pitch: nudged,
            tpc: fullLine[k].tpc + (dir2 > 0 ? 7 : -7)
          };
        }
      }
    }
    // fullLine[0] is `target` (already placed on beat 1); the rest
    // are the walking notes for beats 2..endBeat.
    const adjustedWalking = fullLine.slice(1);

    for (let k = 0; k < adjustedWalking.length && k < walkBeats; k++) {
      results[ce.barIdx][startBeat + 1 + k] = {
        pitch: adjustedWalking[k].pitch,
        tpc:   adjustedWalking[k].tpc,
        duration: 'q'
      };
    }
  });

  return { results, chordEvents, patterns, effective };
}

// Paul Chambers walking-bassline generator. Models the patterns
// observed in 5 Chambers basslines (A Foggy Day, Bye Bye Blackbird,
// Just Friends, Oleo, On Green Dolphin Street — ~420 bars total).
//
// Layered on top of the simpler Walking Bassline:
//   - Beat 1 of every chord and Beat 3 of every full-bar chord are
//     "anchor" beats that land on a weighted chord-tone (~60% R,
//     ~16% 5th, ~8% 3rd, ~3% 7th, ~13% voice-led scale tone). The
//     beat-3 anchor uses a different distribution (50/30/15/5) and
//     never picks the same pitch as beat 1 of the same bar.
//   - Beat-4 / approach beats (the beat immediately before any
//     chord change) draw from a weighted set: ½-step below next
//     root (25%), ½ above (12%), whole-step below (9%), whole-step
//     above (8%), current-chord 3rd (16%), current-chord 5th (12%),
//     scale-step continuation (18%). Captures Chambers's mix of
//     chromatic leading-tones and "5-relationship" approaches.
//   - Connector beats (between two anchors of the same chord) walk
//     stepwise through the chord's own scale, so altered passing
//     tones (b9, #9, #11) appear over dominants but not over Maj7 /
//     m7 — matching the data.
//
// Determinism: the generator uses a seeded PRNG keyed on the chord
// progression so the same song re-renders identically every time
// (otherwise filter / loop / repeat changes would shuffle the line
// every redraw).
function generatePaulChambersBasslineQuarterNotes(bars, ts) {
  const beatsPerBar = ts.num;
  const chordEvents = buildChordEventList(bars);
  const patterns = detectKeyPatterns(chordEvents);
  const effective = chordEvents.map((ce, i) => {
    const pat = patterns.find(p => i >= p.firstIdx && i <= p.lastIdx);
    return pickEffectiveScale(ce, pat);
  });

  const results = bars.map(() => new Array(beatsPerBar).fill(null));
  if (!chordEvents.length) return { results, chordEvents, patterns, effective };

  // mulberry32 PRNG with a seed derived from the chord progression so
  // the same song always renders the same line. Different songs (or
  // different transpositions) yield different lines.
  function makeRng(seed) {
    let s = seed | 0;
    return function () {
      s = (s + 0x9E3779B9) | 0;
      let t = Math.imul(s ^ (s >>> 16), 0x85EBCA6B);
      t = Math.imul(t ^ (t >>> 13), 0xC2B2AE35);
      return ((t ^ (t >>> 16)) >>> 0) / 4294967296;
    };
  }
  let seed = chordEvents.length;
  for (const ce of chordEvents) {
    seed = (Math.imul(seed * 31 + ce.root.pitchClass + ce.root.tpc * 7 + 1, 0x1000193)) | 0;
  }
  const rng = makeRng(seed);

  // ---- Form detection ----
  // Build a list of phrase boundaries: bar indices where a new
  // section begins. Uses iRealPro's section markers (`bar.section`)
  // when present (e.g. AABA → bars 0, 8, 16, 24 carry an "A"/"B"
  // letter on the first bar of each section). When the chart has
  // no section markers at all, falls back to fixed 8-bar phrasing.
  // The returned array always starts with 0 and ends with the
  // total bar count as a sentinel, so phrase lookups can be done
  // by binary search of consecutive pairs.
  function buildPhraseBoundaries() {
    const boundaries = [0];
    let lastSection = null;
    if (bars[0] && bars[0].section) lastSection = bars[0].section;
    for (let i = 1; i < bars.length; i++) {
      const sect = bars[i] && bars[i].section;
      if (sect && sect !== lastSection) {
        boundaries.push(i);
        lastSection = sect;
      }
    }
    if (boundaries.length <= 1) {
      // No section markers — fall back to 8-bar phrases.
      for (let i = 8; i < bars.length; i += 8) boundaries.push(i);
    }
    boundaries.push(bars.length);
    return boundaries;
  }
  const phraseBounds = buildPhraseBoundaries();

  // For a given bar, return its phrase's start, length, position
  // within the phrase, and whether it's the LAST bar of its phrase.
  function phraseInfo(barIdx) {
    for (let i = 0; i < phraseBounds.length - 1; i++) {
      if (barIdx >= phraseBounds[i] && barIdx < phraseBounds[i + 1]) {
        const phraseStart = phraseBounds[i];
        const phraseLen = phraseBounds[i + 1] - phraseStart;
        const posInPhrase = barIdx - phraseStart;
        return {
          phraseStart, phraseLen, posInPhrase,
          isFirst: posInPhrase === 0,
          isLast: posInPhrase === phraseLen - 1
        };
      }
    }
    return { phraseStart: 0, phraseLen: bars.length, posInPhrase: barIdx, isFirst: false, isLast: false };
  }

  // Phrase register arc: target anchor MIDI for each bar position.
  // Climbs from a low starting register through the phrase, peaks
  // around 70% of the way through, then resolves slightly down at
  // the end — mirroring Chambers's typical 8-bar shape.
  // Falls back to a wider arc for shorter phrases (12-bar blues etc.).
  function arcAnchorPitch(barIdx) {
    const { posInPhrase, phraseLen } = phraseInfo(barIdx);
    if (phraseLen <= 1) return 41;
    const t = posInPhrase / (phraseLen - 1);
    const low = 36;   // C2 — typical bottom of a Chambers phrase
    const peak = 50;  // D3 — typical phrase apex
    const peakAt = 0.65; // bias the peak past the middle
    let arc;
    if (t < peakAt) arc = low + (peak - low) * (t / peakAt);
    else            arc = peak - (peak - low) * 0.4 * ((t - peakAt) / (1 - peakAt));
    return Math.round(arc);
  }

  // Diatonic chord-tone (R/3/5/7) of the chord, in cello range,
  // closest to anchorPitch. degIdx 0=R, 2=3, 4=5, 6=7.
  function chordTonePitch(ce, degIdx, anchorPitch) {
    const chordScale = exGetScale(chordToCanonical(ce.chord));
    if (!chordScale || !chordScale.length) return null;
    const realIdx = diatonicIndexInScale(degIdx, chordScale);
    if (realIdx >= chordScale.length) return null;
    const sd = chordScale[realIdx];
    const pc = ((ce.root.pitchClass + sd.s) % 12 + 12) % 12;
    const tpc = ce.root.tpc + sd.t;
    let best = null, bestDist = Infinity;
    for (let p = EX_LOW; p <= EX_HIGH; p++) {
      if ((((p % 12) + 12) % 12) === pc) {
        const d = Math.abs(p - anchorPitch);
        if (d < bestDist) { bestDist = d; best = p; }
      }
    }
    return best == null ? null : { pitch: best, tpc };
  }

  // Pick a scale tone in the given direction past `fromPitch`.
  function nextScaleToneFrom(fromPitch, dir, scaleTones) {
    if (dir > 0) {
      for (const t of scaleTones) if (t.pitch > fromPitch) return t;
    } else {
      for (let k = scaleTones.length - 1; k >= 0; k--) if (scaleTones[k].pitch < fromPitch) return scaleTones[k];
    }
    return null;
  }

  // Beat-1 anchor. Weighted by Chambers's corpus distribution
  // (60/16/8/3 R/5/3/7), with a ~14% voice-led branch for non-
  // chord-tone landings AND a fallback that converts any picked
  // chord-tone more than 5 semis away from the previous note into
  // the nearest scale-tone instead. The fallback is what catches
  // the BBB-style "PC plays a non-chord-tone scale step rather
  // than leap to the chord-tone" cases — without it, when the
  // dice say "pick R" and the chord's nearest R is 7 semis away,
  // we'd take the leap and the bar boundary would feel disjointed.
  //
  // Anchor reference: 90/10 prev/arc blend. The arc still nudges
  // long-range register trajectory, but voice-leading dominates
  // every individual bar boundary — matching BBB where 88% of
  // bar-to-bar intervals are ≤ a M3.
  function pickAnchorBeat1(ce, prevPitch, eff) {
    const arcRef = arcAnchorPitch(ce.barIdx);
    const anchorRef = prevPitch != null
      ? Math.round(prevPitch * 0.9 + arcRef * 0.1)
      : arcRef;
    const r = rng();
    if (r < 0.14 && prevPitch != null) {
      const tones = buildScaleTones(eff.root.pitchClass, eff.root.tpc, eff.scale);
      let best = null, bestDist = Infinity;
      for (const t of tones) {
        const d = Math.abs(t.pitch - anchorRef);
        if (d < bestDist) { bestDist = d; best = t; }
      }
      if (best) return best;
    }
    let degIdx;
    if      (r < 0.74) degIdx = 0; // R   ~60%
    else if (r < 0.90) degIdx = 4; // 5   ~16%
    else if (r < 0.98) degIdx = 2; // 3    ~8%
    else                degIdx = 6; // 7    ~3% (remaining ~14% goes to voice-led above)
    const tone = chordTonePitch(ce, degIdx, anchorRef);
    // Voice-leading override: if the picked chord-tone leaps more
    // than 5 semis from the previous note, prefer the nearest
    // scale tone instead. Replicates Chambers's bias against bar-
    // boundary leaps even when the picked degree is far away.
    if (tone && prevPitch != null && Math.abs(tone.pitch - prevPitch) > 5) {
      const scaleTones = buildScaleTones(eff.root.pitchClass, eff.root.tpc, eff.scale);
      let bestSt = null, bestDist = Infinity;
      for (const t of scaleTones) {
        const d = Math.abs(t.pitch - prevPitch);
        if (d < bestDist) { bestDist = d; bestSt = t; }
      }
      if (bestSt && bestDist < Math.abs(tone.pitch - prevPitch)) return bestSt;
    }
    return tone || chordTonePitch(ce, 0, anchorRef);
  }

  // Beat-3 secondary anchor (only fires for full-bar single-chord
  // bars). Heavier on root than beat 1 in the corpus would suggest,
  // but the analysis showed beat 3 mirrors beat 1's distribution
  // weakly (R 21% / 5 13% / 3 12%); we use 50/30/15/5 here so it
  // tilts more toward complementary chord-tone than beat 1 to keep
  // the line moving.
  function pickAnchorBeat3(ce, beat1Pitch) {
    const r = rng();
    let degIdx;
    if      (r < 0.50) degIdx = 4; // 5    50% (complement of root-on-1)
    else if (r < 0.80) degIdx = 0; // R    30%
    else if (r < 0.95) degIdx = 2; // 3    15%
    else                degIdx = 6; // 7     5%
    let pick = chordTonePitch(ce, degIdx, beat1Pitch) || chordTonePitch(ce, 0, beat1Pitch);
    if (pick && pick.pitch === beat1Pitch) {
      // Avoid a duplicate chord-tone landing — try another degree
      // closest to beat1 but not equal.
      for (const altDeg of [0, 4, 2, 6]) {
        if (altDeg === degIdx) continue;
        const alt = chordTonePitch(ce, altDeg, beat1Pitch);
        if (alt && alt.pitch !== beat1Pitch) { pick = alt; break; }
      }
    }
    return pick;
  }

  // Approach picker — used on the LAST beat before a chord change.
  // Weights tightened to match Bye Bye Blackbird's beat-4 → next-
  // root profile: ~80% of his beat-4 notes sit within ±2 semis of
  // the next root. Distribution:
  //   ½-below 35, ½-above 25, whole-below 12, whole-above 10
  //   (= 82% step-or-half-step approach)
  //   current-3rd 8, current-5th 6, continuation 4 (= 18% larger).
  function pickApproach(currentCe, nextTarget, prevPitch, eff) {
    const tones = buildScaleTones(eff.root.pitchClass, eff.root.tpc, eff.scale);
    const r = rng();
    let pick = null;
    if (r < 0.35) {
      // ½-step BELOW next root.
      pick = {
        pitch: nextTarget.pitch - 1,
        tpc: normalizeEnharmonic(nextTarget.tpc - 7)
      };
    } else if (r < 0.60) {
      // ½-step ABOVE next root.
      pick = {
        pitch: nextTarget.pitch + 1,
        tpc: normalizeEnharmonic(nextTarget.tpc + 7)
      };
    } else if (r < 0.72) {
      // Whole-step (scale tone) BELOW next root.
      pick = nextScaleToneFrom(nextTarget.pitch, -1, tones);
    } else if (r < 0.82) {
      // Whole-step ABOVE next root.
      pick = nextScaleToneFrom(nextTarget.pitch, +1, tones);
    } else if (r < 0.90) {
      // Current chord's 3rd — Chambers occasionally "approaches"
      // the next chord by hanging on the current chord's color
      // tone, letting harmonic root motion handle the leap.
      pick = chordTonePitch(currentCe, 2, prevPitch);
    } else if (r < 0.96) {
      // Current chord's 5th.
      pick = chordTonePitch(currentCe, 4, prevPitch);
    } else {
      // Continuation: scale step from prevPitch toward nextTarget.
      const dir = nextTarget.pitch > prevPitch ? +1 : -1;
      pick = nextScaleToneFrom(prevPitch, dir, tones);
    }
    if (!pick) {
      // Defensive fallback: chromatic below.
      pick = {
        pitch: nextTarget.pitch - 1,
        tpc: normalizeEnharmonic(nextTarget.tpc - 7)
      };
    }
    // Range-clamp.
    if (pick.pitch < EX_LOW) pick = { pitch: pick.pitch + 12, tpc: pick.tpc };
    if (pick.pitch > EX_HIGH) pick = { pitch: pick.pitch - 12, tpc: pick.tpc };
    return pick;
  }

  // Phase 1: pick anchor pitches for every chord event (beat-1)
  // plus secondary beat-3 anchor for full-bar chords.
  const anchors = []; // [{ce, eventIdx, barIdx, beat, pitch, tpc}]
  let voicePrev = null;
  chordEvents.forEach((ce, i) => {
    const { startBeat, endBeat } = chordBeatRange(ce.chordsInBar, ce.chordIdxInBar, beatsPerBar);
    const t1 = pickAnchorBeat1(ce, voicePrev, effective[i]);
    if (!t1) return;
    anchors.push({ ce, eventIdx: i, barIdx: ce.barIdx, beat: startBeat, pitch: t1.pitch, tpc: t1.tpc });
    voicePrev = t1.pitch;
    if (startBeat === 0 && endBeat >= beatsPerBar && beatsPerBar >= 4) {
      const t3 = pickAnchorBeat3(ce, t1.pitch);
      if (t3) {
        anchors.push({ ce, eventIdx: i, barIdx: ce.barIdx, beat: 2, pitch: t3.pitch, tpc: t3.tpc });
        voicePrev = t3.pitch;
      }
    }
  });

  // Place anchor beats.
  for (const a of anchors) {
    if (!results[a.barIdx][a.beat]) {
      results[a.barIdx][a.beat] = { pitch: a.pitch, tpc: a.tpc, duration: 'q' };
    }
  }

  // Phase 2: fill connector / approach beats between anchors.
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i];
    const next = anchors[i + 1] || null;
    const aRange = chordBeatRange(a.ce.chordsInBar, a.ce.chordIdxInBar, beatsPerBar);

    // Collect beats to fill between this anchor and the next.
    const slots = [];
    if (next && a.barIdx === next.barIdx) {
      for (let b = a.beat + 1; b < next.beat; b++) slots.push({ barIdx: a.barIdx, beat: b });
    } else if (next) {
      for (let b = a.beat + 1; b < aRange.endBeat; b++) slots.push({ barIdx: a.barIdx, beat: b });
      for (let bi = a.barIdx + 1; bi < next.barIdx; bi++) {
        for (let b = 0; b < beatsPerBar; b++) slots.push({ barIdx: bi, beat: b });
      }
      for (let b = 0; b < next.beat; b++) slots.push({ barIdx: next.barIdx, beat: b });
    } else {
      // Final anchor: pad the rest of its chord with stepwise descent.
      for (let b = a.beat + 1; b < aRange.endBeat; b++) slots.push({ barIdx: a.barIdx, beat: b });
    }
    if (!slots.length) continue;

    const eff = effective[a.eventIdx];
    const tones = buildScaleTones(eff.root.pitchClass, eff.root.tpc, eff.scale);
    const sameChord = !!(next && next.ce === a.ce);

    let prevP = a.pitch;
    let prevT = a.tpc;
    for (let k = 0; k < slots.length; k++) {
      const slot = slots[k];
      const isLast = (k === slots.length - 1);
      let pick;
      if (isLast && next && !sameChord) {
        pick = pickApproach(a.ce, next, prevP, eff);
      } else if (isLast && next && sameChord) {
        // Walking into a beat-3 secondary anchor of the same chord.
        // The anchor pitch is fixed; we just need a smooth scale step
        // from prevP. The anchor itself is already placed.
        // This connector beat should be one scale step closer to next.
        const dir = next.pitch > prevP ? +1 : -1;
        pick = nextScaleToneFrom(prevP, dir, tones) || { pitch: prevP, tpc: prevT };
      } else if (next) {
        // General connector: scale-step toward next anchor's pitch.
        const dir = next.pitch > prevP ? +1 : -1;
        pick = nextScaleToneFrom(prevP, dir, tones) || { pitch: prevP, tpc: prevT };
      } else {
        // No next anchor (final fill): step downward toward chord-tone.
        pick = nextScaleToneFrom(prevP, -1, tones) || { pitch: prevP, tpc: prevT };
      }
      // De-dup: if the pick equals prev (rare), skip a step further.
      if (pick.pitch === prevP) {
        const dir = next && next.pitch >= prevP ? +1 : -1;
        const further = nextScaleToneFrom(prevP + dir, dir, tones);
        if (further) pick = further;
      }
      if (!results[slot.barIdx][slot.beat]) {
        results[slot.barIdx][slot.beat] = { pitch: pick.pitch, tpc: pick.tpc, duration: 'q' };
      }
      prevP = pick.pitch;
      prevT = pick.tpc;
    }
  }

  // Top per-bar scale-degree shapes from the Paul Chambers corpus,
  // sorted by frequency. Each entry is a 4-tuple of degree strings
  // for beats 1–4. Top-5 per quality combined cover ~40% of major
  // and minor full-bar instances, ~19% of dominant. The templates
  // are applied as a "remix" pass that occasionally substitutes a
  // known Chambers shape for the default per-beat picker output.
  const PC_BAR_SHAPES = {
    major: [
      ['1', '7', '13', 'b13'],   // 14 — half-step descent (R 7 6 b6)
      ['1', '3', '11', '#11'],   //  8 — ascending chromatic to 5
      ['1', '5', '3', '11'],     //  4
      ['5', 'b13', '13', '7'],   //  4
      ['1', '9', '3', '11'],     //  3
      ['5', '3', '11', '#11'],   //  3
      ['1', '7', '13', '7'],     //  2
      ['1', '9', '3', '5']       //  2
    ],
    minor: [
      ['1', '9', 'b3', '3'],     // 14 — Chambers's classic m7 ascent (R 2 b3 3 → next root)
      ['1', 'b7', '5', '1'],     //  6 — descending chord-tone outline
      ['13', 'b7', '13', '11'],  //  5
      ['1', '9', 'b3', '11'],    //  5
      ['5', '11', 'b3', '9'],    //  3
      ['1', '9', 'b3', '5'],     //  3
      ['5', '1', '1', 'b7'],     //  3
      ['1', 'b9', '1', 'b7']     //  2
    ],
    dominant: [
      ['1', 'b7', '13', '5'],    //  6 — descending walk
      ['1', '9', '#9', '3'],     //  5 — altered ascent (overlaps with sig #4)
      ['5', '11', '3', '5'],     //  3
      ['1', '5', '9', 'b9'],     //  3
      ['b7', '5', '3', '5'],     //  3
      ['1', 'b9', '9', '3'],     //  2
      ['3', 'b7', '1', '3'],     //  2
      ['1', '3', '9', '5']       //  2
    ],
    halfdim: [] // no full-bar single-chord halfdim instances in PC corpus
  };
  // TPC offsets from chord root for each degree string, chosen to
  // match Chambers's typical spelling preferences (e.g. #9 spelled
  // as same-letter-flat / b3 enharmonic in his charts, not D## /
  // letter-up-+sharp). semi() and tpcDelta() share these.
  const DEGREE_TO_SEMI = {
    '1':0, 'b9':1, '9':2, 'b3':3, '#9':3, '3':4, '11':5,
    'b5':6, '#11':6, '5':7, 'b13':8, '13':9, 'b7':10, '7':11
  };
  const DEGREE_TO_TPC_OFFSET = {
    '1': 0,  'b9':-5, '9': 2, 'b3':-3, '#9':-3,
    '3': 4,  '11':-1, 'b5':-6,'#11':6, '5': 1,
    'b13':-4,'13': 3, 'b7':-2,'7':  5
  };
  // Map getChordType output to PC_BAR_SHAPES keys. 'other' chords
  // (augmented, diminished7, sus, etc.) skip the template lookup —
  // we don't have corpus data for them.
  function templateKeyForType(t) {
    if (t === 'major') return 'major';
    if (t === 'minor') return 'minor';
    if (t === 'dominant') return 'dominant';
    if (t === 'halfdim') return 'halfdim';
    return null;
  }
  // Apply a 4-tuple shape across the 4 beats of a chord that owns
  // a full bar. Each beat's pitch is the closest in-range MIDI
  // matching the degree's pitch class to a running anchor (carries
  // forward from beat to beat for smooth voice-leading). The first
  // beat's anchor uses the phrase-arc target so the template still
  // rides the section's register trajectory.
  function applyTemplate(ce, shape) {
    if (!shape || shape.length !== beatsPerBar) return false;
    const rootPc = ce.root.pitchClass;
    const rootTpc = ce.root.tpc;
    // Anchor strictly to the previous bar's last note. The phrase
    // arc only matters when there is no prior bar (= start of song)
    // — otherwise voice-leading wins, because templates that "reset"
    // the register based on the arc cause the line to jump every
    // time a template fires. Tight prev-pitch anchoring keeps the
    // template's contour locked into the surrounding line.
    const prevLast = prevBarLastNote(ce.barIdx);
    let prev = prevLast ? prevLast.pitch : arcAnchorPitch(ce.barIdx);
    for (let b = 0; b < shape.length; b++) {
      const deg = shape[b];
      const semi = DEGREE_TO_SEMI[deg];
      const tOff = DEGREE_TO_TPC_OFFSET[deg];
      if (semi == null) continue;
      const pc = ((rootPc + semi) % 12 + 12) % 12;
      const tpc = normalizeEnharmonic(rootTpc + (tOff || 0));
      let best = null, bestDist = Infinity;
      for (let p = EX_LOW; p <= EX_HIGH; p++) {
        if ((((p % 12) + 12) % 12) === pc) {
          const d = Math.abs(p - prev);
          if (d < bestDist) { bestDist = d; best = p; }
        }
      }
      if (best == null) continue;
      results[ce.barIdx][b] = { pitch: best, tpc, duration: 'q' };
      prev = best;
    }
    return true;
  }
  // Weighted pick from a shapes list (top-5 only — beyond that the
  // long tail thins to single occurrences and adds noise). Weight =
  // shape index → frequency proxy: shape[0] gets highest weight,
  // shape[4] gets lowest.
  function pickTemplateShape(shapes) {
    if (!shapes || !shapes.length) return null;
    const top = shapes.slice(0, 5);
    const weights = [5, 4, 3, 2, 1].slice(0, top.length);
    const total = weights.reduce((s, w) => s + w, 0);
    let r = rng() * total;
    for (let i = 0; i < top.length; i++) {
      r -= weights[i];
      if (r <= 0) return top[i];
    }
    return top[0];
  }

  // Phase 3: Chambers signature overrides.
  //
  // Four characteristic gestures from the corpus, each triggered with
  // low probability so they're occasional flavor rather than constant.
  // Higher-priority signatures apply first; once a chord event fires
  // a signature, lower-priority ones are skipped for that bar so
  // overrides don't stack incoherently.
  //
  //   #4  Altered ascent (R b9 #9 3) over a dominant7 going P4-up
  //       — Autumn Leaves bar 6 D7→Gm signature.
  //   #3  Descending 5-3-9-R archetype over a full-bar Maj7
  //       — Just Friends bar 1 signature.
  //   #2  Diatonic enclosure of next chord's root on the prior bar's
  //       last two beats — universal jazz "approach pattern".
  //   #1  Chromatic-above next root (= #11 of the V) on V→I major
  //       resolutions — Foggy Day's "5th drops a 5th with #11 colour"
  //       move. Implemented as a beat-4 override that REPLACES whatever
  //       the approach picker chose with the chromatic-above tone.
  //
  // Helper: place a specific {pc, tpc} at (barIdx, beat) in the
  // cello range, picking the pitch nearest to anchorPitch. Returns
  // the placed pitch (or null if no in-range option). Always
  // overwrites whatever's already there — signatures are designed
  // to win over the default fill.
  function placePc(barIdx, beat, pc, tpc, anchorPitch) {
    let best = null, bestDist = Infinity;
    for (let p = EX_LOW; p <= EX_HIGH; p++) {
      if ((((p % 12) + 12) % 12) === pc) {
        const d = Math.abs(p - anchorPitch);
        if (d < bestDist) { bestDist = d; best = p; }
      }
    }
    if (best != null) {
      results[barIdx][beat] = { pitch: best, tpc, duration: 'q' };
    }
    return best;
  }

  // Helper: find the previous bar's last note (or null) for
  // voice-leading anchor choices when a signature/template starts
  // a new bar. Without this anchor, signatures reset the register
  // independently of the line that came before, producing
  // 7-12 semitone jumps at every signature trigger.
  function prevBarLastNote(barIdx) {
    if (barIdx <= 0) return null;
    const prev = results[barIdx - 1];
    if (!prev) return null;
    for (let b = beatsPerBar - 1; b >= 0; b--) {
      if (prev[b] && prev[b].pitch != null) return prev[b];
    }
    return null;
  }

  // 5-3-9-R descending: takes a full-bar Maj7 chord and writes G E D C
  // (over CMaj7) starting from a 5th close to the previous bar's
  // last note so the descent voice-leads from the prior line. The
  // descent needs ~7 semitones of headroom below the start, so when
  // the voice-led 5th would clip the cello range bottom we bump up
  // an octave (or skip the signature when neither octave fits).
  function applyMaj7Archetype(ce) {
    const chordScale = exGetScale(chordToCanonical(ce.chord));
    if (!chordScale || chordScale.length < 5) return;
    const get = (deg) => {
      const idx = diatonicIndexInScale(deg, chordScale);
      const sd = chordScale[idx % chordScale.length];
      return {
        pc: ((ce.root.pitchClass + sd.s) % 12 + 12) % 12,
        tpc: ce.root.tpc + sd.t
      };
    };
    const five  = get(4);
    const three = get(2);
    const nine  = get(1);
    const root  = get(0);
    // Voice-leading anchor: the previous bar's last note. Falls back
    // to the phrase-arc target on the very first bar.
    const prevLast = prevBarLastNote(ce.barIdx);
    const anchorPitch = prevLast ? prevLast.pitch : arcAnchorPitch(ce.barIdx);
    // Find the in-range 5th closest to anchorPitch that ALSO has
    // enough headroom below for the 4-note descent (≈ 7 semitones).
    const HEADROOM = 7;
    const candidates = [];
    for (let p = EX_LOW + HEADROOM; p <= EX_HIGH; p++) {
      if ((((p % 12) + 12) % 12) === five.pc) candidates.push(p);
    }
    if (!candidates.length) return;
    candidates.sort((a, b) => Math.abs(a - anchorPitch) - Math.abs(b - anchorPitch));
    const fivePitch = candidates[0];
    results[ce.barIdx][0] = { pitch: fivePitch, tpc: five.tpc, duration: 'q' };
    let prev = fivePitch;
    // Each subsequent note is the next descending pc <= prev.
    const placeBelow = (beat, target) => {
      let best = null;
      for (let p = prev - 1; p >= EX_LOW; p--) {
        if ((((p % 12) + 12) % 12) === target.pc) { best = p; break; }
      }
      if (best != null) {
        results[ce.barIdx][beat] = { pitch: best, tpc: target.tpc, duration: 'q' };
        prev = best;
      }
    };
    placeBelow(1, three);
    placeBelow(2, nine);
    placeBelow(3, root);
  }

  // R b9 #9 3 ascending altered scale over a dominant7 chord going
  // P4 up. e.g. D7 → Gm: D Eb F F♯ resolving to G by half-step.
  // Picks the root pitch closest to the previous bar's last note
  // (with 4 semitones of headroom above for the ascent) so the
  // gesture voice-leads from the prior line instead of jumping.
  function applyAlteredAscent(ce) {
    const r_pc = ce.root.pitchClass;
    const r_tpc = ce.root.tpc;
    const ninth_tpc = r_tpc + 2;
    const root   = { pc: r_pc, tpc: r_tpc };
    const b9     = { pc: (r_pc + 1) % 12, tpc: normalizeEnharmonic(ninth_tpc - 7) };
    const sharp9 = { pc: (r_pc + 3) % 12, tpc: normalizeEnharmonic(ninth_tpc + 7) };
    const third  = { pc: (r_pc + 4) % 12, tpc: r_tpc + 4 };
    const prevLast = prevBarLastNote(ce.barIdx);
    const anchorPitch = prevLast ? prevLast.pitch : arcAnchorPitch(ce.barIdx);
    // In-range root pitches that ALSO have 4 semis of headroom above
    // for the ascent (root → b9 → #9 → 3 = +4 semis total).
    const candidates = [];
    for (let p = EX_LOW; p <= EX_HIGH - 4; p++) {
      if ((((p % 12) + 12) % 12) === r_pc) candidates.push(p);
    }
    if (!candidates.length) return;
    candidates.sort((a, b) => Math.abs(a - anchorPitch) - Math.abs(b - anchorPitch));
    const rootPitch = candidates[0];
    results[ce.barIdx][0] = { pitch: rootPitch,     tpc: root.tpc,   duration: 'q' };
    results[ce.barIdx][1] = { pitch: rootPitch + 1, tpc: b9.tpc,     duration: 'q' };
    results[ce.barIdx][2] = { pitch: rootPitch + 3, tpc: sharp9.tpc, duration: 'q' };
    results[ce.barIdx][3] = { pitch: rootPitch + 4, tpc: third.tpc,  duration: 'q' };
  }

  // Diatonic enclosure of next chord's root: writes one scale tone
  // ABOVE next root and one BELOW on prior bar's last two beats. The
  // approach lands diatonically on next's beat 1.
  function applyEnclosure(ce, nextCe, nextEff) {
    const nextRootPitch = results[nextCe.barIdx][0]?.pitch;
    if (nextRootPitch == null) return;
    const tones = buildScaleTones(nextEff.root.pitchClass, nextEff.root.tpc, nextEff.scale);
    let above = null, below = null;
    for (const t of tones) {
      if (t.pitch > nextRootPitch && (!above || t.pitch < above.pitch)) above = t;
      if (t.pitch < nextRootPitch && (!below || t.pitch > below.pitch)) below = t;
    }
    if (!above || !below) return;
    const lastBeat = beatsPerBar - 1;
    const secondLast = beatsPerBar - 2;
    if (secondLast < 0) return;
    // Above on beat 3 (descending into below on beat 4 then up to root).
    results[ce.barIdx][secondLast] = { pitch: above.pitch, tpc: above.tpc, duration: 'q' };
    results[ce.barIdx][lastBeat]   = { pitch: below.pitch, tpc: below.tpc, duration: 'q' };
  }

  // V→I major #11 boost: replace beat 4 of a dominant7 chord with the
  // chromatic-above next-root tone (= #11 of the V) when the next
  // chord is a Maj7 a P4 above. ~25% probability — high enough to
  // appear regularly in the corpus's strongest cadences.
  function applyV2IChromaticAbove(ce, nextCe) {
    const interval = (nextCe.root.pitchClass - ce.root.pitchClass + 12) % 12;
    if (interval !== 5) return;
    const aboveTpc = normalizeEnharmonic(nextCe.root.tpc + 7);
    const abovePc = (nextCe.root.pitchClass + 1) % 12;
    const range = chordBeatRange(ce.chordsInBar, ce.chordIdxInBar, beatsPerBar);
    const lastBeat = range.endBeat - 1;
    const refPitch = results[ce.barIdx][range.startBeat]?.pitch || 41;
    placePc(ce.barIdx, lastBeat, abovePc, aboveTpc, refPitch);
  }

  for (let i = 0; i < chordEvents.length; i++) {
    const ce = chordEvents[i];
    const nextCe = chordEvents[i + 1] || null;
    const range = chordBeatRange(ce.chordsInBar, ce.chordIdxInBar, beatsPerBar);
    const ownsFullBar = (range.startBeat === 0 && range.endBeat === beatsPerBar);
    const ceType = getChordType(chordToCanonical(ce.chord));
    const phr = phraseInfo(ce.barIdx);
    // Turnaround boost: the LAST bar of every phrase (the bar
    // before each section repeat / cadence) tends to be more
    // ornate in the corpus — more chromatic enclosures, more
    // #11 colours, more altered ascents. Fire signatures at
    // ~2× their normal probability there.
    const turnaroundBoost = phr.isLast ? 2.0 : 1.0;

    // Override-rate philosophy: PC's actual basslines have ~10-20%
    // of bars with a recognizable signature gesture; the rest are
    // straightforward walking quarters. Rates here are tuned so the
    // CUMULATIVE probability of any single bar getting overridden
    // sits in that range — anything higher kills the cohesion of
    // the line and the bars stop "flowing" into each other.

    // #4: altered ascent over dominant resolving P4 up.
    // Boosted at turnarounds where the V→i resolution is the
    // defining cadence of the phrase.
    if (ownsFullBar && ceType === 'dominant' && nextCe) {
      const interval = (nextCe.root.pitchClass - ce.root.pitchClass + 12) % 12;
      if (interval === 5 && rng() < 0.07 * turnaroundBoost) {
        applyAlteredAscent(ce);
        continue;
      }
    }

    // #3: 5-3-9-R descending Maj7 archetype.
    // Form-aware: heavier on the FIRST bar of a phrase (Just Friends
    // bar 1 archetype), rare mid-phrase.
    if (ownsFullBar && ceType === 'major') {
      const maj7Prob = phr.isFirst ? 0.18 : 0.03;
      if (rng() < maj7Prob) {
        applyMaj7Archetype(ce);
        continue;
      }
    }

    // Corpus template "remix": substitute one of Chambers's top
    // per-bar shapes for the default walking line. Anchored to the
    // previous bar's last note so the template's contour blends
    // into the surrounding line.
    if (ownsFullBar && !phr.isLast) {
      const tplKey = templateKeyForType(ceType);
      const shapes = tplKey ? PC_BAR_SHAPES[tplKey] : null;
      if (shapes && shapes.length && rng() < 0.10) {
        const shape = pickTemplateShape(shapes);
        if (shape && applyTemplate(ce, shape)) continue;
      }
    }

    // #2: diatonic enclosure of next chord's root, on the prior
    // bar's last two beats. Boosted at turnarounds.
    if (nextCe && nextCe.barIdx === ce.barIdx + 1 && nextCe.chordIdxInBar === 0
        && range.endBeat === beatsPerBar
        && (range.endBeat - range.startBeat) >= 2
        && rng() < 0.06 * turnaroundBoost) {
      applyEnclosure(ce, nextCe, effective[i + 1]);
      continue;
    }

    // #1: V→I #11 (chromatic-above next root on beat 4).
    // Boosted at turnarounds (cadential V→I, not passing dominants).
    if (ceType === 'dominant' && nextCe
        && getChordType(chordToCanonical(nextCe.chord)) === 'major'
        && rng() < 0.15 * turnaroundBoost) {
      applyV2IChromaticAbove(ce, nextCe);
      // No `continue` — this is a single-beat tweak that doesn't
      // preclude later signatures from firing on a future chord.
    }
  }

  // Phase 3.6: bar-boundary register snap.
  // After templates / signatures fill in their bar-local shapes,
  // the absolute register of each bar's notes is whichever octave
  // chordTonePitch happened to pick — which can put consecutive
  // bars in totally different registers (e.g. one bar tails at C2
  // and the next opens at G3). The pre-Phase-1 voice-leading anchor
  // helps but isn't a guarantee, because templates can shift the
  // bar's contour up or down regardless of the anchor.
  //
  // This pass scans each bar's beat 1 against the PRIOR bar's beat
  // 4. If they're more than a P5 (7 semis) apart, we try octave-
  // shifting the entire bar by ±12 to bring beat 1 within range.
  // The shift only commits when EVERY note in the shifted bar
  // remains inside [EX_LOW, EX_HIGH]; otherwise the bar stays where
  // it was (some chord progressions naturally require a register
  // jump that octave-snapping can't fix).
  for (let bi = 1; bi < results.length; bi++) {
    const prev = results[bi - 1];
    const cur = results[bi];
    if (!prev || !cur) continue;
    let prevLast = null;
    for (let b = beatsPerBar - 1; b >= 0; b--) {
      if (prev[b] && prev[b].pitch != null) { prevLast = prev[b]; break; }
    }
    let curFirst = null;
    for (let b = 0; b < beatsPerBar; b++) {
      if (cur[b] && cur[b].pitch != null) { curFirst = cur[b]; break; }
    }
    if (!prevLast || !curFirst) continue;
    const diff = curFirst.pitch - prevLast.pitch;
    // PC's actual basslines (Bye Bye Blackbird across 64 bars):
    // 88% of bar-boundary intervals are ≤ ±4 semis (= a M3 or
    // less), the maximum is ±7, NEVER bigger. Anything more than a
    // M3 (4 semis) between bars feels disjointed compared to the
    // corpus, so we octave-snap whenever we're outside that window.
    if (Math.abs(diff) <= 4) continue;
    // Direction of shift: bring curFirst toward prevLast.
    const shift = diff > 0 ? -12 : 12;
    // Verify every note in cur (with a pitch) stays in range AFTER shift.
    let canShift = true;
    for (const slot of cur) {
      if (!slot || slot.pitch == null) continue;
      const np = slot.pitch + shift;
      if (np < EX_LOW || np > EX_HIGH) { canShift = false; break; }
    }
    if (!canShift) continue;
    // Apply shift in place.
    for (const slot of cur) {
      if (slot && slot.pitch != null) slot.pitch += shift;
    }
    // Re-check: if AFTER shifting we're still > 12 semis off,
    // try ANOTHER shift in the same direction (rare, would only
    // happen for two-octave gaps).
    const newCurFirst = cur[0];
    if (newCurFirst && newCurFirst.pitch != null) {
      const newDiff = newCurFirst.pitch - prevLast.pitch;
      if (Math.abs(newDiff) > 4) {
        let canShift2 = true;
        for (const slot of cur) {
          if (!slot || slot.pitch == null) continue;
          const np = slot.pitch + shift;
          if (np < EX_LOW || np > EX_HIGH) { canShift2 = false; break; }
        }
        if (canShift2) {
          for (const slot of cur) {
            if (slot && slot.pitch != null) slot.pitch += shift;
          }
        }
      }
    }
  }

  // Phase 3.5: dedupe consecutive identical quarter-note pitches.
  // Chambers's lines have <2% repeated pitches across consecutive
  // beats; the random-template / signature passes can occasionally
  // produce a duplicate (e.g. a template's last beat lands on the
  // same pitch as the next bar's beat-1 anchor). Walk the rendered
  // results bar-by-bar and nudge any consecutive duplicate by a
  // scale step toward the next-different pitch — preserves the
  // template's contour while breaking the repeat.
  for (let bi = 0; bi < results.length; bi++) {
    for (let b = 0; b < beatsPerBar; b++) {
      const cur = results[bi][b];
      if (!cur || cur.pitch == null) continue;
      // Find the previous note (same bar earlier beat, or last beat
      // of the prior bar).
      let prev = null;
      if (b > 0) prev = results[bi][b - 1];
      else if (bi > 0) prev = results[bi - 1][beatsPerBar - 1];
      if (!prev || prev.pitch == null || prev.pitch !== cur.pitch) continue;

      // Find the next note (for nudge direction). Falls back to
      // descending if there's no next reference.
      let nxt = null;
      if (b < beatsPerBar - 1) nxt = results[bi][b + 1];
      else if (bi + 1 < results.length) nxt = results[bi + 1][0];
      const dir = (nxt && nxt.pitch != null && nxt.pitch !== cur.pitch)
        ? (nxt.pitch > cur.pitch ? +1 : -1)
        : -1;

      // Pick a scale tone in the chord's effective scale, in `dir`,
      // closest to current pitch. Use the chord-event covering this
      // beat. Falls back to a 1-semi nudge if no scale tone available.
      let nudged = null;
      const ceForBeat = chordEvents.find(c => c.barIdx === bi
        && b >= chordBeatRange(c.chordsInBar, c.chordIdxInBar, beatsPerBar).startBeat
        && b <  chordBeatRange(c.chordsInBar, c.chordIdxInBar, beatsPerBar).endBeat);
      if (ceForBeat) {
        const ceIdx = chordEvents.indexOf(ceForBeat);
        const eff = effective[ceIdx];
        const tones = buildScaleTones(eff.root.pitchClass, eff.root.tpc, eff.scale);
        nudged = nextScaleToneFrom(cur.pitch, dir, tones);
      }
      if (!nudged) {
        const np = cur.pitch + dir;
        if (np >= EX_LOW && np <= EX_HIGH) {
          nudged = { pitch: np, tpc: cur.tpc + (dir > 0 ? 7 : -7) };
        }
      }
      if (nudged) results[bi][b] = { ...cur, pitch: nudged.pitch, tpc: nudged.tpc };
    }
  }

  // Phase 4: eighth-note embellishment.
  // ~5% of beats are split into eighth-note pairs (matches the
  // 4.5% eighth-note rate in the corpus). The pair patterns mirror
  // Chambers's actual usage observed across his five basslines:
  //
  //   - Same-pitch doubling (~28% of pairs): two eighths on the
  //     same pitch — adds rhythmic punch without changing the line.
  //   - Step approach (~25%): second eighth is a half/whole step
  //     toward the NEXT beat's pitch, smoothing a leap.
  //   - Big drop / leap (~25%): −12 (octave), −7 (P5), +5, −5.
  //     Most often used at chord changes to set up the next root.
  //   - Small skip (~22%): ±2, ±3 from current — chord-tone hops.
  //
  // Output uses 8-slot (eighth) resolution per bar. Beats that
  // stay as quarters occupy slot 2*b with duration 'q' and slot
  // 2*b+1 stays null (the renderer auto-detects subdiv from
  // stepsPerBar / beatsPerBar = 2 and treats 'q' as 2 steps).
  // At most ONE eighth-note pair per bar. The corpus census shows
  // 4.5% of all notes are eighths (~0.36 eighth-pairs / bar on
  // average), and Chambers basically never stacks two eighth pairs
  // in the same bar — so we cap at one per bar even if the dice
  // roll would have triggered another. Once `barHasEighths` flips
  // for a bar, subsequent beats in that bar emit as quarters.
  const EIGHTH_PROB = 0.10;
  const expanded = bars.map(() => new Array(beatsPerBar * 2).fill(null));
  for (let bi = 0; bi < results.length; bi++) {
    let barHasEighths = false;
    for (let b = 0; b < beatsPerBar; b++) {
      const slot = results[bi][b];
      const slotIdx = b * 2;
      if (!slot) continue;
      // Quarter-only emit: when this bar already has an eighth pair,
      // when the dice say no, or when there's no pitch to embellish.
      if (barHasEighths || rng() >= EIGHTH_PROB || slot.pitch == null) {
        expanded[bi][slotIdx] = { pitch: slot.pitch, tpc: slot.tpc, duration: 'q' };
        continue;
      }
      // Eighth-note pair. Pick second pitch by weighted style.
      const nextSlot = (b < beatsPerBar - 1) ? results[bi][b + 1]
                     : (bi + 1 < results.length ? results[bi + 1][0] : null);
      const r = rng();
      let secondPitch = slot.pitch;
      let secondTpc = slot.tpc;
      if (r < 0.28) {
        // Doubled same pitch.
        secondPitch = slot.pitch;
        secondTpc = slot.tpc;
      } else if (r < 0.53 && nextSlot && nextSlot.pitch != null && nextSlot.pitch !== slot.pitch) {
        // Step approach toward next beat.
        const dist = nextSlot.pitch - slot.pitch;
        const dir = dist > 0 ? +1 : -1;
        const stepSemi = Math.abs(dist) >= 4 ? 2 : 1;
        secondPitch = slot.pitch + dir * stepSemi;
        secondTpc = slot.tpc + dir * (stepSemi === 2 ? 2 : 7);
      } else if (r < 0.78) {
        // Big drop / leap. Pick from {-12, -7, +5, -5} weighted by
        // corpus frequency.
        const drops = [-12, -7, +5, -5];
        const weights = [3, 6, 5, 4];
        const total = weights.reduce((s, w) => s + w, 0);
        let pick = rng() * total;
        let drop = drops[0];
        for (let k = 0; k < drops.length; k++) {
          pick -= weights[k];
          if (pick <= 0) { drop = drops[k]; break; }
        }
        secondPitch = slot.pitch + drop;
        // TPC: octave drop preserves spelling; P5 / P4 step in
        // circle-of-fifths.
        if (drop === -12) secondTpc = slot.tpc;
        else if (drop === -7) secondTpc = slot.tpc - 1;
        else if (drop === +5) secondTpc = slot.tpc - 1;
        else if (drop === -5) secondTpc = slot.tpc + 1;
        if (secondPitch < EX_LOW || secondPitch > EX_HIGH) {
          // Out of range — fall back to a same-pitch double.
          secondPitch = slot.pitch;
          secondTpc = slot.tpc;
        }
      } else {
        // Small skip ±2 / ±3 (chord-tone hop).
        const skips = [+2, -2, +3, -3];
        const skip = skips[Math.floor(rng() * skips.length)];
        secondPitch = slot.pitch + skip;
        secondTpc = slot.tpc + (Math.abs(skip) === 2 ? Math.sign(skip) * 2 : Math.sign(skip) * (-3));
        if (secondPitch < EX_LOW || secondPitch > EX_HIGH) {
          secondPitch = slot.pitch;
          secondTpc = slot.tpc;
        }
      }
      expanded[bi][slotIdx]     = { pitch: slot.pitch,    tpc: slot.tpc,    duration: '8' };
      expanded[bi][slotIdx + 1] = { pitch: secondPitch,   tpc: secondTpc,   duration: '8' };
      barHasEighths = true;
    }
  }

  return { results: expanded, chordEvents, patterns, effective };
}

// 3579 Range Half generator: a continuous half-note line that walks
// up through the 3 / 5 / 7 / 9 of each chord toward F3, then turns
// and walks back down toward F1, then turns again — repeating the
// climb/descend cycle for the length of the song. Every note is a
// half note. Each note is one of {3, 5, 7, 9} of whatever chord is
// sounding at its start beat, picked to continue the current
// direction by one chord-tone step. The quarter-note version
// (`generateRange3579QuarterNotes` below) shares this exact
// direction-stepping logic with a per-beat slot resolution.
//
// Half-note slots:
//   - 4/4  → two half notes per bar (beats 1 and 3)
//   - 3/4  → one half note per bar on beat 1; beat 3 is left empty
//            so the renderer fills it with a quarter rest. (A pure
//            "all-half-notes" line can't fit a 3-beat bar without
//            tying across barlines, which the renderer doesn't do
//            for synthesized exercises.)
//   - other meters → as many full half-note slots as fit, leftover
//                    beats become a rest.
//
// Direction-stepping:
//   - Ascending: pick the LOWEST chord-tone option strictly above
//     the previous pitch. If no such option exists (we've capped out
//     near F3 on this chord), flip direction and pick the highest
//     option below the previous pitch instead.
//   - Descending: mirror — highest option strictly below previous,
//     flipping if we've bottomed out near F1.
// The result is a sawtooth between F1 and F3 whose teeth are
// chord-tone-shaped rather than scale-step-shaped.
function generateRange3579HalfNotes(bars, ts) {
  const beatsPerBar = ts.num;
  const chordEvents = buildChordEventList(bars);
  const patterns = detectKeyPatterns(chordEvents);
  const effective = chordEvents.map((ce, i) => {
    const pat = patterns.find(p => i >= p.firstIdx && i <= p.lastIdx);
    return pickEffectiveScale(ce, pat);
  });

  const results = bars.map(() => new Array(beatsPerBar).fill(null));

  // Locate the chord event covering a (barIdx, beatIdx) — chord events
  // are partitioned per chord per bar, so a beat falls inside exactly
  // one event's [startBeat, endBeat) range.
  function findChordEventAtBeat(barIdx, beatIdx) {
    for (let i = 0; i < chordEvents.length; i++) {
      const ce = chordEvents[i];
      if (ce.barIdx !== barIdx) continue;
      const r = chordBeatRange(ce.chordsInBar, ce.chordIdxInBar, beatsPerBar);
      if (beatIdx >= r.startBeat && beatIdx < r.endBeat) return ce;
    }
    return null;
  }

  // All 3 / 5 / 7 / 9 pitches for a chord, sorted ascending across the
  // F1..F3 cello range. Each entry is { pitch, tpc }. Duplicates within
  // the [3,5,7,9] set (e.g. on chords whose 9 collapses onto another
  // chord tone in the current scale) are kept — they don't hurt the
  // direction-step logic since findIndex still picks the next strictly
  // greater/lesser pitch.
  function chordToneOptions(ce) {
    const chordScale = exGetScale(chordToCanonical(ce.chord));
    if (!chordScale || chordScale.length === 0) return [];
    const rootPc = ce.root.pitchClass;
    const rootTpc = ce.root.tpc;
    const degIdxs = [2, 4, 6, 8]; // diatonic indices for 3, 5, 7, 9
    const opts = [];
    for (const di of degIdxs) {
      // Remap to the chord's actual 3/5/7/9 when the scale is HW
      // diminished (8 notes with passing tones); diatonic 7-note
      // scales pass through unchanged.
      const ridx = diatonicIndexInScale(di, chordScale);
      const oct = Math.floor(ridx / chordScale.length);
      const sd  = chordScale[ridx % chordScale.length];
      const pc  = (((rootPc + sd.s + oct * 12) % 12) + 12) % 12;
      const tpc = rootTpc + sd.t;
      for (let p = EX_LOW; p <= EX_HIGH; p++) {
        if ((((p % 12) + 12) % 12) === pc) opts.push({ pitch: p, tpc });
      }
    }
    opts.sort((a, b) => a.pitch - b.pitch);
    return opts;
  }

  let direction = 1;     // +1 = ascending, -1 = descending
  let lastPitch = -1;

  for (let barIdx = 0; barIdx < bars.length; barIdx++) {
    for (let beatIdx = 0; beatIdx < beatsPerBar; beatIdx += 2) {
      // A half note needs 2 full beats — skip if the bar runs out
      // (e.g. beat 2 of a 3/4 bar would only have 1 beat available).
      if (beatIdx + 2 > beatsPerBar) continue;
      const ce = findChordEventAtBeat(barIdx, beatIdx);
      if (!ce) continue;
      const opts = chordToneOptions(ce);
      if (opts.length === 0) continue;

      let chosen = null;
      if (lastPitch < 0) {
        // First note of the song: start at the lowest available
        // chord tone (closest to F1) and head upward.
        chosen = opts[0];
        direction = 1;
      } else if (direction > 0) {
        chosen = opts.find(o => o.pitch > lastPitch);
        if (!chosen) {
          // Ceiling: nothing higher available on this chord — turn
          // around and pick the highest option below lastPitch.
          direction = -1;
          for (let i = opts.length - 1; i >= 0; i--) {
            if (opts[i].pitch < lastPitch) { chosen = opts[i]; break; }
          }
        }
      } else {
        for (let i = opts.length - 1; i >= 0; i--) {
          if (opts[i].pitch < lastPitch) { chosen = opts[i]; break; }
        }
        if (!chosen) {
          // Floor: turn around and pick the lowest option above.
          direction = 1;
          chosen = opts.find(o => o.pitch > lastPitch);
        }
      }
      // Final fallback: if even the reverse direction had no option
      // (chord's tones happen to all equal lastPitch), repeat the
      // closest pitch so the bar still gets a half note rather than
      // a silent gap.
      if (!chosen) {
        chosen = opts[0];
        for (let i = 1; i < opts.length; i++) {
          if (Math.abs(opts[i].pitch - lastPitch) < Math.abs(chosen.pitch - lastPitch)) {
            chosen = opts[i];
          }
        }
      }

      results[barIdx][beatIdx] = { pitch: chosen.pitch, tpc: chosen.tpc, duration: 'h' };
      lastPitch = chosen.pitch;
    }
  }

  return { results, chordEvents, patterns, effective };
}

// Chord Tones — Half generator: same sawtooth between F1 and F3 as
// 3579 Range Half, but the walk steps through 1 / 3 / 5 / 7 chord
// tones instead of 3 / 5 / 7 / 9. One half note every two beats,
// ascending until the chord's tones run out at the top, then
// descending, alternating without enclosures. Uses
// diatonicIndexInScale so altered / HW-dim / WH-dim chords still
// resolve to their real chord 3 / 5 / 7 (and bb7 on dim7).
function generateChordTonesHalfNotes(bars, ts) {
  const beatsPerBar = ts.num;
  const chordEvents = buildChordEventList(bars);
  const patterns = detectKeyPatterns(chordEvents);
  const effective = chordEvents.map((ce, i) => {
    const pat = patterns.find(p => i >= p.firstIdx && i <= p.lastIdx);
    return pickEffectiveScale(ce, pat);
  });

  const results = bars.map(() => new Array(beatsPerBar).fill(null));

  function findChordEventAtBeat(barIdx, beatIdx) {
    for (let i = 0; i < chordEvents.length; i++) {
      const ce = chordEvents[i];
      if (ce.barIdx !== barIdx) continue;
      const r = chordBeatRange(ce.chordsInBar, ce.chordIdxInBar, beatsPerBar);
      if (beatIdx >= r.startBeat && beatIdx < r.endBeat) return ce;
    }
    return null;
  }

  // All 1 / 3 / 5 / 7 pitches for a chord across F1..F3, sorted
  // ascending. Same structure as the 3579 variant's helper, just
  // with the chord-tone diatonic indices.
  function chordToneOptions(ce) {
    const chordScale = exGetScale(chordToCanonical(ce.chord));
    if (!chordScale || chordScale.length === 0) return [];
    const rootPc = ce.root.pitchClass;
    const rootTpc = ce.root.tpc;
    const degIdxs = [0, 2, 4, 6]; // diatonic indices for 1, 3, 5, 7
    const opts = [];
    for (const di of degIdxs) {
      const ridx = diatonicIndexInScale(di, chordScale);
      const oct = Math.floor(ridx / chordScale.length);
      const sd  = chordScale[ridx % chordScale.length];
      const pc  = (((rootPc + sd.s + oct * 12) % 12) + 12) % 12;
      const tpc = rootTpc + sd.t;
      for (let p = EX_LOW; p <= EX_HIGH; p++) {
        if ((((p % 12) + 12) % 12) === pc) opts.push({ pitch: p, tpc });
      }
    }
    opts.sort((a, b) => a.pitch - b.pitch);
    return opts;
  }

  let direction = 1;
  let lastPitch = -1;

  for (let barIdx = 0; barIdx < bars.length; barIdx++) {
    for (let beatIdx = 0; beatIdx < beatsPerBar; beatIdx += 2) {
      if (beatIdx + 2 > beatsPerBar) continue;
      const ce = findChordEventAtBeat(barIdx, beatIdx);
      if (!ce) continue;
      const opts = chordToneOptions(ce);
      if (opts.length === 0) continue;

      let chosen = null;
      if (lastPitch < 0) {
        // First note — lowest in-range chord tone, head upward.
        chosen = opts[0];
        direction = 1;
      } else if (direction > 0) {
        chosen = opts.find(o => o.pitch > lastPitch);
        if (!chosen) {
          // Top of the sweep — flip and take the highest pitch below.
          direction = -1;
          for (let i = opts.length - 1; i >= 0; i--) {
            if (opts[i].pitch < lastPitch) { chosen = opts[i]; break; }
          }
        }
      } else {
        for (let i = opts.length - 1; i >= 0; i--) {
          if (opts[i].pitch < lastPitch) { chosen = opts[i]; break; }
        }
        if (!chosen) {
          direction = 1;
          chosen = opts.find(o => o.pitch > lastPitch);
        }
      }
      if (!chosen) {
        // Neither direction had a strictly-stepping option — closest
        // pitch wins so the bar still gets a note.
        chosen = opts[0];
        for (let i = 1; i < opts.length; i++) {
          if (Math.abs(opts[i].pitch - lastPitch) < Math.abs(chosen.pitch - lastPitch)) {
            chosen = opts[i];
          }
        }
      }

      results[barIdx][beatIdx] = { pitch: chosen.pitch, tpc: chosen.tpc, duration: 'h' };
      lastPitch = chosen.pitch;
    }
  }

  return { results, chordEvents, patterns, effective };
}

// 3579 Range generator (quarter-note variant): same sawtooth between
// F1 and F3 as 3579 Range Half, but stepping ONCE PER BEAT instead of
// every two beats. The chord-tone walk through {3, 5, 7, 9} produces
// twice as many notes per bar (four per bar in 4/4, three in 3/4),
// which means the line ascends / descends faster and the
// chord-tone-shaped teeth of the sawtooth are denser. Re-uses the
// same direction-step logic: pick the closest chord tone in the
// current direction, flip when no option exists.
function generateRange3579QuarterNotes(bars, ts) {
  const beatsPerBar = ts.num;
  const chordEvents = buildChordEventList(bars);
  const patterns = detectKeyPatterns(chordEvents);
  const effective = chordEvents.map((ce, i) => {
    const pat = patterns.find(p => i >= p.firstIdx && i <= p.lastIdx);
    return pickEffectiveScale(ce, pat);
  });

  const results = bars.map(() => new Array(beatsPerBar).fill(null));

  function findChordEventAtBeat(barIdx, beatIdx) {
    for (let i = 0; i < chordEvents.length; i++) {
      const ce = chordEvents[i];
      if (ce.barIdx !== barIdx) continue;
      const r = chordBeatRange(ce.chordsInBar, ce.chordIdxInBar, beatsPerBar);
      if (beatIdx >= r.startBeat && beatIdx < r.endBeat) return ce;
    }
    return null;
  }

  function chordToneOptions(ce) {
    const chordScale = exGetScale(chordToCanonical(ce.chord));
    if (!chordScale || chordScale.length === 0) return [];
    const rootPc = ce.root.pitchClass;
    const rootTpc = ce.root.tpc;
    const degIdxs = [2, 4, 6, 8]; // diatonic indices for 3, 5, 7, 9
    const opts = [];
    for (const di of degIdxs) {
      // HW-diminished remap: see diatonicIndexInScale.
      const ridx = diatonicIndexInScale(di, chordScale);
      const oct = Math.floor(ridx / chordScale.length);
      const sd  = chordScale[ridx % chordScale.length];
      const pc  = (((rootPc + sd.s + oct * 12) % 12) + 12) % 12;
      const tpc = rootTpc + sd.t;
      for (let p = EX_LOW; p <= EX_HIGH; p++) {
        if ((((p % 12) + 12) % 12) === pc) opts.push({ pitch: p, tpc });
      }
    }
    opts.sort((a, b) => a.pitch - b.pitch);
    return opts;
  }

  let direction = 1;
  let lastPitch = -1;

  for (let barIdx = 0; barIdx < bars.length; barIdx++) {
    for (let beatIdx = 0; beatIdx < beatsPerBar; beatIdx++) {
      const ce = findChordEventAtBeat(barIdx, beatIdx);
      if (!ce) continue;
      const opts = chordToneOptions(ce);
      if (opts.length === 0) continue;

      let chosen = null;
      if (lastPitch < 0) {
        chosen = opts[0];
        direction = 1;
      } else if (direction > 0) {
        chosen = opts.find(o => o.pitch > lastPitch);
        if (!chosen) {
          direction = -1;
          for (let i = opts.length - 1; i >= 0; i--) {
            if (opts[i].pitch < lastPitch) { chosen = opts[i]; break; }
          }
        }
      } else {
        for (let i = opts.length - 1; i >= 0; i--) {
          if (opts[i].pitch < lastPitch) { chosen = opts[i]; break; }
        }
        if (!chosen) {
          direction = 1;
          chosen = opts.find(o => o.pitch > lastPitch);
        }
      }
      if (!chosen) {
        chosen = opts[0];
        for (let i = 1; i < opts.length; i++) {
          if (Math.abs(opts[i].pitch - lastPitch) < Math.abs(chosen.pitch - lastPitch)) {
            chosen = opts[i];
          }
        }
      }

      results[barIdx][beatIdx] = { pitch: chosen.pitch, tpc: chosen.tpc, duration: 'q' };
      lastPitch = chosen.pitch;
    }
  }

  return { results, chordEvents, patterns, effective };
}

// Enclosures generator: each bar is a classic jazz "enclosure" that
// resolves to a chord tone — diatonic step ABOVE, chromatic step
// BELOW, then the target. The target is a 1, 3, or 5 of the bar's
// "main chord" and the targets ascend / descend through the form
// like the 3579 Range exercise (sweeping from low cello toward F3,
// then back down).
//
// Bar layouts:
//   - 4/4 with 1 chord:  q (above)  q (below)  h (target)
//   - 4/4 with 2 chords: q (above)  q (below)  h (target)
//                        ↑ first chord            ↑ target = 1/3/5 of SECOND chord
//                        first quarter is diatonic to the FIRST chord's scale
//   - 4/4 with 3 chords (2-1-1, chord on beat 4): the beat-4 chord is
//     ignored. Half note targets the chord on beat 3; first quarter
//     is diatonic to the chord on beat 1.
//   - 4/4 with 4 chords (1-1-1-1): same — target = chord on beat 3,
//     diatonic-above is in the chord-on-beat-1 scale, chord-on-beat-2
//     and chord-on-beat-4 are not voiced.
//   - 3/4: degrades to q-q-q (target as a quarter, since q-q-h doesn't
//     fit in 3 beats). Same chord-selection logic.
//
// Voice-leading: targets (the half notes) are picked from {1, 3, 5}
// of the main chord across all octaves in the cello range, choosing
// the next pitch above the previous target (ascending) until the
// chord runs out of higher options, then flipping to descending.
// Same sawtooth shape as 3579 Range, just with a smaller tone set.
function generateEnclosuresQuarterNotes(bars, ts) {
  const beatsPerBar = ts.num;
  const chordEvents = buildChordEventList(bars);
  const patterns = detectKeyPatterns(chordEvents);
  const effective = chordEvents.map((ce, i) => {
    const pat = patterns.find(p => i >= p.firstIdx && i <= p.lastIdx);
    return pickEffectiveScale(ce, pat);
  });

  const results = bars.map(() => new Array(beatsPerBar).fill(null));

  // Locate the chord event covering a given (barIdx, beatIdx). Each
  // beat falls inside exactly one chord event's [startBeat, endBeat).
  function findChordEventAtBeat(barIdx, beatIdx) {
    for (let i = 0; i < chordEvents.length; i++) {
      const ce = chordEvents[i];
      if (ce.barIdx !== barIdx) continue;
      const r = chordBeatRange(ce.chordsInBar, ce.chordIdxInBar, beatsPerBar);
      if (beatIdx >= r.startBeat && beatIdx < r.endBeat) return ce;
    }
    return null;
  }

  // 1 / 3 / 5 of a chord, every octave inside [EX_LOW, EX_HIGH], sorted ascending.
  function targetOptions(ce) {
    const chordScale = exGetScale(chordToCanonical(ce.chord));
    if (!chordScale || chordScale.length === 0) return [];
    const rootPc = ce.root.pitchClass;
    const rootTpc = ce.root.tpc;
    const opts = [];
    for (const di of [0, 2, 4]) { // scale indices for 1, 3, 5
      if (di >= chordScale.length) continue;
      const sd = chordScale[di];
      const pc = (((rootPc + sd.s) % 12) + 12) % 12;
      const tpc = rootTpc + sd.t;
      for (let p = EX_LOW; p <= EX_HIGH; p++) {
        if ((((p % 12) + 12) % 12) === pc) opts.push({ pitch: p, tpc });
      }
    }
    opts.sort((a, b) => a.pitch - b.pitch);
    return opts;
  }

  // Lowest scale tone strictly greater than `belowMidi` in the given
  // scale. Sweep enough octaves to cover the cello range and a touch
  // above (in case the target sits near F3 and the next scale tone
  // is a whole step higher).
  function diatonicAbove(belowMidi, scale, rootPc, rootTpc) {
    let best = null;
    for (let oct = 0; oct < 8; oct++) {
      for (let i = 0; i < scale.length; i++) {
        const pitch = rootPc + scale[i].s + oct * 12;
        const tpc = rootTpc + scale[i].t;
        if (pitch > belowMidi && (!best || pitch < best.pitch)) {
          best = { pitch, tpc };
        }
      }
    }
    return best;
  }

  // Chromatic neighbor a half step BELOW the target, spelled as a
  // leading-tone-from-below approach so the line reads as "rising
  // chromatic into the target":
  //   - Naturals D/E/G/A/B → sharp of the next letter down
  //     (B→A♯, E→D♯, A→G♯, G→F♯, D→C♯). This is the spelling jazz
  //     pedagogy uses for ascending enclosures.
  //   - Naturals C/F → next letter down natural (C→B, F→E), since
  //     C/F already have a half-step diatonic neighbor below — Cb/Fb
  //     would just be enharmonic clutter.
  //   - Sharps (C♯, D♯, F♯, G♯, A♯) → lower the same letter to
  //     natural (C♯→C, F♯→F, …).
  //   - Flats (E♭, B♭, A♭, D♭, G♭, C♭) → previous letter natural
  //     (E♭→D, B♭→A, …). Same-letter would give a double flat.
  // Compactly: TPC+5 covers naturals and flats (the "previous letter"
  // step in the F-C-G-D-A-E-B fifths cycle), TPC−7 covers sharps
  // (lower the accidental in place).
  function chromaticBelow(targetMidi, targetTpc) {
    const altLevel = Math.floor((targetTpc - 6) / 7); // 0=b, 1=nat, 2=#, 3=##
    const tpc = altLevel >= 2 ? targetTpc - 7 : targetTpc + 5;
    return { pitch: targetMidi - 1, tpc };
  }

  let direction = 1;     // +1 ascending, −1 descending
  let lastTarget = -1;

  for (let barIdx = 0; barIdx < bars.length; barIdx++) {
    const firstCe = findChordEventAtBeat(barIdx, 0);
    if (!firstCe) continue;
    // Main chord = chord at beat 3 in 4/4 (0-indexed beat 2). The
    // user explicitly asked: chord on beat 4 is ignored; chord on
    // beat 3 owns the half note. For non-4/4 meters, look at the
    // beat closest to "3 of 4" — beats_per_bar - 2 — which gives a
    // sensible analog (e.g. beat 1 in 3/4) without crashing on odd
    // signatures.
    const mainBeatIdx = beatsPerBar >= 4 ? 2 : Math.max(0, beatsPerBar - 2);
    const mainCe = findChordEventAtBeat(barIdx, mainBeatIdx) || firstCe;

    // Target (half note) — sweeping contour through 1/3/5 options.
    // Filter to targets whose neighbors will ALSO sit inside F1..F3:
    //   - chromatic-below = target − 1 semitone, so target ≥ F♯1 (30).
    //   - diatonic-above (in the FIRST chord's scale) ≤ F3 (53). The
    //     diatonic step above target is 1 or 2 semitones depending on
    //     the scale, so we have to compute it per-option rather than
    //     applying a fixed offset. On F7 (F mixolydian) this caps the
    //     target at C3 (above = D3 = 50) — F3 itself isn't a valid
    //     target because its diatonic-above would be G3 = 55, outside
    //     the cello's F1..F3 range.
    const firstScale = exGetScale(chordToCanonical(firstCe.chord));
    const allOpts = targetOptions(mainCe);
    const opts = allOpts.filter(o => {
      if (o.pitch - 1 < EX_LOW) return false; // chromatic-below would leave the range
      const above = diatonicAbove(
        o.pitch, firstScale, firstCe.root.pitchClass, firstCe.root.tpc
      );
      return above && above.pitch <= EX_HIGH;
    });
    if (opts.length === 0) continue;
    let chosen = null;
    if (lastTarget < 0) {
      chosen = opts[0]; // first bar: start near F1 and head up.
      direction = 1;
    } else if (direction > 0) {
      chosen = opts.find(o => o.pitch > lastTarget);
      if (!chosen) {
        direction = -1;
        for (let i = opts.length - 1; i >= 0; i--) {
          if (opts[i].pitch < lastTarget) { chosen = opts[i]; break; }
        }
      }
    } else {
      for (let i = opts.length - 1; i >= 0; i--) {
        if (opts[i].pitch < lastTarget) { chosen = opts[i]; break; }
      }
      if (!chosen) {
        direction = 1;
        chosen = opts.find(o => o.pitch > lastTarget);
      }
    }
    if (!chosen) {
      // Pathological fallback: chord's only options sit at lastTarget
      // exactly. Repeat the closest pitch so the bar still has a target.
      chosen = opts[0];
      for (let i = 1; i < opts.length; i++) {
        if (Math.abs(opts[i].pitch - lastTarget) < Math.abs(chosen.pitch - lastTarget)) {
          chosen = opts[i];
        }
      }
    }
    const target = chosen;
    lastTarget = target.pitch;

    // First quarter: diatonic note above target, in the FIRST chord's
    // scale (so a 2-chord bar gets the chord-1 voice on the upbeat
    // and the chord-2 voice on the downbeat). Guaranteed ≤ EX_HIGH
    // by the target filter above.
    const firstAbove = diatonicAbove(
      target.pitch, firstScale, firstCe.root.pitchClass, firstCe.root.tpc
    );
    if (!firstAbove) continue;

    // Second quarter: chromatic step below target. Guaranteed
    // ≥ EX_LOW by the target filter above (target ≥ F♯1 ⟹ below ≥ F1).
    const second = chromaticBelow(target.pitch, target.tpc);

    if (beatsPerBar >= 4) {
      // 4/4: q (above) | q (below) | h (target, covers beats 3-4).
      results[barIdx][0] = { pitch: firstAbove.pitch, tpc: firstAbove.tpc, duration: 'q' };
      results[barIdx][1] = { pitch: second.pitch,     tpc: second.tpc,     duration: 'q' };
      results[barIdx][2] = { pitch: target.pitch,     tpc: target.tpc,     duration: 'h' };
    } else if (beatsPerBar === 3) {
      // 3/4: q-q-q. q-q-h would overflow the bar; degrade target to
      // a quarter so the enclosure shape is still recognisable.
      results[barIdx][0] = { pitch: firstAbove.pitch, tpc: firstAbove.tpc, duration: 'q' };
      results[barIdx][1] = { pitch: second.pitch,     tpc: second.tpc,     duration: 'q' };
      results[barIdx][2] = { pitch: target.pitch,     tpc: target.tpc,     duration: 'q' };
    }
    // Other meters: skip — the renderer will fill the bar with rests.
  }

  return { results, chordEvents, patterns, effective };
}

// Long Enclosures generator: every cycle of THREE bars contains a
// SETUP bar (4 diatonic quarter notes split into two voice-leading
// pairs) followed by a TARGET bar (q-q-h enclosure on a 1/3/5 chord
// tone) followed by a REST bar (a single whole rest). The rest bar
// gives the player a beat to breathe and re-orient before the next
// long-enclosure phrase begins. The two PLAYED bars work the same
// way the regular Enclosures generator's pair does — only the rest
// bar in between cycles is new. The setup bar's two pairs each
// voice-lead into a specific note of the upcoming target bar:
//
//   pair 1 (beats 1–2) → q1 of target bar (= diatonic-above target)
//   pair 2 (beats 3–4) → q2 of target bar (= chromatic-below target)
//
// Both pairs are diatonic to the SETUP bar's chord scale. Because
// the two pairs aim at different goals (q1 sits above the target,
// q2 sits a half step below it), they typically end up in different
// octaves, producing the audible jump between beats 2 and 3 that
// the spec image shows.
//
// Default approach styles (chosen to match the worked example):
//   - pair 1: from above, stepwise descending (3rd above ▸ 2nd above
//     ▸ q1). On Dm7 → G7 with q1 = C3 in D dorian: E3 D3.
//   - pair 2: from below, stepwise ascending (3rd below ▸ 2nd below
//     ▸ q2). On Dm7 → G7 with q2 = A♯2 in D dorian (so closest
//     diatonic notes below are A2 and G2): G2 A2.
//
// Combined with the standard target-bar enclosure C A♯ B(h), the
// full two-bar phrase is E3 D3 G2 A2 | C3 A♯2 B(h) — high-high then
// low-low in the setup bar, leaping back up to C3 for the target
// bar's first quarter.
//
// Range/voice-leading filter: the same target-picking sweep used by
// the regular Enclosures generator runs here, but with extra
// constraints — a candidate target is only valid if BOTH setup pairs
// (two diatonic notes above q1, two below q2) fit inside F1..F3.
// This means Long Enclosures has a slightly narrower target range
// than regular Enclosures, since each target now needs four extra
// scale tones in the setup bar's scale to fit.
function generateLongEnclosuresQuarterNotes(bars, ts) {
  const beatsPerBar = ts.num;
  const chordEvents = buildChordEventList(bars);
  const patterns = detectKeyPatterns(chordEvents);
  const effective = chordEvents.map((ce, i) => {
    const pat = patterns.find(p => i >= p.firstIdx && i <= p.lastIdx);
    return pickEffectiveScale(ce, pat);
  });

  const results = bars.map(() => new Array(beatsPerBar).fill(null));

  // === Helpers ===
  function findChordEventAtBeat(barIdx, beatIdx) {
    for (let i = 0; i < chordEvents.length; i++) {
      const ce = chordEvents[i];
      if (ce.barIdx !== barIdx) continue;
      const r = chordBeatRange(ce.chordsInBar, ce.chordIdxInBar, beatsPerBar);
      if (beatIdx >= r.startBeat && beatIdx < r.endBeat) return ce;
    }
    return null;
  }
  function targetOptions(ce) {
    const chordScale = exGetScale(chordToCanonical(ce.chord));
    if (!chordScale || chordScale.length === 0) return [];
    const rootPc = ce.root.pitchClass;
    const rootTpc = ce.root.tpc;
    const opts = [];
    for (const di of [0, 2, 4]) {
      if (di >= chordScale.length) continue;
      const sd = chordScale[di];
      const pc = (((rootPc + sd.s) % 12) + 12) % 12;
      const tpc = rootTpc + sd.t;
      for (let p = EX_LOW; p <= EX_HIGH; p++) {
        if ((((p % 12) + 12) % 12) === pc) opts.push({ pitch: p, tpc });
      }
    }
    opts.sort((a, b) => a.pitch - b.pitch);
    return opts;
  }
  function diatonicAbove(belowMidi, scale, rootPc, rootTpc) {
    let best = null;
    for (let oct = 0; oct < 8; oct++) {
      for (let i = 0; i < scale.length; i++) {
        const pitch = rootPc + scale[i].s + oct * 12;
        const tpc = rootTpc + scale[i].t;
        if (pitch > belowMidi && (!best || pitch < best.pitch)) {
          best = { pitch, tpc };
        }
      }
    }
    return best;
  }
  function chromaticBelow(targetMidi, targetTpc) {
    const altLevel = Math.floor((targetTpc - 6) / 7);
    const tpc = altLevel >= 2 ? targetTpc - 7 : targetTpc + 5;
    return { pitch: targetMidi - 1, tpc };
  }
  // The n-th distinct scale tone above (direction=+1) or below
  // (direction=-1) `goalPitch`, staying inside [EX_LOW, EX_HIGH].
  // n=1 ⇒ the immediate scale neighbor; n=2 ⇒ the one past that.
  // Used to build the two-note voice-leading pairs in the setup bar.
  function diatonicStep(scale, rootPc, rootTpc, goalPitch, direction, n) {
    const seen = new Set();
    const tones = [];
    for (let oct = 0; oct < 8; oct++) {
      for (let i = 0; i < scale.length; i++) {
        const sd = scale[i];
        const pitch = rootPc + sd.s + oct * 12;
        if (pitch < EX_LOW || pitch > EX_HIGH) continue;
        if (seen.has(pitch)) continue;
        seen.add(pitch);
        tones.push({ pitch, tpc: rootTpc + sd.t });
      }
    }
    tones.sort((a, b) => a.pitch - b.pitch);
    if (direction > 0) {
      const above = tones.filter(t => t.pitch > goalPitch);
      return above[n - 1] || null;
    }
    const below = tones.filter(t => t.pitch < goalPitch).reverse();
    return below[n - 1] || null;
  }
  // Place a regular q-q-h Enclosures bar (used for the target bar of
  // every pair, and for the leftover bar when the song has an odd
  // length). Filters target candidates with `extraFilter` so the
  // setup bar's voice-leading pairs are guaranteed to fit.
  function placeEnclosureBar(barIdx, contour, extraFilter) {
    const firstCe = findChordEventAtBeat(barIdx, 0);
    if (!firstCe) return null;
    const mainBeatIdx = beatsPerBar >= 4 ? 2 : Math.max(0, beatsPerBar - 2);
    const mainCe = findChordEventAtBeat(barIdx, mainBeatIdx) || firstCe;
    const firstScale = exGetScale(chordToCanonical(firstCe.chord));
    const allOpts = targetOptions(mainCe);
    const opts = allOpts.filter(o => {
      if (o.pitch - 1 < EX_LOW) return false;
      const above = diatonicAbove(o.pitch, firstScale, firstCe.root.pitchClass, firstCe.root.tpc);
      if (!above || above.pitch > EX_HIGH) return false;
      if (extraFilter && !extraFilter(o, above)) return false;
      return true;
    });
    if (opts.length === 0) return null;

    let chosen = null;
    if (contour.lastTarget < 0) {
      chosen = opts[0];
      contour.direction = 1;
    } else if (contour.direction > 0) {
      chosen = opts.find(o => o.pitch > contour.lastTarget);
      if (!chosen) {
        contour.direction = -1;
        for (let i = opts.length - 1; i >= 0; i--) {
          if (opts[i].pitch < contour.lastTarget) { chosen = opts[i]; break; }
        }
      }
    } else {
      for (let i = opts.length - 1; i >= 0; i--) {
        if (opts[i].pitch < contour.lastTarget) { chosen = opts[i]; break; }
      }
      if (!chosen) {
        contour.direction = 1;
        chosen = opts.find(o => o.pitch > contour.lastTarget);
      }
    }
    if (!chosen) {
      chosen = opts[0];
      for (let i = 1; i < opts.length; i++) {
        if (Math.abs(opts[i].pitch - contour.lastTarget) <
            Math.abs(chosen.pitch - contour.lastTarget)) chosen = opts[i];
      }
    }
    const target = chosen;
    contour.lastTarget = target.pitch;

    const firstAbove = diatonicAbove(
      target.pitch, firstScale, firstCe.root.pitchClass, firstCe.root.tpc
    );
    if (!firstAbove) return null;
    const second = chromaticBelow(target.pitch, target.tpc);

    if (beatsPerBar >= 4) {
      results[barIdx][0] = { pitch: firstAbove.pitch, tpc: firstAbove.tpc, duration: 'q' };
      results[barIdx][1] = { pitch: second.pitch,     tpc: second.tpc,     duration: 'q' };
      results[barIdx][2] = { pitch: target.pitch,     tpc: target.tpc,     duration: 'h' };
    } else if (beatsPerBar === 3) {
      results[barIdx][0] = { pitch: firstAbove.pitch, tpc: firstAbove.tpc, duration: 'q' };
      results[barIdx][1] = { pitch: second.pitch,     tpc: second.tpc,     duration: 'q' };
      results[barIdx][2] = { pitch: target.pitch,     tpc: target.tpc,     duration: 'q' };
    }
    return { firstAbove, target, second };
  }
  // === End helpers ===

  // Drive the form in 3-bar cycles: SETUP at `cycleStart`, TARGET at
  // `cycleStart + 1`, REST at `cycleStart + 2`. The rest bar's slots
  // stay all-null so the renderer fills it with a single whole rest
  // (in 4/4) or a dotted-half rest (in 3/4) via its full-bar-empty
  // shortcut. If the song length isn't a clean multiple of 3, the
  // tail-end cycles just play whatever bars remain — a leftover
  // single bar gets the regular Enclosures pattern; a leftover pair
  // (setup + target with no rest) plays the long-enclosure phrase
  // and the song simply ends on the half note.
  const contour = { lastTarget: -1, direction: 1 };
  for (let cycleStart = 0; cycleStart < bars.length; cycleStart += 3) {
    const setupBarIdx  = cycleStart;
    const targetBarIdx = cycleStart + 1;

    // Tail case: only one bar left in the song, so there's no room
    // for a setup-target pair. Drop in a regular Enclosures bar so
    // the contour still gets a target and the song doesn't trail
    // off into an unexpected silent bar.
    if (targetBarIdx >= bars.length) {
      placeEnclosureBar(setupBarIdx, contour, null);
      continue;
    }

    const setupCe = findChordEventAtBeat(setupBarIdx, 0);
    if (!setupCe) continue;
    const setupScale = exGetScale(chordToCanonical(setupCe.chord));
    if (!setupScale || setupScale.length === 0) continue;
    const setupRootPc  = setupCe.root.pitchClass;
    const setupRootTpc = setupCe.root.tpc;

    // Reject targets whose setup pairs can't fit:
    //  - pair 1 (above q1 stepwise descending) needs 2 scale tones above
    //    q1 inside [EX_LOW, EX_HIGH].
    //  - pair 2 (below q2 stepwise ascending) needs 2 scale tones below
    //    q2 (= target − 1 semitone) inside the same range.
    // Both are computed in the SETUP bar's chord scale.
    const extraFilter = (o, above) => {
      const u1 = diatonicStep(setupScale, setupRootPc, setupRootTpc, above.pitch, +1, 1);
      const u2 = diatonicStep(setupScale, setupRootPc, setupRootTpc, above.pitch, +1, 2);
      if (!u1 || !u2) return false;
      const secondPitch = o.pitch - 1;
      const d1 = diatonicStep(setupScale, setupRootPc, setupRootTpc, secondPitch, -1, 1);
      const d2 = diatonicStep(setupScale, setupRootPc, setupRootTpc, secondPitch, -1, 2);
      if (!d1 || !d2) return false;
      return true;
    };

    const enc = placeEnclosureBar(targetBarIdx, contour, extraFilter);
    if (!enc) continue;

    // Pair 1 (beats 1-2 of setup bar): from above stepwise descending
    // INTO the next bar's q1 (= enc.firstAbove). The two notes are the
    // diatonic 3rd-above and 2nd-above of q1 in the setup scale, played
    // in that order so the line steps down toward q1.
    const u2 = diatonicStep(setupScale, setupRootPc, setupRootTpc, enc.firstAbove.pitch, +1, 2);
    const u1 = diatonicStep(setupScale, setupRootPc, setupRootTpc, enc.firstAbove.pitch, +1, 1);
    // Pair 2 (beats 3-4): from below stepwise ascending INTO q2
    // (= enc.second, the chromatic-below quarter). Two diatonic notes
    // below q2 in the setup scale, played 3rd-below then 2nd-below
    // so the line steps up toward q2.
    const d2 = diatonicStep(setupScale, setupRootPc, setupRootTpc, enc.second.pitch, -1, 2);
    const d1 = diatonicStep(setupScale, setupRootPc, setupRootTpc, enc.second.pitch, -1, 1);
    if (!u1 || !u2 || !d1 || !d2) continue; // shouldn't happen — extraFilter caught it.

    if (beatsPerBar >= 4) {
      results[setupBarIdx][0] = { pitch: u2.pitch, tpc: u2.tpc, duration: 'q' };
      results[setupBarIdx][1] = { pitch: u1.pitch, tpc: u1.tpc, duration: 'q' };
      results[setupBarIdx][2] = { pitch: d2.pitch, tpc: d2.tpc, duration: 'q' };
      results[setupBarIdx][3] = { pitch: d1.pitch, tpc: d1.tpc, duration: 'q' };
    } else if (beatsPerBar === 3) {
      // 3/4: only 3 quarters fit. Drop pair-2's 3rd-below and play
      // 3rd-above ▸ 2nd-above ▸ 2nd-below so the bar still ends on the
      // approach note for q2.
      results[setupBarIdx][0] = { pitch: u2.pitch, tpc: u2.tpc, duration: 'q' };
      results[setupBarIdx][1] = { pitch: u1.pitch, tpc: u1.tpc, duration: 'q' };
      results[setupBarIdx][2] = { pitch: d1.pitch, tpc: d1.tpc, duration: 'q' };
    }
  }
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
    return pickEffectiveScale(ce, pat);
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
      return pickEffectiveScale(ce, pat);
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
      // diatonicIndexInScale maps [0, 2, 4, 6] to the chord's actual
      // 1/3/5/7 even when the active scale is HW Diminished — without
      // it, an arpeggio over D7♭9 would land on R, ♭3, ♯11, 13
      // (HW indices 0, 2, 4, 6) instead of R, 3, 5, ♭7.
      const degrees = [];
      for (let d = 0; d < degCount; d++) {
        const si = diatonicIndexInScale(degScaleIdx[d], chordScale);
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

      // Reset every 2 bars: the FIRST chord of any even-indexed bar
      // (bar 0, 2, 4, …) restarts the line at the lowest available
      // chord tone and ascends from there. Without this reset, the
      // line creeps higher with each chord change and eventually has
      // to bounce off F3, which forces awkward octave-down leaps in
      // multi-chord bars. Restarting low every 2 bars keeps each
      // 2-bar group readable as a smooth ascending line.
      const isResetPoint = (ce.barIdx % 2 === 0) && (ce.chordIdxInBar === 0);
      if (ci === 0 || isResetPoint) {
        startPitch = 9999;
        for (let d = 0; d < degrees.length; d++) {
          const all = pitchesForPC(degrees[d].pc);
          for (let k = 0; k < all.length; k++) {
            if (all[k] < startPitch) { startPitch = all[k]; startDegIdx = d; }
          }
        }
        descending = false;
      } else {
        // Linear voice-leading across chord changes: pick the chord
        // tone CLOSEST to the previous note, with a tie-break
        // preferring the higher pitch so a transition like Gm7 → C7
        // continues ascending instead of jumping down an octave to
        // stay in the prior `descending` direction. The within-chord
        // walk that follows takes its direction from the choice — if
        // we picked a pitch above lastWrittenPitch, we ascend through
        // the rest of this chord's quarters; if below, we descend.
        // Replaces the older two-pass "nearest in current direction,
        // fall back to absolute nearest" logic, which kept the line
        // in one direction even when that meant a big leap.
        let bestPitch = -1, bestDeg = 0, bestDist = 9999;
        for (let d = 0; d < degrees.length; d++) {
          const all = pitchesForPC(degrees[d].pc);
          for (let k = 0; k < all.length; k++) {
            if (all[k] === lastWrittenPitch) continue;
            const dist = Math.abs(all[k] - lastWrittenPitch);
            if (dist < bestDist
                || (dist === bestDist && all[k] > bestPitch)) {
              bestDist = dist; bestPitch = all[k]; bestDeg = d;
            }
          }
        }
        startPitch = bestPitch;
        startDegIdx = bestDeg;
        if (startPitch >= 0 && lastWrittenPitch >= 0) {
          descending = startPitch < lastWrittenPitch;
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

// Songs/ folder index — used to resolve head-file names case-
// insensitively. The iRealPro song titles use Title Case ("You,
// The Night, And The Music") but the actual filenames on disk
// often differ ("You, the Night, and the Music.musicxml").
// Windows filesystems shrug it off; iOS/Android/Linux refuse to
// serve the file. The fix is to fetch the directory listing once,
// build a lowercased → actual map, and resolve each requested
// filename against it.
//
// Two sources, in order:
//   1. `songs/manifest.json` — an explicit array of filenames.
//      Use this on hosts that disable directory listings (GitHub
//      Pages etc.). Generate it however you like — `ls songs/ >
//      manifest.json` works.
//   2. `songs/` — the server's HTML directory listing (Python's
//      http.server + most dev servers). We parse `<a href="...">`
//      entries out of the HTML.
//
// Cached in a single promise so concurrent probe calls share one
// fetch instead of stampeding the server with N copies.
let _songDirIndexPromise = null;
function loadSongDirectoryIndex() {
  if (_songDirIndexPromise) return _songDirIndexPromise;
  _songDirIndexPromise = loadDirectoryIndex('songs');
  return _songDirIndexPromise;
}
// Lick directory index — same shape and merge strategy as the song
// index but rooted at `licks/`. Cached separately so a manual cache
// invalidation in one folder doesn't cost a re-fetch for the other.
let _licksDirIndexPromise = null;
function loadLicksDirectoryIndex() {
  if (_licksDirIndexPromise) return _licksDirIndexPromise;
  _licksDirIndexPromise = loadDirectoryIndex('licks');
  return _licksDirIndexPromise;
}
// Build a `{lowercaseFilename: actualCasingFilename}` map for the
// given top-level folder (e.g. "songs", "licks") by combining a
// JSON manifest at `<folder>/manifest.json` with an HTML directory
// listing at `<folder>/`. The manifest is the canonical source on
// GitHub Pages (which never serves directory listings); the HTML
// listing wins on local dev so a just-dropped file appears
// immediately without the manifest workflow needing to run. Either
// source missing is fine — the function still returns whatever the
// other one provided.
function loadDirectoryIndex(folder) {
  return (async () => {
    const map = Object.create(null);
    // 1. Manifest.
    try {
      const res = await fetch(`${folder}/manifest.json`, { cache: 'no-store' });
      if (res.ok) {
        const json = await res.json();
        if (Array.isArray(json)) {
          for (const fn of json) {
            const s = String(fn);
            map[s.toLowerCase()] = s;
          }
        }
      }
    } catch (e) { /* skip */ }
    // 2. HTML directory listing.
    try {
      const res = await fetch(`${folder}/`, { cache: 'no-store' });
      if (res.ok) {
        const text = await res.text();
        const re = /<a\s+[^>]*href="([^"]+)"/gi;
        let m;
        while ((m = re.exec(text)) !== null) {
          let href;
          try { href = decodeURIComponent(m[1]); } catch (e) { continue; }
          if (!href || href === '../' || href === './' || href.endsWith('/')) continue;
          if (href.includes('/')) continue;
          map[href.toLowerCase()] = href;
        }
      }
    } catch (e) { /* skip */ }
    return map;
  })();
}

// Resolve `${title}.${ext}` to the actual filename on disk, matching
// case-insensitively against the directory index when possible.
// Always returns the title-as-is filename as a final fallback so a
// just-added file that isn't yet in the manifest still gets a fetch
// attempt — if the on-disk casing happens to match the iRealPro
// title verbatim, it loads immediately. The case-insensitive
// resolution only kicks in when the manifest DOES contain a match,
// covering the GitHub Pages case-sensitive-filesystem scenario
// without forcing us to wait for the manifest workflow to run.
async function resolveSongFilename(title, ext) {
  if (!title) return null;
  const wanted = `${title}.${ext}`;
  const index = await loadSongDirectoryIndex();
  if (Object.keys(index).length > 0) {
    const found = index[wanted.toLowerCase()];
    if (found) return found;
  }
  // No (or stale) index entry — try the title verbatim. The fetch
  // will 404 if the file doesn't exist with that case, in which
  // case the load functions return null gracefully.
  return wanted;
}

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

// Score-mode dropdown discovery. When the user is in Score mode, the
// exercise dropdown is repurposed to show every score (.musicxml /
// .mid) that relates to the current song:
//   - "{Title}.musicxml" → label "Head" (the default melody)
//   - "{Title} - {Variant}.musicxml" → label "{Variant}"
// Variants are the after-dash portion of the filename — e.g.
// "On Green Dolphin Street - Paul Chambers Bassline.musicxml" becomes
// "Paul Chambers Bassline". Returns an array sorted with "Head" first
// then variants alphabetical. Filename matching is case-insensitive
// (Linux/iOS/Android serve files case-sensitive even when the
// manifest casing differs from on-disk casing); the `filename` field
// preserves the on-disk casing so the fetch URL works.
async function listScoresForSong(title) {
  if (!title) return [];
  // Invalidate the cached directory index so newly-dropped files
  // appear without a hard page reload. The cache exists to coalesce
  // burst fetches during a single song-load (loadSongMusicXML +
  // loadSongMidi probe back-to-back); clearing it here costs at
  // most one extra manifest.json fetch per Score-mode interaction.
  _songDirIndexPromise = null;
  const index = await loadSongDirectoryIndex();
  const lc = title.toLowerCase();
  // Collect by variant key. When a variant has both .musicxml and
  // .mid available, prefer .musicxml (better spelling + ties).
  const byVariant = new Map();
  for (const fn of Object.values(index)) {
    const lcFn = fn.toLowerCase();
    let ext = null;
    if (lcFn.endsWith('.musicxml')) ext = 'musicxml';
    else if (lcFn.endsWith('.mid')) ext = 'mid';
    else continue;
    const base = fn.slice(0, fn.length - ext.length - 1);
    const baseLc = base.toLowerCase();
    let label, key, isDefault;
    if (baseLc === lc) {
      label = 'Head';
      key = '';
      isDefault = true;
    } else if (baseLc.startsWith(lc + ' - ')) {
      // Slice from `base` (original case) at the title-prefix length.
      // base.length === baseLc.length, so the offset transfers
      // unchanged.
      label = base.slice(title.length + 3);
      key = label.toLowerCase();
      isDefault = false;
    } else continue;
    const existing = byVariant.get(key);
    if (!existing || (existing.ext === 'mid' && ext === 'musicxml')) {
      byVariant.set(key, { label, filename: fn, isDefault, ext });
    }
  }
  const matches = Array.from(byVariant.values());
  matches.sort((a, b) => {
    if (a.isDefault && !b.isDefault) return -1;
    if (b.isDefault && !a.isDefault) return 1;
    return a.label.localeCompare(b.label, undefined, { sensitivity: 'base' });
  });
  return matches;
}

// Load + parse a score directly from an on-disk filename (rather than
// resolving "{title}.{ext}" via loadSongHead). Used when the user
// picks a non-default variant from the Score-mode dropdown — that
// filename is taken from listScoresForSong and corresponds to a real
// entry in the directory index, so we don't need title-resolution.
async function loadHeadFromFilename(filename) {
  if (!filename) return null;
  try {
    const url = `songs/${encodeURIComponent(filename)}`;
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) return null;
    const ext = filename.toLowerCase().split('.').pop();
    if (ext === 'musicxml' || ext === 'xml') {
      const text = await response.text();
      const doc = new DOMParser().parseFromString(text, 'application/xml');
      if (doc.querySelector('parsererror')) return null;
      return parseMusicXML(doc);
    }
    if (ext === 'mid' || ext === 'midi') {
      if (typeof Midi === 'undefined') return null;
      const buf = await response.arrayBuffer();
      return midiToHeadNotes(new Midi(buf));
    }
    return null;
  } catch (e) {
    return null;
  }
}

async function loadSongMusicXML(title) {
  try {
    const filename = await resolveSongFilename(title, 'musicxml');
    if (!filename) return null;
    const url = `songs/${encodeURIComponent(filename)}`;
    // `cache: 'no-store'` so a deleted or edited .musicxml on disk
    // is reflected immediately. Without this, the browser's HTTP
    // cache happily serves the old 200 response — even after the
    // file is gone — so the app keeps showing the stale head.
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) return null;
    const text = await response.text();
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.querySelector('parsererror')) return null;
    return parseMusicXML(doc);
  } catch (e) {
    return null;
  }
}

// Detect a pickup (anacrusis / lead-in) on the first measure of the
// MusicXML document. Returns the pickup length in beats (0 if there
// is none). Three signals, in order of trust:
//   1. <measure implicit="yes"> — explicitly marked.
//   2. <measure number="0">     — common engraver convention.
//   3. First measure's note durations sum to LESS than the time
//      signature's beat count AND the measure has at least one
//      pitched note.
// MuseScore exports usually set the first two signals; engravers
// that don't are caught by the duration check. False positives are
// limited to "first measure has a leading rest the same length as a
// pickup," which the duration sum would mistakenly call full — but
// if we reach the duration check it means neither metadata flag
// fired, so that case is rare and the user can override via
// songs/leadIns.json (future work).
function detectLeadIn(doc, beatsPerBar) {
  const score = doc.querySelector('score-partwise') || doc.querySelector('score-timewise');
  if (!score) return 0;
  const part = score.querySelector('part');
  if (!part) return 0;
  const firstMeasure = part.querySelector('measure');
  if (!firstMeasure) return 0;

  // If the caller didn't pass beatsPerBar, pull it from the doc's
  // first <time> declaration. Falls back to 4 (4/4) for documents
  // that don't declare a time signature explicitly.
  if (!Number.isFinite(beatsPerBar) || beatsPerBar <= 0) {
    const beatsEl = score.querySelector('attributes > time > beats');
    beatsPerBar = beatsEl ? (parseInt(beatsEl.textContent, 10) || 4) : 4;
  }

  // Helper: divisions-per-quarter from the score's first <attributes>
  // (or the measure itself if the file declares it inline).
  function divisionsFor(measure) {
    const local = measure.querySelector('attributes > divisions');
    if (local) return parseInt(local.textContent, 10) || 1;
    const global = score.querySelector('attributes > divisions');
    if (global) return parseInt(global.textContent, 10) || 1;
    return 1;
  }
  // Sum the duration of the measure's primary-voice notes / rests /
  // forward markers, in quarter-note beats. <chord/> notes don't
  // advance the cursor (they're simultaneous with the prior note),
  // so they're skipped.
  function measureBeats(measure) {
    const div = divisionsFor(measure);
    if (div <= 0) return 0;
    let totalDur = 0;
    measure.querySelectorAll(':scope > note, :scope > forward, :scope > backup').forEach(el => {
      if (el.tagName === 'note' && el.querySelector('chord')) return;
      // Skip non-voice-1 notes — most MusicXML keeps voice 1 as the
      // melody and parallel voices for harmony/accompaniment.
      if (el.tagName === 'note') {
        const v = el.querySelector('voice');
        if (v && parseInt(v.textContent, 10) !== 1) return;
      }
      const d = el.querySelector('duration');
      if (!d) return;
      const ticks = parseInt(d.textContent, 10) || 0;
      // <backup> moves the cursor back; for a beat-count we want
      // forward progress only.
      if (el.tagName === 'backup') totalDur -= ticks;
      else                          totalDur += ticks;
    });
    return totalDur / div;
  }

  // Strong signals from the engraver.
  if (firstMeasure.getAttribute('implicit') === 'yes') {
    return Math.max(0, measureBeats(firstMeasure));
  }
  if (firstMeasure.getAttribute('number') === '0') {
    return Math.max(0, measureBeats(firstMeasure));
  }
  // Weak signal: a short measure that contains at least one pitched
  // note. Pure-rest first measures (e.g. an intro silent bar) don't
  // qualify — those should be modeled as bar 1 of rests, not as a
  // pickup.
  const beats = measureBeats(firstMeasure);
  if (beats > 0 && beats < beatsPerBar) {
    const hasPitch = firstMeasure.querySelector('note > pitch') != null;
    if (hasPitch) return beats;
  }
  return 0;
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
          // A rest can be a tuplet member — MuseScore exports the
          // common "quarter-rest at the start of a quarter triplet"
          // pattern as a `<rest>` carrying `<notations><tuplet>` and
          // `<time-modification>`. If we just advance the cursor we
          // lose the start marker (the next note carries
          // `time-modification` but not `<tuplet type="start">`,
          // since the bracket starts on the rest), and the tuplet
          // bracket + proportional spacing get dropped — the bar
          // ends up with a step-count mismatch that the renderer
          // papers over with a row of fallback rest glyphs.
          let rTupletStart = false, rTupletStop = false;
          el.querySelectorAll('notations > tuplet').forEach(t => {
            const type = t.getAttribute('type');
            if (type === 'start') rTupletStart = true;
            else if (type === 'stop') rTupletStop = true;
          });
          const rTm = el.querySelector('time-modification');
          let rTupletActual = null, rTupletNormal = null;
          if (rTm) {
            const a = rTm.querySelector('actual-notes');
            const n = rTm.querySelector('normal-notes');
            if (a && n) {
              rTupletActual = parseInt(a.textContent, 10) || null;
              rTupletNormal = parseInt(n.textContent, 10) || null;
            }
          }
          if (rTupletActual && rTupletNormal) {
            const rTypeEl = el.querySelector('type');
            const rDisplayType = rTypeEl ? (rTypeEl.textContent || '').trim() : null;
            notes.push({
              stepStart: Math.round(cursor),
              durationSteps: dSteps,
              midi: null,
              tpc: null,
              rest: true,
              tieStart: false,
              tieStop: false,
              tupletStart: rTupletStart,
              tupletStop: rTupletStop,
              tupletActual: rTupletActual,
              tupletNormal: rTupletNormal,
              displayType: rDisplayType
            });
          }
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

  // Pickup detection: if the first measure is a lead-in, partition
  // the notes so the head's MAIN array starts cleanly at bar-1
  // downbeat (stepStart = 0), and stash the pickup notes separately
  // for a future render pass to draw before bar 1. Without this
  // partition, both the pickup notes (stepStart 0..pickupSteps-1)
  // AND the first real bar's notes (stepStart pickupSteps..) end up
  // mapped to bars[0] by `Math.floor(stepStart / stepsPerBar)`,
  // overlapping each other and rendering as a mess.
  const leadInBeats = detectLeadIn(doc);
  const leadInSteps = Math.round(leadInBeats * 6); // 24th-note grid
  const pickupNotes = [];
  let mainNotes = notes;
  if (leadInSteps > 0) {
    mainNotes = [];
    for (const n of notes) {
      if (n.stepStart < leadInSteps) {
        // Pickup note — keep its stepStart relative to the START of
        // the pickup measure so a future renderer can paint it.
        pickupNotes.push(n);
      } else {
        // Main note — shift left so bar 1 starts at stepStart=0,
        // matching how the renderer's iReal `bars[0]` lines up.
        mainNotes.push(Object.assign({}, n, {
          stepStart: n.stepStart - leadInSteps
        }));
      }
    }
  }
  // Score key — read once from the first measure's <key> attributes.
  // We use it to mark the Score-key button on the key seg with a
  // square outline (and auto-transpose the chart) whenever the
  // score's key differs from the iRealPro chart's key.
  const keyTonic = detectKeyTonicFromMusicXML(doc);
  const firstHarmony = parseFirstHarmonyFromMusicXML(doc);
  return { notes: mainNotes, leadInBeats, pickupNotes, keyTonic, firstHarmony };
}

// Read the MusicXML's <key><fifths> + <mode> from the first measure
// and convert it to a key-seg data-key string ('C', 'Bb', 'F#' …).
// Pitch class is derived from circle-of-fifths arithmetic; minor
// keys offset by +9 (relative-minor tonic). Returns null when the
// document has no key signature declaration.
// Convert a single <harmony> element into a minimal
// `{ root, rest }` chord object compatible with `chordToCanonical`.
// Returns null if the harmony lacks a recognizable root step.
function parseHarmonyElement(harmony) {
  if (!harmony) return null;
  const rootStep = harmony.querySelector('root > root-step');
  if (!rootStep) return null;
  const letter = rootStep.textContent.trim().toUpperCase();
  if (!/^[A-G]$/.test(letter)) return null;
  const rootAlter = harmony.querySelector('root > root-alter');
  let acc = '';
  if (rootAlter) {
    const a = parseInt(rootAlter.textContent, 10);
    if (a === 1) acc = '#';
    else if (a === -1) acc = 'b';
  }
  const kindEl = harmony.querySelector('kind');
  const kindText = kindEl ? (kindEl.getAttribute('text') || '').trim() : '';
  const kindValue = kindEl ? kindEl.textContent.trim().toLowerCase() : '';
  // Convert MusicXML kind value → iRealPro-style chord-rest token
  // suitable for `chordToCanonical`. Covers the common qualities
  // ports of MuseScore emit; falls back to bare root for anything
  // unrecognized.
  let rest = '';
  if (kindText) {
    rest = kindText;
  } else {
    switch (kindValue) {
      case 'major':                 rest = ''; break;
      case 'minor':                 rest = 'm'; break;
      case 'augmented':             rest = '+'; break;
      case 'diminished':            rest = 'dim'; break;
      case 'dominant':              rest = '7'; break;
      case 'major-seventh':         rest = 'Maj7'; break;
      case 'minor-seventh':         rest = 'm7'; break;
      case 'diminished-seventh':    rest = 'dim7'; break;
      case 'half-diminished':       rest = 'm7b5'; break;
      case 'augmented-seventh':     rest = '7#5'; break;
      case 'major-minor':           rest = 'mMaj7'; break;
      case 'major-sixth':           rest = '6'; break;
      case 'minor-sixth':           rest = 'm6'; break;
      case 'dominant-ninth':        rest = '9'; break;
      case 'major-ninth':           rest = 'Maj9'; break;
      case 'minor-ninth':           rest = 'm9'; break;
      case 'suspended-fourth':      rest = 'sus4'; break;
      case 'suspended-second':      rest = 'sus2'; break;
      case 'power':                 rest = '5'; break;
      default:                      rest = '';
    }
  }
  return { root: letter, rest: acc + rest };
}
// Read the FIRST <harmony> block in the document. Used for
// single-bar exercise licks (Lick 1, Lick 2 …) to determine the
// chord the lick was authored over.
function parseFirstHarmonyFromMusicXML(doc) {
  if (!doc) return null;
  const score = doc.querySelector('score-partwise') || doc.querySelector('score-timewise');
  if (!score) return null;
  return parseHarmonyElement(score.querySelector('harmony'));
}
// Read EVERY <harmony> element across the part with its position in
// 24th-note steps from the start of its containing measure. Returns
//   [{ measureIdx, stepInMeasure, chord: { root, rest } }, …]
// in document order. A measure with multiple chords (e.g. a
// compressed 251 like "Dm7 G7 | CMaj7" that puts the ii and V on
// beats 1 and 3 of bar 1) yields multiple entries with the same
// measureIdx but different stepInMeasure.
function parseHarmonyEvents(doc) {
  if (!doc) return [];
  const score = doc.querySelector('score-partwise') || doc.querySelector('score-timewise');
  if (!score) return [];
  const part = score.querySelector('part');
  if (!part) return [];
  const measures = part.querySelectorAll('measure');
  const out = [];
  let divisions = 1;
  for (let mi = 0; mi < measures.length; mi++) {
    const measure = measures[mi];
    // Track divisions changes (the same per-file logic parseMusicXML
    // uses). Note durations are converted to 24th-note steps via
    // (ticks * 6 / divisions), matching the rest of the pipeline.
    const divEl = measure.querySelector('attributes > divisions');
    if (divEl) divisions = parseInt(divEl.textContent, 10) || divisions;
    let stepInMeasure = 0;
    for (const el of Array.from(measure.children)) {
      const tag = el.tagName;
      if (tag === 'harmony') {
        const chord = parseHarmonyElement(el);
        if (chord) out.push({ measureIdx: mi, stepInMeasure, chord });
      } else if (tag === 'note') {
        const isChord = el.querySelector('chord') !== null;
        // Chord-linked notes don't advance the cursor (they sound
        // simultaneously with the previous note). Only advance for
        // the lead voice's primary line.
        if (isChord) continue;
        const voiceEl = el.querySelector('voice');
        const voice = voiceEl ? parseInt(voiceEl.textContent, 10) : 1;
        if (voice !== 1) continue;
        const dEl = el.querySelector('duration');
        const ticks = dEl ? (parseInt(dEl.textContent, 10) || 0) : 0;
        if (divisions > 0) stepInMeasure += ticks * 6 / divisions;
      } else if (tag === 'backup') {
        const dEl = el.querySelector('duration');
        const ticks = dEl ? (parseInt(dEl.textContent, 10) || 0) : 0;
        if (divisions > 0) stepInMeasure -= ticks * 6 / divisions;
      } else if (tag === 'forward') {
        const dEl = el.querySelector('duration');
        const ticks = dEl ? (parseInt(dEl.textContent, 10) || 0) : 0;
        if (divisions > 0) stepInMeasure += ticks * 6 / divisions;
      }
    }
  }
  return out;
}
// Backward-compat shim: returns the FIRST harmony per measure (used
// by the multi-bar 3-bar 251 path that authored its detection
// against a one-chord-per-measure assumption).
function parseHarmoniesByMeasure(doc) {
  const events = parseHarmonyEvents(doc);
  const seen = new Set();
  const out = [];
  for (const ev of events) {
    if (seen.has(ev.measureIdx)) continue;
    seen.add(ev.measureIdx);
    out.push({ measureIdx: ev.measureIdx, chord: ev.chord });
  }
  return out;
}
// Read the FIRST <time> block in the document → {num, den}.
// Defaults to 4/4 when the file omits a time signature. Used by
// multi-bar lick parsing to compute stepsPerBar at the 24th-note
// grid resolution.
function parseTimeSignatureFromMusicXML(doc) {
  if (!doc) return { num: 4, den: 4 };
  const time = doc.querySelector('time');
  if (!time) return { num: 4, den: 4 };
  const beatsEl = time.querySelector('beats');
  const beatTypeEl = time.querySelector('beat-type');
  const num = beatsEl ? (parseInt(beatsEl.textContent, 10) || 4) : 4;
  const den = beatTypeEl ? (parseInt(beatTypeEl.textContent, 10) || 4) : 4;
  return { num, den };
}

function detectKeyTonicFromMusicXML(doc) {
  if (!doc) return null;
  const score = doc.querySelector('score-partwise') || doc.querySelector('score-timewise');
  if (!score) return null;
  const part = score.querySelector('part');
  if (!part) return null;
  const firstMeasure = part.querySelector('measure');
  if (!firstMeasure) return null;
  const fifthsEl = firstMeasure.querySelector('attributes > key > fifths');
  if (!fifthsEl) return null;
  const fifths = parseInt(fifthsEl.textContent, 10);
  if (!Number.isFinite(fifths) || fifths < -7 || fifths > 7) return null;
  const modeEl = firstMeasure.querySelector('attributes > key > mode');
  const isMinor = !!(modeEl && /minor/i.test(modeEl.textContent));
  // Major tonic pc: each fifth up = +7 semitones (mod 12).
  const majorPc = (((fifths * 7) % 12) + 12) % 12;
  // Minor tonic = relative minor of the major (3 semitones below the
  // major tonic, equivalently +9 mod 12).
  const tonicPc = isMinor ? ((majorPc + 9) % 12) : majorPc;
  // Map pc to one of the seg's 12 data-key strings. The seg uses
  // sharp spellings for the four "black-key" tonics that don't have
  // dedicated buttons (C#/Eb/F#/G#/Bb), regardless of major/minor —
  // syncKeySegLabels handles the visual sharp↔flat alias.
  const PC_TO_DATAKEY = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'G#', 'A', 'Bb', 'B'];
  return PC_TO_DATAKEY[tonicPc];
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
    const filename = await resolveSongFilename(title, 'mid');
    if (!filename) return null;
    const url = `songs/${encodeURIComponent(filename)}`;
    // `cache: 'no-store'` for the same reason as loadSongMusicXML —
    // these stable URLs would otherwise stay pinned to a stale
    // browser cache entry across edits and deletions.
    const response = await fetch(url, { cache: 'no-store' });
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
    return pickEffectiveScale(ce, pat);
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
      // Rest entries (tuplet rest members) carry no pitch — skip
      // them when finding the lowest pitched note for the
      // octave-fit calculation.
      if (n.rest) continue;
      const p = n.midi + rawOffset;
      if (p < minAfter) minAfter = p;
    }
    const octShift = Math.ceil((EX_LOW - minAfter) / 12) * 12;
    totalShift = rawOffset + octShift;
  }
  const transposedNotes = head.notes.map(n => {
    // Rest tuplet members pass straight through — no pitch math.
    if (n.rest) {
      return {
        stepStart: n.stepStart,
        durationSteps: n.durationSteps,
        rest: true,
        tieStart: false,
        tieStop: false,
        tupletStart: n.tupletStart,
        tupletStop: n.tupletStop,
        tupletActual: n.tupletActual,
        tupletNormal: n.tupletNormal,
        displayType: n.displayType,
        midi: null,
        tpc: null
      };
    }
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
      rest: false,
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
        // Rest tuplet members render as a rest tickable inside the
        // tuplet group (see the renderer for the StaveNote build).
        rest: !!note.rest,
        tieFromPrev: !note.rest && !!note.tieStop,
        tieToNext:   !note.rest && !!note.tieStart,
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

// Exercise-lick generator. Each bar of the song plays the cached
// lick (parsed from a "Exercise - …" .musicxml / .mid file)
// transposed so the lick's source root maps to the bar's first
// chord root. The lick's source root comes from the file's key
// signature (parsed `keyTonic`); the per-bar target root comes
// from `bars[i].chords[0]` — multi-chord bars use just the FIRST
// chord, per the user's spec.
//
// Pitch math: `semiDelta = target_pc - source_pc`, `tpcDelta =
// target_tpc - source_tpc`. So a lick written as `E F B A D C`
// over CMaj (sourceRoot=C) becomes `F♯ G C♯ B E D` over a Dmaj7
// bar (target root D), with TPCs preserved as the chord's spelling.
//
// Octave-fit: applied per-bar — find the lowest transposed pitch
// and shift the whole bar's lick by ±12n so the lowest note lands
// in [EX_LOW, EX_LOW+11]. Each bar is independent so a song with
// chords across the cello range has each bar's lick well-placed.
function generateExerciseLickQuarterNotes(bars, ts) {
  const beatsPerBar = ts.num;
  const stepsPerBar = beatsPerBar * 6; // 24th-note grid, like Head mode
  const chordEvents = buildChordEventList(bars);
  const patterns = detectKeyPatterns(chordEvents);
  const effective = chordEvents.map((ce, i) => {
    const pat = patterns.find(p => i >= p.firstIdx && i <= p.lastIdx);
    return pickEffectiveScale(ce, pat);
  });

  const results = bars.map(() => new Array(stepsPerBar).fill(null));

  // Pull the chosen lick out of the cache. The dropdown change
  // handler pre-loads via loadExerciseLick before triggering the
  // rerender, so a hit is the common case; a miss returns empty
  // results (the chart will render bars of rests until the load
  // finishes and a follow-up rerender catches up).
  const lickFilename = (typeof exerciseMode === 'string' && exerciseMode.startsWith('lick:'))
    ? exerciseMode.slice(5) : '';
  const lick = lickFilename ? _exerciseLickCache.get(lickFilename) : null;
  if (!lick) {
    return { results, chordEvents, patterns, effective, subdivisions: 6 };
  }

  const DUR_FITS = [
    { dur: 'w',  steps: 24 },
    { dur: 'h.', steps: 18 },
    { dur: 'h',  steps: 12 },
    { dur: 'q.', steps: 9 },
    { dur: 'q',  steps: 6 },
    { dur: '8',  steps: 3 }
  ];
  // MusicXML <type> → VexFlow duration token. Used for tuplet members
  // whose raw <duration> ticks don't equal a standard note value.
  const TYPE_TO_VF = {
    'whole': 'w', 'half': 'h', 'quarter': 'q', 'eighth': '8', '16th': '16', '32nd': '32'
  };

  // Helper: emit a single transposed note into a target bar's slot
  // grid. Handles tuplet members (single-slot with `tuplet` descriptor
  // + `stepsConsumed`) AND non-tuplet notes (DUR_FITS chunking with
  // ties between chunks). Shared by single-bar and multi-bar paths.
  function emitNoteIntoBar(targetBarIdx, n) {
    const stepInBar = n.stepStart;
    if (stepInBar < 0 || stepInBar >= stepsPerBar) return;
    if (n.tupletActual && n.tupletNormal && n.displayType) {
      if (results[targetBarIdx][stepInBar]) return;
      const stepsConsumed = Math.max(1, Math.round(n.durationSteps));
      const vfDur = TYPE_TO_VF[n.displayType] || 'q';
      results[targetBarIdx][stepInBar] = {
        pitch: n.rest ? null : n.midi,
        tpc:   n.rest ? null : n.tpc,
        duration: vfDur,
        stepsConsumed,
        rest: !!n.rest,
        tieFromPrev: !n.rest && !!n.tieStop,
        tieToNext:   !n.rest && !!n.tieStart,
        tuplet: {
          start: !!n.tupletStart,
          stop:  !!n.tupletStop,
          actual: n.tupletActual,
          normal: n.tupletNormal
        }
      };
      return;
    }
    const totalSteps = Math.max(1, Math.round(n.durationSteps || 6));
    let remaining = Math.min(totalSteps, stepsPerBar - stepInBar);
    let cur = stepInBar;
    let first = true;
    while (remaining > 0) {
      const opt = DUR_FITS.find(f => f.steps <= remaining);
      if (!opt) break;
      if (results[targetBarIdx][cur]) break;
      const isLastInChunk = (remaining === opt.steps);
      // Tie flags carry TWO independent meanings: within-note
      // chunking ties (a long note split into pieces, glued back
      // visually with arcs) and cross-note source ties (an explicit
      // <tie> in the MusicXML connecting THIS note to a different
      // note). Both are emitted via the same `tieFromPrev` /
      // `tieToNext` fields, so we OR them:
      //   - tieFromPrev: true on any non-first chunk OR on the very
      //     first chunk if the source said this note continues from
      //     a prior tie (tieStop).
      //   - tieToNext: true on any non-last chunk OR on the very
      //     last chunk if the source said this note continues into
      //     a following tie (tieStart).
      // Without the cross-note half, Quote ties (e.g. Quote 2's
      // bar-1 eighth into bar-2's whole) lose their visual arc.
      const isPitched = !n.rest;
      results[targetBarIdx][cur] = {
        pitch: n.rest ? null : n.midi,
        tpc:   n.rest ? null : n.tpc,
        duration: opt.dur,
        rest: !!n.rest,
        tieFromPrev: (!first) || (isPitched && first && !!n.tieStop),
        tieToNext:   (!isLastInChunk) || (isPitched && isLastInChunk && !!n.tieStart)
      };
      cur += opt.steps;
      remaining -= opt.steps;
      first = false;
    }
  }

  // Octave-fit a transposed bar of notes into the cello range. Shifts
  // every note by the same ±12n so the lowest pitched note lands in
  // [EX_LOW, EX_LOW+11].
  function octaveFit(transposed) {
    let minPitch = Infinity;
    for (const n of transposed) {
      if (n.midi != null && n.midi < minPitch) minPitch = n.midi;
    }
    let octShift = 0;
    if (minPitch < Infinity) {
      while (minPitch + octShift < EX_LOW) octShift += 12;
      while (minPitch + octShift > EX_LOW + 11) octShift -= 12;
      if (minPitch + octShift < EX_LOW) octShift += 12;
    }
    if (octShift !== 0) {
      for (const n of transposed) {
        if (n.midi != null) n.midi += octShift;
      }
    }
  }

  // ---- Quote path ----
  // The lick file is a "Quote N.musicxml" — a short multi-bar
  // phrase whose chord-relative shape walks THROUGH the song's
  // form one bar at a time. Each source bar's annotated notes get
  // scale-step-transposed (stepIdx + alteration against the source
  // bar's chord → looked up in the target song bar's chord scale)
  // and placed on the song bar at the same offset within the
  // current repetition window. The pattern repeats across the
  // whole form: a 2-bar quote covers bars 0-1, then 2-3, then
  // 4-5, etc. Bars not covered (remainder when bars % numQuoteBars
  // isn't zero) are left as rests.
  if (lick.isQuote && Array.isArray(lick.barNotes) && lick.barNotes.length) {
    const numQuoteBars = lick.barNotes.length;
    // Walk backwards through `repeatPrev` links (iRealPro's Kcl / x)
    // until we find a bar that actually carries chord symbols. A
    // chord held over multiple measures might be written explicitly
    // (each bar has its own `chords` entry) OR shorthanded with a
    // repeat marker on every measure after the first. The shorthand
    // leaves `bars[bi].chords` empty, and without this fallback the
    // Quote path would skip those bars entirely — the symptom the
    // user reported as "no note on the second measure of a held
    // chord". Mirrors the same chord-resolution `buildChordEventList`
    // does for the chordEvent list.
    function resolveBarFirstChord(barIdx) {
      let cursor = barIdx;
      while (cursor >= 0 && cursor < bars.length) {
        const b = bars[cursor];
        const ch = (b.chords || []).find(c => c && !c.slash && !c.nc);
        if (ch) return ch;
        if (!b.repeatPrev || cursor - b.repeatPrev < 0) return null;
        cursor -= b.repeatPrev;
      }
      return null;
    }
    // Helpers used per-chunk to track inter-bar voice-leading.
    const firstPitched = (notes) => {
      for (const n of notes) {
        if (!n.rest && typeof n.midi === 'number') return n.midi;
      }
      return null;
    };
    const lastPitched = (notes) => {
      for (let k = notes.length - 1; k >= 0; k--) {
        const n = notes[k];
        if (!n.rest && n.midi != null) return n.midi;
      }
      return null;
    };

    // === 3579 projection ===
    // Plays the lick's rhythm against a sawtooth walk through 3-5-7-9
    // chord tones — same logic as the 3579 Range exercise, but the
    // walk advances ONCE PER CHORD EVENT (not per beat), and the
    // lick's onsets decide when those notes sound.
    //
    // Pre-pass walks chordEvents in song order:
    //   - For each event, build the in-range 3/5/7/9 candidates.
    //   - First event: take the lowest, set direction = ascending.
    //   - Ascending events: next candidate ABOVE prev. If none in
    //     range, flip direction and take the closest BELOW.
    //   - Descending events: mirror image.
    //   - On boundary failures (extremes of F1..F3), fall back to
    //     the candidate closest to prev's pitch.
    //
    // Apply pass: for each song bar's source notes, look up the
    // chord event that owns each pitched note's beat and emit that
    // event's pre-picked pitch. Rest events stay rests.
    if (_lickProjectionMode === '3579') {
      function chordToneOptions(ce) {
        const chordScale = exGetScale(chordToCanonical(ce.chord));
        if (!chordScale || chordScale.length === 0) return [];
        const rootPc = ce.root.pitchClass;
        const rootTpc = ce.root.tpc;
        const degIdxs = [2, 4, 6, 8]; // 3, 5, 7, 9 (HW-remap aware)
        const opts = [];
        for (const di of degIdxs) {
          const ridx = diatonicIndexInScale(di, chordScale);
          const oct = Math.floor(ridx / chordScale.length);
          const sd  = chordScale[ridx % chordScale.length];
          const pc  = (((rootPc + sd.s + oct * 12) % 12) + 12) % 12;
          const tpc = rootTpc + sd.t;
          for (let p = EX_LOW; p <= EX_HIGH; p++) {
            if ((((p % 12) + 12) % 12) === pc) opts.push({ pitch: p, tpc });
          }
        }
        opts.sort((a, b) => a.pitch - b.pitch);
        return opts;
      }

      const pitchByCe = new Map();
      let direction = 1;
      let lastPitch = -1;
      for (const ce of chordEvents) {
        const opts = chordToneOptions(ce);
        if (opts.length === 0) continue;
        let chosen = null;
        if (lastPitch < 0) {
          chosen = opts[0];
          direction = 1;
        } else if (direction > 0) {
          chosen = opts.find(o => o.pitch > lastPitch);
          if (!chosen) {
            direction = -1;
            for (let i = opts.length - 1; i >= 0; i--) {
              if (opts[i].pitch < lastPitch) { chosen = opts[i]; break; }
            }
          }
        } else {
          for (let i = opts.length - 1; i >= 0; i--) {
            if (opts[i].pitch < lastPitch) { chosen = opts[i]; break; }
          }
          if (!chosen) {
            direction = 1;
            chosen = opts.find(o => o.pitch > lastPitch);
          }
        }
        if (!chosen) {
          // Pinned at a boundary — fall back to closest 3/5/7/9.
          chosen = opts[0];
          for (let i = 1; i < opts.length; i++) {
            if (Math.abs(opts[i].pitch - lastPitch) < Math.abs(chosen.pitch - lastPitch)) {
              chosen = opts[i];
            }
          }
        }
        pitchByCe.set(ce, chosen);
        lastPitch = chosen.pitch;
      }

      function findChordEventAtBeat(barIdx, beat) {
        for (const ce of chordEvents) {
          if (ce.barIdx !== barIdx) continue;
          const r = chordBeatRange(ce.chordsInBar, ce.chordIdxInBar, beatsPerBar);
          if (beat >= r.startBeat && beat < r.endBeat) return ce;
        }
        return null;
      }

      for (let songBarIdx = 0; songBarIdx < bars.length; songBarIdx++) {
        const q = songBarIdx % numQuoteBars;
        const sourceNotes = lick.barNotes[q];
        if (!sourceNotes || !sourceNotes.length) continue;
        const transposed = [];
        for (const n of sourceNotes) {
          if (typeof n.stepStart !== 'number') {
            transposed.push(Object.assign({}, n, { midi: null, tpc: null }));
            continue;
          }
          if (n.rest) {
            transposed.push(Object.assign({}, n, { midi: null, tpc: null }));
            continue;
          }
          // useNextBarChord ties honour the next bar's first chord;
          // every other note uses the chord active at its own beat.
          let ce = null;
          if (n.useNextBarChord) {
            const nb = songBarIdx + 1;
            if (nb < bars.length) {
              for (const c of chordEvents) {
                if (c.barIdx !== nb) continue;
                const r = chordBeatRange(c.chordsInBar, c.chordIdxInBar, beatsPerBar);
                if (r.startBeat === 0) { ce = c; break; }
              }
            }
          } else {
            const beat = Math.floor(n.stepStart / 6);
            ce = findChordEventAtBeat(songBarIdx, beat);
          }
          const placed = ce ? pitchByCe.get(ce) : null;
          if (!placed) {
            transposed.push(Object.assign({}, n, { midi: null, tpc: null }));
            continue;
          }
          transposed.push(Object.assign({}, n, {
            midi: placed.pitch, tpc: placed.tpc
          }));
        }
        for (const tn of transposed) emitNoteIntoBar(songBarIdx, tn);
      }
      return { results, chordEvents, patterns, effective, subdivisions: 6 };
    }

    // === Scale projection ===
    // Use the source lick PURELY for rhythm. We pre-compute a
    // CONTINUOUS scale walk across the whole song at eighth-note
    // resolution — same algorithm as the Scale Notes exercise
    // (generateQuarterNotes), just with 2× the slots per bar and a
    // direction that reverses at the cello range extremes. The walk
    // ascends until it hits the top of F1..F3, then descends, then
    // ascends again, so the line breathes across the whole form
    // instead of restarting at each bar's root.
    //
    // Once the per-bar slot table is built, the lick's rhythm masks
    // it: each source note's stepStart picks an eighth-note slot of
    // its bar (slot = floor(stepStart / 3) on the 24th-note grid),
    // and we emit either the slot's scale pitch (for pitched events)
    // or a rest (for rest events), preserving the source's duration.
    if (_lickProjectionMode === 'scale') {
      const numSlotsPerBar = beatsPerBar * 2;
      const barSlots = bars.map(() => new Array(numSlotsPerBar).fill(null));

      let direction = -1;
      let tones = [];
      let toneIdx = 0;
      let lastPitch = -1;
      let lastTpc = -1;
      let lastSig = null;

      chordEvents.forEach((ce, i) => {
        const eff = effective[i];
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

        const { startBeat, endBeat } = chordBeatRange(ce.chordsInBar, ce.chordIdxInBar, beatsPerBar);
        const startSlot = startBeat * 2;
        const endSlot   = endBeat * 2;
        for (let s = startSlot; s < endSlot; s++) {
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
          barSlots[ce.barIdx][s] = { pitch: p, tpc: t };
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

      // Apply the source's rhythm to each song bar, masking the
      // pre-computed walk. Multi-bar quotes repeat: song bar N uses
      // source bar N % numQuoteBars.
      for (let songBarIdx = 0; songBarIdx < bars.length; songBarIdx++) {
        const q = songBarIdx % numQuoteBars;
        const sourceNotes = lick.barNotes[q];
        if (!sourceNotes || !sourceNotes.length) continue;
        const slots = barSlots[songBarIdx];
        if (!slots) continue;
        const transposed = [];
        for (const n of sourceNotes) {
          if (typeof n.stepStart !== 'number') {
            transposed.push(Object.assign({}, n, { midi: null, tpc: null }));
            continue;
          }
          if (n.rest) {
            transposed.push(Object.assign({}, n, { midi: null, tpc: null }));
            continue;
          }
          const slotIdx = Math.floor(n.stepStart / 3);
          const sc = slots[Math.max(0, Math.min(numSlotsPerBar - 1, slotIdx))];
          if (!sc) {
            transposed.push(Object.assign({}, n, { midi: null, tpc: null }));
            continue;
          }
          transposed.push(Object.assign({}, n, { midi: sc.pitch, tpc: sc.tpc }));
        }
        for (const tn of transposed) emitNoteIntoBar(songBarIdx, tn);
      }
      return { results, chordEvents, patterns, effective, subdivisions: 6 };
    }

    for (let startBar = 0; startBar < bars.length; startBar += numQuoteBars) {
      // Per-quote-application state. Tracks the last pitched note
      // we just emitted (target) and the last pitched note from
      // the corresponding source bar, so each subsequent source-bar
      // can compute the expected "delta" and pick the target octave
      // that matches it most closely. Reset at the top of every
      // chunk so quote applications don't drift across repetitions.
      let prevTargetLast = null;
      let prevSourceLast = null;
      for (let q = 0; q < numQuoteBars; q++) {
        const songBarIdx = startBar + q;
        if (songBarIdx >= bars.length) break;
        const sourceNotes = lick.barNotes[q];
        if (!sourceNotes || !sourceNotes.length) continue;
        // Target chord: the song bar's first live chord, with Kcl /
        // repeat-prev fallback handled by `resolveBarFirstChord`.
        const firstChord = resolveBarFirstChord(songBarIdx);
        if (!firstChord) continue;
        // Per-note target resolver. Most notes use the current song
        // bar's chord, but a tied-across-bar source note (annotated
        // with useNextBarChord at load time) needs the FOLLOWING
        // song bar's chord so its scale-step role carries through —
        // the bar-1 eighth of Quote 2 is "the 3 of Dm7", and over
        // a target Em7 → Am7 it should become "the 3 of Am7" = C,
        // not "the b6 of Em7" = C natural by coincidence elsewhere.
        const resolveNoteTarget = (n) => {
          const bi = n.useNextBarChord ? songBarIdx + 1 : songBarIdx;
          if (bi < 0 || bi >= bars.length) return null;
          const ch = (bi === songBarIdx)
            ? firstChord
            : resolveBarFirstChord(bi);
          if (!ch) return null;
          const canonical = chordToCanonical(ch);
          const root = exParseRoot(canonical);
          const scale = exGetScale(canonical);
          if (!root || !scale || !scale.length) return null;
          return { root, scale };
        };
        const defaultTarget = resolveNoteTarget({ useNextBarChord: false });
        if (!defaultTarget) continue;

        // Scale-step transposition: each source note's stepIdx is
        // resolved in the TARGET chord's scale, so a Gm6 b3 (= step
        // 2 of Dorian) over a target G7 becomes step 2 of Mixolydian
        // = natural 3 (B), not Bb. octaveOffset gives the initial
        // pitch; the per-bar shift below adjusts the whole bar's
        // register to preserve the source's inter-bar interval.
        const transposed = [];
        for (const n of sourceNotes) {
          if (n.rest || typeof n.midi !== 'number' || n.stepIdx == null) {
            transposed.push(Object.assign({}, n, { midi: null, tpc: null }));
            continue;
          }
          const tgt = resolveNoteTarget(n) || defaultTarget;
          const targetRoot = tgt.root;
          const targetScale = tgt.scale;
          // Translate the source's diatonic-step index into the
          // target scale's actual index. For 7-note scales this is
          // a no-op, but for HW Diminished (8 notes — the b9 chord
          // scale) step 2 remaps to HW index 3 so a "b3 of Cm7"
          // lands on the chord's MAJOR 3rd (F♯ on D7♭9) instead of
          // the b3/♯9 passing tone (F). Same fix the 1235 / 3579
          // arpeggio generators already use.
          const realIdx = diatonicIndexInScale(n.stepIdx, targetScale);
          const len = targetScale.length;
          const sd = targetScale[((realIdx % len) + len) % len];
          const alt = n.alteration || 0;
          const newSemi = sd.s + alt;
          const newTpc = sd.t + alt * 7;
          const newMidi = (n.octaveOffset || 0) * 12 + targetRoot.pitchClass + newSemi;
          const finalTpc = targetRoot.tpc + newTpc;
          transposed.push(Object.assign({}, n, { midi: newMidi, tpc: finalTpc }));
        }

        // Tied-out notes (annotated against the NEXT bar's chord)
        // sit at whatever octave the next-chord's math produced.
        // That can land them in a different register from the rest
        // of this bar — e.g. Quote 4's bar-2 G2 is annotated as
        // "the 5 of C7" → C3 over F7, while the rest of bar 2 sits
        // around F2. Treating them like regular bar notes lets one
        // outlier note pull the whole bar's voice-leading anchor
        // sky-high. So we exclude tied-out notes from both the
        // shift-validity range check and the shift application,
        // and post-pass them to land at the octave closest to the
        // bar's other notes.
        const tiedOutMask = transposed.map(n => !!n.useNextBarChord);
        const firstPitchedSkip = (notes, mask) => {
          for (let k = 0; k < notes.length; k++) {
            if (mask && mask[k]) continue;
            const n = notes[k];
            if (!n.rest && typeof n.midi === 'number') return n.midi;
          }
          return null;
        };

        if (q === 0 || prevTargetLast == null || prevSourceLast == null) {
          // First bar of the chunk (or no prior pitched anchor):
          // ordinary octave-fit using the bar's non-tied-out notes
          // so the line starts inside the cello range. The tied-out
          // notes keep their raw "next-chord" pitch until the
          // post-pass below adjusts them.
          let minPitch = Infinity;
          for (let k = 0; k < transposed.length; k++) {
            if (tiedOutMask[k]) continue;
            const n = transposed[k];
            if (n.midi != null && n.midi < minPitch) minPitch = n.midi;
          }
          let octShift = 0;
          if (minPitch < Infinity) {
            while (minPitch + octShift < EX_LOW) octShift += 12;
            while (minPitch + octShift > EX_LOW + 11) octShift -= 12;
            if (minPitch + octShift < EX_LOW) octShift += 12;
          }
          if (octShift !== 0) {
            for (let k = 0; k < transposed.length; k++) {
              if (tiedOutMask[k]) continue;
              const n = transposed[k];
              if (n.midi != null) n.midi += octShift;
            }
          }
        } else {
          // Subsequent bar: preserve the source's last-to-first
          // interval direction by choosing the octave of THIS
          // bar's first pitched note that most closely matches the
          // source delta from `prevSourceLast`. Then shift the
          // non-tied-out notes by the chosen offset (tied-out
          // notes are handled in the post-pass).
          const sourceFirst = firstPitched(sourceNotes);
          const targetFirstRaw = firstPitchedSkip(transposed, tiedOutMask);
          if (sourceFirst != null && targetFirstRaw != null) {
            const sourceDelta = sourceFirst - prevSourceLast;
            let bestPitch = targetFirstRaw;
            let bestErr = Math.abs(sourceDelta - (targetFirstRaw - prevTargetLast));
            for (let octShift = -36; octShift <= 36; octShift += 12) {
              if (octShift === 0) continue;
              const candidate = targetFirstRaw + octShift;
              if (candidate < EX_LOW || candidate > EX_HIGH) continue;
              // Reject only if the whole-bar shift would push a
              // NON-tied-out note out of range. Tied-out notes
              // don't participate — they get re-anchored later.
              let ok = true;
              for (let k = 0; k < transposed.length; k++) {
                if (tiedOutMask[k]) continue;
                const tn = transposed[k];
                if (tn.midi == null) continue;
                const p = tn.midi + octShift;
                if (p < EX_LOW || p > EX_HIGH) { ok = false; break; }
              }
              if (!ok) continue;
              const candDelta = candidate - prevTargetLast;
              const err = Math.abs(sourceDelta - candDelta);
              if (err < bestErr) {
                bestErr = err;
                bestPitch = candidate;
              }
            }
            const shift = bestPitch - targetFirstRaw;
            if (shift !== 0) {
              for (let k = 0; k < transposed.length; k++) {
                if (tiedOutMask[k]) continue;
                const tn = transposed[k];
                if (tn.midi != null) tn.midi += shift;
              }
            }
          } else {
            // Source or target bar had no pitched notes — fall
            // back to plain octave-fit.
            octaveFit(transposed);
          }
        }

        // Post-pass: anchor each tied-out note to the octave
        // closest to the bar's RUNNING non-tied-out pitch. This is
        // the "Quote 4 bar-2 G2 → C2 instead of C3" fix — the
        // tied-out note plays out the end of the bar, so it should
        // sit with the bar's other notes, not at whatever octave
        // its next-chord scale-step math produced. The next bar's
        // first note (the tied:stop continuation) then voice-leads
        // from this placed pitch and lands on the same pitch
        // naturally, preserving the tied chain at a unified
        // register.
        let runningPitch = (prevTargetLast != null) ? prevTargetLast : 41;
        for (let k = 0; k < transposed.length; k++) {
          const tn = transposed[k];
          if (tn.midi == null) continue;
          if (tiedOutMask[k]) {
            let bestP = tn.midi;
            let bestD = Math.abs(tn.midi - runningPitch);
            for (let octShift = -36; octShift <= 36; octShift += 12) {
              if (octShift === 0) continue;
              const cand = tn.midi + octShift;
              if (cand < EX_LOW || cand > EX_HIGH) continue;
              const d = Math.abs(cand - runningPitch);
              if (d < bestD) {
                bestD = d;
                bestP = cand;
              }
            }
            tn.midi = bestP;
            // Don't update runningPitch — tied-out notes don't
            // anchor subsequent non-tied notes (and they're
            // typically the last note of the bar anyway).
          } else {
            runningPitch = tn.midi;
          }
        }

        // Update voice-leading anchors for the next bar in chunk.
        // We DO include the tied-out's placed pitch in
        // prevTargetLast so the next bar's first note (the tied
        // continuation) voice-leads to the same pitch.
        const srcLast = lastPitched(sourceNotes);
        const tgtLast = lastPitched(transposed);
        if (srcLast != null) prevSourceLast = srcLast;
        if (tgtLast != null) prevTargetLast = tgtLast;

        for (const tn of transposed) emitNoteIntoBar(songBarIdx, tn);
      }
    }
    return { results, chordEvents, patterns, effective, subdivisions: 6 };
  }

  // ---- Multi-bar 251 lick path ----
  // The lick file declared a CMaj7-style ii-V-I (or ii°-V-i)
  // progression in its <harmony> tags. Scan the song for matching
  // 251/25/51 segments and apply the lick's bars to them. The
  // single-bar transposition logic below is bypassed entirely in
  // this mode — bars not part of any matched segment are left as
  // rests (the lick is keyed to the progression, not to individual
  // chords).
  if (lick.multiBar && lick.pattern251) {
    const isP4Up = (a, b) => b === (a + 5) % 12;
    // Single-chord-per-bar event lookup (for expanded matching).
    function singleChordEventForBar(bi) {
      if (bi < 0 || bi >= bars.length) return null;
      const cs = (bars[bi].chords || []).filter(c => c && !c.slash && !c.nc);
      if (cs.length !== 1) return null;
      const ch = cs[0];
      const root = exParseRoot(chordToCanonical(ch));
      if (!root) return null;
      return { chord: ch, root, type: getChordType(chordToCanonical(ch)) };
    }
    // First-two-chords-of-bar lookup (for compressed matching). The
    // bar must contain at least 2 live chords; we use the first two.
    function firstTwoChordEventsOfBar(bi) {
      if (bi < 0 || bi >= bars.length) return null;
      const cs = (bars[bi].chords || []).filter(c => c && !c.slash && !c.nc);
      if (cs.length < 2) return null;
      const ev = (ch) => {
        const root = exParseRoot(chordToCanonical(ch));
        if (!root) return null;
        return { chord: ch, root, type: getChordType(chordToCanonical(ch)) };
      };
      const a = ev(cs[0]), b = ev(cs[1]);
      if (!a || !b) return null;
      return [a, b];
    }
    // Greedy non-overlapping segment scan; behaviour depends on the
    // lick's structural shape.
    const used = bars.map(() => false);
    const segments = [];
    if (lick.pattern251.shape === 'compressed') {
      // Lick layout: | ii  V |  I  |. Only match song bars with the
      // same shape — a 2-chord ii-V bar followed by a 1-chord I bar.
      // Looser shapes (e.g. expanded ii | V | I) are NOT matched
      // here because the lick's per-bar note positions assume the
      // ii and V share one bar; squeezing or stretching them would
      // misalign the line.
      for (let i = 0; i <= bars.length - 2; i++) {
        if (used[i] || used[i+1]) continue;
        const pair = firstTwoChordEventsOfBar(i);
        const ev3 = singleChordEventForBar(i+1);
        if (!pair || !ev3) continue;
        const [ev1, ev2] = pair;
        if (!isP4Up(ev1.root.pitchClass, ev2.root.pitchClass)) continue;
        if (!isP4Up(ev2.root.pitchClass, ev3.root.pitchClass)) continue;
        let mode = null;
        if (ev1.type === 'minor' && ev2.type === 'dominant' && ev3.type === 'major') mode = 'major';
        else if (ev1.type === 'halfdim' && ev2.type === 'dominant' && ev3.type === 'minor') mode = 'minor';
        if (!mode) continue;
        segments.push({
          lickBars: [0, 1], songBars: [i, i+1],
          mode, targetTonic: ev3.root
        });
        used[i] = used[i+1] = true;
      }
      // Compressed-25: a 2-chord ii-V bar with no resolution on the
      // next bar. Use just lick bar 0 (the ii+V notes).
      for (let i = 0; i < bars.length; i++) {
        if (used[i]) continue;
        const pair = firstTwoChordEventsOfBar(i);
        if (!pair) continue;
        const [ev1, ev2] = pair;
        if (!isP4Up(ev1.root.pitchClass, ev2.root.pitchClass)) continue;
        let mode = null;
        if (ev1.type === 'minor' && ev2.type === 'dominant') mode = 'major';
        else if (ev1.type === 'halfdim' && ev2.type === 'dominant') mode = 'minor';
        if (!mode) continue;
        const tonic = {
          pitchClass: (ev2.root.pitchClass + 5) % 12,
          tpc: ev2.root.tpc - 1
        };
        segments.push({
          lickBars: [0], songBars: [i],
          mode, targetTonic: tonic
        });
        used[i] = true;
      }
    } else {
      // Expanded 251: scan longest first → 251 (3 bars) → 25 → 51.
      for (let i = 0; i <= bars.length - 3; i++) {
        if (used[i] || used[i+1] || used[i+2]) continue;
        const ev1 = singleChordEventForBar(i);
        const ev2 = singleChordEventForBar(i+1);
        const ev3 = singleChordEventForBar(i+2);
        if (!ev1 || !ev2 || !ev3) continue;
        if (!isP4Up(ev1.root.pitchClass, ev2.root.pitchClass)) continue;
        if (!isP4Up(ev2.root.pitchClass, ev3.root.pitchClass)) continue;
        let mode = null;
        if (ev1.type === 'minor' && ev2.type === 'dominant' && ev3.type === 'major') mode = 'major';
        else if (ev1.type === 'halfdim' && ev2.type === 'dominant' && ev3.type === 'minor') mode = 'minor';
        if (!mode) continue;
        segments.push({
          lickBars: [0, 1, 2], songBars: [i, i+1, i+2],
          mode, targetTonic: ev3.root
        });
        used[i] = used[i+1] = used[i+2] = true;
      }
      for (let i = 0; i <= bars.length - 2; i++) {
        if (used[i] || used[i+1]) continue;
        const ev1 = singleChordEventForBar(i);
        const ev2 = singleChordEventForBar(i+1);
        if (!ev1 || !ev2) continue;
        if (!isP4Up(ev1.root.pitchClass, ev2.root.pitchClass)) continue;
        let mode = null;
        if (ev1.type === 'minor' && ev2.type === 'dominant') mode = 'major';
        else if (ev1.type === 'halfdim' && ev2.type === 'dominant') mode = 'minor';
        if (!mode) continue;
        const tonic = {
          pitchClass: (ev2.root.pitchClass + 5) % 12,
          tpc: ev2.root.tpc - 1
        };
        segments.push({
          lickBars: [0, 1], songBars: [i, i+1],
          mode, targetTonic: tonic
        });
        used[i] = used[i+1] = true;
      }
      for (let i = 0; i <= bars.length - 2; i++) {
        if (used[i] || used[i+1]) continue;
        const ev1 = singleChordEventForBar(i);
        const ev2 = singleChordEventForBar(i+1);
        if (!ev1 || !ev2) continue;
        if (!isP4Up(ev1.root.pitchClass, ev2.root.pitchClass)) continue;
        let mode = null;
        if (ev1.type === 'dominant' && ev2.type === 'major') mode = 'major';
        else if (ev1.type === 'dominant' && ev2.type === 'minor') mode = 'minor';
        if (!mode) continue;
        segments.push({
          lickBars: [1, 2], songBars: [i, i+1],
          mode, targetTonic: ev2.root
        });
        used[i] = used[i+1] = true;
      }
    }

    // Apply each segment: chromatic shift from source tonic to target
    // tonic, with optional "minor flavor" (flatten the source major
    // key's 3rd, 6th, 7th) when the target segment is a minor 251.
    // The minor flatten is computed AFTER the chromatic shift, by
    // checking each note's pitch class relative to the TARGET tonic
    // — so a CMaj 251 lick over a Cm 251 ends up using E♭ major
    // notes (E→E♭, A→A♭, B→B♭) regardless of the per-bar chord.
    const sourceTonic = lick.pattern251.sourceTonic;
    for (const seg of segments) {
      const isMinorTarget = (seg.mode === 'minor');
      const semiDelta = ((seg.targetTonic.pitchClass - sourceTonic.pitchClass) % 12 + 12) % 12;
      const tpcDelta = seg.targetTonic.tpc - sourceTonic.tpc;
      // Transpose every bar in the segment first, THEN octave-fit
      // the whole segment with a single shared shift. Per-bar fits
      // would dump a sparse last bar (e.g. just D5+F4 over the I)
      // onto its own low octave because its own min pitch is so
      // much higher than the busy ii/V bars — breaking the line's
      // continuity. One shared shift keeps the 3-bar phrase in
      // register with the original lick's contour.
      const perBarTransposed = [];
      let segMinPitch = Infinity;
      seg.lickBars.forEach((lickBarIdx) => {
        const sourceBarNotes = (lick.barNotes && lick.barNotes[lickBarIdx]) || [];
        const transposed = [];
        for (const n of sourceBarNotes) {
          if (n.rest || typeof n.midi !== 'number') {
            transposed.push(Object.assign({}, n, { midi: null, tpc: null }));
            continue;
          }
          let newMidi = n.midi + semiDelta;
          let newTpc = n.tpc + tpcDelta;
          if (isMinorTarget) {
            // Flatten the source-major-key's 3rd, 6th, and 7th
            // relative to the target tonic. e.g. CMaj source over
            // Cm 251: E→E♭ (4→3), A→A♭ (9→8), B→B♭ (11→10). Other
            // pitch classes (root, 2, 4, 5 of major + chromatic
            // alterations like ♭5) pass through unchanged.
            const pcFromTonic = ((newMidi - seg.targetTonic.pitchClass) % 12 + 12) % 12;
            if (pcFromTonic === 4 || pcFromTonic === 9 || pcFromTonic === 11) {
              newMidi -= 1;
              newTpc -= 7;
            }
          }
          transposed.push(Object.assign({}, n, { midi: newMidi, tpc: newTpc }));
          if (newMidi < segMinPitch) segMinPitch = newMidi;
        }
        perBarTransposed.push(transposed);
      });
      // Compute one shared octave shift from the segment's min pitch.
      let segOctShift = 0;
      if (segMinPitch < Infinity) {
        while (segMinPitch + segOctShift < EX_LOW) segOctShift += 12;
        while (segMinPitch + segOctShift > EX_LOW + 11) segOctShift -= 12;
        if (segMinPitch + segOctShift < EX_LOW) segOctShift += 12;
      }
      if (segOctShift !== 0) {
        for (const arr of perBarTransposed) {
          for (const n of arr) {
            if (n.midi != null) n.midi += segOctShift;
          }
        }
      }
      perBarTransposed.forEach((arr, k) => {
        const targetBarIdx = seg.songBars[k];
        for (const tn of arr) emitNoteIntoBar(targetBarIdx, tn);
      });
    }
    return { results, chordEvents, patterns, effective, subdivisions: 6 };
  }

  // ---- Single-bar lick path ----
  // (Lick 1, Lick 2 …) — every song bar's first chord re-pitches the
  // one-bar phrase via per-chord scale-degree mapping (modal) with
  // a chromatic-fallback collision check.
  if (!lick.notes || !lick.notes.length || !lick.sourceScale) {
    return { results, chordEvents, patterns, effective, subdivisions: 6 };
  }

  for (let barIdx = 0; barIdx < bars.length; barIdx++) {
    const bar = bars[barIdx];
    const firstChord = (bar.chords || []).find(c => c && !c.slash && !c.nc);
    if (!firstChord) continue;
    const canonical = chordToCanonical(firstChord);
    const targetRoot = exParseRoot(canonical);
    const targetScale = exGetScale(canonical);
    if (!targetRoot || !targetScale || !targetScale.length) continue;

    // Scale-degree transposition. Each source note carries
    //   { stepIdx, alteration, octaveOffset }
    // computed against the lick's source chord/scale at load time.
    // We re-emit it against the TARGET chord's scale: the same
    // step index becomes the chord's own diatonic tone (so a lick
    // degree-3 plays as the chord's 3rd over every bar — b3 over
    // m7, ♮3 over Maj7, etc.). The alteration carries chromatic
    // approach tones (#1, b9, etc.) cleanly across the change.
    function buildScaleDegreeTransposed() {
      const out = [];
      for (const n of lick.notes) {
        if (n.rest || typeof n.midi !== 'number' || n.stepIdx == null) {
          out.push({ ...n, midi: null, tpc: null });
          continue;
        }
        // diatonicIndexInScale remaps "step 2 of a 7-tone source"
        // onto the chord-tone slot (not the b3/♯9 passing tone) for
        // HW Diminished targets — see the Quote path's comment for
        // the full rationale.
        const realIdx = diatonicIndexInScale(n.stepIdx, targetScale);
        const len = targetScale.length;
        const sd = targetScale[((realIdx % len) + len) % len];
        const newSemi = sd.s + n.alteration;
        const newTpc = sd.t + n.alteration * 7;
        // octaveOffset is the absolute octave count (computed at
        // load time as floor((sourceMidi − sourceRootPc) / 12)), so
        // this yields a real MIDI value. Per-bar octave-fit below
        // moves the whole line into the cello range.
        const newMidi = (n.octaveOffset || 0) * 12 + targetRoot.pitchClass + newSemi;
        const finalTpc = targetRoot.tpc + newTpc;
        out.push({ ...n, midi: newMidi, tpc: finalTpc });
      }
      return out;
    }

    // Chromatic (interval-from-root) transposition. Used as a
    // fallback when scale-degree mapping creates a collision —
    // i.e. two source notes that were AUDIBLY different end up on
    // the same target pitch. The collision typically happens with
    // chromatic-enclosure licks like 5–b5–4–b3–3–1 over a chord
    // whose mode already owns the chromatic tone (e.g. CMaj's b5
    // = Gb mapped to Locrian where the b5 = Ab is a scale tone:
    // step 4 alt -1 collapses onto step 3 alt 0). Chromatic
    // mapping preserves every interval-from-root intact, so the
    // lick's exact contour is kept on the new chord.
    function buildChromaticTransposed() {
      const semiDelta = ((targetRoot.pitchClass - lick.sourceRoot.pitchClass) % 12 + 12) % 12;
      const tpcDelta = targetRoot.tpc - lick.sourceRoot.tpc;
      const out = [];
      for (const n of lick.notes) {
        if (n.rest || typeof n.midi !== 'number') {
          out.push({ ...n, midi: null, tpc: null });
          continue;
        }
        out.push({ ...n, midi: n.midi + semiDelta, tpc: n.tpc + tpcDelta });
      }
      return out;
    }

    // Run scale-degree first; check for consecutive non-rest notes
    // that DIFFER in source but COLLIDE in target. If any, redo
    // chromatically.
    let transposed = buildScaleDegreeTransposed();
    let collision = false;
    for (let i = 1; i < lick.notes.length; i++) {
      const a = lick.notes[i - 1];
      const b = lick.notes[i];
      if (!a || !b) continue;
      if (a.rest || b.rest) continue;
      if (typeof a.midi !== 'number' || typeof b.midi !== 'number') continue;
      if (a.midi === b.midi) continue; // already a repeated note in source
      const ta = transposed[i - 1];
      const tb = transposed[i];
      if (ta && tb && ta.midi != null && tb.midi != null && ta.midi === tb.midi) {
        collision = true;
        break;
      }
    }
    if (collision) {
      transposed = buildChromaticTransposed();
    }
    octaveFit(transposed);
    for (const n of transposed) emitNoteIntoBar(barIdx, n);
  }

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
  // 2 → eighth notes (8 slots per 4/4 bar, full pattern across the
  // chord's first half); 1 → quarter notes (4 slots per 4/4 bar,
  // shorter chord spans get the leading degrees of the pattern only,
  // so a 2-chord bar reads as "1-2 / 1-2" or "3-5 / 3-5"). Default
  // matches the original eighth-note behavior.
  const subdivisions = opts.subdivisions === 1 ? 1 : 2;
  const noteDuration = subdivisions === 1 ? 'q' : '8';
  return function (bars, ts) {
    const beatsPerBar = ts.num;
    const stepsPerBar = beatsPerBar * subdivisions;
    const chordEvents = buildChordEventList(bars);
    const patterns = detectKeyPatterns(chordEvents);
    const effective = chordEvents.map((ce, i) => {
      const pat = patterns.find(p => i >= p.firstIdx && i <= p.lastIdx);
      return pickEffectiveScale(ce, pat);
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
        // Translate from diatonic-scale-index semantics into the
        // actual scale's indexing — a no-op for 7-note scales,
        // but a HW-diminished remap so "3" lands on the chord's
        // major 3rd instead of the b3/#9 passing tone.
        const realIdx = diatonicIndexInScale(idx, chordScale);
        const octaveShift = Math.floor(realIdx / chordScale.length);
        const scaleDeg = chordScale[realIdx % chordScale.length];
        return {
          semi: scaleDeg.s + octaveShift * 12,
          tpc: rootTpc + scaleDeg.t
        };
      });
      // Allocate slot range for this chord. iRealPro spacing: for 3
      // chords in a 4-beat bar, first chord gets beats 1-2. With
      // `subdivisions = 2` (eighths) numSteps counts in eighth-notes;
      // with `subdivisions = 1` (quarters) it counts in beats — and
      // the toneCount fallback below works the same way: 2 slots
      // takes the first 2 degrees, 4+ takes the full pattern. So a
      // 2-chord 4/4 bar in the quarter variant produces "1-2 / 1-2".
      const { startBeat, endBeat } = chordBeatRange(ce.chordsInBar, ce.chordIdxInBar, beatsPerBar);
      const startStep = startBeat * subdivisions;
      const endStep   = endBeat   * subdivisions;
      const numSteps  = endStep - startStep;

      // 2 steps → first 2 tones | 3 steps → first 3 | 4+ → full pattern.
      // Clamped to the pattern length so a 3/4 exercise never tries to
      // fit a 4-note pattern.
      let toneCount = numSteps <= 2 ? 2 : (numSteps === 3 ? 3 : patternLen);
      toneCount = Math.min(toneCount, patternLen);

      // Semitone span from the pattern's first tone to its LAST WRITTEN
      // tone (toneCount, not patternLen). When a chord owns only 2
      // beats and we play just the first 2 degrees of "1-2-3-5" (=
      // 1-2 spanning ~2 semitones), we don't need to reserve room
      // above for the unused 3 and 5 — using the full patternSpan
      // here would unnecessarily cap the first-tone candidates to
      // the lowest octave in 4/4 and force the 2nd chord of the bar
      // to land an octave below the 1st chord's tail.
      const actualSpan = tones[toneCount - 1].semi - tones[0].semi;
      const firstToneMaxMidi = EX_HIGH - actualSpan;
      // Target first-tone MIDI:
      //   'center' → arpeggio centered on cello midpoint (used by 1235).
      //   'upper'  → arpeggio's top tone sits ~2 semitones below F3
      //              so the line lives in the cello's upper register
      //              without ever crossing the limit (used by 3579).
      const firstToneTargetMidi = targetMode === 'upper'
        ? firstToneMaxMidi - 2
        : Math.round(CELLO_RANGE_MID - actualSpan / 2);
      const firstTonePc = (rootPc + tones[0].semi + 1200) % 12;

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

      // Every 2 bars (bars 0, 2, 4, …), reset the line back to its
      // lowest playable starting pitch and ascend from there. Without
      // this reset, a long song accumulates upward motion from the
      // closest-prefer-up rule and the line creeps toward F3, where
      // it then has to flip down — which can dump a 2-chord bar like
      // "EbMaj7 Ab7" into an octave-down jump because the only fitting
      // octave for the second chord is far below the first chord's
      // tail. Restarting low every 2 bars keeps each 2-bar group as
      // a clean ascending line.
      const isResetPoint = (ce.barIdx % 2 === 0) && (ce.chordIdxInBar === 0);
      let firstPitch;
      if (!prevPitches || isResetPoint) {
        // Lowest in-range candidate, ascend from there. Falls back
        // to the centered/upper target heuristic only if no candidate
        // satisfies the patternSpan range guard (rare).
        if (candidates.length) {
          candidates.sort((a, b) => a - b);
          firstPitch = candidates[0];
        } else {
          firstPitch = firstTonePc + 36;
        }
      } else {
        // Linear voice-leading: pick the candidate first-tone CLOSEST
        // to the previous arpeggio's last note, with a tie-break
        // preferring the higher pitch (so a chord change in the middle
        // of the cello range continues ASCENDING rather than dropping
        // an octave). This makes a 2-chord bar like "EbMaj7 Ab7" play
        // E♭-F-A♭-B♭ as one continuous line instead of jumping back
        // down to a low Ab. Constrained so the full pattern still fits
        // under EX_HIGH; if no above-fit candidate exists we accept
        // the closest below candidate, and the safety clamp below
        // takes a final octave-down pass if needed.
        const prevLast = prevPitches[prevPitches.length - 1];
        const fitting = candidates.filter(p => p + actualSpan <= EX_HIGH);
        const pool = fitting.length ? fitting : candidates.slice();
        pool.sort((a, b) => {
          const da = Math.abs(a - prevLast);
          const db = Math.abs(b - prevLast);
          if (da !== db) return da - db;
          return b - a; // tie → prefer higher (continue ascending)
        });
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
          duration: noteDuration
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
            duration: noteDuration
          };
        }
        results[ce.barIdx].simileStart = startStep + patternLen;
      }

      prevPitches = pitches;
    });

    return { results, chordEvents, patterns, effective, subdivisions };
  };
}

// 1-2-3-5 (1-2-3 in 3/4) — e.g. C7 → C D E G. Centered on cello mid.
const generate1235EighthNotes = makeChordToneGenerator([0, 1, 2, 4], [0, 1, 2]);
// Quarter-note variant of 1235. One chord tone per beat, so a chord
// owning the whole bar plays 1-2-3-5; a chord owning two beats plays
// just 1-2 (and the next chord plays its own 1-2 in the same bar).
const generate1235QuarterNotes = makeChordToneGenerator(
  [0, 1, 2, 4], [0, 1, 2], { subdivisions: 1 }
);
// 3-5-7-9 (3-5-7 in 3/4) — e.g. C7 → E G Bb D, CMaj7 → E G B D. Aimed
// at the upper register since the arpeggio spans ~10 semitones; with
// the default center target it would sit too low.
const generate3579EighthNotes = makeChordToneGenerator(
  [2, 4, 6, 8], [2, 4, 6], { target: 'upper' }
);
// Quarter-note variant of 3579. Same upper-register targeting, one
// chord tone per beat. A 2-chord bar reads as "3-5 / 3-5".
const generate3579QuarterNotes = makeChordToneGenerator(
  [2, 4, 6, 8], [2, 4, 6], { target: 'upper', subdivisions: 1 }
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

// Mini fingerboard renderer for the "Diagram" overlay. Black-and-
// white static glyph for the scale's fingerboard positions on the
// 5-string cello (F C G D A, 7 frets). Layout matches the big Note
// Info diagram:
//   - Open strings (fret 0) sit ABOVE the nut as HOLLOW circles
//     (chord-chart convention — they're played without pressing).
//   - Stopped notes (frets 1-6) are FILLED dots between fret lines.
//   - The NUT (between fret 0 and fret 1) is the only thick line.
//     Other fret lines are thin. There's no line above the open-
//     string row.
const FB_MINI_COL_W = 8;
const FB_MINI_GAP = 2;
const FB_MINI_ROW_H = 9;
const FB_MINI_FRETS = 7;
const FB_MINI_W = FB_STRING_BASES.length * FB_MINI_COL_W
  + (FB_STRING_BASES.length - 1) * FB_MINI_GAP;
const FB_MINI_H = FB_MINI_FRETS * FB_MINI_ROW_H + 2;
function appendMiniFingerboard(parent, x, y, scalePcs) {
  const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  g.setAttribute('transform', `translate(${x}, ${y})`);
  // Six horizontal fret lines, positioned the same way the big
  // diagram does: at i*rowH+1 for i = 1..6. That means there's NO
  // line at y=0 (above the open-string row), and the first line
  // drawn (the nut, between fret 0 and fret 1) is the thick one.
  const fretLineYs = [1, 2, 3, 4, 5, 6].map(i => i * FB_MINI_ROW_H + 1);
  fretLineYs.forEach((ly, i) => {
    const thickness = i === 0 ? 1.4 : 0.6; // nut thicker than other frets
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    line.setAttribute('x', -1);
    line.setAttribute('y', ly);
    line.setAttribute('width', FB_MINI_W + 2);
    line.setAttribute('height', thickness);
    line.setAttribute('fill', '#000');
    g.appendChild(line);
  });
  // Per-string vertical line + scale-tone dots.
  for (let c = 0; c < FB_STRING_BASES.length; c++) {
    const cx = c * (FB_MINI_COL_W + FB_MINI_GAP) + FB_MINI_COL_W / 2;
    // String line spans from the top circle center down to the
    // bottom circle center (matches the big diagram's behavior so
    // the line doesn't poke past the outermost dots).
    const firstCy = FB_MINI_ROW_H - 3;
    const lastCy = (FB_MINI_FRETS - 1) * FB_MINI_ROW_H + (FB_MINI_ROW_H - 3);
    const sline = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    sline.setAttribute('x1', cx);
    sline.setAttribute('y1', firstCy);
    sline.setAttribute('x2', cx);
    sline.setAttribute('y2', lastCy);
    sline.setAttribute('stroke', '#000');
    sline.setAttribute('stroke-width', 0.6);
    g.appendChild(sline);
    for (let r = 0; r < FB_MINI_FRETS; r++) {
      const midi = FB_STRING_BASES[c] + r;
      const pc = ((midi % 12) + 12) % 12;
      if (!scalePcs.has(pc)) continue;
      // Same vertical-offset formula as the big diagram so circles
      // sit just above each fret line they belong to.
      const cy = r * FB_MINI_ROW_H + (FB_MINI_ROW_H - 3);
      const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      dot.setAttribute('cx', cx);
      dot.setAttribute('cy', cy);
      dot.setAttribute('r', 2.5);
      if (r === 0) {
        // Open-string: hollow circle.
        dot.setAttribute('fill', 'none');
        dot.setAttribute('stroke', '#000');
        dot.setAttribute('stroke-width', 0.8);
      } else {
        // Stopped note: filled dot.
        dot.setAttribute('fill', '#000');
      }
      g.appendChild(dot);
    }
  }
  parent.appendChild(g);
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
    // Compound intervals (above the octave). Spelled as a 9th/11th/13th
    // rather than collapsed to b2/4/b6, because they're a distinct
    // chord function — and #9 specifically must spell as an augmented
    // 2nd (D♯ above C), not a minor 3rd (E♭), even though they share a
    // pitch class.
    case 13: return -5;   // ♭9
    case 14: return 2;    // 9
    case 15: return 8;    // ♯9 (augmented 2nd: D♯, A♯, …)
    case 17: return -1;   // 11
    case 18: return 6;    // ♯11
    case 20: return -4;   // ♭13
    case 21: return 3;    // 13
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
  // Use ALL intervals (including extensions ≥ 12) for the displayed
  // names list, so altered tensions like the ♭9 in G7♭9 appear as
  // chord tones (G B D F A♭). The on-fingerboard chord-tone marker
  // map (byPc) stays restricted to the basic chord tones — root,
  // 3rd, 5th, 7th — since those are the only intervals that
  // degreeFromInterval has labels for and that read cleanly as
  // ringed degrees on the board.
  const allIvs = intervalsFor(ch.rest || '');
  const byPc = {};
  const names = [];
  const seenPc = new Set();
  allIvs.forEach(i => {
    const pc = (rootPc + i) % 12;
    if (i < 12) {
      const deg = degreeFromInterval(i, ch.rest || '');
      if (deg && !(pc in byPc)) byPc[pc] = deg;
    }
    if (!seenPc.has(pc)) {
      seenPc.add(pc);
      const tpc = rootTpc + intervalTpcOffset(i, ch.rest || '');
      names.push(tpcToNoteName(tpc));
    }
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

// Whole-Half Diminished — the 8-note symmetric scale used over a fully
// diminished 7 chord (W-H-W-H-W-H-W-H from the root). Distinct from
// Half-Whole Diminished, which is used over dom7♭9; for the dim7 case
// we want the W-H spelling so the chord tones (1, ♭3, ♭5, ♭♭7) sit on
// odd scale degrees instead of every-other note in the H-W spelling.
const DIMINISHED_WH_SIG = '0,2,3,5,6,8,9,11';
// Half-Whole Diminished — H-W-H-W-H-W-H-W from the root, used over a
// 7♭9 chord. Contains every chord tone (R, 3, 5, ♭7, ♭9) plus the ♯9,
// ♯11, and 13 as available color tones.
const DIMINISHED_HW_SIG = '0,1,3,4,6,7,9,10';

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
  // Whole-Half Diminished — labeled by its own root (no parent-major
  // equivalent: the symmetric 8-note scale doesn't sit inside any
  // diatonic major). E.g. Bbdim7 → "B♭ Whole-Half Diminished".
  if (sig === DIMINISHED_WH_SIG) {
    return names[rootPc] + ' Whole-Half Diminished';
  }
  // Half-Whole Diminished — used over 7♭9. Same symmetric 8-note set
  // shifted by a semitone; also no parent-major equivalent.
  if (sig === DIMINISHED_HW_SIG) {
    return names[rootPc] + ' Half-Whole Diminished';
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
let lastChordEvents = null; // flat chord-event list from the most recent renderChart pass
let lastBarsPerBar = 4;     // beats-per-bar (ts.num) of the most recent renderChart pass

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
        // Ring just signals "this pitch appears in the current bar".
        // The previous color-coded position scheme (blue/red/green
        // for 1st/half/upper from the old fingering-overlay system)
        // has been retired in favour of the user-authored Edit
        // Fingering data; a single black ring is enough to flag the
        // bar's pitches on the fingerboard.
        ring.setAttribute('stroke', '#000');
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
// Default Bars/Line: 4 on desktop (4-bar phrases read like a typical
// lead sheet), 2 on mobile (narrower screens benefit from fewer bars
// per row so each one reads at a comfortable size). The mobile/
// desktop split is a one-time decision at page load — the segmented
// button still lets the user override afterwards.
let measuresPerLine = (function () {
  try { return (typeof emIsMobile === 'function' && emIsMobile()) ? 2 : 4; }
  catch (e) { return 4; }
})();
// Per-measure viewBox width in VexFlow units. The "Size" segmented
// control sets this. A SMALLER value squeezes each measure's notes
// into fewer viewBox units; since the SVG still stretches to fill
// the container, the scale factor goes UP and everything (staff
// lines, note heads, clefs) renders BIGGER on screen. So Size=L / XL
// corresponds to a smaller measureWidth, giving a big-notes look at
// any Per line count. Tight internal spacing is fine for sparse
// exercises like Cantus Firmus.
// Default is M (120) — middle of the road; users who want smaller
// or larger notes flip the segs.
let chartSize = 120;
let songRepeats = 1;
let exerciseMode = 'head'; // 'head' = play the song's melody from the head file;
                            // 'scale' = walk the scale, 'chord' = 1-3-5-7 arpeggio,
                            // etc. for the various exercise generators.
const barElements = []; // [ { rowEl, x, y, w, h } ] per bar index, for highlighting

// Refresh the title line above the score: "{song name} ({exercise})".
// Called on song load and whenever the exercise picker changes, so the
// title always reflects what's currently being drawn. Takes an optional
// explicit song arg for the render-time case (renderChart fires before
// `window.currentSong` is assigned in loadSong); callers from elsewhere
// can fall back on the global.
// Real Book index. Lazy-loaded from songs/realbook-index.json on the
// first updateScoreTitle call and cached forever. The lookup is
// fuzzy: titles are normalized (lowercased, accents stripped, "the"
// / "a" prefixes removed, leading articles in parentheses stripped,
// non-alphanumeric collapsed) so that iRealPro variants like
// "All The Things You Are" match the index's "ALL THE THINGS YOU
// ARE", and "(I Love You) For Sentimental Reasons" matches
// "(I LOVE YOU) FOR SENTIMENTAL REASONS". Multiple matches (same
// song in multiple volumes) are joined with "/" — e.g. "(RB3 p.392
// / RB5 p.417)" so the user sees every available source.
let _realbookIndexPromise = null;
let _realbookByKey = null;
function _normalizeTitleForRBLookup(t) {
  if (!t) return '';
  let s = String(t).toLowerCase();
  // Strip accents (NFKD then drop combining marks).
  try { s = s.normalize('NFKD').replace(/[̀-ͯ]/g, ''); } catch (e) {}
  // Drop ALL parenthetical phrases — not just leading. The Real Book
  // index entries often carry an alternative title in parens, e.g.
  // "CHEROKEE (INDIAN LOVE SONG)", "A FOGGY DAY (IN LONDON TOWN)",
  // "BILLIE'S BOUNCE (BILL'S BOUNCE)", and iRealPro typically uses
  // just the short form. Stripping every (...) on both sides lets
  // them line up. (Songs with a leading parenthetical alt-title
  // like "(I LOVE YOU) FOR SENTIMENTAL REASONS" also collapse to
  // their short form here, matching how iRealPro lists them.)
  s = s.replace(/\([^)]*\)/g, ' ');
  // Library-style trailing article: "Girl From Ipanema, The" /
  // "Way You Look Tonight, The" — iRealPro often uses this sort-
  // friendly form whereas the Real Book index has the article up
  // front ("THE GIRL FROM IPANEMA"). Strip the trailing ", The/A/An"
  // so both sides reduce to the same article-less core below.
  s = s.replace(/,\s*(the|an|a)\s*$/, '');
  // Drop leading "the " / "a " / "an " articles.
  s = s.replace(/^\s*(the|an|a)\s+/, '');
  // Collapse to alphanumerics — kills punctuation, spacing variants,
  // and apostrophes ("Tain't" vs "taint", "Don't" vs "dont").
  s = s.replace(/[^a-z0-9]/g, '');
  return s;
}
function loadRealbookIndex() {
  if (_realbookIndexPromise) return _realbookIndexPromise;
  _realbookIndexPromise = (async () => {
    try {
      const res = await fetch('songs/realbook-index.json', { cache: 'no-store' });
      if (!res.ok) return null;
      const arr = await res.json();
      if (!Array.isArray(arr)) return null;
      const map = new Map();
      for (const e of arr) {
        if (!e || !e.title) continue;
        const key = _normalizeTitleForRBLookup(e.title);
        if (!key) continue;
        if (!map.has(key)) map.set(key, []);
        map.get(key).push({ book: e.book, page: e.page });
      }
      _realbookByKey = map;
      // Refresh anything that depends on the index now that it's in:
      //   - the score title (adds its RB suffix)
      //   - the song list (each row gets its RB reference filled)
      try { if (typeof updateScoreTitle === 'function') updateScoreTitle(); } catch (e) {}
      try { if (typeof applyRealbookSuffixesToSongList === 'function') applyRealbookSuffixesToSongList(); } catch (e) {}
      return map;
    } catch (e) { return null; }
  })();
  return _realbookIndexPromise;
}
function _rbSuffixForTitle(songTitle) {
  if (!_realbookByKey) return '';
  const key = _normalizeTitleForRBLookup(songTitle);
  if (!key) return '';
  const hits = _realbookByKey.get(key);
  if (!hits || !hits.length) return '';
  // Sort by book then page so the suffix is deterministic.
  const sorted = hits.slice().sort((a, b) => a.book - b.book || a.page - b.page);
  return ' (' + sorted.map(h => 'RB' + h.book + ' p.' + h.page).join(' / ') + ')';
}
// Song-list variant of the Real Book suffix. Same data as the score
// title's suffix, different format: comma-separated `(RB1, p.45)`
// (and `(RB1, p.45 / RB3, p.392)` for songs in multiple volumes),
// matching the picker's looser visual style next to the song name.
// Returns '' when the song isn't in the index or the index hasn't
// loaded yet.
function _rbListSuffixForTitle(songTitle) {
  if (!_realbookByKey) return '';
  const key = _normalizeTitleForRBLookup(songTitle);
  if (!key) return '';
  const hits = _realbookByKey.get(key);
  if (!hits || !hits.length) return '';
  const sorted = hits.slice().sort((a, b) => a.book - b.book || a.page - b.page);
  return '(' + sorted.map(h => 'RB' + h.book + ', p.' + h.page).join(' / ') + ')';
}
// After the song list is populated and the Real Book index resolves,
// walk every list row and fill in its `.song-rb` span. Idempotent —
// rows that already have text are left alone, so re-rendering on
// filter/sort doesn't double-write.
function applyRealbookSuffixesToSongList() {
  if (!_realbookByKey) return;
  const rows = document.querySelectorAll('#songList li');
  rows.forEach(li => {
    const nameSpan = li.querySelector('.song-name');
    const rbSpan = li.querySelector('.song-rb');
    if (!nameSpan || !rbSpan) return;
    if (rbSpan.textContent) return; // already filled
    const suffix = _rbListSuffixForTitle(nameSpan.textContent || '');
    if (suffix) rbSpan.textContent = suffix;
  });
}
function updateScoreTitle(songArg) {
  const el = document.getElementById('scoreTitle');
  if (!el) return;
  // Fire the index load on first call. Cached after that, and the
  // load itself triggers a re-call once the data lands.
  if (_realbookIndexPromise === null) loadRealbookIndex();
  const song = songArg ||
    (window.currentSong && window.currentSong.song) || null;
  const title = (song && song.title) || '';
  // Mode is now driven by the Head/Exercise segmented button. When
  // Head is active the title reads "(Head)"; otherwise it reflects
  // the exercise dropdown's current selection.
  let exLabel = '';
  if (exerciseMode === 'head') {
    // When the Score-mode dropdown is showing variants, the current
    // dropdown text IS the score label (e.g. "Head" or "Paul Chambers
    // Bassline"). Reflect it in the title so the user can see at a
    // glance which score they're looking at. Falls back to plain
    // "Head" when the dropdown hasn't been switched to score-mode
    // yet (e.g. song still loading).
    const sel = document.getElementById('exerciseSelect');
    if (_dropdownMode === 'score' && sel && sel.selectedIndex >= 0) {
      const opt = sel.options[sel.selectedIndex];
      exLabel = (opt && opt.text) || 'Head';
    } else {
      exLabel = 'Head';
    }
  } else if (exerciseMode === 'blank') {
    exLabel = 'Blank';
  } else {
    const sel = document.getElementById('exerciseSelect');
    if (sel && sel.selectedIndex >= 0) {
      const opt = sel.options[sel.selectedIndex];
      if (opt) exLabel = opt.text || '';
    }
  }
  // Compose the title:
  //   "<song> [RBx p.yy] (<mode>)"
  // Real Book reference (e.g. "RB1 p.32" or
  // "RB3 p.392 / RB5 p.417" for multi-volume songs) is wrapped in
  // square brackets and sits between the song name and the
  // parenthesized mode label. Falls back gracefully when any piece
  // is missing (e.g. index not yet loaded, or song not in the
  // Real Book).
  const rbRef = title ? _rbSuffixForTitle(title).trim() : '';
  const parts = [];
  if (title)   parts.push(title);
  if (rbRef)   parts.push('[' + rbRef.replace(/^\(|\)$/g, '') + ']');
  if (exLabel) parts.push('(' + exLabel + ')');
  el.textContent = parts.join(' ');
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

// Scale-notes string for the "Chord notes" overlay. Returns the
// chord's own scale spelled out from the chord's root, e.g. CMaj7 →
// "C D E F G A B"; D7 → "D E F♯ G A B C"; Bbm7♭5 → "B♭ C D♭ E♭ F♭ G♭ A♭".
// Uses Unicode flat / sharp glyphs so they render the same as the
// chord labels themselves. Returns "" for chords we can't parse
// (slashes, N.C., empty), so the caller can skip drawing.
//
// The `nextCh` argument lets the picker make a context-aware call
// for 7♭9 chords specifically: Phrygian Dominant (♭6, harmonic-
// minor-derived) when the next chord is minor (V → i), Mixolydian
// ♭9 (♮6) otherwise. For A Foggy Day's D7♭9 → Gm7, that resolves
// to Phrygian Dominant — the song's parent F major has B♭ in it,
// and the V-i in temporary G minor wants the harmonic-minor sound.
function chordScaleNotesText(ch, nextCh) {
  if (!ch || ch.slash || ch.nc) return '';
  const canonical = chordToCanonical(ch);
  const root = exParseRoot(canonical);
  if (!root) return '';
  const nextCanonical = (nextCh && !nextCh.slash && !nextCh.nc)
    ? chordToCanonical(nextCh) : null;
  const scale = exGetScaleContextual(canonical, nextCanonical);
  if (!scale || !scale.length) return '';
  const ACC_GLYPHS = { '': '', '#': '♯', 'b': '♭', '##': '𝄪', 'bb': '𝄫' };
  const out = [];
  for (let i = 0; i < scale.length; i++) {
    const tpc = root.tpc + scale[i].t;
    const { letter, acc } = tpcToLetterAcc(tpc);
    out.push(letter + (ACC_GLYPHS[acc] || ''));
  }
  return out.join(' ');
}
// "Chord tones" overlay variant. Returns the chord's 1 / 3 / 5 / 7
// as letter-name tokens (e.g. "C E G B" for CMaj7, "C E♭ G B♭" for
// Cm7, "C E♭ G♭ B♭♭" for Cdim7). Uses diatonicIndexInScale so
// altered / HW-diminished / WH-diminished chords still produce
// their real chord 3 / 5 / 7. Empty string for slash / N.C. chords.
function chordToneText(ch, nextCh) {
  if (!ch || ch.slash || ch.nc) return '';
  const canonical = chordToCanonical(ch);
  const root = exParseRoot(canonical);
  if (!root) return '';
  const nextCanonical = (nextCh && !nextCh.slash && !nextCh.nc)
    ? chordToCanonical(nextCh) : null;
  const scale = exGetScaleContextual(canonical, nextCanonical);
  if (!scale || !scale.length) return '';
  const ACC_GLYPHS = { '': '', '#': '♯', 'b': '♭', '##': '𝄪', 'bb': '𝄫' };
  const out = [];
  const seen = new Set();
  for (const di of [0, 2, 4, 6]) {
    const ridx = diatonicIndexInScale(di, scale);
    const sd = scale[((ridx % scale.length) + scale.length) % scale.length];
    if (!sd) continue;
    const tpc = root.tpc + sd.t;
    if (seen.has(tpc)) continue;
    seen.add(tpc);
    const { letter, acc } = tpcToLetterAcc(tpc);
    out.push(letter + (ACC_GLYPHS[acc] || ''));
  }
  return out.join(' ');
}

// "Chord notes — simplified" overlay variant. Same scale-tone walk
// as `chordScaleNotesText`, but skips every NATURAL note and only
// emits notes that carry a sharp or flat. So a chord whose scale is
// entirely natural (e.g. CMaj7 over C major: C D E F G A B) returns
// an empty string and renders nothing under the chord label.
// Useful for quickly spotting which non-diatonic accidentals a
// chord introduces against its surroundings.
//
// Output ordering follows the standard key-signature progressions:
//   - Flats are listed in BEADGCF order (the order flats are
//     added to a key signature: 1st flat is B♭, 2nd is E♭, etc.)
//   - Sharps are listed in FCGDAEB order (1st sharp is F♯, 2nd
//     is C♯, etc.)
//   - Mixed sets put all flats first (in BEADGCF order) then all
//     sharps (in FCGDAEB order). E.g. a D7♭9-style scale with E♭,
//     F♯, A♭ comes out as "E♭ A♭ F♯".
const _FLAT_ORDER  = ['B', 'E', 'A', 'D', 'G', 'C', 'F'];
const _SHARP_ORDER = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
// Returns the chord's accidental notes (sharps / flats) as an array
// of pretty tokens like "B♭" / "F♯", in BEADGCF-then-FCGDAEB order.
// Empty array for a chord whose effective scale is entirely natural.
function chordAccidentalTokens(ch, nextCh) {
  if (!ch || ch.slash || ch.nc) return [];
  const canonical = chordToCanonical(ch);
  const root = exParseRoot(canonical);
  if (!root) return [];
  const nextCanonical = (nextCh && !nextCh.slash && !nextCh.nc)
    ? chordToCanonical(nextCh) : null;
  const scale = exGetScaleContextual(canonical, nextCanonical);
  if (!scale || !scale.length) return [];
  const ACC_GLYPHS = { '': '', '#': '♯', 'b': '♭', '##': '𝄪', 'bb': '𝄫' };
  const flats = new Map();
  const sharps = new Map();
  for (let i = 0; i < scale.length; i++) {
    const tpc = root.tpc + scale[i].t;
    const { letter, acc } = tpcToLetterAcc(tpc);
    if (!acc) continue;
    const token = letter + (ACC_GLYPHS[acc] || '');
    if (acc === 'b' || acc === 'bb') {
      if (!flats.has(letter)) flats.set(letter, token);
    } else if (acc === '#' || acc === '##') {
      if (!sharps.has(letter)) sharps.set(letter, token);
    }
  }
  const orderedFlats = _FLAT_ORDER
    .filter(L => flats.has(L))
    .map(L => flats.get(L));
  const orderedSharps = _SHARP_ORDER
    .filter(L => sharps.has(L))
    .map(L => sharps.get(L));
  return orderedFlats.concat(orderedSharps);
}
function chordScaleNotesTextSimplified(ch, nextCh) {
  return chordAccidentalTokens(ch, nextCh).join(' ');
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
  //   - "range3579"     → quarter-note F1↔F3 sweep through 3/5/7/9 of each chord
  //   - "range3579Half" → half-note variant of the same sweep (one chord tone
  //                       every two beats instead of every beat)
  //   - "enclosures"    → q (above) + q (below) + h (1/3/5 target) per bar
  //   - "longEnclosures"→ pair-of-bars enclosures: 4 diatonic quarters into
  //                       a regular q-q-h enclosure on the next bar
  //   - "scaleChromatic"→ scale walk with each bar's last beat replaced
  //                       by a half-step chromatic approach to the next
  //                       bar's first note (e.g. D E F F♯ | G A B D♭).
  //   - "blank"         → empty staff with chord symbols above; for
  //                       hand-writing or printing as practice paper.
  //   - "descending"    → restart on the highest 1/3/5 every 2 bars,
  //                       walk down one diatonic step per beat.
  //   - "1235"          → quarter-note arpeggio of the chord's 1-2-3-5
  //                       (a 2-chord bar plays "1-2 / 1-2").
  //   - "1235Eighth"    → eighth-note variant; a chord owning the bar
  //                       plays the full 1-2-3-5 in the first half-bar.
  //   - "3579"          → quarter-note arpeggio of the chord's 3-5-7-9
  //                       (a 2-chord bar plays "3-5 / 3-5").
  //   - "3579Eighth"    → eighth-note variant of 3-5-7-9.
  const bars = expandBarsByRepeats(barsIn, songRepeats);
  const gen = exerciseMode === 'head' ? generateHeadFromScore
            : exerciseMode === 'chord' ? generate1357QuarterNotes
            : exerciseMode === 'triads' ? generateTriadsQuarterNotes
            : exerciseMode === 'broken3' ? generateBroken3rdsQuarterNotes
            : exerciseMode === 'cantus' ? generateCantusFirmusQuarterNotes
            : exerciseMode === 'targetTriad' ? generateTargetTriadQuarterNotes
            : exerciseMode === 'range3579' ? generateRange3579QuarterNotes
            : exerciseMode === 'range3579Half' ? generateRange3579HalfNotes
            : exerciseMode === 'chordTonesHalf' ? generateChordTonesHalfNotes
            : exerciseMode === 'enclosures' ? generateEnclosuresQuarterNotes
            : exerciseMode === 'longEnclosures' ? generateLongEnclosuresQuarterNotes
            : exerciseMode === 'scaleChromatic' ? generateScaleChromaticQuarterNotes
            : exerciseMode === 'blank' ? generateBlankExercise
            : exerciseMode === 'descending' ? generateDescendingQuarterNotes
            : exerciseMode === '1235' ? generate1235QuarterNotes
            : exerciseMode === '1235Eighth' ? generate1235EighthNotes
            : exerciseMode === '3579' ? generate3579QuarterNotes
            : exerciseMode === '3579Eighth' ? generate3579EighthNotes
            : exerciseMode === 'walkTriad' ? generateWalkTriadQuarterNotes
            : exerciseMode === 'mixedTriads' ? generateMixedTriadsQuarterNotes
            : exerciseMode === 'threeSeven' ? generateThreeSevenQuarterNotes
            : exerciseMode === 'landmarks' ? generateLandmarksQuarterNotes
            : exerciseMode === 'landmarks13' ? generateLandmarks13QuarterNotes
            : exerciseMode === 'walkBass' ? generateWalkingBasslineQuarterNotes
            : exerciseMode === 'walkBassPC' ? generatePaulChambersBasslineQuarterNotes
            : (typeof exerciseMode === 'string' && exerciseMode.startsWith('lick:'))
              ? generateExerciseLickQuarterNotes
            : generateQuarterNotes;
  const { results: quarterNotes, chordEvents, patterns, effective } = gen(bars, ts);
  // Per-bar/per-beat info for the fingerboard panel, keyed by expanded-bar idx.
  lastBeatInfo = buildBeatInfo(bars, ts, quarterNotes, chordEvents, effective, patterns);
  // Expose chord events to downstream consumers (game-mode chord
  // preview, etc.) — same lifetime as lastBeatInfo, regenerated on
  // every renderChart pass.
  lastChordEvents = chordEvents;
  lastBarsPerBar = ts.num;

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
    exerciseMode === '1235Eighth' || exerciseMode === '3579Eighth' || exerciseMode === 'head';
  let measureWidth = Math.round(chartSize * (eighthNoteExercise ? 1.6 : 1));
  const leftPadding = 14;
  const rightPadding = 14;
  const firstMeasureClefWidth = 68; // bass clef + 8vb + time sig on line 1
  // Previously reserved width for the bass clef on continuation rows.
  // We now omit the clef on every row after the first and redistribute
  // this width across the row's bars as extra note space.
  const clefOnlyExtra = 44;
  // staffY pushes the bass-clef staff down to leave headroom above for
  // BOTH the rehearsal-mark badge (drawn at y=2 with bh=13) AND the
  // chord-symbol label that sits at y = staffY − 6 with font-size 15.
  // With staffY=36 the chord text's top edge lands around y=18, well
  // below the rehearsal box's bottom (y=15) — no more overlap when a
  // section letter falls on a bar that has a beat-1 chord.
  const staffY = 36;
  // VexFlow's bass-clef staff lines end up at y ≈ 76 (top) .. 116 (bottom)
  // when staffY=36 (was 66..106 with staffY=26). The lowest F the generator
  // can produce (written F2 via the 8vb clef) now sits around y = 121–126,
  // so the scale label baseline shifts down in lockstep to keep its
  // ~20 px clearance from the note heads.
  // Scale label sits below the staff. Bumped from 144 → 150 to
  // leave a clean band for the Overlay-mode beat markers (blue
  // 1/2/3/4 circles + and-dots) at y≈126; without the bump the
  // bottom of those circles brushed up against the scale label
  // text. Each row is 6 px taller as a result.
  const patternTextY = 150;         // baseline of the scale label
  const patternLineY = patternTextY + 6; // underline just below descenders
  // Chord-notes overlay sits in the bottom band of the row, near
  // where the chord-scale ink lives. When the Chord-scales overlay
  // is ALSO on, chord notes go BELOW the chord-scale line so the
  // two don't overlap. When chord scales is off, chord notes take
  // the chord-scale band's vertical position itself.
  // Font size matches the chord-scale label (16) at the user's
  // request — the line-height is therefore 17 (font + 1 px gap)
  // and the y offsets give the larger glyph body room to breathe.
  const CHORD_NOTES_LINE_HEIGHT = 17;
  // Either chord-notes overlay (full or simplified) reserves space
  // below the chord-symbol row. Simplified text is often empty for
  // a given chord, but we still need the row height so non-empty
  // entries have somewhere to land.
  const chordNotesAnyOn = overlayChordNotesOn || overlayChordNotesSimplifiedOn || overlayChordTonesOn;
  const chordNotesY1 = chordNotesAnyOn
    ? (overlayChordScalesOn ? patternLineY + 18 : 148)
    : 0;
  const chordNotesY2 = chordNotesY1 + CHORD_NOTES_LINE_HEIGHT;

  // Pre-compute "Chord Notes - Simplified" runs once for the whole
  // chart. A run is a stretch of consecutive chord events that share
  // the SAME SET of accidental notes. Adjacent chords with E♭ +
  // F♯ + A♭ all collapse into a single grouped line; the next
  // chord whose accidentals differ (or is purely natural) starts
  // a fresh run. Chords with no accidentals (purely diatonic) render
  // nothing AND break any current run.
  let _simpRuns = null;
  if (overlayChordNotesSimplifiedOn) {
    const tokensPerCE = chordEvents.map((ce, i) => {
      const nextCh = (i + 1 < chordEvents.length) ? chordEvents[i + 1].chord : null;
      return chordAccidentalTokens(ce.chord, nextCh);
    });
    _simpRuns = [];
    let runStart = -1;
    let runLabel = null;
    for (let i = 0; i < tokensPerCE.length; i++) {
      const label = tokensPerCE[i].join(' ');
      if (!label) {
        if (runStart >= 0) {
          _simpRuns.push({ firstIdx: runStart, lastIdx: i - 1, label: runLabel });
          runStart = -1; runLabel = null;
        }
        continue;
      }
      if (runStart < 0) {
        runStart = i; runLabel = label;
      } else if (label !== runLabel) {
        _simpRuns.push({ firstIdx: runStart, lastIdx: i - 1, label: runLabel });
        runStart = i; runLabel = label;
      }
    }
    if (runStart >= 0) {
      _simpRuns.push({ firstIdx: runStart, lastIdx: tokensPerCE.length - 1, label: runLabel });
    }
  }

  // Diagram overlay runs: groups of consecutive chord events that
  // share the same EFFECTIVE scale (root + scale signature). Each
  // run gets one mini fingerboard diagram drawn at the start of
  // its first bar in this row. Standalone chords (not in any
  // pattern) use their own scale; chords inside a key pattern
  // share the parent key's scale, so a ii-V-i collapses into one
  // diagram. Empty / null effective scales (NC, slash) break the
  // run.
  let _diagramRuns = null;
  if (overlayDiagramOn) {
    function _effSig(eff) {
      if (!eff || !eff.root || !eff.scale) return '';
      return eff.root.pitchClass + ':' + eff.scale.map(x => x.s).join(',');
    }
    _diagramRuns = [];
    let dStart = -1;
    let dSig = null;
    let dRoot = null, dScale = null;
    for (let i = 0; i < chordEvents.length; i++) {
      const sig = _effSig(effective[i]);
      if (!sig) {
        if (dStart >= 0) {
          _diagramRuns.push({ firstIdx: dStart, lastIdx: i - 1, root: dRoot, scale: dScale });
          dStart = -1;
        }
        continue;
      }
      if (dStart < 0) {
        dStart = i; dSig = sig; dRoot = effective[i].root; dScale = effective[i].scale;
      } else if (sig !== dSig) {
        _diagramRuns.push({ firstIdx: dStart, lastIdx: i - 1, root: dRoot, scale: dScale });
        dStart = i; dSig = sig; dRoot = effective[i].root; dScale = effective[i].scale;
      }
    }
    if (dStart >= 0) {
      _diagramRuns.push({ firstIdx: dStart, lastIdx: chordEvents.length - 1, root: dRoot, scale: dScale });
    }
  }

  // Diagram band sits at the BOTTOM, below any other overlay band
  // that's also enabled. So a chart with all four overlays on
  // stacks (top→bottom under staff): staff → chord-scales →
  // chord-notes → diagram. Y1 picks whichever lower edge is in
  // play; if the diagram is the only overlay, it sits just below
  // the staff.
  let diagramBandY1 = 0;
  if (overlayDiagramOn) {
    if (chordNotesAnyOn) diagramBandY1 = chordNotesY2 + 5;
    else if (overlayChordScalesOn) diagramBandY1 = patternLineY + 10;
    else diagramBandY1 = 148;
  }

  let staffHeight;
  if (overlayDiagramOn) {
    staffHeight = diagramBandY1 + FB_MINI_H + 5;
  } else if (chordNotesAnyOn) {
    staffHeight = chordNotesY2 + 5;
  } else if (overlayChordScalesOn) {
    staffHeight = patternLineY + 10; // 166
  } else {
    staffHeight = 148;
  }
  // Bottom of the per-bar selection-highlight rect. Tracks the
  // bottom of whichever band is active (diagram → chord notes →
  // chord scales → staff) so the highlight wash always covers
  // everything we render.
  const barHighlightBottom = overlayDiagramOn
    ? diagramBandY1 + FB_MINI_H + 3
    : (chordNotesAnyOn
      ? chordNotesY2 + 3
      : (overlayChordScalesOn ? patternLineY + 3 : staffHeight - 4));

  // Print sizing: widen `measureWidth` so the row's natural aspect
  // ratio (rowWidth/staffHeight) matches whatever the user's S/M/L
  // selection chose for this print run. _printTargetAspect comes
  // from the beforeprint handler and is one of three values:
  //   S → 9.5 (short rows, smaller notes, wider bars)
  //   M → 7.4 (default)
  //   L → 5.5 (tall rows, bigger notes, denser bars)
  // The CSS pins each row to width:100%; height auto-derives from
  // the aspect, so a smaller targetAspect makes paper rows taller
  // and the fixed-size notehead glyph paints proportionally bigger.
  if (_printMode) {
    const targetAspect = _printTargetAspect;
    const targetRowWidth = staffHeight * targetAspect;
    measureWidth = Math.max(
      measureWidth,
      Math.round((targetRowWidth - leftPadding - rightPadding) / mpl)
    );
  }

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
    // In print mode, ALL bars across ALL rows get the same width.
    // The clef + time sig on the first row's first bar still RENDER
    // (VexFlow calls inside the bar-loop add them) — they just live
    // inside that bar's shared width budget instead of pushing it
    // wider. That gives a clean grid of identical-sized cells across
    // the whole worksheet, which is what the user expects of a
    // printed practice page.
    // Pickup (anacrusis) — a partial bar carried at the very start
    // of row 1, OUTSIDE the iRealPro `bars[]` array so bar numbering
    // and fingering indexing stay aligned with bar 1 = bars[0].
    // leadInBeats comes from MusicXML detection at parse time.
    // On-screen, pickup is HEAD-MODE-ONLY: in Blank and Exercise modes,
    // there is no melody to render in the partial bar (it would be all
    // rests) and the playback would schedule nothing useful. Forcing
    // leadInBeats to 0 outside of head mode also zeroes pickupWidth,
    // pickupShrinkPerBar, and the row-1 bar-number offset so layout
    // matches a normal song-without-pickup.
    // EXCEPTION: in PRINT mode, render the pickup bar regardless of
    // exerciseMode. The printed worksheet should look like the source
    // score — the head's pickup melody appears as a visual prefix
    // ("A Foggy Day" has a quarter-note D pickup before bar 1) so
    // the rehearsal letter "A" stays anchored to bar 1's left edge
    // (not pushed into bar 1's content area). The pickup notes shown
    // are the original head melody even when exercising / blanked —
    // the rest of the row carries the exercise content as usual.
    // Computed BEFORE clefExtra because the pickup-stave needs the
    // clef-width slice reserved even in print mode (otherwise it
    // gets only the proportional beat width and the clef + time sig
    // + double bar crush together with no separation from bar 1).
    const _isHeadMode = (typeof exerciseMode !== 'undefined' && exerciseMode === 'head');
    const _showPickup = _isHeadMode || _printMode;
    const leadInBeats = (isFirstRow && _showPickup)
      ? (window.currentSong && window.currentSong.head && window.currentSong.head.leadInBeats) || 0
      : 0;
    // clefExtra: dedicated horizontal slice for the bass clef + time
    // signature on row 1's first stave. Three cases:
    //   - Continuation row: 0 (no clef redrawn).
    //   - Row 1, print mode, NO pickup: 0 — the clef is packed into
    //     bar 1's shared per-cell width by VexFlow's formatter,
    //     keeping the printed grid uniform.
    //   - Row 1 WITH pickup (any mode): firstMeasureClefWidth — the
    //     pickup stave needs room for clef + time sig + pickup notes
    //     + closing double bar. Without this, the print-mode pickup
    //     overlaps bar 1 and the double-bar separator disappears.
    //   - Row 1, non-print, no pickup: firstMeasureClefWidth (as before).
    const clefExtra = (!isFirstRow) ? 0
                    : (_printMode && leadInBeats === 0) ? 0
                    : firstMeasureClefWidth;
    const extraPerBar = (_printMode || isFirstRow) ? 0 : Math.floor(clefOnlyExtra / mpl);
    const pickupWidth = leadInBeats > 0
      ? Math.round((leadInBeats / ts.num) * measureWidth)
      : 0;
    // Pickup-shrink: when row 1 carries an anacrusis, the pickup's
    // horizontal slice is part of the row's total width budget.
    // Without compensation, row 1 would be wider than every other
    // row; since the SVG scales (viewBox + width:100%) to fit the
    // container, that wider row renders visually SMALLER on screen
    // (bars 1-N look squashed compared to bars on later rows).
    // Subtract an equal share of pickupWidth from each bar on row 1
    // so the row's total width matches the other rows and the global
    // scale stays uniform.
    const pickupShrinkPerBar = (leadInBeats > 0 && mpl > 0)
      ? Math.floor(pickupWidth / mpl)
      : 0;
    const barWidth = measureWidth + extraPerBar - pickupShrinkPerBar;
    // Always size the row as if it were a full MPL row so short rows (last
    // row, end-of-pass) keep the same per-bar width as full rows and the
    // remainder of the staff sits as empty space to the right.
    const rowWidth = leftPadding + clefExtra + pickupWidth + mpl * barWidth + rightPadding;
    // Per-bar width allocation. A row of [whole-note, 4-quarter,
    // 4-quarter, 4-quarter] used to give every bar an equal slice
    // even though the whole-note bar only needs ~25% of the four-
    // quarter bar's horizontal space. Now we weight each bar by
    // roughly the count of glyphs the renderer will emit and
    // redistribute the row's TOTAL content width by those weights.
    // The total stays the same (so empty trailing space on short
    // rows is preserved); only the share each bar takes shifts.
    //
    // Two-pass distribution:
    //   1. First pass weights every bar by glyph count (whole = 1,
    //      4-quarter = 4) and proportionally splits the row's
    //      content budget. Lighter bars become genuinely narrower.
    //   2. Any bar that falls below `MIN_BAR_PX` (the floor that
    //      keeps chord labels readable) gets clamped UP to that
    //      minimum, and the deficit is taken back PROPORTIONALLY
    //      from the bars that were above the floor. So a row of
    //      [whole, whole, whole, whole] still ends up equal — but a
    //      row of [whole, 4-qtr, whole, 4-qtr] gives the wholes the
    //      floor and the quarter bars eat the remaining width.
    // No coarse weight floor — that flattened the discrimination
    // for [whole, qtr+half] rows where both naturally weigh 1-2.
    function barNoteWeight(barIdxArg) {
      const rawBP = quarterNotes[barIdxArg] || [];
      const sStart = rawBP.simileStart;
      const bp = (sStart != null)
        ? rawBP.map((b, idx) => idx >= sStart ? null : b)
        : rawBP;
      const stepsBar = bp.length || ts.num;
      const sub = Math.max(1, Math.round(stepsBar / ts.num));
      const defDur = sub >= 2 ? '8' : 'q';
      const DTS = sub === 6
        ? { 'w': 24, 'h.': 18, 'h': 12, 'q.': 9,   'q': 6,   '8': 3 }
        : sub === 2
        ? { 'w': 8,  'h.': 6,  'h': 4,  'q.': 3,   'q': 2,   '8': 1 }
        : { 'w': 4,  'h.': 3,  'h': 2,  'q.': 1.5, 'q': 1 };
      let count = 0;
      let bb = 0;
      while (bb < stepsBar) {
        const slot = bp[bb];
        if (slot) {
          const dur = slot.duration || defDur;
          const cons = slot.stepsConsumed || DTS[dur] || 1;
          count++;
          bb += cons;
        } else {
          let run = 0;
          while (bb + run < stepsBar && !bp[bb + run]) run++;
          // Coalesced rests: roughly one glyph per half-bar of
          // silence (matches the renderer's half-bar boundary
          // splitting), with a floor of 1.
          const half = stepsBar / 2;
          count += Math.max(1, Math.ceil(run / half));
          bb += run || 1;
        }
      }
      return Math.max(1, count);
    }
    // Each chord label needs roughly the same horizontal slice as a
    // note glyph for the labels to space out without overlapping.
    // A bar with one whole note but FOUR chord changes (e.g.
    // "Am Dm Gm C7" stretched across a single sustained note) was
    // collapsing under the note-only weight of 1 and squeezing all
    // four labels into the chord-label area, where they overlap as
    // a single illegible "AmDmGmC7" run. Take the MAX of the note
    // weight and the live-chord count so the bar gets enough width
    // for whichever side of the engraving is denser.
    function barChordCount(bar) {
      if (!bar || !bar.chords) return 1;
      const live = bar.chords.filter(c => !c.slash);
      return Math.max(1, live.length);
    }
    // Blank-Staff exercise: every bar is empty (one invisible whole
    // rest) so chord-count and note-density weighting is the only
    // thing left to differ — and as a worksheet the user wants the
    // grid uniform regardless of whether one bar has a single chord
    // and the next has three. Force flat weights so the proportional
    // split below produces identical bar widths.
    const weights = rowBars.map((bar, i) => {
      if (exerciseMode === 'blank') return 1;
      return Math.max(barNoteWeight(rowStart + i), barChordCount(bar));
    });
    const sumWeight = weights.reduce((a, b) => a + b, 0) || 1;
    const totalContent = rowBars.length * barWidth;
    // Pass 1: pure proportional split.
    const barWidths = weights.map(w =>
      Math.max(1, Math.round(totalContent * w / sumWeight))
    );
    // Pass 2: clamp anything below MIN_BAR_PX up to that floor and
    // claw the deficit back from bars that have headroom. The floor
    // is "chord-label + a note glyph + breathing room" — anything
    // narrower is unreadable regardless of the proportional math.
    const MIN_BAR_PX = 90;
    let deficit = 0;
    for (let i = 0; i < barWidths.length; i++) {
      if (barWidths[i] < MIN_BAR_PX) {
        deficit += MIN_BAR_PX - barWidths[i];
        barWidths[i] = MIN_BAR_PX;
      }
    }
    if (deficit > 0) {
      // Pull the deficit out of the ABOVE-floor bars, proportional
      // to how much extra they each have above MIN_BAR_PX. If
      // every bar was already at the floor (whole row of wholes),
      // there's nothing to pull from and we just accept the
      // overshoot.
      const givable = barWidths
        .map(w => Math.max(0, w - MIN_BAR_PX))
        .reduce((a, b) => a + b, 0);
      if (givable > 0) {
        const factor = Math.min(1, deficit / givable);
        for (let i = 0; i < barWidths.length; i++) {
          const headroom = barWidths[i] - MIN_BAR_PX;
          if (headroom > 0) {
            barWidths[i] = Math.round(barWidths[i] - headroom * factor);
          }
        }
      }
    }
    // Round-off drift: the sum of the rounded widths can be off by
    // a pixel or two from totalContent. Park the drift on the
    // widest bar so x-advance through the row stays close to the
    // expected right edge without cutting into a near-floor bar.
    const widthDrift = totalContent - barWidths.reduce((a, b) => a + b, 0);
    if (widthDrift !== 0 && barWidths.length > 0) {
      let widestIdx = 0;
      for (let i = 1; i < barWidths.length; i++) {
        if (barWidths[i] > barWidths[widestIdx]) widestIdx = i;
      }
      barWidths[widestIdx] += widthDrift;
    }

    const rowEl = document.createElement('div');
    rowEl.className = 'staff-row';
    chartEl.appendChild(rowEl);

    const renderer = new VF.Renderer(rowEl, VF.Renderer.Backends.SVG);
    renderer.resize(rowWidth, staffHeight);
    const context = renderer.getContext();
    context.setFont('Arial', 10);

    // Measure number — labels the row's first NON-PICKUP bar so the
    // "1" lands next to bar 1 instead of next to the pickup. For all
    // other rows (and rows without a pickup) the number sits at x=4
    // in the left margin as before.
    const num = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    const numX = (isFirstRow && leadInBeats > 0)
      ? leftPadding + clefExtra + pickupWidth - 10
      : 4;
    num.setAttribute('x', numX);
    num.setAttribute('y', staffY + 2);
    num.setAttribute('font-family', 'serif');
    num.setAttribute('font-style', 'italic');
    num.setAttribute('font-size', 11);
    num.setAttribute('fill', '#000');
    num.textContent = rowStart + 1;
    // insertion happens after svg exists below

    let x = leftPadding;
    // Render the pickup stave first on row 1 (when present). The
    // pickup carries the clef + time signature; bars[0]'s stave
    // therefore skips its clef+sig in this case (see the !leadInBeats
    // checks in the rowBars loop below). Wrapped in try/catch so
    // any rendering issue inside the pickup helper doesn't take down
    // the whole chart — the bars[] rendering below stays intact and
    // the user just doesn't see the pickup.
    if (leadInBeats > 0 && isFirstRow) {
      const pickupTotalWidth = clefExtra + pickupWidth;
      try {
        // In print mode (or head mode), draw the head's actual pickup
        // melody notes so the printed worksheet matches the source
        // score. Outside of those, the pickup space is just rests.
        const isHeadMode = (exerciseMode === 'head') || _printMode;
        const pickupNotes = (window.currentSong && window.currentSong.head && window.currentSong.head.pickupNotes) || [];
        renderPickupStave(
          context, x, staffY, pickupTotalWidth,
          leadInBeats, ts, isHeadMode, pickupNotes
        );
      } catch (e) {
        // Surface the failure in the console (so we can diagnose)
        // but continue with the bars[] rendering. The pickup space
        // will be empty on screen, but the rest of the chart still
        // appears.
        console.error('Pickup render failed:', e);
      }
      x += pickupTotalWidth;
    }
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
      // `barWidths[i]` is the per-bar slice from the weighted
      // distribution above; the clefExtra is reserved space for
      // the bass clef + 8vb + time-sig glyphs, only present on
      // the very first measure of the score.
      // When the row has a pickup, the pickup stave already drew the
      // clef + time signature, so bars[0] doesn't need clefExtra and
      // doesn't add the clef again.
      const carriesClef = isFirstRow && isFirstInRow && leadInBeats === 0;
      const width = barWidths[i] + (carriesClef ? clefExtra : 0);
      // left_bar/right_bar default to true in VexFlow, which draws grey
      // vertical edges at the stave's left and right — the "border" around
      // each measure. Turn them off; we manage measure boundaries via
      // Barline modifiers only (and only for repeats / final / double).
      const stave = new VF.Stave(x, staffY, width, { left_bar: false, right_bar: false });
      // Clef + time signature only on the very first measure of the score
      // when there's no pickup (otherwise the pickup carries them).
      // Continuation rows skip the clef to keep the reading surface dense
      // and to make more note space available inside each bar.
      if (carriesClef) {
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
        r.setAttribute('class', 'rehearsal-mark');
        r.setAttribute('x', bx); r.setAttribute('y', by);
        r.setAttribute('width', bw); r.setAttribute('height', bh);
        r.setAttribute('fill', '#000');
        r.setAttribute('stroke', 'none');
        svgForSection.appendChild(r);
        const st = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        st.setAttribute('class', 'rehearsal-mark');
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
          // Rest tuplet member: build a rest tickable, fold it into
          // the active tuplet group, and skip every pitched-note
          // bookkeeping path (accidentals, ties, fingering data).
          // Without this branch a quarter-rest at the start of a
          // quarter triplet (Stablemates m. 29) would never reach
          // the tuplet collector, the bracket would be silently
          // dropped, and the bar's tick total wouldn't match — which
          // VexFlow recovers from by drawing a row of fallback
          // eighth-rest glyphs.
          // Blank Staff exercise: emit a rest tickable that VexFlow
          // counts toward the bar's tick total but paints transparent
          // so no glyph appears. The bar shows just the staff, key/
          // time signatures, bar lines, and the chord symbols above —
          // exactly what you want as a fill-in-the-blank worksheet.
          if (bp.blank) {
            let blankBase = dur;
            let blankDots = 0;
            while (blankBase.endsWith('.')) { blankDots++; blankBase = blankBase.slice(0, -1); }
            const r = new VF.StaveNote({ clef: 'bass', keys: ['d/3'], duration: blankBase + 'r' });
            if (blankDots > 0 && VF.Dot && VF.Dot.buildAndAttach) {
              VF.Dot.buildAndAttach([r], { all: true });
            }
            r.setStyle({ fillStyle: 'transparent', strokeStyle: 'transparent' });
            notes.push(r);
            barNoteData.push(null);
            b += consume;
            continue;
          }
          if (bp.rest) {
            let restBase = dur;
            let restDots = 0;
            while (restBase.endsWith('.')) { restDots++; restBase = restBase.slice(0, -1); }
            const r = new VF.StaveNote({ clef: 'bass', keys: ['d/3'], duration: restBase + 'r' });
            if (restDots > 0 && VF.Dot && VF.Dot.buildAndAttach) {
              VF.Dot.buildAndAttach([r], { all: true });
            }
            notes.push(r);
            barNoteData.push(null);
            // Rest slots stay at -1 in beatToNoteSlot — playback
            // and the fingering overlay both treat -1 as "no note
            // here", which is exactly what we want for a rest.
            if (bp.tuplet) {
              // Same beam-grouper markers as the pitched-note path —
              // a rest tuplet member also breaks any pending beam,
              // and a tuplet-start that sits on a rest still needs
              // to flush whatever beam was running before it.
              r._inTuplet = true;
              if (bp.tuplet.start) r._tupletStart = true;
              if (bp.tuplet.stop)  r._tupletStop  = true;
              if (bp.tuplet.start) {
                currentTupletNotes = [r];
                currentTupletRatio = { actual: bp.tuplet.actual, normal: bp.tuplet.normal };
              } else if (currentTupletNotes) {
                currentTupletNotes.push(r);
              }
              if (bp.tuplet.stop && currentTupletNotes) {
                const ratio = currentTupletRatio || { actual: 3, normal: 2 };
                const tupletObj = new VF.Tuplet(currentTupletNotes, {
                  num_notes: ratio.actual,
                  notes_occupied: ratio.normal,
                  bracketed: true,
                  // Force the bracket BELOW the noteheads. VexFlow's
                  // default places it on the stem-up side, which for
                  // our 8vb bass-clef means the bracket lands in the
                  // y≈30..60 band right where the chord row,
                  // position label, and fingering numbers live —
                  // overlapping everything. Below-the-staff is
                  // unconventional but never collides with the
                  // annotation stack above the staff.
                  location: -1
                });
                rowTuplets.push({ tuplet: tupletObj });
                currentTupletNotes = null;
                currentTupletRatio = null;
              }
            }
            b += consume;
            continue;
          }
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
          // `stepStart` records this note's first step in the bar so
          // overlays (e.g. Scale Degrees) can map it back to a beat
          // and from there to the chord active at that beat.
          barNoteData.push({ pitch: bp.pitch, tpc: bp.tpc, staveNote: n, duration: noteDur, stepStart: b });
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
            // Tag the StaveNote for the beam grouper. Without these
            // markers, an 8th-triplet inside a half-bar gets fused
            // into the surrounding eighth-note beam — the triplet
            // members' tick footprints (≈1365 ticks each) sum to
            // exactly one quarter, falling cleanly inside a 4/8 beam
            // group, so the standard boundary check doesn't fire.
            // Each tuplet should be its own self-contained beam.
            n._inTuplet = true;
            if (bp.tuplet.start) n._tupletStart = true;
            if (bp.tuplet.stop)  n._tupletStop  = true;
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
                bracketed: true,
                // Force the bracket BELOW the noteheads — see the
                // matching comment in the rest-tuplet path. Default
                // location=1 puts the bracket and the "3" marker
                // right inside the chord/position/fingering stack
                // above the staff.
                location: -1
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
        // Rests and non-beamable durations (quarter or longer)
        // naturally break beams.
        //
        // We build beams ourselves rather than calling
        // `VF.Beam.generateBeams` because that helper has been
        // observed to silently SKIP beam generation for some bars —
        // specifically, eighth-note runs that follow a half (or
        // longer) note in stem-down configurations sometimes come
        // back un-beamed even though the notes fall cleanly inside a
        // beat group. Walking the notes ourselves and constructing
        // VF.Beam directly is fully deterministic.
        const ticksPerWhole = VF.RESOLUTION;        // 16384 by default
        const ticksPerQuarter = ticksPerWhole / 4;  // 4096
        const groupTicks = ts.num === 3
          ? ticksPerQuarter * 3 / 2   // 3 eighths in waltz
          : ticksPerQuarter * 2;      // 4 eighths (half-bar) in 4/4 etc.
        let pending = [];
        let pendingGroup = -1; // beat-group index that `pending[]` belongs to
        let cursor = 0;
        const flushPending = () => {
          if (pending.length >= 2) {
            // `autoStem = true` (the second VF.Beam arg) tells VexFlow
            // to override each member's stem_direction so the whole
            // beamed group shares one direction. Without this, a beam
            // that includes notes straddling the stem-direction
            // pivot (D2 sounding / D3 written for our 8vb bass) ends
            // up with the last note flipped — its stem points the
            // opposite way of the others and the beam draws as a
            // crooked dog-leg connecting them.
            barBeams.push(new VF.Beam(pending.slice(), true));
          }
          pending = [];
          pendingGroup = -1;
        };
        for (const n of notes) {
          let dur = '';
          try { dur = n.getDuration ? n.getDuration() : ''; } catch (e) { dur = ''; }
          const isRest = !!(n.isRest && n.isRest());
          const isBeamable = !isRest && (dur === '8' || dur === '16' || dur === '32');
          // Tick footprint for this note. VF.StaveNote exposes
          // getTicks() as a Fraction; if it isn't available, fall
          // back to the duration token's standard tick count.
          let noteTicks = 0;
          try {
            const t = n.getTicks && n.getTicks();
            if (t && typeof t.value === 'function') noteTicks = t.value();
          } catch (e) { /* ignore */ }
          if (!noteTicks) {
            const STD_TICKS = {
              w: ticksPerWhole, h: ticksPerQuarter * 2,
              q: ticksPerQuarter, '8': ticksPerQuarter / 2,
              '16': ticksPerQuarter / 4, '32': ticksPerQuarter / 8
            };
            noteTicks = STD_TICKS[dur] || ticksPerQuarter;
          }
          if (isBeamable) {
            // Tuplets are self-contained beams. A tuplet-start note
            // closes any pending non-tuplet beam (or the previous
            // tuplet), and a tuplet-stop note closes the tuplet's
            // own beam afterwards. Without these flushes, an 8th
            // triplet in a half-bar of plain eighths gets fused
            // into the surrounding beam — its tick footprint
            // (≈4096 across three members = exactly one quarter)
            // sits cleanly inside the 4/8 beam group, so the
            // standard boundary check never fires.
            if (n._tupletStart && pending.length > 0) flushPending();
            if (!n._inTuplet) {
              // Standard non-tuplet boundary checks. Skipped for
              // tuplet members since the start/stop markers above
              // already isolate them; their ticks are also scaled
              // (×normal/actual) and don't align with our raw
              // beat-group arithmetic.
              const groupAtStart = Math.floor(cursor / groupTicks);
              const groupAtEnd = Math.floor((cursor + noteTicks - 1) / groupTicks);
              if (pending.length > 0 && groupAtStart !== pendingGroup) flushPending();
              if (pending.length > 0 && groupAtStart !== groupAtEnd) flushPending();
              pending.push(n);
              pendingGroup = groupAtStart;
            } else {
              pending.push(n);
              // Tuplet members live in their own implicit "group" —
              // reset pendingGroup so a following non-tuplet note
              // unambiguously starts a fresh comparison.
              pendingGroup = -1;
            }
            // Tuplet-stop closes the tuplet's beam before any
            // following notes (tuplet or otherwise) can extend it.
            if (n._tupletStop) flushPending();
          } else {
            // Quarter-or-longer note, dotted variants, or any rest
            // breaks the beam. A tuplet rest member that's also
            // tuplet-start/stop still flushes — none of those rests
            // is beamable on its own.
            flushPending();
          }
          cursor += noteTicks;
        }
        flushPending();
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
          t.setAttribute('class', 'chord-label');
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

          // Chord-notes overlay: tiny grey list of the chord-scale
          // tones rooted at this chord (e.g. "C D E F G A B" under a
          // CMaj7 label). Drawn just below the chord symbol; uses
          // the next chord's start x as its right boundary so a
          // bar with multiple chords doesn't bleed each chord's
          // notes into the next chord's slot. If the rendered text
          // overflows the slot, the notes are split across two lines
          // via a second <tspan>.
          if (overlayChordNotesOn || overlayChordTonesOn) {
            // Per-chord text rendering — shared path for the FULL
            // Chord Notes overlay AND the Chord Tones overlay. (The
            // Simplified variant uses a separate per-row line+
            // ticks+text pass below, modeled on Chord Scales, that
            // groups adjacent chords sharing the same note set.)
            // Find the chord that follows this one in song order —
            // either the next chord in the same bar, or the first
            // non-empty chord of a later bar. The contextual scale
            // picker uses this to pick Phrygian Dominant vs.
            // Mixolydian ♭9 for 7♭9 chords (V → minor i vs.
            // V → major I).
            let nextCh = null;
            if (ci + 1 < displayChords.length) {
              nextCh = displayChords[ci + 1];
            } else {
              for (let nbi = barIdx + 1; nbi < bars.length; nbi++) {
                const nextChords = (bars[nbi].chords || []).filter(c => !c.slash);
                if (nextChords.length) { nextCh = nextChords[0]; break; }
              }
            }
            const noteStr = overlayChordTonesOn
              ? chordToneText(ch, nextCh)
              : chordScaleNotesText(ch, nextCh);
            if (noteStr) {
              // Slot width: from this chord's cx to the next chord's
              // cx (or to the bar's right edge for the last chord).
              let slotEndX = labelAreaX0 + labelAreaW;
              if (ci < n - 1) {
                const next = chordBeatRange(n, ci + 1, beatsPerBarLabel);
                slotEndX = labelAreaX0 + (next.startBeat / beatsPerBarLabel) * labelAreaW;
              }
              const slotW = Math.max(20, slotEndX - cx - 2); // 2px gap
              const tn = document.createElementNS('http://www.w3.org/2000/svg', 'text');
              tn.setAttribute('class', 'chord-notes');
              tn.setAttribute('x', cx);
              // Bottom-band placement — chord notes live in the
              // same vertical region as chord scales, BELOW the
              // staff, not stacked under the chord symbol above.
              // chordNotesY1 was computed at the top of renderChart
              // (it depends on whether chord scales is also on, so
              // both bands fit without overlap).
              tn.setAttribute('y', chordNotesY1);
              tn.setAttribute('text-anchor', 'start');
              tn.setAttribute('font-family', 'sans-serif');
              // Match the chord-scale label's 16 px so the two
              // bottom-band overlays read at the same visual weight.
              tn.setAttribute('font-size', 16);
              tn.setAttribute('fill', '#888');
              tn.setAttribute('stroke', 'none');
              setSvgTextWithFlatFix(tn, noteStr);
              svg.appendChild(tn);
              // Wrap if the line is wider than the slot. getBBox is
              // reliable here because the text is already in the DOM.
              let bbox = null;
              try { bbox = tn.getBBox(); } catch (e) { /* ignore */ }
              if (bbox && bbox.width > slotW) {
                // Split notes roughly in half; bias the first line
                // slightly larger so a 7-note scale becomes 4 + 3
                // (which reads more natural than 3 + 4).
                const tokens = noteStr.split(' ');
                const firstCount = Math.ceil(tokens.length / 2);
                const line1 = tokens.slice(0, firstCount).join(' ');
                const line2 = tokens.slice(firstCount).join(' ');
                while (tn.firstChild) tn.removeChild(tn.firstChild);
                const span1 = document.createElementNS('http://www.w3.org/2000/svg', 'tspan');
                span1.setAttribute('x', cx);
                setSvgTextWithFlatFix(span1, line1);
                tn.appendChild(span1);
                const span2 = document.createElementNS('http://www.w3.org/2000/svg', 'tspan');
                span2.setAttribute('x', cx);
                // Same line-height the y-offset constants use so
                // the wrapped second line stays inside the
                // staffHeight reserved at the top of renderChart.
                span2.setAttribute('dy', String(CHORD_NOTES_LINE_HEIGHT));
                setSvgTextWithFlatFix(span2, line2);
                tn.appendChild(span2);
              }
            }
          }
        });
      }

      // Beat markers under the staff — blue circles with white "1"/"2"
      // /etc. on each downbeat, smaller blue dots on each "and"
      // (off-beat eighth). Always painted; visibility is gated by
      // `body.overlay-beats-on` via CSS so the Beats overlay toggle
      // just flips a class instead of triggering a full chart re-render.
      //
      // Markers anchor to the actual rendered StaveNote x at each
      // beat (or interpolate between flanking notes when a beat
      // falls inside a long held note). This places marker "2" right
      // under a sharp+eighth even though the accidental has shoved
      // the notehead off the "1/4 of the way across the bar" mark.
      //
      // Local push-apart for clustered markers: anchored positions
      // are kept wherever they fit, and only adjacent pairs that come
      // closer than MIN_GAP get nudged. A forward pass shoves each
      // marker right as needed; if the rightmost marker then spills
      // past the bar's note area, a backward pass pulls earlier
      // markers leftward to fit. This preserves alignment with the
      // last note (e.g. an and-of-4 eighth pinned to the right edge)
      // instead of falling back to pure even spacing across the bar.
      {
        const beatsPerBarMarker = ts.num;
        const beatY = staffY + 90; // ≈y=126: just under the bottom staff line (y=116)
        const DOWNBEAT_R  = 7;
        const ANDBEAT_R   = 2.5;
        const FILL        = '#3da9fc';
        const MIN_GAP     = 13;
        const slotWidth   = labelAreaW / beatsPerBarMarker;
        // Build (step, x) anchors from each rendered StaveNote in
        // this bar. Step starts come from cumulative tick counts —
        // tuplet members have scaled tick values, so triplets give
        // the right (rounded-integer) step counts.
        const ticksPerStep = (typeof VF !== 'undefined' && VF.RESOLUTION)
          ? (VF.RESOLUTION / (4 * subdiv)) : (4096 / subdiv);
        const anchors = [];
        let cumStep = 0;
        for (let ni = 0; ni < notes.length; ni++) {
          // VexFlow's getAbsoluteX() returns the notehead's LEFT
          // edge, not its center. Shift by half the glyph width so
          // the marker sits visually centered under the notehead —
          // critical at the start of a bar where the first note
          // butts up against the time signature with very little
          // padding (placing the marker at the left edge had it
          // looking offset from the notehead).
          let nx;
          try {
            const absX = notes[ni].getAbsoluteX();
            const w = (notes[ni].getGlyphWidth && notes[ni].getGlyphWidth()) || 10;
            nx = absX + w / 2;
          } catch (e) { nx = NaN; }
          if (isFinite(nx)) anchors.push({ step: cumStep, x: nx });
          // Tick count for advancing cumStep. Two VexFlow-4 quirks:
          //  1. StaveNote is constructed from the BARE duration ('q',
          //     '8', …); dots are attached afterwards via
          //     VF.Dot.buildAndAttach. getTicks() reflects only the
          //     bare duration, so a dotted quarter reports 4096 ticks
          //     (= a plain quarter) instead of 6144. Without
          //     compensation the cumulative step count drifts and a
          //     downbeat marker lands on the next note's notehead.
          //  2. Tuplet members already have scaled .value() (e.g. a
          //     quarter inside a triplet returns 2730), so the raw
          //     value is right for tuplets — only dots need adjusting.
          // Detect dots by counting Dot modifiers attached to the note
          // and dividing by the number of noteheads (Dot.buildAndAttach
          // attaches one dot per head). Apply factor (2 − 1/2^D).
          let rawTicks = 0;
          try {
            const tk = notes[ni].getTicks && notes[ni].getTicks();
            if (tk && typeof tk.value === 'function') rawTicks = tk.value();
          } catch (e) { /* ignore */ }
          let dotCount = 0;
          try {
            const mods = notes[ni].getModifiers ? notes[ni].getModifiers() : [];
            const numHeads = Math.max(1, (notes[ni].keys && notes[ni].keys.length) || 1);
            let dotMods = 0;
            for (let mi = 0; mi < mods.length; mi++) {
              const m = mods[mi];
              const cat = m && m.getCategory ? m.getCategory() : '';
              const cn  = m && m.constructor ? m.constructor.name : '';
              if (cat === 'Dots' || cat === 'Dot' || cn === 'Dot') dotMods++;
            }
            dotCount = Math.round(dotMods / numHeads);
          } catch (e) { /* ignore */ }
          if (dotCount > 0) {
            rawTicks = rawTicks * (2 - 1 / (1 << dotCount));
          }
          let stepCount = Math.round(rawTicks / ticksPerStep);
          if (stepCount <= 0) stepCount = 1;
          cumStep += stepCount;
        }
        // Implicit end anchor at noteEnd so beats past the last
        // note's start still get an x in range.
        anchors.push({ step: cumStep, x: noteEnd });
        anchors.sort(function (a, b) { return a.step - b.step; });
        function xAtStep(s) {
          if (anchors.length === 0) {
            return labelAreaX0 + (s / stepsPerBar) * labelAreaW;
          }
          let before = anchors[0];
          let after  = anchors[anchors.length - 1];
          for (let ai = 0; ai < anchors.length; ai++) {
            const a = anchors[ai];
            if (a.step <= s) before = a;
            if (a.step > s) { after = a; break; }
          }
          if (before === after || after.step === before.step) return before.x;
          const t = (s - before.step) / (after.step - before.step);
          return before.x + t * (after.x - before.x);
        }
        // Compute anchor-based positions for every marker step
        // (downbeats and ands), then check for cluster collisions.
        const stepsPerBeat = stepsPerBar / beatsPerBarMarker;
        const halfBeat     = stepsPerBeat / 2;
        const xs = [];
        for (let b = 0; b < beatsPerBarMarker; b++) {
          xs.push(xAtStep(b * stepsPerBeat));            // downbeat
          xs.push(xAtStep(b * stepsPerBeat + halfBeat)); // and
        }
        // Forward pass: enforce MIN_GAP by pushing each marker right
        // when its left neighbor crowds it. This only moves markers
        // that actually overlap; everything else stays on its anchor.
        for (let i = 1; i < xs.length; i++) {
          if (xs[i] - xs[i - 1] < MIN_GAP) xs[i] = xs[i - 1] + MIN_GAP;
        }
        // Backward pass: if the forward pass shoved the rightmost
        // marker past the bar's note area (noteEnd), pin it there and
        // pull earlier markers left to maintain MIN_GAP. Anchors that
        // were already comfortably left of any pushed marker keep
        // their original x — including, importantly, the anchor for
        // the final eighth at the and-of-4 position.
        if (xs.length && xs[xs.length - 1] > noteEnd) {
          xs[xs.length - 1] = noteEnd;
          for (let i = xs.length - 2; i >= 0; i--) {
            if (xs[i + 1] - xs[i] < MIN_GAP) xs[i] = xs[i + 1] - MIN_GAP;
          }
        }
        for (let b = 0; b < beatsPerBarMarker; b++) {
          const cxBeat = xs[b * 2];
          const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
          circle.setAttribute('class', 'beat-marker beat-down');
          circle.setAttribute('cx', cxBeat);
          circle.setAttribute('cy', beatY);
          circle.setAttribute('r', DOWNBEAT_R);
          circle.setAttribute('fill', FILL);
          circle.setAttribute('stroke', 'none');
          svg.appendChild(circle);
          const txt = document.createElementNS('http://www.w3.org/2000/svg', 'text');
          txt.setAttribute('class', 'beat-marker beat-down-text');
          txt.setAttribute('x', cxBeat);
          // y baseline + ~3 px lifts the digit's visual centre to
          // the circle centre for a balanced look on serif at 10pt.
          txt.setAttribute('y', beatY + 4);
          txt.setAttribute('text-anchor', 'middle');
          txt.setAttribute('font-family', 'serif');
          txt.setAttribute('font-weight', 'bold');
          txt.setAttribute('font-size', '10');
          txt.setAttribute('fill', '#fff');
          txt.setAttribute('stroke', 'none');
          txt.textContent = String(b + 1);
          svg.appendChild(txt);
          // The "and" between this beat and the next one (or the
          // start of the next bar). For 4/4: ands of 1/2/3/4. For
          // 3/4: ands of 1/2/3. Read from xs so cluster fallback
          // (even spacing) and anchor mode both flow through.
          const cxAnd = xs[b * 2 + 1];
          const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
          dot.setAttribute('class', 'beat-marker beat-and');
          dot.setAttribute('cx', cxAnd);
          dot.setAttribute('cy', beatY);
          dot.setAttribute('r', ANDBEAT_R);
          dot.setAttribute('fill', FILL);
          dot.setAttribute('stroke', 'none');
          svg.appendChild(dot);
        }
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
        h: barHighlightBottom - (staffY - 4),
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
          const idx = rowStartLocal + i;
          // Shift-click in Edit Mode extends the current selection
          // into a multi-bar range (used by Copy Fingerings).
          // Anywhere else, or any non-shift click, falls through to
          // the regular single-bar selection.
          if (ev.shiftKey
              && typeof emEnabled !== 'undefined' && emEnabled
              && selectedBar != null) {
            extendBarSelection(idx);
          } else {
            selectBar(idx);
          }
          break;
        }
      }
    });

    // Draw pattern overlays (bold key name + underline spanning the pattern).
    // For patterns that cross row boundaries, each row draws its own segment.
    // Skipped entirely when the Chord-scales overlay is off — and because
    // staffHeight was already shrunk above, the saved vertical space
    // actually compresses each row visibly on screen.
    const rowSvg = rowEl.querySelector('svg');
    const rowFirstBar = rowStart;
    const rowLastBar = rowStart + rowBars.length - 1;
    if (overlayChordScalesOn) patterns.forEach(pat => {
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

    // Chord Notes - Simplified runs. Each run is a stretch of
    // consecutive chord events that share the SAME SET of accidental
    // notes — a single grouped line, not one line per individual
    // note. Visual style mirrors the Chord Scales overlay above
    // (single-row band, line + ticks + label).
    if (overlayChordNotesSimplifiedOn && _simpRuns && _simpRuns.length) {
      const lineY = chordNotesY1 + 11;
      const textY = chordNotesY1 + 5;
      for (const run of _simpRuns) {
        const firstCE = chordEvents[run.firstIdx];
        const lastCE = chordEvents[run.lastIdx];
        const runFirstBar = firstCE.barIdx;
        const runLastBar = lastCE.barIdx;
        const iFirst = Math.max(rowFirstBar, runFirstBar);
        const iLast = Math.min(rowLastBar, runLastBar);
        if (iFirst > iLast) continue;
        const leftBar = barPosInRow.find(b => b.barIdx === iFirst);
        const rightBar = barPosInRow.find(b => b.barIdx === iLast);
        if (!leftBar || !rightBar) continue;
        const isRunStart = iFirst === runFirstBar;
        const isRunEnd = iLast === runLastBar;
        // X-coords mirror the Chord Scales math: when the run's
        // true start / end is inside this row AND that bar holds
        // multiple chords, position by the chord's beat slot rather
        // than the bar's edge.
        let startX = leftBar.noteStartX;
        if (isRunStart && firstCE.chordsInBar > 1) {
          const barW = leftBar.noteEndX - leftBar.noteStartX;
          const { startBeat } = chordBeatRange(firstCE.chordsInBar, firstCE.chordIdxInBar, ts.num);
          startX = leftBar.noteStartX + (startBeat / ts.num) * barW;
        }
        let endX = rightBar.noteEndX;
        if (isRunEnd && lastCE.chordsInBar > 1) {
          const barW = rightBar.noteEndX - rightBar.noteStartX;
          const { endBeat } = chordBeatRange(lastCE.chordsInBar, lastCE.chordIdxInBar, ts.num);
          endX = rightBar.noteStartX + (endBeat / ts.num) * barW;
        }
        const GAP_S = 2;
        const TICK_HEIGHT_S = 6;
        const lineStartX = startX + GAP_S;
        const lineEndX   = endX   - GAP_S;
        // One color per UNIQUE accidental set — keyed by the run's
        // label so two runs with the same set get the same color.
        const color = colorFor('acc:' + run.label);
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', lineStartX);
        line.setAttribute('y1', lineY);
        line.setAttribute('x2', lineEndX);
        line.setAttribute('y2', lineY);
        line.setAttribute('stroke', color);
        line.setAttribute('stroke-width', 2);
        line.setAttribute('stroke-linecap', 'round');
        rowSvg.appendChild(line);
        const ticks = [];
        if (isRunStart) ticks.push(lineStartX);
        if (isRunEnd) ticks.push(lineEndX);
        ticks.forEach(tx => {
          const tick = document.createElementNS('http://www.w3.org/2000/svg', 'line');
          tick.setAttribute('x1', tx);
          tick.setAttribute('y1', lineY - TICK_HEIGHT_S);
          tick.setAttribute('x2', tx);
          tick.setAttribute('y2', lineY);
          tick.setAttribute('stroke', color);
          tick.setAttribute('stroke-width', 2);
          tick.setAttribute('stroke-linecap', 'round');
          rowSvg.appendChild(tick);
        });
        // Group label only on the row where the run actually starts.
        if (isRunStart) {
          const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
          t.setAttribute('x', lineStartX + 4);
          t.setAttribute('y', textY);
          t.setAttribute('text-anchor', 'start');
          t.setAttribute('font-family', 'serif');
          t.setAttribute('font-weight', 'bold');
          t.setAttribute('font-size', 14);
          t.setAttribute('fill', color);
          t.setAttribute('stroke', 'none');
          setSvgTextWithFlatFix(t, run.label);
          rowSvg.appendChild(t);
        }
      }
    }

    // Diagram overlay: one mini fingerboard per scale-run, drawn
    // under the FIRST bar of the run within its own row. Continuation
    // rows (when a long run spans a row break) skip the diagram —
    // it's already shown earlier. Position: just inside the run's
    // start bar, anchored to `diagramBandY1` (top of diagram band).
    if (overlayDiagramOn && _diagramRuns && _diagramRuns.length) {
      for (const run of _diagramRuns) {
        const firstCE = chordEvents[run.firstIdx];
        const runFirstBar = firstCE.barIdx;
        // Skip if the run's first bar isn't in this row.
        if (runFirstBar < rowFirstBar || runFirstBar > rowLastBar) continue;
        const leftBar = barPosInRow.find(b => b.barIdx === runFirstBar);
        if (!leftBar) continue;
        // X-position: left edge of the run's first chord (beat-aware
        // when the bar holds multiple chords, matching Chord Scales).
        let startX = leftBar.noteStartX;
        if (firstCE.chordsInBar > 1) {
          const barW = leftBar.noteEndX - leftBar.noteStartX;
          const { startBeat } = chordBeatRange(firstCE.chordsInBar, firstCE.chordIdxInBar, ts.num);
          startX = leftBar.noteStartX + (startBeat / ts.num) * barW;
        }
        const scalePcs = new Set();
        if (run.root && run.scale) {
          for (const sd of run.scale) {
            scalePcs.add(((run.root.pitchClass + sd.s) % 12 + 12) % 12);
          }
        }
        appendMiniFingerboard(rowSvg, startX + 2, diagramBandY1, scalePcs);
      }
    }

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

    // === Annotation shift for high-note rows ===
    // When a row contains noteheads above the default annotation
    // band, the chord/position/fingering stack would overlap the
    // notes themselves. Shift the entire annotation stack UP by
    // the deficit and extend the SVG viewBox upward to give the
    // chord text somewhere new to live. The shift gets stored on
    // each barElement so emRenderPositions / emRenderFingerings
    // can apply the same offset when they paint over this row.
    if (svgEl) {
      let minNoteY = Infinity;
      for (let i = rowStart; i < rowEnd; i++) {
        const info = barElements[i];
        if (!info || !info.noteData) continue;
        for (let j = 0; j < info.noteData.length; j++) {
          const nd = info.noteData[j];
          if (!nd || !nd.staveNote) continue;
          try {
            const ys = nd.staveNote.getYs && nd.staveNote.getYs();
            if (ys && ys.length) {
              const yy = ys[0];
              if (isFinite(yy) && yy < minNoteY) minNoteY = yy;
            }
          } catch (e) { /* ignore */ }
        }
      }
      // The adaptive fingering already tracks the notehead for
      // mid-range pitches (y ≈ 70..82), so shift only kicks in
      // when notes are high enough that the fingering's floor
      // would crash into the notehead. With floor=56 (baseline)
      // and a 7 px target gap above noteheads, the threshold is
      // y=70: any note higher than that needs the whole
      // annotation stack lifted, with shift = (70 − minNoteY).
      const ANNOT_FLOOR_NOTE_Y = 70;
      let annotShift = 0;
      if (isFinite(minNoteY) && minNoteY < ANNOT_FLOOR_NOTE_Y) {
        annotShift = ANNOT_FLOOR_NOTE_Y - minNoteY;
      }
      // Stash on each barElement so the position / fingering
      // renderers can pick it up later. Stored even when 0 so the
      // renderers don't have to handle "undefined".
      for (let i = rowStart; i < rowEnd; i++) {
        if (barElements[i]) barElements[i].annotShift = annotShift;
      }
      if (annotShift > 0) {
        // Shift chord labels up by the same amount.
        svgEl.querySelectorAll('text.chord-label').forEach(t => {
          const oldY = parseFloat(t.getAttribute('y'));
          if (isFinite(oldY)) t.setAttribute('y', oldY - annotShift);
        });
        // Shift the rehearsal-mark badge (rect + text) too.
        svgEl.querySelectorAll('.rehearsal-mark').forEach(el => {
          const oldY = parseFloat(el.getAttribute('y'));
          if (isFinite(oldY)) el.setAttribute('y', oldY - annotShift);
        });
        // Extend the viewBox upward so the now-negative-y
        // chord/rehearsal elements are still visible. The CSS keeps
        // width:100% / height:auto, so the SVG visually grows taller
        // by `annotShift` pixels — pushing the chart's other rows
        // down to make room.
        const vb = svgEl.getAttribute('viewBox');
        if (vb) {
          const parts = vb.split(/\s+/).map(Number);
          if (parts.length === 4 && parts.every(isFinite)) {
            const newY = parts[1] - annotShift;
            const newH = parts[3] + annotShift;
            svgEl.setAttribute('viewBox', parts[0] + ' ' + newY + ' ' + parts[2] + ' ' + newH);
          }
        }
      }
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

  // Re-paint the Notes overlay across the freshly-rendered bars.
  // The overlay is global (every bar gets it when the toggle is on),
  // and renderChart just destroyed every bar's SVG, so any prior
  // overlay groups are gone with them. No-op when the toggle is off.
  if (typeof renderAllNotesOverlays === 'function') renderAllNotesOverlays();
  // Same deal for the Degree Name overlay (inside-the-head numbers)
  // and the Scale Degrees overlay (below-the-staff full labels) —
  // re-paint after the bars are re-drawn so the per-note marks
  // reattach to the new SVGs. We pass `bars` and `ts` explicitly
  // because `loadSong` calls `renderChart` BEFORE assigning
  // `window.currentSong`, so the overlay's `window.currentSong.bars`
  // fallback would still hold the PREVIOUS song's chord chart at
  // this moment.
  if (typeof renderAllDegreeNamesOverlays === 'function') {
    renderAllDegreeNamesOverlays(bars, ts);
  }
  if (typeof renderAllChordToneNamesOverlays === 'function') {
    renderAllChordToneNamesOverlays(bars, ts);
  }
  if (typeof renderAllScaleDegreesOverlays === 'function') {
    renderAllScaleDegreesOverlays(bars, ts);
  }
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
// Map a tempo value to a loop tier. Tier names match the realLoops
// key prefix. Boundaries are chosen so the tempo-seg buttons (80,
// 100, 120, 180) each land on their own dedicated source-bpm file
// when one exists. Anything in between picks the nearest tier and
// rate-shifts inside `startPlayback`.
function tempoTierFor(t) {
  if (t < 90) return 'ballad';     // 80 BPM file
  if (t < 110) return 'med-slow';  // 100 BPM file (4/4 only)
  if (t < 150) return 'medium';    // 120 BPM file
  return 'up';                      // 180 BPM file
}
// Resolve (tier, ts) → realLoops key, with a fallback for tier
// combinations we don't have a recorded file for (e.g. med-slow has
// no 3/4 file — falls back to medium-3/4 and the playbackRate
// compensation in startPlayback handles the 100 → 120 BPM offset).
function tempoLoopKey(tier, ts) {
  const key = tier + '-' + (ts && ts.str);
  if (realLoops[key]) return key;
  if (tier === 'med-slow') return 'medium-' + (ts && ts.str);
  return key; // fall through; caller handles missing entries
}
let currentRealLoop = null;
let drumMode = 'ride'; // 'hat' | 'ride' | 'click'
let countInBars = 1;  // 0, 1, or 2 measures of click before the song starts
let loopCountIn = false; // when true, the count-in fires at the top of every loop iteration
let playbackPart;
// Separate Tone.Part for "Play Head" override audio. Built only when
// the Head checkbox is on at startPlayback time; loops in lock-step
// with playbackPart's loopStart/loopEnd so the head melody keeps
// firing as the chord chart cycles. Disposed alongside playbackPart
// in stopPlayback.
let headPart = null;
let playState = 'stopped'; // 'stopped' | 'playing' | 'paused'
let pauseContext = null;   // { offset, beatsPerBar } captured at startPlayback; used by resume
let currentPlaylist = []; // sequence of { bar, idx } one entry = one bar
let currentBeatHighlight = null;
let selectedBar = null;   // user-tapped bar index; when set, play starts here
// Multi-bar selection range, used by Edit Mode's Copy Fingerings
// menu. When non-null, bars [min(selectedBar, end) .. max(...)] are
// all "selected" — visualised with the same blue highlight as
// `selectedBar`. A regular (non-shift) click resets this to null,
// as does any path through `selectBar()`.
let selectedBarRangeEnd = null;
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
  // 100 BPM files — their own bucket so the 100 BPM tempo button
  // plays at the recorded tempo with no playbackRate compensation
  // in either time signature. tempoLoopKey() still has the
  // 'med-slow' → 'medium' fallback as a safety net for any other
  // (tier, time-sig) gap that ever shows up.
  realLoops['med-slow-4/4'] = {
    player: new Tone.Player({
      url: 'drums/medium-4-4-100bpm.mp3',
      loop: true, autostart: false, fadeIn: 0.005, fadeOut: 0.005, volume: 0
    }).connect(drumsOut),
    beats: 16 // 4 bars of 4/4
  };
  realLoops['med-slow-3/4'] = {
    player: new Tone.Player({
      url: 'drums/medium-3-4-100bpm.mp3',
      loop: true, autostart: false, fadeIn: 0.005, fadeOut: 0.005, volume: 0
    }).connect(drumsOut),
    beats: 12 // 4 bars of 3/4
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
  if (headPart)     { headPart.stop();     headPart.dispose();     headPart = null; }
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

async function resumePlayback() {
  if (playState !== 'paused') return;
  // Naive `Tone.Transport.start()` resume leaves stale events in the
  // scheduler — a drum hit or comp stab queued ~50ms ahead of pause
  // can fire on resume out of phase with the rebuilt drum loop, and
  // the result is the lead, piano, and drums drifting out of sync.
  // Tear everything down and rebuild from scratch via startPlayback,
  // which gives a deterministic single-source-of-truth schedule.
  // The `prerollCountIn` flag rolls Transport BACK by `countInBars`
  // and fires count-in clicks before resuming the song, both giving
  // the user a beat to absorb the resume AND covering the half-bar
  // gap from "paused mid-bar at beat N" → "restart at beat 1 of that
  // bar" — the sync rebuild only knows whole bars.
  if (!window.currentSong) return;
  const expanded = expandBarsByRepeats(window.currentSong.bars, songRepeats);
  // startPlayback's prerollCountIn requires countInBars > 0 AND the
  // resume bar to be ≥ countInBars (so we have room to roll back).
  // For early bars or count-in-disabled, fall through to a plain
  // mid-song restart — still rebuilds cleanly, just without the
  // click pre-roll.
  await startPlayback(
    window.currentSong.song,
    expanded,
    currentPlayingBar,
    { prerollCountIn: countInBars > 0 }
  );
}

function clearHighlight() {
  document.querySelectorAll('svg .hi-overlay').forEach(el => el.remove());
}

// ===== Notes overlay =====
// State for the "Notes" entry in the Overlays dropdown. When on,
// every notehead in every bar gets the note letter painted inside
// it (white text on filled noteheads, black text on a small white
// disc for hollow whole/half notes). Independent of the "Beats"
// overlay, which only flips a body class to reveal the beat-marker
// circles renderChart already painted.
//
// The old position-based fingering system (1st/half/upper rings on
// the Note Info panel) was removed long ago; the user-authored Edit
// Fingering data is what replaces it. The function name and class
// `fingering-overlay` are kept here because removing them would be a
// large rename touching renderer hooks; conceptually this is now
// just the "note letter overlay".

let overlayNotesOn = false;
let overlayBeatsOn = false;
// Scale Degrees overlay: paint a number under each note showing its
// position relative to the active chord — 1/3/5/7 for chord tones,
// jazz extension numbering (b9, 9, #9, 11, #11, b13, 13, b7, 7) for
// non-chord-tones. Off by default; toggling re-renders the chart.
let overlayScaleDegreesOn = false;
// Current Note overlay: while playing back, the note currently
// sounding gets a blue notehead tint AND its note letter painted
// inside it (same letter style as the "Notes" overlay, but only
// on the lit note). Off by default; toggling on without playback
// has no immediate effect — the highlight starts firing on the
// next playback event.
let overlayCurrentNoteOn = false;
// Chord-scale lines (the bold key-name + colored underline showing
// which span of bars belongs to which key). On by default — they're
// the most useful sight-reading aid the chart offers. When off, the
// renderer skips the underline pass entirely AND shrinks the SVG
// height so the saved space actually compresses the score on screen
// (instead of leaving an empty band under each row). Default reflects
// the matching `checked` attribute on #overlayChordScalesToggle.
let overlayChordScalesOn = true;
// Chord notes: tiny grey list of the chord-scale tones written under
// each chord symbol (e.g. CMaj7 → "C D E F G A B"). Off by default;
// flipping it triggers a chart re-render so the per-chord text gets
// painted into the same SVG region as the chord labels themselves.
let overlayChordNotesOn = false;
// Simplified chord-notes overlay — only the sharp/flat notes from
// the chord's scale (skips naturals). Mutually exclusive with the
// regular Chord Notes overlay; the toggles below uncheck each
// other so only one is active at a time.
let overlayChordNotesSimplifiedOn = false;
// Chord tones overlay — only the 1 / 3 / 5 / 7 of each chord (e.g.
// CMaj7 → "C E G B", Cm7 → "C E♭ G B♭"). Shares the same bottom
// band as the two Chord Notes variants and is mutually exclusive
// with both — the same painter renders all three, swapping which
// text extractor it calls.
let overlayChordTonesOn = false;
// "Diagram" overlay: draw a miniature monochrome cello-fingerboard
// diagram below the staff at the start of each new chord-scale
// group, with dots at every scale-tone fret position. Mirrors the
// Chord Scales grouping (one diagram per consecutive same-scale
// run), so a long ii-V-i shows a single diagram covering all
// three chords.
let overlayDiagramOn = false;

// Remove every per-bar note-letter overlay group from the chart.
// We use a class selector so we don't have to track each painted
// group individually — there's one per rendered bar SVG.
function clearNotesOverlay() {
  document.querySelectorAll('.fingering-overlay').forEach(n => {
    if (n.parentNode) n.parentNode.removeChild(n);
  });
}

// Paint note-letter labels inside every notehead of every bar.
// Called when the Notes overlay is toggled on, and again after every
// chart re-render (the SVGs are recreated, taking the overlays with
// them). Cheap enough to recompute in full — typical songs have a
// few dozen bars and a few hundred notes total.
function renderAllNotesOverlays() {
  clearNotesOverlay();
  if (!overlayNotesOn) return;
  for (let bi = 0; bi < barElements.length; bi++) {
    if (barElements[bi]) paintNotesOverlayForBar(bi);
  }
}

// Degree Name overlay — paints a single digit 1..7 inside every
// notehead, the note's scale-degree position in its current chord's
// scale. Mutually exclusive with Note Name (both fill the notehead).
// Uses its own DOM class so each overlay clears only its own marks.
let overlayDegreeNamesOn = false;
function clearDegreeNamesOverlay() {
  document.querySelectorAll('.degree-name-overlay').forEach(n => {
    if (n.parentNode) n.parentNode.removeChild(n);
  });
}
function renderAllDegreeNamesOverlays(barsArg, tsArg) {
  clearDegreeNamesOverlay();
  if (!overlayDegreeNamesOn) return;
  let bars = barsArg, ts = tsArg;
  if (!bars) {
    const cs = window.currentSong;
    if (!cs || !cs.bars) return;
    bars = cs.bars;
    ts = cs.timesig;
  }
  for (let bi = 0; bi < barElements.length; bi++) {
    if (barElements[bi]) paintDegreeNamesOverlayForBar(bi, bars, ts);
  }
}

// Chord Tone Names overlay — paints 1 / 3 / 5 / 7 inside the
// notehead, but ONLY on actual chord tones. Every other note
// (passing tones, tensions, chromatic neighbours) is left blank.
// Resolves chord tones through diatonicIndexInScale so altered /
// HW-dim / WH-dim chords return their real 3 / 5 / 7 rather than a
// scale-passing-tone enharmonic.
let overlayChordToneNamesOn = false;
function clearChordToneNamesOverlay() {
  document.querySelectorAll('.chord-tone-name-overlay').forEach(n => {
    if (n.parentNode) n.parentNode.removeChild(n);
  });
}
function renderAllChordToneNamesOverlays(barsArg, tsArg) {
  clearChordToneNamesOverlay();
  if (!overlayChordToneNamesOn) return;
  let bars = barsArg, ts = tsArg;
  if (!bars) {
    const cs = window.currentSong;
    if (!cs || !cs.bars) return;
    bars = cs.bars;
    ts = cs.timesig;
  }
  for (let bi = 0; bi < barElements.length; bi++) {
    if (barElements[bi]) paintChordToneNamesOverlayForBar(bi, bars, ts);
  }
}

// Resolve a chord into the semitone-offsets of its 1 / 3 / 5 / 7,
// keyed by that label. Returns e.g. { 0:'1', 4:'3', 7:'5', 11:'7' }
// for a maj7 in Ionian, or { 0:'1', 3:'3', 6:'5', 9:'7' } for a
// dim7 in WH-diminished. Used by the per-note labeler below.
function chordToneOffsetMap(chord) {
  const canonical = chordToCanonical(chord);
  const root = exParseRoot(canonical);
  const scale = exGetScale(canonical);
  if (!root || !scale || !scale.length) return null;
  const out = {};
  for (const [di, label] of [[0,'1'],[2,'3'],[4,'5'],[6,'7']]) {
    const ridx = diatonicIndexInScale(di, scale);
    const sd = scale[((ridx % scale.length) + scale.length) % scale.length];
    if (!sd) continue;
    const offset = ((sd.s % 12) + 12) % 12;
    // Skip duplicates so an 8-note scale's wrap-around doesn't
    // overwrite the previous label at the same offset.
    if (!(offset in out)) out[offset] = label;
  }
  return out;
}

// Strip accidentals/extensions from noteToScaleDegreeLabel's output,
// collapsing everything to a plain 1..7 degree number. Examples:
//   b3 → 3, #9 → 3, 11 → 4, #11 → 4, b5 → 5, b13 → 6, 13 → 6,
//   b7 → 7, Maj7 → 7, b9 → 2.
// Semitone 6 keeps the chord-type-sensitive split from the parent
// function: dim / halfdim treat the tritone as b5 → "5"; everything
// else treats it as #11 → "4".
function noteToDegreeNumberLabel(semiOffset, chordType) {
  const s = ((semiOffset % 12) + 12) % 12;
  switch (s) {
    case 0:  return '1';
    case 1:  return '2'; // b9
    case 2:  return '2'; // 9
    case 3:  return '3'; // b3 / #9
    case 4:  return '3'; // 3
    case 5:  return '4'; // 11
    case 6:  return (chordType === 'halfdim' || chordType === 'other') ? '5' : '4';
    case 7:  return '5';
    case 8:  return '6'; // b13
    case 9:  return '6'; // 6 / 13
    case 10: return '7'; // b7
    case 11: return '7'; // 7 / Maj7
  }
  return '';
}

// Map a semitone offset from the chord root + the chord's quality
// to a jazz scale-degree label. Chord tones (1, 3 / b3, 5, 7 / b7)
// keep their basic number; non-chord tones use extension numbering
// (b9, 9, #9, 11, #11, b13, 13). Half-diminished's b5 stays "b5"
// rather than "#11". The chordType comes from getChordType().
function noteToScaleDegreeLabel(semiOffset, chordType) {
  const s = ((semiOffset % 12) + 12) % 12;
  switch (s) {
    case 0:  return '1';
    case 1:  return 'b9';
    case 2:  return '9';
    case 3:  return (chordType === 'minor' || chordType === 'halfdim' || chordType === 'other') ? 'b3' : '#9';
    case 4:  return '3';
    case 5:  return '11';
    case 6:  return (chordType === 'halfdim' || chordType === 'other') ? 'b5' : '#11';
    case 7:  return '5';
    case 8:  return 'b13';
    case 9:  return (chordType === 'other') ? '6' : '13';
    case 10: return 'b7';
    case 11: return (chordType === 'major') ? '7' : 'Maj7';
  }
  return '';
}

// Remove every per-bar scale-degree overlay group from the chart.
function clearScaleDegreesOverlay() {
  document.querySelectorAll('.scale-degree-overlay').forEach(n => {
    if (n.parentNode) n.parentNode.removeChild(n);
  });
}

// Paint scale-degree numbers under every note in every bar.
function renderAllScaleDegreesOverlays(barsArg, tsArg) {
  clearScaleDegreesOverlay();
  if (!overlayScaleDegreesOn) return;
  // Resolve bars + timesig: accept explicit args from `renderChart`
  // (where `window.currentSong` may not yet reflect the new song),
  // otherwise fall back to the global. Same for the toggle-handler
  // path which fires after a song is fully loaded.
  let bars = barsArg;
  let ts = tsArg;
  if (!bars) {
    const cs = window.currentSong;
    if (!cs || !cs.bars) return;
    bars = cs.bars;
    ts = cs.timesig;
  }
  for (let bi = 0; bi < barElements.length; bi++) {
    if (barElements[bi]) paintScaleDegreesOverlayForBar(bi, bars, ts);
  }
}

function paintScaleDegreesOverlayForBar(barIdx, barsArg, tsArg) {
  if (barIdx == null || barIdx < 0) return;
  const info = barElements[barIdx];
  if (!info || !info.noteEls || !info.noteData) return;
  const svg = info.rowEl.querySelector('svg');
  if (!svg) return;
  // Figure out which chords are in this bar (live chord events,
  // skipping slash continuations and N.C.). For multi-chord bars,
  // a note's beat position determines which chord is "active" for
  // its label. Single-chord bars take the only chord regardless.
  //
  // The renderer uses `expandBarsByRepeats` so the rendered bar
  // index ranges over the EXPANDED bar list; modulo `bars.length`
  // walks it back to the unrepeated chart. For Kcl/x "repeat prev
  // measure" bars (bar.chords is empty or all-slashes), the chord
  // is inherited from an earlier bar — same fallback the chart-
  // label code uses below. Without this, every Kcl bar would render
  // notes with no scale-degree labels.
  //
  // bars/ts come from the renderChart call site when available so
  // we don't read a stale `window.currentSong` during the brief
  // window between renderChart() and the song-state assignment in
  // loadSong (the cause of the "wrong scale degrees on first click,
  // correct on second click" bug).
  let bars = barsArg;
  let ts = tsArg;
  if (!bars) {
    const cs = window.currentSong;
    if (!cs || !cs.bars) return;
    bars = cs.bars;
    ts = cs.timesig;
  }
  const baseIdx = ((barIdx % bars.length) + bars.length) % bars.length;
  const bar = bars[baseIdx];
  if (!bar) return;
  let liveChords = (bar.chords || []).filter(c => c && !c.slash && !c.nc);
  if (!liveChords.length && bar.repeatPrev) {
    let cursor = baseIdx;
    while (cursor >= 0) {
      const b = bars[cursor];
      const cs2 = (b.chords || []).filter(c => c && !c.slash && !c.nc);
      if (cs2.length) { liveChords = cs2; break; }
      if (!b.repeatPrev || cursor - b.repeatPrev < 0) break;
      cursor -= b.repeatPrev;
    }
  }
  if (!liveChords.length) return;
  // ts may arrive as either a parsed `{num, denom}` object (when
  // renderChart called us mid-render) OR as the iRealPro time-sig
  // string `"44"` / `"34"` etc. (when we fell back to the global).
  // Parse the string form on demand.
  let beatsPerBar = 4;
  if (ts) {
    if (typeof ts === 'string' && typeof parseTimesig === 'function') {
      const parsed = parseTimesig(ts);
      if (parsed && parsed.num) beatsPerBar = parsed.num;
    } else if (ts.num) {
      beatsPerBar = ts.num;
    }
  }
  // Generator's actual step resolution for this bar. nd.stepStart is
  // expressed in THIS resolution, NOT a fixed 24th-note grid:
  //   - quarter-note exercises (scale, triads, walk, landmarks, ...)
  //     → 1 step per beat → stepsPerBar = beatsPerBar
  //   - eighth-note exercises (1235Eighth, 3579Eighth)
  //     → 2 steps per beat → stepsPerBar = 2 × beatsPerBar
  //   - head mode + triplet-capable generators
  //     → 6 steps per beat → stepsPerBar = 6 × beatsPerBar
  // The previous "always × 6" code only worked for the head-mode
  // generator and silently mis-mapped chord boundaries for every
  // quarter-note exercise on multi-chord bars (e.g. a Cm7 | F7 bar:
  // the F7's beat-3 note has stepStart=2 in quarter-note units, the
  // chordRange for F7 started at step 12 in 24th-note units, so the
  // lookup attributed the note to Cm7 instead and the scale-degree
  // label rendered against Cm7's root — producing "13" for the A
  // that should have labeled as "3" over F7).
  const stepsPerBar = (info.beatToNoteSlot && info.beatToNoteSlot.length)
    ? info.beatToNoteSlot.length
    : beatsPerBar * 6;
  const stepsPerBeat = Math.max(1, Math.round(stepsPerBar / beatsPerBar));
  // Pre-compute each chord's [startStep, endStep) range in the bar
  // in the generator's native step units.
  const chordRanges = liveChords.map((ch, ci) => {
    const r = chordBeatRange(liveChords.length, ci, beatsPerBar);
    return {
      startStep: r.startBeat * stepsPerBeat,
      endStep:   r.endBeat   * stepsPerBeat,
      chord: ch,
      canonical: chordToCanonical(ch),
      type: getChordType(chordToCanonical(ch)),
      root: exParseRoot(chordToCanonical(ch))
    };
  });
  // Lookup helper: chord active at the given step. Falls back to
  // the last chord when step lands past the bar's end (defensive).
  function chordAtStep(stepInBar) {
    for (const cr of chordRanges) {
      if (stepInBar >= cr.startStep && stepInBar < cr.endStep) return cr;
    }
    return chordRanges[chordRanges.length - 1];
  }

  const svgRect = svg.getBoundingClientRect();
  const vb = svg.viewBox && svg.viewBox.baseVal;
  const vbOK = vb && vb.width > 0 && vb.height > 0;
  const vbSY = vbOK ? vb.height / svgRect.height : 1;
  const vbOY = vbOK ? vb.y : 0;

  const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  g.setAttribute('class', 'scale-degree-overlay');
  g.setAttribute('pointer-events', 'none');
  svg.appendChild(g);

  // Y position: just below the staff (5-line staff bottom line is
  // at info.y + 80; the chart leaves room beneath for fingerings).
  // We want the label clear of the staff but not crashing into the
  // chord-scale band. Use a fixed offset below the staff bottom.
  const STAFF_BOTTOM_Y = info.y + 80;
  const LABEL_Y = STAFF_BOTTOM_Y + 12;

  for (let i = 0; i < info.noteData.length; i++) {
    const nd = info.noteData[i];
    if (!nd) continue; // rest
    if (nd.tpc == null || nd.pitch == null) continue;
    const cr = chordAtStep(nd.stepStart != null ? nd.stepStart : 0);
    if (!cr || !cr.root) continue;
    const noteEl = info.noteEls[i];
    if (!noteEl) continue;
    // Centre the label under the notehead. Ask VexFlow for the head's
    // x position when possible; otherwise fall back to DOM geometry.
    let labelX = null;
    const sn = nd.staveNote;
    if (sn) {
      try {
        const absX = sn.getAbsoluteX();
        const noteheadW = (sn.getGlyphWidth && sn.getGlyphWidth()) || 10;
        if (isFinite(absX)) labelX = absX + noteheadW / 2;
      } catch (e) {}
    }
    if (labelX == null) {
      const rect = noteEl.getBoundingClientRect();
      if (rect.width <= 0) continue;
      const vbSX = vbOK ? vb.width / svgRect.width : 1;
      const vbOX = vbOK ? vb.x : 0;
      labelX = (rect.left + rect.width / 2 - svgRect.left) * vbSX + vbOX;
    }
    // Use TPC-derived semitone offset so enharmonic equivalents
    // (D♯ vs E♭) get the spelling-aware semitone via the note's
    // pitch class. The label itself is semitone-keyed so the
    // distinction doesn't actually surface — same sound, same name.
    const noteSemi = ((nd.pitch % 12) + 12) % 12;
    const semiOffset = ((noteSemi - cr.root.pitchClass) % 12 + 12) % 12;
    const label = noteToScaleDegreeLabel(semiOffset, cr.type);
    if (!label) continue;
    const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    t.setAttribute('x', labelX);
    t.setAttribute('y', LABEL_Y);
    t.setAttribute('text-anchor', 'middle');
    t.setAttribute('dominant-baseline', 'central');
    t.setAttribute('font-family', 'sans-serif');
    t.setAttribute('font-size', 9);
    t.setAttribute('font-weight', 'bold');
    t.setAttribute('fill', '#444');
    t.setAttribute('stroke', 'none');
    t.textContent = label;
    g.appendChild(t);
  }
}

function paintNotesOverlayForBar(barIdx) {
  if (barIdx == null || barIdx < 0) return;
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

  for (let i = 0; i < info.noteData.length; i++) {
    const nd = info.noteData[i];
    if (!nd) continue; // rest
    const noteEl = info.noteEls[i];
    if (!noteEl) continue;
    const rect = noteEl.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    const noteX   = (rect.left + rect.width / 2 - svgRect.left) * vbSX + vbOX;
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
    // Overlay mode previously also painted position-based fingering
    // numbers (1/2/3/4) above the staff and "first/half/upper"
    // labels at position changes. Those have been removed — the
    // user-authored fingerings (Edit Mode) take over that role —
    // leaving only the note-letter inside the notehead, which is
    // the actual sight-reading aid the overlay still earns its
    // keep with.
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

}

// Paints the scale-degree number (1..7) inside every notehead in a
// single bar. Combines Note Name's inside-the-head rendering with
// Scale Degrees' per-step chord resolution so multi-chord bars
// label each note against the chord active at its beat.
function paintDegreeNamesOverlayForBar(barIdx, barsArg, tsArg) {
  if (barIdx == null || barIdx < 0) return;
  const info = barElements[barIdx];
  if (!info || !info.noteEls || !info.noteData) return;
  const svg = info.rowEl.querySelector('svg');
  if (!svg) return;

  let bars = barsArg, ts = tsArg;
  if (!bars) {
    const cs = window.currentSong;
    if (!cs || !cs.bars) return;
    bars = cs.bars;
    ts = cs.timesig;
  }
  const baseIdx = ((barIdx % bars.length) + bars.length) % bars.length;
  const bar = bars[baseIdx];
  if (!bar) return;
  let liveChords = (bar.chords || []).filter(c => c && !c.slash && !c.nc);
  if (!liveChords.length && bar.repeatPrev) {
    let cursor = baseIdx;
    while (cursor >= 0) {
      const b = bars[cursor];
      const cs2 = (b.chords || []).filter(c => c && !c.slash && !c.nc);
      if (cs2.length) { liveChords = cs2; break; }
      if (!b.repeatPrev || cursor - b.repeatPrev < 0) break;
      cursor -= b.repeatPrev;
    }
  }
  if (!liveChords.length) return;

  let beatsPerBar = 4;
  if (ts) {
    if (typeof ts === 'string' && typeof parseTimesig === 'function') {
      const parsed = parseTimesig(ts);
      if (parsed && parsed.num) beatsPerBar = parsed.num;
    } else if (ts.num) {
      beatsPerBar = ts.num;
    }
  }
  const stepsPerBar = (info.beatToNoteSlot && info.beatToNoteSlot.length)
    ? info.beatToNoteSlot.length
    : beatsPerBar * 6;
  const stepsPerBeat = Math.max(1, Math.round(stepsPerBar / beatsPerBar));
  const chordRanges = liveChords.map((ch, ci) => {
    const r = chordBeatRange(liveChords.length, ci, beatsPerBar);
    return {
      startStep: r.startBeat * stepsPerBeat,
      endStep:   r.endBeat   * stepsPerBeat,
      type: getChordType(chordToCanonical(ch)),
      root: exParseRoot(chordToCanonical(ch))
    };
  });
  function chordAtStep(stepInBar) {
    for (const cr of chordRanges) {
      if (stepInBar >= cr.startStep && stepInBar < cr.endStep) return cr;
    }
    return chordRanges[chordRanges.length - 1];
  }

  const svgRect = svg.getBoundingClientRect();
  const vb = svg.viewBox && svg.viewBox.baseVal;
  const vbOK = vb && vb.width > 0 && vb.height > 0;
  const vbSX = vbOK ? vb.width / svgRect.width : 1;
  const vbSY = vbOK ? vb.height / svgRect.height : 1;
  const vbOX = vbOK ? vb.x : 0;
  const vbOY = vbOK ? vb.y : 0;

  const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  g.setAttribute('class', 'degree-name-overlay');
  g.setAttribute('pointer-events', 'none');
  svg.appendChild(g);

  for (let i = 0; i < info.noteData.length; i++) {
    const nd = info.noteData[i];
    if (!nd) continue;
    if (nd.pitch == null) continue;
    const cr = chordAtStep(nd.stepStart != null ? nd.stepStart : 0);
    if (!cr || !cr.root) continue;
    const noteEl = info.noteEls[i];
    if (!noteEl) continue;
    const rect = noteEl.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    let headCX = (rect.left + rect.width / 2 - svgRect.left) * vbSX + vbOX;
    let headCY = (rect.top  + rect.height / 2 - svgRect.top)  * vbSY + vbOY;
    const sn = nd.staveNote;
    if (sn) {
      try {
        const absX = sn.getAbsoluteX();
        const ys = sn.getYs && sn.getYs();
        const noteheadW = (sn.getGlyphWidth && sn.getGlyphWidth()) || 10;
        if (isFinite(absX) && ys && ys.length) {
          headCX = absX + noteheadW / 2;
          headCY = ys[0];
        }
      } catch (e) {}
    }

    const noteSemi = ((nd.pitch % 12) + 12) % 12;
    const semiOffset = ((noteSemi - cr.root.pitchClass) % 12 + 12) % 12;
    const label = noteToDegreeNumberLabel(semiOffset, cr.type);
    if (!label) continue;

    const isHollow = nd.duration === 'w' || nd.duration === 'h';
    if (isHollow) {
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
    appendFingeringLabel(g, headCX, headCY, label, textColor, {
      inside: true, fontSize: 7
    });
  }
}

// Paints 1 / 3 / 5 / 7 inside chord-tone noteheads in a single bar.
// Same per-step chord resolution as paintDegreeNamesOverlayForBar
// (so multi-chord bars label each note against its own chord), but
// the per-note label comes from chordToneOffsetMap — passing tones
// and tensions return null and stay blank.
function paintChordToneNamesOverlayForBar(barIdx, barsArg, tsArg) {
  if (barIdx == null || barIdx < 0) return;
  const info = barElements[barIdx];
  if (!info || !info.noteEls || !info.noteData) return;
  const svg = info.rowEl.querySelector('svg');
  if (!svg) return;

  let bars = barsArg, ts = tsArg;
  if (!bars) {
    const cs = window.currentSong;
    if (!cs || !cs.bars) return;
    bars = cs.bars;
    ts = cs.timesig;
  }
  const baseIdx = ((barIdx % bars.length) + bars.length) % bars.length;
  const bar = bars[baseIdx];
  if (!bar) return;
  let liveChords = (bar.chords || []).filter(c => c && !c.slash && !c.nc);
  if (!liveChords.length && bar.repeatPrev) {
    let cursor = baseIdx;
    while (cursor >= 0) {
      const b = bars[cursor];
      const cs2 = (b.chords || []).filter(c => c && !c.slash && !c.nc);
      if (cs2.length) { liveChords = cs2; break; }
      if (!b.repeatPrev || cursor - b.repeatPrev < 0) break;
      cursor -= b.repeatPrev;
    }
  }
  if (!liveChords.length) return;

  let beatsPerBar = 4;
  if (ts) {
    if (typeof ts === 'string' && typeof parseTimesig === 'function') {
      const parsed = parseTimesig(ts);
      if (parsed && parsed.num) beatsPerBar = parsed.num;
    } else if (ts.num) {
      beatsPerBar = ts.num;
    }
  }
  const stepsPerBar = (info.beatToNoteSlot && info.beatToNoteSlot.length)
    ? info.beatToNoteSlot.length
    : beatsPerBar * 6;
  const stepsPerBeat = Math.max(1, Math.round(stepsPerBar / beatsPerBar));
  const chordRanges = liveChords.map((ch, ci) => {
    const r = chordBeatRange(liveChords.length, ci, beatsPerBar);
    return {
      startStep: r.startBeat * stepsPerBeat,
      endStep:   r.endBeat   * stepsPerBeat,
      root: exParseRoot(chordToCanonical(ch)),
      toneMap: chordToneOffsetMap(ch)
    };
  });
  function chordAtStep(stepInBar) {
    for (const cr of chordRanges) {
      if (stepInBar >= cr.startStep && stepInBar < cr.endStep) return cr;
    }
    return chordRanges[chordRanges.length - 1];
  }

  const svgRect = svg.getBoundingClientRect();
  const vb = svg.viewBox && svg.viewBox.baseVal;
  const vbOK = vb && vb.width > 0 && vb.height > 0;
  const vbSX = vbOK ? vb.width / svgRect.width : 1;
  const vbSY = vbOK ? vb.height / svgRect.height : 1;
  const vbOX = vbOK ? vb.x : 0;
  const vbOY = vbOK ? vb.y : 0;

  const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  g.setAttribute('class', 'chord-tone-name-overlay');
  g.setAttribute('pointer-events', 'none');
  svg.appendChild(g);

  for (let i = 0; i < info.noteData.length; i++) {
    const nd = info.noteData[i];
    if (!nd) continue;
    if (nd.pitch == null) continue;
    const cr = chordAtStep(nd.stepStart != null ? nd.stepStart : 0);
    if (!cr || !cr.root || !cr.toneMap) continue;
    const noteSemi = ((nd.pitch % 12) + 12) % 12;
    const offset = ((noteSemi - cr.root.pitchClass) % 12 + 12) % 12;
    const label = cr.toneMap[offset];
    if (!label) continue; // non-chord-tone — leave blank

    const noteEl = info.noteEls[i];
    if (!noteEl) continue;
    const rect = noteEl.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    let headCX = (rect.left + rect.width / 2 - svgRect.left) * vbSX + vbOX;
    let headCY = (rect.top  + rect.height / 2 - svgRect.top)  * vbSY + vbOY;
    const sn = nd.staveNote;
    if (sn) {
      try {
        const absX = sn.getAbsoluteX();
        const ys = sn.getYs && sn.getYs();
        const noteheadW = (sn.getGlyphWidth && sn.getGlyphWidth()) || 10;
        if (isFinite(absX) && ys && ys.length) {
          headCX = absX + noteheadW / 2;
          headCY = ys[0];
        }
      } catch (e) {}
    }

    const isHollow = nd.duration === 'w' || nd.duration === 'h';
    if (isHollow) {
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
    appendFingeringLabel(g, headCX, headCY, label, textColor, {
      inside: true, fontSize: 7
    });
  }
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

// Bind the Overlays dropdown — a top-toolbar button that opens a
// fixed-position checkbox menu. Each entry toggles one overlay:
//   - "Notes": paint the note letter inside every notehead in
//     every bar, all the time (delegated to renderAllNotesOverlays).
//   - "Beats": flip body.overlay-beats-on to reveal the beat-marker
//     SVG elements renderChart already painted under each bar.
// Both default off; clicking entries doesn't close the menu so the
// user can flip several on/off in one trip. The menu closes on a
// click outside (or Escape) — see the document-level handlers below.
(function bindOverlaysMenu() {
  const btn   = document.getElementById('overlaysBtn');
  const menu  = document.getElementById('overlaysMenu');
  const notes = document.getElementById('overlayNotesToggle');
  const beats = document.getElementById('overlayBeatsToggle');
  if (!btn || !menu) return;

  function openMenu() {
    const r = btn.getBoundingClientRect();
    menu.hidden = false;
    menu.style.top = (r.bottom + 4) + 'px';
    // Right-align the menu's right edge with the button's right
    // edge so it doesn't poke off the side of the screen on phones.
    menu.style.right = (window.innerWidth - r.right) + 'px';
    menu.style.left  = 'auto';
    btn.setAttribute('aria-expanded', 'true');
  }
  function closeMenu() {
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu.hidden) openMenu();
    else             closeMenu();
  });
  document.addEventListener('click', (e) => {
    if (menu.hidden) return;
    if (menu.contains(e.target) || btn.contains(e.target)) return;
    closeMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.hidden) closeMenu();
  });

  const degreeNames = document.getElementById('overlayDegreeNamesToggle');
  const chordToneNames = document.getElementById('overlayChordToneNamesToggle');
  // Note Name, Degree Name, and Chord Tone Names ALL paint inside
  // the notehead and would visually collide. Whenever one switches
  // on, the others switch off (and their existing marks are cleared).
  function turnOffInsideHeadOthers(except) {
    if (except !== 'notes' && notes && notes.checked) {
      notes.checked = false;
      overlayNotesOn = false;
      clearNotesOverlay();
    }
    if (except !== 'degree' && degreeNames && degreeNames.checked) {
      degreeNames.checked = false;
      overlayDegreeNamesOn = false;
      clearDegreeNamesOverlay();
    }
    if (except !== 'chordTone' && chordToneNames && chordToneNames.checked) {
      chordToneNames.checked = false;
      overlayChordToneNamesOn = false;
      clearChordToneNamesOverlay();
    }
  }
  if (notes) {
    notes.addEventListener('change', (e) => {
      overlayNotesOn = !!e.target.checked;
      if (overlayNotesOn) turnOffInsideHeadOthers('notes');
      renderAllNotesOverlays();
    });
  }
  if (degreeNames) {
    degreeNames.addEventListener('change', (e) => {
      overlayDegreeNamesOn = !!e.target.checked;
      if (overlayDegreeNamesOn) turnOffInsideHeadOthers('degree');
      renderAllDegreeNamesOverlays();
    });
  }
  if (chordToneNames) {
    chordToneNames.addEventListener('change', (e) => {
      overlayChordToneNamesOn = !!e.target.checked;
      if (overlayChordToneNamesOn) turnOffInsideHeadOthers('chordTone');
      renderAllChordToneNamesOverlays();
    });
  }
  const scaleDegrees = document.getElementById('overlayScaleDegreesToggle');
  if (scaleDegrees) {
    scaleDegrees.addEventListener('change', (e) => {
      overlayScaleDegreesOn = !!e.target.checked;
      renderAllScaleDegreesOverlays();
    });
  }
  const currentNote = document.getElementById('overlayCurrentNoteToggle');
  if (currentNote) {
    currentNote.addEventListener('change', (e) => {
      overlayCurrentNoteOn = !!e.target.checked;
      // Toggling OFF mid-playback: strip whatever's currently lit so
      // the user immediately sees the change. Toggling ON: the next
      // beat tick paints the next note — no manual repaint needed.
      if (!overlayCurrentNoteOn) clearNoteHighlight();
    });
  }
  if (beats) {
    beats.addEventListener('change', (e) => {
      overlayBeatsOn = !!e.target.checked;
      document.body.classList.toggle('overlay-beats-on', overlayBeatsOn);
    });
  }
  // Chord scales: full chart re-render when toggled. Unlike Notes
  // (SVG group append/remove) and Beats (CSS class toggle on already-
  // painted markers), the chord-scale band changes the SVG's viewBox
  // height — every row needs to be redrawn at the new size so the
  // saved space actually shrinks the score on screen.
  const chordScales = document.getElementById('overlayChordScalesToggle');
  if (chordScales) {
    chordScales.addEventListener('change', (e) => {
      overlayChordScalesOn = !!e.target.checked;
      if (typeof rerenderCurrent === 'function') rerenderCurrent();
    });
  }
  // Chord notes: also a re-render trigger. The notes are drawn as
  // SVG <text> children of each row's chord-symbol pass, which
  // only runs inside renderChart — so toggling without re-rendering
  // would leave the previous state on screen.
  const chordNotes = document.getElementById('overlayChordNotesToggle');
  const chordNotesSimplified = document.getElementById('overlayChordNotesSimplifiedToggle');
  const chordTones = document.getElementById('overlayChordTonesToggle');
  // Chord Notes, Chord Notes — Simplified, and Chord Tones all
  // paint into the same bottom band and are mutually exclusive.
  // Switching one on clears the others.
  function turnOffBottomBandOthers(except) {
    if (except !== 'notes' && chordNotes && chordNotes.checked) {
      chordNotes.checked = false;
      overlayChordNotesOn = false;
    }
    if (except !== 'simplified' && chordNotesSimplified && chordNotesSimplified.checked) {
      chordNotesSimplified.checked = false;
      overlayChordNotesSimplifiedOn = false;
    }
    if (except !== 'tones' && chordTones && chordTones.checked) {
      chordTones.checked = false;
      overlayChordTonesOn = false;
    }
  }
  if (chordNotes) {
    chordNotes.addEventListener('change', (e) => {
      overlayChordNotesOn = !!e.target.checked;
      if (overlayChordNotesOn) turnOffBottomBandOthers('notes');
      if (typeof rerenderCurrent === 'function') rerenderCurrent();
    });
  }
  if (chordNotesSimplified) {
    chordNotesSimplified.addEventListener('change', (e) => {
      overlayChordNotesSimplifiedOn = !!e.target.checked;
      if (overlayChordNotesSimplifiedOn) turnOffBottomBandOthers('simplified');
      if (typeof rerenderCurrent === 'function') rerenderCurrent();
    });
  }
  if (chordTones) {
    chordTones.addEventListener('change', (e) => {
      overlayChordTonesOn = !!e.target.checked;
      if (overlayChordTonesOn) turnOffBottomBandOthers('tones');
      if (typeof rerenderCurrent === 'function') rerenderCurrent();
    });
  }
  // Diagram: mini fingerboards under each new chord-scale group.
  // Independent of the other overlays — can be combined with Chord
  // Scales / Chord Notes / Chord Notes Simplified; the diagrams
  // just stack as the bottom band beneath whichever others are on.
  const diagram = document.getElementById('overlayDiagramToggle');
  if (diagram) {
    diagram.addEventListener('change', (e) => {
      overlayDiagramOn = !!e.target.checked;
      if (typeof rerenderCurrent === 'function') rerenderCurrent();
    });
  }
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
// "Head" checkbox next to the Lead Play switch. When ON, the Lead
// instrument plays the song's HEAD melody (from currentSong.head)
// regardless of what's being displayed — useful for hearing the
// melody as a backing track while practicing an exercise. The
// checkbox is disabled when no head is available for the current
// song. Pickup notes follow the same flag (see startPlayback).
let playHeadOverride = false;
(function bindPlayScoreSwitch() {
  const sw = document.getElementById('playScoreToggle');
  if (!sw) return;
  playScoreOn = sw.checked;
  sw.addEventListener('change', (e) => {
    playScoreOn = e.target.checked;
  });
})();
(function bindPlayHeadCheckbox() {
  const cb = document.getElementById('playHeadCheckbox');
  if (!cb) return;
  playHeadOverride = !!cb.checked;
  cb.addEventListener('change', async (e) => {
    playHeadOverride = !!e.target.checked;
    // Restart playback if currently playing so the new lead source
    // (head vs displayed score) takes effect immediately. Mirrors the
    // restart pattern used for key changes / exercise picks.
    await restartPlaybackInPlaceWithCountIn();
  });
})();
// Sync the Head checkbox's enabled state to the current song's head
// availability. Disabled when there's no head; auto-unchecks if
// the user switches to a headless song while it was on, so the
// flag doesn't silently persist into "no audio" territory.
function updatePlayHeadAvailability() {
  const cb = document.getElementById('playHeadCheckbox');
  if (!cb) return;
  const cs = window.currentSong;
  const hasHead = !!(cs && cs.head && Array.isArray(cs.head.notes) && cs.head.notes.length);
  cb.disabled = !hasHead;
  if (!hasHead && cb.checked) {
    cb.checked = false;
    playHeadOverride = false;
  }
}

// Restart playback in place at the current bar with a count-in
// pre-roll, so the user has a beat or two to absorb the change
// before the new audio kicks in. Used for any change that swaps
// the queued audio mid-playback (key, score, lick, exercise, drum
// pattern, etc.). Without the pre-roll the new pattern jumps in on
// whatever beat we happen to land on, which makes drums and lead
// audibly drift relative to the user's tapping foot.
//
// Falls through to a regular bar-0 restart when:
//   - we're not currently playing (nothing to restart),
//   - or there's no song / no Transport,
//   - or the user has count-in disabled (countInBars === 0) — in
//     that case it's just a plain in-place restart with no pre-roll.
async function restartPlaybackInPlaceWithCountIn() {
  if (playState !== 'playing' || !window.currentSong) return;
  const expanded = expandBarsByRepeats(window.currentSong.bars, songRepeats);
  await startPlayback(
    window.currentSong.song,
    expanded,
    currentPlayingBar,
    { prerollCountIn: countInBars > 0 }
  );
}

// ===== Current-note highlight in the score =====
// Paint the currently-playing note's stavenote group blue so the
// reader can track it. Gated on the "Current Note" overlay toggle.
// Note-letter painting is intentionally NOT done here — the user
// can flip on the "Note Name" overlay (which paints letters on
// every note in every bar) alongside Current Note when they want
// the combined view.
let lastLitNoteEl = null;
function clearNoteHighlight() {
  if (lastLitNoteEl) lastLitNoteEl.classList.remove('lit');
  lastLitNoteEl = null;
}
function updateNoteHighlight(barIdx, step) {
  if (lastLitNoteEl) lastLitNoteEl.classList.remove('lit');
  lastLitNoteEl = null;
  if (!overlayCurrentNoteOn) return;
  if (barIdx == null || step == null) return;
  const info = barElements[barIdx];
  if (!info || !info.beatToNoteSlot || !info.noteEls || !info.noteData) return;
  const slotIdx = info.beatToNoteSlot[step];
  if (slotIdx == null || slotIdx < 0) return;
  const noteEl = info.noteEls[slotIdx];
  const nd = info.noteData[slotIdx];
  if (!noteEl || !nd || nd.pitch == null) return; // rest
  noteEl.classList.add('lit');
  lastLitNoteEl = noteEl;
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
//   - Play button shows a small loop glyph when both brackets are placed,
//     and is disabled when we're in Head mode but the current song has no
//     head file (or the load resolved with nothing) — there'd be nothing
//     for the Lead to play and no notes to highlight.
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
    // Block Play in Head mode for songs without a head. We only
    // gate AFTER the head load has resolved (`headLoaded === true`)
    // so the button doesn't flash disabled during the brief async
    // fetch on song change. While playback is running we leave the
    // button enabled so the user can still hit it to pause.
    const headMissing =
      exerciseMode === 'head' &&
      !!window.currentSong &&
      window.currentSong.headLoaded === true &&
      !window.currentSong.head;
    playBtn.disabled = headMissing && !playing;
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
  // Any non-shift-click bar selection resets the multi-bar range.
  // Range extension goes through `extendBarSelection` instead.
  selectedBarRangeEnd = null;
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
// Paint a single highlight rect over `barIdx`. Shared between the
// primary highlightBar() and the multi-bar range extension.
function paintBarSelectionRect(idx) {
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
}

// Extend the current selection up-to or down-to `idx`. Used by
// shift-click in Edit Mode. Repaints all highlight rects for the
// inclusive range; the cursor (selectedBar) stays at the anchor.
function extendBarSelection(idx) {
  if (selectedBar == null) {
    selectBar(idx);
    return;
  }
  selectedBarRangeEnd = idx;
  clearHighlight();
  const a = Math.min(selectedBar, idx);
  const b = Math.max(selectedBar, idx);
  for (let bi = a; bi <= b; bi++) paintBarSelectionRect(bi);
  // Edit-mode overlays (cursor + fingering text) follow the anchor.
  if (typeof emRenderOverlays === 'function') emRenderOverlays();
  // The kebab's Copy state depends on whether anything is selected,
  // and the menu's Paste enabled state never changes on selection,
  // but call to keep things consistent.
  if (typeof emUpdateKebabState === 'function') emUpdateKebabState();
}

function highlightBar(idx) {
  clearHighlight();
  paintBarSelectionRect(idx);
  // Use the current barElements[idx] for downstream scroll math.
  const info = barElements[idx];
  if (!info) return;
  const svg = info.rowEl.querySelector('svg');
  if (!svg) return;
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

  // Count-in: N bars of click before the song starts. Fired DIRECTLY
  // on the click synth at computed audio-context times rather than
  // via Tone.Transport.scheduleOnce. The Transport-scheduled approach
  // was reliably dropping the very first click — events queued at
  // Transport position `0:0:0` lined up with Transport.start's
  // engaged time and landed in the audio scheduler's "in the past"
  // window. A direct `triggerAttackRelease(audioTime)` call at a
  // future-anchored time has no such race: the audio context just
  // queues the noise burst at the requested AudioContext time. We
  // tie the Transport.start call below to the SAME `_audioStartTime`
  // base so Transport.position=0 lines up with the first click.
  const _audioStartTime = Tone.now() + 0.2;
  const _beatSec = 60 / currentTempo;
  const offset = startBarIdx > 0 ? 0 : countInBars;
  for (let cb = 0; cb < offset; cb++) {
    for (let beat = 0; beat < beatsPerBar; beat++) {
      const accent = beat === 0;
      const t = _audioStartTime + (cb * beatsPerBar + beat) * _beatSec;
      try {
        click.triggerAttackRelease('32n', t, accent ? 0.95 : 0.55);
      } catch (e) {}
    }
  }
  // Pickup melody (anacrusis): schedule each pickup note to play at
  // the matching beat of the LAST count-in bar so the lead-in
  // approaches bar 1's downbeat from the previous bar's tail. Lives
  // outside the playbackPart's bars[]-driven schedule because the
  // pickup is conceptually before bar 1, not part of it. Plays only
  // when starting from bar 0 with at least one count-in bar (no
  // count-in → no room to fit the pickup; mid-song restart → the
  // pickup is irrelevant). Gated by playScoreOn inside the callback
  // so toggling Lead during playback flips the pickup audibility
  // along with everything else.
  const pickupHead = window.currentSong && window.currentSong.head;
  // Pickup playback fires in two cases:
  //   1. Score mode (`exerciseMode === 'head'`) — the lead-in is
  //      drawn on the staff, the lead audio plays it.
  //   2. "Play Head" override is on — the user chose to hear the
  //      head as a backing while practicing an exercise; play the
  //      pickup so the melody enters where it should, even though
  //      the chart shows something else (no visible lead-in).
  const _pickupHeadMode = (typeof exerciseMode !== 'undefined' && exerciseMode === 'head');
  const _shouldPlayPickup = _pickupHeadMode || playHeadOverride;
  if (_shouldPlayPickup && pickupHead && pickupHead.leadInBeats > 0
      && Array.isArray(pickupHead.pickupNotes) && pickupHead.pickupNotes.length
      && startBarIdx === 0 && countInBars > 0) {
    const leadInBeats = pickupHead.leadInBeats;
    const pickupBarIdx = countInBars - 1;
    // Same key shift as generateHeadFromScore (rawOffset only — the
    // octave-correction step that pulls the head into the cello
    // range isn't replicated here, so a heavily transposed pickup
    // may land an octave away from the head's main melody. Common
    // case (no transpose / song stays in its original key) is fine.
    const rawOffset = (KEY_TO_PC[currentKey] - KEY_TO_PC[originalKey] + 12) % 12;
    for (const n of pickupHead.pickupNotes) {
      if (n.rest || typeof n.midi !== 'number') continue;
      // 24-step grid → beats. stepStart is 0-indexed inside the pickup.
      const beatInPickup = (n.stepStart || 0) / 6;
      const beatPos = beatsPerBar - leadInBeats + beatInPickup;
      const beatInt = Math.floor(beatPos);
      const sub16 = Math.round((beatPos - beatInt) * 4);
      const time = `${pickupBarIdx}:${beatInt}:${sub16}`;
      const transposedMidi = n.midi + rawOffset;
      // +12 mirrors the same convention the in-Part lead playback
      // uses: head pitches are stored at sounding-bass-clef MIDI,
      // so we shift up an octave to hit the actual played pitch on
      // the guitar sampler.
      const noteName = midiToName(transposedMidi + 12);
      const durSec = ((n.durationSteps || 6) / 6) * (60 / currentTempo);
      Tone.Transport.scheduleOnce(t => {
        if (playScoreOn && guitar && guitar.loaded) {
          try { guitar.triggerAttackRelease(noteName, durSec, t, 0.7); } catch (e) {}
        }
      }, time);
    }
  }

  // "Play Head" override: when the user has the Head checkbox on,
  // build a parallel Tone.Part that fires head notes through the
  // Lead sampler regardless of what's being displayed (exercise,
  // blank, score variant). Built here as an EVENT ARRAY; the actual
  // Part is constructed after playbackPart so we can mirror its
  // loopStart / loopEnd — that's how the head keeps cycling
  // forever (the previous one-shot Tone.Transport.scheduleOnce
  // approach fired each note exactly once and went silent after
  // the first pass through the form).
  let _headEvents = null;
  if (playHeadOverride && pickupHead
      && Array.isArray(pickupHead.notes) && pickupHead.notes.length) {
    _headEvents = [];
    const rawOffsetH = (KEY_TO_PC[currentKey] - KEY_TO_PC[originalKey] + 12) % 12;
    for (const n of pickupHead.notes) {
      if (n.rest || typeof n.midi !== 'number') continue;
      const beatInHead = (n.stepStart || 0) / 6;
      const headBar = Math.floor(beatInHead / beatsPerBar);
      const beatInBar = beatInHead - headBar * beatsPerBar;
      // Store ALL head events, including bars before startBarIdx —
      // mirroring playbackPart's "every bar of the song" event set.
      // The Part's start(time, offset) call below handles skipping
      // pre-startBarIdx events on the FIRST pass through the form;
      // when the Part loops, internal time wraps back to 0 and
      // those early-bar events fire normally (otherwise PageUp
      // drill-back from mid-song would silently strip the head's
      // first N bars from every subsequent loop iteration too).
      //
      // Times stored at PART-RELATIVE bar coords (= same scheme as
      // playbackPart's events: bar 0 = song's first bar). The Part's
      // start position maps internal bar 0 onto the right Transport
      // bar (after count-in for bar-0 starts, or at startBarIdx for
      // mid-song).
      const beatInt = Math.floor(beatInBar);
      const sub16 = Math.round((beatInBar - beatInt) * 4);
      const time = `${headBar}:${beatInt}:${sub16}`;
      const transposedMidi = n.midi + rawOffsetH;
      const noteName = midiToName(transposedMidi + 12);
      const durSec = ((n.durationSteps || 6) / 6) * (60 / currentTempo);
      _headEvents.push({ time, noteName, durSec });
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
      // Bar position in seconds — used as the base for tuplet events
      // that need to bypass the Transport's swing engine.
      const barStartSec = absBar * beatsPerBar * (60 / currentTempo);
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
        // Time format selection. Tuplet members (`stepsConsumed` set —
        // we mark them this way in the head/lick generators) are
        // scheduled using NUMERIC SECONDS so the Transport's swing
        // engine doesn't pull them. With swing on, BBS positions like
        // `0:0:1.333` (an 8th-triplet inside a swung beat) sit inside
        // the swing band and get shifted, which makes triplets sound
        // oddly lopsided over a swing groove. Seconds-based times
        // bypass the BBS-to-ticks swing math, so a written triplet
        // plays as exact 1:1:1. Non-tuplet eighths still go through
        // BBS so the song's swing setting applies normally.
        const isTuplet = !!info.stepsConsumed;
        const time = isTuplet
          ? barStartSec + s * secondsPerStep
          : `${absBar}:${beat}:${sixteenth}`;
        events.push({
          time,
          type: 'beat', idx: entry.idx, beat, step: s, info, measurePitches,
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
      //   Ballad   (< 90):    brush sweep + taps on 2 & 4
      //   Med-slow (90-109):  crisp hi-hat ride at 100 BPM source
      //   Medium   (110-149): crisp hi-hat ride at 120 BPM source
      //   Up       (≥ 150):   quick brush shuffle (swung 8ths)
      const tempoTier = tempoTierFor(currentTempo);

      if (tempoTier === 'ballad') {
        // Prefer the real recorded loop when we have one for this time sig.
        // Otherwise fall back to the synthesized brush layer.
        const loopKey = tempoLoopKey('ballad', ts);
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
      } else if (tempoTier === 'medium' || tempoTier === 'med-slow') {
        // Both the 120 BPM medium loop and the 100 BPM med-slow loop
        // share the same crisp hi-hat ride pattern — only the source
        // BPM differs. Prefer the recorded loop; fall back to the
        // synthesized spang-a-lang when no file exists for this
        // (tier, time-sig) pairing.
        const loopKey = tempoLoopKey(tempoTier, ts);
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
        const loopKey = tempoLoopKey('up', ts);
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

  // Cross-event state for the lick playback path. Tracks the most
  // recent tuplet note's pitch so the next tuplet attack can release
  // it first — see the `type === 'beat'` handler. Without this, the
  // guitar sampler's 0.6s release tail piles three triplet notes on
  // top of each other and the first one perceptually dominates.
  let _lastTupletGuitarName = null;
  let _lastTupletEndTime = 0;
  playbackPart = new Tone.Part((time, ev) => {
    if (ev.type === 'barStart') {
      // Track the currently-playing bar so clear-loop / change-loop can
      // restart playback at the right spot (Transport.position keeps
      // climbing during looping and can't be trusted for this).
      const _prevBar = currentPlayingBar;
      currentPlayingBar = ev.idx;
      // Loop wraparound (form returned to its top, or a Loop In/Out
      // wrap fired): the new bar idx is much LOWER than where we
      // just were. Force an immediate scrollTo here, OUTSIDE of
      // Tone.Draw's audio-clock queue. After multiple PageUp
      // drill-backs the queue's callbacks can fire noticeably late,
      // and the scroll-up to the form's top would lag behind the
      // music. The threshold of 4 keeps this from firing on any
      // accidental forward-jump or first-bar startup (where _prevBar
      // is typically 0 or near-zero already).
      if (typeof _prevBar === 'number'
          && _prevBar > ev.idx + 4
          && !ev.scrollIntoView) {
        const info = barElements[ev.idx];
        const chartEl = document.getElementById('chart');
        if (info && info.rowEl && chartEl) {
          const rowTop = info.rowEl.offsetTop;
          // Match highlightBar's TOP_BUFFER so the new top-of-form
          // bar lands at the same y the regular per-row follow-scroll
          // would put it.
          const targetTop = Math.max(0, rowTop - 56);
          if (Math.abs(targetTop - chartEl.scrollTop) >= 20) {
            chartEl.scrollTo({ top: targetTop, behavior: 'smooth' });
          }
        }
      }
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
      // Skip the in-Part lead audio when "Play Head" override is on
      // — head notes are scheduled separately above (see the
      // playHeadOverride block before the bar loop). Without this
      // gate we'd double up: the override schedule plays head notes
      // AND this branch plays whatever the displayed exercise has
      // for the same beat slot.
      if (playScoreOn && !playHeadOverride && guitar && guitar.loaded
          && ev.info.pitch != null && ev.attackDurSec > 0) {
        const name = midiToName(ev.info.pitch + 12);
        // Tuplet voice-stealing. The guitar sampler has a 0.6s
        // release tail; at fast tempos a written triplet's three
        // attacks (≈166ms apart at ♩=120) all overlap inside note 1's
        // tail, and the first note perceptually dominates while
        // notes 2–3 attack into the mud. Cut the previous tuplet
        // note's sustain at the moment of the next tuplet attack so
        // each triplet member rings cleanly into its own slot. The
        // ringing tail still happens (via the sampler's release
        // envelope from this trigger point) but only one tail at a
        // time, and they're each the same length — so the three
        // notes sound equal. Non-tuplet notes are left alone (their
        // tails overlapping is the desired legato feel).
        const isTuplet = !!ev.info.stepsConsumed;
        if (isTuplet && _lastTupletGuitarName) {
          try { guitar.triggerRelease(_lastTupletGuitarName, time); } catch (e) {}
        }
        guitar.triggerAttackRelease(name, ev.attackDurSec, time, 0.7);
        if (isTuplet) {
          _lastTupletGuitarName = name;
          _lastTupletEndTime = time + ev.attackDurSec;
        } else {
          // Non-tuplet attack ends the tuplet chain — clear the
          // tracker so a future tuplet doesn't accidentally release
          // an unrelated previous note.
          _lastTupletGuitarName = null;
        }
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
          measurePitches: ev.measurePitches
        });
        updateNoteHighlight(ev.idx, ev.step);
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

  // "Play Head" override Part. Built only when _headEvents was
  // populated above (i.e. playHeadOverride was on at startPlayback
  // time and the song has a head). Mirrors playbackPart's loop
  // bounds so the head melody cycles forever in lock-step with the
  // chord chart — without this, the head events would be one-shots
  // that fire only on the first pass through the form.
  if (_headEvents && _headEvents.length) {
    headPart = new Tone.Part((time, ev) => {
      // Re-check the toggles inside the callback so flipping Lead Play
      // mid-playback silences the head without a rebuild.
      if (playScoreOn && playHeadOverride && guitar && guitar.loaded) {
        try { guitar.triggerAttackRelease(ev.noteName, ev.durSec, time, 0.7); } catch (e) {}
      }
    }, _headEvents.map(e => [e.time, e]));
    headPart.loop = true;
    headPart.loopStart = playbackPart.loopStart;
    headPart.loopEnd   = playbackPart.loopEnd;
    if (_prerollActive) {
      headPart.start(`${startBarIdx}:0:0`, `${startBarIdx}:0:0`);
    } else {
      headPart.start(`${offset}:0:0`);
    }
  }

  // If Real mode has a recorded drum loop for this tempo tier + time sig,
  // sync it to the Transport so it phase-locks with the bars. Adjust
  // playbackRate when the user tempo differs from the loop's source bpm.
  currentRealLoop = null;
  let midSongDrum = null; // set when we'll start the drum synchronously below
  if (drumMode === 'ride') {
    const tempoTier2 = tempoTierFor(currentTempo);
    const key = tempoLoopKey(tempoTier2, ts);
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
    // Fire count-in clicks DIRECTLY at audio-context times anchored
    // to `_audioStartTime` (the same base used by Transport.start
    // below, so Transport position prerollStart:0:0 lines up with
    // the first click). Same rationale as the bar-0 count-in: the
    // Transport.scheduleOnce path was dropping the first beat
    // because the scheduled time matched Transport's engaged time.
    for (let cb = 0; cb < countInBars; cb++) {
      for (let beat = 0; beat < beatsPerBar; beat++) {
        const accent = beat === 0;
        const t = _audioStartTime + (cb * beatsPerBar + beat) * _beatSec;
        try {
          click.triggerAttackRelease('32n', t, accent ? 0.95 : 0.55);
        } catch (e) {}
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
    // Delayed start. Tone's audio scheduler has a built-in lookahead
    // (~50–100 ms by default), so an event whose Transport time
    // EQUALS Transport's engaged time can land in the "already
    // passed" window when start() actually hooks up to the audio
    // clock — that event gets dropped. Starting 100 ms in the future
    // gives every scheduled event (including the very first
    // count-in click at `${prerollStart}:0:0`) headroom inside the
    // lookahead window so it fires reliably. The 100 ms lead-in is
    // short enough to feel instantaneous when the user taps Play.
    Tone.Transport.start(_audioStartTime);
  } else {
    Tone.Transport.position = startBarIdx > 0 ? `${startBarIdx}:0:0` : 0;
    if (midSongDrum) {
      try { midSongDrum.entry.player.start(undefined, midSongDrum.bufOffset); } catch (e) {}
    }
    // Same delayed-start trick. Critical for the bar-0 case with
    // count-in: the first click is scheduled at `0:0:0` and would
    // otherwise tie exactly with Transport.position=0, leading the
    // audio scheduler to drop it.
    Tone.Transport.start(_audioStartTime);
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

// Expand a "D.C. al 3rd Ending" chart. Runs AFTER expandIRealRepeats
// so the N1 / N3 markers survive on the bars that carried them.
// Canonical use: AABA charts that already have an N1/N2 pair inside
// the A section (so the first two A passes use first / second
// endings via the internal repeat), then close the B section with
// a "D.C. al 3rd ending" comment. The N3 bars are written at the
// tail of the chart — without this pass they'd play directly after
// B with no trip back through the form first.
//
// Without a Song is the canonical example: the chart shows A (N1),
// A (N2), B, then "D.C. al 3rd Ending" pointing back to the top of
// A, finishing with the N3 ending (E♭6 | Cm7 | Fm7 | B♭7).
//
// Algorithm:
//   1. Require a D.C.-al-3rd-ending marker somewhere in `bars`.
//   2. Find the N1 range to identify the A section's common bars
//      (0..firstN1-1) AND to derive the N3 length (matches N1's).
//   3. Find the first N3 bar.
//   4. SPLICE the A common bars in BEFORE the first N3 bar, so the
//      play order becomes A(N1) → A(N2) → B → A common → N3.
//   5. Tag every bar in the N3 range with ending='3' so the renderer
//      paints the "3rd Ending" bracket across the whole group (the
//      parser only marks the FIRST N3 bar — same convention as N1
//      and N2 — and the existing expand passes rely on the run-of-
//      bars tagging downstream).
function expandDCAl3rdEnding(bars) {
  let hasDCAl3rd = false;
  bars.forEach(b => {
    (b.markers || []).forEach(m => {
      if (m.type !== 'comment') return;
      const lc = (m.text || '').toLowerCase();
      if (lc.includes('d.c. al 3rd ending') || lc.includes('dc al 3rd ending')) {
        hasDCAl3rd = true;
      }
    });
  });
  if (!hasDCAl3rd) return bars;

  // N1 range: first bar tagged ending==1 through the last consecutive
  // one. Loose equality because the parser stores `ending` as a
  // string ("1") while callers think in numbers.
  let firstN1Idx = -1, lastN1Idx = -1;
  for (let i = 0; i < bars.length; i++) {
    if (bars[i].ending == 1) {
      if (firstN1Idx < 0) firstN1Idx = i;
      lastN1Idx = i;
    }
  }
  // N3 starts at the first bar tagged ending==3. Length matches N1's
  // (same convention used by iReal's repeat expander for N2).
  let firstN3Idx = -1;
  for (let i = 0; i < bars.length; i++) {
    if (bars[i].ending == 3) { firstN3Idx = i; break; }
  }
  if (firstN1Idx < 0 || firstN3Idx < 0) return bars;

  const n1Length = lastN1Idx - firstN1Idx + 1;
  const n3EndIdx = Math.min(firstN3Idx + n1Length - 1, bars.length - 1);

  const out = [];
  // Everything up to (but not including) the first N3 bar passes through.
  for (let i = 0; i < firstN3Idx; i++) out.push(bars[i]);
  // Then the A common bars (0..firstN1-1) — the D.C. trip back.
  for (let j = 0; j < firstN1Idx; j++) {
    const b = { ...bars[j], markers: bars[j].markers ? [...bars[j].markers] : [] };
    out.push(b);
  }
  // Then the N3 bars, every one tagged ending='3'.
  for (let k = firstN3Idx; k <= n3EndIdx; k++) {
    const b = { ...bars[k], markers: bars[k].markers ? [...bars[k].markers] : [] };
    b.ending = '3';
    out.push(b);
  }
  // Any trailing bars beyond the N3 range stay where they were.
  for (let k = n3EndIdx + 1; k < bars.length; k++) out.push(bars[k]);
  return out;
}

// Some iRealPro charts use a `}` (repeatEnd) WITHOUT an explicit
// `{` (repeatStart) — the convention is that the repeat goes back
// to the start of the current section (`*A`, `*B`, …) or to the
// song's first bar if no section marker has been seen yet. Almost
// Like Being In Love is one such chart: its A section has N1/N2
// endings closed by `}` but no opening `{`, so the repeater needs
// to infer that the repeat starts at bar 0.
//
// Walk the bars left-to-right. Track the most recent section
// marker (or 0). When a `repeatEnd` arrives without an active
// `repeatStart`, promote the section-start bar's left barline to
// `repeatStart` so expandIRealRepeats handles it the same way as
// an explicit `{...}`. Explicit `{` bars set the active marker;
// the active marker clears when a matching `}` is consumed, so
// multiple non-overlapping repeats in the same song still work.
function inferImplicitRepeats(bars) {
  const out = bars.map(b => ({ ...b, markers: b.markers ? [...b.markers] : [] }));
  let sectionStart = 0;
  let activeRepeatStart = -1;
  for (let i = 0; i < out.length; i++) {
    if (out[i].section) sectionStart = i;
    if (out[i].leftBar === 'repeatStart') activeRepeatStart = i;
    if (out[i].rightBar === 'repeatEnd') {
      if (activeRepeatStart < 0) {
        const startIdx = Math.min(sectionStart, i);
        if (out[startIdx] && out[startIdx].leftBar !== 'repeatStart') {
          out[startIdx].leftBar = 'repeatStart';
        }
      }
      activeRepeatStart = -1;
    }
  }
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
// Mark the button matching the iRealPro chart's PERMANENT key with
// an "ireal-key" class so CSS can draw a square around its label.
// Used as a "memo" indicator — only shows when a variant has
// rebased the active originalKey to its own key (e.g. a bassline
// scored in C over an iRealPro chart in Bb). When the chart is
// still on its native iRealPro key, originalKey === irealKey, and
// the existing circle (.original) already marks the spot, so the
// square is suppressed to avoid doubling up.
function syncKeySegIrealMarker() {
  const ireal = window.currentSong && window.currentSong.irealKey;
  document.querySelectorAll('#keySeg button').forEach(b => {
    const matches = ireal != null
      && ireal !== originalKey
      && b.dataset.key === ireal;
    b.classList.toggle('ireal-key', !!matches);
  });
}
// Variant rebase: when a score in a different key is loaded, treat
// the score's key as the new BASE for the song. Transpose the
// chord chart to that key, store the result as the new
// originalBars, move originalKey to the score's key (so the circle
// moves with it and future Key-seg clicks compute their offsets
// from the variant's key), and update markers. The iRealPro
// chart's permanent reference (irealBars / irealKey) is NOT
// touched — it survives the rebase so picking the default Head
// later can restore from it.
async function rebaseToScoreKey(scoreKey) {
  if (!window.currentSong) return;
  if (!scoreKey || !(scoreKey in KEY_TO_PC)) {
    // No score key info — leave the chart alone, just refresh marker.
    syncKeySegIrealMarker();
    return;
  }
  // Relative-major correction. Bass parts for minor-key tunes are
  // commonly notated with the key signature of the RELATIVE MAJOR
  // and `<mode>major</mode>` (or no mode at all), even though the
  // song is in minor — e.g. Autumn Leaves in Gm gets a 2-flat key
  // signature exported as "Bb major." `detectKeyTonicFromMusicXML`
  // takes that at face value and returns Bb, which would rebase
  // a Gm chart to Bb-something. When iReal says the song is minor
  // AND the detected score key is exactly the relative major
  // (iReal tonic + 3 semitones, mod 12), substitute the iReal's
  // own tonic — so the chart stays on Gm and the score plays at
  // its written pitches (which are already the G-minor pitches).
  const cs = window.currentSong;
  if (currentIsMinor && cs.irealKey && (cs.irealKey in KEY_TO_PC)) {
    const irealPc = KEY_TO_PC[cs.irealKey];
    const scorePc = KEY_TO_PC[scoreKey];
    if (((irealPc + 3) % 12) === scorePc) {
      scoreKey = cs.irealKey;
    }
  }
  // Compute the transpose offset from CURRENT originalKey (which
  // might already be a previous variant's key) to the new scoreKey.
  const offset = (KEY_TO_PC[scoreKey] - KEY_TO_PC[originalKey] + 12) % 12;
  if (offset === 0 && scoreKey === originalKey) {
    // Already on this key — no transpose needed; just refresh markers.
    currentKey = scoreKey;
    syncKeySegOriginal(originalKey);
    syncKeySegActive(currentKey);
    syncKeySegIrealMarker();
    return;
  }
  const useFlats = FLAT_KEYS.has(scoreKey)
    || (!currentIsMinor && (scoreKey === 'C#' || scoreKey === 'F#' || scoreKey === 'G#'));
  const newBars = transposeBars(window.currentSong.originalBars, offset, useFlats);
  window.currentSong.originalBars = newBars;
  window.currentSong.bars = newBars;
  originalKey = scoreKey;
  currentKey = scoreKey;
  syncKeySegOriginal(originalKey);
  syncKeySegActive(currentKey);
  syncKeySegIrealMarker();
  renderChart(window.currentSong.song, newBars, window.currentSong.timesig);
  await restartPlaybackInPlaceWithCountIn();
}
// Default-Head restore: undo any prior variant rebase by snapping
// originalKey + originalBars back to the iRealPro chart's
// untouched reference (irealKey + irealBars). Called when the user
// switches back to the default Head — ensures the chart is on the
// iRealPro key whenever the head is showing, since heads are
// authored in iRealPro key by convention.
async function restoreIrealKeyForDefaultHead() {
  const cs = window.currentSong;
  if (!cs || !cs.irealKey || !cs.irealBars) return;
  if (originalKey === cs.irealKey && cs.originalBars === cs.irealBars) {
    // Already on iRealPro baseline — nothing to do beyond refresh.
    syncKeySegIrealMarker();
    return;
  }
  cs.originalBars = cs.irealBars;
  cs.bars = cs.irealBars;
  originalKey = cs.irealKey;
  currentKey = cs.irealKey;
  syncKeySegOriginal(originalKey);
  syncKeySegActive(currentKey);
  syncKeySegIrealMarker();
  renderChart(cs.song, cs.irealBars, cs.timesig);
  await restartPlaybackInPlaceWithCountIn();
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
  bars = inferImplicitRepeats(bars);
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
  // And "D.C. al 3rd Ending" — charts whose A section already has
  // N1/N2 inside an internal repeat (so two A passes happen before
  // B), then close B with this marker pointing back to a tail N3.
  // Without a Song is the canonical example.
  bars = expandDCAl3rdEnding(bars);
  const normalized = normalizeKey(song.key);
  originalKey = normalized.key;
  currentKey = originalKey;
  currentIsMinor = normalized.minor;
  syncKeySegLabels(currentIsMinor);
  syncKeySegOriginal(originalKey);
  syncKeySegActive(currentKey);
  // Clear any leftover ireal-key marker from a prior song's variant
  // rebase. The marker depends on currentSong.irealKey vs
  // originalKey; right after assignment they're equal, so the
  // helper will produce no class. Calling it explicitly here also
  // cleans stale classes that were set against the previous song.
  document.querySelectorAll('#keySeg button.ireal-key').forEach(b => {
    b.classList.remove('ireal-key');
  });
  renderChart(song, bars, timesig);
  // Store both the original (untransposed) bars and the currently
  // displayed bars. Key changes re-transpose from the original so
  // repeated key flips don't accumulate rounding errors.
  window.currentSong = {
    song, bars, timesig,
    originalBars: bars,
    // Permanent reference to the iRealPro chart's bars + key. Stays
    // put even when a variant score in a foreign key rebases the
    // active originalKey/originalBars onto its own key. Picking the
    // default Head later restores from these.
    irealBars: bars,
    irealKey: originalKey,
    head: null,
    // `headLoaded` stays false during the async fetch so the
    // "No head found" banner doesn't flash while we're still
    // waiting for the file. Set to true once the load resolves,
    // regardless of whether a head was found.
    headLoaded: false
  };
  // Edit Mode toggle is gated on (Head mode + head loaded). At
  // this exact moment headLoaded is false, so this disables the
  // toggle for the brief window between "song picked" and "head
  // fetch resolved". The post-fetch callback re-enables it (or
  // keeps it off, for headless songs).
  if (typeof emUpdateAvailability === 'function') emUpdateAvailability();
  document.getElementById('status').textContent = `Loaded: ${song.title} (${bars.length} bars)`;
  // Score discovery + head load, consolidated. Used to be two parallel
  // async blocks (loadSongHead by title + listScoresForSong) but that
  // left songs with NO default head (e.g. Oleo, which only ships
  // with a bassline variant) stuck on "No head found" — the dropdown
  // showed the variant visually-selected, but no change event fired
  // to actually load it. Doing both in one flow lets us pick the
  // right initial score: default head if it exists, else the first
  // variant, and load it directly.
  (async () => {
    const scores = await listScoresForSong(song.title);
    if (!window.currentSong || window.currentSong.song !== song) return;
    const defaultEntry = scores.find(s => s.isDefault);
    const defaultFilename = defaultEntry ? defaultEntry.filename : null;
    // Default head's filename — used by the variant-load handler to
    // tell "user picked the default" (no rebase, no square) from
    // "user picked a variant" (rebase + square).
    window.currentSong.defaultScoreFilename = defaultFilename;
    // Initial score to load. Prefer the default head; fall back to
    // the first variant in the list (alphabetical) so songs that
    // ship only with a bassline / etude render that score by
    // default. No scores at all → fall back to the synthetic
    // "(Blank)" sentinel; the modeSeg stays on Score and the chart
    // renders empty staves with chord changes above (the exact
    // behaviour the old "Blank" segmented button used to provide).
    const initialEntry = defaultEntry || (scores.length > 0 ? scores[0] : null);
    const initialFilename = initialEntry ? initialEntry.filename : SCORE_BLANK_VALUE;
    window.currentSong.scoreFilename = initialFilename;
    // Sync exerciseMode to the new song's reality, but ONLY when
    // we're already in the Score branch (head or blank). If the
    // user is currently in an Exercise mode, leave them there —
    // loading a new song shouldn't yank them out of their picked
    // exercise. When in Score: a song with a head flips us to
    // 'head', a song without flips us to 'blank'. This handles two
    // cases at once:
    //   - Previous song was headless (exerciseMode='blank') and
    //     the new song HAS a head → flip back to 'head' so the
    //     chart actually renders the loaded melody.
    //   - Previous song had a head and the new song has none →
    //     flip to 'blank' so we don't try to render a missing head.
    if (exerciseMode === 'head' || exerciseMode === 'blank') {
      exerciseMode = (initialFilename === SCORE_BLANK_VALUE) ? 'blank' : 'head';
    }
    if (_dropdownMode === 'score' || exerciseMode === 'head' || exerciseMode === 'blank') {
      populateScoreDropdown(scores, initialFilename);
    }
    // Load the chosen score (or skip when (Blank) is selected — there's
    // nothing to load and the blank-staff generator runs at render time).
    const head = (initialFilename && initialFilename !== SCORE_BLANK_VALUE)
      ? await loadHeadFromFilename(initialFilename)
      : null;
    if (!window.currentSong || window.currentSong.song !== song) return;
    window.currentSong.head = head;
    window.currentSong.headLoaded = true;
    // Recompute songRepeats from the loaded score's bar length.
    if (typeof _updateRepeatsSegLock === 'function') _updateRepeatsSegLock();
    // Key handling. Default head: stay on iRealPro key (heads are
    // authored in iRealPro key by convention). Variant fallback:
    // rebase to the variant's key, mirroring what would happen if
    // the user manually picked it from the dropdown. No score: just
    // clear any leftover ireal-key marker from a prior song.
    const isVariantFallback = initialEntry && !defaultEntry;
    if (isVariantFallback && head && head.keyTonic) {
      await rebaseToScoreKey(head.keyTonic);
    } else {
      syncKeySegIrealMarker();
    }
    if (exerciseMode === 'head' || exerciseMode === 'blank') rerenderCurrent();
    updateLoopControls();
    if (typeof emUpdateAvailability === 'function') emUpdateAvailability();
    if (typeof updatePlayHeadAvailability === 'function') updatePlayHeadAvailability();
  })();
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
  // the transposed bars. Pre-roll a count-in so the user has a beat
  // to absorb the change instead of the new key crashing in mid-bar.
  await restartPlaybackInPlaceWithCountIn();
}

document.querySelectorAll('#keySeg button').forEach(btn => {
  btn.addEventListener('click', () => applyKeyChange(btn.dataset.key));
});

// Spacebar = scroll the score one "almost-page" down (matches the
// PageDown handler immediately below — same step size, same eased
// animation). Bail when typing in a field so space can still insert
// a character, when a button has focus so the browser's native
// space-activates-button behavior still works, or when any modifier
// is held (don't hijack Ctrl-Space etc.).
//
// Enter = toggle the Chord Tones overlay. Skipped when a button or
// link has focus so the browser's native enter-activates-control
// still fires, and when typing in a field.
document.addEventListener('keydown', e => {
  const isSpace = e.key === ' ' || e.code === 'Space';
  const isEnter = e.key === 'Enter';
  if (!isSpace && !isEnter) return;
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
  const t = e.target;
  if (t) {
    const tag = (t.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if (tag === 'button' || tag === 'a') return;
    if (t.isContentEditable) return;
  }
  if (isSpace) {
    const chartEl = document.getElementById('chart');
    if (!chartEl) return;
    e.preventDefault();
    const step = Math.max(40, Math.round(chartEl.clientHeight * 0.75));
    _animateChartScroll(chartEl, step);
    return;
  }
  // Enter — toggle the Chord Tones overlay. Going through the
  // checkbox's change event triggers the existing handler, which
  // already does the bottom-band mutual exclusion AND the chart
  // re-render — no need to duplicate that logic here.
  const cb = document.getElementById('overlayChordTonesToggle');
  if (!cb) return;
  e.preventDefault();
  cb.checked = !cb.checked;
  cb.dispatchEvent(new Event('change'));
});

// Page Up / Page Down — scroll the score (#chart) regardless of where
// keyboard focus currently sits. The browser's native PageUp/Down
// scrolls whatever's focused (often the body), which doesn't move the
// chart since it's its own scrollable region. Capture the keys at the
// document level, route the scroll to the chart, and use 75% of the
// chart's visible height per press so each tap moves a comfortable
// "almost-a-page" amount with overlap to keep context.
//
// Custom 1-second ease-in-out animation instead of the browser's
// `behavior: 'smooth'` — the native version is typically too fast
// (~200-400ms) and varies by browser, so the eye can't easily track
// the line. A full second with cubic ease-in-out gives the user time
// to follow their place on the score.
let _pageScrollRAF = null;
let _pageScrollStart = 0;
let _pageScrollFrom = 0;
let _pageScrollTo = 0;
let _pageScrollEl = null;
function _easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}
function _animateChartScroll(el, deltaY) {
  // If a previous animation is mid-flight, cancel it and restart
  // from the CURRENT position toward (current + delta). This makes
  // repeated PageDown presses feel responsive — the new target is
  // computed against where the chart actually is right now, not
  // where the prior animation was headed.
  if (_pageScrollRAF) cancelAnimationFrame(_pageScrollRAF);
  _pageScrollEl = el;
  _pageScrollFrom = el.scrollTop;
  const maxTop = el.scrollHeight - el.clientHeight;
  _pageScrollTo = Math.max(0, Math.min(maxTop, _pageScrollFrom + deltaY));
  _pageScrollStart = performance.now();
  const DURATION_MS = 1000;
  function step(now) {
    const t = Math.min(1, (now - _pageScrollStart) / DURATION_MS);
    const eased = _easeInOutCubic(t);
    _pageScrollEl.scrollTop = _pageScrollFrom
      + (_pageScrollTo - _pageScrollFrom) * eased;
    if (t < 1) {
      _pageScrollRAF = requestAnimationFrame(step);
    } else {
      _pageScrollRAF = null;
    }
  }
  _pageScrollRAF = requestAnimationFrame(step);
}
document.addEventListener('keydown', e => {
  if (e.key !== 'PageUp' && e.key !== 'PageDown') return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  // Let inputs / textareas / contenteditable handle their own
  // PageUp/Down (some users navigate within long fields).
  const t = e.target;
  if (t) {
    const tag = (t.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') return;
    if (t.isContentEditable) return;
  }
  // Drill-back: while PLAYING, PageUp jumps back 2 bars and
  // restarts with a count-in so the user can immediately
  // re-attempt a tricky passage without reaching for the mouse.
  // Page Down keeps its scroll behavior even while playing — useful
  // for skimming ahead. When a Loop In/Out is active, we clamp the
  // jump-target to loopIn so drill-back stays inside the loop
  // (going before loopIn would break the loop's wraparound).
  if (e.key === 'PageUp'
      && playState === 'playing'
      && window.currentSong) {
    e.preventDefault();
    const hasLoop = loopIn != null && loopOut != null && loopIn <= loopOut;
    let target = Math.max(0, (currentPlayingBar || 0) - 2);
    if (hasLoop && target < loopIn) target = loopIn;
    selectedBar = target;
    // IMMEDIATE visual feedback: snap the highlight back and scroll
    // the chart now, before startPlayback does its teardown +
    // setup. Without this, the user sees a half-second pause where
    // the old bar stays highlighted while the playback rebuilds —
    // then the count-in starts and only THEN does the highlight
    // catch up. Doing it synchronously here makes the line visibly
    // snap back the instant they tap PageUp; startPlayback's own
    // highlight call later just re-applies the same state.
    currentPlayingBar = target;
    if (typeof highlightBar === 'function') highlightBar(target);
    {
      const info = barElements && barElements[target];
      const chartEl = document.getElementById('chart');
      if (info && info.rowEl && chartEl) {
        const rowTop = info.rowEl.offsetTop;
        const rowH   = info.rowEl.offsetHeight;
        const viewH  = chartEl.clientHeight;
        const padding = Math.max(0, (viewH - rowH) / 2);
        const targetTop = Math.max(0, rowTop - padding);
        if (Math.abs(targetTop - chartEl.scrollTop) >= 4) {
          chartEl.scrollTo({ top: targetTop, behavior: 'smooth' });
        }
      }
    }
    const expanded = expandBarsByRepeats(window.currentSong.bars, songRepeats);
    // prerollCountIn fires the count-in only when starting mid-song
    // (startBarIdx >= countInBars). Bar 0 with countInBars > 0
    // routes through the regular song-start count-in path inside
    // startPlayback, which doesn't need this flag.
    startPlayback(window.currentSong.song, expanded, target, {
      prerollCountIn: countInBars > 0
    });
    return;
  }
  const chartEl = document.getElementById('chart');
  if (!chartEl) return;
  e.preventDefault();
  const step = Math.max(40, Math.round(chartEl.clientHeight * 0.75));
  _animateChartScroll(chartEl, e.key === 'PageDown' ? step : -step);
});

// ArrowLeft / ArrowRight at the document level — step the Note Info
// panel between chords. If the current bar has multiple chords the
// arrows hop chord-to-chord within it (equivalent to clicking the
// Prev/Next chord buttons under the fingerboard). When already at
// the first or last chord of the bar, the next arrow press jumps to
// the previous or next bar that carries chords and lands on its
// last or first chord respectively. So a `Dm7 G7 | CMaj7` chart
// with the first bar selected on Dm7: → goes to G7 (within bar),
// → goes to bar 2 on CMaj7; ← from CMaj7 goes back to G7, ← from
// G7 goes back to Dm7.
//
// Suppressed while typing in inputs / textareas / contenteditable,
// while Edit Mode is active (its own ArrowLeft / ArrowRight handler
// at line 17216-ish claims the keys for note-by-note cursor
// movement), and while playback is running (the panel auto-updates
// per beat — arrows would race the playhead).
document.addEventListener('keydown', e => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
  if (typeof emEnabled !== 'undefined' && emEnabled) return;
  const t = e.target;
  if (t) {
    const tag = (t.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if (t.isContentEditable) return;
  }
  if (selectedBar == null) return;
  if (playState === 'playing') return;
  const dir = (e.key === 'ArrowRight') ? +1 : -1;
  const starts = chordStartBeatsForBar(selectedBar);
  const newIdx = selectedChordIdxInBar + dir;
  if (starts.length && newIdx >= 0 && newIdx < starts.length) {
    e.preventDefault();
    selectedChordIdxInBar = newIdx;
    refreshFingerboardForBar(selectedBar, starts[newIdx]);
    updateChordNav();
    return;
  }
  // Bar-edge — hop to the next/prev bar that has chord info.
  const limit = (typeof barElements !== 'undefined') ? barElements.length : 0;
  if (dir > 0) {
    for (let bi = selectedBar + 1; bi < limit; bi++) {
      const s = chordStartBeatsForBar(bi);
      if (s.length > 0) {
        e.preventDefault();
        // selectBar() resets selectedChordIdxInBar to 0 and refreshes
        // the panel against the bar's first chord — exactly what we
        // want when advancing forward.
        selectBar(bi);
        return;
      }
    }
  } else {
    for (let bi = selectedBar - 1; bi >= 0; bi--) {
      const s = chordStartBeatsForBar(bi);
      if (s.length > 0) {
        e.preventDefault();
        selectBar(bi);
        // Going backwards: land on the bar's LAST chord, not its first.
        selectedChordIdxInBar = s.length - 1;
        refreshFingerboardForBar(bi, s[s.length - 1]);
        updateChordNav();
        return;
      }
    }
  }
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
  if (playState === 'paused' && !hasLoop) { await resumePlayback(); return; }
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
    if (playState === 'playing' && window.currentSong && drumMode === 'ride' &&
        tempoTierFor(prevTempo) !== tempoTierFor(currentTempo)) {
      const expanded = expandBarsByRepeats(window.currentSong.bars, songRepeats);
      await startPlayback(window.currentSong.song, expanded);
    }
    // Re-pace the game-mode metronome if it's running so it follows
    // the new BPM instead of staying on the previous tempo.
    if (typeof gameMetronome !== 'undefined' && gameMetronome.running) {
      gameMetronomeStop();
      gameMetronomeStart();
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
  // renderChart wipes #chart's innerHTML, which natively resets its
  // scrollTop to 0. For full-song rebuilds triggered by overlay
  // toggles / exercise changes / size or measures-per-line changes,
  // the user almost always wants to stay where they were on the
  // chart — popping back to the top after every checkbox click is
  // disorienting (most obvious with the Enter → Chord Tones binding).
  // Save scrollTop before the render and restore it after; the
  // browser clamps the value automatically if the new chart turns
  // out shorter than where we were scrolled to.
  const chartEl = document.getElementById('chart');
  const savedScroll = chartEl ? chartEl.scrollTop : 0;
  renderChart(song, bars, timesig);
  if (chartEl) chartEl.scrollTop = savedScroll;
}

document.querySelectorAll('#mplSeg button').forEach(b => {
  b.addEventListener('click', () => {
    document.querySelectorAll('#mplSeg button').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    measuresPerLine = parseInt(b.dataset.mpl, 10) || 4;
    rerenderCurrent();
  });
});
// On mobile devices, the IIFE that initialized `measuresPerLine`
// picked 2 (instead of the desktop default of 4). Sync the seg's
// active class to match — without this, the on-screen state is
// inconsistent ("4" highlighted even though we're rendering 2).
(function syncMplSegToMobileDefault() {
  const want = String(measuresPerLine);
  document.querySelectorAll('#mplSeg button').forEach(b => {
    b.classList.toggle('active', b.dataset.mpl === want);
  });
})();

document.querySelectorAll('#sizeSeg button').forEach(b => {
  b.addEventListener('click', () => {
    document.querySelectorAll('#sizeSeg button').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    chartSize = parseInt(b.dataset.size, 10) || 240;
    rerenderCurrent();
  });
});

// Tracks the user's last-clicked Repeats value so we can restore
// it when leaving Head mode. Head mode forces an effective value of
// 1 (the head plays once); switching back to Blank or Exercise mode
// restores whatever the user had last selected.
let _userRepeatChoice = 1;

// Sync the Repeats segmented control to the current exerciseMode.
// In Score mode the seg is locked (every button disabled) but
// `songRepeats` is COMPUTED from the loaded score: how many times
// the iRealPro form fits inside the score's note span. So a
// 64-bar bassline over a 16-bar form sets songRepeats=4 and the
// chord chart loops 4 times under the score. The pickup measure
// doesn't count — `head.notes` already has its stepStart shifted
// past any pickup, so the max-step calculation naturally ignores
// it. In other modes the seg follows the user's manual choice.
function _computeScoreRepeats() {
  const cs = window.currentSong;
  if (!cs || !cs.head || !Array.isArray(cs.head.notes) || !cs.head.notes.length) {
    return 1;
  }
  if (!cs.bars || !cs.bars.length) return 1;
  const beatsPerBar = (cs.timesig && cs.timesig.num) || 4;
  const stepsPerBar = beatsPerBar * 6; // 24th-note grid
  let maxStep = 0;
  for (const n of cs.head.notes) {
    const end = (n.stepStart || 0) + (n.durationSteps || 0);
    if (end > maxStep) maxStep = end;
  }
  if (maxStep <= 0) return 1;
  const headBars = Math.ceil(maxStep / stepsPerBar);
  const formBars = cs.bars.length;
  return Math.max(1, Math.ceil(headBars / formBars));
}
function _updateRepeatsSegLock() {
  const isHead = (typeof exerciseMode !== 'undefined' && exerciseMode === 'head');
  const buttons = document.querySelectorAll('#repeatSeg button');
  songRepeats = isHead ? _computeScoreRepeats() : _userRepeatChoice;
  buttons.forEach(b => {
    b.disabled = isHead;
    const r = parseInt(b.dataset.r, 10) || 1;
    b.classList.toggle('active', r === songRepeats);
  });
}

document.querySelectorAll('#repeatSeg button').forEach(b => {
  b.addEventListener('click', async () => {
    if (b.disabled) return; // locked in Head mode
    document.querySelectorAll('#repeatSeg button').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    _userRepeatChoice = parseInt(b.dataset.r, 10) || 1;
    songRepeats = _userRepeatChoice;
    rerenderCurrent();
    if (playState === 'playing' && window.currentSong) {
      const expanded = expandBarsByRepeats(window.currentSong.bars, songRepeats);
      await startPlayback(window.currentSong.song, expanded);
    }
  });
});
// Sync once on load so the seg reflects the initial Head-mode default.
_updateRepeatsSegLock();

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
    await restartPlaybackInPlaceWithCountIn();
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
    await restartPlaybackInPlaceWithCountIn();
  });
})();

// Lick discovery + caching. Every .musicxml / .mid file in the
// `licks/` folder is treated as a transposable lick: a one-bar
// phrase (or 3-bar 251) that the app re-pitches per-chord (or
// per-segment) through the song's chord changes. The user-facing
// label is the filename without its extension — e.g. `Lick 1.musicxml`
// shows up as "Lick 1".
async function listLickFiles() {
  // Invalidate the licks dir-index cache so newly-dropped files
  // appear without a hard page reload.
  _licksDirIndexPromise = null;
  const index = await loadLicksDirectoryIndex();
  const out = [];
  const seen = new Set();
  for (const fn of Object.values(index)) {
    const lcFn = fn.toLowerCase();
    let ext = null;
    if (lcFn.endsWith('.musicxml')) ext = 'musicxml';
    else if (lcFn.endsWith('.mid')) ext = 'mid';
    else continue;
    const label = fn.slice(0, fn.length - ext.length - 1);
    if (!label) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue; // dedupe .musicxml + .mid for the same lick
    seen.add(key);
    out.push({ filename: fn, label });
  }
  out.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
  return out;
}

// Lick parse cache. Keyed by filename. Each entry holds the parsed
// notes plus the source-key root info (pc + tpc) needed to compute
// the per-chord transposition delta at generate time.
const _exerciseLickCache = new Map();
const _KEY_TO_TPC_ROOT = {
  'C': 14, 'G': 15, 'D': 16, 'A': 17, 'E': 18, 'B': 19,
  'F#': 20, 'C#': 21, 'G#': 22,
  'F': 13, 'Bb': 12, 'Eb': 11, 'Ab': 10
};
async function loadExerciseLick(filename) {
  if (_exerciseLickCache.has(filename)) return _exerciseLickCache.get(filename);
  const url = 'licks/' + encodeURIComponent(filename);
  let parsed = null;
  let dom = null;
  try {
    if (filename.toLowerCase().endsWith('.mid')) {
      if (typeof Midi === 'undefined') return null;
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) return null;
      const buf = await res.arrayBuffer();
      parsed = midiToHeadNotes(new Midi(buf));
    } else {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) return null;
      const text = await res.text();
      dom = new DOMParser().parseFromString(text, 'application/xml');
      parsed = parseMusicXML(dom);
    }
  } catch (e) {
    return null;
  }
  if (!parsed || !Array.isArray(parsed.notes) || !parsed.notes.length) return null;

  // Quote detection. Filename starting with "Quote " (e.g.
  // "Quote 1.musicxml") is treated as a multi-bar phrase whose
  // chord-relative shape is mapped THROUGH the song's form rather
  // than placed once at a matching progression. Each source bar's
  // notes are scale-step-transposed against the song's bar at the
  // same offset, then the whole pattern repeats — bar 1 of the
  // quote goes on song bar 1, bar 2 on song bar 2, then quote bar 1
  // again on song bar 3, etc. So a "Gm6 (G A B♭) / Cm7 (E♭)" quote
  // applied to a song that opens "Dm7 / G7" becomes
  // "Dm7 (D E F) / G7 (B)" (b3 of Gm becomes the scale's 3rd of
  // Mixolydian = natural 3 on G7).
  //
  // Detection is by filename only so the MusicXML itself doesn't
  // need any special markers — drop a "Quote N.musicxml" in the
  // licks/ folder with one chord per bar and the algorithm picks
  // it up automatically.
  if (dom && /^quote\s/i.test(filename)) {
    const events = parseHarmonyEvents(dom);
    const ts = parseTimeSignatureFromMusicXML(dom);
    const stepsPerBar = ts.num * 6;
    // Per-bar chord lookup. If a measure has multiple harmonies the
    // first one wins (Quote convention is one chord per source bar).
    const chordByMeasure = new Map();
    for (const ev of events) {
      if (!chordByMeasure.has(ev.measureIdx)) chordByMeasure.set(ev.measureIdx, ev.chord);
    }
    // Number of source bars: covers every measure that carries notes.
    let maxStep = 0;
    for (const n of parsed.notes) {
      const end = (n.stepStart || 0) + (n.durationSteps || 6);
      if (end > maxStep) maxStep = end;
    }
    const numBars = Math.max(1, Math.ceil(maxStep / stepsPerBar));
    // Bucket notes by source bar (stepStart re-anchored to 0 so the
    // generator can drop the bar onto any target song bar without
    // doing offset math itself).
    const barNotes = [];
    const barChords = [];
    // Carry the last-seen <harmony> forward into bars that have none
    // of their own — Quote charts often omit chord symbols on bars 2
    // and 4 of a two-bar phrase when the chord is held over, which
    // would otherwise leave those bars unannotated (stepIdx = null)
    // and Functional / 3579 projection couldn't place notes there.
    let lastSourceChord = null;
    for (let b = 0; b < numBars; b++) {
      barNotes.push([]);
      const ch = chordByMeasure.get(b);
      if (ch) lastSourceChord = ch;
      barChords.push(ch || lastSourceChord);
    }
    for (const n of parsed.notes) {
      const b = Math.floor((n.stepStart || 0) / stepsPerBar);
      if (b < 0 || b >= numBars) continue;
      barNotes[b].push(Object.assign({}, n, {
        stepStart: (n.stepStart || 0) - b * stepsPerBar
      }));
    }
    // Annotate each bar's notes with (stepIdx, alteration, octaveOffset)
    // against the bar's source chord/scale.
    //
    // Cross-bar tie handling: when a note has tieStart === true and
    // its duration reaches the end of the bar, it ties INTO the next
    // bar. Its musical identity belongs to the NEXT bar's chord
    // context — Quote 2's bar-1 last eighth is an F that's the 3 of
    // bar-2's Dm7, not a b6 of bar-1's Am7. To carry that intent
    // through transposition we annotate the note against the NEXT
    // bar's chord (so stepIdx/alteration describe its role under
    // the chord it lands on), and set `useNextBarChord: true` so
    // the generator looks up the target chord from the FOLLOWING
    // song bar at apply time.
    const annotateNote = (n, chord) => {
      if (n.rest || typeof n.midi !== 'number' || !chord) {
        return Object.assign({}, n, { stepIdx: null, alteration: null });
      }
      const canonical = chordToCanonical(chord);
      const sourceRoot = exParseRoot(canonical);
      const sourceScale = exGetScale(canonical);
      if (!sourceRoot || !sourceScale || !sourceScale.length) {
        return Object.assign({}, n, { stepIdx: null, alteration: null });
      }
      const semi = (((n.midi - sourceRoot.pitchClass) % 12) + 12) % 12;
      const tpcOff = n.tpc - sourceRoot.tpc;
      let stepIdx = 0, alteration = 0;
      // Exact (semi, tpc) match first.
      outer: for (const alt of [0, 1, -1, 2, -2]) {
        for (let i = 0; i < sourceScale.length; i++) {
          const expSemi = (((sourceScale[i].s + alt) % 12) + 12) % 12;
          const expTpc = sourceScale[i].t + alt * 7;
          if (expSemi === semi && expTpc === tpcOff) {
            stepIdx = i; alteration = alt; break outer;
          }
        }
      }
      // Loose semi-only match if exact failed.
      if (stepIdx === 0 && alteration === 0
          && !(sourceScale[0].s === semi && sourceScale[0].t === tpcOff)) {
        outer2: for (const alt of [0, 1, -1, 2, -2]) {
          for (let i = 0; i < sourceScale.length; i++) {
            const expSemi = (((sourceScale[i].s + alt) % 12) + 12) % 12;
            if (expSemi === semi) {
              stepIdx = i; alteration = alt; break outer2;
            }
          }
        }
      }
      const octaveOffset = Math.floor((n.midi - sourceRoot.pitchClass) / 12);
      return Object.assign({}, n, { stepIdx, alteration, octaveOffset });
    };
    for (let b = 0; b < numBars; b++) {
      barNotes[b] = barNotes[b].map(n => {
        // Cross-bar tie: tieStart === true AND the note's footprint
        // reaches the end of its bar AND the next bar exists with a
        // chord. Those conditions describe a tie that crosses the
        // bar line into the next chord's territory.
        const tiesAcross = n.tieStart === true
          && (Math.round(n.stepStart || 0) + Math.round(n.durationSteps || 0) >= stepsPerBar)
          && (b + 1) < numBars
          && barChords[b + 1] != null;
        const chord = tiesAcross ? barChords[b + 1] : barChords[b];
        const annotated = annotateNote(n, chord);
        if (tiesAcross) annotated.useNextBarChord = true;
        return annotated;
      });
    }
    const data = {
      isQuote: true,
      barNotes,
      barChords,
      stepsPerBar,
      ts
    };
    _exerciseLickCache.set(filename, data);
    return data;
  }

  // Multi-bar 251 detection. Two layouts are recognized — both
  // resolve to a ii-V-I (m7 → 7 → Maj7/6) or ii°-V-i
  // (m7♭5 → 7 → m/m7) progression in falling-fifths order:
  //   • EXPANDED  — three measures, one chord each (Lick 3-style):
  //                 |  ii  |  V  |  I  |
  //   • COMPRESSED — two measures, ii AND V split bar 1 and the
  //                 resolution lands on bar 2 (Lick 4-style):
  //                 | ii  V |  I  |
  // The generator scans the SONG for matching shapes and applies
  // the lick's bars to them. Major-251 licks over a minor 251
  // automatically flatten the source key's 3rd, 6th, and 7th
  // (= relative-major substitution: a CMaj lick over Cm uses E♭
  // major notes).
  if (dom) {
    const events = parseHarmonyEvents(dom);
    const ts = parseTimeSignatureFromMusicXML(dom);
    const stepsPerBar = ts.num * 6; // 24th-note grid
    const isP4Up = (a, b) => b === (a + 5) % 12;
    let pattern251 = null;
    let numBars = 0;
    if (events.length >= 3) {
      const e1 = events[0], e2 = events[1], e3 = events[2];
      const r1 = exParseRoot(chordToCanonical(e1.chord));
      const r2 = exParseRoot(chordToCanonical(e2.chord));
      const r3 = exParseRoot(chordToCanonical(e3.chord));
      const t1 = getChordType(chordToCanonical(e1.chord));
      const t2 = getChordType(chordToCanonical(e2.chord));
      const t3 = getChordType(chordToCanonical(e3.chord));
      if (r1 && r2 && r3
          && isP4Up(r1.pitchClass, r2.pitchClass)
          && isP4Up(r2.pitchClass, r3.pitchClass)) {
        let mode = null;
        if (t1 === 'minor' && t2 === 'dominant' && t3 === 'major') mode = 'major';
        else if (t1 === 'halfdim' && t2 === 'dominant' && t3 === 'minor') mode = 'minor';
        if (mode) {
          // Determine the structural shape from chord positions.
          //   expanded:   bars [0, 1, 2], all at stepInMeasure 0
          //   compressed: bars [0, 0, 1], V at stepInMeasure > 0
          if (e1.measureIdx === 0 && e2.measureIdx === 1 && e3.measureIdx === 2
              && e1.stepInMeasure === 0 && e2.stepInMeasure === 0 && e3.stepInMeasure === 0) {
            pattern251 = { mode, sourceTonic: r3, shape: 'expanded' };
            numBars = 3;
          } else if (e1.measureIdx === 0 && e2.measureIdx === 0 && e3.measureIdx === 1
              && e1.stepInMeasure === 0 && e2.stepInMeasure > 0 && e3.stepInMeasure === 0) {
            pattern251 = { mode, sourceTonic: r3, shape: 'compressed' };
            numBars = 2;
          }
        }
      }
    }
    if (pattern251) {
      // Bucket notes by measure index. Each bar's stepStart is
      // re-anchored to 0 so the generator can drop the bar into
      // any matching song bar without manual offset math. For the
      // compressed shape, bar 0 carries notes for BOTH the ii and
      // V chords (interleaved at their original step positions).
      const barNotes = [];
      for (let b = 0; b < numBars; b++) barNotes.push([]);
      for (const n of parsed.notes) {
        const b = Math.floor((n.stepStart || 0) / stepsPerBar);
        if (b >= 0 && b < numBars) {
          barNotes[b].push(Object.assign({}, n, {
            stepStart: (n.stepStart || 0) - b * stepsPerBar
          }));
        }
      }
      const data = {
        multiBar: true,
        pattern251,
        barNotes,
        stepsPerBar,
        ts
      };
      _exerciseLickCache.set(filename, data);
      return data;
    }
  }

  // Source chord — read from the file's first <harmony> when present
  // (MuseScore writes one if you put a chord symbol on the lick),
  // otherwise default to a major chord on the key signature's tonic.
  const sourceChord = parsed.firstHarmony
    || { root: parsed.keyTonic || 'C', rest: '' };
  const canonical = chordToCanonical(sourceChord);
  const sourceRoot = exParseRoot(canonical);
  const sourceScale = exGetScale(canonical);
  if (!sourceRoot || !sourceScale || !sourceScale.length) {
    // Can't derive a scale — store unannotated; the generator will
    // skip the lick entirely.
    const data = { notes: parsed.notes, sourceChord, sourceRoot: null, sourceScale: null };
    _exerciseLickCache.set(filename, data);
    return data;
  }

  // Annotate each note with its scale-step + chromatic alteration
  // (relative to the source chord's scale). The generator uses
  // these per-bar to look up the SAME step in each target chord's
  // scale — so a "degree 3" in the source plays as the chord's
  // own 3rd over every bar (b3 over a m7, ♮3 over a Maj7, etc.).
  function findStepAndAlteration(semiOffset, tpcOffset) {
    // Try exact (semi, tpc) match first across alterations 0, ±1, ±2.
    // Order: prefer 0 > +1 > −1 > +2 > −2 so a note that fits a
    // scale tone exactly never gets re-spelled as a chromatic.
    for (const alt of [0, 1, -1, 2, -2]) {
      for (let i = 0; i < sourceScale.length; i++) {
        const expSemi = (((sourceScale[i].s + alt) % 12) + 12) % 12;
        const expTpc = sourceScale[i].t + alt * 7;
        if (expSemi === semiOffset && expTpc === tpcOffset) {
          return { stepIdx: i, alteration: alt };
        }
      }
    }
    // Loose semi-only match (TPC didn't line up — happens when the
    // source file's accidental spelling differs from the canonical
    // scale spelling). Pick the smallest |alt| that matches semi.
    for (const alt of [0, 1, -1, 2, -2]) {
      for (let i = 0; i < sourceScale.length; i++) {
        const expSemi = (((sourceScale[i].s + alt) % 12) + 12) % 12;
        if (expSemi === semiOffset) {
          return { stepIdx: i, alteration: alt };
        }
      }
    }
    return { stepIdx: 0, alteration: 0 };
  }
  const annotated = parsed.notes.map(n => {
    if (n.rest || typeof n.midi !== 'number') return { ...n, stepIdx: null, alteration: null };
    const semiOffset = (((n.midi - sourceRoot.pitchClass) % 12) + 12) % 12;
    const tpcOffset = n.tpc - sourceRoot.tpc;
    const { stepIdx, alteration } = findStepAndAlteration(semiOffset, tpcOffset);
    // Source-octave anchor: how many octaves above the source root
    // does this note sit? Used to keep the same registral shape on
    // every transposed bar instead of collapsing into a single octave.
    const octaveOffset = Math.floor((n.midi - sourceRoot.pitchClass) / 12);
    return { ...n, stepIdx, alteration, octaveOffset };
  });

  const data = {
    notes: annotated,
    sourceChord,
    sourceRoot,
    sourceScale
  };
  _exerciseLickCache.set(filename, data);
  return data;
}

// Dropdown shared between Score, Exercise, and Lick modes. The
// original exercise <option>s are stashed at startup so we can swap
// them back when the user returns to Exercise mode without
// rebuilding the list from scratch — and without losing any options
// the user-facing HTML may add later (we treat the HTML snippet as
// the source of truth for the exercise menu).
let _exerciseDropdownHTML = null;
let _dropdownMode = 'exercise'; // 'exercise' | 'score' | 'lick'
let _lastExerciseValue = 'scale';
let _lastLickValue = null; // remembered across mode toggles
// Lick projection mode controls how a Quote-style lick re-projects
// onto the song's chord changes:
//   'functional'  — original behavior: each source note's scale
//                   degree is computed in its source chord, then
//                   played at the SAME degree of the target chord
//                   (octave-fitted per bar). Preserves harmonic
//                   character precisely; each chord change tends
//                   to reset the line's register.
//   '3579'        — uses the source PURELY for rhythm. The whole
//                   song is pre-walked through 3/5/7/9 chord tones
//                   in a sawtooth pattern (same as the 3579 Range
//                   exercise: ascend until F3, descend until F1,
//                   repeat). Advances ONCE PER CHORD EVENT, not per
//                   beat, so multi-chord bars get a fresh 3/5/7/9
//                   for each chord while same-chord beats hold
//                   their pitch. The lick's onsets pick when those
//                   pitches sound; rest events stay rests.
//   'scale'       — uses the source PURELY for rhythm. The whole
//                   song is pre-filled with a CONTINUOUS scale walk
//                   at eighth-note resolution — same algorithm as
//                   the Scale Notes exercise (ascend, hit the top
//                   of the cello range, descend, …) — and the
//                   lick's onset pattern masks it. Pitched events
//                   pick up the bar's eighth-note slot they land
//                   on, rest events stay rests. Pitches are
//                   independent of the source's pitches.
let _lickProjectionMode = (() => {
  try {
    const v = localStorage.getItem('lickProjectionMode');
    if (v === '3579' || v === 'scale') return v;
    // Legacy: 'intervallic' (removed) and '3rd' (replaced by '3579')
    // both migrate back to the default.
    return 'functional';
  } catch (_) { return 'functional'; }
})();
function _stashExerciseDropdownIfNeeded() {
  if (_exerciseDropdownHTML !== null) return;
  const sel = document.getElementById('exerciseSelect');
  if (sel) _exerciseDropdownHTML = sel.innerHTML;
}
function populateExerciseDropdown(selectedValue) {
  _stashExerciseDropdownIfNeeded();
  const sel = document.getElementById('exerciseSelect');
  if (!sel) return;
  sel.innerHTML = _exerciseDropdownHTML || '';
  sel.disabled = false;
  const target = selectedValue || _lastExerciseValue || 'scale';
  if (sel.querySelector(`option[value="${target}"]`)) sel.value = target;
  _dropdownMode = 'exercise';
}
// Stash the dropdown's initial HTML on boot. The page starts in
// Exercise mode (Score is the default modeSeg active button, but
// the dropdown's hardcoded options ARE the exercise list — Score
// mode replaces them when first entered). Without this early stash,
// the first Lick/Score swap captures whatever's already there, but
// the very first populateExerciseDropdown call then restores from
// a possibly-already-mutated source.
_stashExerciseDropdownIfNeeded();
// Populate the dropdown with the lick library — every file in the
// `licks/` folder shows up by its filename-without-extension. Each
// option's value is `lick:<filename>` so the dispatcher and the
// change handler can identify it. Async because the directory index
// is fetched on demand; the dropdown shows "(loading…)" briefly
// when the index isn't already cached.
async function populateLickDropdown(selectedValue) {
  _stashExerciseDropdownIfNeeded();
  const sel = document.getElementById('exerciseSelect');
  if (!sel) return;
  sel.innerHTML = '<option value="">(loading…)</option>';
  sel.disabled = true;
  _dropdownMode = 'lick';
  let licks = [];
  try { licks = await listLickFiles(); } catch (e) {}
  // The user may have switched back to Score / Exercise during the
  // fetch. Bail without clobbering whatever they're now on.
  if (_dropdownMode !== 'lick') return;
  if (!licks.length) {
    sel.innerHTML = '<option value="">(no licks)</option>';
    sel.disabled = true;
    return;
  }
  let html = '';
  for (const lick of licks) {
    const safeLabel = String(lick.label)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const safeFn = String(lick.filename)
      .replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    html += `<option value="lick:${safeFn}">${safeLabel}</option>`;
  }
  sel.innerHTML = html;
  sel.disabled = false;
  // Selection priority: explicit selectedValue > last-picked lick >
  // first item in the list.
  const target = selectedValue
    || _lastLickValue
    || ('lick:' + licks[0].filename);
  const opt = sel.querySelector(`option[value="${CSS.escape(target)}"]`);
  if (opt) sel.value = target;
  else sel.value = 'lick:' + licks[0].filename;
}
// Sentinel value for the synthetic "(Blank)" option that always sits
// at the top of the Score dropdown. The bindExerciseSelect score-mode
// branch detects this string and switches into exerciseMode='blank'
// (empty staves with chord changes above) instead of loading a head
// file. Chosen to be distinct from any real .mid/.musicxml filename.
const SCORE_BLANK_VALUE = '__blank__';
function populateScoreDropdown(scores, selectedFilename) {
  _stashExerciseDropdownIfNeeded();
  const sel = document.getElementById('exerciseSelect');
  if (!sel) return;
  // Always include "(Blank)" as the first option — it's how the user
  // gets to blank-staff mode now that the modeSeg has only Score and
  // Exercise. When the song ships no score files, the dropdown holds
  // ONLY this option and the chart renders as blank staves.
  let html = `<option value="${SCORE_BLANK_VALUE}">(Blank)</option>`;
  if (scores && scores.length) {
    for (const s of scores) {
      const safeLabel = String(s.label)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const safeFn = String(s.filename)
        .replace(/&/g, '&amp;').replace(/"/g, '&quot;');
      html += `<option value="${safeFn}">${safeLabel}</option>`;
    }
  }
  sel.innerHTML = html;
  sel.disabled = false;
  // Selection: an explicit selectedFilename wins (real score or
  // SCORE_BLANK_VALUE). When omitted, fall back to the first real
  // score, or to (Blank) if the song has none.
  let target = selectedFilename;
  if (!target) {
    target = (scores && scores.length) ? scores[0].filename : SCORE_BLANK_VALUE;
  }
  const opt = sel.querySelector(`option[value="${CSS.escape(target)}"]`);
  if (opt) sel.value = target;
  else sel.value = SCORE_BLANK_VALUE;
  _dropdownMode = 'score';
}
// Refresh the Score-mode dropdown for the currently loaded song.
// Called when the song changes (so the picker shows that song's
// scores) and when the user enters Score mode.
async function refreshScoreDropdownForCurrentSong() {
  if (!window.currentSong) {
    populateScoreDropdown([], null);
    return;
  }
  const title = window.currentSong.song && window.currentSong.song.title;
  const scores = await listScoresForSong(title);
  const currentFilename = window.currentSong.scoreFilename || null;
  populateScoreDropdown(scores, currentFilename || (scores[0] && scores[0].filename));
}

// Exercise picker — regenerates the quarter notes with the selected
// algorithm (scale-walker vs. 1-3-5-7 arpeggio). If playback is running,
// restart so the audible notes match the re-rendered score.
//
// The Head/Exercise mode is now driven by the segmented button to the
// LEFT of the dropdown (#modeSeg). The dropdown only carries the
// non-head exercises. Changing the dropdown implies the user wants an
// exercise, so we auto-flip the seg to "Exercise" — keeping the two
// controls consistent without forcing the user to click both.
(function bindExerciseSelect() {
  const sel = document.getElementById('exerciseSelect');
  if (!sel) return;
  sel.addEventListener('change', async () => {
    const value = sel.value;
    // Score-mode dropdown: the value is a filename. Load that file
    // as the song's head and re-render. Don't auto-flip anywhere —
    // we stay in Score mode.
    if (_dropdownMode === 'score') {
      if (!value || !window.currentSong) return;
      // "(Blank)" sentinel: stay in Score mode, but render blank
      // staves instead of loading a head file. Mirrors what the
      // removed "Blank" segmented button used to do — just surfaced
      // as the first item in the Score dropdown so the modeSeg can
      // collapse to two buttons (Score / Exercise).
      if (value === SCORE_BLANK_VALUE) {
        window.currentSong.scoreFilename = SCORE_BLANK_VALUE;
        exerciseMode = 'blank';
        if (typeof _updateRepeatsSegLock === 'function') _updateRepeatsSegLock();
        rerenderCurrent();
        updateScoreTitle();
        updateLoopControls();
        if (typeof emUpdateAvailability === 'function') emUpdateAvailability();
        if (typeof updatePlayHeadAvailability === 'function') updatePlayHeadAvailability();
        await restartPlaybackInPlaceWithCountIn();
        return;
      }
      // Real score file: leave blank mode if we were in it, load the
      // chosen head, and re-render in head mode.
      exerciseMode = 'head';
      window.currentSong.scoreFilename = value;
      window.currentSong.headLoaded = false;
      const head = await loadHeadFromFilename(value);
      if (!window.currentSong) return; // user changed songs mid-load
      window.currentSong.head = head;
      window.currentSong.headLoaded = true;
      // Re-evaluate auto-repeat: a longer score (e.g. multi-chorus
      // bassline) needs more form repeats than a single-chorus head,
      // so the chord chart underneath stretches to match.
      if (typeof _updateRepeatsSegLock === 'function') _updateRepeatsSegLock();
      // VARIANT scores rebase the song to the score's key — the
      // chord chart transposes there, originalKey moves with it
      // (so the circle marks the new base and Key-seg clicks
      // compute offsets from it), and the iRealPro key is marked
      // with a square as a memo. Default Head restores the
      // iRealPro reference instead of rebasing.
      const isDefaultHead = !!(window.currentSong.defaultScoreFilename
        && value === window.currentSong.defaultScoreFilename);
      if (isDefaultHead) {
        await restoreIrealKeyForDefaultHead();
      } else if (head && head.keyTonic) {
        await rebaseToScoreKey(head.keyTonic);
      } else {
        // Variant has no <key> data — keep the chart on whatever
        // base it's currently on, just refresh the marker.
        syncKeySegIrealMarker();
      }
      if (exerciseMode === 'head') rerenderCurrent();
      updateScoreTitle();
      updateLoopControls();
      if (typeof emUpdateAvailability === 'function') emUpdateAvailability();
      if (typeof updatePlayHeadAvailability === 'function') updatePlayHeadAvailability();
      await restartPlaybackInPlaceWithCountIn();
      return;
    }
    // Lick-mode dropdown: the value is `lick:<filename>`. Pre-load
    // the file before rerendering so the generator finds the parsed
    // data in cache on its first call. Auto-flip the modeSeg to
    // "Lick" so the UI matches the dropdown.
    if (_dropdownMode === 'lick') {
      if (!value || !value.startsWith('lick:')) return;
      exerciseMode = value;
      _lastLickValue = value;
      document.querySelectorAll('#modeSeg button').forEach(b => {
        b.classList.toggle('active', b.dataset.mode === 'lick');
      });
      if (typeof _updateRepeatsSegLock === 'function') _updateRepeatsSegLock();
      updateScoreTitle();
      await loadExerciseLick(value.slice(5));
      rerenderCurrent();
      updateLoopControls();
      if (typeof emUpdateAvailability === 'function') emUpdateAvailability();
      await restartPlaybackInPlaceWithCountIn();
      return;
    }
    // Exercise-mode dropdown: the value is an exercise key.
    const ex = value;
    exerciseMode = (ex === 'chord' || ex === 'triads' || ex === 'broken3' || ex === 'cantus' || ex === 'targetTriad' || ex === 'range3579' || ex === 'range3579Half' || ex === 'chordTonesHalf' || ex === 'enclosures' || ex === 'longEnclosures' || ex === 'scaleChromatic' || ex === 'descending' || ex === '1235' || ex === '1235Eighth' || ex === '3579' || ex === '3579Eighth' || ex === 'walkTriad' || ex === 'mixedTriads' || ex === 'threeSeven' || ex === 'landmarks' || ex === 'landmarks13' || ex === 'walkBass' || ex === 'walkBassPC')
      ? ex : 'scale';
    _lastExerciseValue = exerciseMode;
    // Auto-flip the mode seg to "Exercise" — picking from the
    // dropdown is an implicit "I want an exercise" gesture.
    document.querySelectorAll('#modeSeg button').forEach(b => {
      b.classList.toggle('active', b.dataset.mode === 'exercise');
    });
    if (typeof _updateRepeatsSegLock === 'function') _updateRepeatsSegLock();
    updateScoreTitle();
    rerenderCurrent();
    // Re-evaluate Play button state — switching to/from Head with a
    // headless song must enable/disable Play accordingly.
    updateLoopControls();
    // Re-evaluate Edit Mode availability — picking an exercise from
    // the dropdown moves us out of Head, which disables editing.
    if (typeof emUpdateAvailability === 'function') emUpdateAvailability();
    await restartPlaybackInPlaceWithCountIn();
  });
})();

// Mode segmented button: Score (play the song's melody as parsed
// from MusicXML / MIDI, OR render blank staves when the dropdown's
// "(Blank)" sentinel is selected), Lick (a transposable phrase from
// the licks/ folder), and Exercise (one of the generators picked
// in the dropdown to the right). Each branch swaps the dropdown's
// option set to its own list and restores exerciseMode from the
// dropdown's current value so toggling between modes returns to the
// user's last-picked item in each.
(function bindModeSeg() {
  const seg = document.getElementById('modeSeg');
  if (!seg) return;
  seg.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', async () => {
      seg.querySelectorAll('button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const mode = btn.dataset.mode;
      if (mode === 'head') {
        // Score mode. Dropdown becomes the per-song scores list with
        // "(Blank)" prepended. If the user's persisted score for this
        // song is the blank sentinel (or the song has no real scores),
        // exerciseMode flips to 'blank'; otherwise 'head'.
        await refreshScoreDropdownForCurrentSong();
        const sel = document.getElementById('exerciseSelect');
        const v = sel ? sel.value : '';
        exerciseMode = (v === SCORE_BLANK_VALUE) ? 'blank' : 'head';
      } else if (mode === 'lick') {
        // Lick mode. Dropdown lists every file in licks/. The picker
        // value carries the `lick:` prefix used by the generator
        // dispatcher. Pre-load the lick on initial selection so the
        // first rerender finds parsed data in cache.
        await populateLickDropdown(_lastLickValue);
        const sel = document.getElementById('exerciseSelect');
        const v = sel ? sel.value : '';
        if (v && v.startsWith('lick:')) {
          exerciseMode = v;
          _lastLickValue = v;
          await loadExerciseLick(v.slice(5));
        } else {
          // No licks available — fall back to a no-op render
          // (blank-staff equivalent). Keeps the chart usable until
          // the user drops a file in licks/.
          exerciseMode = 'blank';
        }
      } else {
        if (_dropdownMode !== 'exercise') populateExerciseDropdown();
        const sel = document.getElementById('exerciseSelect');
        const ex = sel ? sel.value : 'scale';
        exerciseMode = (ex === 'chord' || ex === 'triads' || ex === 'broken3' || ex === 'cantus' || ex === 'targetTriad' || ex === 'range3579' || ex === 'range3579Half' || ex === 'chordTonesHalf' || ex === 'enclosures' || ex === 'longEnclosures' || ex === 'scaleChromatic' || ex === 'descending' || ex === '1235' || ex === '1235Eighth' || ex === '3579' || ex === '3579Eighth' || ex === 'walkTriad' || ex === 'mixedTriads' || ex === 'threeSeven' || ex === 'landmarks' || ex === 'landmarks13' || ex === 'walkBass' || ex === 'walkBassPC')
          ? ex : 'scale';
        _lastExerciseValue = exerciseMode;
      }
      // Repeats lock to 1 in Head mode; restored from the user's
      // last choice when switching out. _updateRepeatsSegLock also
      // updates the live `songRepeats` global so the rerender picks
      // up the right effective count.
      if (typeof _updateRepeatsSegLock === 'function') _updateRepeatsSegLock();
      // The lick-projection seg is only meaningful in Lick mode;
      // show it there and hide everywhere else.
      const lps = document.getElementById('lickProjSeg');
      if (lps) lps.hidden = (mode !== 'lick');
      updateScoreTitle();
      rerenderCurrent();
      // Switching INTO Head on a song without one disables Play;
      // switching OUT of Head re-enables it. Refresh the button now.
      updateLoopControls();
      // Edit Mode follows the same logic — only enabled when in Head
      // AND a head was loaded. Toggle off automatically when leaving.
      if (typeof emUpdateAvailability === 'function') emUpdateAvailability();
      await restartPlaybackInPlaceWithCountIn();
    });
  });
})();

// Lick projection-mode toggle: visible only in Lick mode (see
// bindModeSeg above). Switches between Functional (scale-degree
// mapping) and Intervallic (voice-led + contour-walked) projection,
// persisted across reloads via localStorage.
(function bindLickProjSeg() {
  const seg = document.getElementById('lickProjSeg');
  if (!seg) return;
  // Sync visual active state with the persisted preference at boot.
  seg.querySelectorAll('button').forEach(b => {
    b.classList.toggle('active', b.dataset.proj === _lickProjectionMode);
  });
  seg.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', async () => {
      const next = btn.dataset.proj;
      if (next !== 'functional' && next !== '3579' && next !== 'scale') return;
      if (next === _lickProjectionMode) return;
      _lickProjectionMode = next;
      try { localStorage.setItem('lickProjectionMode', next); } catch (_) {}
      seg.querySelectorAll('button').forEach(b => {
        b.classList.toggle('active', b.dataset.proj === next);
      });
      // Only rerender if a lick is the active exercise — otherwise
      // the new mode just sits there until the user picks one.
      if (typeof exerciseMode === 'string' && exerciseMode.startsWith('lick:')) {
        rerenderCurrent();
        await restartPlaybackInPlaceWithCountIn();
      }
    });
  });
})();

document.querySelectorAll('#drumSeg button').forEach(b => {
  b.addEventListener('click', async () => {
    document.querySelectorAll('#drumSeg button').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    drumMode = b.dataset.mode;
    // Restart in-place with a count-in pre-roll so the new drum
    // pattern slots in cleanly on the next downbeat instead of
    // crashing in mid-bar.
    await restartPlaybackInPlaceWithCountIn();
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
      // the song name and ignore the RB reference / HEAD badge we
      // append next to it.
      const nameSpan = document.createElement('span');
      nameSpan.className = 'song-name';
      nameSpan.textContent = entry.title;
      li.appendChild(nameSpan);
      // Real Book reference — populated by applyRealbookSuffixesToSongList
      // once the realbook-index.json fetch resolves. Empty until then.
      const rbSpan = document.createElement('span');
      rbSpan.className = 'song-rb';
      li.appendChild(rbSpan);
      li.dataset.idx = String(i);
      li.setAttribute('role', 'option');
      li.addEventListener('click', () => {
        selectSongByIndex(i);
        // `closeSongPicker()` also clears the filter in portrait mode
        // so the next open starts fresh.
        closeSongPicker();
      });
      songListEl.appendChild(li);
      // Probe the songs/ folder per song (in parallel) to detect
      // companion score files. Tags the row with up to three small
      // pill badges on the right side: HEAD (default melody),
      // BASSLINE (any "{title} - *Bassline*" variant), SOLO (any
      // "{title} - *Solo*" variant). Badges appear as probes
      // resolve; we don't block list rendering on the network.
      probeSongVariants(entry.title).then(v => {
        if (v.hasHead) {
          const b = document.createElement('span');
          b.className = 'song-tag tag-head';
          b.textContent = 'HEAD';
          li.appendChild(b);
        }
        if (v.hasBassline) {
          const b = document.createElement('span');
          b.className = 'song-tag tag-bassline';
          b.textContent = 'BASSLINE';
          li.appendChild(b);
        }
        if (v.hasSolo) {
          const b = document.createElement('span');
          b.className = 'song-tag tag-solo';
          b.textContent = 'SOLO';
          li.appendChild(b);
        }
      });
    }
  });

  // Safety-net the filter-input listeners — bindSongPickerControls
  // already ran once at script load, but if anything ever re-inserts
  // the input element these calls re-establish the handlers.
  ensureSongFilterBindings();

  // Kick off the Real Book index fetch (if not already in flight) and
  // fill in the per-row RB references when it resolves. If the index
  // is already cached the fill happens synchronously inside the .then.
  // Either way `applyRealbookSuffixesToSongList` is idempotent so a
  // duplicate call from updateScoreTitle's load is harmless.
  loadRealbookIndex().then(() => {
    try { applyRealbookSuffixesToSongList(); } catch (e) {}
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

// Check whether a song has a companion head file (.musicxml or .mid)
// in the songs/ folder. Issues a HEAD request against each candidate
// URL — cheap, no body download — and returns true for the first one
// that responds 2xx. Used to decorate the song-picker list with a
// "HEAD" badge without having to actually load the head data.
async function probeSongHasHead(title) {
  const v = await probeSongVariants(title);
  return v.hasHead;
}
// Probe the songs/ folder for files matching a song title and return
// flags for which variant categories exist. Used to decorate the
// song list with badges (HEAD / BASSLINE / SOLO):
//   - hasHead     ← `{title}.musicxml` or `{title}.mid`
//   - hasBassline ← any `{title} - *Bassline*.{musicxml,mid}` match
//   - hasSolo     ← any `{title} - *Solo*.{musicxml,mid}` match
// Bassline / Solo detection is purely substring-on-the-suffix, so a
// file like "Autumn Leaves - Sam Jones Bassline.musicxml" or
// "Cherokee - Clifford Brown Solo.musicxml" both pick up correctly.
// Falls through to a HEAD HTTP probe when the manifest/listing
// returned nothing for the head case (newly-dropped file before the
// manifest regenerates).
async function probeSongVariants(title) {
  const result = { hasHead: false, hasBassline: false, hasSolo: false };
  if (!title) return result;
  const index = await loadSongDirectoryIndex();
  const lc = title.toLowerCase();
  if (Object.keys(index).length > 0) {
    if (index[`${lc}.musicxml`] || index[`${lc}.mid`]) result.hasHead = true;
    for (const fn of Object.values(index)) {
      const lcFn = fn.toLowerCase();
      if (!lcFn.startsWith(lc + ' - ')) continue;
      // Must have a known extension to count as a score variant.
      if (!(lcFn.endsWith('.musicxml') || lcFn.endsWith('.mid'))) continue;
      // Strip extension before scanning the suffix label so a song
      // titled e.g. "Solo Flight" doesn't false-positive its OWN
      // base name; we only check the part AFTER the " - " separator.
      const ext = lcFn.endsWith('.musicxml') ? 9 : 4; // ".musicxml" / ".mid"
      const suffix = lcFn.slice(lc.length + 3, lcFn.length - ext);
      if (suffix.includes('bassline')) result.hasBassline = true;
      if (suffix.includes('solo')) result.hasSolo = true;
    }
  }
  if (!result.hasHead) {
    for (const ext of ['musicxml', 'mid']) {
      const url = `songs/${encodeURIComponent(title)}.${ext}`;
      try {
        const res = await fetch(url, { method: 'HEAD', cache: 'no-store' });
        if (res.ok) { result.hasHead = true; break; }
      } catch (e) { /* skip */ }
    }
  }
  return result;
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
  // Escape user-controlled and song-title text before injecting it
  // back as innerHTML — song titles can contain "&", "<", etc.
  const escapeHtml = (s) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  document.querySelectorAll('#songList li').forEach(li => {
    // Match against the song name only — the HEAD badge lives in a
    // sibling span, so `li.textContent` would also include "HEAD"
    // and any search for "h", "he", "head" would spuriously match
    // every song with a head file.
    const nameEl = li.querySelector('.song-name');
    if (!nameEl) return;
    // `textContent` returns the plain title even when prior filter
    // runs left <strong> tags inside (textContent strips tags), so
    // we always recover the original title without needing a
    // separate dataset cache.
    const originalText = nameEl.textContent;
    const lc = originalText.toLowerCase();
    const hit = !needle || lc.includes(needle);
    li.hidden = !hit;
    if (!hit) return;
    if (!needle) {
      // Filter cleared — drop any leftover <strong> markup.
      nameEl.textContent = originalText;
      return;
    }
    // Bold every occurrence of the needle in the title. Using the
    // lowercased copy for index math, but slicing from the original
    // so the bolded characters keep their original case.
    let html = '';
    let i = 0;
    while (i < originalText.length) {
      const idx = lc.indexOf(needle, i);
      if (idx === -1) {
        html += escapeHtml(originalText.slice(i));
        break;
      }
      if (idx > i) html += escapeHtml(originalText.slice(i, idx));
      html += '<strong>' + escapeHtml(originalText.slice(idx, idx + needle.length)) + '</strong>';
      i = idx + needle.length;
    }
    nameEl.innerHTML = html;
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

// ============================================================
// Edit Mode — fingering authoring (Windows desktop only)
//
// Storage model: one JSON file per song under
// `songs/fingerings/<title>.json`, written via the File System
// Access API directly to the user's local working tree. The user
// then commits + pushes from terminal as part of their normal
// workflow. The PWA on Android is structurally read-only because
// `window.showDirectoryPicker` doesn't exist there — the toggle
// won't even render.
// ============================================================
function emIsWindows() {
  if (navigator.userAgentData && typeof navigator.userAgentData.platform === 'string') {
    return navigator.userAgentData.platform === 'Windows';
  }
  return /\bWindows\b/.test(navigator.userAgent || '');
}
function emIsStandalone() {
  if (window.matchMedia) {
    if (window.matchMedia('(display-mode: standalone)').matches) return true;
    if (window.matchMedia('(display-mode: window-controls-overlay)').matches) return true;
    if (window.matchMedia('(display-mode: minimal-ui)').matches) return true;
  }
  return navigator.standalone === true;
}
// Belt-and-suspenders mobile check. The Windows test SHOULD already
// exclude phones (Android/iOS report a different platform string and
// neither contains "Windows" in their UA), but if a browser ever
// spoofs UA strangely or `userAgentData` returns something unexpected
// we want a second guard. `userAgentData.mobile` is the canonical
// modern signal; the regex is the fallback for browsers that haven't
// shipped the API.
function emIsMobile() {
  if (navigator.userAgentData && typeof navigator.userAgentData.mobile === 'boolean') {
    return navigator.userAgentData.mobile;
  }
  return /\b(Android|iPhone|iPad|iPod|Mobile)\b/i.test(navigator.userAgent || '');
}
function emIsEditorDevice() {
  return emIsWindows()
      && !emIsMobile()
      && !emIsStandalone()
      && typeof window.showDirectoryPicker === 'function';
}

// IndexedDB store for the FileSystemDirectoryHandle. Handles are
// structured-cloneable in modern Chromium — they survive reload
// and even browser restart, though Chrome may ask the user to
// re-grant readwrite permission once per session via a click.
const EM_DB_NAME = 'song-practice-fs';
const EM_DB_STORE = 'handles';
function emOpenDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(EM_DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(EM_DB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}
async function emIDBGet(key) {
  const db = await emOpenDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(EM_DB_STORE, 'readonly');
    const req = tx.objectStore(EM_DB_STORE).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror   = () => reject(req.error);
  });
}
async function emIDBSet(key, value) {
  const db = await emOpenDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(EM_DB_STORE, 'readwrite');
    tx.objectStore(EM_DB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}

// Cello fingerboard positions, indexed 0..8 from low to high. Each
// entry's `label` is what gets engraved above the staff — empty
// string for 1st position (the default; no marking required).
//
//   0  half          → "1/2"
//   1  1st           → ""           (default — no annotation)
//   2  +1st          → "+1st"       (extension above 1st position)
//   3  2nd           → "2nd"
//   4  3rd           → "3rd"
//   5  +3rd          → "+3rd"
//   6  4th           → "4th"
//   7  +4th          → "+4th"
//   8  5th           → "5th"
const EM_POSITIONS = [
  { name: 'half',  label: '1/2'  },
  { name: '1st',   label: ''     },
  { name: '+1st',  label: '+1st' },
  { name: '2nd',   label: '2nd'  },
  { name: '3rd',   label: '3rd'  },
  { name: '+3rd',  label: '+3rd' },
  { name: '4th',   label: '4th'  },
  { name: '+4th',  label: '+4th' },
  { name: '5th',   label: '5th'  }
];
const EM_DEFAULT_POSITION = 1;

// Storage format versioning.
//   v1: the original 9-position layout (idx 2 was labelled "1st")
//   v2: 8-position layout with the extended-1st ("upper") removed
//   v3: 9-position layout restored, with the extension explicitly
//       labelled "+1st" instead of the misleading "1st"
//   v4: per-key fingering — `byKey: { C: {...}, Eb: {...}, ... }`
//       replaces the flat `fingerings`/`positions` at the root.
//       Pre-v4 files are migrated by wrapping their flat data
//       under the song's originalKey.
const EM_STORAGE_VERSION = 4;
// Position-index migration shared across schema versions. v1→v3
// rewrote position indices; subsequent versions keep the same
// 9-entry array, so this only runs when the source is v1 or v2.
function emMigratePositions(positions, version) {
  if (!positions || typeof positions !== 'object') return {};
  if (typeof version !== 'number') version = 1;
  if (version >= 3) return positions;
  // Filter to a clean numeric copy first so the migrations below
  // can mutate-and-rebuild without worrying about stray garbage.
  const clean = {};
  for (const key of Object.keys(positions)) {
    const v = positions[key];
    if (typeof v === 'number') clean[key] = v;
  }
  // v1 → v3: identity. v1 already had the 9-entry layout we now
  // have in v3; the only difference is that v1's idx=2 label was
  // "1st" (semantically misleading) and v3's is "+1st". Same
  // musical position either way — no index remapping needed.
  if (version === 1) {
    const out = {};
    for (const key of Object.keys(clean)) {
      const v = clean[key];
      if (v !== EM_DEFAULT_POSITION) out[key] = v;
    }
    return out;
  }
  // v2 → v3: v2 had 8 entries with no extension between 1st and
  // 2nd. v3 reinstates +1st at idx 2, so v2's idx 2..7 (2nd, 3rd,
  // +3rd, 4th, +4th, 5th) shift up by one to land at v3 idx 3..8.
  if (version === 2) {
    const out = {};
    for (const key of Object.keys(clean)) {
      const v = clean[key];
      const next = v <= 1 ? v : v + 1;
      if (next !== EM_DEFAULT_POSITION) out[key] = next;
    }
    return out;
  }
  return clean;
}

// Edit-mode state.
//
// `emFingeringsByKey` is the canonical store — one entry per key
// the user has edited fingerings in. `emFingerings` and `emPositions`
// are *references* into emFingeringsByKey[currentKey], updated by
// `emRefreshFromByKey()` whenever the key changes. Render and edit
// code both read/write through those references, so writes
// automatically land in the right per-key bucket without any
// extra plumbing.
let emEnabled = false;
let emProjectDir = null;        // FileSystemDirectoryHandle for the repo root
let emEditNoteIdx = 0;          // index into barElements[selectedBar].noteData
let emFingeringsByKey = {};     // { keyName: { fingerings: {...}, positions: {...} } }
let emFingerings = {};          // ref to byKey[currentKey].fingerings (or {})
let emPositions = {};           // ref to byKey[currentKey].positions  (or {})
let emFingeringsTitle = null;   // title the in-memory map was loaded for

// Refresh emFingerings / emPositions to point at the current key's
// entry in emFingeringsByKey. Lazily creates the entry if missing
// so subsequent writes (typing a fingering or stepping a position)
// land in the right bucket without a separate "did we already
// allocate this key?" check at every keystroke. Empty entries are
// pruned on save, so visiting a key without making any edits
// doesn't bloat the JSON file.
function emRefreshFromByKey() {
  const k = (typeof currentKey === 'string' && currentKey) ? currentKey : '';
  if (!k) {
    emFingerings = {};
    emPositions = {};
    return;
  }
  if (!emFingeringsByKey[k]) {
    emFingeringsByKey[k] = { fingerings: {}, positions: {} };
  }
  emFingerings = emFingeringsByKey[k].fingerings;
  emPositions  = emFingeringsByKey[k].positions;
}

// Take the JSON loaded from disk and produce a `byKey` map ready
// for emFingeringsByKey. Handles every legacy schema:
//   - v4+: data is already keyed by song key. Sanitize each entry.
//   - v1/v2/v3: flat fingerings/positions at root. Apply the v1→v3
//     position-index migration, then wrap the result under the
//     song's originalKey (the user's most-likely authoring key,
//     since pre-v4 had no per-key support to author OFF of).
function emMigrateByKey(json, wrapKey) {
  const version = (json && typeof json.version === 'number') ? json.version : 1;
  if (version >= 4) {
    const byKey = (json && typeof json.byKey === 'object' && json.byKey) || {};
    const out = {};
    for (const k of Object.keys(byKey)) {
      const entry = byKey[k];
      if (!entry || typeof entry !== 'object') continue;
      const fingerings = (typeof entry.fingerings === 'object' && entry.fingerings) || {};
      const positions  = (typeof entry.positions  === 'object' && entry.positions)  || {};
      out[k] = { fingerings: fingerings, positions: positions };
    }
    return out;
  }
  const fingerings = (json && typeof json.fingerings === 'object' && json.fingerings) || {};
  const rawPos     = (json && typeof json.positions  === 'object' && json.positions)  || {};
  const positions = emMigratePositions(rawPos, version);
  const out = {};
  if (Object.keys(fingerings).length > 0 || Object.keys(positions).length > 0) {
    const k = (typeof wrapKey === 'string' && wrapKey) ? wrapKey : 'C';
    out[k] = { fingerings: fingerings, positions: positions };
  }
  return out;
}

// One-time setup: prompt the user to pick the project root folder, or
// reuse a previously-saved handle. Returns the handle, or null if the
// user dismissed the picker.
async function emEnsureProjectDir() {
  if (!emProjectDir) {
    try { emProjectDir = await emIDBGet('projectDir'); } catch (e) { /* ignore */ }
  }
  if (emProjectDir) {
    try {
      const perm = await emProjectDir.queryPermission({ mode: 'readwrite' });
      if (perm === 'granted') return emProjectDir;
      const req = await emProjectDir.requestPermission({ mode: 'readwrite' });
      if (req === 'granted') return emProjectDir;
    } catch (e) { /* fall through to re-pick */ }
    emProjectDir = null;
  }
  if (typeof window.showDirectoryPicker !== 'function') return null;
  try {
    emProjectDir = await window.showDirectoryPicker({ mode: 'readwrite' });
    await emIDBSet('projectDir', emProjectDir);
    return emProjectDir;
  } catch (e) {
    return null;
  }
}

// Resolve the songs/fingerings/<title>.json file handle, creating
// every intermediate directory and the file itself if missing.
async function emFingeringFileHandle(title, opts) {
  const create = !!(opts && opts.create);
  const root = await emEnsureProjectDir();
  if (!root) return null;
  try {
    const songsDir = await root.getDirectoryHandle('songs', { create: true });
    const fDir = await songsDir.getDirectoryHandle('fingerings', { create: true });
    return await fDir.getFileHandle(title + '.json', { create: create });
  } catch (e) {
    return null;
  }
}

async function emLoadFingerings(title) {
  if (!title) return {};
  // HTTP fetch — works on every device, no FS permission needed,
  // no edit-mode toggle required. Loads the same file the laptop
  // edit-mode workflow writes via the File System Access API.
  // `cache: 'no-store'` so freshly-pushed fingering files show up
  // without manual cache-busting; the SW also strips cache for
  // anything under songs/ as a belt-and-suspenders.
  //
  // Capture the wrap-key BEFORE the await — if the user switches
  // songs mid-fetch, originalKey may have changed by the time the
  // response lands, and we want pre-v4 data wrapped under the key
  // that was active when this load was kicked off.
  const wrapKey = (typeof originalKey === 'string' && originalKey) ? originalKey : 'C';
  try {
    const url = 'songs/fingerings/' + encodeURIComponent(title) + '.json';
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return {};
    const text = await res.text();
    if (!text.trim()) return {};
    const json = JSON.parse(text);
    return emMigrateByKey(json, wrapKey);
  } catch (e) {
    return {};
  }
}

async function emSaveFingerings(title) {
  if (!title) return;
  try {
    const handle = await emFingeringFileHandle(title, { create: true });
    if (!handle) return;
    const writable = await handle.createWritable();
    // Prune empty per-key entries — visiting a transposed key
    // without typing anything would otherwise leave behind
    // `{ "Eb": { "fingerings": {}, "positions": {} } }` clutter
    // in the JSON file.
    const byKey = {};
    for (const k of Object.keys(emFingeringsByKey)) {
      const entry = emFingeringsByKey[k];
      if (!entry) continue;
      const f = entry.fingerings || {};
      const p = entry.positions  || {};
      if (Object.keys(f).length > 0 || Object.keys(p).length > 0) {
        byKey[k] = { fingerings: f, positions: p };
      }
    }
    const payload = {
      version: EM_STORAGE_VERSION,
      song: title,
      byKey: byKey
    };
    await writable.write(JSON.stringify(payload, null, 2));
    await writable.close();
  } catch (e) {
    console.warn('emSaveFingerings failed:', e);
  }
}

async function emEnsureFingeringsForCurrentSong() {
  if (!window.currentSong || !window.currentSong.song) return;
  const title = window.currentSong.song.title;
  if (!title) return;
  if (emFingeringsTitle !== title) {
    const loaded = await emLoadFingerings(title);
    // Re-check that the user hasn't switched songs while we were
    // fetching — if they did, the load result is for the wrong
    // song and we drop it.
    if (!window.currentSong || !window.currentSong.song
        || window.currentSong.song.title !== title) return;
    emFingeringsTitle = title;
    emFingeringsByKey = loaded;
  }
  // Always refresh the per-key view — currentKey may have changed
  // even when the song title hasn't (i.e. a transpose).
  emRefreshFromByKey();
}

// Walk a bar's noteData looking for the first/last entry that
// represents a real (pitched) note — rests come through as nulls.
function emFirstNoteIdx(barIdx) {
  const info = barElements[barIdx];
  if (!info || !info.noteData) return -1;
  for (let i = 0; i < info.noteData.length; i++) {
    if (info.noteData[i]) return i;
  }
  return -1;
}
function emLastNoteIdx(barIdx) {
  const info = barElements[barIdx];
  if (!info || !info.noteData) return -1;
  for (let i = info.noteData.length - 1; i >= 0; i--) {
    if (info.noteData[i]) return i;
  }
  return -1;
}

// Compute SVG-space coordinates for a notehead overlay. VexFlow's
// native getAbsoluteX / getYs are in the same viewBox the row's SVG
// uses, so we don't need any client-space conversion. The
// `annotShift` is the per-row vertical offset applied to chord /
// position / fingering when a row contains high noteheads — see
// the "annotation shift" block at the end of each row's render
// loop. Renderers subtract this from their target y so the entire
// annotation stack rises uniformly with the chord.
function emNoteheadGeometry(barIdx, noteIdx) {
  const info = barElements[barIdx];
  if (!info) return null;
  const nd = info.noteData[noteIdx];
  if (!nd) return null;
  const sn = nd.staveNote;
  if (!sn) return null;
  let x, y, w;
  try {
    x = sn.getAbsoluteX();
    const ys = sn.getYs && sn.getYs();
    y = ys && ys.length ? ys[0] : null;
    w = (sn.getGlyphWidth && sn.getGlyphWidth()) || 12;
  } catch (e) { return null; }
  if (!isFinite(x) || y == null || !isFinite(y)) return null;
  const annotShift = (typeof info.annotShift === 'number') ? info.annotShift : 0;
  return {
    x: x, y: y, w: w,
    svg: info.rowEl.querySelector('svg'),
    annotShift: annotShift
  };
}

// Bass clef top staff line. With staffY=36, VexFlow draws the top
// line near y=76 — see the staffY comment in renderChart for the
// detailed geometry.
const EM_TOP_LINE_Y = 76;

function emRenderCursor() {
  document.querySelectorAll('.edit-cursor').forEach(n => n.remove());
  if (!emEnabled || selectedBar == null) return;
  // Cursor only makes sense when we're actually looking at the head.
  // Edit Mode is gated on Head mode by emUpdateAvailability(), but
  // there's a transient window during a mode switch where this can
  // run before the toggle settles.
  if (typeof exerciseMode !== 'undefined' && exerciseMode !== 'head') return;
  const geom = emNoteheadGeometry(selectedBar, emEditNoteIdx);
  if (!geom || !geom.svg) return;
  const PAD_X = 4, PAD_Y = 7;
  const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  r.setAttribute('class', 'edit-cursor');
  r.setAttribute('x', geom.x - PAD_X);
  r.setAttribute('y', geom.y - PAD_Y);
  r.setAttribute('width', geom.w + PAD_X * 2);
  r.setAttribute('height', PAD_Y * 2);
  r.setAttribute('fill', 'none');
  r.setAttribute('stroke', '#c92a2a');
  r.setAttribute('stroke-width', 1.6);
  r.setAttribute('rx', 2);
  geom.svg.appendChild(r);
}

function emRenderFingerings() {
  document.querySelectorAll('.fingering-text, .fingering-bg').forEach(n => n.remove());
  // Fingerings are head-specific — they describe finger positions
  // for the head's actual melody, not for the algorithmically
  // generated exercise patterns. So they only paint when the
  // user is reading the Head (regardless of Edit Mode state). In
  // Exercise modes the in-memory map persists; switching back to
  // Head re-renders them.
  if (typeof exerciseMode !== 'undefined' && exerciseMode !== 'head') return;
  // Always render whatever fingerings are loaded — edit mode only
  // controls the COLOR (red while authoring; same color as the
  // notes once you toggle edit mode off so the fingerings blend
  // with the score). The in-memory map persists across toggles
  // for the same song, so flipping edit mode off doesn't lose
  // anything you typed.
  const fillColor = emEnabled ? '#c92a2a' : '#888';
  const keys = Object.keys(emFingerings);
  for (let k = 0; k < keys.length; k++) {
    const key = keys[k];
    const value = emFingerings[key];
    if (!value) continue;
    const parts = key.split(':');
    const barIdx = parseInt(parts[0], 10);
    const noteIdx = parseInt(parts[1], 10);
    if (!isFinite(barIdx) || !isFinite(noteIdx)) continue;
    const geom = emNoteheadGeometry(barIdx, noteIdx);
    if (!geom || !geom.svg) continue;
    // Fingering placement — track the notehead UP for high
    // ledger-line notes, but never rise so far that the text
    // crashes into the position line above. The offset is 14 px
    // above the notehead's pitch line, which empirically clears
    // the full glyph height plus a 3-4 px breathing margin.
    // Smaller offsets like 6 or 8 *almost* worked but the
    // descenders on the bold serif digits combined with the
    // notehead's full glyph extent kept producing 1-2 px overlap
    // on high ledger-line noteheads — bumping to 14 gives an
    // unambiguous gap.
    //
    //   - Notes in/below the staff (geom.y ≥ 82) → baseline=68,
    //     just above the top staff line. Default position.
    //   - High notes (geom.y < 82) → baseline = geom.y - 14.
    //   - Very high notes (geom.y ≤ 70) → floor at baseline=56 so
    //     the text top (≈47) doesn't crash into the position line.
    // Fingering baseline runs in a band ABOVE the staff. Floor
    // bumped from 56 → 58 so the now-larger font-15 glyph (cap
    // height ~11) doesn't crash into the position line at y=45 —
    // text top sits at y≈47 in the default case, leaving the
    // standard 2 px gap.
    const FINGER_BASELINE_FLOOR   = 58;
    const FINGER_BASELINE_CEILING = EM_TOP_LINE_Y - 8; // 68
    // Compute the baseline as if the row were at the default
    // staff position, then apply the row's annotation shift so
    // we move up uniformly with the chord/position above us.
    let ty = Math.max(
      FINGER_BASELINE_FLOOR,
      Math.min(FINGER_BASELINE_CEILING, geom.y - 14)
    );
    ty -= geom.annotShift;
    const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    t.setAttribute('class', 'fingering-text');
    t.setAttribute('x', geom.x + geom.w / 2);
    t.setAttribute('y', ty);
    t.setAttribute('text-anchor', 'middle');
    t.setAttribute('font-family', 'serif');
    t.setAttribute('font-weight', 'bold');
    // 15 to match the chord-symbol size — bigger fingering reads
    // much better when sight-reading at distance. The position
    // line's adaptive raise logic uses FINGER_FONT_HEIGHT below
    // to predict where this text's top will land.
    t.setAttribute('font-size', '15');
    t.setAttribute('fill', fillColor);
    t.setAttribute('stroke', 'none');
    t.textContent = value;
    geom.svg.appendChild(t);
    // White rectangle behind the text so the digit stays legible even
    // when it sits directly on top of a beat marker, ledger line, or
    // overlapping note glyph. Sized via the actual text bounding box
    // (1 px of padding on every side) so it hugs the digit instead of
    // covering more of the staff than necessary. The rect is inserted
    // BEFORE the text in document order so SVG paint order draws it
    // underneath; the wrapping cleanup query also picks it up via the
    // `fingering-bg` class.
    let bbox = null;
    try { bbox = t.getBBox(); } catch (e) { /* not yet in layout — skip bg */ }
    if (bbox && isFinite(bbox.width) && bbox.width > 0) {
      const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      bg.setAttribute('class', 'fingering-bg');
      bg.setAttribute('x', bbox.x - 1);
      bg.setAttribute('y', bbox.y - 1);
      bg.setAttribute('width',  bbox.width  + 2);
      bg.setAttribute('height', bbox.height + 2);
      bg.setAttribute('fill', '#fff');
      bg.setAttribute('stroke', 'none');
      geom.svg.insertBefore(bg, t);
    }
  }
}

// Render position bars: a horizontal line "hovering above the
// notehead" with a small text-in-a-box label above it. Consecutive
// notes with the same non-default position get one continuous bar
// spanning the run, with the label above the FIRST note. 1st
// position (idx 1, the default) has an empty label and renders
// nothing — we only annotate departures from default.
//
// Group breaks happen at:
//   - any rest (null in noteData)
//   - any note with a different position than the current run
//   - any note with no explicit position (treated as default)
//   - a row boundary (different SVG element)
function emRenderPositions() {
  document.querySelectorAll('.position-line, .position-box, .position-text').forEach(n => n.remove());
  if (typeof exerciseMode !== 'undefined' && exerciseMode !== 'head') return;
  // Vertical stack above the staff:
  //   chord row    y ≈ 19..30 (baseline 30, font 15)
  //   position     label y ≈ 31..41 (baseline 41, font 12),
  //                line y = 45 default, OR raised to clear a high
  //                fingering in the group (down to y=43 minimum
  //                where the label still clears chord-bottom).
  //   fingering    y ≈ 47..58 (baseline 58-68, font 15) — adapts
  //                to per-note y, see emRenderFingerings.
  //   top staff    y = 76
  // The line raises by 2 px (45→43) when fingering text in the
  // same group reaches up close to the default line; that opens a
  // 4 px gap between the position line and the topmost fingering
  // text, instead of the 2 px that read as overlap. For groups
  // without any fingering, the line stays at the default y=45 so
  // the layout doesn't shift around for no reason.
  const POS_LINE_DEFAULT_Y = 45;
  const POS_LINE_RAISED_Y  = 43; // when fingering forces line up
  const POS_LABEL_GAP      = 4;  // line-to-label-baseline gap
  // Position label font bumped from 10 → 12 to keep proportional
  // pace with the bigger fingering size below (12 → 15).
  const POS_FONT_SIZE      = 12;
  const POS_TEXT_HEIGHT    = 13; // approx font-size * 0.8 + 1 for ascent

  // Mirror emRenderFingerings's clamps so we can predict where
  // the fingering will land for each note in this group.
  const FINGER_BASELINE_FLOOR   = 58;
  const FINGER_BASELINE_CEILING = EM_TOP_LINE_Y - 8; // 68
  const FINGER_FONT_HEIGHT      = 11;                // font 15 → ~11 px cap height
  const LINE_FINGER_GAP         = 4;                 // min gap line→fingering top

  // Drawing color follows the same edit-mode convention as the
  // fingering numbers — red while authoring so the live edits
  // stand out, medium grey for reading so the annotations sit
  // visibly above the staff without competing with the noteheads.
  const color = emEnabled ? '#c92a2a' : '#888';

  let cur = null; // { positionIdx, svg, notes: [{ barIdx, noteIdx, x, y, w }] }
  function flushGroup() {
    if (!cur || cur.notes.length === 0) { cur = null; return; }
    const pos = EM_POSITIONS[cur.positionIdx];
    if (pos && pos.label) {
      const svg = cur.svg;
      const first = cur.notes[0];
      const last  = cur.notes[cur.notes.length - 1];
      // Per-group adaptive line position. Find the highest fingering
      // text top across notes in this group (matching the formula in
      // emRenderFingerings exactly). If that top would land closer
      // than LINE_FINGER_GAP to the default line, raise the line.
      // The raise is bounded — line can drop only as far as
      // POS_LINE_RAISED_Y where the label still clears the chord
      // row. Anything closer than that and we accept a tighter
      // visual; the fingering's own floor (56) keeps the gap from
      // ever closing entirely.
      let highestFingerTop = Infinity;
      for (let i = 0; i < cur.notes.length; i++) {
        const n = cur.notes[i];
        const fkey = n.barIdx + ':' + n.noteIdx;
        if (!(fkey in emFingerings)) continue;
        const fingerBaseY = Math.max(
          FINGER_BASELINE_FLOOR,
          Math.min(FINGER_BASELINE_CEILING, n.y - 14)
        );
        const fingerTop = fingerBaseY - FINGER_FONT_HEIGHT;
        if (fingerTop < highestFingerTop) highestFingerTop = fingerTop;
      }
      let lineY = POS_LINE_DEFAULT_Y;
      if (highestFingerTop !== Infinity
          && highestFingerTop < POS_LINE_DEFAULT_Y + LINE_FINGER_GAP) {
        lineY = Math.max(POS_LINE_RAISED_Y, highestFingerTop - LINE_FINGER_GAP);
      }
      // Apply the per-row annotation shift so the position elements
      // ride up with chord and fingering when a row contains high
      // noteheads. All notes in a group share a row (groups break
      // at row boundaries), so reading the shift off any one note
      // in the group is sufficient.
      const annotShift = (cur.notes[0] && typeof cur.notes[0].annotShift === 'number')
        ? cur.notes[0].annotShift : 0;
      lineY -= annotShift;
      const labelBaseline = lineY - POS_LABEL_GAP;
      const x1 = first.x - 4;
      const x2 = last.x + last.w + 4;
      // The line.
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('class', 'position-line');
      line.setAttribute('x1', x1);
      line.setAttribute('y1', lineY);
      line.setAttribute('x2', x2);
      line.setAttribute('y2', lineY);
      line.setAttribute('stroke', color);
      line.setAttribute('stroke-width', 1.2);
      line.setAttribute('stroke-linecap', 'round');
      svg.appendChild(line);
      // The position label, centered over the FIRST note in the run.
      // Plain text, no box around it.
      const cx = first.x + first.w / 2;
      const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      t.setAttribute('class', 'position-text');
      t.setAttribute('x', cx);
      t.setAttribute('y', labelBaseline);
      t.setAttribute('text-anchor', 'middle');
      t.setAttribute('font-family', 'serif');
      t.setAttribute('font-weight', 'bold');
      t.setAttribute('font-size', POS_FONT_SIZE);
      t.setAttribute('fill', color);
      t.setAttribute('stroke', 'none');
      t.textContent = pos.label;
      svg.appendChild(t);
    }
    cur = null;
  }
  if (!barElements || !barElements.length) return;
  for (let barIdx = 0; barIdx < barElements.length; barIdx++) {
    const info = barElements[barIdx];
    if (!info || !info.noteData) { flushGroup(); continue; }
    for (let noteIdx = 0; noteIdx < info.noteData.length; noteIdx++) {
      if (!info.noteData[noteIdx]) continue; // rest — doesn't break the group on its own
      const key = barIdx + ':' + noteIdx;
      const pIdx = (key in emPositions) ? emPositions[key] : EM_DEFAULT_POSITION;
      // Default (1st) position is "no annotation" — flush any open
      // group and skip.
      if (pIdx === EM_DEFAULT_POSITION) { flushGroup(); continue; }
      const geom = emNoteheadGeometry(barIdx, noteIdx);
      if (!geom || !geom.svg) { flushGroup(); continue; }
      // Same position AND same row → extend; otherwise start fresh.
      // Each note carries the row-level annotShift; groups never
      // span rows (svg-comparison breaks any cross-row attempt) so
      // every note in a group has the same shift.
      const noteRecord = {
        barIdx: barIdx, noteIdx: noteIdx,
        x: geom.x, y: geom.y, w: geom.w,
        annotShift: geom.annotShift
      };
      if (cur && cur.positionIdx === pIdx && cur.svg === geom.svg) {
        cur.notes.push(noteRecord);
      } else {
        flushGroup();
        cur = {
          positionIdx: pIdx,
          svg: geom.svg,
          notes: [noteRecord]
        };
      }
    }
  }
  flushGroup();
}

function emRenderOverlays() {
  emRenderFingerings();
  emRenderPositions();
  emRenderCursor();
}

// Play the currently-selected note as a brief preview through the
// Lead sampler — same instrument the "Play Score" toggle uses, with
// the same `+12` semitone shift to compensate for the bass-clef
// 8vb display. Intended to fire whenever the cursor lands on a new
// note in edit mode so the user can hear what they're fingering
// without starting full playback. Best-effort: silently no-ops if
// the sampler hasn't loaded yet, the audio context isn't started,
// playback is already running (don't fight the live audio), or
// anything else goes wrong.
function emPreviewSelectedNote() {
  if (!emEnabled || selectedBar == null) return;
  if (typeof playState !== 'undefined' && playState === 'playing') return;
  const info = barElements[selectedBar];
  if (!info || !info.noteData) return;
  const nd = info.noteData[emEditNoteIdx];
  if (!nd || nd.pitch == null) return;
  if (typeof guitar === 'undefined' || !guitar || !guitar.loaded) return;
  try {
    const name = midiToName(nd.pitch + 12);
    // '8n' = an eighth note at the current Tone.Transport tempo.
    // No `time` arg → fires immediately (Tone.now()).
    guitar.triggerAttackRelease(name, '8n', undefined, 0.7);
  } catch (e) { /* ignore — preview is best-effort */ }
}

function emMoveCursorRight() {
  if (selectedBar == null) return;
  const info = barElements[selectedBar];
  if (!info) return;
  // In-bar advance: no bar change, so the highlightBar wrapper
  // doesn't fire. Preview here.
  for (let i = emEditNoteIdx + 1; i < info.noteData.length; i++) {
    if (info.noteData[i]) {
      emEditNoteIdx = i;
      emRenderCursor();
      emPreviewSelectedNote();
      return;
    }
  }
  // Cross-bar jump: selectBar() invokes highlightBar(), whose
  // wrapper handles the preview. We don't call emPreviewSelectedNote
  // explicitly here — that would double-fire the sample.
  for (let bi = selectedBar + 1; bi < barElements.length; bi++) {
    const fi = emFirstNoteIdx(bi);
    if (fi >= 0) {
      emEditNoteIdx = fi;
      selectBar(bi);
      return;
    }
  }
}
function emMoveCursorLeft() {
  if (selectedBar == null) return;
  const info = barElements[selectedBar];
  if (!info) return;
  for (let i = emEditNoteIdx - 1; i >= 0; i--) {
    if (info.noteData[i]) {
      emEditNoteIdx = i;
      emRenderCursor();
      emPreviewSelectedNote();
      return;
    }
  }
  for (let bi = selectedBar - 1; bi >= 0; bi--) {
    const li = emLastNoteIdx(bi);
    if (li >= 0) {
      emEditNoteIdx = li;
      selectBar(bi);
      return;
    }
  }
}

async function emSetEnabled(on) {
  emEnabled = !!on;
  document.body.classList.toggle('edit-mode', emEnabled);
  if (emEnabled) {
    await emEnsureProjectDir();
    // Boot the audio graph so the Lead sampler is ready when the
    // user starts arrowing through notes — `initAudio()` is
    // idempotent (returns early if `piano` already exists), so
    // this is safe to call regardless of whether playback was
    // previously started. The toggle click counts as the user
    // gesture Tone.start() needs.
    try { await initAudio(); } catch (e) { /* ignore */ }
    // Force a fresh load — the user might have edited the file
    // between toggle-off and toggle-on, or this might be the first
    // time toggling on for this song.
    emFingeringsTitle = null;
    await emEnsureFingeringsForCurrentSong();
    if (selectedBar != null) {
      const fi = emFirstNoteIdx(selectedBar);
      if (fi >= 0) emEditNoteIdx = fi;
    }
  }
  // Note: when toggling OFF we DO NOT clear emFingerings — the
  // user wants the fingerings to remain visible (in note color
  // rather than red) so they can read the score with their
  // fingerings still showing.
  // BUT we DO clear any multi-bar range — that selection only has
  // a meaning while editing (Copy Fingerings reads from it). Off
  // edit mode, leaving 5 bars highlighted blue is just confusing,
  // so collapse back to the single anchor and repaint.
  if (!emEnabled && selectedBarRangeEnd != null) {
    selectedBarRangeEnd = null;
    if (selectedBar != null) highlightBar(selectedBar);
  }
  emRenderOverlays();
  // The kebab button's enabled state mirrors emEnabled, but
  // emSetEnabled is the one place that flips emEnabled directly
  // (emUpdateAvailability is called from mode/song-change paths,
  // not from the toggle switch itself), so we have to refresh
  // the kebab here too. Without this, the kebab stays disabled
  // forever once Edit Mode is turned on for the first time.
  if (typeof emUpdateKebabState === 'function') emUpdateKebabState();
  // Preview the note the cursor just landed on so the user
  // immediately hears the starting pitch when they enable edit
  // mode. Fires after render so the cursor visually appears at
  // the same instant the sound starts.
  if (emEnabled) emPreviewSelectedNote();
}

// Availability gate: Edit Mode requires Head exercise mode AND a
// successfully-loaded head file for the current song. When
// unavailable, the toggle dims and won't accept clicks; if the user
// was already in edit mode and the song / mode shifts to an
// unsupported state, force it off.
function emIsAvailable() {
  if (typeof exerciseMode === 'undefined') return false;
  if (exerciseMode !== 'head') return false;
  const cs = window.currentSong;
  if (!cs) return false;
  // Treat as available once the head load finished AND returned data.
  // If the load is still pending, keep the toggle disabled — flipping
  // it on while the data isn't ready would just produce empty
  // overlays.
  return cs.headLoaded === true && !!cs.head;
}
function emUpdateAvailability() {
  const label = document.getElementById('editModeLabel');
  const cb    = document.getElementById('editModeToggle');
  if (!label || !cb) return;
  // First guard: if this isn't an editor device at all (phone PWA,
  // Mac, Linux, Firefox/Safari on any OS), the toggle stays
  // hidden no matter what mode/song state says. We re-check on
  // every availability update so a stray code path that ever
  // un-hid the label gets corrected on the next song / mode flip.
  if (!emIsEditorDevice()) {
    label.hidden = true;
    if (emEnabled) {
      cb.checked = false;
      emSetEnabled(false);
    }
    emUpdateKebabState();
    return;
  }
  label.hidden = false;
  const ok = emIsAvailable();
  label.classList.toggle('disabled', !ok);
  cb.disabled = !ok;
  // If we were ON and the mode/song no longer permits editing,
  // turn off and clear overlays so we don't stay in a half-state.
  if (!ok && emEnabled) {
    cb.checked = false;
    emSetEnabled(false);
  }
  emUpdateKebabState();
}

// === Kebab menu + copy/paste ============================================
//
// Clipboard for fingering+position copy/paste. `null` until the
// user invokes Copy Fingerings; cleared by reload only (a successful
// paste leaves it intact so the user can paste the same set
// repeatedly to multiple targets if they want).
let emClipboard = null; // null OR { entries: [{ fingering, position }, ...] }

// Update kebab visibility + enabled state. Mirrors the rules for
// the Edit Mode switch and the user's device:
//   - hidden entirely on mobile (none of the menu items work there —
//     Print needs a desktop print dialog and the fingering tools need
//     File System Access API).
//   - on any desktop browser (Mac/Linux/Windows) the kebab is always
//     SHOWN and always ENABLED. Print Worksheet is always live; the
//     fingering items disable individually when Edit Mode is off
//     (or when the device can't host the editor — e.g. Mac/Linux).
//   - Paste also disables when the clipboard is empty even within
//     an active Edit Mode.
function emUpdateKebabState() {
  const btn = document.getElementById('editKebabBtn');
  const menu = document.getElementById('editKebabMenu');
  const printBtn = document.getElementById('printScoreBtn');
  if (!btn) return;
  if (emIsMobile()) {
    btn.hidden = true;
    if (menu) menu.hidden = true;
    if (printBtn) printBtn.hidden = true;
    return;
  }
  btn.hidden = false;
  // Print button lives next to the kebab and stays available
  // whenever the kebab is visible (desktop only). It doesn't edit
  // fingerings so it's not gated on Edit Fingering being on.
  if (printBtn) {
    printBtn.hidden = false;
    printBtn.disabled = false;
  }
  // Kebab itself is only ENABLED when Edit Fingering is on. With the
  // Print option moved out, every remaining menu item edits
  // fingerings — so disabling the whole button (plus auto-closing
  // any open menu) when fingering editing is off is cleaner than
  // greying out each item individually.
  const fingeringEnabled = emEnabled && emIsEditorDevice();
  btn.disabled = !fingeringEnabled;
  if (!fingeringEnabled && menu && !menu.hidden) {
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
  }
  const copy   = document.getElementById('copyFingeringsBtn');
  const paste  = document.getElementById('pasteFingeringsBtn');
  const delAll = document.getElementById('deleteAllFingeringsBtn');
  if (copy)   copy.disabled   = !fingeringEnabled;
  if (paste)  paste.disabled  = !fingeringEnabled
    || !(emClipboard && emClipboard.entries && emClipboard.entries.length > 0);
  if (delAll) delAll.disabled = !fingeringEnabled;
  // Position-fingering buttons follow the same gate as the rest of
  // the fingering tools — they edit fingerings, so they're only
  // available when Edit Fingering is on AND we're on a desktop /
  // editor device.
  document.querySelectorAll('.em-position-btn').forEach(b => {
    b.disabled = !fingeringEnabled;
  });
}

function emOpenKebabMenu() {
  const btn = document.getElementById('editKebabBtn');
  const menu = document.getElementById('editKebabMenu');
  if (!btn || !menu) return;
  // Position the fixed-position menu just under and right-aligned
  // with the kebab button, using its viewport rect so any ancestor
  // overflow:hidden doesn't clip us.
  const r = btn.getBoundingClientRect();
  menu.hidden = false;
  // Align the menu's right edge with the button's right edge.
  menu.style.top = (r.bottom + 4) + 'px';
  menu.style.right = (window.innerWidth - r.right) + 'px';
  menu.style.left = 'auto';
  btn.setAttribute('aria-expanded', 'true');
}
function emCloseKebabMenu() {
  const btn = document.getElementById('editKebabBtn');
  const menu = document.getElementById('editKebabMenu');
  if (menu) menu.hidden = true;
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

// Copy fingerings + positions from the current selection (single
// bar or multi-bar range) into emClipboard. Walks the selected bars'
// notes in order, capturing each note's fingering / position state
// (or `null` for "no annotation"). The clipboard is just an ordered
// list of { fingering, position } entries — bar/note indexes aren't
// preserved, since paste applies sequentially from the target bar
// regardless of how the source was structured.
function emCopyFingerings() {
  if (selectedBar == null) return;
  const a = selectedBarRangeEnd != null
    ? Math.min(selectedBar, selectedBarRangeEnd)
    : selectedBar;
  const b = selectedBarRangeEnd != null
    ? Math.max(selectedBar, selectedBarRangeEnd)
    : selectedBar;
  const entries = [];
  for (let bi = a; bi <= b; bi++) {
    const info = barElements[bi];
    if (!info || !info.noteData) continue;
    for (let ni = 0; ni < info.noteData.length; ni++) {
      if (!info.noteData[ni]) continue; // skip rests
      const key = bi + ':' + ni;
      const fingering = (key in emFingerings) ? emFingerings[key] : null;
      const position  = (key in emPositions)  ? emPositions[key]  : null;
      entries.push({ fingering: fingering, position: position });
    }
  }
  emClipboard = { entries: entries };
  emUpdateKebabState();
}

// Cello position → MIDI → fingering tables. Ported from the user's
// MuseScore plugins (cellofingering*.qml). Each position maps the
// MIDI pitches it can comfortably reach to the appropriate fingering
// label — Roman numerals (I/II/III/IV/V) for open strings, '1'..'4'
// for stopped notes, '4+' for the half-step extension above 4, and
// '-1' for the half-step below 1 (used in 1st position and above).
// Notes outside a position's reach aren't in its table — the apply
// helper below leaves those notes' existing fingerings untouched
// rather than overwrite with '?'.
const EM_POSITION_FINGERINGS = {
  half: {
    29:'V', 30:'1', 31:'2', 32:'3', 33:'4', 34:'4+',
    36:'IV',37:'1', 38:'2', 39:'3', 40:'4', 41:'4+',
    43:'III',44:'1',45:'2', 46:'3', 47:'4', 48:'4+',
    50:'II',51:'1', 52:'2', 53:'3', 54:'4', 55:'4+',
    57:'I', 58:'1', 59:'2', 60:'3', 61:'4', 62:'4+'
  },
  first: {
    29:'V', 30:'-1',31:'1', 32:'2', 33:'3', 34:'4', 35:'4+',
    36:'IV',37:'-1',38:'1', 39:'2', 40:'3', 41:'4', 42:'4+',
    43:'III',44:'-1',45:'1',46:'2', 47:'3', 48:'4', 49:'4+',
    50:'II',51:'-1',52:'1', 53:'2', 54:'3', 55:'4', 56:'4+',
    57:'I', 58:'-1',59:'1', 60:'2', 61:'3', 62:'4', 63:'4+'
  },
  upper1st: {
    31:'-1',32:'1', 33:'2', 34:'3', 35:'4', 36:'4+',
    38:'-1',39:'1', 40:'2', 41:'3', 42:'4', 43:'4+',
    45:'-1',46:'1', 47:'2', 48:'3', 49:'4', 50:'4+',
    52:'-1',53:'1', 54:'2', 55:'3', 56:'4', 57:'4+',
    59:'-1',60:'1', 61:'2', 62:'3', 63:'4', 64:'4+'
  },
  second: {
    39:'-1',40:'1', 41:'2', 42:'3', 43:'4', 44:'4+',
    46:'-1',47:'1', 48:'2', 49:'3', 50:'4', 51:'4+',
    53:'-1',54:'1', 55:'2', 56:'3', 57:'4', 58:'4+',
    60:'-1',61:'1', 62:'2', 63:'3', 64:'4', 65:'4+'
  },
  third: {
    40:'-1',41:'1', 42:'2', 43:'3', 44:'4', 45:'4+',
    47:'-1',48:'1', 49:'2', 50:'3', 51:'4', 52:'4+',
    54:'-1',55:'1', 56:'2', 57:'3', 58:'4', 59:'4+',
    61:'-1',62:'1', 63:'2', 64:'3', 65:'4', 66:'4+'
  },
  upper3rd: {
    41:'-1',42:'1', 43:'2', 44:'3', 45:'4', 46:'4+',
    48:'-1',49:'1', 50:'2', 51:'3', 52:'4', 53:'4+',
    55:'-1',56:'1', 57:'2', 58:'3', 59:'4', 60:'4+',
    62:'-1',63:'1', 64:'2', 65:'3', 66:'4', 67:'4+'
  },
  fourth: {
    42:'-1',43:'1', 44:'2', 45:'3', 46:'4', 47:'4+',
    49:'-1',50:'1', 51:'2', 52:'3', 53:'4', 54:'4+',
    56:'-1',57:'1', 58:'2', 59:'3', 60:'4', 61:'4+',
    63:'-1',64:'1', 65:'2', 66:'3', 67:'4', 68:'4+'
  },
  upper4th: {
    43:'-1',44:'1', 45:'2', 46:'3', 47:'4', 48:'4+',
    50:'-1',51:'1', 52:'2', 53:'3', 54:'4', 55:'4+',
    57:'-1',58:'1', 59:'2', 60:'3', 61:'4', 62:'4+',
    64:'-1',65:'1', 66:'2', 67:'3', 68:'4', 69:'4+'
  },
  fifth: {
    44:'-1',45:'1', 46:'2', 47:'3', 48:'4', 49:'4+',
    51:'-1',52:'1', 53:'2', 54:'3', 55:'4', 56:'4+',
    58:'-1',59:'1', 60:'2', 61:'3', 62:'4', 63:'4+',
    65:'-1',66:'1', 67:'2', 68:'3', 69:'4', 70:'4+'
  }
};

// Map a data-position key to its index in EM_POSITIONS, so the
// apply-position helper can stamp the same value emPositions[] uses
// elsewhere (per-note position cycling, copy/paste round-trips, the
// position-line renderer). Order MUST match EM_POSITIONS above:
//   0 half · 1 first · 2 upper1st · 3 second · 4 third · 5 upper3rd
//   6 fourth · 7 upper4th · 8 fifth
const EM_POSITION_KEY_TO_IDX = {
  half: 0, first: 1, upper1st: 2, second: 3,
  third: 4, upper3rd: 5, fourth: 6, upper4th: 7, fifth: 8
};

// Apply a position's fingering map to every pitched note inside the
// currently selected bar (or selected bar range). Notes whose MIDI
// isn't covered by the chosen position are left as-is — better than
// stomping a previously-correct fingering with '?' when a single
// out-of-position note appears in an otherwise good range.
// In addition, stamp emPositions on every pitched note in the
// selection so the position-line renderer draws a single line +
// label spanning the full selection. (Position idx 1 = "1st" is
// the implicit default; the renderer skips drawing a line for it,
// so applying 1st position effectively clears any prior position
// annotation across the selection — matching the convention that
// 1st position doesn't carry a visible marker.)
// Persists immediately and re-renders overlays so the new labels
// show up without further interaction.
function emApplyPositionFingerings(positionKey) {
  if (!emFingeringsTitle) return;
  if (selectedBar == null) return;
  const map = EM_POSITION_FINGERINGS[positionKey];
  if (!map) return;
  const posIdx = EM_POSITION_KEY_TO_IDX[positionKey];
  const a = selectedBarRangeEnd != null
    ? Math.min(selectedBar, selectedBarRangeEnd)
    : selectedBar;
  const b = selectedBarRangeEnd != null
    ? Math.max(selectedBar, selectedBarRangeEnd)
    : selectedBar;
  for (let bi = a; bi <= b; bi++) {
    const info = barElements[bi];
    if (!info || !info.noteData) continue;
    for (let ni = 0; ni < info.noteData.length; ni++) {
      const nd = info.noteData[ni];
      if (!nd || typeof nd.pitch !== 'number') continue;
      const key = bi + ':' + ni;
      const fingering = map[nd.pitch];
      if (fingering != null) emFingerings[key] = fingering;
      // Stamp the position regardless of whether the note's pitch
      // is in this position's table — the line spans the whole
      // selection, so out-of-range notes still contribute to the
      // group geometry. The default-position case (idx 1 = 1st)
      // gets cleared via delete so the renderer falls through to
      // its "no annotation" path.
      if (posIdx === EM_DEFAULT_POSITION) {
        delete emPositions[key];
      } else if (typeof posIdx === 'number') {
        emPositions[key] = posIdx;
      }
    }
  }
  emRenderOverlays();
  emSaveFingerings(emFingeringsTitle);
}

// Wipe every fingering and position annotation for the CURRENT key
// only — other keys' data on the same song is untouched. Confirms
// before destroying anything; no-ops on cancel. Saves the file at
// the end so the deletion is committed to disk immediately.
function emDeleteAllFingerings() {
  if (!emFingeringsTitle) return;
  const fEmpty = !emFingerings || Object.keys(emFingerings).length === 0;
  const pEmpty = !emPositions || Object.keys(emPositions).length === 0;
  if (fEmpty && pEmpty) return; // nothing to delete
  const keyLabel = (typeof currentKey === 'string' && currentKey) ? currentKey : '';
  const msg = keyLabel
    ? `Delete every fingering and position annotation for "${emFingeringsTitle}" in ${keyLabel}?`
    : `Delete every fingering and position annotation for "${emFingeringsTitle}"?`;
  if (typeof confirm === 'function' && !confirm(msg)) return;
  // emFingerings / emPositions are references into byKey[currentKey]
  // — clearing the underlying objects is enough; the byKey entry
  // becomes empty and gets pruned on save.
  for (const k of Object.keys(emFingerings)) delete emFingerings[k];
  for (const k of Object.keys(emPositions))  delete emPositions[k];
  emRenderOverlays();
  emSaveFingerings(emFingeringsTitle);
}

// Paste from emClipboard onto consecutive notes starting at the
// currently-selected bar. Each clipboard entry maps to one
// pitched note in the target stream — rests are skipped, and we
// continue across bar boundaries until either the clipboard or the
// score runs out. Empty clipboard entries (`null` fingering /
// position) overwrite the target, so pasting clears any prior
// annotation that was on a now-empty source slot.
function emPasteFingerings() {
  if (!emClipboard || !emClipboard.entries.length) return;
  if (selectedBar == null) return;
  const entries = emClipboard.entries;
  let idx = 0;
  let bi = selectedBar;
  while (bi < barElements.length && idx < entries.length) {
    const info = barElements[bi];
    if (!info || !info.noteData) { bi++; continue; }
    for (let ni = 0; ni < info.noteData.length && idx < entries.length; ni++) {
      if (!info.noteData[ni]) continue; // skip rests
      const key = bi + ':' + ni;
      const e = entries[idx++];
      if (e.fingering != null) emFingerings[key] = e.fingering;
      else                     delete emFingerings[key];
      if (e.position != null) emPositions[key] = e.position;
      else                    delete emPositions[key];
    }
    bi++;
  }
  emRenderOverlays();
  if (emFingeringsTitle) emSaveFingerings(emFingeringsTitle);
}

(function emInitToggle() {
  const label = document.getElementById('editModeLabel');
  const cb    = document.getElementById('editModeToggle');
  if (!label || !cb) return;
  if (!emIsEditorDevice()) return;
  label.hidden = false;
  cb.addEventListener('change', async () => {
    if (!emIsAvailable()) {
      cb.checked = false;
      return;
    }
    await emSetEnabled(cb.checked);
  });
  emUpdateAvailability();
})();

(function emInitKebab() {
  const btn = document.getElementById('editKebabBtn');
  const menu = document.getElementById('editKebabMenu');
  if (!btn || !menu) return;
  // The kebab is now visible on every desktop browser (Print is the
  // common item; the fingering tools live behind their own
  // emEnabled+emIsEditorDevice gates). Bail out only on mobile,
  // where Print and the editor would both be useless.
  if (emIsMobile()) return;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    // Disabled state (Edit Fingering off) — ignore clicks. Browsers
    // already block click events on disabled native buttons, but
    // event listeners can still fire if `pointer-events` lets the
    // click through. Belt-and-suspenders.
    if (btn.disabled) return;
    if (menu.hidden) emOpenKebabMenu();
    else             emCloseKebabMenu();
  });
  // Print Worksheet → fires the system print dialog. Used to save
  // a PDF or print to paper. The active @media print stylesheet
  // strips the toolbar/footer/panels and leaves just the score.
  // Now lives as a standalone toolbar button next to the kebab,
  // not inside the kebab menu, so it's available regardless of
  // whether Edit Fingering is on.
  const printBtn = document.getElementById('printScoreBtn');
  if (printBtn) {
    printBtn.addEventListener('click', () => {
      if (printBtn.disabled) return;
      window.print();
    });
  }
  const copyBtn  = document.getElementById('copyFingeringsBtn');
  const pasteBtn = document.getElementById('pasteFingeringsBtn');
  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      if (copyBtn.disabled) return;
      emCopyFingerings();
      emCloseKebabMenu();
    });
  }
  if (pasteBtn) {
    pasteBtn.addEventListener('click', () => {
      if (pasteBtn.disabled) return;
      emPasteFingerings();
      emCloseKebabMenu();
    });
  }
  const deleteAllBtn = document.getElementById('deleteAllFingeringsBtn');
  if (deleteAllBtn) {
    deleteAllBtn.addEventListener('click', () => {
      if (deleteAllBtn.disabled) return;
      emDeleteAllFingerings();
      emCloseKebabMenu();
    });
  }
  // Position-fingering buttons — one per cello position. Click looks
  // up the data-position key (e.g. "first", "upper3rd") and feeds it
  // to emApplyPositionFingerings, which walks the selected bar /
  // bar range and applies the corresponding MIDI→fingering table.
  document.querySelectorAll('.em-position-btn').forEach(b => {
    b.addEventListener('click', () => {
      if (b.disabled) return;
      emApplyPositionFingerings(b.dataset.position);
      emCloseKebabMenu();
    });
  });
  // Click-outside and Escape close the menu.
  document.addEventListener('click', (e) => {
    if (menu.hidden) return;
    if (e.target === btn || btn.contains(e.target)) return;
    if (e.target === menu || menu.contains(e.target)) return;
    emCloseKebabMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.hidden) emCloseKebabMenu();
  });
  emUpdateKebabState();
})();

// Print sizing: bars-per-row is fixed by the song's time signature
// (4 for 4/4, 3 for 3/4), and the user's S/M/L selection controls
// only the VERTICAL ZOOM by varying the print target aspect ratio:
//                  aspect    row height   notehead size
//   S (180)        9.5        0.79in       0.048in
//   M (120)        6.5        1.15in       0.071in
//   L (80)         5.5        1.36in       0.082in
// Lower aspect → taller row → bigger notes (notehead glyph is a
// fixed viewBox size, so when the SVG renders at 7.5in width the
// glyph paints proportionally bigger when the viewBox is shorter).
// Per-bar paper width stays constant within a meter — 1.875in for
// 4/4, 2.5in for 3/4 — so inter-note spacing is the same across
// S/M/L; only the staff and noteheads scale up or down.
// M aspect tuned so a 32-bar / 8-row chart with one fingering or
// note-name overlay enabled fills (but doesn't overflow) a single
// US Letter page — about a 14% notehead bump from the prior 7.4.
//
// To preview on screen before printing, toggle S/M/L in the
// Options panel — the screen rendering uses chartSize directly,
// so smaller chartSize (L) zooms the score up. The screen aspect
// won't precisely match the print aspect, but the relative sizing
// (L bigger than M than S) is the same either way.
//
// _printMode is also read by renderChart itself to (a) widen each
// bar so the row's natural aspect ratio fills the page width
// instead of leaving big side margins, and (b) split the row into
// equal-width bars (overriding the note-density weighting that
// makes some bars wider than others on screen).
let _printMode = false;
let _printTargetAspect = 6.5;
(function bindPrintLayout() {
  let savedMpl = null;
  window.addEventListener('beforeprint', () => {
    if (!window.currentSong) return;
    if (typeof measuresPerLine === 'undefined') return;
    savedMpl = measuresPerLine;
    // mpl is dictated by the song's time signature: 3 for 3/4,
    // 4 for everything else (4/4 is the dominant case; uncommon
    // meters like 5/4 fall back to 4 — the layout still works,
    // just with one bar on its own at the end of a row).
    const ts = parseTimesig(window.currentSong.timesig);
    measuresPerLine = (ts && ts.num === 3) ? 3 : 4;
    // chartSize → aspect. Thresholds at 150 / 100 catch the
    // existing chartSize values (180 / 120 / 80) cleanly.
    const cs = (typeof chartSize !== 'undefined') ? chartSize : 120;
    if (cs >= 150) {            // S — short row, small notes
      _printTargetAspect = 9.5;
    } else if (cs >= 100) {     // M — default
      _printTargetAspect = 6.5;
    } else {                    // L — tall row, big notes
      _printTargetAspect = 5.5;
    }
    _printMode = true;
    if (typeof rerenderCurrent === 'function') rerenderCurrent();
    // The wrapped renderChart re-paints fingerings via a Promise's
    // .then() callback — that's a microtask, which Chromium doesn't
    // always drain before capturing the print preview's DOM. Result:
    // the fingerings are missing on paper even though they're back
    // on screen the moment the dialog closes. Force a SYNCHRONOUS
    // overlay re-paint here so the printed output matches the
    // on-screen state. The data lives in `emFingerings` already,
    // populated on the first render of the current song; we just
    // need to draw it into the freshly-rendered SVGs.
    if (typeof emRenderOverlays === 'function') emRenderOverlays();
  });
  window.addEventListener('afterprint', () => {
    _printMode = false;
    if (savedMpl != null) {
      measuresPerLine = savedMpl;
      savedMpl = null;
    }
    if (typeof rerenderCurrent === 'function') rerenderCurrent();
    if (typeof emRenderOverlays === 'function') emRenderOverlays();
  });
})();

// Re-render overlays after every chart re-render. renderChart wipes
// the SVGs, so any cursor / fingering text needs to be re-applied.
//
// Loading is unconditional — fingering files are fetched over HTTP
// (cheap, public, works on the phone PWA too) so we always show
// whatever's been saved for the current song, no edit-mode toggle
// required. The cache check inside emEnsureFingeringsForCurrentSong
// makes the second-and-onward render of the same song free.
const _emOriginalRenderChart = renderChart;
renderChart = function emWrappedRenderChart() {
  const result = _emOriginalRenderChart.apply(this, arguments);
  emEnsureFingeringsForCurrentSong().then(emRenderOverlays);
  return result;
};

// Bar selection changes need a cursor refresh. If the new bar's
// noteData doesn't have an entry at the current emEditNoteIdx,
// snap to the first note in that bar. The movement helpers above
// pre-set emEditNoteIdx to a valid slot before calling selectBar,
// so this only fires the snap for click-driven selection.
const _emOriginalHighlightBar = highlightBar;
highlightBar = function emWrappedHighlightBar(idx) {
  const result = _emOriginalHighlightBar.call(this, idx);
  if (emEnabled) {
    const info = barElements[idx];
    const valid = info && info.noteData && info.noteData[emEditNoteIdx];
    if (!valid) {
      const fi = emFirstNoteIdx(idx);
      emEditNoteIdx = fi >= 0 ? fi : 0;
    }
    emRenderOverlays();
    // Preview the cursor's note. Triggers whether the bar change
    // came from a click (user picks a different bar in edit mode)
    // or from an arrow key jumping past the end of the current
    // bar. emPreviewSelectedNote no-ops during playback, so the
    // many highlightBar calls during live playback don't spam the
    // Lead sampler.
    emPreviewSelectedNote();
  }
  return result;
};

// Allowed input keys → fingering string. Anything not in this map
// is ignored. The mapping covers:
//   1..4         → "1".."4"        (right-hand fingers — standard
//                                    bass guitar notation)
//   5            → "4+"            (extension past pinky)
//   `            → "-1"            (thumb-behind / "minus" position;
//                                    backtick chosen because it's
//                                    just left of 1, mirroring the
//                                    "one below" semantics)
//   A,D,G,C,F    → "I","II","III","IV","V"  (string numbers — first
//                                    five strings of an upright bass
//                                    or the four-string equivalents
//                                    plus a low-B add)
// Both upper and lower case map to the same value.
const EM_KEY_MAP = {
  '1': '1', '2': '2', '3': '3', '4': '4',
  '5': '4+',
  '`': '-1',
  'a': 'I', 'A': 'I',
  'd': 'II', 'D': 'II',
  'g': 'III', 'G': 'III',
  'c': 'IV', 'C': 'IV',
  'f': 'V', 'F': 'V'
};

// Edit-mode key handling: arrows navigate, the mapped keys above
// assign a fingering, Delete/Backspace clears one. All other keys
// are passed through to the rest of the page (so spacebar still
// reaches the play handler, etc.).
document.addEventListener('keydown', e => {
  if (!emEnabled) return;
  const t = e.target;
  if (t) {
    const tag = (t.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if (t.isContentEditable) return;
  }
  // Ctrl+C / Ctrl+V (or Cmd on macOS) before the generic modifier
  // guard below — these are the copy/paste hotkeys for the
  // fingering clipboard. preventDefault() blocks the browser's
  // native copy/paste, which would otherwise try to operate on
  // any document selection (always empty under #chart since we
  // disable user-select there, but still worth suppressing for
  // any stray selection elsewhere).
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
    const k = (e.key || '').toLowerCase();
    if (k === 'c') {
      e.preventDefault();
      emCopyFingerings();
      return;
    }
    if (k === 'v') {
      e.preventDefault();
      emPasteFingerings();
      return;
    }
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 'ArrowRight') {
    e.preventDefault();
    emMoveCursorRight();
    return;
  }
  if (e.key === 'ArrowLeft') {
    e.preventDefault();
    emMoveCursorLeft();
    return;
  }
  // Delete (or Backspace) on the current note → clear its fingering
  // AND its position annotation. Cursor stays put so the user can
  // immediately retype if they pressed delete by accident.
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (selectedBar == null) return;
    const info = barElements[selectedBar];
    if (!info || !info.noteData[emEditNoteIdx]) return;
    e.preventDefault();
    const key = selectedBar + ':' + emEditNoteIdx;
    let changed = false;
    if (key in emFingerings) { delete emFingerings[key]; changed = true; }
    if (key in emPositions)  { delete emPositions[key];  changed = true; }
    if (changed) {
      emRenderOverlays();
      if (emFingeringsTitle) emSaveFingerings(emFingeringsTitle);
    }
    return;
  }
  // Cello fingerboard position: `-` steps down, `=` (or `+` for
  // shift-=) steps up. The transition is clamped to the array
  // bounds. Pressing from default (no entry → 1st position) maps
  // to half (idx 0) on `-` and upper-1st (idx 2) on `=`. The
  // cursor stays put — these adjust the current note's position
  // without advancing.
  if (e.key === '-' || e.key === '=' || e.key === '+') {
    if (selectedBar == null) return;
    const info = barElements[selectedBar];
    if (!info || !info.noteData[emEditNoteIdx]) return;
    e.preventDefault();
    const key = selectedBar + ':' + emEditNoteIdx;
    const cur = (key in emPositions) ? emPositions[key] : EM_DEFAULT_POSITION;
    let next = cur;
    if (e.key === '-') next = Math.max(0, cur - 1);
    else next = Math.min(EM_POSITIONS.length - 1, cur + 1);
    if (next === EM_DEFAULT_POSITION) {
      // Landing on the default position is the same as having no
      // entry — drop the key so the JSON stays clean.
      delete emPositions[key];
    } else {
      emPositions[key] = next;
    }
    emRenderOverlays();
    if (emFingeringsTitle) emSaveFingerings(emFingeringsTitle);
    return;
  }
  // Translate the keypress against the allowed-keys table. If it
  // isn't a recognised key, we silently ignore it — no preventDefault,
  // so other listeners (spacebar play/pause) still see it.
  const mapped = EM_KEY_MAP[e.key];
  if (mapped == null) return;
  if (selectedBar == null) return;
  const info = barElements[selectedBar];
  if (!info || !info.noteData[emEditNoteIdx]) return;
  e.preventDefault();
  const key = selectedBar + ':' + emEditNoteIdx;
  emFingerings[key] = mapped;
  emRenderOverlays();
  if (emFingeringsTitle) emSaveFingerings(emFingeringsTitle);
  emMoveCursorRight();
});

// ===== Game mode =====
// A simple ear-training / sight-reading game built on top of the
// existing exercise rendering. When toggled on:
//   - Every note in the rendered score is hidden EXCEPT the first.
//   - A 4×3 chromatic keyboard (12 PCs) appears below the chart in
//     place of the fingerboard panel.
//   - Pressing a key checks the pitch-class against the NEXT hidden
//     note in playback order. Correct → reveal the note, play it
//     through the Lead guitar sampler, +1 to the black correct
//     counter. Wrong → flash a red clone of the next note for one
//     second + 1 to the red mistake counter; the note stays hidden
//     so the player can try again.
// The game state is rebuilt after every renderChart pass so changing
// the song / exercise / key / repeats automatically resets the game.

let gameMode = false;
// Two distinct gameplay flavors. Default 'follow'.
//   'hidden': original behavior — all notes start hidden except the
//             first; player reveals each next note by playing it
//             correctly. Wrong note rewinds to the start of the
//             current chord.
//   'follow': all notes visible from the start; metronome paces the
//             cursor (one note per tick). Wrong notes get a
//             permanent red mark. At the end, bars containing any
//             red note get a semi-transparent red wash. No chord
//             stab between chord changes.
let gameKind     = 'follow';
let gameSequence = [];         // [{ barIdx, slotIdx, pitch, pc, chordEventIdx }, ...]
let gameCursor   = 0;          // index of the next-expected note in gameSequence
let gameCorrect  = 0;
let gameMistakes = 0;
let gameWrongTimer = null;     // setTimeout handle for clearing the red-flash clone
let gameWrongEl    = null;     // current red-flash DOM element
// Game-mode bookkeeping.
const gameRedNotes    = new Set(); // 'barIdx:slotIdx' for notes the user played wrong
const gameGreenNotes  = new Set(); // 'barIdx:slotIdx' for notes the user got right (or freebies)
const gamePlayedNotes = new Set(); // 'barIdx:slotIdx' for notes the user attempted this play-through
const gameFilledRests = new Set(); // 'barIdx:slotIdx' for rest slots the user filled in (Landmarks)
let gameFillNoteEls = [];          // DOM elements of placed fill notes (for reset cleanup)
let gameBeatMap = [];              // one entry per beat in the song (see gameBuildSequence)
let gameCurrentBeat = -1;          // Follow-mode beat cursor; -1 before the first metronome tick
let gameFollowFinished = false;    // true once the metronome has walked off the end

// Build the linear pitch sequence from barElements. Pulled in order
// of bar → slot, skipping any nulls (rests) or notes without a
// pitch. The PC (pitch-class 0..11) is what we compare against the
// keyboard's data-pc attribute.
function gameBuildSequence() {
  gameSequence = [];
  gameBeatMap = [];
  if (typeof barElements === 'undefined' || !barElements) return;
  // Build a (barIdx, beat) → chordEventIndex lookup once, so we can
  // tag each note in the sequence with the chord event it belongs to.
  // That lets the chord-preview feature in gameHandleKeyPress fire
  // exactly when the sequence crosses from one chord to the next.
  const beatsPerBar = (typeof lastBarsPerBar === 'number' && lastBarsPerBar > 0)
    ? lastBarsPerBar : 4;
  const chordEventAtBeat = {};
  if (Array.isArray(lastChordEvents)) {
    lastChordEvents.forEach((ce, ci) => {
      const range = chordBeatRange(ce.chordsInBar, ce.chordIdxInBar, beatsPerBar);
      for (let b = range.startBeat; b < range.endBeat; b++) {
        chordEventAtBeat[ce.barIdx + ':' + b] = ci;
      }
    });
  }
  // First pass: build gameSequence (every pitched note, regardless
  // of beat position). Also map (barIdx:slotIdx) → seqIdx so the
  // beat-map pass below can cross-reference on-beat notes.
  const seqIdxByBarSlot = new Map();
  for (let bi = 0; bi < barElements.length; bi++) {
    const info = barElements[bi];
    if (!info || !info.noteData) continue;
    const stepsPerBar = info.noteData.length || beatsPerBar;
    const stepsPerBeat = Math.max(1, Math.round(stepsPerBar / beatsPerBar));
    for (let si = 0; si < info.noteData.length; si++) {
      const nd = info.noteData[si];
      if (!nd || nd.pitch == null) continue;
      const pc = ((nd.pitch % 12) + 12) % 12;
      const stepStart = (typeof nd.stepStart === 'number') ? nd.stepStart : si;
      const beat = Math.floor(stepStart / stepsPerBeat);
      const ceIdx = chordEventAtBeat[bi + ':' + beat];
      const seqIdx = gameSequence.length;
      gameSequence.push({
        barIdx: bi,
        slotIdx: si,
        pitch: nd.pitch,
        pc,
        chordEventIdx: (ceIdx != null ? ceIdx : -1)
      });
      seqIdxByBarSlot.set(bi + ':' + si, seqIdx);
    }
  }
  // Second pass: build gameBeatMap with ONE entry per beat in the
  // song. Each entry records whether that beat has a landmark (a
  // pitched note at the beat's first step) or is a rest beat. Used
  // by Follow mode to pace the cursor through the score one beat
  // at a time — so a Landmarks exercise (notes on beats 1+3, rests
  // on 2+4) lets the user play landmark notes on the strong beats
  // AND drop free "fill" notes on the rest beats without either
  // input being mis-attributed to the other.
  for (let bi = 0; bi < barElements.length; bi++) {
    const info = barElements[bi];
    const hasInfo = !!(info && info.noteData);
    const stepsPerBar = hasInfo
      ? ((info.beatToNoteSlot && info.beatToNoteSlot.length) || info.noteData.length || beatsPerBar)
      : beatsPerBar;
    const stepsPerBeat = Math.max(1, Math.round(stepsPerBar / beatsPerBar));
    for (let beatInBar = 0; beatInBar < beatsPerBar; beatInBar++) {
      const stepStart = beatInBar * stepsPerBeat;
      // Slot index in noteData for this beat's first step. Use
      // beatToNoteSlot (the step → slot lookup the renderer built)
      // when available; fall back to stepStart for simple
      // quarter-note grids.
      let slotIdx = -1;
      if (hasInfo && info.beatToNoteSlot && info.beatToNoteSlot[stepStart] != null
          && info.beatToNoteSlot[stepStart] >= 0) {
        slotIdx = info.beatToNoteSlot[stepStart];
      } else if (hasInfo && stepStart < info.noteData.length) {
        slotIdx = stepStart;
      }
      const seqIdxLookup = (slotIdx >= 0)
        ? seqIdxByBarSlot.get(bi + ':' + slotIdx)
        : undefined;
      const ceIdx = chordEventAtBeat[bi + ':' + beatInBar];
      gameBeatMap.push({
        barIdx: bi,
        beatInBar,
        slotIdx,
        seqIdx: (seqIdxLookup != null ? seqIdxLookup : -1),
        chordEventIdx: (ceIdx != null ? ceIdx : -1)
      });
    }
  }
}

// Apply visibility + color-mark classes for the current game state.
// Color rules:
//   - In Hidden mode, the "green" set is implicit: every note at an
//     index < gameCursor is a note the player has either been given
//     for free (index 0) or played correctly (each correct play
//     bumps the cursor). Compute that set here on every repaint;
//     gameGreenNotes is tracked explicitly in Follow mode instead.
//   - Red notes always win over green (if a key somehow ends up in
//     both sets, paint it red — wrong inputs are louder feedback).
//   - Visibility (`game-hidden`) only applies in Hidden mode.
function gameApplyVisibility() {
  if (typeof barElements === 'undefined' || !barElements) return;
  // Clear-all when game mode is off.
  if (!gameMode) {
    for (let bi = 0; bi < barElements.length; bi++) {
      const info = barElements[bi];
      if (!info || !info.noteEls) continue;
      for (const el of info.noteEls) {
        if (el && el.classList) {
          el.classList.remove('game-hidden');
          el.classList.remove('game-wrong-note');
          el.classList.remove('game-correct-note');
        }
      }
    }
    return;
  }
  // Compute the active green set per-mode.
  const greenKeys = new Set();
  if (gameKind === 'follow') {
    for (const k of gameGreenNotes) greenKeys.add(k);
  } else {
    for (let i = 0; i < gameCursor && i < gameSequence.length; i++) {
      const e = gameSequence[i];
      greenKeys.add(e.barIdx + ':' + e.slotIdx);
    }
  }
  for (let bi = 0; bi < barElements.length; bi++) {
    const info = barElements[bi];
    if (!info || !info.noteEls || !info.noteData) continue;
    for (let si = 0; si < info.noteEls.length; si++) {
      const el = info.noteEls[si];
      if (!el || !el.classList) continue;
      const key = bi + ':' + si;
      const nd = info.noteData[si];
      const isPitched = !!(nd && nd.pitch != null);
      // ---- Visibility ----
      if (gameKind === 'hidden' && isPitched && !greenKeys.has(key)) {
        el.classList.add('game-hidden');
      } else {
        el.classList.remove('game-hidden');
      }
      // ---- Color ----
      const isRed   = gameRedNotes.has(key);
      const isGreen = greenKeys.has(key);
      if (isRed) {
        el.classList.add('game-wrong-note');
        el.classList.remove('game-correct-note');
      } else if (isGreen) {
        el.classList.add('game-correct-note');
        el.classList.remove('game-wrong-note');
      } else {
        el.classList.remove('game-wrong-note');
        el.classList.remove('game-correct-note');
      }
    }
  }
}

// Paint a semi-transparent red rect over every bar that contains
// at least one wrong note. Called when Follow mode finishes the
// last note in the sequence.
function gameMarkWrongBars() {
  gameClearWrongBars();
  if (typeof barElements === 'undefined' || !barElements) return;
  const NS = 'http://www.w3.org/2000/svg';
  const wrongBars = new Set();
  for (const key of gameRedNotes) {
    const bi = parseInt(key.split(':')[0], 10);
    if (isFinite(bi)) wrongBars.add(bi);
  }
  for (const bi of wrongBars) {
    const info = barElements[bi];
    if (!info || !info.rowEl) continue;
    const svg = info.rowEl.querySelector('svg');
    if (!svg) continue;
    const rect = document.createElementNS(NS, 'rect');
    rect.setAttribute('class', 'game-wrong-bar-overlay');
    rect.setAttribute('x', info.x);
    rect.setAttribute('y', info.y - 4);
    rect.setAttribute('width', info.w);
    rect.setAttribute('height', info.h);
    rect.setAttribute('fill', 'rgba(201, 42, 42, 0.18)');
    rect.setAttribute('pointer-events', 'none');
    svg.appendChild(rect);
  }
}

function gameClearWrongBars() {
  document.querySelectorAll('.game-wrong-bar-overlay').forEach(el => el.remove());
}

// Reset all game state to the start of the current song (cursor at
// the first hidden note; counters back to zero).
function gameReset() {
  // Hidden mode reveals the first note for free, so the cursor
  // starts at 1. Follow mode requires every note to be played in
  // time with the metronome — cursor starts at -1 so the FIRST
  // metronome tick advances it to 0 (the user's first expected
  // note), instead of immediately consuming note 0 before they've
  // had a chance to play it.
  gameCursor = (gameKind === 'follow') ? -1 : 1;
  gameCurrentBeat = -1; // pre-start; first metronome tick advances to 0
  gameCorrect = 0;
  gameMistakes = 0;
  gameFollowFinished = false;
  gameRedNotes.clear();
  gameGreenNotes.clear();
  gamePlayedNotes.clear();
  gameFilledRests.clear();
  // Mark the first pitched note green as a "you start here"
  // landmark. In Hidden mode the green for the freebie comes out
  // of the cursor-based green-set rebuild in gameApplyVisibility,
  // so we don't need to seed gameGreenNotes there; in Follow mode
  // we DO seed it explicitly because Follow mode's green set is
  // tracked, not derived.
  if (gameKind === 'follow' && gameSequence.length > 0) {
    const first = gameSequence[0];
    gameGreenNotes.add(first.barIdx + ':' + first.slotIdx);
  }
  gameClearWrongFlash();
  gameClearWrongBars();
  gameClearFillNotes();
  gameUpdateCounters();
  gameApplyVisibility();
}

// Remove every fill-note DOM element from the chart AND restore
// any rest glyphs that were hidden to make room for them. Called
// on game reset so the next play-through starts with a clean
// staff.
function gameClearFillNotes() {
  for (const el of gameFillNoteEls) {
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }
  gameFillNoteEls = [];
  document.querySelectorAll('.vf-stavenote.game-rest-filled').forEach(el => {
    el.classList.remove('game-rest-filled');
    if (el.style) el.style.visibility = '';
  });
}

// Reference pitch the fill-note placer uses to pick an octave for
// the user's pressed PC. Walks BACKWARD from the current cursor
// to find the most recently-encountered landmark — that's the
// pitch the line would currently sit on. Falls forward if no
// previous landmark exists yet (e.g., the user plays a fill before
// any landmark has fired), so the very first fill still lands in
// a sensible register.
function gameGetReferencePitchForFill() {
  for (let i = gameCursor - 1; i >= 0; i--) {
    if (gameSequence[i] && gameSequence[i].pitch != null) return gameSequence[i].pitch;
  }
  for (let i = 0; i < gameSequence.length; i++) {
    if (gameSequence[i] && gameSequence[i].pitch != null) return gameSequence[i].pitch;
  }
  return 41; // F2 — cello midrange fallback
}

// Render a "fill" notehead at the rest at barIdx + restSlot, at
// the staff position for the user's played pitch. When micMidi is
// provided (mic-driven input), uses that ACTUAL detected octave;
// otherwise (keyboard input) picks the octave closest to the
// surrounding landmarks. Returns the MIDI pitch placed (so the
// caller can play it through the lead sampler when the input came
// from the on-screen keyboard), or null if rendering failed.
function gamePlaceFillNote(barIdx, restSlot, pressedPc, micMidi) {
  if (typeof barElements === 'undefined' || !barElements) return null;
  const info = barElements[barIdx];
  if (!info || !info.noteEls) return null;
  const restEl = info.noteEls[restSlot];
  if (!restEl) return null;
  const svg = restEl.ownerSVGElement;
  if (!svg) return null;

  // MIDI pitch resolution:
  //   - micMidi given → use the user's ACTUAL detected octave.
  //   - otherwise → guess via closest-octave to a surrounding
  //     landmark (on-screen keyboard inputs don't carry octave).
  let pressedMidi;
  if (micMidi != null && isFinite(micMidi)) {
    pressedMidi = micMidi;
  } else {
    const refMidi = gameGetReferencePitchForFill();
    pressedMidi = gamePitchInClosestOctave(refMidi, pressedPc);
  }

  // X position: center of the rest's bounding box, converted from
  // screen space to the SVG's viewBox coords.
  const rect = restEl.getBoundingClientRect();
  if (!rect || rect.width <= 0) return null;
  const svgRect = svg.getBoundingClientRect();
  const vb = svg.viewBox && svg.viewBox.baseVal;
  const vbOK = vb && vb.width > 0 && vb.height > 0;
  const vbSX = vbOK ? vb.width  / svgRect.width  : 1;
  const vbOX = vbOK ? vb.x : 0;
  const cx = (rect.left + rect.width / 2 - svgRect.left) * vbSX + vbOX;

  // Y position: compute the written staff position for this pitch
  // (8vb bass clef means written = sounding + 1 octave) and
  // convert to SVG y using the bar's staffY. VexFlow's default
  // bass clef puts the BOTTOM line at staffY + 40, top line at
  // staffY, with 5px between consecutive staff positions.
  const LETTER_IDX = { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 };
  const letter = GAME_PC_LETTER[pressedPc] || 'C';
  const writtenOctave = Math.floor(pressedMidi / 12); // sounding octave + 1 for 8vb
  // Bottom line of bass clef = G2 written = letter index 4, octave 2 → step 18.
  const staffStep = (LETTER_IDX[letter] || 0) + writtenOctave * 7 - 18;
  const staffY = (typeof info.y === 'number') ? info.y : 36;
  const cy = staffY + 40 - 5 * staffStep;

  // Borrow geometry + glyph from the FIRST landmark notehead we
  // can find in this bar. Cloning the landmark's actual
  // `<g class="vf-notehead">` (VexFlow's Bravura glyph as an SVG
  // path) into a translating wrapper gives us a PIXEL-PERFECT
  // size + shape match with the staff's other noteheads. Falls
  // back to a drawn ellipse only when no clonable landmark is
  // available (rare — Landmarks always has 2 landmarks per bar).
  let refNoteheadEl = null;
  let refX = null, refY = null;
  let noteheadW = 11;
  let stemLen = 32;
  if (info.noteData) {
    for (let i = 0; i < info.noteData.length; i++) {
      const nd = info.noteData[i];
      if (!nd || !nd.staveNote) continue;
      try {
        const w = nd.staveNote.getGlyphWidth && nd.staveNote.getGlyphWidth();
        if (w && w > 0) noteheadW = w;
        const absX = nd.staveNote.getAbsoluteX();
        const ys = nd.staveNote.getYs && nd.staveNote.getYs();
        if (isFinite(absX) && ys && ys.length) {
          refX = absX + noteheadW / 2;
          refY = ys[0];
        }
      } catch (e) { /* ignore */ }
      const el = info.noteEls[i];
      if (el) {
        const nh = el.querySelector('.vf-notehead');
        if (nh && refX != null && refY != null) {
          refNoteheadEl = nh;
          break;
        }
      }
    }
  }

  // Build the fill group: notehead (cloned VexFlow glyph if
  // possible, otherwise a tilted ellipse fallback) + stem +
  // optional sharp glyph. Standard black so it reads as a normal
  // note (no special "feedback" color).
  const NS = 'http://www.w3.org/2000/svg';
  const COLOR = '#000';
  const g = document.createElementNS(NS, 'g');
  g.setAttribute('class', 'game-fill-note');
  g.setAttribute('pointer-events', 'none');

  // The bounding-X for the stem placement. Differs depending on
  // whether we cloned a glyph (use the glyph's intrinsic half-
  // width) or drew an ellipse (use rx).
  let stemRx = noteheadW / 2;

  // Ledger lines: draw the horizontal short lines that anchor any
  // notehead landing outside the 5-staff-line range. VexFlow does
  // this automatically for real staveNotes; we have to do it
  // manually for the custom-drawn fill. Without them, a high or
  // low fill floats with no visual reference and the octave is
  // unreadable.
  //
  // Bottom line G2(written) sits at staffY + 40. The first ledger
  // below is at staffY + 50 (E2), the next at +60 (C2), etc. Top
  // line A3(written) sits at staffY. First ledger above is at
  // staffY - 10 (C4), next at -20 (E4), etc. Each ledger is one
  // diatonic step (5px) past the previous space, i.e. ledger Y
  // values are at the 10-multiple boundaries past the staff edge.
  const ledgerHalfLen = Math.max(7, noteheadW / 2 + 2);
  let topMostDrawY = cy; // tracked to extend the viewBox if needed
  for (let y = staffY + 50; y <= cy + 0.5; y += 10) {
    const ll = document.createElementNS(NS, 'line');
    ll.setAttribute('x1', cx - ledgerHalfLen);
    ll.setAttribute('y1', y);
    ll.setAttribute('x2', cx + ledgerHalfLen);
    ll.setAttribute('y2', y);
    ll.setAttribute('stroke', COLOR);
    ll.setAttribute('stroke-width', '1.5');
    g.appendChild(ll);
  }
  for (let y = staffY - 10; y >= cy - 0.5; y -= 10) {
    const ll = document.createElementNS(NS, 'line');
    ll.setAttribute('x1', cx - ledgerHalfLen);
    ll.setAttribute('y1', y);
    ll.setAttribute('x2', cx + ledgerHalfLen);
    ll.setAttribute('y2', y);
    ll.setAttribute('stroke', COLOR);
    ll.setAttribute('stroke-width', '1.5');
    g.appendChild(ll);
    if (y < topMostDrawY) topMostDrawY = y;
  }

  // Extend the SVG viewBox upward if our fill (with its stem +
  // ledger lines) lands above the current viewable area. VexFlow's
  // renderChart only auto-shifts the viewBox for the landmark
  // notes it knows about — custom fills land outside that math, so
  // a high pizz fill can paint its notehead at the top of the SVG
  // with ledger lines technically AT the right y-coordinate but
  // clipped by the viewBox boundary.
  try {
    const vb = svg.viewBox && svg.viewBox.baseVal;
    if (vb && isFinite(vb.y) && isFinite(vb.height)) {
      // Estimate the topmost pixel the fill paints: ledger lines
      // extend up to topMostDrawY; the stem goes from the notehead
      // up to cy - stemLen when stem-up; the sharp glyph sits
      // around the notehead. Take the most extreme.
      const fillTop = Math.min(
        topMostDrawY - 2,             // ledger lines (small margin)
        cy - stemLen - 2,             // stem-up endpoint
        cy - (noteheadW * 0.36) - 2   // notehead top
      );
      if (fillTop < vb.y) {
        const extend = vb.y - fillTop;
        const newY = fillTop;
        const newH = vb.height + extend;
        svg.setAttribute('viewBox',
          vb.x + ' ' + newY + ' ' + vb.width + ' ' + newH);
      }
    }
  } catch (e) { /* viewBox API quirky in some browsers — best-effort */ }

  if (refNoteheadEl) {
    // Clone the landmark's notehead glyph. The clone keeps its
    // original (absolute) coordinates baked in; wrap it in a
    // translating <g> so the entire glyph shifts to (cx, cy)
    // without disturbing its internal transforms.
    const wrapper = document.createElementNS(NS, 'g');
    const dx = cx - refX;
    const dy = cy - refY;
    wrapper.setAttribute('transform', 'translate(' + dx + ',' + dy + ')');
    const clone = refNoteheadEl.cloneNode(true);
    // Clear any inline visibility:hidden that may have been
    // copied from the source (shouldn't normally happen for a
    // landmark, but defensive).
    clone.style.visibility = '';
    wrapper.appendChild(clone);
    g.appendChild(wrapper);
  } else {
    // Fallback: drawn ellipse approximating a notehead.
    const rx = Math.max(4.5, noteheadW / 2);
    const ry = Math.max(4,   noteheadW * 0.36); // ~7/11 aspect
    stemRx = rx;
    const ellipse = document.createElementNS(NS, 'ellipse');
    ellipse.setAttribute('cx', cx);
    ellipse.setAttribute('cy', cy);
    ellipse.setAttribute('rx', rx);
    ellipse.setAttribute('ry', ry);
    ellipse.setAttribute('transform', 'rotate(-20 ' + cx + ' ' + cy + ')');
    ellipse.setAttribute('fill', COLOR);
    g.appendChild(ellipse);
  }

  // Stem direction: down when notehead is above the middle staff
  // line, up when below — matches VexFlow's default.
  const staffMidY = staffY + 20;
  const stemDown = cy < staffMidY;
  const stem = document.createElementNS(NS, 'line');
  if (stemDown) {
    stem.setAttribute('x1', cx - stemRx + 0.5);
    stem.setAttribute('y1', cy);
    stem.setAttribute('x2', cx - stemRx + 0.5);
    stem.setAttribute('y2', cy + stemLen);
  } else {
    stem.setAttribute('x1', cx + stemRx - 0.5);
    stem.setAttribute('y1', cy);
    stem.setAttribute('x2', cx + stemRx - 0.5);
    stem.setAttribute('y2', cy - stemLen);
  }
  stem.setAttribute('stroke', COLOR);
  stem.setAttribute('stroke-width', '1.5');
  g.appendChild(stem);

  if (GAME_PC_IS_SHARP[pressedPc]) {
    const sharp = document.createElementNS(NS, 'text');
    sharp.setAttribute('x', cx - stemRx - 8);
    sharp.setAttribute('y', cy + 5);
    sharp.setAttribute('font-family', 'serif');
    sharp.setAttribute('font-size', '18');
    sharp.setAttribute('font-weight', 'bold');
    sharp.setAttribute('fill', COLOR);
    sharp.textContent = '♯';
    g.appendChild(sharp);
  }

  svg.appendChild(g);
  gameFillNoteEls.push(g);
  // Hide the rest glyph so the user sees only the fill notehead
  // in that slot. Apply both a class AND an inline style — the
  // class is the documented mechanism but the inline style is
  // defensive in case the rest's outer <g> has a class that
  // doesn't include `vf-stavenote` in some VexFlow build.
  // visibility:hidden keeps the slot's layout box in place
  // (barlines / downstream notes don't shift).
  restEl.classList.add('game-rest-filled');
  restEl.style.visibility = 'hidden';
  return pressedMidi;
}

function gameUpdateCounters() {
  const c = document.getElementById('gameCorrectCount');
  const m = document.getElementById('gameMistakeCount');
  if (c) c.textContent = String(gameCorrect);
  if (m) m.textContent = String(gameMistakes);
}

function gameClearWrongFlash() {
  if (gameWrongTimer) {
    clearTimeout(gameWrongTimer);
    gameWrongTimer = null;
  }
  if (gameWrongEl) {
    if (gameWrongEl.parentNode) gameWrongEl.parentNode.removeChild(gameWrongEl);
    gameWrongEl = null;
  }
}

// Closest MIDI pitch with a given PC to a reference pitch. Used to
// pick the OCTAVE of the user's pressed key — we want the red wrong
// note to sit in the same register as the expected note, not in some
// far-off octave that would force a leger-line forest.
function gamePitchInClosestOctave(refMidi, pc) {
  const refPc = ((refMidi % 12) + 12) % 12;
  let delta = (pc - refPc + 6 + 12) % 12 - 6; // signed distance in [-6, +5]
  if (delta < -6) delta += 12;
  return refMidi + delta;
}

// Diatonic staff-step for the EXPECTED note: use its actual TPC
// (which encodes the sharp/flat spelling chosen by the chart) so
// the step lands on the correct staff line. Eb is step (E line),
// Db is step (D line), etc. — NOT collapsed to the chromatically
// adjacent natural.
const GAME_LETTER_IDX = { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 };
function gameExpectedStaffStep(midi, tpc) {
  if (tpc == null) return gamePressedStaffStep(((midi % 12) + 12) % 12, midi);
  const { letter, acc } = tpcToLetterAcc(tpc);
  const altAdjust = { 'bb': -2, 'b': -1, '': 0, '#': 1, '##': 2 }[acc] || 0;
  // letterRef = sounding MIDI of the natural letter this tpc spells.
  // For Db4 (MIDI 61, acc 'b'): letterRef = 62 (D4 natural). For C#4
  // (MIDI 61, acc '#'): letterRef = 60 (C4 natural). The displayed
  // octave then comes from letterRef's natural-octave bucket.
  const letterRef = midi - altAdjust;
  const octave = Math.floor(letterRef / 12) - 1;
  return octave * 7 + (GAME_LETTER_IDX[letter] || 0);
}

// Diatonic staff-step for the PRESSED note, using sharp-form
// natural-letter spelling for sharp PCs (C#, D#, F#, G#, A#).
// Sharps share the same staff line as the natural letter below
// (C# and C both sit on the C line; the # accidental does the
// disambiguation).
const GAME_PC_LETTER = ['C','C','D','D','E','F','F','G','G','A','A','B'];
const GAME_PC_IS_SHARP = [false,true,false,true,false,false,true,false,true,false,true,false];
function gamePressedStaffStep(pc, midi) {
  const letter = GAME_PC_LETTER[pc];
  const isSharp = GAME_PC_IS_SHARP[pc];
  const altAdjust = isSharp ? 1 : 0;
  const letterRef = midi - altAdjust;
  const octave = Math.floor(letterRef / 12) - 1;
  return octave * 7 + (GAME_LETTER_IDX[letter] || 0);
}

// Show a red "you pressed THIS" notehead at the position of the
// next-expected slot but at the staff line of the user's PRESSED
// pitch. Crucially: it does NOT clone the expected note (which
// would give away the answer). The notehead is drawn from scratch
// with the right accidental for the pressed PC. Removed after
// `WRONG_FLASH_MS`.
const GAME_WRONG_FLASH_MS = 1000;
const GAME_WRONG_COLOR = '#c92a2a';
function gameShowWrongFlash(pressedPc) {
  gameClearWrongFlash();
  if (gameCursor >= gameSequence.length) return;
  const expected = gameSequence[gameCursor];
  const info = barElements[expected.barIdx];
  if (!info || !info.noteData || !info.noteEls) return;
  const nd = info.noteData[expected.slotIdx];
  if (!nd || !nd.staveNote) return;
  const expectedEl = info.noteEls[expected.slotIdx];
  if (!expectedEl) return;
  const svg = expectedEl.ownerSVGElement;
  if (!svg) return;

  // Pull the expected slot's notehead geometry from VexFlow — same
  // calls the existing notes-overlay uses.
  let absX, ys, noteheadW;
  try {
    absX = nd.staveNote.getAbsoluteX();
    ys = nd.staveNote.getYs();
    noteheadW = (nd.staveNote.getGlyphWidth && nd.staveNote.getGlyphWidth()) || 11;
  } catch (e) { return; }
  if (!isFinite(absX) || !ys || ys.length === 0) return;

  const expectedCX = absX + noteheadW / 2;
  const expectedCY = ys[0];

  // Vertical offset: (expectedStep − pressedStep) * 5 px/step.
  // Higher diatonic step = visually higher on staff = lower SVG y;
  // so a pressed pitch one step HIGHER than expected gets a dy of −5.
  const expectedStep = gameExpectedStaffStep(nd.pitch, nd.tpc);
  const pressedMidi  = gamePitchInClosestOctave(nd.pitch, pressedPc);
  const pressedStep  = gamePressedStaffStep(pressedPc, pressedMidi);
  const STEP_PX = 5;
  const newCY = expectedCY + (expectedStep - pressedStep) * STEP_PX;

  // Draw a fresh red quarter-note glyph from scratch:
  //   - tilted notehead ellipse (the standard VexFlow notehead slant)
  //   - stem line (direction chosen so the stem points away from the
  //     middle line — VexFlow's default policy)
  //   - sharp glyph to the left of the notehead, if the pressed PC
  //     is a sharp
  const NS = 'http://www.w3.org/2000/svg';
  const g = document.createElementNS(NS, 'g');
  g.setAttribute('class', 'game-wrong-flash');
  g.setAttribute('pointer-events', 'none');

  const rx = Math.max(4, noteheadW / 2 - 0.5);
  const ry = 4;
  const ellipse = document.createElementNS(NS, 'ellipse');
  ellipse.setAttribute('cx', expectedCX);
  ellipse.setAttribute('cy', newCY);
  ellipse.setAttribute('rx', rx);
  ellipse.setAttribute('ry', ry);
  ellipse.setAttribute('transform', 'rotate(-20 ' + expectedCX + ' ' + newCY + ')');
  ellipse.setAttribute('fill', GAME_WRONG_COLOR);
  g.appendChild(ellipse);

  // Stem direction: stem-down when the notehead sits above the
  // middle staff line, stem-up below. Approximate using the
  // expected note's staffY (the staff middle line lives at
  // roughly staffY + 20 for a standard 5-line staff). Fall back
  // to the expected note's existing stem direction if accessible.
  const staffMidY = (info.y || 0) + 20;
  const stemDown = newCY < staffMidY;
  const stem = document.createElementNS(NS, 'line');
  if (stemDown) {
    stem.setAttribute('x1', expectedCX - rx + 0.5);
    stem.setAttribute('y1', newCY);
    stem.setAttribute('x2', expectedCX - rx + 0.5);
    stem.setAttribute('y2', newCY + 28);
  } else {
    stem.setAttribute('x1', expectedCX + rx - 0.5);
    stem.setAttribute('y1', newCY);
    stem.setAttribute('x2', expectedCX + rx - 0.5);
    stem.setAttribute('y2', newCY - 28);
  }
  stem.setAttribute('stroke', GAME_WRONG_COLOR);
  stem.setAttribute('stroke-width', '1.5');
  g.appendChild(stem);

  if (GAME_PC_IS_SHARP[pressedPc]) {
    const sharp = document.createElementNS(NS, 'text');
    sharp.setAttribute('x', expectedCX - rx - 8);
    sharp.setAttribute('y', newCY + 5);
    sharp.setAttribute('font-family', 'serif');
    sharp.setAttribute('font-size', '18');
    sharp.setAttribute('font-weight', 'bold');
    sharp.setAttribute('fill', GAME_WRONG_COLOR);
    sharp.textContent = '♯';
    g.appendChild(sharp);
  }

  svg.appendChild(g);
  gameWrongEl = g;
  gameWrongTimer = setTimeout(() => {
    gameClearWrongFlash();
  }, GAME_WRONG_FLASH_MS);
}

// Play a pitch through the Lead (guitar) sampler. Mirrors the
// midiToName + +12 convention used elsewhere for bass-clef 8vb.
function gamePlayNote(midi) {
  if (typeof guitar === 'undefined' || !guitar || !guitar.loaded) return;
  try {
    const name = midiToName(midi + 12);
    guitar.triggerAttackRelease(name, '8n', undefined, 0.7);
  } catch (e) { /* best-effort preview */ }
}

// Handle a keyboard key press (pc = 0..11). Compares against the
// next-expected note's pitch-class; reveals + plays on match,
// flashes red on miss.
//
// micMidi is the actual detected MIDI value when the call comes
// from the mic path (which can resolve the OCTAVE, not just PC).
// On a rest beat in Follow mode, the fill-note placer uses this
// to draw the note in the user's ACTUAL octave instead of
// guessing one from surrounding landmarks. Undefined when the
// input came from the on-screen keyboard (which has no octave).
function gameHandleKeyPress(pc, playLead, micMidi) {
  // playLead controls whether a CORRECT note triggers the guitar
  // sampler. Defaults to true. The mic-driven path passes false:
  // the user just produced the audio themselves, so adding a
  // guitar layer would be redundant (and risks the guitar feeding
  // back into the mic detector).
  if (playLead === undefined) playLead = true;
  if (!gameMode) return;
  if (gameFollowFinished) return;

  // ----- Follow mode -----
  // Drives off gameCurrentBeat (the metronome's beat cursor), so
  // landmark beats and rest beats are handled independently. On a
  // landmark beat the input is checked against the landmark; on a
  // rest beat the input gets dropped onto the staff as a free
  // "fill" note in green at the rest's position.
  if (gameKind === 'follow') {
    if (gameCurrentBeat < 0 || gameCurrentBeat >= gameBeatMap.length) return;
    const beatInfo = gameBeatMap[gameCurrentBeat];
    if (!beatInfo) return;

    // Landmark beat — compare against the expected pitch class.
    if (beatInfo.seqIdx >= 0) {
      const expected = gameSequence[beatInfo.seqIdx];
      if (!expected) return;
      // Visual key-press feedback on the keyboard cell.
      const cell = document.querySelector('.game-key[data-pc="' + pc + '"]');
      if (cell) {
        cell.classList.add(expected.pc === pc ? 'flash-correct' : 'flash-wrong');
        setTimeout(() => {
          if (cell) cell.classList.remove('flash-correct', 'flash-wrong');
        }, 220);
      }
      const key = expected.barIdx + ':' + expected.slotIdx;
      // First attempt wins. Once a note has been played (correctly
      // or not) in this beat, ignore subsequent presses.
      if (gamePlayedNotes.has(key)) return;
      gamePlayedNotes.add(key);
      if (expected.pc === pc) {
        gameCorrect++;
        gameGreenNotes.add(key);
        gameApplyVisibility();
        if (playLead) gamePlayNote(expected.pitch);
        gameClearWrongFlash();
      } else {
        gameMistakes++;
        gameRedNotes.add(key);
        gameApplyVisibility();
        gameShowWrongFlash(pc);
      }
      gameUpdateCounters();
      return;
    }

    // Rest beat — place a green "fill" notehead at the rest's
    // position. No correct/mistake score change for fills (the
    // user is improvising; we just paint what they played so they
    // can see their line shape).
    if (beatInfo.slotIdx < 0) return; // nowhere to place the fill
    const cell2 = document.querySelector('.game-key[data-pc="' + pc + '"]');
    if (cell2) {
      cell2.classList.add('flash-correct');
      setTimeout(() => { if (cell2) cell2.classList.remove('flash-correct'); }, 220);
    }
    const fillKey = beatInfo.barIdx + ':' + beatInfo.slotIdx;
    if (gameFilledRests.has(fillKey)) return;
    gameFilledRests.add(fillKey);
    const placedMidi = gamePlaceFillNote(beatInfo.barIdx, beatInfo.slotIdx, pc, micMidi);
    if (playLead && placedMidi != null) gamePlayNote(placedMidi);
    return;
  }

  // ----- Hidden mode (original behavior) -----
  // Cursor < 0: pre-start. Cursor >= length: game complete.
  if (gameCursor < 0 || gameCursor >= gameSequence.length) return;
  const expected = gameSequence[gameCursor];
  // Visual key-press feedback on the keyboard cell.
  const cell = document.querySelector('.game-key[data-pc="' + pc + '"]');
  if (cell) {
    cell.classList.add(expected.pc === pc ? 'flash-correct' : 'flash-wrong');
    setTimeout(() => {
      if (cell) cell.classList.remove('flash-correct', 'flash-wrong');
    }, 220);
  }
  if (expected.pc === pc) {
    gameCorrect++;
    gameCursor++;
    gameApplyVisibility();
    if (playLead) gamePlayNote(expected.pitch);
    gameClearWrongFlash();
    // Chord confirmation: if the note we just accepted was the LAST
    // one of its chord (the next pending note belongs to a different
    // chord event, OR the song just ended), play THAT chord — the
    // one we just finished — as audible confirmation.
    const nextEntry = gameSequence[gameCursor];
    const justCompletedChord = !nextEntry
                            || nextEntry.chordEventIdx !== expected.chordEventIdx;
    if (justCompletedChord) {
      gamePlayNextChord(expected.chordEventIdx);
      if (nextEntry && Array.isArray(lastChordEvents)) {
        const upcomingBar = lastChordEvents[nextEntry.chordEventIdx]
          ? lastChordEvents[nextEntry.chordEventIdx].barIdx : -1;
        if (upcomingBar >= 0) gameScrollToBar(upcomingBar);
      }
    }
  } else {
    gameMistakes++;
    gameShowWrongFlash(pc);
    // Punish a wrong note by REWINDING to the start of the current
    // chord. The very first note of the song is exempt — it's
    // always given for free (gameCursor starts at 1), so we floor
    // the rewind target at 1.
    if (expected.chordEventIdx >= 0) {
      let chordStart = -1;
      for (let i = 0; i < gameSequence.length; i++) {
        if (gameSequence[i].chordEventIdx === expected.chordEventIdx) {
          chordStart = i;
          break;
        }
      }
      if (chordStart >= 0) {
        if (chordStart < 1) chordStart = 1;
        if (chordStart < gameCursor) {
          gameCursor = chordStart;
          gameApplyVisibility();
        }
      }
    }
  }
  gameUpdateCounters();
}

// Follow-mode tick: called by gameMetronomeTick on each beat.
// Advances one BEAT (not one landmark) so exercises with rests on
// some beats (Landmarks: notes on 1+3, rests on 2+4) let the user
// play landmark notes on the strong beats AND drop free fill
// notes on rest beats. Evaluates the beat that just ended: if it
// was a landmark beat and the user didn't play the landmark, it
// counts as a miss. Rest beats are not evaluated.
function gameFollowAdvance() {
  if (!gameMode || gameKind !== 'follow' || gameFollowFinished) return;
  // Evaluate the beat that just ended (gameCurrentBeat). Only
  // landmark beats need evaluation — for rest beats the user can
  // play anything (or nothing) without penalty.
  if (gameCurrentBeat >= 0 && gameCurrentBeat < gameBeatMap.length) {
    const beatInfo = gameBeatMap[gameCurrentBeat];
    if (beatInfo && beatInfo.seqIdx >= 0) {
      const entry = gameSequence[beatInfo.seqIdx];
      if (entry) {
        const key = entry.barIdx + ':' + entry.slotIdx;
        if (!gamePlayedNotes.has(key)) {
          gameMistakes++;
          gameUpdateCounters();
        }
        // Sync gameCursor so any code still reading it stays
        // consistent with the beat-driven cursor.
        gameCursor = beatInfo.seqIdx + 1;
      }
    }
  }
  gameCurrentBeat++;
  if (gameCurrentBeat >= gameBeatMap.length) {
    // Walked past the last beat — finalize.
    gameFollowFinished = true;
    if (typeof gameMetronomeStop === 'function') gameMetronomeStop();
    gameMarkWrongBars();
    return;
  }
  const next = gameBeatMap[gameCurrentBeat];
  if (next) gameScrollToBar(next.barIdx);
  // Chord stab — fire when we're advancing onto the FIRST beat of
  // a new chord (either the very first beat of the song or the
  // chord event index differs from the previous beat's). One
  // octave up and 200ms mic-duck (see gamePlayChordStab).
  const prevBeat = gameCurrentBeat > 0 ? gameBeatMap[gameCurrentBeat - 1] : null;
  if (next && next.chordEventIdx >= 0
      && (!prevBeat || prevBeat.chordEventIdx !== next.chordEventIdx)) {
    gamePlayChordStab(next.chordEventIdx, 1, 200);
  }
}

// Scroll the chart container so the row containing `barIdx` is
// brought into view. Used by the chord-preview path so a chord
// change that lands on a new line of the score also pulls the
// view down to that line. Skips scrolling when the target row is
// already comfortably inside the viewport so we don't twitch the
// view on every chord change within the same row.
function gameScrollToBar(barIdx) {
  if (typeof barElements === 'undefined' || !barElements) return;
  const info = barElements[barIdx];
  if (!info || !info.rowEl) return;
  const chartEl = document.getElementById('chart');
  if (!chartEl) return;
  const rowRect   = info.rowEl.getBoundingClientRect();
  const chartRect = chartEl.getBoundingClientRect();
  const rowTop    = rowRect.top - chartRect.top + chartEl.scrollTop;
  const rowBot    = rowTop + rowRect.height;
  const viewTop   = chartEl.scrollTop;
  const viewBot   = viewTop + chartEl.clientHeight;
  // Already fully on-screen — do nothing.
  if (rowTop >= viewTop + 4 && rowBot <= viewBot - 4) return;
  // Same TOP_BUFFER value as the playback page-flip logic — clears
  // chord labels and gives the row some headroom from the top of
  // the chart container.
  const TOP_BUFFER = 56;
  const target = Math.max(0, rowTop - TOP_BUFFER);
  if (Math.abs(target - viewTop) >= 20) {
    chartEl.scrollTo({ top: target, behavior: 'smooth' });
  }
}

// Play the chord at chordEvents[chordEventIdx] through the piano
// sampler, using the same jazzVoicing() the regular playback comp
// uses. No-op if the sampler isn't loaded, the chord-event lookup
// fails, or jazzVoicing returns null (NC / slash chords).
function gamePlayNextChord(chordEventIdx) {
  // Convenience wrapper kept for the Hidden-mode "chord just
  // completed" call site. No octave shift, no mic duck — the
  // chord plays after a note acceptance, so the mic isn't actively
  // racing the stab for the next attack.
  gamePlayChordStab(chordEventIdx, 0, 0);
}

// Play a piano chord stab voiced by jazzVoicing(). Optionally
// shifts every note in the voicing by `octaveOffset` octaves and
// ducks the mic detector for `duckMs` milliseconds — both used by
// the Follow-mode "stab at start of each chord" cue so the chord
// sits above the cello's typical playing range AND so its attack
// transient can't fool the YIN/onset detector into mis-locking on
// the piano's fundamentals.
function gamePlayChordStab(chordEventIdx, octaveOffset, duckMs) {
  if (chordEventIdx < 0) return;
  if (!Array.isArray(lastChordEvents)) return;
  const ce = lastChordEvents[chordEventIdx];
  if (!ce || !ce.chord) return;
  if (typeof piano === 'undefined' || !piano || !piano.loaded) return;
  if (typeof jazzVoicing !== 'function') return;
  let notes;
  try { notes = jazzVoicing(ce.chord); } catch (e) { return; }
  if (!notes || !notes.length) return;
  if (octaveOffset) {
    notes = notes.map(n => n + 12 * octaveOffset);
  }
  try {
    const names = notes.map(midiToName);
    // Quick "stab" — a sharp 16th-note hit. Reads as a punctuation
    // mark, not as a pad sustaining underneath the next melody attempt.
    piano.triggerAttackRelease(names, '16n', undefined, 0.6);
  } catch (e) { /* best-effort cue */ }
  if (duckMs > 0) {
    const nowMs = (typeof performance !== 'undefined' && performance.now)
      ? performance.now() : Date.now();
    gameMic.duckUntil = nowMs + duckMs;
  }
}

// Toggle game mode on/off. Swaps the fingerboard panel for the
// game panel in the bottom section, rebuilds the sequence from the
// current render, resets counters, and reapplies visibility.
function gameSetMode(on) {
  gameMode = !!on;
  const btn = document.getElementById('gameToggle');
  const gamePanel = document.getElementById('gamePanel');
  const fbPanel   = document.getElementById('fingerboardPanel');
  if (btn) btn.setAttribute('aria-pressed', gameMode ? 'true' : 'false');
  if (gameMode) {
    if (gamePanel) gamePanel.removeAttribute('hidden');
    if (fbPanel)   fbPanel.setAttribute('hidden', '');
    gameBuildSequence();
    gameReset();
    // Eagerly kick off audio sample loading. Without this, a fresh
    // page-load → game-mode-on flow leaves the Tone.js samplers
    // uninitialized (piano + guitar). The correct-note guitar cue
    // and especially the chord-transition piano preview both rely
    // on those samplers being ready. initAudio() is idempotent and
    // returns immediately once samples are loaded. Tone.start()
    // inside it requires a user gesture; the toggle click here is
    // exactly that, so Chrome/Safari let it through.
    if (typeof initAudio === 'function') {
      initAudio().catch(() => {});
    }
  } else {
    if (gamePanel) gamePanel.setAttribute('hidden', '');
    // Don't auto-show the fingerboard — leave its visibility to its
    // own toggle button. Just clear any hidden marks on notes.
    gameClearWrongFlash();
    gameApplyVisibility();
    // Stop the mic listener if it was running — it's only meaningful
    // while the game keyboard is visible (no notes to match against
    // outside game mode).
    if (typeof gameMicStop === 'function') gameMicStop();
    // Same reasoning for the metronome — the click is a game-mode
    // pacing tool, not a general practice metronome.
    if (typeof gameMetronomeStop === 'function') gameMetronomeStop();
    // Tear down any fill notes the user placed during the session.
    gameClearFillNotes();
    gameFilledRests.clear();
  }
}

// Bind UI handlers.
(function bindGameControls() {
  const btn = document.getElementById('gameToggle');
  if (btn) {
    btn.addEventListener('click', () => gameSetMode(!gameMode));
  }
  // Game-kind selector — switch between Follow and Hidden.
  // Changing the kind resets the play-through so the previous run's
  // red marks / cursor state don't leak into the new mode.
  const kindSel = document.getElementById('gameKindSelect');
  if (kindSel) {
    gameKind = kindSel.value || 'follow';
    kindSel.addEventListener('change', () => {
      gameKind = kindSel.value || 'follow';
      if (gameMode) {
        // Stop the metronome before reset — Follow mode will
        // re-arm its own metronome state on the next user toggle.
        if (typeof gameMetronomeStop === 'function') gameMetronomeStop();
        gameReset();
      }
    });
  }
  // Two keyboard halves now: left (C..F) and right (G♭..B), with the
  // score column between them. Both bind the same click handler.
  const gamePanel = document.getElementById('gamePanel');
  if (gamePanel) {
    gamePanel.addEventListener('click', (e) => {
      const t = e.target.closest('.game-key');
      if (!t) return;
      const pc = parseInt(t.dataset.pc, 10);
      if (!isFinite(pc)) return;
      gameHandleKeyPress(pc);
    });
  }
  const resetBtn = document.getElementById('gameResetBtn');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      if (!gameMode) return;
      gameBuildSequence();
      gameReset();
    });
  }
  // Keyboard show/hide toggle. Adds/removes the `.kbd-hidden` class
  // on the game panel — the CSS collapses both keyboard halves and
  // centers the score column when that class is present.
  const kbdToggle = document.getElementById('gameKeyboardToggle');
  if (kbdToggle) {
    kbdToggle.addEventListener('click', () => {
      const panel = document.getElementById('gamePanel');
      if (!panel) return;
      const isHidden = panel.classList.toggle('kbd-hidden');
      kbdToggle.setAttribute('aria-pressed', isHidden ? 'false' : 'true');
    });
  }
})();

// Reapply game state after every renderChart — picks up new
// barElements references whenever the chart re-renders (song change,
// exercise change, key change, etc.).
const _gameOriginalRenderChart = renderChart;
renderChart = function gameWrappedRenderChart() {
  const result = _gameOriginalRenderChart.apply(this, arguments);
  if (gameMode) {
    gameBuildSequence();
    // Clamp cursors in case the new sequence is shorter than where
    // we were (e.g. user switched to a shorter song mid-game).
    if (gameCursor > gameSequence.length) gameCursor = gameSequence.length;
    if (gameCursor < 1) gameCursor = 1;
    if (gameCurrentBeat >= gameBeatMap.length) gameCurrentBeat = gameBeatMap.length - 1;
    // Re-render wipes the previous chart's SVG, so any fill-note
    // <g> elements we appended live as detached DOM in the
    // gameFillNoteEls array. Drop the references — the fills also
    // need to be cleared from the in-game state since the new
    // chart has no rests at the same coords. Hitting Reset is a
    // hard restart anyway; this just keeps the render-wrapper
    // path from carrying ghost references forward.
    gameFillNoteEls = [];
    gameFilledRests.clear();
    gameClearWrongFlash();
    gameUpdateCounters();
    gameApplyVisibility();
  }
  return result;
};

// ===== Game mode: microphone pitch detection =====
// Optional second input path for the game. When the user toggles the
// 🎤 button in the game panel, we open the microphone, run a YIN
// pitch detector on the audio stream, and feed detected pitch-classes
// to gameHandleKeyPress — the same function the on-screen keyboard
// uses. So singing the next note or playing it on a cello triggers
// the game logic identically to tapping a key.
//
// Design notes:
//   - YIN: classic monophonic pitch detector (de Cheveigné & Kawahara,
//     2002). Cheap, robust on harmonic instruments, ~50ms latency at
//     2048-sample buffers / 44.1kHz.
//   - Energy gate: we only run YIN when the input RMS is above a
//     threshold (gate out silence + room noise) and we lock out a
//     re-accept until the user lets the energy drop below a lower
//     threshold first. That handles bowed cello sustain (you can't
//     accidentally count one bow stroke as multiple notes) and also
//     "you played a C, took the bow off, played another C" (two
//     attacks ⇒ two acceptances).
//   - PC stability gate: once in a note, we require N consecutive
//     frames to agree on the same pitch class before accepting it.
//     Filters out the brief noisy attack transient and YIN's
//     occasional octave glitches.
//   - getFloatTimeDomainData() reads the most recent audio buffer
//     from an AnalyserNode; polled from requestAnimationFrame for
//     the detection loop. Simpler than wiring up an AudioWorklet
//     and the ~16ms rAF interval is well within the game's latency
//     budget.

// Buffer at 4096 samples (~93ms at 44.1kHz) gives YIN's half-buffer
// 2048 samples to work with — enough for ~22Hz minimum detection, so
// cello C2 (65Hz) and even extension notes down to F1 (~44Hz) come
// through reliably. (At a 2048-sample buffer the F1 period barely
// fit twice in the analysis window, so detection was flaky.)
const GAME_MIC_BUFFER_SIZE       = 4096;
// RMS_LOW / RMS_HIGH form a hysteresis gate for SUSTAINED tones
// (bowed cello, voice). Useful as a fallback even with onset
// detection on: when energy drops to silence between phrases, the
// "in note" state resets, ensuring the next attack rearms cleanly
// even if the onset-ratio threshold isn't crossed.
const GAME_MIC_RMS_LOW           = 0.005;
const GAME_MIC_RMS_HIGH          = 0.012;
// Onset detection — needed for PIZZICATO cello (and any plucked /
// percussive instrument): the previous note's decay tail sits well
// above RMS_LOW when the next pluck lands, so the silence-based
// rearm never fires. Instead, we look for a sudden energy spike
// relative to the smoothed background level. Any frame whose
// instantaneous RMS exceeds the smoothed RMS by `ONSET_RATIO×` AND
// is itself above `ONSET_FLOOR` (so quiet room noise can't trigger)
// is treated as a fresh attack: the acceptedThisAttack flag clears
// and the PC stability counter restarts.
const GAME_MIC_ONSET_RATIO       = 1.7;
const GAME_MIC_ONSET_FLOOR       = 0.008;
const GAME_MIC_SMOOTH_ALPHA      = 0.15;   // EMA weight for current frame (higher = less smoothing)
const GAME_MIC_ONSET_REFRACTORY  = 80;     // ms — minimum spacing between onset-driven rearms
// Sliding-window majority vote on the last N detected PCs. Replaces
// a strict "consecutive identical" streak so a pitch hovering near a
// 50-cent boundary (e.g. cello F that's 45 cents sharp + slight
// vibrato) doesn't get rejected because one frame in the middle
// rounded to the adjacent semitone. ±50-cent tolerance comes for
// free from rounding hz → nearest MIDI; this window adds tolerance
// for SHORT-LIVED outliers within that range.
const GAME_MIC_PC_HISTORY        = 5;
const GAME_MIC_PC_QUORUM         = 3;
const GAME_MIC_YIN_THRESHOLD     = 0.15;   // YIN aperiodicity threshold (lower = more confident)
// MIN_HZ lowered to 40 to cover cello F1 (~43.7Hz) without false-
// rejecting it. Octave errors at this low end are common but
// HARMLESS for the game: F1 and F2 share the same pitch class, so a
// YIN result that locks onto the 2nd harmonic still produces the
// right PC.
const GAME_MIC_MIN_HZ            = 40;
const GAME_MIC_MAX_HZ            = 1500;
const GAME_MIC_PULSE_CLASS_MS    = 220;

let gameMic = {
  running: false,
  audioContext: null,
  stream: null,
  source: null,
  analyser: null,
  buffer: null,
  rafId: null,
  inNote: false,
  acceptedThisAttack: false,
  // Ring buffer of (last GAME_MIC_PC_HISTORY) detected MIDI values.
  // We track full MIDI — not just PC — so the fill-note placer can
  // use the user's ACTUAL octave instead of guessing one from
  // surrounding landmarks. The PC quorum is still derived from
  // these MIDIs (`m % 12`).
  recentMidis: [],
  smoothedRms: 0,
  lastOnsetAt: 0,
  // performance.now() timestamp until which mic detection should be
  // skipped. Set by the metronome on each tick so the click's noise
  // burst doesn't trip the onset detector or mask the cello attack.
  duckUntil: 0
};

// YIN pitch detection. Returns Hz, or -1 if no confident pitch found.
function gameYinPitch(buffer, sampleRate) {
  const bufferSize = buffer.length;
  const halfBufferSize = bufferSize >> 1;
  // Reuse a thread-local workspace to avoid GC churn on each frame.
  if (!gameYinPitch._yin || gameYinPitch._yin.length !== halfBufferSize) {
    gameYinPitch._yin = new Float32Array(halfBufferSize);
  }
  const yin = gameYinPitch._yin;

  // Step 1: squared difference function.
  for (let tau = 0; tau < halfBufferSize; tau++) {
    let sum = 0;
    for (let i = 0; i < halfBufferSize; i++) {
      const delta = buffer[i] - buffer[i + tau];
      sum += delta * delta;
    }
    yin[tau] = sum;
  }
  // Step 2: cumulative mean normalized difference function (CMNDF).
  yin[0] = 1;
  let runningSum = 0;
  for (let tau = 1; tau < halfBufferSize; tau++) {
    runningSum += yin[tau];
    yin[tau] *= tau / (runningSum || 1);
  }
  // Step 3: absolute-threshold pitch search. Walk past the first
  // dip below threshold; track the local minimum within that dip.
  let tauEstimate = -1;
  for (let tau = 2; tau < halfBufferSize; tau++) {
    if (yin[tau] < GAME_MIC_YIN_THRESHOLD) {
      while (tau + 1 < halfBufferSize && yin[tau + 1] < yin[tau]) tau++;
      tauEstimate = tau;
      break;
    }
  }
  if (tauEstimate < 0) return -1;
  // Step 4: parabolic interpolation around the minimum for sub-sample
  // precision (otherwise the detected pitch quantizes badly at high
  // frequencies where the period is only a handful of samples).
  let betterTau = tauEstimate;
  const x0 = tauEstimate > 0 ? tauEstimate - 1 : tauEstimate;
  const x2 = tauEstimate + 1 < halfBufferSize ? tauEstimate + 1 : tauEstimate;
  if (x0 !== tauEstimate && x2 !== tauEstimate) {
    const s0 = yin[x0], s1 = yin[tauEstimate], s2 = yin[x2];
    const denom = 2 * (2 * s1 - s2 - s0);
    if (Math.abs(denom) > 1e-9) {
      betterTau = tauEstimate + (s2 - s0) / denom;
    }
  }
  if (betterTau <= 0) return -1;
  return sampleRate / betterTau;
}

function gameMicSetButton(active) {
  const btn = document.getElementById('gameMicBtn');
  if (btn) btn.setAttribute('aria-pressed', active ? 'true' : 'false');
}

// Update the live detected-note readout in the score column. Pass
// a MIDI value to show as letter+octave ("F1", "B♭2"); pass null
// to clear the readout (mic stopped, or silence frame).
function gameSetDetectedNote(midi) {
  const el = document.getElementById('gameDetectedNote');
  if (!el) return;
  if (midi == null || !isFinite(midi)) {
    el.textContent = '—';
    return;
  }
  // midiToName gives sharps-form (C#, D#, F#, G#, A#). Substitute
  // the unicode sharp glyph for a more musical look.
  const name = midiToName(midi).replace('#', '♯');
  el.textContent = name;
}

function gameMicProcessFrame() {
  if (!gameMic.running || !gameMic.analyser || !gameMic.buffer) return;
  // If the metronome just clicked, skip detection for a short window
  // so the click's noise burst can't fool the onset detector or
  // briefly mask the cello attack. The click itself is high-pass
  // filtered far above the cello range — YIN won't lock onto it
  // even outside the duck — but the RMS spike from the click is
  // still enough to trip onset detection, which would reset the
  // accept gate prematurely.
  const nowMs = (typeof performance !== 'undefined' && performance.now)
    ? performance.now() : Date.now();
  if (gameMic.duckUntil && nowMs < gameMic.duckUntil) return;
  gameMic.analyser.getFloatTimeDomainData(gameMic.buffer);
  const buf = gameMic.buffer;

  // Instantaneous RMS for this frame.
  let sumSq = 0;
  for (let i = 0; i < buf.length; i++) sumSq += buf[i] * buf[i];
  const rms = Math.sqrt(sumSq / buf.length);

  // Smoothed RMS — exponential moving average of the recent
  // energy floor. Used by onset detection: a real attack spikes
  // instantaneous RMS well above this baseline.
  const prevSmoothed = gameMic.smoothedRms;
  gameMic.smoothedRms = prevSmoothed * (1 - GAME_MIC_SMOOTH_ALPHA)
                     + rms * GAME_MIC_SMOOTH_ALPHA;

  // Silence: rearm everything so the next attack starts from a
  // clean state.
  if (rms < GAME_MIC_RMS_LOW) {
    gameMic.inNote = false;
    gameMic.acceptedThisAttack = false;
    gameMic.recentMidis.length = 0;
    gameSetDetectedNote(null);
    return;
  }
  if (rms > GAME_MIC_RMS_HIGH) {
    gameMic.inNote = true;
  }
  if (!gameMic.inNote) return;

  // Onset detection — drives pizz/plucked workflow where the
  // previous note's tail sits above RMS_LOW when the next pluck
  // lands. A "fresh attack" is a frame whose RMS jumps above
  // ONSET_RATIO × the smoothed baseline AND clears the absolute
  // floor. We compare against the PREVIOUS smoothed value so a
  // sudden spike isn't immediately blunted by including itself in
  // the EMA. A refractory period prevents one physical pluck (which
  // can have a multi-frame attack ramp) from registering twice.
  const now = (typeof performance !== 'undefined' && performance.now)
    ? performance.now() : Date.now();
  const refSmoothed = Math.max(prevSmoothed, GAME_MIC_RMS_LOW);
  const isOnset = (rms > GAME_MIC_ONSET_FLOOR)
               && (rms / refSmoothed > GAME_MIC_ONSET_RATIO)
               && (now - gameMic.lastOnsetAt > GAME_MIC_ONSET_REFRACTORY);
  if (isOnset) {
    gameMic.acceptedThisAttack = false;
    gameMic.recentMidis.length = 0;
    gameMic.lastOnsetAt = now;
  }

  // Already accepted a PC for this attack — wait for either a real
  // silence (handled above) or the next onset (handled just now).
  if (gameMic.acceptedThisAttack) return;

  const sr = gameMic.audioContext.sampleRate;
  const hz = gameYinPitch(buf, sr);
  if (hz < GAME_MIC_MIN_HZ || hz > GAME_MIC_MAX_HZ) return;

  // Hz → MIDI. midi = 69 + 12·log2(hz/440); the rounding to the
  // nearest MIDI integer is what gives the ±50-cent intonation
  // tolerance (any pitch within 50 cents of a semitone lands on
  // that semitone). PC = MIDI mod 12.
  const midi = Math.round(69 + 12 * Math.log2(hz / 440));

  // Live readout — update every frame so the user sees the
  // detected note in real time (including pre-quorum frames, so
  // they can confirm the mic is picking up the right pitch even
  // before it commits to a final answer).
  gameSetDetectedNote(midi);

  // Push the full MIDI into a small ring buffer of recent detections.
  gameMic.recentMidis.push(midi);
  if (gameMic.recentMidis.length > GAME_MIC_PC_HISTORY) {
    gameMic.recentMidis.shift();
  }
  // Need at least QUORUM samples before we can even consider
  // accepting — keeps the very first frame of an attack (still
  // transient) from triggering.
  if (gameMic.recentMidis.length < GAME_MIC_PC_QUORUM) return;
  // Tally PC counts over the window, and (per PC) tally MIDI
  // counts so we can pick the most-common ACTUAL octave for the
  // winning PC. YIN occasionally locks onto the 2nd harmonic at
  // low frequencies (e.g. reports A2 when the user played A1);
  // by picking the mode of the winning-PC MIDIs and tiebreaking
  // toward the LOWER MIDI, those octave-up artifacts are filtered
  // out of the final answer.
  const pcCounts = {};
  const midisByPc = {};
  let winnerPc = -1, winnerPcCount = 0;
  for (let i = 0; i < gameMic.recentMidis.length; i++) {
    const m = gameMic.recentMidis[i];
    const p = ((m % 12) + 12) % 12;
    pcCounts[p] = (pcCounts[p] || 0) + 1;
    if (!midisByPc[p]) midisByPc[p] = [];
    midisByPc[p].push(m);
    if (pcCounts[p] > winnerPcCount) {
      winnerPcCount = pcCounts[p];
      winnerPc = p;
    }
  }
  if (winnerPcCount >= GAME_MIC_PC_QUORUM) {
    gameMic.acceptedThisAttack = true;
    // Pick the most-common MIDI within the winning PC (lower MIDI
    // wins ties — prefers fundamental over harmonic).
    const midis = midisByPc[winnerPc];
    const midiCounts = {};
    for (const m of midis) midiCounts[m] = (midiCounts[m] || 0) + 1;
    let winnerMidi = midis[0];
    let bestCount = -1;
    for (const mStr in midiCounts) {
      const m = +mStr;
      const c = midiCounts[mStr];
      if (c > bestCount || (c === bestCount && m < winnerMidi)) {
        bestCount = c;
        winnerMidi = m;
      }
    }
    // playLead=false: the user just produced this note themselves,
    // so layering the guitar sampler on top would be redundant.
    // micMidi=winnerMidi: the actual detected octave, so the
    // fill-note placer doesn't have to guess.
    gameHandleKeyPress(winnerPc, false, winnerMidi);
    // Pulse the mic button to confirm a detection registered.
    const btn = document.getElementById('gameMicBtn');
    if (btn) {
      btn.classList.remove('active-pulse');
      // Force reflow so the animation restarts on rapid retriggers.
      void btn.offsetWidth;
      btn.classList.add('active-pulse');
      setTimeout(() => btn && btn.classList.remove('active-pulse'),
                 GAME_MIC_PULSE_CLASS_MS + 50);
    }
  }
}

async function gameMicStart() {
  if (gameMic.running) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    const s = document.getElementById('status');
    if (s) s.textContent = 'Microphone not supported in this browser.';
    return;
  }
  try {
    // Disable browser DSP that would distort our pitch input:
    //   - echoCancellation: would notch out sustained tones
    //   - noiseSuppression: aggressive suppressor can mistake bowed
    //     cello for noise
    //   - autoGainControl: ramps gain mid-note, throws off energy gate
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    });
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) throw new Error('No AudioContext');
    const ac = new AC();
    if (ac.state === 'suspended') await ac.resume().catch(() => {});
    const source = ac.createMediaStreamSource(stream);
    const analyser = ac.createAnalyser();
    analyser.fftSize = GAME_MIC_BUFFER_SIZE;
    analyser.smoothingTimeConstant = 0;
    source.connect(analyser);

    gameMic.audioContext = ac;
    gameMic.stream = stream;
    gameMic.source = source;
    gameMic.analyser = analyser;
    gameMic.buffer = new Float32Array(analyser.fftSize);
    gameMic.running = true;
    gameMic.inNote = false;
    gameMic.acceptedThisAttack = false;
    gameMic.recentMidis.length = 0;
    gameMic.smoothedRms = 0;
    gameMic.lastOnsetAt = 0;
    gameMicSetButton(true);

    function tick() {
      if (!gameMic.running) return;
      gameMicProcessFrame();
      gameMic.rafId = requestAnimationFrame(tick);
    }
    tick();
  } catch (e) {
    const s = document.getElementById('status');
    if (s) s.textContent = 'Microphone access denied.';
    gameMicSetButton(false);
  }
}

function gameMicStop() {
  if (!gameMic.running && !gameMic.audioContext) {
    gameMicSetButton(false);
    return;
  }
  gameMic.running = false;
  if (gameMic.rafId) {
    cancelAnimationFrame(gameMic.rafId);
    gameMic.rafId = null;
  }
  try {
    if (gameMic.source)    gameMic.source.disconnect();
    if (gameMic.analyser)  gameMic.analyser.disconnect();
    if (gameMic.stream)    gameMic.stream.getTracks().forEach(t => t.stop());
    if (gameMic.audioContext && gameMic.audioContext.state !== 'closed') {
      gameMic.audioContext.close();
    }
  } catch (e) { /* ignore teardown errors */ }
  gameMic.audioContext = null;
  gameMic.stream = null;
  gameMic.source = null;
  gameMic.analyser = null;
  gameMic.buffer = null;
  gameMicSetButton(false);
  gameSetDetectedNote(null);
}

(function bindGameMicButton() {
  const btn = document.getElementById('gameMicBtn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    if (gameMic.running) {
      gameMicStop();
    } else {
      gameMicStart();
    }
  });
})();

// ===== Game mode: metronome =====
// Independent click track for game mode. Runs off setInterval keyed
// to `currentTempo` (the BPM picked by the Tempo segmented control).
// Uses the same `click` Tone.NoiseSynth that drum-mode "Click" uses.
//
// Mic conflict avoidance:
//   - The click is a high-pass-filtered (>2500Hz) noise burst, well
//     above cello fundamentals (≤880Hz). YIN's range gate
//     (40-1500Hz) drops it even if it managed to find a pitch.
//   - To stop the click's RMS spike from tripping the mic's onset
//     detector (which would reset the accept gate and briefly mask
//     a cello attack landing on the same beat), the tick handler
//     sets `gameMic.duckUntil` to `now + GAME_METRONOME_DUCK_MS`.
//     gameMicProcessFrame bails early while in that window.

const GAME_METRONOME_DUCK_MS = 90; // mic-detection blackout after each click

let gameMetronome = {
  running: false,
  intervalId: null,
  bpm: 120,
  // Count-in: clicks-only (no cursor advancement, no game scoring)
  // for the first N beats after pressing Play. Lets the user press
  // Play, lift their bow / get ready, and start playing in time
  // when the count-in lapses. N = countInBars × beatsPerBar at the
  // time Play was pressed.
  countInRemaining: 0
};

function gameMetronomeSetButton(active) {
  const btn = document.getElementById('gameMetronomeBtn');
  if (btn) btn.setAttribute('aria-pressed', active ? 'true' : 'false');
}

function gameMetronomeTick() {
  // Play the click via the existing Tone.NoiseSynth used by the
  // "Click" drum mode. Short '32n' release so the click reads as
  // a tight tick, not a sweeping burst.
  if (typeof click !== 'undefined' && click) {
    try { click.triggerAttackRelease('32n', undefined, 0.7); }
    catch (e) { /* sampler not ready yet */ }
  }
  // Duck the mic detector so this click doesn't trip the onset
  // edge or mask a simultaneous cello attack.
  const nowMs = (typeof performance !== 'undefined' && performance.now)
    ? performance.now() : Date.now();
  gameMic.duckUntil = nowMs + GAME_METRONOME_DUCK_MS;
  // Visual pulse on the button. During the count-in we use an
  // orange-tinted pulse so the user has a clear "I'm warming up"
  // vs. "I'm playing now" visual cue.
  const btn = document.getElementById('gameMetronomeBtn');
  if (btn) {
    btn.classList.remove('tick-pulse', 'count-in-pulse');
    void btn.offsetWidth; // reflow so the animation restarts
    btn.classList.add(
      gameMetronome.countInRemaining > 0 ? 'count-in-pulse' : 'tick-pulse'
    );
  }
  // Count-in: just play the click and decrement; don't advance the
  // game cursor yet. When the count-in counter reaches zero the
  // NEXT tick (and all subsequent ticks) runs the normal game
  // advancement.
  if (gameMetronome.countInRemaining > 0) {
    gameMetronome.countInRemaining--;
    return;
  }
  // Follow mode: each tick drives the cursor through the score.
  // Hidden mode just gets the audible/visual click — cursor is
  // driven by the user's correct inputs there.
  if (gameMode && gameKind === 'follow') {
    gameFollowAdvance();
  }
}

function gameMetronomeStart() {
  if (gameMetronome.running) return;
  // Kick off audio so the click sampler is loaded. The button click
  // is a user gesture, so Tone.start() inside initAudio() succeeds.
  if (typeof initAudio === 'function') initAudio().catch(() => {});
  const bpm = (typeof currentTempo === 'number' && currentTempo > 0)
    ? currentTempo : 120;
  const intervalMs = 60000 / bpm;
  gameMetronome.bpm = bpm;
  gameMetronome.running = true;
  // Count-in beats = countInBars setting × beats-per-bar of the
  // current song. Reads from the existing global `countInBars`
  // (Instruments panel → Count-in seg). With 0, the very first
  // tick is already a "game" beat — no warm-up. With 1, the first
  // bar's worth of ticks is click-only; the cursor starts advancing
  // on the FIRST tick of the second bar (which doubles as the
  // downbeat of the music).
  const ts = (window.currentSong && typeof parseTimesig === 'function')
    ? parseTimesig(window.currentSong.timesig) : null;
  const beatsPerBar = (ts && ts.num) ? ts.num : 4;
  const bars = (typeof countInBars === 'number') ? countInBars : 0;
  gameMetronome.countInRemaining = Math.max(0, bars * beatsPerBar);
  gameMetronomeSetButton(true);
  // First tick immediately so the user gets feedback the moment
  // they toggle on; subsequent ticks at `intervalMs` cadence.
  gameMetronomeTick();
  gameMetronome.intervalId = setInterval(gameMetronomeTick, intervalMs);
}

function gameMetronomeStop() {
  if (gameMetronome.intervalId != null) {
    clearInterval(gameMetronome.intervalId);
    gameMetronome.intervalId = null;
  }
  gameMetronome.running = false;
  gameMetronome.countInRemaining = 0;
  gameMetronomeSetButton(false);
  // Clear any residual mic duck so detection resumes immediately.
  gameMic.duckUntil = 0;
  // Also clear any leftover button pulse classes from the count-in
  // or in-game ticks so the icon settles cleanly on the stopped
  // state.
  const btn = document.getElementById('gameMetronomeBtn');
  if (btn) btn.classList.remove('tick-pulse', 'count-in-pulse');
}

(function bindGameMetronomeButton() {
  const btn = document.getElementById('gameMetronomeBtn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    if (gameMetronome.running) {
      gameMetronomeStop();
    } else {
      gameMetronomeStart();
    }
  });
})();
