/* Harmony Booth
 * Record a lead vocal, generate two fixed-interval harmony voices with
 * Tone.PitchShift rendered offline, mix/preview live, export a WAV of the
 * current mute/solo/volume mix, and share it via the Web Share API.
 */
(() => {
  'use strict';

  const VOICES = [
    { id: 'lead', name: 'Lead', tag: 'as sung', semitones: 0 },
    { id: 'h2', name: 'Harmony 2', tag: '+ major 3rd', semitones: 4 },
    { id: 'h3', name: 'Harmony 3', tag: '+ perfect 5th', semitones: 7 },
  ];

  const els = {
    recBtn: document.getElementById('rec-btn'),
    recDot: document.getElementById('rec-dot'),
    recLabel: document.getElementById('rec-label'),
    recTimer: document.getElementById('rec-timer'),
    buildCard: document.getElementById('build-card'),
    buildLabel: document.getElementById('build-label'),
    mixCard: document.getElementById('mix-card'),
    voices: document.getElementById('voices'),
    playBtn: document.getElementById('play-btn'),
    pauseBtn: document.getElementById('pause-btn'),
    stopBtn: document.getElementById('stop-btn'),
    loopCheck: document.getElementById('loop-check'),
    progressBar: document.getElementById('progress-bar'),
    rerecordBtn: document.getElementById('rerecord-btn'),
    shareBtn: document.getElementById('share-btn'),
    shareStatus: document.getElementById('share-status'),
    diagCard: document.getElementById('diag-card'),
    diagToggle: document.getElementById('diag-toggle'),
    diagBody: document.getElementById('diag-body'),
    diagLog: document.getElementById('diag-log'),
    diagPrevWrap: document.getElementById('diag-prev-wrap'),
    diagPrev: document.getElementById('diag-prev'),
  };

  // ------------------------------------------------------------ diagnostics
  // iOS Safari can silently kill/reload a tab under memory pressure -- that
  // looks EXACTLY like "the page just refreshed" and throws no catchable JS
  // error. A normal in-memory log is useless for this because the process
  // that held it is gone. Persisting each step to sessionStorage means the
  // steps survive the kill (sessionStorage is tied to the tab, not the JS
  // heap), so the NEXT load can show "here is exactly what happened right
  // before you vanished" instead of guessing a third time.
  const DIAG_KEY = 'hb_diag_log_v1';
  let diagEntries = [];
  let previousIncompleteLog = null;

  (function loadPreviousDiagLog() {
    try {
      const raw = sessionStorage.getItem(DIAG_KEY);
      if (raw) {
        const data = JSON.parse(raw);
        if (data && Array.isArray(data.entries) && data.entries.length && !data.complete) {
          previousIncompleteLog = data.entries;
        }
      }
    } catch (e) {}
  })();

  function diagPersist(complete) {
    try { sessionStorage.setItem(DIAG_KEY, JSON.stringify({ entries: diagEntries, complete: !!complete })); } catch (e) {}
  }

  function diagLog(msg) {
    const t = new Date();
    const stamp = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}.${String(t.getMilliseconds()).padStart(3, '0')}`;
    diagEntries.push(`${stamp}  ${msg}`);
    diagPersist(false);
    if (els.diagLog) els.diagLog.textContent = diagEntries.join('\n');
  }

  function diagMarkComplete() { diagPersist(true); }

  function initDiagUI() {
    if (previousIncompleteLog) {
      els.diagPrev.textContent = previousIncompleteLog.join('\n');
      els.diagPrevWrap.hidden = false;
      els.diagBody.hidden = false; // auto-open -- don't make the user hunt for it after a crash
      els.diagCard.classList.add('has-crash-log');
    }
    els.diagToggle.addEventListener('click', () => { els.diagBody.hidden = !els.diagBody.hidden; });
    diagLog('page loaded' + (previousIncompleteLog ? ' (previous session log recovered above)' : ''));
  }

  // These fire on a real navigation/reload triggered by OUR code; if the tab
  // is instead killed by the OS for memory, none of these fire and the log
  // just stops mid-entry -- that gap is itself the diagnostic signal.
  ['visibilitychange', 'pagehide', 'beforeunload'].forEach((evt) => {
    window.addEventListener(evt, () => diagLog(`browser event: ${evt} (visibilityState=${document.visibilityState})`));
  });

  // ---- state ----
  let mediaStream = null;
  let mediaRecorder = null;
  let recordedChunks = [];
  let recordStartedAt = 0;
  let recordTimerHandle = null;

  let duration = 0; // seconds, shared by all three rendered buffers
  const state = {}; // voiceId -> { buffer: ToneAudioBuffer, player, gain, muted, solo, volume }

  let playing = false;
  let playbackOffset = 0; // seconds into the buffer, valid when paused/stopped
  let playbackStartedCtxTime = 0; // Tone.now() when the current play run began
  let progressRaf = null;

  // Surface anything that would otherwise fail silently -- a real JS exception
  // during the record->decode->render pipeline should never look like "the
  // page just refreshed"; if it does, something outside JS's reach (e.g. an
  // iOS Safari memory-pressure tab kill) is the more likely explanation.
  window.addEventListener('error', (e) => {
    console.error('window error', e.error || e.message);
    alert('Unexpected error: ' + (e.error ? e.error.message : e.message));
  });
  window.addEventListener('unhandledrejection', (e) => {
    console.error('unhandled rejection', e.reason);
    alert('Unexpected error: ' + (e.reason && e.reason.message ? e.reason.message : e.reason));
  });

  // ---------------------------------------------------------------- record

  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec));
    const m = String(Math.floor(sec / 60)).padStart(2, '0');
    const s = String(sec % 60).padStart(2, '0');
    return `${m}:${s}`;
  }

  function pickMimeType() {
    const candidates = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
    for (const c of candidates) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(c)) return c;
    }
    return ''; // let the browser pick its own default
  }

  async function startRecording() {
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      diagLog('getUserMedia failed: ' + err.message);
      alert('Microphone access is needed to record: ' + err.message);
      return;
    }
    recordedChunks = [];
    const mimeType = pickMimeType();
    mediaRecorder = mimeType ? new MediaRecorder(mediaStream, { mimeType }) : new MediaRecorder(mediaStream);
    mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) recordedChunks.push(e.data); };
    mediaRecorder.onstop = onRecordingStopped;
    mediaRecorder.start();
    diagLog(`recording started (mimeType=${mimeType || '(browser default)'})`);

    recordStartedAt = performance.now();
    els.recBtn.classList.add('recording');
    els.recLabel.textContent = 'Tap to stop';
    recordTimerHandle = setInterval(() => {
      els.recTimer.textContent = fmtTime((performance.now() - recordStartedAt) / 1000);
    }, 200);
  }

  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
    if (mediaStream) mediaStream.getTracks().forEach((t) => t.stop());
    clearInterval(recordTimerHandle);
    els.recBtn.classList.remove('recording');
    els.recLabel.textContent = 'Tap to record';
  }

  els.recBtn.addEventListener('click', () => {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      stopRecording();
    } else {
      startRecording();
    }
  });

  async function onRecordingStopped() {
    const blob = new Blob(recordedChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
    diagLog(`recording stopped: blob size=${blob.size} bytes, type=${blob.type}`);
    if (blob.size === 0) {
      diagLog('blob was empty -- aborting build');
      alert('No audio was captured — try again.');
      return;
    }
    els.buildCard.hidden = false;
    els.buildLabel.textContent = 'Decoding recording…';
    try {
      await buildHarmonies(blob);
      diagLog('build complete, mixer shown');
      diagMarkComplete();
    } catch (err) {
      diagLog('buildHarmonies threw: ' + (err && err.message ? err.message : err));
      console.error(err);
      alert('Could not build harmonies: ' + err.message);
      els.buildCard.hidden = true;
    }
  }

  // -------------------------------------------------------- build voices

  async function decodeBlobToAudioBuffer(blob) {
    const arrayBuffer = await blob.arrayBuffer();
    const ctx = Tone.getContext().rawContext; // native AudioContext/OfflineAudioContext-capable decode
    // decodeAudioData needs a *live* AudioContext; Tone's context is a real one.
    return await ctx.decodeAudioData(arrayBuffer.slice(0));
  }

  // Tone.js 14.9.17's OfflineContext.close() is a hard-coded no-op
  // (`close(){return Promise.resolve()}` -- confirmed by reading the shipped
  // source), so nothing ever releases the underlying native OfflineAudioContext
  // that Tone.Offline creates -- it's only reclaimed once GC gets to it. Safari
  // on iOS is known to cap the total number of live audio-context objects a
  // page can hold; leaking one per Tone.Offline call means repeated recordings
  // in the same page session can exhaust that budget and silently kill the tab.
  // Bypass Tone's stub and try to close the REAL native context ourselves --
  // harmless where unsupported (OfflineAudioContext.close isn't part of the
  // spec in most engines, so this is likely a no-op on iOS too, but it's free
  // insurance for engines where it does something).
  async function closeRawContext(rawCtx) {
    try { if (rawCtx && typeof rawCtx.close === 'function') await rawCtx.close(); } catch (e) {}
  }

  async function renderVoiceBuffer(leadToneBuffer, semitones, renderDuration, channels) {
    if (semitones === 0) return leadToneBuffer;
    let player, shift, rawCtx;
    const rendered = await Tone.Offline((offlineCtx) => {
      rawCtx = offlineCtx.rawContext;
      player = new Tone.Player(leadToneBuffer);
      shift = new Tone.PitchShift({ pitch: semitones, windowSize: 0.08 });
      // Use toDestination() (resolves via the node's OWN this.context), never the
      // bare `Tone.Destination` singleton, inside a Tone.Offline callback -- the
      // singleton is not reliably rebound to the temporary offline context and
      // connecting to it throws "Source and destination nodes belong to
      // different audio contexts".
      player.chain(shift);
      shift.toDestination();
      player.start(0);
    }, renderDuration, channels);
    try { player.dispose(); shift.dispose(); } catch (e) {}
    await closeRawContext(rawCtx);
    return rendered; // Tone.ToneAudioBuffer
  }

  // Fast path for the common case (mono mic recording): render BOTH harmony
  // voices in a SINGLE Tone.Offline call instead of two, by routing each
  // voice's mono PitchShift output into its own channel of a 2-channel merge --
  // half the leaked native contexts per take vs. calling renderVoiceBuffer once
  // per voice. Falls back to the old one-call-per-voice approach for
  // non-mono sources, where packing N voices x M channels gets complicated
  // fast and correctness matters more than the optimization.
  async function renderHarmonyVoicesMerged(leadToneBuffer, harmonyDefs, renderDuration) {
    let rawCtx;
    diagLog('Tone.Offline (merged) entering');
    const merged = await Tone.Offline((offlineCtx) => {
      rawCtx = offlineCtx.rawContext;
      const merge = new Tone.Merge({ channels: harmonyDefs.length }).toDestination();
      harmonyDefs.forEach((v, i) => {
        const player = new Tone.Player(leadToneBuffer);
        const shift = new Tone.PitchShift({ pitch: v.semitones, windowSize: 0.08 });
        player.chain(shift);
        shift.connect(merge, 0, i);
        player.start(0);
      });
    }, renderDuration, harmonyDefs.length);
    diagLog('Tone.Offline (merged) returned, closing native context');
    await closeRawContext(rawCtx);
    diagLog('native context closed');

    const raw = merged.get(); // native AudioBuffer, one channel per harmony voice
    return harmonyDefs.map((v, i) => {
      const single = new AudioBuffer({ length: raw.length, numberOfChannels: 1, sampleRate: raw.sampleRate });
      single.copyToChannel(raw.getChannelData(i), 0);
      return new Tone.ToneAudioBuffer(single);
    });
  }

  async function renderHarmonyVoices(leadToneBuffer, renderDuration, channels) {
    const harmonyDefs = VOICES.filter((v) => v.semitones !== 0);
    if (channels === 1) {
      diagLog('render path: merged (mono)');
      return renderHarmonyVoicesMerged(leadToneBuffer, harmonyDefs, renderDuration);
    }
    diagLog(`render path: per-voice fallback (channels=${channels})`);
    // Non-mono fallback: one Tone.Offline call per voice, same as before, with a
    // short yield between them so there's at least a chance for GC to reclaim
    // the previous call's native context before the next one is allocated.
    const buffers = [];
    for (let i = 0; i < harmonyDefs.length; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, 150));
      diagLog(`per-voice render ${i + 1}/${harmonyDefs.length} starting`);
      buffers.push(await renderVoiceBuffer(leadToneBuffer, harmonyDefs[i].semitones, renderDuration, channels));
      diagLog(`per-voice render ${i + 1}/${harmonyDefs.length} done`);
    }
    return buffers;
  }

  function teardownVoice(v) {
    if (!v) return;
    try { v.player && v.player.dispose(); } catch (e) {}
    try { v.gain && v.gain.dispose(); } catch (e) {}
  }

  async function buildHarmonies(blob) {
    await Tone.start(); // unlock audio context on user gesture
    diagLog('Tone.start() resolved, context state=' + Tone.getContext().state);

    const audioBuffer = await decodeBlobToAudioBuffer(blob);
    duration = audioBuffer.duration;
    diagLog(`decoded audio buffer: duration=${duration.toFixed(2)}s channels=${audioBuffer.numberOfChannels} sampleRate=${audioBuffer.sampleRate}`);
    if (duration < 0.15) throw new Error('recording too short');
    // Not a hard cap -- long recordings should still work -- but this is a
    // known-unverified risk area (offline-rendering 2 extra pitch-shifted
    // copies of a long, high-sample-rate mono/stereo take on iOS Safari's
    // tight per-tab memory budget) so flag it rather than fail mysteriously.
    if (duration > 90) {
      console.warn(`Long recording (${duration.toFixed(1)}s) -- harmony rendering may be slow or memory-heavy on mobile.`);
    }

    const leadToneBuffer = new Tone.ToneAudioBuffer(audioBuffer);
    const renderDuration = duration + 0.3; // headroom for the pitch-shift processing tail
    const channels = audioBuffer.numberOfChannels;

    els.buildLabel.textContent = 'Rendering harmony voices…';
    diagLog(`starting harmony render: renderDuration=${renderDuration.toFixed(2)}s channels=${channels}`);

    // tear down any previous take
    Object.values(state).forEach(teardownVoice);

    const harmonyDefs = VOICES.filter((v) => v.semitones !== 0);
    const harmonyBuffers = await renderHarmonyVoices(leadToneBuffer, renderDuration, channels);
    diagLog('harmony voices rendered, populating mixer');
    const bufferById = { lead: leadToneBuffer };
    harmonyDefs.forEach((v, i) => { bufferById[v.id] = harmonyBuffers[i]; });

    for (const v of VOICES) {
      const buf = bufferById[v.id];
      const gain = new Tone.Gain(1).toDestination();
      const player = new Tone.Player(buf);
      player.loop = els.loopCheck.checked;
      // Harmony buffers are rendered `duration + 0.3s` long (headroom for the
      // pitch-shift tail, see renderDuration above), so without an explicit
      // loopEnd their natural loop length is 0.3s longer than the lead's --
      // harmonies would drift later by 0.3s on every single loop cycle.
      player.loopStart = 0;
      player.loopEnd = duration;
      player.connect(gain);
      state[v.id] = { def: v, buffer: buf, player, gain, muted: false, solo: false, volume: 1 };
    }

    playbackOffset = 0;
    playing = false;
    renderVoiceRows();
    updateGains();
    els.buildCard.hidden = true;
    els.mixCard.hidden = false;
    els.shareStatus.textContent = '';
  }

  // --------------------------------------------------------------- mixer

  function anySolo() {
    return VOICES.some((v) => state[v.id] && state[v.id].solo);
  }

  function effectiveGain(v) {
    const s = state[v.id];
    if (!s) return 0;
    if (anySolo()) return s.solo ? s.volume : 0;
    return s.muted ? 0 : s.volume;
  }

  function updateGains() {
    for (const v of VOICES) {
      const s = state[v.id];
      if (!s) continue;
      s.gain.gain.value = effectiveGain(v);
    }
  }

  function renderVoiceRows() {
    els.voices.innerHTML = '';
    for (const v of VOICES) {
      const s = state[v.id];
      const row = document.createElement('div');
      row.className = 'voice-row';
      row.innerHTML = `
        <div class="voice-top">
          <div class="voice-name">${v.name}<span class="tag">${v.tag}</span></div>
          <div class="voice-buttons">
            <button class="mini-btn mute-btn" data-voice="${v.id}">MUTE</button>
            <button class="mini-btn solo-btn" data-voice="${v.id}">SOLO</button>
          </div>
        </div>
        <input type="range" class="vol-slider" data-voice="${v.id}" min="0" max="1" step="0.01" value="${s.volume}">
      `;
      els.voices.appendChild(row);
    }

    els.voices.querySelectorAll('.mute-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.voice;
        state[id].muted = !state[id].muted;
        btn.classList.toggle('active-mute', state[id].muted);
        updateGains();
      });
    });
    els.voices.querySelectorAll('.solo-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.voice;
        state[id].solo = !state[id].solo;
        btn.classList.toggle('active-solo', state[id].solo);
        updateGains();
      });
    });
    els.voices.querySelectorAll('.vol-slider').forEach((sl) => {
      sl.addEventListener('input', () => {
        const id = sl.dataset.voice;
        state[id].volume = parseFloat(sl.value);
        updateGains();
      });
    });
  }

  // ------------------------------------------------------------ playback

  function startAllPlayers(fromOffset) {
    const t = Tone.now() + 0.03;
    for (const v of VOICES) {
      const s = state[v.id];
      if (!s) continue;
      s.player.loop = els.loopCheck.checked;
      // fresh Player.start() call each time -- Tone.Player cannot resume a
      // stopped source, so we always (re)start from the tracked offset.
      s.player.start(t, fromOffset % Math.max(duration, 0.001));
    }
    playbackStartedCtxTime = t;
    playing = true;
    els.playBtn.hidden = true;
    els.pauseBtn.hidden = false;
    tickProgress();
  }

  function stopAllPlayers() {
    for (const v of VOICES) {
      const s = state[v.id];
      if (!s) continue;
      try { s.player.stop(); } catch (e) {}
    }
    playing = false;
    els.playBtn.hidden = false;
    els.pauseBtn.hidden = true;
    if (progressRaf) cancelAnimationFrame(progressRaf);
  }

  function tickProgress() {
    if (!playing) return;
    const elapsed = Tone.now() - playbackStartedCtxTime;
    const pos = els.loopCheck.checked ? elapsed % duration : Math.min(elapsed, duration);
    els.progressBar.style.width = `${Math.min(100, (pos / duration) * 100)}%`;
    if (!els.loopCheck.checked && elapsed >= duration) {
      playbackOffset = 0;
      stopAllPlayers();
      els.progressBar.style.width = '0%';
      return;
    }
    progressRaf = requestAnimationFrame(tickProgress);
  }

  els.playBtn.addEventListener('click', async () => {
    await Tone.start();
    startAllPlayers(playbackOffset);
  });

  els.pauseBtn.addEventListener('click', () => {
    const elapsed = Tone.now() - playbackStartedCtxTime;
    playbackOffset = (playbackOffset + elapsed) % Math.max(duration, 0.001);
    stopAllPlayers();
  });

  els.stopBtn.addEventListener('click', () => {
    stopAllPlayers();
    playbackOffset = 0;
    els.progressBar.style.width = '0%';
  });

  // --------------------------------------------------------- re-record

  els.rerecordBtn.addEventListener('click', () => {
    stopAllPlayers();
    Object.values(state).forEach(teardownVoice);
    for (const k of Object.keys(state)) delete state[k];
    els.mixCard.hidden = true;
    els.recTimer.textContent = '00:00';
    els.shareStatus.textContent = '';
  });

  // ------------------------------------------------------- export / wav

  // Standard 16-bit PCM WAV encoder for an AudioBuffer.
  function audioBufferToWav(audioBuffer) {
    const numChannels = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;
    const numFrames = audioBuffer.length;
    const bytesPerSample = 2;
    const blockAlign = numChannels * bytesPerSample;
    const dataSize = numFrames * blockAlign;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    const writeStr = (offset, str) => { for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)); };

    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);          // fmt chunk size
    view.setUint16(20, 1, true);           // PCM
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true); // byte rate
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);          // bits per sample
    writeStr(36, 'data');
    view.setUint32(40, dataSize, true);

    const channelData = [];
    for (let ch = 0; ch < numChannels; ch++) channelData.push(audioBuffer.getChannelData(ch));

    let offset = 44;
    for (let i = 0; i < numFrames; i++) {
      for (let ch = 0; ch < numChannels; ch++) {
        let sample = channelData[ch][i];
        sample = Math.max(-1, Math.min(1, sample));
        view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
        offset += 2;
      }
    }
    return new Blob([buffer], { type: 'audio/wav' });
  }

  async function renderCurrentMixToBuffer() {
    const channels = VOICES.reduce((max, v) => {
      const s = state[v.id];
      return s ? Math.max(max, s.buffer.numberOfChannels) : max;
    }, 1);
    const nodes = [];
    let rawCtx;
    const rendered = await Tone.Offline((offlineCtx) => {
      rawCtx = offlineCtx.rawContext;
      for (const v of VOICES) {
        const s = state[v.id];
        if (!s) continue;
        const g = effectiveGain(v);
        if (g <= 0) continue;
        const player = new Tone.Player(s.buffer);
        const gain = new Tone.Gain(g).toDestination();
        player.connect(gain);
        player.start(0);
        nodes.push(player, gain);
      }
    }, duration + 0.3, channels);
    nodes.forEach((n) => { try { n.dispose(); } catch (e) {} });
    await closeRawContext(rawCtx);
    return rendered.get(); // -> native AudioBuffer
  }

  els.shareBtn.addEventListener('click', async () => {
    els.shareStatus.textContent = 'Rendering mix…';
    els.shareBtn.disabled = true;
    try {
      const mixBuffer = await renderCurrentMixToBuffer();
      const wavBlob = audioBufferToWav(mixBuffer);
      const file = new File([wavBlob], 'harmony-booth-mix.wav', { type: 'audio/wav' });

      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        els.shareStatus.textContent = '';
        await navigator.share({ files: [file], title: 'My harmony mix' });
      } else {
        const url = URL.createObjectURL(wavBlob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'harmony-booth-mix.wav';
        document.body.appendChild(a);
        a.click();
        a.remove();
        els.shareStatus.textContent = 'Downloaded — attach the file to WhatsApp manually.';
      }
    } catch (err) {
      if (err && err.name === 'AbortError') {
        els.shareStatus.textContent = '';
      } else {
        console.error(err);
        els.shareStatus.textContent = 'Export failed: ' + err.message;
      }
    } finally {
      els.shareBtn.disabled = false;
    }
  });
})();
