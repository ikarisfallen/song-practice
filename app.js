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
        if (!cur) startBar();
        cur.markers.push({ type: 'segno' });
        break;
      case 'coda':
        if (!cur) startBar();
        cur.markers.push({ type: 'coda' });
        break;
      case 'endMarker':
        if (!cur) startBar();
        cur.markers.push({ type: 'endMarker' });
        break;
      case 'comment': {
        const txt = t.m[1];
        if (!cur) startBar();
        cur.markers.push({ type: 'comment', text: txt });
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

// Given an expanded bars array and a time signature, walk beat-by-beat and
// generate a quarter-note pitch sequence using the Quarter Notes algorithm.
// Returns an array parallel to bars: beatPitches[barIdx] = [ {pitch, tpc} | null, ... ].
function generateQuarterNotes(bars, ts) {
  const beatsPerBar = ts.num;
  // Build flat beat list with chord per beat
  const beatList = [];
  for (let bi = 0; bi < bars.length; bi++) {
    const bar = bars[bi];
    const chords = (bar.chords || []).filter(c => !c.slash && !c.nc);
    const bc = new Array(beatsPerBar).fill(null);
    if (chords.length === 1) bc.fill(chords[0]);
    else if (chords.length === 2) {
      const half = Math.floor(beatsPerBar / 2);
      for (let i = 0; i < half; i++) bc[i] = chords[0];
      for (let i = half; i < beatsPerBar; i++) bc[i] = chords[1];
    } else if (chords.length > 2) {
      for (let i = 0; i < beatsPerBar; i++)
        bc[i] = chords[Math.min(chords.length - 1, Math.floor(i * chords.length / beatsPerBar))];
    }
    // If bar is a repeat of prev (repeatPrev set), inherit prev bar's chords
    if (bar.repeatPrev && bi > 0) {
      const src = bars[bi - bar.repeatPrev];
      if (src) {
        const srcChords = (src.chords || []).filter(c => !c.slash && !c.nc);
        if (srcChords.length === 1) bc.fill(srcChords[0]);
        else if (srcChords.length === 2) {
          const half = Math.floor(beatsPerBar / 2);
          for (let i = 0; i < half; i++) bc[i] = srcChords[0];
          for (let i = half; i < beatsPerBar; i++) bc[i] = srcChords[1];
        }
      }
    }
    for (let b = 0; b < beatsPerBar; b++) beatList.push({ barIdx: bi, beat: b, chord: bc[b] });
  }

  // Walk and assign pitches
  let direction = -1;
  let currentKey = null;  // chord canonical text
  let tones = [];
  let toneIdx = 0;
  let lastPitch = -1;
  const results = bars.map(() => new Array(beatsPerBar).fill(null));

  for (let i = 0; i < beatList.length; i++) {
    const entry = beatList[i];
    const ch = entry.chord;
    if (!ch) continue;
    const key = chordToCanonical(ch);
    if (key !== currentKey) {
      const root = exParseRoot(key);
      if (!root) continue;
      const scale = exGetScale(key);
      tones = buildScaleTones(root.pitchClass, root.tpc, scale);
      currentKey = key;
      if (tones.length === 0) continue;
      if (lastPitch < 0) {
        // first chord: start on root in C3 octave, descending
        let sp = root.pitchClass + 48;
        while (sp < EX_LOW) sp += 12;
        while (sp > EX_HIGH) sp -= 12;
        toneIdx = findClosestIndex(tones, sp);
      } else {
        const cont = findContinuationIndex(tones, lastPitch, direction);
        toneIdx = cont.idx;
        direction = cont.dir;
      }
    }
    if (tones.length === 0) continue;

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
    results[entry.barIdx][entry.beat] = { pitch: p, tpc: t };
    lastPitch = p;

    // advance
    let ni = toneIdx + direction;
    if (ni < 0) { direction = 1; ni = toneIdx + 1; }
    else if (ni >= tones.length) { direction = -1; ni = toneIdx - 1; }
    if (ni < 0) ni = 0;
    if (ni >= tones.length) ni = tones.length - 1;
    toneIdx = ni;
  }
  return results;
}

// TPC → letter + accidental (e.g. TPC 7 → { letter:'C', acc:'b' })
function tpcToLetterAcc(tpc) {
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
  return { key, acc, letterIdx: LETTER_IDX[letter], level: altAdjust };
}

// ===== Render (sheet music via VexFlow) =====
let measuresPerLine = 2;
let songRepeats = 2;
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
  document.getElementById('songComposer').textContent = song.composer || '';
  document.getElementById('songStyle').textContent =
    (song.styleFull || song.style || '') + (song.key ? ' · ' + song.key : '') + (song.bpm ? ' · ' + song.bpm + ' bpm' : '');

  if (!window.Vex || !window.Vex.Flow) {
    chartEl.textContent = 'VexFlow failed to load.';
    return;
  }
  const VF = Vex.Flow;
  const ts = parseTimesig(timesigStr);

  // Expand by song repeats and generate quarter notes across the whole thing
  const bars = expandBarsByRepeats(barsIn, songRepeats);
  const quarterNotes = generateQuarterNotes(bars, ts);

  // State for courtesy accidentals, carried across bars.
  // letter index: 0=F,1=C,2=G,3=D,4=A,5=E,6=B (same as ExerciseBuilder.qml noteName)
  // level: -2=bb, -1=b, 0=natural, 1=#, 2=##
  // In C major (no key sig) the default level for every letter is 0.
  let prevMeasureAlterations = {};

  const mpl = measuresPerLine;
  const measureWidth = 240;
  const leftPadding = 14;
  const rightPadding = 14;
  const firstMeasureClefWidth = 68; // bass clef + 8vb + time sig on line 1
  const clefOnlyExtra = 44; // bass clef + 8vb on other lines
  const staffY = 26;
  const staffHeight = 120;

  for (let rowStart = 0; rowStart < bars.length; rowStart += mpl) {
    const rowBars = bars.slice(rowStart, rowStart + mpl);
    const isFirstRow = rowStart === 0;
    const clefExtra = isFirstRow ? firstMeasureClefWidth : clefOnlyExtra;
    const rowWidth = leftPadding + clefExtra + rowBars.length * measureWidth + rightPadding;

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
    rowBars.forEach((bar, i) => {
      const barIdx = rowStart + i;
      const isFirstInRow = i === 0;
      const width = measureWidth + (isFirstInRow ? clefExtra : 0);
      const stave = new VF.Stave(x, staffY, width);
      if (isFirstInRow) {
        stave.addClef('bass', undefined, '8vb');
        if (isFirstRow) stave.addTimeSignature(ts.str);
      }
      // Barlines
      if (bar.leftBar === 'repeatStart') stave.setBegBarType(VF.Barline.type.REPEAT_BEGIN);
      else if (!isFirstInRow) stave.setBegBarType(VF.Barline.type.NONE);

      if (bar.rightBar === 'repeatEnd') stave.setEndBarType(VF.Barline.type.REPEAT_END);
      else if (bar.rightBar === 'final') stave.setEndBarType(VF.Barline.type.END);
      else if (bar.rightBar === 'double') stave.setEndBarType(VF.Barline.type.DOUBLE);
      else stave.setEndBarType(VF.Barline.type.SINGLE);

      // Section marker (rehearsal letter)
      if (bar.section) {
        stave.setSection(bar.section, 0);
      }
      // Ending bracket
      if (bar.ending) {
        stave.setRepetition && stave.setRepetition(VF.Repetition.type.NONE, 0, 0);
        stave.setVoltaType && stave.setVoltaType(VF.Volta.type.MID, bar.ending, 0);
      }
      stave.setContext(context).draw();

      // Quarter notes per beat (generated from chord scales).
      const beatPitches = quarterNotes[barIdx] || [];
      const notes = [];
      // Per-measure courtesy-accidental state (ported from ExerciseBuilder.qml)
      const currMeasureSeen = {};       // letter → accidental level displayed so far
      const currMeasureAlterations = {}; // letter → level (only where level != key default)
      const ACC_GLYPH = { '-2': 'bb', '-1': 'b', '0': 'n', '1': '#', '2': '##' };

      for (let b = 0; b < ts.num; b++) {
        const bp = beatPitches[b];
        if (bp) {
          const { key, letterIdx, level } = midiTpcToVexKey(bp.pitch, bp.tpc);
          // Stem direction: on/above middle line of the staff → stem down,
          // below middle line → stem up. Bass-clef middle line is D3 (MIDI 50);
          // we render an octave up (8vb), so written MIDI = sounding + 12.
          // Therefore sounding MIDI >= 38 (D2) → stem down.
          const stemDir = bp.pitch >= 38 ? VF.Stem.DOWN : VF.Stem.UP;
          const n = new VF.StaveNote({ clef: 'bass', keys: [key], duration: 'q', stem_direction: stemDir });

          // Decide whether to show an accidental on this note.
          // Key default level for every letter = 0 (C major / no key signature).
          const keyDefault = 0;
          let showLevel = null;
          if (!(letterIdx in currMeasureSeen)) {
            // First occurrence of this letter in the current measure
            if (level !== keyDefault) {
              showLevel = level; // sharp/flat/etc must be drawn
            } else if (letterIdx in prevMeasureAlterations &&
                       prevMeasureAlterations[letterIdx] !== keyDefault) {
              // Previous measure altered this letter → courtesy natural
              showLevel = 0;
            }
            currMeasureSeen[letterIdx] = level;
          } else if (currMeasureSeen[letterIdx] !== level) {
            // Accidental changed mid-measure → must redraw
            showLevel = level;
            currMeasureSeen[letterIdx] = level;
          }
          if (showLevel !== null) {
            n.addModifier(new VF.Accidental(ACC_GLYPH[String(showLevel)]), 0);
          }
          if (level !== keyDefault) currMeasureAlterations[letterIdx] = level;

          notes.push(n);
        } else {
          notes.push(new VF.StaveNote({ clef: 'bass', keys: ['d/3'], duration: 'qr' }));
        }
      }
      // Carry this measure's alterations to the next measure
      prevMeasureAlterations = currMeasureAlterations;
      const voice = new VF.Voice({ num_beats: ts.num, beat_value: ts.denom, resolution: VF.RESOLUTION });
      voice.setStrict(false);
      voice.addTickables(notes);
      const noteStart = stave.getNoteStartX();
      const noteEnd = stave.getNoteEndX();
      new VF.Formatter().joinVoices([voice]).format([voice], noteEnd - noteStart - 10);
      voice.draw(context, stave);

      // Manual chord symbol labels above the staff, evenly spaced over the note area.
      const svg = rowEl.querySelector('svg');
      // For Kcl-style "repeat prev measure" bars, inherit the previous bar's chord
      // symbols so the label matches the generated notes.
      let displayChords = (bar.chords || []).filter(c => !c.slash);
      if (bar.repeatPrev && barIdx >= bar.repeatPrev) {
        const src = bars[barIdx - bar.repeatPrev];
        if (src && src.chords) displayChords = src.chords.filter(c => !c.slash);
      }
      const labelAreaX0 = noteStart;
      const labelAreaW = noteEnd - noteStart;
      {
        displayChords.forEach((ch, ci) => {
          const cx = labelAreaX0 + (ci + 0.5) * (labelAreaW / Math.max(1, displayChords.length));
          const cy = staffY - 6;
          const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
          t.setAttribute('x', cx);
          t.setAttribute('y', cy);
          t.setAttribute('text-anchor', 'middle');
          t.setAttribute('font-family', 'serif');
          t.setAttribute('font-size', 15);
          t.setAttribute('fill', '#000');
          t.textContent = chordText(ch);
          svg.appendChild(t);
        });
      }

      // Record bounds for highlighting
      barElements[barIdx] = { rowEl, x, y: staffY, w: width, h: 80 };

      x += width;
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
    }
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
  const pc = pcFromRoot(ch.root);
  const ivs = intervalsFor(ch.rest || '');
  // Build MIDI pitch numbers around given octave
  const rootMidi = 12 * (octave + 1) + pc; // C4 = 60
  return ivs.map(i => rootMidi + i);
}

// Jazz voicing: rootless, 3-4 note, randomized inversion, centered mid-register.
function jazzVoicing(ch) {
  if (!ch || ch.nc || ch.slash) return null;
  const pc = pcFromRoot(ch.root);
  const ivs = intervalsFor(ch.rest || '');
  // Drop the root; keep chord tones (3,5,7) and one tension (9/11/13) if present
  const chordTones = ivs.filter(i => i > 0 && i < 12);
  const tensions = ivs.filter(i => i >= 12);
  let upper = [...chordTones];
  if (tensions.length) {
    // add one random tension
    upper.push(tensions[Math.floor(Math.random() * tensions.length)]);
  }
  // Trim/pad to 3 or 4 notes
  upper = upper.slice(0, 4);
  // Build MIDI: root at C4 so chord sits around middle
  const rootMidi = 60 + pc; // C4-area root
  let notes = upper.map(i => rootMidi + i);
  // Bring into ideal range (F3=53 .. C5=72)
  while (notes[0] < 53) notes = notes.map(n => n + 12);
  while (notes[0] > 65) notes = notes.map(n => n - 12);
  // Random inversion: rotate bottom note(s) up an octave
  const inv = Math.floor(Math.random() * Math.min(notes.length, 3));
  for (let k = 0; k < inv; k++) {
    const bottom = notes.shift();
    notes.push(bottom + 12);
  }
  // Sort for nicer voicing
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
  const pc = ch.bass ? pcFromRoot(ch.bass) : pcFromRoot(ch.root);
  return 12 * (octave + 1) + pc;
}
function midiToName(m) {
  const names = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  const n = names[m % 12];
  const o = Math.floor(m / 12) - 1;
  return n + o;
}

// ===== Tone.js playback =====
let transport, piano, hat, rideBody, rideBell, rideNoise;
let drumMode = 'hat'; // 'hat' | 'ride'
let playbackPart;
let playing = false;
let currentPlaylist = []; // sequence of { bar, idx } one entry = one bar
let currentBeatHighlight = null;

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
  document.getElementById('status').textContent = 'Loading piano samples…';
  await Tone.loaded();
  document.getElementById('status').textContent = 'Ready';

  const hatFilter = new Tone.Filter({ type: 'highpass', frequency: 7000, Q: 0.8 }).toDestination();
  hat = new Tone.NoiseSynth({
    noise: { type: 'white' },
    envelope: { attack: 0.001, decay: 0.06, sustain: 0, release: 0.05 },
    volume: -6
  }).connect(hatFilter);

  // Ride cymbal = body (long metallic wash) + bell (bright ping) + noise shimmer
  const rideVerb = new Tone.Reverb({ decay: 1.4, wet: 0.2 }).toDestination();
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
  const rideHP = new Tone.Filter({ type: 'highpass', frequency: 5000, Q: 1.2 }).connect(rideVerb);
  rideNoise = new Tone.NoiseSynth({
    noise: { type: 'white' },
    envelope: { attack: 0.001, decay: 0.35, sustain: 0.05, release: 0.6 },
    volume: -30
  }).connect(rideHP);
}

function stopPlayback() {
  if (playbackPart) { playbackPart.stop(); playbackPart.dispose(); playbackPart = null; }
  Tone.Transport.stop();
  Tone.Transport.cancel();
  playing = false;
  const btn = document.getElementById('playBtn');
  btn.textContent = '▶';
  btn.classList.remove('playing');
  clearHighlight();
}

function clearHighlight() {
  document.querySelectorAll('svg .hi-overlay').forEach(el => el.remove());
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
  rect.setAttribute('y', info.y - 4);
  rect.setAttribute('width', info.w);
  rect.setAttribute('height', info.h);
  rect.setAttribute('rx', 2);
  svg.appendChild(rect);
  const bcr = info.rowEl.getBoundingClientRect();
  if (bcr.top < 110 || bcr.bottom > window.innerHeight - 40) {
    info.rowEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

async function startPlayback(song, bars) {
  await initAudio();
  stopPlayback();

  const isSwing = /swing|jazz|bossa|bop/i.test(song.styleFull || song.style || '');
  const isFunk = /funk|fusion/i.test(song.styleFull || song.style || '');
  Tone.Transport.bpm.value = currentTempo;
  Tone.Transport.swing = isSwing ? 0.55 : 0;
  Tone.Transport.swingSubdivision = '8n';

  const playlist = expandForPlayback(bars);
  currentPlaylist = playlist;
  if (!playlist.length) return;

  const beatsPerBar = 4;
  const events = [];
  let tick = 0;
  let lastResolved = null;

  for (let barNum = 0; barNum < playlist.length; barNum++) {
    const entry = playlist[barNum];
    let bar = entry.bar;
    // resolve repeats
    if (bar.repeatPrev === 1 && lastResolved) bar = lastResolved;
    else if (bar.repeatPrev === 2 && playlist[barNum - 2]) bar = playlist[barNum - 2].bar;
    else lastResolved = bar;

    // Determine chord per 16th slot (for comping lookup)
    const chords = (bar.chords || []).filter(c => !c.slash && !c.nc);
    const chordForSlot = (slot16) => {
      if (chords.length === 0) return null;
      if (chords.length === 1) return chords[0];
      if (chords.length === 2) return slot16 < 8 ? chords[0] : chords[1];
      // 3+: distribute evenly
      const idx = Math.min(chords.length - 1, Math.floor(slot16 / (16 / chords.length)));
      return chords[idx];
    };

    events.push({ time: barNum + ':0:0', type: 'barStart', idx: entry.idx });

    // Random jazz comping pattern for this bar
    const pat = COMPING_PATTERNS[Math.floor(Math.random() * COMPING_PATTERNS.length)];
    for (const slot of pat) {
      const ch = chordForSlot(slot);
      if (!ch) continue;
      const dur = Math.random() < 0.25 ? '4n' : '8n'; // mostly short, occasional longer
      events.push({ time: `${barNum}:0:${slot}`, type: 'comp', ch, dur });
    }

    // Drums
    if (drumMode === 'hat') {
      // hi-hat on beats 2 and 4
      events.push({ time: `${barNum}:1:0`, type: 'hat' });
      events.push({ time: `${barNum}:3:0`, type: 'hat' });
    } else if (drumMode === 'ride') {
      // classic jazz spang-a-lang: quarters on 1..4 plus skip notes on &2 and &4
      // (Transport.swing pushes the "and" eighths into the triplet feel)
      events.push({ time: `${barNum}:0:0`, type: 'ride' });
      events.push({ time: `${barNum}:1:0`, type: 'ride' });
      events.push({ time: `${barNum}:1:2`, type: 'ride', accent: true });
      events.push({ time: `${barNum}:2:0`, type: 'ride' });
      events.push({ time: `${barNum}:3:0`, type: 'ride' });
      events.push({ time: `${barNum}:3:2`, type: 'ride', accent: true });
      // foot hi-hat (chick) on 2 and 4
      events.push({ time: `${barNum}:1:0`, type: 'hatFoot' });
      events.push({ time: `${barNum}:3:0`, type: 'hatFoot' });
    }
  }

  playbackPart = new Tone.Part((time, ev) => {
    if (ev.type === 'barStart') {
      Tone.Draw.schedule(() => highlightBar(ev.idx), time);
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
    if (ev.type === 'ride') {
      // "spang" (downbeat) = body + bell + shimmer; "a" (skip) = body + light shimmer, softer
      const skip = !!ev.accent; // skip notes tagged with accent:true
      const bodyVel = skip ? 0.45 : 0.7;
      const bellVel = skip ? 0 : 0.6;
      const noiseVel = skip ? 0.25 : 0.4;
      rideBody.triggerAttackRelease('C3', '2n', time, bodyVel);
      if (bellVel) rideBell.triggerAttackRelease('C5', '16n', time, bellVel);
      rideNoise.triggerAttackRelease('16n', time, noiseVel);
    }
    if (ev.type === 'ride') ride.triggerAttackRelease('8n', time, 0.4);
  }, events.map(e => [e.time, e]));

  playbackPart.start(0);
  Tone.Transport.start();
  playing = true;
  const btn = document.getElementById('playBtn');
  btn.textContent = '■';
  btn.classList.add('playing');
  document.getElementById('status').textContent = `Playing · ${playlist.length} bars`;
}

// ===== File loading =====
async function loadFromHTMLText(text) {
  // Find irealb:// URL
  const m = text.match(/irealb:\/\/[^"'<>\s]+/);
  if (!m) { alert('No iRealPro song URL found in file.'); return; }
  const url = m[0];
  return loadFromURL(url);
}
function loadFromURL(url) {
  const song = parseIRealSong(url);
  const tokens = tokenize(song.body);
  const { bars, timesig } = buildBars(tokens);
  renderChart(song, bars, timesig);
  window.currentSong = { song, bars };
  document.getElementById('status').textContent = `Loaded: ${song.title} (${bars.length} bars)`;
}

// ===== Event bindings =====
document.getElementById('playBtn').addEventListener('click', async () => {
  if (playing) { stopPlayback(); return; }
  if (!window.currentSong) return;
  const expanded = expandBarsByRepeats(window.currentSong.bars, songRepeats);
  await startPlayback(window.currentSong.song, expanded);
});
let currentTempo = 120;
document.querySelectorAll('#tempoSeg button').forEach(b => {
  b.addEventListener('click', () => {
    document.querySelectorAll('#tempoSeg button').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    currentTempo = parseInt(b.dataset.bpm, 10) || 120;
    if (Tone.Transport) Tone.Transport.bpm.value = currentTempo;
  });
});
function rerenderCurrent() {
  if (!window.currentSong) return;
  const { song, bars } = window.currentSong;
  const { timesig } = buildBars(tokenize(song.body));
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

document.querySelectorAll('#repeatSeg button').forEach(b => {
  b.addEventListener('click', async () => {
    document.querySelectorAll('#repeatSeg button').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    songRepeats = parseInt(b.dataset.r, 10) || 1;
    rerenderCurrent();
    if (playing && window.currentSong) {
      const expanded = expandBarsByRepeats(window.currentSong.bars, songRepeats);
      await startPlayback(window.currentSong.song, expanded);
    }
  });
});

document.querySelectorAll('#drumSeg button').forEach(b => {
  b.addEventListener('click', async () => {
    document.querySelectorAll('#drumSeg button').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    drumMode = b.dataset.mode;
    if (playing && window.currentSong) {
      // restart with the new pattern so the change is immediate
      const expanded = expandBarsByRepeats(window.currentSong.bars, songRepeats);
      await startPlayback(window.currentSong.song, expanded);
    }
  });
});

// ===== Song library =====
// Songs are served from /songs. The manifest at songs/index.json lists the
// filenames (HTML exports from iReal Pro). To add a song: drop the HTML file
// in songs/ and add its filename to songs/index.json.

async function loadSongByFilename(filename) {
  try {
    const res = await fetch('songs/' + encodeURIComponent(filename));
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = await res.text();
    loadFromHTMLText(text);
  } catch (e) {
    document.getElementById('status').textContent =
      'Failed to load ' + filename + ': ' + e.message;
  }
}

async function initSongLibrary() {
  const sel = document.getElementById('songSelect');
  if (!sel) { document.getElementById('status').textContent = '#songSelect missing'; return; }
  let songs;
  try {
    const res = await fetch('songs/index.json');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    songs = data.songs;
    if (!Array.isArray(songs) || songs.length === 0) throw new Error('empty manifest');
  } catch (e) {
    document.getElementById('status').textContent =
      'Could not load songs/index.json: ' + e.message;
    return;
  }
  sel.innerHTML = '';
  songs.forEach(filename => {
    const opt = document.createElement('option');
    opt.value = filename;
    opt.textContent = filename.replace(/\.html?$/i, '');
    sel.appendChild(opt);
  });
  sel.addEventListener('change', () => {
    if (playing) stopPlayback();
    loadSongByFilename(sel.value);
  });
  await loadSongByFilename(songs[0]);
}

initSongLibrary();
