// Simulated Axe-Fx III. It answers the same SysEx the real unit does, so demo mode
// exercises the real protocol code (build -> parse) end to end.
'use strict';
function DemoDevice(onMessage) {
  const { ID, msg, build, lsb14, CMD, from14 } = P;
  const NAMES = ['Clean Machine','Plexi Crunch','Worship Ambient','Lead Scream','Edge of Breakup',
    'Rhythm Metal','Country Chicken','Shimmer Pad','Blues Driver','Funk Wah','Djent Tight','Acoustic Sim',
    'Fuzz Factory','Surf Spring','Big Room Lead','Swell Machine'];
  const SCN = [['Clean','Crunch','Rhythm','Lead','Ambient','Swell','Solo','Outro'],
    ['Verse','Chorus','Bridge','Solo','Intro','Breakdown','Tag','Pad']];
  const state = { preset: 0, scene: 0, tempo: 120, tuner: false, blocks: {} };
  const PRESET_BLOCKS = [ID.COMP1, ID.FUZZ1, ID.DISTORT1, ID.CAB1, ID.CHORUS1, ID.DELAY1, ID.DELAY2,
    ID.REVERB1, ID.PITCH1, ID.PHASER1, ID.WAH1, ID.VOLUME1];
  const presetName = n => n < NAMES.length * 4 ? NAMES[n % NAMES.length] + (n >= NAMES.length ? ' ' + (1 + Math.floor(n / NAMES.length)) : '') : 'Preset ' + n;
  function loadPreset(n) {
    state.preset = n; state.scene = 0; state.blocks = {};
    PRESET_BLOCKS.forEach((id, i) => {
      const chs = id === ID.CAB1 ? 4 : (i % 3 === 0 ? 2 : 4);
      state.blocks[id] = { bypassed: ((n + i) % 3) === 0 && id !== ID.DISTORT1 && id !== ID.CAB1, channel: (n + i) % chs, channels: chs };
    });
  }
  loadPreset(0);
  const pad = (s, n = 32) => Array.from((s + ' '.repeat(n)).slice(0, n)).map(c => c.charCodeAt(0));
  const reply = (cmd, data) => setTimeout(() => onMessage(build(cmd, data)), 12);
  const sceneNames = () => SCN[state.preset % 2];

  let beat = null, tune = null, t0 = 0;
  function startBeat() {
    clearInterval(beat);
    beat = setInterval(() => { if (!state.tuner) onMessage([0xF0, 0, 1, 0x74, 0x10, 0x10, 0xF7]); }, 60000 / state.tempo);
  }
  startBeat();

  let bank = 0;
  this.send = (d) => {
    d = Array.from(d);
    if ((d[0] & 0xF0) === 0xB0 && d[1] === 0) { bank = d[2]; return; }
    if ((d[0] & 0xF0) === 0xC0) { loadPreset(Math.min(1023, bank * 128 + d[1])); return; }
    if (d[0] !== 0xF0) return;
    const cmd = d[5], p = d.slice(6, d.length - 2);
    switch (cmd) {
      case CMD.SCENE: if (p[0] !== 0x7F) state.scene = p[0] & 7; reply(CMD.SCENE, [state.scene]); break;
      case CMD.PATCH_NAME: {
        const n = (p[0] === 0x7F && p[1] === 0x7F) ? state.preset : from14(p[0], p[1]);
        reply(CMD.PATCH_NAME, [...lsb14(n), ...pad(presetName(n))]); break;
      }
      case CMD.SCENE_NAME: {
        const s = p[0] === 0x7F ? state.scene : p[0];
        reply(CMD.SCENE_NAME, [s, ...pad(sceneNames()[s])]); break;
      }
      case CMD.BYPASS: case CMD.CHANNEL: {
        const id = from14(p[0], p[1]), b = state.blocks[id]; if (!b) break;
        if (p[2] !== 0x7F) { if (cmd === CMD.BYPASS) b.bypassed = p[2] === 1; else b.channel = Math.min(p[2], b.channels - 1); }
        reply(cmd, [p[0], p[1], cmd === CMD.BYPASS ? (b.bypassed ? 1 : 0) : b.channel]); break;
      }
      case CMD.STATUS_DUMP: {
        const out = [];
        for (const [id, b] of Object.entries(state.blocks)) out.push(...lsb14(+id), (b.bypassed ? 1 : 0) | (b.channel << 1) | (b.channels << 4));
        reply(CMD.STATUS_DUMP, out); break;
      }
      case CMD.TEMPO: if (!(p[0] === 0x7F && p[1] === 0x7F)) { state.tempo = Math.max(24, Math.min(250, from14(p[0], p[1]))); startBeat(); }
        reply(CMD.TEMPO, lsb14(state.tempo)); break;
      case CMD.TAP: {
        const now = performance.now();
        if (t0 && now - t0 < 2500) { state.tempo = Math.round(60000 / (now - t0)); startBeat(); }
        t0 = now; break;
      }
      case CMD.TUNER: {
        state.tuner = p[0] === 1; clearInterval(tune);
        if (state.tuner) {
          let k = 0; const strings = [[7, 0], [0, 1], [5, 2], [10, 3], [2, 4], [7, 5]]; // E A D G B E (0 = A)
          tune = setInterval(() => {
            k++; const [note, str] = strings[Math.floor(k / 60) % 6];
            const cents = Math.round(Math.sin(k / 9) * 30 * Math.max(0.05, 1 - (k % 60) / 45));
            onMessage([0xF0, 0, 1, 0x74, 0x10, 0x11, note, str, 63 + cents, 0xF7]);
          }, 50);
        }
        break;
      }
      case 0x1F: { // simulated bulk-read burst (shape per community RE; values are fake)
        const id = from14(p[0], p[1]); if (!state.blocks[id]) { reply(0x64, [0x1F, 0x00]); break; }
        const per = 50, vals = []; for (let i = 0; i < per * 4; i++) vals.push((i * 2731 + id * 97) % 65535);
        const tri = v => [v & 0x7F, (v >> 7) & 0x7F, (v >> 14) & 0x03];
        setTimeout(() => {
          onMessage(build(0x74, [...lsb14(id), ...lsb14(per * 4), 0]));
          onMessage(build(0x75, [0, 0, ...vals.slice(0, 128).flatMap(tri)]));
          onMessage(build(0x75, [1, 0, ...vals.slice(128).flatMap(tri)]));
          onMessage(build(0x76, []));
        }, 15);
        break;
      }
      case CMD.FIRMWARE: reply(CMD.FIRMWARE, [32, 0, 0, 0, 0]); break;
    }
  };
  this.close = () => { clearInterval(beat); clearInterval(tune); };
  this.name = 'Demo unit (simulated)';
}
