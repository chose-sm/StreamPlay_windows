const { Bonjour } = require('bonjour-service');

// Hľadá Chromecast / Google Cast zariadenia (Android TV s vstavaným Chromecastom) v sieti.
class Discovery {
  constructor(onChange) {
    this.onChange = onChange;
    this.devices = new Map();
    this.bonjour = null;
    this.browser = null;
  }

  start() {
    this.stop();
    this.bonjour = new Bonjour();
    this.browser = this.bonjour.find({ type: 'googlecast' });
    this.browser.on('up', (svc) => this._add(svc));
    this.browser.on('down', (svc) => this._remove(svc));
    this.browser.update && this.browser.update();
  }

  rescan() {
    this.devices.clear();
    this.onChange(this.list());
    this.start();
  }

  stop() {
    try { this.browser && this.browser.stop(); } catch {}
    try { this.bonjour && this.bonjour.destroy(); } catch {}
    this.browser = null;
    this.bonjour = null;
  }

  _add(svc) {
    const txt = svc.txt || {};
    const id = txt.id || svc.name;
    const host = (svc.addresses || []).find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a)) || svc.referer?.address;
    if (!host) return;
    // md = model (napr. "Chromecast", "Google Home Mini"); preferujeme zariadenia s obrazovkou, ale nezahadzujeme ostatné
    this.devices.set(id, {
      id,
      name: txt.fn || svc.name,
      model: txt.md || '',
      host,
      port: svc.port || 8009,
    });
    this.onChange(this.list());
  }

  _remove(svc) {
    const id = (svc.txt && svc.txt.id) || svc.name;
    if (this.devices.delete(id)) this.onChange(this.list());
  }

  list() {
    return [...this.devices.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id) {
    return this.devices.get(id);
  }
}

module.exports = { Discovery };
