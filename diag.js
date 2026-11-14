// Diagnostics screen: step-by-step protocol tests that produce a plain-text log to paste back.
'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const SP = window.ScenePad;
  const hex = a => Array.from(a).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const t0 = performance.now();
  const ts = () => { const d = new Date(); return d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0'); };
  const lines = [];
  const results = {}; // test number -> {title, verdict, note}
  const TITLES = { 1: 'MIDI ports + SysEx permission', 2: 'Queries (fw, name, scene, scene names, tempo, status dump)',
    3: 'Block ID probe (bypass GET)', 4: 'Tuner on/listen 5 s/off', 5: 'EXPERIMENTAL write test (block + scene, restored)',
    6: 'EXPERIMENTAL param read (fn 0x1F bulk read, Amp 1)', 7: 'WRITE test: Amp 1 Gain +0.1 then restore (gates the Amp editor)' };
  let busy = false;

  function log(s) { lines.push(`[${ts()}] ${s}`); render(); }
  function logRaw(dir, d, note = '') { log(`${dir} ${hex(d)}${note ? '   ' + note : ''}`); }
  let renderT; function render() { clearTimeout(renderT); renderT = setTimeout(() => { const el = $('tLog'); el.textContent = lines.join('\n'); el.scrollTop = el.scrollHeight; }, 30); }
  function verdict(n, v, note = '') {
    results[n] = { v, note }; if (v !== 'running') log(`== TEST ${n} RESULT: ${v.toUpperCase()}${note ? ' · ' + note : ''}`); renderRes();
  }
  function renderRes() {
    const box = $('tRes'); box.innerHTML = '';
    for (const n of Object.keys(TITLES)) {
      const r = results[n]; if (!r) continue;
      const row = document.createElement('div'); row.className = 'tr';
      const cls = { pass: 'pass', fail: 'fail', 'no-reply': 'noreply', running: 'run', partial: 'noreply', info: 'info', skipped: 'info' }[r.v] || 'info';
      row.innerHTML = `<span>${n} · ${TITLES[n]}</span><span class="v ${cls}">${r.v.toUpperCase()}</span>`;
      box.appendChild(row);
    }
  }

  // ---------- transport helpers ----------
  const listeners = new Set();
  let sniff = false, lastSniff = null, sniffRep = 0;
  SP.onRaw(d => {
    for (const fn of listeners) fn(d);
    if (sniff) {
      const h = hex(d);
      if (h === lastSniff) { sniffRep++; if (sniffRep % 25 === 0) log(`RX (same message repeated ×${sniffRep})`); return; }
      if (sniffRep > 0 && sniffRep % 25) log(`RX (previous message repeated ×${sniffRep})`);
      lastSniff = h; sniffRep = 0;
      const m = P.parse(d); logRaw('RX', d, m ? describe(m) : (d[0] === 0xF0 ? sysexInfo(d) : ''));
    }
  });
  function sysexInfo(d) { return d[1] === 0 && d[2] === 1 && d[3] === 0x74 ? `fractal model=0x${d[4].toString(16)} fn=0x${d[5].toString(16)} len=${d.length}` : 'sysex (other maker)'; }
  function describe(m) {
    switch (m.type) {
      case 'pc': return `ProgramChange ch${m.ch + 1} prog=${m.program}`;
      case 'cc': return `CC ch${m.ch + 1} #${m.cc}=${m.value}`;
      case 'patch': return `preset ${m.number} "${m.name}"${cs(m)}`;
      case 'scene': return `scene=${m.scene} (Scene ${m.scene + 1})${cs(m)}`;
      case 'sceneName': return `scene ${m.scene + 1} name "${m.name}"${cs(m)}`;
      case 'tempo': return `tempo=${m.bpm} BPM${cs(m)}`;
      case 'firmware': return `firmware ${m.major}.${String(m.minor).padStart(2, '0')}${cs(m)}`;
      case 'bypass': return `bypass id=${m.id} (${idName(m.id)}) ${m.bypassed ? 'BYPASSED' : 'ENGAGED'}${cs(m)}`;
      case 'channel': return `channel id=${m.id} (${idName(m.id)}) ch=${'ABCDEFGH'[m.channel] || m.channel}${cs(m)}`;
      case 'dump': return `status dump, ${m.blocks.length} entries${cs(m)}`;
      case 'tuner': return `tuner note=${P.NOTES[m.note] ?? m.note} string=${m.string} cents=${m.cents}`;
      case 'beat': return 'tempo beat pulse';
      case 'looper': return `looper state=0b${m.state.toString(2)}${cs(m)}`;
      default: return `fn=0x${m.cmd.toString(16)} (not decoded)${m.cmd === 0x64 ? ' MULTIPURPOSE/NACK echoed fn=0x' + (m.data[0] ?? 0).toString(16) + ' code=' + (m.data[1] ?? '?') : ''}${cs(m)}`;
    }
  }
  const cs = m => (m.okCs === false ? ' [CHECKSUM MISMATCH]' : '');
  function idName(id) { try { const n = P.ID_NAME[id]; return n ? `${n} = ${P.blockName(id)}` : `NOT IN OUR TABLE (${P.blockName(id)})`; } catch (e) { return `#${id} (name error)`; } }

  // Send one message and wait for the first reply matching `match` (or a 0x64 NACK for this fn).
  function request(msg, match, timeout = 700, label = '') {
    return new Promise(resolve => {
      const fn = msg[0] === 0xF0 ? msg[5] : null;
      let done = false;
      const h = d => {
        if (done) return;
        const isNack = d[0] === 0xF0 && d[5] === 0x64 && d[6] === fn;
        if (match(d) || isNack) {
          done = true; listeners.delete(h); clearTimeout(t);
          const m = P.parse(d);
          logRaw('RX', d, isNack ? `NACK (0x64) for fn 0x${fn.toString(16)}, code=${d[7]}` : (m ? describe(m) : ''));
          resolve({ d, m, nack: isNack });
        }
      };
      listeners.add(h);
      const t = setTimeout(() => { if (!done) { done = true; listeners.delete(h); log(`   … no reply within ${timeout} ms${label ? ' (' + label + ')' : ''}`); resolve(null); } }, timeout);
      logRaw('TX', msg, label);
      if (!SP.send(msg)) { done = true; listeners.delete(h); clearTimeout(t); log('   ! send failed (not connected)'); resolve(null); }
    });
  }
  const isFn = f => d => d[0] === 0xF0 && d[1] === 0 && d[2] === 1 && d[3] === 0x74 && d[5] === f;
  function connected() { const io = SP.getIO(); return io.mode !== 'off'; }

  // ---------- tests ----------
  let lastDump = null;
  async function test1() {
    verdict(1, 'running');
    const io0 = SP.getIO();
    log(`Mode: ${io0.mode}. Secure context: ${window.isSecureContext}. Web MIDI API: ${!!navigator.requestMIDIAccess}`);
    if (io0.mode === 'demo') { log('Demo mode active: ports are simulated. Turn Demo off to test the real unit.'); verdict(1, 'info', 'demo mode'); return true; }
    if (!navigator.requestMIDIAccess) { verdict(1, 'fail', 'browser has no Web MIDI (use Chrome on Android)'); return false; }
    try { const p = await navigator.permissions.query({ name: 'midi', sysex: true }); log(`Permission state (midi + sysex) before request: ${p.state}`); } catch (e) { log('Permission query not supported: ' + e.message); }
    let acc;
    try { acc = await navigator.requestMIDIAccess({ sysex: true }); log('requestMIDIAccess({sysex:true}) → GRANTED, sysexEnabled=' + acc.sysexEnabled); }
    catch (e) { log('requestMIDIAccess({sysex:true}) → DENIED: ' + e.name + ' ' + e.message); verdict(1, 'fail', 'sysex permission denied'); return false; }
    const ins = [...acc.inputs.values()], outs = [...acc.outputs.values()];
    log(`Inputs (${ins.length}):`); ins.forEach(p => log(`   IN  "${p.name}" mfr="${p.manufacturer}" id=${p.id} state=${p.state} conn=${p.connection}`));
    log(`Outputs (${outs.length}):`); outs.forEach(p => log(`   OUT "${p.name}" mfr="${p.manufacturer}" id=${p.id} state=${p.state} conn=${p.connection}`));
    if (!outs.length) { verdict(1, 'fail', 'no MIDI ports. Check cable, set USB mode to MIDI'); return false; }
    if (io0.mode !== 'midi') { log('Connecting with auto-selected ports…'); await SP.requestMidi(); await SP.connectMidi(); }
    const io = SP.getIO();
    log(`Using IN="${io.input ? io.input.name : '(none)'}" OUT="${io.output ? io.output.name : '(none)'}"`);
    const axe = outs.some(p => /axe|fractal/i.test(p.name));
    verdict(1, io.output && io.input ? 'pass' : 'partial', `${ins.length} in / ${outs.length} out${axe ? ', Axe-Fx port seen' : ', no port named Axe/Fractal'}`);
    return true;
  }

  async function test2() {
    if (!connected()) { verdict(2, 'fail', 'not connected (run test 1)'); return; }
    verdict(2, 'running');
    let ok = 0, total = 0;
    const step = async (label, msg, f, timeout) => { total++; const r = await request(msg, isFn(f), timeout, label); if (r && !r.nack) ok++; return r; };
    await step('firmware 0x08', P.msg.getFirmware(), 0x08);
    await step('preset name 0x0D (current)', P.msg.getPatchName(), 0x0D);
    await step('scene 0x0C (get)', P.msg.getScene(), 0x0C);
    for (let s = 0; s < 8; s++) await step(`scene name 0x0E #${s}`, P.msg.getSceneName(s), 0x0E, 500);
    await step('tempo 0x14 (get)', P.msg.getTempo(), 0x14);
    const r = await step('status dump 0x13', P.msg.statusDump(), 0x13, 1200);
    if (r && r.m && r.m.type === 'dump') {
      lastDump = r.m.blocks;
      log(`Status dump: ${r.m.blocks.length} blocks in the current preset:`);
      log('   ID   (hex)  our name                    state     ch  chans  raw-dd');
      const raw = r.d.slice(6, r.d.length - 2);
      r.m.blocks.forEach((b, i) => {
        const dd = raw[i * 3 + 2];
        log(`   ${String(b.id).padStart(3)}  0x${b.id.toString(16).padStart(2, '0')}   ${idName(b.id).padEnd(26)}  ${b.bypassed ? 'BYPASSED' : 'ENGAGED '}  ${'ABCDEFGH'[b.channel]}   ${b.channels}      0x${dd.toString(16).padStart(2, '0')}`);
      });
      const unknown = r.m.blocks.filter(b => !P.ID_NAME[b.id]);
      log(unknown.length ? `!! ${unknown.length} ID(s) not in our table: ${unknown.map(b => b.id).join(', ')}` : 'All dump IDs exist in our table. Compare names above with the blocks on the unit\'s grid.');
      if ((raw.length % 3) !== 0) log(`!! dump payload length ${raw.length} is not a multiple of 3`);
    }
    verdict(2, ok === total ? 'pass' : ok ? 'partial' : 'no-reply', `${ok}/${total} replies`);
  }

  async function test3() {
    if (!connected()) { verdict(3, 'fail', 'not connected'); return; }
    verdict(3, 'running');
    const ids = Object.values(P.ID).filter((v, i, a) => a.indexOf(v) === i).sort((a, b) => a - b);
    log(`Probing ${ids.length} effect IDs with read-only bypass GET (F0 00 01 74 10 0A id id 7F cs F7)…`);
    const got = new Map(), others = [];
    const h = d => {
      if (!isFn(0x0A)(d) && !(d[0] === 0xF0 && d[5] === 0x64)) return;
      if (d[5] === 0x64) { others.push(d); return; }
      const m = P.parse(d); if (m) got.set(m.id, { d, m });
    };
    listeners.add(h);
    for (const id of ids) { SP.send(P.msg.getBypass(id)); await sleep(25); }
    log(`   sent ${ids.length} queries (first: ${hex(P.msg.getBypass(ids[0]))}), waiting 1.5 s for replies…`);
    await sleep(1500);
    listeners.delete(h);
    const present = lastDump ? new Set(lastDump.map(b => b.id)) : null;
    log(`Replies: ${got.size}. NACKs (0x64): ${others.length}`);
    log('NOTE: on fw 18.03 blocks NOT in the preset still answer ENGAGED (00). Only the status dump says what is present.');
    for (const id of ids) {
      const g = got.get(id);
      if (g) log(`   ${String(id).padStart(3)} ${idName(id).padEnd(26)} ${g.m.bypassed ? 'BYPASSED' : (g.d[8] === 0 ? 'ENGAGED' : 'value=' + g.d[8])}${present ? (present.has(id) ? '  [in dump]' : '  [NOT in dump]') : ''}   ${hex(g.d)}`);
    }
    const silent = ids.filter(id => !got.has(id));
    log(`No reply for ${silent.length} IDs: ${silent.join(', ')}`);
    others.slice(0, 10).forEach(d => logRaw('RX', d, 'NACK'));
    if (present) {
      const missing = [...present].filter(id => !got.has(id));
      log(missing.length ? `!! IDs present in dump but silent to GET: ${missing.join(', ')}` : 'Every block in the status dump answered the bypass GET.');
    }
    verdict(3, got.size ? 'pass' : 'no-reply', `${got.size}/${ids.length} IDs answered`);
  }

  async function test4() {
    if (!connected()) { verdict(4, 'fail', 'not connected'); return; }
    verdict(4, 'running');
    SP.S.diag = true;
    let n = 0, beats = 0; const samples = [];
    const h = d => { if (isFn(0x11)(d)) { n++; if (samples.length < 6) samples.push(d); } else if (isFn(0x10)(d) && d.length === 7) beats++; };
    listeners.add(h);
    logRaw('TX', P.msg.tuner(true), 'tuner ON'); SP.send(P.msg.tuner(true));
    log('Listening 5 s… (play an open string)');
    await sleep(5000);
    logRaw('TX', P.msg.tuner(false), 'tuner OFF'); SP.send(P.msg.tuner(false));
    await sleep(300);
    listeners.delete(h); SP.S.diag = false;
    samples.forEach(d => { const m = P.parse(d); logRaw('RX', d, m ? describe(m) : ''); });
    log(`Tuner messages received: ${n}. Tempo beat pulses: ${beats}.`);
    if (!n) log('No tuner data. Expected over USB: Fractal says tuner/tempo push data only streams from the 5-pin MIDI OUT jack with "Send Realtime Sysex" ON. Did the unit\'s tuner screen open and close? Please note that in your reply.');
    verdict(4, n ? 'pass' : 'no-reply', n ? `${n} tuner frames` : 'no tuner data (expected over USB)');
  }

  async function test5() {
    if (!connected()) { verdict(5, 'fail', 'not connected'); return; }
    if (!confirm('EXPERIMENTAL: this briefly CHANGES the unit.\n\n• Toggles one effect block bypass and toggles it back\n• Switches to another scene and back\n\nTurn your volume down. Continue?')) { verdict(5, 'skipped', 'cancelled by user'); return; }
    verdict(5, 'running');
    if (!lastDump) { const r = await request(P.msg.statusDump(), isFn(0x13), 1200, 'status dump'); if (r && r.m && r.m.type === 'dump') lastDump = r.m.blocks; }
    let ok = true;
    const prefer = ['DELAY', 'REVERB', 'CHORUS', 'FLANGER', 'PHASER', 'COMP', 'FUZZ', 'PITCH'];
    const cand = (lastDump || []).filter(b => P.blockInfo(b.id)).sort((a, b) => { const r = x => { const i = prefer.indexOf(P.blockInfo(x.id).base); return i < 0 ? 99 : i; }; return r(a) - r(b); })[0];
    if (!cand) { log('No switchable block found in status dump; skipping block toggle.'); ok = false; }
    else {
      const id = cand.id; log(`Block toggle on ${idName(id)} (id ${id})`);
      const a = await request(P.msg.getBypass(id), isFn(0x0A), 700, 'GET before');
      const orig = a && a.m ? a.m.bypassed : cand.bypassed;
      const b = await request(P.msg.setBypass(id, !orig), isFn(0x0A), 700, `SET ${!orig ? 'bypass' : 'engage'}`);
      await sleep(400);
      const c = await request(P.msg.getBypass(id), isFn(0x0A), 700, 'GET after set');
      const d = await request(P.msg.setBypass(id, orig), isFn(0x0A), 700, 'SET restore');
      await sleep(300);
      const e = await request(P.msg.getBypass(id), isFn(0x0A), 700, 'GET after restore');
      const changed = c && c.m && c.m.bypassed === !orig, restored = e && e.m && e.m.bypassed === orig;
      log(`Block: changed=${!!changed} restored=${!!restored} (set echo: ${b ? 'yes' : 'no'}, restore echo: ${d ? 'yes' : 'no'})`);
      ok = ok && changed && restored;
    }
    const s0 = await request(P.msg.getScene(), isFn(0x0C), 700, 'scene GET');
    const cur = s0 && s0.m ? s0.m.scene : 0, other = (cur + 1) % 8;
    await request(P.msg.setScene(other), isFn(0x0C), 700, `scene SET → ${other + 1}`);
    await sleep(500);
    const s1 = await request(P.msg.getScene(), isFn(0x0C), 700, 'scene GET after set');
    await request(P.msg.setScene(cur), isFn(0x0C), 700, `scene SET back → ${cur + 1}`);
    await sleep(500);
    const s2 = await request(P.msg.getScene(), isFn(0x0C), 700, 'scene GET after restore');
    const sOk = s1 && s1.m && s1.m.scene === other && s2 && s2.m && s2.m.scene === cur;
    log(`Scene: switched=${!!(s1 && s1.m && s1.m.scene === other)} restored=${!!(s2 && s2.m && s2.m.scene === cur)}`);
    verdict(5, ok && sOk ? 'pass' : 'fail', 'see log');
  }

  // fn 0x1F block bulk-read poll (read-only; carries only an effect ID). Community RE (FM9 hardware-confirmed,
  // Axe-Fx III unconfirmed): the reply is a 0x74 head + 0x75 body section(s) + 0x76 end; body = one 3-septet
  // 16-bit value per parameter, index = channel * (itemCount/4) + paramId.
  async function test6() {
    if (!connected()) { verdict(6, 'fail', 'not connected'); return; }
    verdict(6, 'running');
    log('Read-only: sends ONLY the fn 0x1F bulk-read poll for Amp 1 (id 58). No parameter writes.');
    log('NOTE: the community fn 0x01 "GET" (sub 09 00, value 0) is byte-identical to a typed SET to 0, so it is NOT sent.');
    const frames = [];
    const h = d => { if (d[0] === 0xF0 && d[3] === 0x74 && [0x74, 0x75, 0x76, 0x64].includes(d[5])) frames.push(d); };
    listeners.add(h);
    const poll = P.build(0x1F, P.lsb14(58));
    logRaw('TX', poll, 'bulk-read poll Amp 1');
    SP.send(poll);
    await sleep(1800);
    listeners.delete(h);
    frames.forEach(d => logRaw('RX', d, `fn=0x${d[5].toString(16)} len=${d.length}`));
    const bulk = P.parseBulk(frames);
    if (!bulk) { verdict(6, frames.length ? 'fail' : 'no-reply', frames.length ? 'NACK / unexpected reply' : 'no burst received'); return; }
    const { blockId, itemCount, stride, values: vals } = bulk;
    log(`Head: block=${blockId} (${idName(blockId)}) itemCount=${itemCount} → per-channel stride ${stride}. Values decoded: ${vals.length}`);
    const amp = (lastDump || []).find(b => b.id === 58); const ch = amp ? amp.channel : 0;
    log(`Amp 1 current channel (from status dump): ${'ABCD'[ch]}`);
    const knob = v => v == null ? 'n/a' : `${v} (≈${(v / 65534 * 10).toFixed(2)} on a 0-10 knob)`;
    const an = v => (typeof AMP_TYPES !== 'undefined' && AMP_TYPES[v]) || '?';
    for (let c = 0; c < 4 && Number.isInteger(stride); c++) log(`   Channel ${'ABCD'[c]}: type #${vals[c * stride]} "${an(vals[c * stride])}"  Gain ${(vals[c * stride + 1] / 65534 * 10).toFixed(2)}  Master ${(vals[c * stride + 5] / 65534 * 10).toFixed(2)}`);
    const cands = [['III catalog map', { Gain: 1, Bass: 2, Mid: 3, Treble: 4, Master: 5 }], ['FM9-style map (+10)', { Gain: 11, Bass: 12, Mid: 13, Treble: 14, Master: 15 }]];
    for (const [label, map] of cands) {
      log(`Candidate ${label}:`);
      for (const [k, pid] of Object.entries(map)) log(`   ${k.padEnd(7)} pid ${String(pid).padStart(2)}: ch ${'ABCD'[ch]} = ${knob(vals[ch * stride + pid])}${Number.isInteger(stride) ? '' : ' (stride not integer!)'}`);
    }
    log('First 40 values (channel A block): ' + vals.slice(0, 40).join(' '));
    log('Compare Gain / Master on the unit\'s Amp 1 screen with the two candidates above.');
    verdict(6, vals.length ? 'pass' : 'partial', `${vals.length} values, itemCount ${itemCount}`);
  }

  // Test 7: one parameter write + restore, verified by bulk read-back. Unlocks the Amp editor when it passes.
  async function test7() {
    if (!connected()) { verdict(7, 'fail', 'not connected'); return; }
    if (!confirm('WRITE TEST: this sets Amp 1 Gain (active channel) up by 0.1, reads it back, then restores the original value and reads again.\n\nNothing is saved to the preset. Continue?')) { verdict(7, 'skipped', 'cancelled'); return; }
    if (!confirm('Second confirmation: send the parameter write now?')) { verdict(7, 'skipped', 'cancelled'); return; }
    verdict(7, 'running');
    const fw = await request(P.msg.getFirmware(), isFn(0x08), 700, 'firmware');
    const fwStr = fw && fw.m && fw.m.type === 'firmware' ? `${fw.m.major}.${String(fw.m.minor).padStart(2, '0')}` : '?';
    const dump = await request(P.msg.statusDump(), isFn(0x13), 1200, 'status dump');
    const amp = dump && dump.m && dump.m.type === 'dump' ? dump.m.blocks.find(b => b.id === 58) : null;
    if (!amp) { verdict(7, 'fail', 'Amp 1 not in this preset'); return; }
    const ch = amp.channel;
    const read = async label => { logRaw('TX', P.msg.bulkRead(58), label); const r = await SP.readBulk(58); log(`   bulk read: ${r.frames.length} frames${r.nack ? ' (NACK)' : ''}`); return r.bulk && Number.isInteger(r.bulk.stride) ? r.bulk : null; };
    const b0 = await read('read original');
    if (!b0) { verdict(7, 'fail', 'bulk read failed'); return; }
    const idx = ch * b0.stride + 1, orig = b0.values[idx];
    const disp = w => (w / 65534 * 10).toFixed(3);
    let target = orig + 6553; if (target > 65534) target = orig - 6553;
    log(`Amp 1 channel ${'ABCD'[ch]} Gain original = ${orig} (${disp(orig)}); target = ${target} (${disp(target)})`);
    const echoes = []; const eh = d => { if (isFn(0x01)(d)) echoes.push(d); }; listeners.add(eh);
    const setMsg = P.setParamContinuous(58, 1, target / 65534);
    logRaw('TX', setMsg, 'SET Gain (fn 01 sub 52 00, float32 normalized)'); SP.send(setMsg);
    await new Promise(r => setTimeout(r, 400));
    echoes.forEach(d => logRaw('RX', d, `fn 0x01 reply len=${d.length}`)); echoes.length = 0;
    const b1 = await read('read after SET');
    const after = b1 ? b1.values[idx] : null;
    const TOL = 140; // ~0.02 on the knob
    const setOK = after != null && Math.abs(after - target) <= TOL;
    log(`After SET: ${after} (${after == null ? '-' : disp(after)}) → ${setOK ? 'MATCHES target' : 'DOES NOT match target'}`);
    if (b1) { const others = [0, 1, 2, 3].filter(c => c !== ch && b1.values[c * b1.stride + 1] !== b0.values[c * b0.stride + 1]); log(others.length ? `!! other channels changed too: ${others.map(c => 'ABCD'[c]).join(',')}` : 'Other channels unchanged.'); }
    const rMsg = P.setParamContinuous(58, 1, orig / 65534);
    logRaw('TX', rMsg, 'RESTORE Gain'); SP.send(rMsg);
    await new Promise(r => setTimeout(r, 400));
    echoes.forEach(d => logRaw('RX', d, `fn 0x01 reply len=${d.length}`)); listeners.delete(eh);
    const b2 = await read('read after RESTORE');
    const back = b2 ? b2.values[idx] : null;
    const restOK = back != null && Math.abs(back - orig) <= TOL;
    log(`After RESTORE: ${back} (${back == null ? '-' : disp(back)}), original ${orig} → ${restOK ? 'RESTORED' : 'NOT RESTORED'}${back != null && back !== orig ? ` (off by ${back - orig} wire units)` : ''}`);
    if (!restOK) log(`!!! Please set Amp 1 channel ${'ABCD'[ch]} Gain back to ${disp(orig)} on the unit (or reload the preset without saving).`);
    const pass = setOK && restOK;
    if (SP.getIO().mode === 'midi') SP.setWriteOK(pass ? { fw: fwStr, at: new Date().toISOString(), app: SP.VERSION, mode: 'midi' } : null);
    else log('(Demo mode: result not stored; the real unit still needs its own test 7.)');
    log(pass ? `Write path VERIFIED on fw ${fwStr}. Amp editor sliders are now unlocked.` : 'Write path NOT verified. Amp editor stays locked.');
    verdict(7, pass ? 'pass' : 'fail', pass ? `write+restore verified (fw ${fwStr})` : (setOK ? 'restore mismatch' : 'write had no effect'));
  }

  const TESTS = { 1: test1, 2: test2, 3: test3, 4: test4, 5: test5, 6: test6, 7: test7 };
  async function run(nums) {
    if (busy) return; busy = true; SP.S.pausePoll = true;
    document.querySelectorAll('#testScreen [data-t], #tRunAll').forEach(b => b.disabled = true);
    try {
      for (const n of nums) {
        log(`──────── TEST ${n}: ${TITLES[n]} ────────`);
        try { const r = await TESTS[n](); if (n === 1 && r === false && nums.length > 1) { log('Stopping: no usable MIDI connection.'); break; } }
        catch (e) { log('!! exception: ' + (e && e.stack || e)); verdict(n, 'fail', 'exception'); }
      }
    } finally {
      busy = false; SP.S.pausePoll = sniff; SP.S.diag = false;
      document.querySelectorAll('#testScreen [data-t], #tRunAll').forEach(b => b.disabled = false);
    }
  }

  function header() {
    const io = SP.getIO();
    return [
      `ScenePad diagnostics log`,
      `App version: ${SP.VERSION}   URL: ${location.href}`,
      `Time: ${new Date().toString()}`,
      `User agent: ${navigator.userAgent}`,
      `Screen: ${screen.width}x${screen.height} @${devicePixelRatio}  Secure: ${isSecureContext}  WebMIDI: ${!!navigator.requestMIDIAccess}`,
      `Mode: ${io.mode}  IN: ${io.input ? io.input.name : '-'}  OUT: ${io.output ? io.output.name : '-'}  PC channel: ${(+document.getElementById('chSel').value || 0) + 1}`,
      `Write path: ${JSON.stringify(SP.store.get('writeOK', null))}`,
      `Summary: ${Object.entries(results).map(([n, r]) => `T${n}=${r.v.toUpperCase()}${r.note ? ' (' + r.note + ')' : ''}`).join('; ') || 'no tests run'}`,
      '────────────────────────────────────────',
    ].join('\n');
  }
  const fullText = () => header() + '\n' + lines.join('\n') + '\n';
  async function copy() {
    const text = fullText();
    try { await navigator.clipboard.writeText(text); toast('Log copied. Paste it into the chat.'); }
    catch { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); toast('Log copied.'); } catch { toast('Copy failed. Long-press the log to select it.'); } ta.remove(); }
  }
  async function share() {
    const text = fullText();
    if (navigator.share) { try { await navigator.share({ title: 'ScenePad diagnostics', text }); return; } catch (e) { if (e.name === 'AbortError') return; } }
    copy();
  }
  function toast(t) { const el = $('toast'); el.textContent = t; el.classList.remove('hidden'); clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.add('hidden'), 2500); }

  function open() { $('testScreen').classList.remove('hidden'); $('settings').classList.add('hidden'); $('tVer').textContent = 'v' + SP.VERSION; if (!lines.length) log(`Diagnostics opened. App v${SP.VERSION}. Mode: ${SP.getIO().mode}.`); }
  $('openTest').onclick = open;
  $('testClose').onclick = () => { $('testScreen').classList.add('hidden'); };
  $('tRunAll').onclick = () => run([1, 2, 3, 4, 6]);
  document.querySelectorAll('#testScreen [data-t]').forEach(b => b.onclick = () => run([+b.dataset.t]));
  $('tCopy').onclick = copy; $('tShare').onclick = share;
  $('tClear').onclick = () => { lines.length = 0; for (const k in results) delete results[k]; renderRes(); render(); };
  $('tSniff').onclick = () => {
    sniff = !sniff; lastSniff = null; sniffRep = 0;
    $('tSniff').classList.toggle('on', sniff); $('tSniff').textContent = `● MIDI sniffer: ${sniff ? 'ON. Twist knobs / press switches on the unit' : 'OFF'}`;
    SP.S.pausePoll = sniff || busy;
    log(sniff ? 'Sniffer ON: logging every incoming MIDI message (app polling paused).' : 'Sniffer OFF.');
  };
  window.ScenePadDiag = { run, fullText, results, open };
  if (new URLSearchParams(location.search).has('test')) open();
})();
