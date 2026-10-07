# Starts the SakugaTV server hidden, unless it is already running.
$porta = 8765
if (Get-NetTCPConnection -LocalPort $porta -State Listen -ErrorAction SilentlyContinue) { exit 0 }
Start-Process -FilePath 'node' -ArgumentList 'server.mjs' -WorkingDirectory $PSScriptRoot -WindowStyle Hidden
