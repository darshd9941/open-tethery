// Guess a friendly device name from the user agent for hello/info. Pure.
export function guessDeviceName(ua = '') {
  ua = String(ua);
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) {
    const m = /Android[^;)]*;\s*([^;)]+?)(?:\s+Build|\s*\)|;)/.exec(ua);
    const model = m && m[1].trim();
    if (model && !/^(wv|U|mobile)$/i.test(model)) return model.slice(0, 40);
    return 'Android phone';
  }
  if (/Macintosh/.test(ua)) return 'Mac browser';
  if (/Windows/.test(ua)) return 'Windows browser';
  if (/Linux/.test(ua)) return 'Linux browser';
  return 'Phone';
}
