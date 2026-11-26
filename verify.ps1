# T3 DeepSeek 自检脚本：检查配置状态并跑协议级测试（mock 后端，不消耗 API 额度）。
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File verify.ps1
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$PLUGIN_DIR  = Split-Path -Parent $PSScriptRoot
$T3_EXE      = Join-Path $env:LOCALAPPDATA "Programs\t3code\T3 Code (Beta).exe"
$CONFIG_FILE = Join-Path $env:USERPROFILE ".t3-deepseek\config.json"
$SETTINGS_FILE = Join-Path $env:USERPROFILE ".t3\userdata\settings.json"

Write-Host ""
Write-Host "========== T3 DeepSeek 自检 ==========" -ForegroundColor Cyan

# 1. 插件配置
$ok = $true
if (-not (Test-Path $CONFIG_FILE)) {
    Write-Host "[1/4] 本地配置：未找到（请先运行 install.ps1）" -ForegroundColor Yellow
    $ok = $false
} else {
    try {
        $config = Get-Content $CONFIG_FILE -Raw -Encoding UTF8 | ConvertFrom-Json
        $keyOk = -not [string]::IsNullOrWhiteSpace($config.apiKey)
        Write-Host "[1/4] 本地配置：存在，API Key $($(if ($keyOk) { "已设置" } else { "缺失" }))，baseUrl=$($config.baseUrl)，默认模型=$($config.defaultModel)" -ForegroundColor $(if ($keyOk) { "Green" } else { "Yellow" })
        if (-not $keyOk) { $ok = $false }
    } catch {
        Write-Host "[1/4] 本地配置：存在但解析失败：$($_.Exception.Message)" -ForegroundColor Red
        $ok = $false
    }
}

# 2. T3 注册状态
if (-not (Test-Path $SETTINGS_FILE)) {
    Write-Host "[2/4] T3 注册：settings.json 不存在（请先启动过一次 T3 Code）" -ForegroundColor Yellow
    $ok = $false
} else {
    try {
        $settings = Get-Content $SETTINGS_FILE -Raw -Encoding UTF8 | ConvertFrom-Json
        $registered = $null -ne $settings.providerInstances.acp_t3deepseek
        if ($registered) {
            $e = $settings.providerInstances.acp_t3deepseek
            Write-Host "[2/4] T3 注册：已注册（driver=$($e.driver)，source=$($e.config.source)，enabled=$($e.enabled)）" -ForegroundColor Green
        } else {
            Write-Host "[2/4] T3 注册：未注册（请运行 install.ps1）" -ForegroundColor Yellow
            $ok = $false
        }
    } catch {
        Write-Host "[2/4] T3 注册：settings.json 解析失败：$($_.Exception.Message)" -ForegroundColor Red
        $ok = $false
    }
}

# 3. 启动器与运行时
if (-not (Test-Path $T3_EXE)) {
    Write-Host "[3/4] 运行时：未找到 T3 Code" -ForegroundColor Red
    $ok = $false
} else {
    Write-Host "[3/4] 运行时：T3 Code 存在（将复用其内置 Electron 运行时）" -ForegroundColor Green
}

# 4. 协议级测试
Write-Host "[4/4] 协议测试：运行中…"
$env:ELECTRON_RUN_AS_NODE = "1"
$harness = Join-Path $PLUGIN_DIR "test\harness.mjs"
& $T3_EXE $harness
$testOk = ($LASTEXITCODE -eq 0)
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
if ($testOk) { Write-Host "[4/4] 协议测试：全部通过" -ForegroundColor Green }
else { Write-Host "[4/4] 协议测试：失败（详见上方输出）" -ForegroundColor Red }

Write-Host ""
if ($ok -and $testOk) {
    Write-Host "自检通过：重启 T3 Code 后即可在模型选择器里选择 T3 DeepSeek。" -ForegroundColor Green
} else {
    Write-Host "自检未完全通过，请按上方提示处理。" -ForegroundColor Yellow
}
Write-Host ""
exit $(if ($ok -and $testOk) { 0 } else { 1 })
