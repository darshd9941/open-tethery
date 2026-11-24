// Pocket Monitor host script (ExtendScript, ES3 only: no let/const/arrow/JSON/Array.map).
// Loaded by CEP via <ScriptPath>. The panel calls otGetHostState() and otControl().
// Every entry point returns a JSON string and never throws.
//
// Known limits (documented in panels/cep/README.md):
//  - Premiere ExtendScript has no "is playing" property. We track our own flag and
//    also infer it from the playhead moving between two polls.
//  - After Effects has no playback API; play/pause uses a menu command if found.

var OT_TICKS_PER_SECOND = 254016000000;

var otState = {
    playing: false,      // our best knowledge
    lastPos: null,       // playhead seconds at the previous poll
    lastPollMs: 0,
    stillPolls: 0,
    aeCmd: -1            // cached AE menu command id (0 = none found)
};

// ---------------------------------------------------------------- JSON (ES3 safe)

function otQuote(s) {
    var out = '"';
    for (var i = 0; i < s.length; i++) {
        var c = s.charAt(i);
        var code = s.charCodeAt(i);
        if (c === '"') out += '\\"';
        else if (c === '\\') out += '\\\\';
        else if (c === '\n') out += '\\n';
        else if (c === '\r') out += '\\r';
        else if (c === '\t') out += '\\t';
        else if (code < 32 || code > 126) {
            var h = code.toString(16);
            while (h.length < 4) h = '0' + h;
            out += '\\u' + h;
        } else out += c;
    }
    return out + '"';
}

function otJson(v) {
    var t = typeof v;
    if (v === null || v === undefined) return 'null';
    if (t === 'number') return isFinite(v) ? String(v) : 'null';
    if (t === 'boolean') return v ? 'true' : 'false';
    if (t === 'string') return otQuote(v);
    if (v instanceof Array) {
        var a = [];
        for (var i = 0; i < v.length; i++) a.push(otJson(v[i]));
        return '[' + a.join(',') + ']';
    }
    var parts = [];
    for (var k in v) {
        if (v.hasOwnProperty(k) && typeof v[k] !== 'function' && v[k] !== undefined) {
            parts.push(otQuote(k) + ':' + otJson(v[k]));
        }
    }
    return '{' + parts.join(',') + '}';
}

// ---------------------------------------------------------------- helpers

function otNow() { return new Date().getTime(); }

function otGcd(a, b) {
    while (b) { var t = a % b; a = b; b = t; }
    return a;
}

// Rational fps from a float (After Effects gives only a double).
function otRationalFps(fps) {
    var ntsc = [24, 30, 48, 60, 120];
    for (var i = 0; i < ntsc.length; i++) {
        if (Math.abs(fps - ntsc[i] * 1000 / 1001) < 0.002) return { num: ntsc[i] * 1000, den: 1001 };
    }
    var r = Math.round(fps);
    if (Math.abs(fps - r) < 0.0005) return { num: r, den: 1 };
    return { num: Math.round(fps * 1000), den: 1000 };
}

function otHostApp() {
    try {
        if (typeof BridgeTalk !== 'undefined' && BridgeTalk.appName) {
            var bt = String(BridgeTalk.appName).toLowerCase();
            if (bt.indexOf('premiere') !== -1) return 'premiere';
            if (bt.indexOf('aftereffects') !== -1) return 'aftereffects';
        }
    } catch (e1) {}
    try {
        if (app.name && String(app.name).indexOf('After Effects') !== -1) return 'aftereffects';
        if (app.name && String(app.name).indexOf('Premiere') !== -1) return 'premiere';
        if (typeof app.enableQE !== 'undefined') return 'premiere';
    } catch (e2) {}
    return 'unknown';
}

function otFail(code, message) {
    return { ok: false, code: code, message: message };
}

function otEnsureQE() {
    try {
        if (typeof qe === 'undefined' || !qe) app.enableQE();
        return (typeof qe !== 'undefined' && qe) ? true : false;
    } catch (e) { return false; }
}

function otAeComp() {
    try {
        var it = app.project ? app.project.activeItem : null;
        if (it && it instanceof CompItem) return it;
    } catch (e) {}
    return null;
}

