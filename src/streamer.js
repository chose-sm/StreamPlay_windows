const { spawn } = require('child_process');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const HLS_DIR_PREFIX = 'streamplay-';

function resolveFfmpeg() {
  let p = require('ffmpeg-static');
  // po zabalení do asar archívu je binárka v app.asar.unpacked
  if (p && p.includes('app.asar')) p = p.replace('app.asar', 'app.asar.unpacked');
  return p;
}

// Nájde hardvérový H.264 enkodér (NVENC / AMF / QuickSync), inak použije libx264 na CPU.
let encoderPromise = null;
function detectEncoder(ffmpeg) {
  if (encoderPromise) return encoderPromise;
  const candidates = ['h264_nvenc', 'h264_amf', 'h264_qsv'];
  encoderPromise = (async () => {
    for (const enc of candidates) {
      const ok = await new Promise((resolve) => {
        const p = spawn(ffmpeg, [
          '-hide_banner', '-loglevel', 'error',
          '-f', 'lavfi', '-i', 'color=c=black:s=1280x720:r=30',
          '-frames:v', '5', '-c:v', enc, '-pix_fmt', 'yuv420p', '-f', 'null', '-',
        ], { windowsHide: true });
        const timer = setTimeout(() => { try { p.kill(); } catch {} resolve(false); }, 6000);
        p.on('exit', (code) => { clearTimeout(timer); resolve(code === 0); });
        p.on('error', () => { clearTimeout(timer); resolve(false); });
      });
      if (ok) return enc;
    }
    return 'libx264';
  })();
  return encoderPromise;
}

function encoderArgs(enc, bitrateMbps) {
  const b = `${bitrateMbps}M`;
  const rate = ['-b:v', b, '-maxrate', `${Math.round(bitrateMbps * 1.3)}M`, '-bufsize', `${bitrateMbps * 2}M`];
  switch (enc) {
    case 'h264_nvenc': return ['-c:v', enc, '-preset', 'p4', '-tune', 'll', '-profile:v', 'high', ...rate];
    case 'h264_amf': return ['-c:v', enc, '-quality', 'speed', '-profile:v', 'high', ...rate];
    case 'h264_qsv': return ['-c:v', enc, '-preset', 'veryfast', '-profile:v', 'high', ...rate];
    default: return ['-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-profile:v', 'high', ...rate];
  }
}

// IPv4 adresa tohto PC v rovnakej podsieti ako TV
function localIpFor(targetHost) {
  const toInt = (ip) => ip.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
  let fallback = null;
  for (const infos of Object.values(os.networkInterfaces())) {
    for (const i of infos || []) {
      if (i.family !== 'IPv4' || i.internal) continue;
      fallback = fallback || i.address;
      if (targetHost) {
        const mask = toInt(i.netmask);
        if ((toInt(i.address) & mask) === (toInt(targetHost) & mask)) return i.address;
      }
    }
  }
  return fallback;
}

class Streamer extends EventEmitter {
  constructor() {
    super();
    this.ffmpeg = null;
    this.server = null;
    this.dir = null;
    this.log = '';
  }

