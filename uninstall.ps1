# T3 DeepSeek 卸载脚本：从 T3 Code 移除 provider 注册（可选：删除本地配置）
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$INSTANCE_ID   = "acp_t3deepseek"
$T3_HOME       = Join-Path $env:USERPROFILE ".t3"
$SETTINGS_FILE = Join-Path $T3_HOME "userdata\settings.json"
$CONFIG_DIR    = Join-Path $env:USERPROFILE ".t3-deepseek"

if (-not (Test-Path $SETTINGS_FILE)) {
    Write-Host "未找到 T3 配置文件，无需处理。"
} else {
    $running = Get-Process -Name "T3 Code (Beta)" -ErrorAction SilentlyContinue
    if ($null -ne $running) {
        Write-Host "请先完全退出 T3 Code，然后重新运行本脚本。" -ForegroundColor Yellow
        exit 1
    }
    $backup = "$SETTINGS_FILE.bak-t3deepseek-uninstall-$(Get-Date -Format yyyyMMdd-HHmmss)"
    Copy-Item $SETTINGS_FILE $backup
    $settings = Get-Content $SETTINGS_FILE -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($null -ne $settings.providerInstances.$INSTANCE_ID) {
        $settings.providerInstances.PSObject.Properties.Remove($INSTANCE_ID)
        $settingsJson = $settings | ConvertTo-Json -Depth 100
        [System.IO.File]::WriteAllText($SETTINGS_FILE, $settingsJson, (New-Object System.Text.UTF8Encoding $false))
        Write-Host "已移除 provider：$INSTANCE_ID" -ForegroundColor Green
    } else {
        Write-Host "provider 未注册，无需移除。"
    }
}

$answer = Read-Host "是否同时删除本地配置（含 API Key）目录 $CONFIG_DIR？(y/N)"
if ($answer -eq "y" -or $answer -eq "Y") {
    if (Test-Path $CONFIG_DIR) { Remove-Item -Recurse -Force $CONFIG_DIR }
    Write-Host "已删除本地配置。" -ForegroundColor Green
}
Write-Host "卸载完成。" -ForegroundColor Green
