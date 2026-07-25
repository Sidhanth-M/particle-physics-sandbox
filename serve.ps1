# Static dev server for the sandbox. ES modules will not load over file://.
param([int]$Port = 8000)

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

Write-Host "Serving $root at http://localhost:$Port" -ForegroundColor Cyan
Write-Host "Self-checks: http://localhost:$Port/?selfcheck" -ForegroundColor DarkGray

if (Get-Command python -ErrorAction SilentlyContinue) {
  python serve.py $Port      # no-cache headers; see serve.py for why
} elseif (Get-Command npx -ErrorAction SilentlyContinue) {
  npx --yes serve -l $Port .
} else {
  Write-Error "Need python or npx on PATH to serve the files."
}
