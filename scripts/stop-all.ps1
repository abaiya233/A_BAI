# Stop DaFeiYu services: AstrBot(6185/6199) + SnowLuma(5099/3000/3001)
# 2026-10-26: also sweep by command line, because a crashed AstrBot can leave
# python children that no longer own a listening port, so "close" looked like a no-op.
$ErrorActionPreference = 'SilentlyContinue'

$ports = 6185, 6199, 5099, 3000, 3001
$targets = @()

# 1) whoever listens on our ports
foreach ($p in $ports) {
    $conns = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue
    foreach ($c in $conns) {
        if ($c.OwningProcess -gt 0) { $targets += [int]$c.OwningProcess }
    }
}

# 2) fallback sweep by command line (only these image names, so user's
#    unrelated python/node processes are left alone)
$procs = Get-CimInstance Win32_Process -Filter "Name='python.exe' OR Name='pythonw.exe' OR Name='node.exe' OR Name='AstrBot.exe'" -ErrorAction SilentlyContinue
foreach ($p in $procs) {
    $cl = $p.CommandLine
    if (-not $cl) { continue }
    if ($cl -match 'DaFeiYu' -or $cl -match 'snowluma' -or $cl -match '\.astrbot') {
        $targets += [int]$p.ProcessId
    }
}

$targets = $targets | Sort-Object -Unique
foreach ($procId in $targets) {
    if ($procId -le 4) { continue }
    $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if ($null -eq $proc) { continue }
    if ($proc.ProcessName -match '^(python|pythonw|node|AstrBot)$') {
        Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
    }
}

# 3) wait until the ports are really released (max 8s)
for ($i = 0; $i -lt 16; $i++) {
    Start-Sleep -Milliseconds 500
    $still = 0
    foreach ($p in $ports) {
        $c = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue
        if ($c) { $still = $still + 1 }
    }
    if ($still -eq 0) { break }
}

exit 0