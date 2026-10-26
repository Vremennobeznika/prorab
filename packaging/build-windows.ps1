$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
trap { Write-Host ('::error::' + ($_.Exception.Message.Replace('%','%25').Replace("`r",'%0D').Replace("`n",'%0A'))); exit 1 }
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$build = Join-Path $root 'build'
$dist = Join-Path $root 'dist'
New-Item -ItemType Directory -Path $build, $dist -Force | Out-Null
$runtime = Join-Path $build 'runtime'
$app = Join-Path $build 'app'
New-Item -ItemType Directory -Path $runtime, $app -Force | Out-Null
$node = (Get-Command node.exe -ErrorAction Stop).Source
Copy-Item $node (Join-Path $runtime 'node.exe') -Force
$nodeDir = Split-Path $node -Parent
$nodeLicense = @(
  (Join-Path $nodeDir 'LICENSE'),
  (Join-Path (Split-Path $nodeDir -Parent) 'LICENSE')
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($nodeLicense) { Copy-Item $nodeLicense (Join-Path $runtime 'NODE-LICENSE.txt') -Force }
else { throw 'Не найдена лицензия Node.js для включения в дистрибутив.' }
foreach ($name in @('src','web','agents','config','certs')) {
  Copy-Item (Join-Path $root $name) (Join-Path $app $name) -Recurse -Force
}
foreach ($document in @('README.md','MEMORY.md','WORKSPACE.md','ORIGINS.md','THIRD_PARTY_NOTICES.md')) {
  Copy-Item -LiteralPath (Join-Path $root $document) -Destination (Join-Path $app $document) -Force
}
# Official public CAs. Keep HTTPS verification enabled and fail the build on any error.
# No system certificate store is modified; only the GigaChat adapter uses this bundle.
$caDownload = Join-Path $build 'gigachat-ca'
New-Item -ItemType Directory -Path $caDownload -Force | Out-Null
$rootCa = Join-Path $caDownload 'root.crt'
$subCa = Join-Path $caDownload 'sub.crt'
Invoke-WebRequest 'https://gu-st.ru/content/lending/russian_trusted_root_ca_pem.crt' -UseBasicParsing -TimeoutSec 60 -OutFile $rootCa
Invoke-WebRequest 'https://gu-st.ru/content/lending/russian_trusted_sub_ca_pem.crt' -UseBasicParsing -TimeoutSec 60 -OutFile $subCa
& $node (Join-Path $root 'scripts/prepare-gigachat-certs.mjs') $rootCa $subCa (Join-Path $app 'certs/russian_trusted_root_ca_pem.crt')
if ($LASTEXITCODE -ne 0) { throw 'GigaChat CA validation failed' }
# Pinned Microsoft SDK with checksum validation; the renderer runtime is signed by Microsoft.
$desktop = Join-Path $build 'desktop'
New-Item -ItemType Directory -Path $desktop -Force | Out-Null
$package = Join-Path $desktop 'webview2.nupkg'
Invoke-WebRequest 'https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/1.0.2903.40/microsoft.web.webview2.1.0.2903.40.nupkg' -OutFile $package
if ((Get-FileHash $package -Algorithm SHA256).Hash.ToLowerInvariant() -ne 'ef128016dd1e51c59178c827ed5b8aa3322c57afa8675d930f8109505542ad74') { throw 'WebView2 SDK checksum mismatch' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$sdk = Join-Path $desktop 'sdk'
if (!(Test-Path $sdk)) { [System.IO.Compression.ZipFile]::ExtractToDirectory($package, $sdk) }
Copy-Item (Join-Path $sdk 'lib/net462/Microsoft.Web.WebView2.Core.dll') $desktop -Force
Copy-Item (Join-Path $sdk 'lib/net462/Microsoft.Web.WebView2.WinForms.dll') $desktop -Force
Copy-Item (Join-Path $sdk 'runtimes/win-x64/native/WebView2Loader.dll') $desktop -Force
Copy-Item (Join-Path $sdk 'LICENSE.txt') (Join-Path $desktop 'WEBVIEW2-LICENSE.txt') -Force
$bootstrapper = Join-Path $desktop 'MicrosoftEdgeWebview2Setup.exe'
Invoke-WebRequest 'https://go.microsoft.com/fwlink/p/?LinkId=2124703' -OutFile $bootstrapper
$signature = Get-AuthenticodeSignature $bootstrapper
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') { throw 'WebView2 installer signature verification failed' }
# Windows 10/11 ships .NET Framework. PowerShell 5.1 compiles a native-looking GUI launcher,
# which hosts the workspace in WebView2 and starts the bundled Node runtime invisibly.
$compiler = New-Object System.CodeDom.Compiler.CompilerParameters
$compiler.CompilerOptions = '/platform:x64'
$compiler.GenerateExecutable = $true
$compiler.OutputAssembly = Join-Path $build 'Прораб.exe'
$compiler.ReferencedAssemblies.AddRange(@('System.dll','System.Core.dll','System.Drawing.dll','System.Windows.Forms.dll','System.Web.Extensions.dll',(Join-Path $desktop 'Microsoft.Web.WebView2.Core.dll'),(Join-Path $desktop 'Microsoft.Web.WebView2.WinForms.dll')))
$compiler.CompilerOptions += ' /target:winexe'
$provider = New-Object Microsoft.CSharp.CSharpCodeProvider
$result = $provider.CompileAssemblyFromFile($compiler, (Join-Path $PSScriptRoot 'ProrabLauncher.cs'))
if ($result.Errors.HasErrors) { throw (($result.Errors | ForEach-Object { $_.ToString() }) -join "`n") }
$inno = @(
  "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
  "$env:ProgramFiles\Inno Setup 6\ISCC.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $inno) { throw 'Требуется Inno Setup 6 для формирования установщика.' }
& $inno (Join-Path $PSScriptRoot 'Prorab.iss')
if ($LASTEXITCODE -ne 0) { throw "Сборка инсталлятора завершилась с кодом $LASTEXITCODE" }
Get-FileHash (Join-Path $dist 'Prorab-Setup-0.5.0.exe') -Algorithm SHA256
