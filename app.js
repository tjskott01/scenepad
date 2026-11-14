'use strict';
const APP_VERSION = '1.1.0';
(() => {
  const $ = id => document.getElementById(id);
  const hex = a => Array.from(a).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
  const pad3 = n => String(n).padStart(3, '0');
  const store = { get: (k, d) => { try { return JSON.parse(localStorage.getItem('sp.' + k)) ?? d; } catch { return d; } },
    set: (k, v) => { try { localStorage.setItem('sp.' + k, JSON.stringify(v)); } catch {} } };

  // ---------- state ----------
  const S = { mode: 'off', preset: null, presetName: '', scene: 0, sceneNames: Array(8).fill(''),
    blocks: new Map(), dumpSeen: false, tempo: null, tuner: false, tunerAuto: false, lastTune: 0, fw: '' };
  let access = null, input = null, output = null, demo = null;
  const names = store.get('names', {}); // preset number -> name cache (for the picker)
  const midiCh = () => +$('chSel').value || 0;

  // ---------- log ----------
  const logLines = [];
  function log(dir, d) {
    if (d[0] === 0xF0 && d[5] === 0x11 && d.length === 10) return; // skip tuner flood
    if (d[0] === 0xF0 && d[5] === 0x10 && d.length === 7) return;  // skip beat pulses
    logLines.unshift(`${new Date().toLocaleTimeString()} ${dir} ${hex(d)}`);
    logLines.length = Math.min(logLines.length, 80);
    if (!$('settings').classList.contains('hidden')) $('log').textContent = logLines.join('\n');
  }
  function toast(t, ms = 2200) { const el = $('toast'); el.textContent = t; el.classList.remove('hidden'); clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.add('hidden'), ms); }

  // ---------- transport ----------
  let nextAt = 0;
  function send(d) {
    if (S.mode === 'demo') { log('→', d); demo.send(d); return true; }
    if (S.mode !== 'midi' || !output) return false;
    // Space messages ~6 ms apart so bursts (8 scene-name queries) don't overrun the unit's input.
    const now = performance.now(); nextAt = Math.max(now, nextAt + 6);
    try { output.send(d, nextAt); log('→', d); return true; } catch (e) { log('!', [0]); toast('Send failed: ' + e.message); return false; }
  }
  const rawListeners = new Set();
  function receive(d) {
    for (const fn of rawListeners) { try { fn(Array.from(d)); } catch (e) { console.warn(e); } }
    log('←', d);
    const m = P.parse(d); if (!m) return;
    switch (m.type) {
      case 'patch':
        names[m.number] = m.name; saveNames();
        if (pickerWaiting.has(m.number)) { pickerWaiting.delete(m.number); renderPicker(); }
        { // Replies arrive in request order; match against what we asked for.
          const exp = patchQ.length ? patchQ.shift() : 'cur';
          if (exp !== 'cur' && exp === m.number) break;
          const changed = m.number !== S.preset;
          S.preset = m.number; S.presetName = m.name; renderPreset();
          if (changed) refreshPresetDetails();
        }
        break;
      case 'scene': if (m.scene !== S.scene) { S.scene = m.scene; renderScenes(); } break;
      case 'sceneName': if (m.scene < 8) { S.sceneNames[m.scene] = m.name; renderScenes(); } break;
      case 'bypass': { const b = getBlock(m.id); b.bypassed = m.bypassed; renderBlocks(); break; }
      case 'channel': { const b = getBlock(m.id); b.channel = m.channel; renderBlocks(); break; }
      case 'dump': {
        S.blocks = new Map(); S.dumpSeen = true;
        for (const b of m.blocks) if (P.blockInfo(b.id)) S.blocks.set(b.id, b);
        renderBlocks(); break;
      }
      case 'tempo': if (m.bpm >= 20 && m.bpm <= 300) { S.tempo = m.bpm; $('bpm').textContent = m.bpm; } break;
      case 'beat': flashLed(); break;
      case 'tuner': onTuner(m); break;
      case 'firmware': S.fw = `Firmware ${m.major}.${String(m.minor).padStart(2, '0')}`; $('fwLine').textContent = S.fw; break;
      case 'pc': if (m.ch === midiCh()) { queryCurrent(); } break; // unit (or another controller) changed preset
      case 'cc': break;
    }
  }
  function getBlock(id) { if (!S.blocks.has(id)) S.blocks.set(id, { id, bypassed: false, channel: 0, channels: 0 }); return S.blocks.get(id); }
  let saveT; function saveNames() { clearTimeout(saveT); saveT = setTimeout(() => store.set('names', names), 800); }

  // ---------- queries ----------
  const patchQ = [];
  function askName(n = null) { if (patchQ.length > 60) patchQ.length = 0; patchQ.push(n == null ? 'cur' : n); send(P.msg.getPatchName(n)); }
  function queryCurrent() { askName(); send(P.msg.getScene()); }
  function refreshPresetDetails() {
    S.sceneNames = Array(8).fill(''); renderScenes();
    for (let s = 0; s < 8; s++) send(P.msg.getSceneName(s));
    send(P.msg.statusDump());
    send(P.msg.getTempo());
  }
  function fullRefresh() { send(P.msg.getFirmware()); queryCurrent(); refreshPresetDetails(); }
  let pollT = null, tick = 0;
  function startPolling() {
    clearInterval(pollT);
    pollT = setInterval(() => {
      if (S.mode === 'off' || S.pausePoll || !$('pollChk').checked || document.hidden) return;
      tick++;
      queryCurrent();
      if (tick % 3 === 0 && !S.tuner) { send(P.msg.statusDump()); send(P.msg.getTempo()); }
      if (S.tunerAuto && performance.now() - S.lastTune > 1500) closeTuner(false);
    }, 1000);
  }

  // ---------- actions ----------
  function changePreset(n) {
    n = Math.max(0, Math.min(1023, n | 0));
    if (S.mode === 'off') return toast('Connect MIDI or start Demo first');
    for (const m of P.msg.presetChange(n, midiCh())) send(m);
    S.preset = n; S.presetName = names[n] || '…'; renderPreset();
    setTimeout(() => { queryCurrent(); refreshPresetDetails(); }, 120);
  }
  function selectScene(s) {
    if (S.mode === 'off') return toast('Connect MIDI or start Demo first');
    S.scene = s; renderScenes(); send(P.msg.setScene(s));
    setTimeout(() => send(P.msg.statusDump()), 150); // scene changes bypass/channel states
  }
  function toggleBlock(id) { const b = getBlock(id); b.bypassed = !b.bypassed; renderBlocks(); send(P.msg.setBypass(id, b.bypassed)); }
  function setChannel(id, ch) { const b = getBlock(id); b.channel = ch; renderBlocks(); send(P.msg.setChannel(id, ch)); }
  function tap() { if (S.mode === 'off') return; send(P.msg.tap()); flashLed(); clearTimeout(tap.t); tap.t = setTimeout(() => send(P.msg.getTempo()), 400); }
  function nudgeTempo(d) { if (S.mode === 'off' || !S.tempo) return; S.tempo = Math.max(24, Math.min(250, S.tempo + d)); $('bpm').textContent = S.tempo; send(P.msg.setTempo(S.tempo)); }
  function flashLed() { const l = $('led'); l.classList.add('flash'); clearTimeout(flashLed.t); flashLed.t = setTimeout(() => l.classList.remove('flash'), 90); }

  // ---------- tuner ----------
  function openTuner(sendCmd = true) {
    S.tuner = true; $('tuner').classList.remove('hidden'); $('tunerBtn').classList.add('active');
    if (sendCmd) { S.tunerAuto = false; send(P.msg.tuner(true)); }
    $('tHint').classList.toggle('hidden', S.mode === 'demo');
    S.lastTune = 0; $('tCents').textContent = 'waiting for tuner data…';
  }
  function closeTuner(sendCmd = true) {
    S.tuner = false; S.tunerAuto = false; $('tuner').classList.add('hidden'); $('tunerBtn').classList.remove('active');
    if (sendCmd) send(P.msg.tuner(false));
  }
  function onTuner(m) {
    if (S.diag) return; // diagnostics screen handles tuner data itself
    if (!S.tuner) { openTuner(false); S.tunerAuto = true; } // tuner engaged on the unit itself
    S.lastTune = performance.now();
    const note = P.NOTES[m.note] ?? '?', ok = Math.abs(m.cents) <= 3;
    $('tNote').textContent = note; $('tNote').classList.toggle('ok', ok);
    $('tString').textContent = 'String ' + (6 - m.string) + ' · ' + ['low E', 'A', 'D', 'G', 'B', 'high E'][m.string];
    const c = Math.max(-50, Math.min(50, m.cents));
    $('needle').style.left = (50 + c) + '%'; $('needle').classList.toggle('ok', ok);
    $('tCents').textContent = (m.cents > 0 ? '+' : '') + m.cents + ' ¢';
    $('tHint').classList.add('hidden');
  }

  // ---------- rendering ----------
  function renderPreset() {
    $('presetNum').textContent = S.preset == null ? '---' : 'PRESET ' + pad3(S.preset);
    $('presetName').textContent = S.mode === 'off' ? 'No device' : (S.presetName || '…');
    $('sceneName').textContent = S.mode === 'off' ? '\u00a0' : `Scene ${S.scene + 1}${S.sceneNames[S.scene] ? ' · ' + S.sceneNames[S.scene] : ''}`;
  }
  function renderScenes() {
    const box = $('scenes');
    if (!box.children.length) for (let i = 0; i < 8; i++) {
      const b = document.createElement('button'); b.className = 'scene'; b.dataset.s = i;
      b.innerHTML = `<span class="n">SCENE ${i + 1}</span><span class="t"></span>`;
      b.addEventListener('click', () => selectScene(i)); box.appendChild(b);
    }
    [...box.children].forEach((b, i) => { b.classList.toggle('active', i === S.scene && S.mode !== 'off'); b.querySelector('.t').textContent = S.sceneNames[i] || `Scene ${i + 1}`; });
    renderPreset();
  }
  function renderBlocks() {
    const box = $('blocks'); box.innerHTML = '';
    let ids = S.dumpSeen ? [...S.blocks.keys()] : P.DEFAULT_BLOCKS;
    const order = ['FUZZ', 'COMP', 'DISTORT', 'CAB', 'WAH', 'PITCH', 'CHORUS', 'FLANGER', 'PHASER', 'TREMOLO', 'DELAY', 'MULTITAP', 'PLEX', 'MEGATAP', 'TENTAP', 'REVERB'];
    const rank = id => { const i = P.blockInfo(id); const r = order.indexOf(i.base); return (r < 0 ? 99 : r) * 10 + i.inst; };
    ids = ids.filter(id => P.blockInfo(id)).sort((a, b) => rank(a) - rank(b));
    for (const id of ids) {
      const info = P.blockInfo(id), st = S.blocks.get(id) || { bypassed: true, channel: 0, channels: 0 };
      const el = document.createElement('button');
      el.className = 'block' + (st.bypassed ? '' : ' on'); el.dataset.id = id;
      el.innerHTML = `<span class="lamp"></span><span>${info.label}</span>`;
      if (st.channels > 1) {
        const chs = document.createElement('span'); chs.className = 'chs';
        for (let c = 0; c < Math.min(4, st.channels); c++) {
          const x = document.createElement('span'); x.className = 'ch' + (c === st.channel ? ' sel' : ''); x.textContent = 'ABCD'[c];
          x.addEventListener('click', e => { e.stopPropagation(); setChannel(id, c); }); chs.appendChild(x);
        }
        el.appendChild(chs);
      }
      el.addEventListener('click', () => { if (S.mode === 'off') return toast('Connect MIDI or start Demo first'); toggleBlock(id); });
      box.appendChild(el);
    }
  }
  function setStatus(text, cls) { $('connText').textContent = text; $('dot').className = 'dot ' + (cls || ''); }

  // ---------- preset picker ----------
  let page = 0; const PER = 20; const pickerWaiting = new Set();
  function openPicker() { page = Math.floor((S.preset || 0) / PER); $('picker').classList.remove('hidden'); renderPicker(true); }
  function renderPicker(fetch = false) {
    const start = page * PER; $('pgLabel').textContent = `${pad3(start)}–${pad3(Math.min(1023, start + PER - 1))}`;
    const list = $('plist'); list.innerHTML = '';
    for (let n = start; n < Math.min(1024, start + PER); n++) {
      const b = document.createElement('button'); b.className = 'pitem' + (n === S.preset ? ' cur' : '');
      b.innerHTML = `<b>${pad3(n)}</b>`; b.append(names[n] ?? (S.mode === 'off' ? '' : '…'));
      b.addEventListener('click', () => { $('picker').classList.add('hidden'); changePreset(n); });
      list.appendChild(b);
      if (fetch && S.mode !== 'off') { pickerWaiting.add(n); askName(n); }
    }
  }

  // ---------- MIDI setup ----------
  function fillPorts() {
    const fill = (sel, ports, saved) => {
      sel.innerHTML = '';
      const arr = [...ports.values()];
      if (!arr.length) sel.innerHTML = '<option value="">(no ports found)</option>';
      for (const p of arr) { const o = document.createElement('option'); o.value = p.id; o.textContent = p.name + (p.manufacturer ? ` (${p.manufacturer})` : ''); sel.appendChild(o); }
      const pick = arr.find(p => p.id === saved) || arr.find(p => /axe|fractal/i.test(p.name)) || arr[0];
      if (pick) sel.value = pick.id;
    };
    fill($('inSel'), access.inputs, store.get('in')); fill($('outSel'), access.outputs, store.get('out'));
  }
  async function requestMidi() {
    if (!navigator.requestMIDIAccess) { toast('This browser has no Web MIDI. Use Chrome on Android.'); return false; }
    try { access = await navigator.requestMIDIAccess({ sysex: true }); }
    catch (e) { toast('MIDI permission denied: ' + e.message, 4000); return false; }
    access.onstatechange = () => { fillPorts(); if (S.mode === 'midi' && output && output.state === 'disconnected') { setStatus('Cable unplugged', ''); } };
    fillPorts(); return true;
  }
  async function connectMidi() {
    if (!access && !(await requestMidi())) return;
    stopDemo();
    if (input) input.onmidimessage = null;
    input = access.inputs.get($('inSel').value) || null; output = access.outputs.get($('outSel').value) || null;
    if (!output) { toast('No MIDI output selected. Is the cable in and the phone in USB-MIDI mode?', 4000); return; }
    store.set('in', input && input.id); store.set('out', output.id); store.set('ch', midiCh());
    if (input) input.onmidimessage = e => receive(e.data);
    S.mode = 'midi'; S.dumpSeen = false; S.blocks = new Map();
    setStatus(output.name, 'ok'); $('settings').classList.add('hidden');
    renderBlocks(); fullRefresh(); startPolling(); wake();
    if (!input) toast('No MIDI input: commands work, but the screen cannot follow the unit.', 4000);
  }
  function startDemo() {
    if (input) input.onmidimessage = null; input = output = null;
    demo = new DemoDevice(d => receive(d));
    S.mode = 'demo'; S.dumpSeen = false; S.blocks = new Map(); S.preset = null;
    setStatus('Demo mode', 'demo'); $('demoBtn').classList.add('active');
    renderBlocks(); fullRefresh(); startPolling(); wake();
  }
  function stopDemo() { if (demo) { demo.close(); demo = null; } $('demoBtn').classList.remove('active'); }
  function toggleDemo() {
    if (S.mode === 'demo') { stopDemo(); closeTuner(false); S.mode = 'off'; S.preset = null; S.sceneNames = Array(8).fill(''); S.dumpSeen = false; S.blocks = new Map(); S.tempo = null; $('bpm').textContent = '---'; setStatus('Not connected', ''); renderScenes(); renderBlocks(); }
    else startDemo();
  }

  // ---------- screen ----------
  let lock = null;
  async function wake() { if (!$('wakeChk').checked || !('wakeLock' in navigator)) return; try { lock = await navigator.wakeLock.request('screen'); } catch {} }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && S.mode !== 'off') wake(); });

  // ---------- wiring ----------
  function init() {
    for (let c = 0; c < 16; c++) { const o = document.createElement('option'); o.value = c; o.textContent = 'Channel ' + (c + 1); $('chSel').appendChild(o); }
    $('chSel').value = store.get('ch', 0);
    $('midiSupport').textContent = navigator.requestMIDIAccess
      ? (window.isSecureContext ? 'Web MIDI available. Plug in the cable, then tap Connect MIDI and allow MIDI device access.' : 'Web MIDI needs HTTPS.')
      : 'This browser has no Web MIDI support. Use Chrome (or Brave) on Android. Demo mode still works.';
    $('connBtn').onclick = () => { $('log').textContent = logLines.join('\n'); $('settings').classList.remove('hidden'); };
    $('connectBtn').onclick = connectMidi;
    $('refreshBtn').onclick = async () => { if (access) fillPorts(); else await requestMidi(); };
    $('demoBtn').onclick = toggleDemo;
    $('prevBtn').onclick = () => changePreset((S.preset ?? 1) - 1);
    $('nextBtn').onclick = () => changePreset((S.preset ?? -1) + 1);
    $('presetBox').onclick = openPicker;
    $('pgPrev').onclick = () => { page = Math.max(0, page - 1); renderPicker(true); };
    $('pgNext').onclick = () => { page = Math.min(Math.floor(1023 / PER), page + 1); renderPicker(true); };
    $('goBtn').onclick = () => { const v = $('presetInput').value; if (v !== '') { $('picker').classList.add('hidden'); changePreset(+v); } };
    $('presetInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('goBtn').click(); });
    $('tunerBtn').onclick = () => { if (S.mode === 'off') return toast('Connect MIDI or start Demo first'); S.tuner ? closeTuner() : openTuner(); };
    $('tunerClose').onclick = () => closeTuner();
    $('tapBtn').addEventListener('pointerdown', e => { e.preventDefault(); tap(); }); // pointerdown: no click delay for tap tempo
    $('tempoDown').onclick = () => nudgeTempo(-1); $('tempoUp').onclick = () => nudgeTempo(1);
    $('fsBtn').onclick = () => { document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.().catch(() => {}); };
    document.querySelectorAll('[data-close]').forEach(b => b.onclick = () => $(b.dataset.close).classList.add('hidden'));
    renderScenes(); renderBlocks(); renderPreset();
    if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
    if (new URLSearchParams(location.search).has('demo')) startDemo();
    // Re-open MIDI silently if permission was granted before.
    if (navigator.permissions && navigator.requestMIDIAccess && !new URLSearchParams(location.search).has('demo')) {
      navigator.permissions.query({ name: 'midi', sysex: true }).then(r => { if (r.state === 'granted') requestMidi().then(ok => ok && store.get('out') && access.outputs.get(store.get('out')) && connectMidi()); }).catch(() => {});
    }
  }
  window.ScenePad = { S, send, receive, startDemo, connectMidi, requestMidi, VERSION: APP_VERSION,
    getIO: () => ({ access, input, output, mode: S.mode }),
    onRaw: fn => rawListeners.add(fn), offRaw: fn => rawListeners.delete(fn) };
  init();
})();
