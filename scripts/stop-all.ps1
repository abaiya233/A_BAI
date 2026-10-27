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
    # 排除工具箱自己：便携版的 node 跑的就是 <根>\server\server.mjs，
    # 它的命令行里带 "DaFeiYu"，不排除的话这里会把工具箱后端一起 Stop-Process 掉，
    # 表现就是点了「停止」之后界面永远停在「正在关闭大肥鱼」。
    if ($cl -match 'server\.mjs') { continue }
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

# 3) wait until the ports are really released (max 6s)
#    一次查出全部监听连接再筛端口，别再每个端口单独跑一遍 Get-NetTCPConnection。
$deadline = (Get-Date).AddSeconds(6)
while ((Get-Date) -lt $deadline) {
    $live = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
              Where-Object { $ports -contains $_.LocalPort })
    if ($live.Count -eq 0) { break }
    Start-Sleep -Milliseconds 300
}

exit 0