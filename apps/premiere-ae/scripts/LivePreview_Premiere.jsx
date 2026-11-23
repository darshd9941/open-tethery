// Live Preview - Premiere Pro Frame Export Helper
// Can be executed in ExtendScript Toolkit, VS Code ExtendScript, or Premiere Pro scripting console

(function() {
    if (typeof app === 'undefined' || !app.project) {
        alert("Please open a Premiere Pro project first.");
        return;
    }

    if (typeof qe === 'undefined') app.enableQE();
    var seq = app.project.activeSequence;
    var qeSeq = qe.project.getActiveSequence();

    if (!seq || !qeSeq) {
        alert("Please open and select a timeline sequence.");
        return;
    }

    var timecode = qeSeq.CTI.timecode;
    var tempPath = Folder.temp.fsName + "/pr_manual_frame.jpg";
    var file = new File(tempPath);
    if (file.exists) file.remove();

    var ok = qeSeq.exportFrameJPEG(timecode, tempPath);
    if (!ok) ok = qeSeq.exportFramePNG(timecode, tempPath);

    if (ok && file.exists) {
        alert("Exported frame at " + timecode + " to:\n" + tempPath);
    } else {
        alert("Export failed for sequence: " + seq.name);
    }
})();
