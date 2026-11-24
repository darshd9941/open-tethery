; Pocket Monitor installer (Inno Setup 6). Normally built by installer\build-release.ps1 -> installer\dist\PocketMonitorSetup-<version>.exe
; Needs first (see README.md): dist\helper (build-helper-exe), dist\panel (SIGNED panel from sign-panel.ps1),
; dist\PocketMonitorPhotoshop.ccx and the built Transmit .prm. No PlayerDebugMode: the panel is signed.
;
; Privileges: PrivilegesRequired=admin. Two things need admin no matter what: the firewall rule and the shared
; Adobe MediaCore plug-in folder under Program Files. One UAC prompt ("Yes once") is simpler and more reliable than
; a per-user install that elevates half-way. Everything else is still per-user (files in %LOCALAPPDATA%, HKCU, %APPDATA%).
; Caveat: if a different admin account approves the prompt, "per-user" paths belong to that admin. Normal single-user
; PCs are not affected.

#define AppName "Pocket Monitor"
#define AppPublisher "Pocket Monitor"
#define InstallDirName "PocketMonitor"
#define PrmFile "PocketMonitorTransmit.prm"
#define VerFile FileOpen(SourcePath + "version.txt")
#define AppVersion FileRead(VerFile)
#expr FileClose(VerFile)
#define HelperExe "PocketMonitorHelper.exe"
#define RuleName "Pocket Monitor Helper"
#define RunValue "PocketMonitorHelper"
#define Port "47825"
#define CepId "com.pocketmonitor.panel"
#define PsPluginId "com.pocketmonitor.photoshop"
#define MediaCoreFolder "PocketMonitor"
#define MediaCoreDir "{commonpf64}\Adobe\Common\Plug-ins\7.0\MediaCore\" + MediaCoreFolder
#define UpiaExe "{commoncf64}\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe"