function otPrSeq() {
    try { return app.project ? app.project.activeSequence : null; } catch (e) { return null; }
}

function otPrPos(seq) {
    // seconds
    var p = seq.getPlayerPosition();
    if (p && p.seconds !== undefined) return Number(p.seconds);
    return Number(p.ticks) / OT_TICKS_PER_SECOND;
}

// ---------------------------------------------------------------- state

function otPremiereState() {
    var seq = otPrSeq();
    var out = {
        ok: true,
        host: { app: 'premiere', appName: 'Premiere Pro', version: String(app.version) },
        sequence: null, playing: false, time: null
    };
    if (!seq) return out;
    var tb = Number(seq.timebase);           // ticks per frame
    var fpsNum = 0, fpsDen = 1;
    if (tb > 0) {
        var g = otGcd(OT_TICKS_PER_SECOND, tb);
        fpsNum = OT_TICKS_PER_SECOND / g;
        fpsDen = tb / g;
    }
    var endSec = null;
    try { endSec = Number(seq.end) / OT_TICKS_PER_SECOND; } catch (e1) {}
    var pos = null;
    try { pos = otPrPos(seq); } catch (e2) {}
    out.sequence = {
        name: String(seq.name),
        width: Number(seq.frameSizeHorizontal),
        height: Number(seq.frameSizeVertical),
        fpsNum: fpsNum, fpsDen: fpsDen,
        duration: endSec
    };
    out.time = pos;
    out.playing = otInferPlaying(pos);
    return out;
}

// Playing = our flag, corrected by observing the playhead between polls.
function otInferPlaying(pos) {
    var now = otNow();
    if (pos !== null && otState.lastPos !== null && now - otState.lastPollMs > 150) {
        var delta = pos - otState.lastPos;
        var elapsed = (now - otState.lastPollMs) / 1000;
        if (Math.abs(delta) > 0.0005) {
            otState.stillPolls = 0;
            // Real-time forward motion means playing; bigger jumps are scrubs or seeks.
            if (delta > 0 && delta < elapsed * 3 + 0.05) otState.playing = true;
            else if (delta < 0) otState.playing = false;
        } else {
            otState.stillPolls++;
            if (otState.playing && otState.stillPolls >= 2) otState.playing = false;
        }
    }
    if (pos !== null) { otState.lastPos = pos; otState.lastPollMs = now; }
    return otState.playing;
}

function otAeState() {
    var comp = otAeComp();
    var out = {
        ok: true,
        host: { app: 'aftereffects', appName: 'After Effects', version: String(app.version) },
        sequence: null, playing: false, time: null
    };
    if (!comp) return out;
    var r = otRationalFps(Number(comp.frameRate));
    out.sequence = {
        name: String(comp.name),
        width: Number(comp.width), height: Number(comp.height),
        fpsNum: r.num, fpsDen: r.den,
        duration: Number(comp.duration)
    };
    out.time = Number(comp.time);
    out.playing = otState.playing;   // AE cannot report playback; see otAePlayToggle
    return out;
}

function otGetHostState() {
    try {
        var h = otHostApp();
        if (h === 'premiere') return otJson(otPremiereState());
        if (h === 'aftereffects') return otJson(otAeState());
        return otJson(otFail('unsupported', 'Not running in Premiere Pro or After Effects'));
    } catch (e) {
        return otJson(otFail('host-error', String(e)));
    }
}

// ---------------------------------------------------------------- controls

function otSeekSeconds(sec) {
    if (typeof sec !== 'number' || !isFinite(sec)) return otFail('bad-args', 'seek needs a number of seconds');
    var h = otHostApp();
    if (h === 'premiere') {
        var seq = otPrSeq();
        if (!seq) return otFail('no-sequence', 'No active sequence');
        if (sec < 0) sec = 0;
        seq.setPlayerPosition(String(Math.round(sec * OT_TICKS_PER_SECOND)));
        otState.lastPos = sec;
        otState.lastPollMs = otNow();
        return { ok: true };
    }
    if (h === 'aftereffects') {
        var comp = otAeComp();
        if (!comp) return otFail('no-sequence', 'No active composition');
        if (sec < 0) sec = 0;
        if (sec > comp.duration) sec = comp.duration;
        comp.time = sec;
        return { ok: true };
    }
    return otFail('unsupported', 'Unknown host');
}

