const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const statusText = $('statusText');
const devicesEl = $('devices');
const emptyEl = $('empty');
const sourceEl = $('source');
const qualityEl = $('quality');
const stopBtn = $('stop');

let devices = [];
let activeId = null;
let capture = null; // { stream, recorder }
let busy = false;

function setStatus(state, text) {
  statusEl.className = 'status ' + state;
  statusText.textContent = text;
}

function renderDevices() {
  devicesEl.textContent = '';
  emptyEl.hidden = devices.length > 0;
  for (const d of devices) {
    const li = document.createElement('li');
    if (d.id === activeId) li.classList.add('active');
    if (busy && d.id !== activeId) li.classList.add('disabled');

    const info = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = d.name;
    const model = document.createElement('div');
    model.className = 'model';
    model.textContent = d.model;
    info.append(name, model);

    const go = document.createElement('div');
    go.className = 'go';
    go.textContent = d.id === activeId ? 'Prenáša sa' : 'Zrkadliť';

    li.append(info, go);
    li.addEventListener('click', () => { if (!busy) startMirroring(d); });
    devicesEl.append(li);
  }
}

function setBusy(on) {
  busy = on;
  stopBtn.hidden = !on;
  sourceEl.disabled = on;
  qualityEl.disabled = on;
  renderDevices();
}

async function loadSources() {
  const sources = await window.api.listSources();
  sourceEl.textContent = '';
  sources.forEach((s, i) => {
    const o = document.createElement('option');
    o.value = s.id;
    o.textContent = sources.length > 1 ? `Obrazovka ${i + 1}` : 'Hlavná obrazovka';
    sourceEl.append(o);
  });
}

