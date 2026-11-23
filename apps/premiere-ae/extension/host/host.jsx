// Host ExtendScript for Live Video Preview
// Compatible with Adobe Premiere Pro and Adobe After Effects (2020-2026+)

var _manualHost = "";

function setHostType(name) {
    _manualHost = name;
}

(function() {
    if (typeof $JSON === 'undefined') {
        $JSON = {
            stringify: function(obj) {
                var t = typeof obj;
                if (t !== "object" || obj === null) {
                    if (t === "string") return '"' + obj.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
                    return String(obj);
                }
                var json = [], isArr = (obj && obj.constructor === Array);
                for (var n in obj) {
                    if (obj.hasOwnProperty(n)) {
                        var v = obj[n];
                        var vt = typeof v;
                        if (vt === "string") v = '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
                        else if (vt === "object" && v !== null) v = $JSON.stringify(v);
                        json.push((isArr ? "" : '"' + n + '":') + String(v));
                    }
                }
                return (isArr ? "[" : "{") + String(json) + (isArr ? "]" : "}");
            }
        };
    }
})();

function getHostName() {
    if (_manualHost) return _manualHost;
    try {
        if (typeof BridgeTalk !== 'undefined' && BridgeTalk.appName) {
            var bt = BridgeTalk.appName.toLowerCase();
            if (bt.indexOf("premiere") !== -1) return "Premiere Pro";
            if (bt.indexOf("aftereffects") !== -1) return "After Effects";
        }
    } catch(e) {}
    try {
        if (typeof app !== 'undefined') {
            if (app.name && app.name.indexOf("After Effects") !== -1) return "After Effects";
            if (typeof app.enableQE !== 'undefined' || typeof qe !== 'undefined' || (typeof app.project !== 'undefined' && typeof app.project.activeSequence !== 'undefined')) {
                return "Premiere Pro";
            }
        }
    } catch(e) {}
    return "Unknown";
}

function getHostInfo() {
    var host = getHostName();
    var version = "";
    try { version = app.version; } catch(e) {}
    return $JSON.stringify({ host: host, version: version });
}

// ---------------------------------------------------------------------------
// Timeline Change Detection (Lightweight Polling)
// ---------------------------------------------------------------------------

function getTimelineSignature() {
    var host = getHostName();
    try {
        if (host === "Premiere Pro") {
            if (!app.project) return "no-project";
            var seq = app.project.activeSequence;
            if (!seq) return "no-seq";
            var playerPos = null;
            try {
                playerPos = seq.getPlayerPosition();
            } catch(e) {}
            var ticks = playerPos ? playerPos.ticks : "";
            var sec = playerPos ? (Math.round(playerPos.seconds * 100) / 100) : "";
            return "pr:" + seq.name + ":" + ticks + ":" + sec;
        } else if (host === "After Effects") {
            if (!app.project || !app.project.activeItem) return "no-comp";
            var item = app.project.activeItem;
            if (item instanceof CompItem) {
                return "ae:" + item.id + ":" + item.name + ":" + (Math.round(item.time * 100) / 100) + ":" + item.numLayers;
            }
            return "not-a-comp";
        }
    } catch(err) {
        return "err:" + err.message;
    }
    return "none";
}

// ---------------------------------------------------------------------------
// Frame Exporting
// ---------------------------------------------------------------------------

function formatTimecode(seconds, fps) {
    if (!fps || fps <= 0) fps = 24;
    var totalFrames = Math.floor(seconds * fps);
    var f = totalFrames % Math.round(fps);
    var totalSec = Math.floor(seconds);
    var s = totalSec % 60;
    var totalMin = Math.floor(totalSec / 60);
    var m = totalMin % 60;
    var h = Math.floor(totalMin / 60);
    
    function pad(n) { return (n < 10 ? "0" : "") + n; }
    return pad(h) + ":" + pad(m) + ":" + pad(s) + ":" + pad(f);
}

