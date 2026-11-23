; Open Tethery installer (Inno Setup 6). Build: ISCC.exe installer\OpenTethery.iss  ->  installer\Output\OpenTetherySetup.exe
; Needs first (see README.md): installer\build-helper-exe.ps1, the CEP/UXP panels, and the built Transmit .prm.
;
; Privileges: PrivilegesRequired=admin. Two things need admin no matter what: the firewall rule and the shared
; Adobe MediaCore plug-in folder under Program Files. One UAC prompt ("Yes once") is simpler and more reliable than
; a per-user install that elevates half-way. Everything else is still per-user (files in %LOCALAPPDATA%, HKCU, %APPDATA%).
; Caveat: if a different admin account approves the prompt, "per-user" paths belong to that admin. Normal single-user
; PCs are not affected.

#define AppName "Open Tethery"
#define VerFile FileOpen(SourcePath + "version.txt")
#define AppVersion FileRead(VerFile)
#expr FileClose(VerFile)
#define HelperExe "OpenTetheryHelper.exe"
#define RuleName "Open Tethery Helper"
#define Port "47825"
#define CepId "com.opentethery.panel"
#define PsPluginId "com.opentethery.photoshop"
#define MediaCoreDir "{commonpf64}\Adobe\Common\Plug-ins\7.0\MediaCore\OpenTethery"
#define UpiaExe "{commoncf64}\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe"

[Setup]
AppId={{6F1C0C52-7A0B-4E39-9D55-0E7B7C1A6B21}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=Open Tethery
DefaultDirName={localappdata}\OpenTethery
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputBaseFilename=OpenTetherySetup
OutputDir=Output
Compression=lzma2
SolidCompression=yes
; Ask to close Adobe apps that hold files we replace (Restart Manager) ...
CloseApplications=yes
CloseApplicationsFilter=Adobe Premiere Pro.exe,AfterFX.exe,Photoshop.exe,{#HelperExe}
RestartApplications=no
UninstallDisplayName={#AppName}
UninstallDisplayIcon={app}\{#HelperExe}
WizardStyle=modern

[Dirs]
Name: "{app}"

[InstallDelete]
; Old build of the panel
Type: filesandordirs; Name: "{userappdata}\Adobe\CEP\extensions\com.screenlive.video"
; Reinstall cleanly
Type: filesandordirs; Name: "{userappdata}\Adobe\CEP\extensions\{#CepId}"

[Files]
Source: "dist\helper\{#HelperExe}"; DestDir: "{app}"; Flags: ignoreversion
Source: "dist\helper\viewer\*"; DestDir: "{app}\viewer"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "dist\helper\profiles\*"; DestDir: "{app}\profiles"; Flags: ignoreversion recursesubdirs createallsubdirs skipifsourcedoesntexist
Source: "start-helper.vbs"; DestDir: "{app}"; Flags: ignoreversion
Source: "version.txt"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\panels\cep\*"; DestDir: "{userappdata}\Adobe\CEP\extensions\{#CepId}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\build\native\Release\OpenTetheryTransmit.prm"; DestDir: "{#MediaCoreDir}"; Flags: ignoreversion
Source: "dist\OpenTetheryPhotoshop.ccx"; DestDir: "{app}"; Flags: ignoreversion

[Registry]
; Allow unsigned CEP panels (kept on at uninstall: other panels may rely on it)
Root: HKCU; Subkey: "Software\Adobe\CSXS.9"; ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"
Root: HKCU; Subkey: "Software\Adobe\CSXS.10"; ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"
Root: HKCU; Subkey: "Software\Adobe\CSXS.11"; ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"
Root: HKCU; Subkey: "Software\Adobe\CSXS.12"; ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"
Root: HKCU; Subkey: "Software\Adobe\CSXS.13"; ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"
; Start the helper with Windows
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "OpenTetheryHelper"; ValueData: "wscript.exe ""{app}\start-helper.vbs"""; Flags: uninsdeletevalue

[Icons]
Name: "{autoprograms}\Uninstall Open Tethery"; Filename: "{uninstallexe}"

[Run]
; Replace the old "Live Video Preview" / "Live Phone Preview" rules and our own rule (idempotent)
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""{#RuleName}"""; Flags: runhidden; StatusMsg: "Updating firewall..."
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""Live Video Preview (TCP 47825)"""; Flags: runhidden
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""Live Phone Preview (TCP 47823)"""; Flags: runhidden
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall add rule name=""{#RuleName}"" dir=in action=allow protocol=TCP localport={#Port} profile=private"; Flags: runhidden
Filename: "{#UpiaExe}"; Parameters: "/install ""{app}\OpenTetheryPhotoshop.ccx"""; Flags: runhidden skipifdoesntexist; StatusMsg: "Installing Photoshop plug-in..."
Filename: "{sys}\wscript.exe"; Parameters: """{app}\start-helper.vbs"""; Flags: nowait runasoriginaluser postinstall skipifsilent; Description: "Start the Open Tethery helper now"

[UninstallRun]
Filename: "{sys}\taskkill.exe"; Parameters: "/F /IM {#HelperExe}"; Flags: runhidden; RunOnceId: "KillHelper"
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""{#RuleName}"""; Flags: runhidden; RunOnceId: "DelRule"
Filename: "{#UpiaExe}"; Parameters: "/remove {#PsPluginId}"; Flags: runhidden skipifdoesntexist; RunOnceId: "DelPsPlugin"

[UninstallDelete]
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
end;