  // listSize = koľko segmentov (po hlsTime sekúnd) ostáva v playliste, 300 s = 5 minút
  async start({ targetHost, height = 1080, fps = 30, bitrate = 6, hlsTime = 1, listSize = 300, event = false }) {
    await this.stop();
    const ffmpeg = resolveFfmpeg();
    const enc = await detectEncoder(ffmpeg);
    this.encoder = enc;

    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), HLS_DIR_PREFIX));
    this.log = '';
    this.served = false;

    const args = [
      '-hide_banner', '-loglevel', 'info', '-stats_period', '5',
      // POZOR: '-fflags +nobuffer' tu nepoužívať, pri živom vstupe zdvojí prvý obraz na 4 až 6 s
      // (obraz zamrzne, kým zvuk už hrá)
      '-probesize', '500000', '-analyzeduration', '500000',
      '-i', 'pipe:0',
      '-vf', `scale=-2:'min(ih,${height})',fps=${fps},format=yuv420p`,
      ...encoderArgs(enc, bitrate),
      '-g', String(fps), '-keyint_min', String(fps),
      '-force_key_frames', 'expr:gte(t,n_forced*1)',
      // zvuk si necháva pôvodné časové značky (zachovanie synchronizácie s obrazom),
      // async=1 len doplní ticho na začiatku, ak zvuk začal neskôr než obraz
      '-af', 'aresample=48000:async=1',
      '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
      // dlhšie segmenty = TV si drží väčší buffer a netrhá sa pri drobných zdržaniach
      '-f', 'hls', '-hls_time', String(hlsTime),
      ...(event
        ? ['-hls_list_size', '0', '-hls_playlist_type', 'event', '-hls_flags', 'independent_segments+omit_endlist']
        : ['-hls_list_size', String(listSize), '-hls_flags', 'delete_segments+independent_segments+omit_endlist']),
      '-hls_segment_filename', path.join(this.dir, 'seg_%05d.ts'),
      path.join(this.dir, 'index.m3u8'),
    ];

    this.ffmpeg = spawn(ffmpeg, args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    this.ffmpeg.stderr.on('data', (d) => {
      const text = d.toString();
      this.emit('log', text);
      // do chybovej hlášky idú len varovania, nie priebeh kódovania
      const important = text.split(/\r?\n|\r/).filter((l) => l && !/^frame=|Opening '|^\[hls/.test(l)).join('\n');
      this.log = (this.log + important + '\n').slice(-1500);
    });
    this.ffmpeg.stdin.on('error', () => {});
    this.ffmpeg.on('error', (e) => this.emit('error', new Error('ffmpeg sa nepodarilo spustiť: ' + e.message)));
    this.ffmpeg.on('exit', (code) => {
      if (this.ffmpeg) this.emit('error', new Error(`ffmpeg skončil (kód ${code})\n${this.log}`));
    });

    const ip = localIpFor(targetHost);
    if (!ip) throw new Error('Nenašiel som sieťové pripojenie (Wi-Fi / Ethernet).');
    this.token = crypto.randomBytes(16).toString('hex');
    await this._listen(ip, targetHost);
    return { url: `http://${ip}:${this.server.address().port}/${this.token}/index.m3u8`, encoder: enc };
  }

  // Server počúva len na adrese PC v sieti s TV, vyžaduje náhodný token v URL
  // a obsluhuje výhradne IP adresu TV, takže prúd neuvidí nikto iný v sieti.
  _listen(ip, allowedHost) {
    const types = { '.m3u8': 'application/x-mpegURL', '.ts': 'video/mp2t' };
    this.server = http.createServer((req, res) => {
      const remote = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
      const parts = (req.url.split('?')[0] || '').split('/').filter(Boolean);
      const ok = remote === allowedHost && parts.length === 2 && parts[0] === this.token && /^[\w.-]+$/.test(parts[1]);
      if (!ok) {
        this.emit('http', `${remote} ${req.method} odmietnuté`);
        res.writeHead(404);
        return res.end();
      }
      const name = parts[1];
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', '*');
      res.setHeader('Cache-Control', 'no-cache');
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
      fs.readFile(path.join(this.dir, name), (err, data) => {
        this.emit('http', `${remote} GET ${name} -> ${err ? 404 : 200}`);
        if (err) { res.writeHead(404); return res.end(); }
        this.served = true; // TV sa k nám vie pripojiť (firewall ju nezablokoval)
        if (name.endsWith('.m3u8')) {
          // Playlist označíme ako EVENT: TV potom začne od začiatku a drží si stály odstup od živého okraja.
          // Pri bežnom "živom" playliste sa TV usádza na samom okraji a netrhane prehráva len chvíľu (stále sa načítava).
          data = Buffer.from(data.toString().replace('#EXT-X-VERSION', '#EXT-X-PLAYLIST-TYPE:EVENT\n#EXT-X-VERSION'));
        }
        res.writeHead(200, { 'Content-Type': types[path.extname(name)] || 'application/octet-stream', 'Content-Length': data.length });
        res.end(data);
      });
    });
    return new Promise((resolve, reject) => {
      const tryListen = (port, fallback) => {
        this.server.once('error', (e) => (fallback ? tryListen(0, false) : reject(e)));
        this.server.listen(port, ip, () => {
          this.server.removeAllListeners('error');
          // neskoršie chyby servera (napr. zmena siete) nesmú zhodiť aplikáciu
          this.server.on('error', (e) => this.emit('error', e));
          resolve();
        });
      };
      tryListen(8765, true);
    });
  }

  write(buf) {
    const s = this.ffmpeg && this.ffmpeg.stdin;
    if (s && s.writable) s.write(buf);
  }

  // počká, kým ffmpeg vyrobí aspoň 2 segmenty, aby TV mala čo prehrávať
  async waitReady(timeoutMs = 25000) {
    const playlist = path.join(this.dir, 'index.m3u8');
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (!this.ffmpeg) throw new Error('Prenos bol zastavený');
      try {
        const txt = fs.readFileSync(playlist, 'utf8');
        if ((txt.match(/#EXTINF/g) || []).length >= 2) return;
      } catch {}
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error('ffmpeg nestihol pripraviť prúd. ' + this.log);
  }

  async stop() {
    const ff = this.ffmpeg;
    this.ffmpeg = null;
    if (ff) {
      try { ff.stdin.end(); } catch {}
      try { ff.kill(); } catch {}
    }
    if (this.server) {
      try { this.server.close(); this.server.closeAllConnections && this.server.closeAllConnections(); } catch {}
      this.server = null;
    }
    if (this.dir) {
      const d = this.dir;
      this.dir = null;
      setTimeout(() => { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }, 1000);
    }
  }
}

module.exports = { Streamer, detectEncoder, resolveFfmpeg };
