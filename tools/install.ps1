# 手动安装「我的日记」到本机。
# 不依赖 electron-builder 的 NSIS 安装器（在当前环境下行为不可观测），
# 直接复制已打包的 win-unpacked，并自行创建快捷方式与卸载项。

param(
  # 默认安装项目里的 release\win-unpacked。
  # 项目目录若在同步盘（Seafile 等）里，release 下的文件可能被同步客户端锁住而无法重建，
  # 这时可以把构建输出到别处，再用 -Source 指过去安装。
  [string]$Source = ''
)

$ErrorActionPreference = 'Stop'

# 从脚本自身位置推导项目根目录，这样 clone 到任何路径都能直接用
$Root    = Split-Path $PSScriptRoot -Parent
if (-not $Source) { $Source = Join-Path $Root 'release\win-unpacked' }
$Dest    = Join-Path $env:LOCALAPPDATA 'Programs\我的日记'
$ExeName = '我的日记.exe'
$AppName = '我的日记'

if (-not (Test-Path (Join-Path $Source $ExeName))) {
  throw "找不到打包产物: $Source\$ExeName —— 请先运行 electron-builder"
}

Write-Host "源:      $Source"
Write-Host "目标:    $Dest"

# 如果旧版本在运行则先停掉
Get-Process -Name ([System.IO.Path]::GetFileNameWithoutExtension($ExeName)) -ErrorAction SilentlyContinue |
  ForEach-Object { Write-Host "停止运行中的进程 PID $($_.Id)"; Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }

if (Test-Path $Dest) {
  Write-Host '目标目录已存在，先清理'
  Remove-Item $Dest -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $Dest | Out-Null

Write-Host '复制文件…'
Copy-Item (Join-Path $Source '*') -Destination $Dest -Recurse -Force
Copy-Item (Join-Path $Root 'build\icon.ico') -Destination (Join-Path $Dest 'icon.ico') -Force

$TargetExe = Join-Path $Dest $ExeName
if (-not (Test-Path $TargetExe)) { throw "复制后找不到 $TargetExe" }

# ---------- 卸载脚本 ----------
$UninstallPs1 = Join-Path $Dest 'uninstall.ps1'
$uninstallBody = @"
`$ErrorActionPreference = 'SilentlyContinue'
`$dest = '$Dest'
Get-Process -Name '我的日记' | Stop-Process -Force
Start-Sleep -Milliseconds 800
foreach (`$lnk in @(
  (Join-Path `$env:APPDATA 'Microsoft\Windows\Start Menu\Programs\我的日记.lnk'),
  (Join-Path ([Environment]::GetFolderPath('Desktop')) '我的日记.lnk')
)) { if (Test-Path `$lnk) { Remove-Item `$lnk -Force } }
Remove-Item 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\我的日记' -Recurse -Force
Set-Location `$env:TEMP
Remove-Item `$dest -Recurse -Force
Write-Host '「我的日记」已卸载。'
"@
Set-Content -Path $UninstallPs1 -Value $uninstallBody -Encoding UTF8
Write-Host "卸载脚本: $UninstallPs1"

# ---------- 快捷方式 ----------
$shell = New-Object -ComObject WScript.Shell

function New-Shortcut($lnkPath, $target, $iconPath, $workdir) {
  $dir = Split-Path $lnkPath -Parent
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  $sc = $shell.CreateShortcut($lnkPath)
  $sc.TargetPath       = $target
  $sc.WorkingDirectory = $workdir
  $sc.IconLocation     = "$iconPath,0"
  $sc.Description      = '我的日记 - 本地日记本'
  $sc.Save()
  Write-Host "快捷方式: $lnkPath"
}

$StartMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\我的日记.lnk'
New-Shortcut $StartMenu $TargetExe (Join-Path $Dest 'icon.ico') $Dest

$Desktop = Join-Path ([Environment]::GetFolderPath('Desktop')) '我的日记.lnk'
New-Shortcut $Desktop $TargetExe (Join-Path $Dest 'icon.ico') $Dest

# ---------- 卸载注册表项 ----------
$RegPath = 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\我的日记'
if (Test-Path $RegPath) { Remove-Item $RegPath -Recurse -Force }
New-Item -Path $RegPath -Force | Out-Null
$size = (Get-ChildItem $Dest -Recurse -File | Measure-Object Length -Sum).Sum
$kb = [int]($size / 1KB)

Set-ItemProperty -Path $RegPath -Name 'DisplayName'     -Value $AppName
Set-ItemProperty -Path $RegPath -Name 'DisplayVersion'  -Value '1.0.0'
Set-ItemProperty -Path $RegPath -Name 'Publisher'       -Value 'local'
Set-ItemProperty -Path $RegPath -Name 'InstallLocation' -Value $Dest
Set-ItemProperty -Path $RegPath -Name 'DisplayIcon'     -Value "$TargetExe,0"
Set-ItemProperty -Path $RegPath -Name 'EstimatedSize'   -Value $kb -Type DWord
Set-ItemProperty -Path $RegPath -Name 'NoModify'        -Value 1 -Type DWord
Set-ItemProperty -Path $RegPath -Name 'NoRepair'        -Value 1 -Type DWord
Set-ItemProperty -Path $RegPath -Name 'UninstallString' -Value "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$UninstallPs1`""

Write-Host ''
Write-Host '安装完成。'
Write-Host "  程序:     $TargetExe"
Write-Host "  开始菜单: $StartMenu"
Write-Host "  桌面:     $Desktop"
Write-Host "  卸载:     设置 > 应用 > 我的日记"