[Setup]
AppId={{6F1C0C52-7A0B-4E39-9D55-0E7B7C1A6B21}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={localappdata}\{#InstallDirName}
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputBaseFilename={#InstallDirName}Setup-{#AppVersion}
OutputDir=dist
SetupLogging=yes
UsePreviousAppDir=yes
VersionInfoVersion={#AppVersion}
VersionInfoProductName={#AppName}
UninstallDisplayName={#AppName}
Compression=lzma2
SolidCompression=yes
; Ask to close Adobe apps that hold files we replace (Restart Manager) ...
CloseApplications=yes
CloseApplicationsFilter=Adobe Premiere Pro.exe,AfterFX.exe,Photoshop.exe,{#HelperExe}
RestartApplications=no
UninstallDisplayIcon={app}\{#HelperExe}
WizardStyle=modern
WizardSizePercent=110
#ifexist "..\LICENSE"
LicenseFile=..\LICENSE
#endif

[Components]
Name: "adobe"; Description: "Premiere Pro and After Effects (panel, Transmit plug-in, helper)"; Types: full custom; Flags: fixed
Name: "photoshop"; Description: "Photoshop plug-in (optional)"; Types: full

[Types]
Name: "full"; Description: "Everything"
Name: "custom"; Description: "Custom"; Flags: iscustom

[Dirs]
Name: "{app}"

[InstallDelete]
; Old build of the panel
Type: filesandordirs; Name: "{userappdata}\Adobe\CEP\extensions\com.screenlive.video"
; Earlier name of this product (Open Tethery)
Type: filesandordirs; Name: "{userappdata}\Adobe\CEP\extensions\com.opentethery.panel"
Type: filesandordirs; Name: "{commonpf64}\Adobe\Common\Plug-ins\7.0\MediaCore\OpenTethery"
Type: filesandordirs; Name: "{localappdata}\OpenTethery"
; Reinstall cleanly
Type: filesandordirs; Name: "{userappdata}\Adobe\CEP\extensions\{#CepId}"

[Files]
Source: "dist\helper\{#HelperExe}"; DestDir: "{app}"; Flags: ignoreversion
Source: "dist\helper\viewer\*"; DestDir: "{app}\viewer"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "dist\helper\profiles\*"; DestDir: "{app}\profiles"; Flags: ignoreversion recursesubdirs createallsubdirs skipifsourcedoesntexist
Source: "start-helper.vbs"; DestDir: "{app}"; Flags: ignoreversion
Source: "version.txt"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\product.json"; DestDir: "{app}"; Flags: ignoreversion
; SIGNED panel (unpacked .zxp from sign-panel.ps1): loads without PlayerDebugMode
Source: "dist\panel\*"; DestDir: "{userappdata}\Adobe\CEP\extensions\{#CepId}"; Flags: ignoreversion recursesubdirs createallsubdirs; Components: adobe
Source: "..\build\native\Release\{#PrmFile}"; DestDir: "{#MediaCoreDir}"; Flags: ignoreversion; Components: adobe
Source: "dist\{#InstallDirName}Photoshop.ccx"; DestDir: "{app}"; Flags: ignoreversion; Components: photoshop

[Registry]
; Start the helper with Windows
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "{#RunValue}"; ValueData: "wscript.exe ""{app}\start-helper.vbs"""; Flags: uninsdeletevalue

[Icons]
Name: "{autoprograms}\Uninstall {#AppName}"; Filename: "{uninstallexe}"

[Run]
; Old product name: stop it, drop its start-up entry, firewall rules and Photoshop plug-in
Filename: "{sys}\taskkill.exe"; Parameters: "/F /IM OpenTetheryHelper.exe"; Flags: runhidden
Filename: "{sys}\reg.exe"; Parameters: "delete ""HKCU\Software\Microsoft\Windows\CurrentVersion\Run"" /v OpenTetheryHelper /f"; Flags: runhidden
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""Open Tethery Helper"""; Flags: runhidden
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""Open Tethery Helper (video)"""; Flags: runhidden
Filename: "{#UpiaExe}"; Parameters: "/remove com.opentethery.photoshop"; Flags: runhidden skipifdoesntexist
; Replace the old "Live Video Preview" / "Live Phone Preview" rules and our own rule (idempotent)
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""{#RuleName}"""; Flags: runhidden; StatusMsg: "Updating firewall..."
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""{#RuleName} (video)"""; Flags: runhidden; StatusMsg: "Updating firewall..."
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""Live Video Preview (TCP 47825)"""; Flags: runhidden
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""Live Phone Preview (TCP 47823)"""; Flags: runhidden
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall add rule name=""{#RuleName}"" dir=in action=allow protocol=TCP localport={#Port} profile=private"; Flags: runhidden
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall add rule name=""{#RuleName} (video)"" dir=in action=allow protocol=UDP program=""{app}\{#HelperExe}"" profile=private"; Flags: runhidden
Filename: "{#UpiaExe}"; Parameters: "/install ""{app}\{#InstallDirName}Photoshop.ccx"""; Flags: runhidden skipifdoesntexist; Components: photoshop; StatusMsg: "Installing Photoshop plug-in..."
Filename: "{sys}\wscript.exe"; Parameters: """{app}\start-helper.vbs"""; Flags: nowait runasoriginaluser postinstall skipifsilent; Description: "Start the {#AppName} helper now"

[UninstallRun]
Filename: "{sys}\taskkill.exe"; Parameters: "/F /IM {#HelperExe}"; Flags: runhidden; RunOnceId: "KillHelper"
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""{#RuleName}"""; Flags: runhidden; RunOnceId: "DelRule"
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""{#RuleName} (video)"""; Flags: runhidden; RunOnceId: "DelRuleVideo"
Filename: "{#UpiaExe}"; Parameters: "/remove {#PsPluginId}"; Flags: runhidden skipifdoesntexist; RunOnceId: "DelPsPlugin"
Filename: "{#UpiaExe}"; Parameters: "/remove com.opentethery.photoshop"; Flags: runhidden skipifdoesntexist; RunOnceId: "DelLegacyPsPlugin"
Filename: "{sys}\taskkill.exe"; Parameters: "/F /IM OpenTetheryHelper.exe"; Flags: runhidden; RunOnceId: "KillLegacyHelper"
Filename: "{sys}\reg.exe"; Parameters: "delete ""HKCU\Software\Microsoft\Windows\CurrentVersion\Run"" /v OpenTetheryHelper /f"; Flags: runhidden; RunOnceId: "DelLegacyRun"
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""Open Tethery Helper"""; Flags: runhidden; RunOnceId: "DelLegacyRule"

[UninstallDelete]
; Legacy leftovers (old panel builds and the earlier "Open Tethery" name)
Type: filesandordirs; Name: "{userappdata}\Adobe\CEP\extensions\com.screenlive.video"
Type: filesandordirs; Name: "{userappdata}\Adobe\CEP\extensions\com.opentethery.panel"
Type: filesandordirs; Name: "{commonpf64}\Adobe\Common\Plug-ins\7.0\MediaCore\OpenTethery"
Type: filesandordirs; Name: "{localappdata}\OpenTethery"
Type: filesandordirs; Name: "{userappdata}\Adobe\CEP\extensions\{#CepId}"
Type: filesandordirs; Name: "{#MediaCoreDir}"
Type: filesandordirs; Name: "{app}"

[Code]
function IsRunning(const ExeName: String): Boolean;
var
  Code: Integer;
begin
  // find.exe returns 0 when the name appears in the tasklist output
  Result := Exec(ExpandConstant('{sys}\cmd.exe'),
    '/C tasklist /FI "IMAGENAME eq ' + ExeName + '" | find /I "' + ExeName + '"',
    '', SW_HIDE, ewWaitUntilTerminated, Code) and (Code = 0);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Code: Integer;
  Names: array of String;
  I: Integer;
begin
  Result := '';
  // Restart Manager only notices apps holding files we replace; check all three by name.
  SetArrayLength(Names, 3);
  Names[0] := 'Adobe Premiere Pro.exe';
  Names[1] := 'AfterFX.exe';
  Names[2] := 'Photoshop.exe';
  for I := 0 to 2 do
    if IsRunning(Names[I]) then
    begin
      Result := Names[I] + ' is still running. Please close Premiere Pro, After Effects and Photoshop, then choose Back and Next to retry.';
      Exit;
    end;
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM {#HelperExe}', '', SW_HIDE, ewWaitUntilTerminated, Code);
  // Old "Open Tethery" helpers: the dev install ran node.exe from LocalAppData\OpenTethery and kept ports
  // 47825/47826, so the new helper could not start. Stop every process running from our old or new folders.
  Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
    '-NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq ''OpenTetheryHelper.exe'' -or ($_.ExecutablePath -and ($_.ExecutablePath -like ''' +
    ExpandConstant('{localappdata}') + '\OpenTethery\*'' -or $_.ExecutablePath -like ''' + ExpandConstant('{localappdata}') +
    '\{#InstallDirName}\*'')) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"',
    '', SW_HIDE, ewWaitUntilTerminated, Code);
end;
