const tls = require('tls');

// Minimálny klient protokolu Google Cast (CASTV2) bez externých knižníc.
// Spojenie: TLS na port 8009, správy majú 4 bajty dĺžky (big-endian) + protobuf "CastMessage".

const NS = {
  connection: 'urn:x-cast:com.google.cast.tp.connection',
  heartbeat: 'urn:x-cast:com.google.cast.tp.heartbeat',
  receiver: 'urn:x-cast:com.google.cast.receiver',
  media: 'urn:x-cast:com.google.cast.media',
};
const DEFAULT_MEDIA_RECEIVER = 'CC1AD845';
const MAX_MESSAGE = 1024 * 1024;

// --- ručné kódovanie / dekódovanie protobuf správy CastMessage ---

function varint(n) {
  const out = [];
  while (n > 0x7f) { out.push((n & 0x7f) | 0x80); n >>>= 7; }
  out.push(n);
  return Buffer.from(out);
}

function field(tag, buf) {
  return Buffer.concat([Buffer.from([tag]), varint(buf.length), buf]);
}

function encode({ source, destination, namespace, payload }) {
  const body = Buffer.concat([
    Buffer.from([0x08, 0x00]), // protocol_version = CASTV2_1_0
    field(0x12, Buffer.from(source)), // source_id
    field(0x1a, Buffer.from(destination)), // destination_id
    field(0x22, Buffer.from(namespace)), // namespace
    Buffer.from([0x28, 0x00]), // payload_type = STRING
    field(0x32, Buffer.from(JSON.stringify(payload))), // payload_utf8
  ]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  return Buffer.concat([len, body]);
}

function decode(buf) {
  const msg = {};
  let i = 0;
  const readVarint = () => {
    let result = 0;
    let shift = 0;
    for (;;) {
      if (i >= buf.length || shift > 28) throw new Error('neplatný protobuf');
      const b = buf[i++];
      result |= (b & 0x7f) << shift;
      if (!(b & 0x80)) return result >>> 0;
      shift += 7;
    }
  };
  while (i < buf.length) {
    const key = readVarint();
    const num = key >>> 3;
    const wire = key & 7;
    if (wire === 0) {
      readVarint();
    } else if (wire === 2) {
      const len = readVarint();
      if (i + len > buf.length) throw new Error('neplatný protobuf');
      const data = buf.subarray(i, i + len);
      i += len;
      if (num === 2) msg.source = data.toString();
      else if (num === 3) msg.destination = data.toString();
      else if (num === 4) msg.namespace = data.toString();
      else if (num === 6) msg.payload = data.toString();
    } else {
      throw new Error('nepodporovaný typ poľa');
    }
  }
  return msg;
}

// --- relácia: spustí na TV Default Media Receiver a povie mu, aby prehral náš HLS prúd ---

class CastSession {
  constructor() {
    this.socket = null;
    this.onEnded = () => {};
    this.onLog = () => {};
    this.requestId = 0;
    this.pending = new Map(); // requestId -> { resolve, reject }
    this.app = null; // { transportId, sessionId }
    this.mediaSessionId = null;
    this.finished = false;
    this.heartbeat = null;
    this.watchdog = null;
    this.lastRx = 0;
    this.buffer = Buffer.alloc(0);
  }

  _send(namespace, destination, payload) {
    if (this.socket && !this.socket.destroyed) {
      this.socket.write(encode({ source: 'sender-0', destination, namespace, payload }));
    }
  }

  _request(namespace, destination, payload, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const requestId = ++this.requestId;
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('TV neodpovedala včas'));
      }, timeoutMs);
      this.pending.set(requestId, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this._send(namespace, destination, { ...payload, requestId });
    });
  }

  _end(reason) {
    if (this.finished) return;
    this.finished = true;
    this._cleanup();
    this.onEnded(reason);
  }

  _cleanup() {
    clearInterval(this.heartbeat);
    clearInterval(this.watchdog);
    for (const p of this.pending.values()) p.reject(new Error('Spojenie s TV sa skončilo'));
    this.pending.clear();
  }

  _onMessage(raw) {
    let msg;
    try { msg = decode(raw); } catch { return; }
    let data;
    try { data = JSON.parse(msg.payload || '{}'); } catch { return; }
    this.lastRx = Date.now();

    if (msg.namespace === NS.heartbeat) {
      if (data.type === 'PING') this._send(NS.heartbeat, msg.source || 'receiver-0', { type: 'PONG' });
      return;
    }
    if (msg.namespace === NS.connection) {
      if (data.type === 'CLOSE') this._end('TV zatvorila spojenie');
      return;
    }

    if (data.requestId && this.pending.has(data.requestId)) {
      const p = this.pending.get(data.requestId);
      if (['LOAD_FAILED', 'LOAD_CANCELLED', 'INVALID_REQUEST', 'INVALID_PLAYER_STATE', 'LAUNCH_ERROR'].includes(data.type)) {
        this.pending.delete(data.requestId);
        p.reject(new Error(`TV odmietla požiadavku (${data.type}${data.reason ? ': ' + data.reason : ''})`));
        return;
      }
      if (data.type === 'RECEIVER_STATUS' || data.type === 'MEDIA_STATUS') {
        this.pending.delete(data.requestId);
        p.resolve(data);
      }
    }

    if (msg.namespace === NS.receiver && data.type === 'RECEIVER_STATUS' && this.app) {
      const apps = (data.status && data.status.applications) || [];
      if (!apps.some((a) => a.sessionId === this.app.sessionId)) this._end('Aplikácia na TV bola ukončená');
    }

    if (msg.namespace === NS.media && data.type === 'MEDIA_STATUS') {
      this.onLog('cast status: ' + JSON.stringify((data.status || []).map((s) => ({ state: s.playerState, idle: s.idleReason, time: s.currentTime }))));
      // Ignorujeme stavy staršieho média (TV pri nahradení pošle IDLE/INTERRUPTED pre to predošlé)
      const st = (data.status || []).find((s) => this.mediaSessionId && s.mediaSessionId === this.mediaSessionId);
      if (st && st.playerState === 'IDLE' && st.idleReason) this._end(`TV ukončila prehrávanie (${st.idleReason})`);
    }
  }

  async play(device, url) {
    await new Promise((resolve, reject) => {
      // Zariadenia Cast používajú vlastný (nepodpísaný verejnou CA) certifikát, overenie preto nejde.
      // Pripájame sa len na adresu zo zoznamu nájdených zariadení v lokálnej sieti.
      const socket = tls.connect({ host: device.host, port: device.port, rejectUnauthorized: false }, resolve);
      this.socket = socket;
      socket.setTimeout(10000, () => reject(new Error('Pripojenie k TV vypršalo')));
      socket.once('error', reject);
      socket.on('data', (chunk) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        while (this.buffer.length >= 4) {
          const len = this.buffer.readUInt32BE(0);
          if (len > MAX_MESSAGE) { socket.destroy(); return; }
          if (this.buffer.length < 4 + len) break;
          const frame = this.buffer.subarray(4, 4 + len);
          this.buffer = this.buffer.subarray(4 + len);
          this._onMessage(frame);
        }
      });
      socket.on('close', () => this._end('Spojenie s TV sa prerušilo'));
      socket.on('error', (err) => { this.onLog('cast socket error: ' + err.message); this._end('Chyba spojenia s TV: ' + err.message); });
    });
    this.socket.setTimeout(0);

    this._send(NS.connection, 'receiver-0', { type: 'CONNECT' });
    this.lastRx = Date.now();
    this.heartbeat = setInterval(() => this._send(NS.heartbeat, 'receiver-0', { type: 'PING' }), 5000);
    this.watchdog = setInterval(() => {
      if (Date.now() - this.lastRx > 20000) { this._end('TV neodpovedá'); this.socket && this.socket.destroy(); }
    }, 5000);

    const findApp = (r) => ((r.status && r.status.applications) || []).find((a) => a.appId === DEFAULT_MEDIA_RECEIVER && a.transportId);
    let app = findApp(await this._request(NS.receiver, 'receiver-0', { type: 'LAUNCH', appId: DEFAULT_MEDIA_RECEIVER }));
    // niektoré TV odpovedia ešte pred spustením aplikácie, tak chvíľu čakáme
    for (let i = 0; !app && i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      app = findApp(await this._request(NS.receiver, 'receiver-0', { type: 'GET_STATUS' }));
    }
    if (!app) throw new Error('TV nespustila prehrávač');
    this.app = { transportId: app.transportId, sessionId: app.sessionId };

    this._send(NS.connection, app.transportId, { type: 'CONNECT' });
    const loaded = await this._request(NS.media, app.transportId, {
      type: 'LOAD',
      sessionId: app.sessionId,
      autoplay: true,
      currentTime: 0,
      media: {
        contentId: url,
        contentType: 'application/x-mpegURL',
        streamType: 'LIVE',
        metadata: { type: 0, metadataType: 0, title: 'Zrkadlenie PC' },
      },
    }, 30000);
    const status = (loaded.status || [])[0];
    this.mediaSessionId = status && status.mediaSessionId;
    // ak TV medzitým stihla médium ukončiť, oznámime to hneď
    if (status && status.playerState === 'IDLE' && status.idleReason) this._end(`TV ukončila prehrávanie (${status.idleReason})`);
  }

  stop() {
    this.finished = true;
    this._cleanup();
    const socket = this.socket;
    this.socket = null;
    if (!socket || socket.destroyed) return;
    try {
      if (this.app) {
        socket.write(encode({ source: 'sender-0', destination: 'receiver-0', namespace: NS.receiver, payload: { type: 'STOP', sessionId: this.app.sessionId, requestId: ++this.requestId } }));
      }
    } catch {}
    setTimeout(() => socket.destroy(), 500);
  }
}

module.exports = { CastSession, encode, decode };
