param([ValidateSet('Start', 'Check', 'Smoke')][string]$Action = 'Start')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$nodePath = if ($nodeCommand) { $nodeCommand.Source } else {
  Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
}
if (-not (Test-Path -LiteralPath $nodePath)) { throw 'Install Node.js >= 22 first.' }
$tsxPath = Join-Path $projectRoot 'node_modules\tsx\dist\cli.mjs'
if (-not (Test-Path -LiteralPath $tsxPath)) { throw 'Dependencies missing. Run npm ci in the project directory first.' }
Push-Location $projectRoot
try {
  if ($Action -eq 'Start') {
    & $nodePath 'scripts/build-web.mjs'
    if ($LASTEXITCODE -ne 0) { throw 'Browser build failed.' }
    & $nodePath $tsxPath 'apps/server/src/index.ts'
  } elseif ($Action -eq 'Smoke') {
    & $nodePath $tsxPath 'scripts/smoke.ts'
  } else {
    & $nodePath 'scripts/check.mjs'
  }
  if ($LASTEXITCODE -ne 0) { throw "Local $Action failed." }
} finally { Pop-Location }