function captureActiveFrame(targetPath) {
    var host = getHostName();
    try {
        if (host === "Premiere Pro") {
            if (!app.project) {
                return $JSON.stringify({ success: false, error: "No project open in Premiere Pro." });
            }
            var seq = app.project.activeSequence;
            if (!seq) {
                return $JSON.stringify({ success: false, error: "No active sequence. Open or click on a sequence." });
            }

            try {
                if (typeof qe === 'undefined') app.enableQE();
            } catch(e) {}

            var qeSeq = null;
            try {
                if (typeof qe !== 'undefined' && qe.project) {
                    qeSeq = qe.project.getActiveSequence();
                }
            } catch(e) {}

            // If null because focus is on panel, re-activate sequence
            if (!qeSeq && seq.sequenceID) {
                try {
                    app.project.openSequence(seq.sequenceID);
                    if (typeof qe !== 'undefined' && qe.project) {
                        qeSeq = qe.project.getActiveSequence();
                    }
                } catch(e) {}
            }

            if (!qeSeq) {
                return $JSON.stringify({ success: false, error: "Please click once inside your timeline panel so Premiere activates it." });
            }

            // Get timecode from CTI
            var timecode = "00:00:00:00";
            try {
                if (qeSeq.CTI && qeSeq.CTI.timecode) {
                    timecode = qeSeq.CTI.timecode;
                }
            } catch(e) {}

            // Use temp folder
            var tempFolder = Folder.temp;
            if (!tempFolder.exists) tempFolder.create();
            var outDir = tempFolder.fsName.replace(/\\/g, '/');

            var outPng = outDir + "/live_frame.png";
            var outJpg = outDir + "/live_frame.jpg";

            var candidatePaths = [
                outPng,
                outPng + ".png",
                outJpg,
                outJpg + ".jpg",
                outDir + "/live_frame"
            ];

            // Remove any old frames
            for (var c = 0; c < candidatePaths.length; c++) {
                try {
                    var fOld = new File(candidatePaths[c]);
                    if (fOld.exists) fOld.remove();
                } catch(e) {}
            }

            // Use exportAsMediaDirect (exportFramePNG is dead on current builds)
            var outFile = new File(outPng);
            try { if (outFile.exists) outFile.remove(); } catch(e) {}

            var _t = null;
            try { _t = seq.getPlayerPosition(); } catch(e) {}
            try {
                if (!_t) {
                    if (typeof qe === 'undefined') app.enableQE();
                    var _qe = (typeof qe !== 'undefined' && qe.project) ? qe.project.getActiveSequence() : null;
                    if (_qe && _qe.CTI) _t = _qe.CTI;
                }
            } catch(e) {}
            try {
                var _t2 = new Time();
                _t2.seconds = (_t && typeof _t.seconds === 'number') ? _t.seconds + 0.04 : 0.04;
                if (_t) seq.setInPoint(_t);
                seq.setOutPoint(_t2);
            } catch(e) {}

            var presetPath = "C:\\Program Files\\Adobe\\Adobe Premiere Pro 2026\\MediaIO\\systempresets\\3F3F3F3F_504E4720\\PNG Sequence (Match Source).epr";
            try { seq.exportAsMediaDirect(outFile.fsName, presetPath, 1); } catch(e) {}

            var finalFile = null;
            var mime = "image/png";
            for (var waitLoop = 0; waitLoop < 20; waitLoop++) {
                try { if (outFile.exists && outFile.length > 200) { finalFile = outFile; break; } } catch(e) {}
                $.sleep(100);
            }

            if (finalFile && finalFile.exists) {
                return $JSON.stringify({
                    success: true,
                    host: "Premiere Pro",
                    name: seq.name,
                    timecode: timecode,
                    width: seq.frameSizeHorizontal,
                    height: seq.frameSizeVertical,
                    path: finalFile.fsName.replace(/\\/g, '/'),
                    mime: mime
                });
            } else {
                return $JSON.stringify({
                    success: false,
                    error: "Could not export frame. Ensure a sequence is focused and has clips at playhead."
                });
            }

        } else if (host === "After Effects") {
            if (!app.project || !app.project.activeItem) {
                return $JSON.stringify({ success: false, error: "No active composition in After Effects. Please select a composition." });
            }
            var comp = app.project.activeItem;
            if (!(comp instanceof CompItem)) {
                return $JSON.stringify({ success: false, error: "Selected item is not a composition." });
            }

            var time = comp.time;
            var tempFolder = Folder.temp;
            if (!tempFolder.exists) tempFolder.create();
            var outPng = tempFolder.fsName.replace(/\\/g, '/') + "/ae_live_frame.png";
            var fPng = new File(outPng);
            if (fPng.exists) {
                try { fPng.remove(); } catch(e) {}
            }

            comp.saveFrameToPng(time, fPng);

            for (var w = 0; w < 6; w++) {
                if (fPng.exists && fPng.length > 200) break;
                $.sleep(50);
            }

            if (fPng.exists) {
                return $JSON.stringify({
                    success: true,
                    host: "After Effects",
                    name: comp.name,
                    timecode: formatTimecode(time, comp.frameRate),
                    width: comp.width,
                    height: comp.height,
                    fps: comp.frameRate,
                    path: fPng.fsName.replace(/\\/g, '/'),
                    mime: "image/png"
                });
            } else {
                return $JSON.stringify({ success: false, error: "After Effects frame export failed." });
            }
        }
    } catch(err) {
        return $JSON.stringify({ success: false, error: err.toString() });
    }

    return $JSON.stringify({ success: false, error: "Unsupported host: " + host });
}