function pickMime() {
  const options = [
    'video/webm;codecs=h264,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  return options.find((m) => MediaRecorder.isTypeSupported(m));
}

async function startMirroring(device) {
  const mbps = Number(qualityEl.value);
  const height = 1080;
  const fps = 30;
  activeId = device.id;
  setBusy(true);
  $('fwBox').hidden = true;
  setStatus('busy', 'Spúšťam…');

  try {
    await window.api.start({ deviceId: device.id, sourceId: sourceEl.value, height, bitrate: mbps, fps });

    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 60, max: 60 }, width: { max: Math.round((height * 16) / 9) }, height: { max: height } },
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    if (stream.getAudioTracks().length === 0) {
      setStatus('busy', 'Pozor: zvuk systému sa nepodarilo zachytiť, prenáša sa len obraz.');
    }

    const mimeType = pickMime();
    const vs = stream.getVideoTracks()[0].getSettings();
    window.api.log(`capture ${vs.width}x${vs.height}@${vs.frameRate} audioTracks=${stream.getAudioTracks().length} mime=${mimeType}`);

    // Zachytenie obrazovky posiela snímky len pri zmene obrazu. Každý nový snímok hneď
    // prekreslíme na canvas (bez vlastného časovača, ktorý by s príchodom snímok "bicoval"
    // a spôsoboval mikrolagy). Pri statickej ploche pridáme snímok aspoň každých ~60 ms,
    // aby prúd (a ffmpeg) nikdy nečakal.
    const video = document.createElement('video');
    video.muted = true;
    video.srcObject = new MediaStream([stream.getVideoTracks()[0]]);
    await video.play();
    const canvas = document.createElement('canvas');
    canvas.width = (vs.width || video.videoWidth || 1920) & ~1;
    canvas.height = (vs.height || video.videoHeight || 1080) & ~1;
    const ctx = canvas.getContext('2d', { alpha: false });
    const canvasTrack = canvas.captureStream(0).getVideoTracks()[0];

    let running = true;
    let lastDraw = performance.now();
    let deltas = [];
    const draw = () => {
      const t = performance.now();
      deltas.push(t - lastDraw);
      lastDraw = t;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      canvasTrack.requestFrame();
    };
    // Obrazovku zachytávame rýchlejšie (60 Hz) a vyberáme presne tie snímky, ktoré treba pre
    // rovnomerných 30 fps. Pri zachytávaní priamo na 30 fps dodáva Chromium snímky po 34 ms
    // (29,4 fps) a ffmpeg ich potom raz za ~1,7 s zdvojí, čo vidno ako mikrozásek.
    const slotMs = 1000 / fps;
    let nextDue = null;
    const onVideoFrame = (now, meta) => {
      if (!running) return;
      const t = (meta && meta.captureTime) || now;
      if (nextDue === null) nextDue = t;
      if (t >= nextDue - slotMs * 0.25) {
        draw();
        nextDue += slotMs;
        if (t - nextDue > slotMs) nextDue = t + slotMs; // po zdržaní sa znova zosynchronizujeme
      }
      video.requestVideoFrameCallback(onVideoFrame);
    };
    video.requestVideoFrameCallback(onVideoFrame);
    const keepAlive = setInterval(() => { if (performance.now() - lastDraw > 60) draw(); }, 20);
    const drawTimer = { stop() { running = false; clearInterval(keepAlive); } };
    const outStream = new MediaStream([canvasTrack, ...stream.getAudioTracks()]);

    // Indikátor zvuku: ukáže, či PC zvuk naozaj zachytáva (užitočné pri hľadaní, prečo na TV nehrá)
    let audioCtx = null;
    let meterTimer = null;
    let audioPeak = 0;
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length) {
      audioCtx = new AudioContext();
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      audioCtx.createMediaStreamSource(new MediaStream(audioTracks)).connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      let silentMs = 0;
      $('audioBox').hidden = false;
      meterTimer = setInterval(() => {
        analyser.getFloatTimeDomainData(samples);
        let peak = 0;
        for (const v of samples) peak = Math.max(peak, Math.abs(v));
        audioPeak = Math.max(audioPeak, peak);
        $('audioLevel').style.width = Math.min(100, Math.sqrt(peak) * 100) + '%';
        silentMs = peak < 0.0005 ? silentMs + 100 : 0;
        const silent = silentMs > 3000;
        $('audioBox').classList.toggle('silent', silent);
        $('audioText').textContent = silent ? 'Zvuk z PC: ticho (nič nehrá)' : 'Zvuk z PC: zachytáva sa';
      }, 100);
    }

    const recorder = new MediaRecorder(outStream, {
      mimeType,
      videoBitsPerSecond: Math.max(mbps * 2, 8) * 1_000_000,
      audioBitsPerSecond: 192_000,
    });
    let bytes = 0;
    const logTimer = setInterval(() => {
      const d = deltas.sort((a, b) => a - b);
      const n = d.length || 1;
      const avg = d.reduce((s, x) => s + x, 0) / n;
      const dbfs = audioPeak > 0 ? (20 * Math.log10(audioPeak)).toFixed(0) + ' dBFS' : 'ticho';
      window.api.log(`recorder ${recorder.state}, ${(bytes / 5 / 1024).toFixed(0)} kB/s; frames ${(d.length / 5).toFixed(1)}/s, interval avg ${avg.toFixed(1)} p95 ${(d[Math.floor(n * 0.95)] || 0).toFixed(1)} max ${(d[n - 1] || 0).toFixed(1)} ms; audio peak ${dbfs}`);
      bytes = 0;
      deltas = [];
      audioPeak = 0;
    }, 5000);
    recorder.onstop = () => {
      clearInterval(logTimer);
      clearInterval(meterTimer);
      drawTimer.stop();
      video.srcObject = null;
      if (audioCtx) audioCtx.close();
      $('audioBox').hidden = true;
    };
    recorder.onerror = (e) => window.api.log('recorder error: ' + (e.error && e.error.message));
    recorder.ondataavailable = async (e) => {
      if (e.data && e.data.size) {
        bytes += e.data.size;
        window.api.chunk(await e.data.arrayBuffer());
      }
    };
    recorder.start(200);
    stream.getVideoTracks()[0].addEventListener('ended', () => stopMirroring());

    capture = { stream, recorder };
  } catch (err) {
    await stopMirroring(err.message || String(err));
  }
}

async function stopMirroring(errorMessage) {
  if (capture) {
    try { capture.recorder.state !== 'inactive' && capture.recorder.stop(); } catch {}
    capture.stream.getTracks().forEach((t) => t.stop());
    capture = null;
  }
  await window.api.stop();
  activeId = null;
  setBusy(false);
  if (errorMessage) setStatus('error', errorMessage);
  else setStatus('idle', 'Zrkadlenie zastavené. Vyber TV zo zoznamu.');
}

window.api.onDevices((list) => { devices = list; renderDevices(); });

window.api.onStatus(({ state, text }) => {
  setStatus(state === 'live' ? 'live' : 'busy', text);
});

window.api.onEnded((reason) => { stopMirroring(reason || 'Prenos sa skončil.'); });

window.api.onFirewallHint(() => { $('fwBox').hidden = false; });
$('fwAllow').addEventListener('click', () => { window.api.allowFirewall(); $('fwBox').hidden = true; });

$('licenses').addEventListener('click', () => window.api.openLicenses());

stopBtn.addEventListener('click', () => stopMirroring());
$('rescan').addEventListener('click', () => { devices = []; renderDevices(); window.api.rescan(); });

loadSources();
renderDevices();
