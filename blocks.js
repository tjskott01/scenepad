// Block editor definitions. Param numbers = Axe-Fx III catalog in fractal-midi (community RE, Apache-2.0).
// kind 'knob'  : catalog says linear 0–10 (typecode 50, same as the Amp knobs Tjay confirmed) → shown 0–10.
// kind 'pct'   : any other range → shown as % of the parameter's range (normalized). Catalog range is shown as a hint only,
//                because the wire→unit mapping (log Hz, dB taper, ms) is not verified.
// test         : param nudged by diagnostics test 8 (small step, then restored).
'use strict';
const BLOCK_DEFS = {
  DISTORT: { title: 'Amp', types: [{ pid: 0, label: 'Model', names: () => (typeof AMP_TYPES !== 'undefined' ? AMP_TYPES : null) }],
    controls: [['Gain', 1, 'knob'], ['Bass', 2, 'knob'], ['Mid', 3, 'knob'], ['Treble', 4, 'knob'], ['Master', 5, 'knob']], test: 1, confidence: 'confirmed on unit (fw 18.03)' },
  CAB: { title: 'Cab', types: [{ pid: 0, label: 'Cab 1 bank', names: null }, { pid: 4, label: 'Cab 1 number', names: null }],
    controls: [['Level', 28, 'pct', '-80…+20 dB'], ['Balance', 29, 'pct', '-100…+100'], ['Cab 1 level', 8, 'pct', '-40…0 dB'],
      ['Cab 1 proximity', 20, 'knob'], ['Low cut', 38, 'pct', '20…2000 Hz'], ['High cut', 39, 'pct', '200…20000 Hz']], test: 28, confidence: 'catalog only' },
  FUZZ: { title: 'Drive', types: [{ pid: 0, label: 'Type', names: () => ROSTERS.FUZZ_TYPE }],
    controls: [['Drive', 1, 'knob'], ['Tone', 2, 'knob'], ['Level', 3, 'knob'], ['Mix', 4, 'pct', '0…100 %'],
      ['Low cut', 8, 'pct', '20…2000 Hz'], ['High cut', 9, 'pct', '200…20000 Hz']], test: 3, confidence: 'catalog only' },
  DELAY: { title: 'Delay', types: [{ pid: 0, label: 'Model', names: () => ROSTERS.DELAY_MODEL }, { pid: 1, label: 'Type', names: () => ROSTERS.DELAY_TYPE }],
    controls: [['Time', 2, 'pct', '1…16000 ms'], ['Feedback', 4, 'pct', '-100…+100 %'], ['Mix', 17, 'pct', '0…100 %'],
      ['Level', 18, 'pct', '-80…+20 dB'], ['Low cut', 10, 'pct', '20…2000 Hz'], ['High cut', 11, 'pct', '200…20000 Hz']], test: 17, confidence: 'catalog only (Time pid 2 also matches a 2019 Axe-Edit III capture)' },
  REVERB: { title: 'Reverb', types: [{ pid: 0, label: 'Type', names: () => ROSTERS.REVERB_TYPE }],
    controls: [['Time', 1, 'pct', '0.1…100 s'], ['Mix', 13, 'pct', '0…100 %'], ['Level', 14, 'pct', '-80…+20 dB'], ['Pre-delay', 9, 'pct', '0…1000 ms'],
      ['Size', 5, 'pct', '1…100 %'], ['High cut', 2, 'pct', '200…20000 Hz'], ['Low cut', 10, 'pct', '20…2000 Hz']], test: 13, confidence: 'catalog only' },
};
const BLOCK_ORDER = ['DISTORT', 'CAB', 'FUZZ', 'DELAY', 'REVERB'];
function blockDef(id) { const b = P.blockInfo(id); return b && BLOCK_DEFS[b.base] ? { ...BLOCK_DEFS[b.base], base: b.base } : null; }
function fmtParam(kind, w) {
  if (w == null || w > 65534) return '–';
  return kind === 'knob' ? (w / 65534 * 10).toFixed(2) : (w / 65534 * 100).toFixed(1) + '%';
}
function typeName(t, v) { const n = t.names && t.names(); const s = n && n[v]; return s ? `${s} (#${v})` : `#${v}`; }
// Channel stride: gen-3 bulk reads are laid out as 4 channel copies (Amp: 540 = 4 × 135, confirmed on fw 18.03).
// Fall back to the status-dump channel count only if itemCount is not divisible by 4.
function blockStride(bulk, channels) { if (Number.isInteger(bulk.itemCount / 4)) return bulk.itemCount / 4; const s = bulk.itemCount / (channels || 1); return Number.isInteger(s) ? s : null; }
