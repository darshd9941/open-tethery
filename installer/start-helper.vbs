' Starts PocketMonitorHelper.exe hidden, from the folder this script sits in.
' Used by the Inno Setup installer and the start-up (Run) entry.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Environment("Process")("OT_VIEWER_DIR") = dir & "\viewer"
sh.Run """" & dir & "\PocketMonitorHelper.exe""", 0, False
