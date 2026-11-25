# Prépare le serveur CSM embarqué dans l'app native : node.exe + le code du serveur (mêmes fichiers que l'app
# Electron) + ses modules de production, dans un zip que CsmNative.csproj intègre à l'exécutable (server.zip).
# node-pty est livré compilé en N-API (prebuilds/win32-x64) : le même binaire marche avec ce Node, sans compilation.
# Utilisation : pwsh native/windows/pack-server.ps1 [-Out out/server.zip] [-Node chemin\node.exe]
param([string]$Out = "$PSScriptRoot\..\..\out\server.zip", [string]$Node = (Get-Command node).Source)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path "$PSScriptRoot\..\..").Path
$stage = Join-Path ([IO.Path]::GetTempPath()) "csm-server-$([guid]::NewGuid().ToString('n'))"
New-Item -ItemType Directory -Force $stage | Out-Null
try {
  foreach ($d in 'bin', 'lib', 'public', 'scripts', 'electron') { Copy-Item -Recurse (Join-Path $root $d) (Join-Path $stage $d) }
  foreach ($f in 'server.js', 'hook.js', 'statusline.js', 'pick-folder.ps1', 'package.json', 'package-lock.json') { Copy-Item (Join-Path $root $f) $stage }
  # modules de production seulement ; pas de script d'installation (node-pty a ses binaires prêts)
  npm ci --prefix $stage --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error
  if ($LASTEXITCODE) { throw "npm ci a échoué ($LASTEXITCODE)" }
  # allègement : symboles de débogage, sources et binaires des autres plateformes de node-pty
  Get-ChildItem $stage -Recurse -Include *.pdb, *.map | Remove-Item -Force
  $pty = Join-Path $stage 'node_modules\node-pty'
  foreach ($d in 'deps', 'src', 'third_party', 'scripts', 'typings') { Remove-Item -Recurse -Force (Join-Path $pty $d) -ErrorAction SilentlyContinue }
  Get-ChildItem (Join-Path $pty 'prebuilds') -Directory | Where-Object Name -ne 'win32-x64' | Remove-Item -Recurse -Force
  Copy-Item $Node (Join-Path $stage 'node.exe')
  if (-not (Test-Path (Join-Path $pty 'prebuilds\win32-x64\pty.node'))) { throw 'node-pty : binaire win32-x64 absent' }
  New-Item -ItemType Directory -Force (Split-Path $Out) | Out-Null
  Remove-Item $Out -Force -ErrorAction SilentlyContinue
  Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $Out -CompressionLevel Optimal
  $v = (Get-Content (Join-Path $stage 'package.json') -Raw | ConvertFrom-Json).version
  "serveur $v embarqué : $Out ($([math]::Round((Get-Item $Out).Length / 1MB, 1)) Mo, node $(& $Node --version))"
}
finally { Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue }
