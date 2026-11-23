// Live Preview - After Effects ScriptUI Panel
// Can be run via File > Scripts > Run Script File... or placed in:
// "Adobe After Effects <Version>/Support Files/Scripts/ScriptUI Panels/"

(function(thisObj) {
    function buildUI(container) {
        var win = (container instanceof Panel) ? container : new Window("palette", "Live Phone Preview", undefined, {resizeable: true});
        win.orientation = "column";
        win.alignChildren = ["fill", "top"];
        win.spacing = 8;
        win.margins = 10;

        var statusGroup = win.add("group");
        statusGroup.orientation = "row";
        var dot = statusGroup.add("statictext", undefined, "●");
        dot.graphics.foregroundColor = dot.graphics.newPen(dot.graphics.PenType.SOLID_COLOR, [0.5, 0.5, 0.5, 1], 1);
        var lblStatus = statusGroup.add("statictext", undefined, "Ready");
        lblStatus.characters = 25;

        var btnExport = win.add("button", undefined, "Send Current Frame");
        
        btnExport.onClick = function() {
            if (!app.project || !app.project.activeItem || !(app.project.activeItem instanceof CompItem)) {
                alert("Please select an active composition.");
                return;
            }
            var comp = app.project.activeItem;
            var tempPath = Folder.temp.fsName + "/ae_manual_frame.png";
            var file = new File(tempPath);
            if (file.exists) file.remove();

            comp.saveFrameToPng(comp.time, file);
            if (file.exists) {
                lblStatus.text = "Frame exported: " + comp.name;
                dot.graphics.foregroundColor = dot.graphics.newPen(dot.graphics.PenType.SOLID_COLOR, [0.2, 0.8, 0.2, 1], 1);
            } else {
                lblStatus.text = "Export failed";
            }
        };

        if (win instanceof Window) {
            win.center();
            win.show();
        }
        return win;
    }

    buildUI(thisObj);
})(this);
