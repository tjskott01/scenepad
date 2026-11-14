'use strict';
const APP_VERSION = '1.3.0';
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
      // A GET reply for a block that is not in the preset still answers (value 0) on fw 18.03, so the
      // status dump is the only source of truth for presence: ignore replies for blocks it didn't list.
      case 'bypass': { if (S.dumpSeen && !S.blocks.has(m.id)) break; const b = getBlock(m.id); b.bypassed = m.bypassed; renderBlocks(); break; }
      case 'channel': { if (S.dumpSeen && !S.blocks.has(m.id)) break; const b = getBlock(m.id); b.channel = m.channel; renderBlocks(); break; }
      case 'dump': {
        S.blocks = new Map(); S.dumpSeen = true;
        for (const b of m.blocks) if (P.blockInfo(b.id)) S.blocks.set(b.id, b);
        S.allBlocks = m.blocks; renderBlocks(); ampBtnState(); break;
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
    for (const m of P.msg.presetChange(n, midiCh(), +$('bankSel').value || 0)) send(m);
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

  // ---------- Amp panel (read-only, fn 0x1F bulk read) ----------
  const AMP_KNOBS = [['Gain', 1], ['Bass', 2], ['Mid', 3], ['Treble', 4], ['Master', 5]];
  let ampId = P.ID.DISTORT1, ampBusy = false;
  const ampName = v => (typeof AMP_TYPES !== 'undefined' && AMP_TYPES[v]) ? AMP_TYPES[v] : 'Type #' + v;
  const knob = v => v == null || v > 65534 ? null : v / 65534 * 10;
  function ampBtnState() {
    const amps = (S.allBlocks || []).filter(b => b.id === P.ID.DISTORT1 || b.id === P.ID.DISTORT2);
    $('ampBtn').classList.toggle('hidden', S.mode === 'off');
    $('ampSel').innerHTML = '';
    for (const id of (amps.length ? amps.map(b => b.id) : [P.ID.DISTORT1])) {
      const o = document.createElement('option'); o.value = id; o.textContent = P.blockName(id); $('ampSel').appendChild(o);
    }
    if ([...$('ampSel').options].some(o => +o.value === ampId)) $('ampSel').value = ampId; else ampId = +$('ampSel').value;
  }
  // Bulk read helper (shared with diagnostics). Resolves {bulk, frames, nack}.
  function readBulk(id, timeout = 2500) {
    return new Promise(resolve => {
      const frames = []; let done = false;
      const h = d => { if (d[0] === 0xF0 && d[3] === 0x74 && d[4] === 0x10 && [0x74, 0x75, 0x76, 0x64].includes(d[5])) { frames.push(d); if (d[5] === 0x76 || d[5] === 0x64) fin(); } };
      const fin = () => { if (done) return; done = true; rawListeners.delete(h); clearTimeout(t); resolve({ frames, bulk: P.parseBulk(frames), nack: frames.some(d => d[5] === 0x64) }); };
      rawListeners.add(h); const t = setTimeout(fin, timeout);
      send(P.msg.bulkRead(id));
    });
  }
  // Demo mode edits the simulator freely; real hardware needs a test-7 pass recorded in MIDI mode.
  const writeOK = () => S.mode === 'demo' ? { demo: true } : ((w => w && w.mode === 'midi' ? w : null)(store.get('writeOK', null)));
  let amp = null;            // last read: {id, ch, stride, values, bypassed}
  const ampOrig = {};        // `${id}:${ch}` -> {pid: wireValue} captured before the first edit
  async function readAmp() {
    if (S.mode === 'off') return toast('Connect MIDI or start Demo first');
    if (ampBusy) return; ampBusy = true; S.pausePoll = true;
    $('ampStatus').textContent = 'Reading…';
    send(P.msg.statusDump()); await new Promise(r => setTimeout(r, 120));
    const { bulk, nack } = await readBulk(ampId);
    ampBusy = false; S.pausePoll = false;
    if (!bulk || !bulk.values.length || !Number.isInteger(bulk.stride)) {
      amp = null; $('ampBody').innerHTML = '';
      $('ampStatus').textContent = nack ? 'The unit rejected the read (block not in this preset?).' : 'No reply from the unit.'; return;
    }
    const st = (S.allBlocks || []).find(b => b.id === bulk.blockId);
    amp = { id: bulk.blockId, ch: st ? st.channel : 0, chans: st && st.channels ? Math.min(4, st.channels) : 4, stride: bulk.stride, values: bulk.values, bypassed: st && st.bypassed };
    renderAmp();
    $('ampStatus').textContent = `Read ${new Date().toLocaleTimeString()} · ${bulk.values.length} values`;
  }
  function renderAmp() {
    if (!amp) return;
    const { ch, chans } = amp, val = (c, pid) => amp.values[c * amp.stride + pid];
    const ok = writeOK(), key = `${amp.id}:${ch}`, edited = !!ampOrig[key];
    $('ampMode').textContent = ok ? 'experimental editor' : 'read-only';
    let html = `<div class="ampType"><small>${P.blockName(amp.id)} · Channel ${'ABCD'[ch]}</small><b>${ampName(val(ch, 0))}</b><span class="dim">type #${val(ch, 0)}${amp.bypassed ? ' · BYPASSED' : ''}</span></div>`;
    html += ok ? `<div class="expBanner">EXPERIMENTAL editing · changes channel ${'ABCD'[ch]} live, not saved to the preset until you save on the unit</div>`
               : `<div class="lockBanner">Editing locked. Run Diagnostics <b>test 7</b> once to verify writes on this unit.<button class="chip" id="ampGoTest">Open test 7</button></div>`;
    html += '<div class="knobs">';
    for (const [k, pid] of AMP_KNOBS) {
      const x = knob(val(ch, pid));
      html += `<div class="knob"><span class="kl">${k}</span><input type="range" min="0" max="10" step="0.01" value="${x == null ? 0 : x.toFixed(2)}" data-pid="${pid}" ${ok ? '' : 'disabled'}><span class="kv" id="kv${pid}">${x == null ? '–' : x.toFixed(2)}</span></div>`;
    }
    html += '</div>';
    if (ok) html += `<div class="row2"><button class="chip" id="ampRestore" ${edited ? '' : 'disabled'}>↺ Restore original values</button></div>`;
    html += '<table class="chTable"><tr><th></th>' + [...Array(chans)].map((_, c) => `<th class="${c === ch ? 'cur' : ''}">${'ABCD'[c]}</th>`).join('') + '</tr>';
    html += '<tr><td>Type</td>' + [...Array(chans)].map((_, c) => `<td class="${c === ch ? 'cur' : ''}">${ampName(val(c, 0))}</td>`).join('') + '</tr>';
    for (const [k, pid] of AMP_KNOBS) html += `<tr><td>${k}</td>` + [...Array(chans)].map((_, c) => { const x = knob(val(c, pid)); return `<td class="${c === ch ? 'cur' : ''}">${x == null ? '–' : x.toFixed(2)}</td>`; }).join('') + '</tr>';
    html += '</table>';
    $('ampBody').innerHTML = html;
    const go = $('ampGoTest'); if (go) go.onclick = () => { $('ampPanel').classList.add('hidden'); window.ScenePadDiag && window.ScenePadDiag.open(); };
    $('ampBody').querySelectorAll('input[type=range]').forEach(inp => {
      inp.addEventListener('input', () => onSlide(+inp.dataset.pid, +inp.value));
      inp.addEventListener('change', () => { clearTimeout(rereadT); rereadT = setTimeout(readAmp, 500); });
    });
    const rb = $('ampRestore'); if (rb) rb.onclick = restoreAmp;
  }
  let slideT = null, slidePending = null, rereadT = null, lastSlide = 0;
  function onSlide(pid, v) {
    if (!amp || !writeOK()) return;
    const key = `${amp.id}:${amp.ch}`;
    if (!ampOrig[key]) { ampOrig[key] = {}; for (const [, p] of AMP_KNOBS) ampOrig[key][p] = amp.values[amp.ch * amp.stride + p]; }
    $('kv' + pid).textContent = v.toFixed(2);
    slidePending = [pid, v];
    const flush = () => { if (!slidePending) return; const [p, x] = slidePending; slidePending = null; lastSlide = performance.now(); send(P.setParamContinuous(amp.id, p, x / 10)); amp.values[amp.ch * amp.stride + p] = Math.round(x / 10 * 65534); };
    clearTimeout(slideT);
    if (performance.now() - lastSlide > 60) flush(); else slideT = setTimeout(flush, 60);
    const rb = $('ampRestore'); if (rb) rb.disabled = false;
  }
  async function restoreAmp() {
    if (!amp) return; const key = `${amp.id}:${amp.ch}`, orig = ampOrig[key]; if (!orig) return;
    for (const [p, w] of Object.entries(orig)) { send(P.setParamContinuous(amp.id, +p, w / 65534)); await new Promise(r => setTimeout(r, 30)); }
    delete ampOrig[key];
    toast('Original values sent. Re-reading…');
    setTimeout(readAmp, 400);
  }

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
    renderBlocks(); ampBtnState(); fullRefresh(); startPolling(); wake();
    if (!input) toast('No MIDI input: commands work, but the screen cannot follow the unit.', 4000);
  }
  function startDemo() {
    if (input) input.onmidimessage = null; input = output = null;
    demo = new DemoDevice(d => receive(d));
    S.mode = 'demo'; S.dumpSeen = false; S.blocks = new Map(); S.preset = null;
    setStatus('Demo mode', 'demo'); $('demoBtn').classList.add('active');
    ampBtnState(); renderBlocks(); fullRefresh(); startPolling(); wake();
  }
  function stopDemo() { if (demo) { demo.close(); demo = null; } $('demoBtn').classList.remove('active'); }
  function toggleDemo() {
    if (S.mode === 'demo') { stopDemo(); closeTuner(false); S.mode = 'off'; S.preset = null; S.sceneNames = Array(8).fill(''); S.dumpSeen = false; S.blocks = new Map(); S.tempo = null; $('bpm').textContent = '---'; setStatus('Not connected', ''); S.allBlocks = null; ampBtnState(); renderScenes(); renderBlocks(); }
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
    $('bankSel').value = store.get('bankcc', 0); $('bankSel').onchange = () => store.set('bankcc', +$('bankSel').value);
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
    $('ampBtn').onclick = () => { $('ampPanel').classList.remove('hidden'); ampBtnState(); readAmp(); };
    $('ampRefresh').onclick = readAmp;
    $('ampSel').onchange = () => { ampId = +$('ampSel').value; readAmp(); };
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
    getIO: () => ({ access, input, output, mode: S.mode }), readBulk, store,
    setWriteOK: v => { store.set('writeOK', v); renderAmp(); },
    onRaw: fn => rawListeners.add(fn), offRaw: fn => rawListeners.delete(fn) };
  init();
})();
