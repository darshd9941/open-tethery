'use strict';

// All Photoshop API calls live here. Watches the active document, grabs a
// downscaled copy of the pixels through the Imaging API, encodes a JPEG and
// hands it to the source client.

const { base64ToBytes, fitSize, aspectString, errorText } = require('./format');
const { resolveProfile, injectProfile } = require('./icc');

const DEFAULT_PROFILE = 'sRGB IEC61966-2.1';
const MAX_PIXELS = 12000000;

function defaultPs() {
  return require('photoshop'); // only exists inside Photoshop (tests hook require)
}

class PsCapture {
  // opts: { client, ps, getSettings() -> {size, profile}, onDoc(info|null),
  //         onFrame(meta), onError(text), pollMs, debounceMs, now }
  constructor(opts) {
    this.client = opts.client;
    this.ps = opts.ps || null;
    this.getSettings = opts.getSettings || (() => ({ size: 1600, profile: DEFAULT_PROFILE }));
    this.onDoc = opts.onDoc || (() => {});
    this.onFrame = opts.onFrame || (() => {});
    this.onError = opts.onError || (() => {});
    this.pollMs = opts.pollMs === undefined ? 300 : opts.pollMs;
    this.debounceMs = opts.debounceMs === undefined ? 350 : opts.debounceMs;
    this.now = opts.now || Date.now;

    this.docKey = null; // id:name:w:h, drives source-state
    this.lastSig = null; // adds history/layers, drives frames
    this.pendingSig = null;
    this.capturing = false;
    this.again = false;
    this.pollTimer = null;
    this.debounceTimer = null;
    this.retryTimer = null;
  }

  _ps() {
    if (!this.ps) this.ps = defaultPs();
    return this.ps;
  }

  start() {
    this.stop();
    this.pollTimer = setInterval(() => this.tick(), this.pollMs);
    this.tick();
  }

  stop() {
    clearInterval(this.pollTimer);
    clearTimeout(this.debounceTimer);
    clearTimeout(this.retryTimer);
    this.pollTimer = this.debounceTimer = this.retryTimer = null;
    this.pendingSig = null;
  }

  // Call after reconnects / setting changes so the next tick sends a frame.
  invalidate() {
    this.lastSig = null;
    this.docKey = null;
  }

  hostInfo() {
    let version = '';
    try {
      version = String(this._ps().app.version || '');
    } catch {
      /* unknown */
    }
    return { app: 'photoshop', appName: 'Photoshop', version };
  }

  activeDocument() {
    try {
      const app = this._ps().app;
      if (app.documents && app.documents.length === 0) return null;
      return app.activeDocument || null;
    } catch (error) {
      if (!this.reportedDocError) {
        this.reportedDocError = true;
        this.onError('Cannot read the open document: ' + String((error && error.message) || error));
      }
      return null;
    }
  }

  static docInfo(doc) {
    const width = Math.max(1, Math.round(doc.width));
    const height = Math.max(1, Math.round(doc.height));
    return { id: doc.id, name: doc.title || doc.name || 'Untitled', width, height };
  }

  static signature(doc) {
    let history = '';
    let layers = 0;
    try {
      history = doc.activeHistoryState ? doc.activeHistoryState.id : '';
    } catch {
      /* not available in every version */
    }
    try {
      layers = doc.layers ? doc.layers.length : 0;
    } catch {
      /* ignore */
    }
    const i = PsCapture.docInfo(doc);
    return [i.id, history, i.width, i.height, layers, i.name].join(':');
  }

  // Cheap poll: detect document switch/resize/rename and edits.
  tick() {
    const doc = this.activeDocument();
    if (!doc) {
      if (this.docKey !== null) {
        this.docKey = null;
        this.lastSig = null;
        this.onDoc(null);
      }
      return;
    }
    const info = PsCapture.docInfo(doc);
    const key = [info.id, info.name, info.width, info.height].join(':');
    if (key !== this.docKey) {
      this.docKey = key;
      this.client.setSequence({
        name: info.name,
        width: info.width,
        height: info.height,
        aspect: aspectString(info.width, info.height),
      });
      this.onDoc(info);
    }
    if (this.capturing) return;
    const sig = PsCapture.signature(doc);
    if (sig === this.lastSig || sig === this.pendingSig) return;
    this.pendingSig = sig;
    clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.pendingSig = null;
      this.captureNow();
    }, this.debounceMs);
  }

  async _grab(doc, size, profile) {
    const { core, imaging } = this._ps();
    const info = PsCapture.docInfo(doc);
    const target = fitSize(info.width, info.height, size, MAX_PIXELS);
    let encoded = null;
    let got = target;

    await core.executeAsModal(
      async () => {
        const result = await imaging.getPixels({
          documentID: doc.id,
          targetSize: { width: target.width, height: target.height },
          componentSize: 8,
          applyAlpha: true,
          colorSpace: 'RGB',
          colorProfile: profile,
        });
        try {
          got = { width: result.imageData.width, height: result.imageData.height };
          encoded = await imaging.encodeImageData({ imageData: result.imageData, base64: true });
        } finally {
          if (result.imageData && result.imageData.dispose) result.imageData.dispose();
        }
      },
      { commandName: require('./product').name }
    );

    let jpeg;
    if (typeof encoded === 'string') jpeg = base64ToBytes(encoded);
    else if (encoded && typeof encoded.length === 'number') jpeg = Uint8Array.from(encoded);
    if (!jpeg || jpeg.length < 4) throw new Error('Photoshop returned an empty frame');
    return { jpeg, width: got.width, height: got.height, srcWidth: info.width, srcHeight: info.height };
  }

  // Returns true when a frame was handed to the client.
  async captureNow() {
    if (this.capturing) {
      this.again = true;
      return false;
    }
    const doc = this.activeDocument();
    if (!doc) return false;
    const sig = PsCapture.signature(doc);
    const settings = this.getSettings();
    const profile = settings.profile || DEFAULT_PROFILE;
    this.capturing = true;
    try {
      const frame = await this._grab(doc, settings.size || 1600, profile);
      let jpeg = frame.jpeg;
      try {
        const icc = resolveProfile(profile);
        if (icc) jpeg = injectProfile(jpeg, icc);
      } catch {
        /* send untagged rather than nothing */
      }
      this.lastSig = sig;
      const sent = this.client.sendFrame(jpeg, frame);
      this.onFrame({ bytes: jpeg.length, width: frame.width, height: frame.height, sent });
      return sent;
    } catch (error) {
      const text = errorText(error);
      if (/modal|busy|in progress|locked|transaction/i.test(text)) {
        this.onError('Photoshop is busy, will retry.');
        clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => this.captureNow(), 700);
      } else {
        this.onError(text);
      }
      return false;
    } finally {
      this.capturing = false;
      if (this.again) {
        this.again = false;
        this.lastSig = null; // edits happened while capturing
      }
    }
  }

  // Colour profiles Photoshop knows: sRGB always, Display P3 when installed.
  async listProfiles() {
    let names = [];
    try {
      names = (await this._ps().app.getColorProfiles('RGB')) || [];
    } catch {
      names = [];
    }
    const srgb = names.find((n) => /^sRGB IEC61966-2\.1$/i.test(n)) || DEFAULT_PROFILE;
    const p3 = names.find((n) => /display\s*p3/i.test(n)) || null;
    return { srgb, p3 };
  }
}

module.exports = { PsCapture, DEFAULT_PROFILE };