function otPremierePlay(wantPlay) {
    if (!otPrSeq()) return otFail('no-sequence', 'No active sequence');
    if (!otEnsureQE()) return otFail('unsupported', 'QE DOM not available');
    if (wantPlay) { qe.startPlayback(); otState.playing = true; }
    else { qe.stopPlayback(); otState.playing = false; }
    otState.stillPolls = 0;
    return { ok: true };
}

// After Effects: run the "Play/Pause" style menu command when we can find its id.
function otAeCommandId() {
    if (otState.aeCmd !== -1) return otState.aeCmd;
    var names = ['Play/Pause', 'Play', 'RAM Preview'];
    var id = 0;
    try {
        for (var i = 0; i < names.length && !id; i++) id = app.findMenuCommandId(names[i]);
    } catch (e) { id = 0; }
    otState.aeCmd = id || 0;
    return otState.aeCmd;
}

function otAePlay(wantPlay) {
    if (!otAeComp()) return otFail('no-sequence', 'No active composition');
    if (wantPlay === otState.playing) return { ok: true };
    var id = otAeCommandId();
    if (!id) return otFail('unsupported', 'No playback menu command found in this After Effects version');
    app.executeCommand(id);
    otState.playing = wantPlay;
    return { ok: true };
}

function otPlay(wantPlay) {
    var h = otHostApp();
    if (h === 'premiere') return otPremierePlay(wantPlay);
    if (h === 'aftereffects') return otAePlay(wantPlay);
    return otFail('unsupported', 'Unknown host');
}

function otStepFrames(frames) {
    var h = otHostApp();
    if (h === 'premiere') {
        var seq = otPrSeq();
        if (!seq) return otFail('no-sequence', 'No active sequence');
        var secPerFrame = Number(seq.timebase) / OT_TICKS_PER_SECOND;
        return otSeekSeconds(otPrPos(seq) + frames * secPerFrame);
    }
    if (h === 'aftereffects') {
        var comp = otAeComp();
        if (!comp) return otFail('no-sequence', 'No active composition');
        return otSeekSeconds(comp.time + frames * comp.frameDuration);
    }
    return otFail('unsupported', 'Unknown host');
}

function otJump(to) {
    var h = otHostApp();
    if (to !== 'start' && to !== 'end') return otFail('bad-args', 'jump needs "start" or "end"');
    if (to === 'start') return otSeekSeconds(0);
    if (h === 'premiere') {
        var seq = otPrSeq();
        if (!seq) return otFail('no-sequence', 'No active sequence');
        return otSeekSeconds(Number(seq.end) / OT_TICKS_PER_SECOND);
    }
    if (h === 'aftereffects') {
        var comp = otAeComp();
        if (!comp) return otFail('no-sequence', 'No active composition');
        // Last frame, not the exclusive end of the comp.
        return otSeekSeconds(comp.duration - comp.frameDuration);
    }
    return otFail('unsupported', 'Unknown host');
}

// cmd: play | pause | toggle | seek | step | jump. arg: seconds, frames, or "start"/"end".
function otControl(cmd, arg) {
    try {
        var r;
        if (cmd === 'play') r = otPlay(true);
        else if (cmd === 'pause') r = otPlay(false);
        else if (cmd === 'toggle') {
            // Premiere: trust the polled flag. AE: same, may be stale (see README).
            r = otPlay(!otState.playing);
        }
        else if (cmd === 'seek') r = otSeekSeconds(Number(arg));
        else if (cmd === 'step') r = otStepFrames(Math.round(Number(arg)));
        else if (cmd === 'jump') r = otJump(arg);
        else r = otFail('unsupported', 'Unknown command ' + cmd);
        return otJson(r);
    } catch (e) {
        return otJson(otFail('host-error', String(e)));
    }
}
