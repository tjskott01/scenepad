// Axe-Fx III third-party SysEx protocol (Fractal Audio doc "Axe-Fx III MIDI for Third-Party Devices", rev 1.4).
// Pure functions only: no DOM, no MIDI access. Shared by the real link and the demo device.
'use strict';
const P = (() => {
  const HDR = [0xF0, 0x00, 0x01, 0x74, 0x10];
  const CMD = {
    FIRMWARE: 0x08,   // not in rev 1.4 doc; widely used by community libraries
    BYPASS: 0x0A, CHANNEL: 0x0B, SCENE: 0x0C, PATCH_NAME: 0x0D, SCENE_NAME: 0x0E,
    LOOPER: 0x0F, TAP: 0x10, TUNER: 0x11, STATUS_DUMP: 0x13, TEMPO: 0x14,
  };
  const Q = 0x7F;

  // XOR of every byte from F0 through the last data byte, masked to 7 bits.
  function checksum(bytes) { let x = 0; for (const b of bytes) x ^= b; return x & 0x7F; }
  function build(cmd, data = []) {
    const body = [...HDR, cmd, ...data];
    return [...body, checksum(body), 0xF7];
  }
  const lsb14 = n => [n & 0x7F, (n >> 7) & 0x7F];
  const from14 = (lo, hi) => (lo & 0x7F) | ((hi & 0x7F) << 7);

  // Effect ID enum, Appendix 1. Values are sequential from ID_TUNER = 35.
  const ENUM_FROM_35 = ['TUNER','IRCAPTURE','INPUT1','INPUT2','INPUT3','INPUT4','INPUT5',
    'OUTPUT1','OUTPUT2','OUTPUT3','OUTPUT4'];
  const QUADS = ['COMP','GRAPHEQ','PARAEQ','DISTORT','CAB','REVERB','DELAY','MULTITAP','CHORUS',
    'FLANGER','ROTARY','PHASER','WAH','FORMANT','VOLUME','TREMOLO','PITCH','FILTER','FUZZ',
    'ENHANCER','MIXER','SYNTH','VOCODER','MEGATAP','CROSSOVER','GATE','RINGMOD','MULTICOMP',
    'TENTAP','RESONATOR','LOOPER','TONEMATCH','RTA','PLEX','FBSEND','FBRETURN'];
  const ID = { CONTROL: 2 };
  let n = 35;
  for (const k of ENUM_FROM_35) ID[k] = n++;
  for (const q of QUADS) for (let i = 1; i <= 4; i++) ID[q + i] = n++;
  ID.MIDIBLOCK = n++;
  for (let i = 1; i <= 4; i++) ID['MULTIPLEXER' + i] = n++;
  for (let i = 1; i <= 4; i++) ID['IRPLAYER' + i] = n++;
  ID.FOOTCONTROLLER = n++; ID.PRESET_FC = n++;

  // Friendly labels for blocks a player would switch. Everything else is hidden.
  const LABEL = { COMP:'Comp', GRAPHEQ:'GEQ', PARAEQ:'PEQ', DISTORT:'Amp', CAB:'Cab', REVERB:'Reverb',
    DELAY:'Delay', MULTITAP:'Multitap', CHORUS:'Chorus', FLANGER:'Flanger', ROTARY:'Rotary',
    PHASER:'Phaser', WAH:'Wah', FORMANT:'Formant', VOLUME:'Vol/Pan', TREMOLO:'Trem/Pan', PITCH:'Pitch',
    FILTER:'Filter', FUZZ:'Drive', ENHANCER:'Enhancer', MIXER:'Mixer', SYNTH:'Synth', VOCODER:'Vocoder',
    MEGATAP:'Megatap', CROSSOVER:'Xover', GATE:'Gate', RINGMOD:'Ring Mod', MULTICOMP:'MB Comp',
    TENTAP:'Ten-Tap', RESONATOR:'Resonator', LOOPER:'Looper', PLEX:'Plex Dly', IRPLAYER:'IR Player',
    MULTIPLEXER:'Mux' };
  const ID_NAME = {}; for (const [k, v] of Object.entries(ID)) ID_NAME[v] = k;
  function blockInfo(id) {
    const name = ID_NAME[id]; if (!name) return null;
    const m = name.match(/^([A-Z]+?)(\d)?$/); const base = m[1], inst = m[2];
    if (!LABEL[base]) return null;
    return { id, key: name, label: LABEL[base] + (inst ? ' ' + inst : ''), base, inst: +inst || 1 };
  }
  // Order shown when no status dump is available yet.
  const DEFAULT_BLOCKS = ['DISTORT1','FUZZ1','COMP1','DELAY1','REVERB1','CHORUS1','FLANGER1',
    'PHASER1','WAH1','PITCH1','TREMOLO1','FILTER1'].map(k => ID[k]);

  // Outgoing message builders
  const msg = {
    setBypass: (id, bypassed) => build(CMD.BYPASS, [...lsb14(id), bypassed ? 1 : 0]),
    getBypass: id => build(CMD.BYPASS, [...lsb14(id), Q]),
    setChannel: (id, ch) => build(CMD.CHANNEL, [...lsb14(id), ch & 3]),
    getChannel: id => build(CMD.CHANNEL, [...lsb14(id), Q]),
    setScene: s => build(CMD.SCENE, [s & 7]),
    getScene: () => build(CMD.SCENE, [Q]),
    getPatchName: (num = null) => build(CMD.PATCH_NAME, num == null ? [Q, Q] : lsb14(num)),
    getSceneName: (s = null) => build(CMD.SCENE_NAME, [s == null ? Q : s & 7]),
    looper: btn => build(CMD.LOOPER, [btn]),
    getLooper: () => build(CMD.LOOPER, [Q]),
    tap: () => build(CMD.TAP),
    tuner: on => build(CMD.TUNER, [on ? 1 : 0]),
    statusDump: () => build(CMD.STATUS_DUMP),
    setTempo: bpm => build(CMD.TEMPO, lsb14(Math.round(bpm))),
    getTempo: () => build(CMD.TEMPO, [Q, Q]),
    getFirmware: () => build(CMD.FIRMWARE),
    // Standard MIDI: bank select CC0 (value = preset / 128) then Program Change (preset % 128).
    presetChange: (num, ch = 0) => [[0xB0 | ch, 0x00, (num >> 7) & 0x7F], [0xC0 | ch, num & 0x7F]],
  };

  const ascii = arr => String.fromCharCode(...arr.filter(c => c >= 0x20 && c < 0x7F)).replace(/\s+$/, '');

  // Parse an incoming message. Returns {type, ...} or null when it is not ours.
  function parse(d) {
    d = Array.from(d);
    if (d[0] !== 0xF0) {
      const st = d[0] & 0xF0, ch = d[0] & 0x0F;
      if (st === 0xC0) return { type: 'pc', ch, program: d[1] };
      if (st === 0xB0) return { type: 'cc', ch, cc: d[1], value: d[2] };
      return null;
    }
    if (d.length < 7 || d[d.length - 1] !== 0xF7) return null;
    for (let i = 0; i < 5; i++) if (d[i] !== HDR[i]) return null;
    const cmd = d[5];
    // Realtime push data carries no checksum (tempo beat: 7 bytes, tuner: 10 bytes)
    if (cmd === CMD.TAP && d.length === 7) return { type: 'beat' };
    if (cmd === CMD.TUNER && d.length === 10) {
      return { type: 'tuner', note: d[6], string: d[7], cents: d[8] - 63 };
    }
    const cs = d[d.length - 2];
    const okCs = checksum(d.slice(0, d.length - 2)) === cs;
    const p = d.slice(6, d.length - 2);
    const r = { cmd, okCs };
    switch (cmd) {
      case CMD.BYPASS: return { ...r, type: 'bypass', id: from14(p[0], p[1]), bypassed: p[2] === 1 };
      case CMD.CHANNEL: return { ...r, type: 'channel', id: from14(p[0], p[1]), channel: p[2] };
      case CMD.SCENE: return { ...r, type: 'scene', scene: p[0] };
      case CMD.PATCH_NAME: return { ...r, type: 'patch', number: from14(p[0], p[1]), name: ascii(p.slice(2, 34)) };
      case CMD.SCENE_NAME: return { ...r, type: 'sceneName', scene: p[0], name: ascii(p.slice(1, 33)) };
      case CMD.LOOPER: return { ...r, type: 'looper', state: p[0] };
      case CMD.TEMPO: return { ...r, type: 'tempo', bpm: from14(p[0], p[1]) };
      case CMD.FIRMWARE: return { ...r, type: 'firmware', major: p[0], minor: p[1] };
      case CMD.STATUS_DUMP: {
        const blocks = [];
        for (let i = 0; i + 2 < p.length; i += 3) {
          const dd = p[i + 2];
          blocks.push({ id: from14(p[i], p[i + 1]), bypassed: !!(dd & 1), channel: (dd >> 1) & 7, channels: (dd >> 4) & 7 });
        }
        return { ...r, type: 'dump', blocks };
      }
      default: return { ...r, type: 'unknown', data: p };
    }
  }

  const NOTES = ['A','A#','B','C','C#','D','D#','E','F','F#','G','G#'];
  return { HDR, CMD, ID, ID_NAME, checksum, build, lsb14, from14, msg, parse, blockInfo, DEFAULT_BLOCKS, NOTES };
})();
if (typeof module !== 'undefined') module.exports = P;
