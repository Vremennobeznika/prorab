#define MyAppName "Прораб"
#define MyAppVersion "0.4.2"
[Setup]
AppId={{60BF5C40-1868-4E48-927C-16717E132BE8}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
DefaultDirName={localappdata}\Programs\Prorab
DefaultGroupName={#MyAppName}
OutputDir=..\dist
OutputBaseFilename=Prorab-Setup-0.4.2
Compression=lzma2
SolidCompression=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={app}\Прораб.exe
DisableProgramGroupPage=yes
WizardStyle=modern
[Files]
Source: "..\build\desktop\*.dll"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\build\desktop\WEBVIEW2-LICENSE.txt"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\build\desktop\MicrosoftEdgeWebview2Setup.exe"; DestDir: "{tmp}"; Flags: deleteafterinstall
Source: "..\build\Прораб.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\build\runtime\*"; DestDir: "{app}\runtime"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\build\app\*"; DestDir: "{app}\app"; Flags: ignoreversion recursesubdirs createallsubdirs
[Icons]
Name: "{autoprograms}\Прораб"; Filename: "{app}\Прораб.exe"
Name: "{autodesktop}\Прораб"; Filename: "{app}\Прораб.exe"; Tasks: desktopicon
[Tasks]
Name: "desktopicon"; Description: "Создать ярлык на рабочем столе"; Flags: unchecked
[Run]
Filename: "{tmp}\MicrosoftEdgeWebview2Setup.exe"; Parameters: "/silent /install"; Flags: runhidden waituntilterminated; Check: NeedsWebView2
Filename: "{app}\Прораб.exe"; Description: "Запустить Прораб"; Flags: nowait postinstall skipifsilent
[UninstallDelete]
; Папка данных пользователя намеренно не удаляется при деинсталляции.

[Code]
function NeedsWebView2: Boolean;
var
  Version: String;
begin
  Result := not ((RegQueryStringValue(HKLM32, 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', Version) or
    RegQueryStringValue(HKCU, 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', Version)) and (Version <> '') and (Version <> '0.0.0.0'));
end;
