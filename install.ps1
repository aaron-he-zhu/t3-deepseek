# T3 DeepSeek 一键安装脚本
# 交互式：右键"使用 PowerShell 运行"，或：
#   powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1
# 非交互（一条命令安装）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -ApiKey "sk-xxx" -DefaultModel "deepseek-reasoner" -NonInteractive
# 功能：保存 DeepSeek API Key -> 写入本地配置 -> 在 T3 Code 注册"T3 DeepSeek" provider。

param(
    [string]$ApiKey = "",
    [string]$BaseUrl = "",
    [string]$DefaultModel = "",
    [switch]$NonInteractive = $false
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$INSTANCE_ID = "acp_t3deepseek"
$PLUGIN_DIR   = Split-Path -Parent $PSScriptRoot
$CONFIG_DIR   = Join-Path $env:USERPROFILE ".t3-deepseek"
$CONFIG_FILE  = Join-Path $CONFIG_DIR "config.json"
$T3_HOME      = Join-Path $env:USERPROFILE ".t3"
$SETTINGS_FILE = Join-Path $T3_HOME "userdata\settings.json"
$T3_EXE       = Join-Path $env:LOCALAPPDATA "Programs\t3code\T3 Code (Beta).exe"
$LAUNCHER     = Join-Path $PLUGIN_DIR "bin\t3-deepseek.cmd"

Write-Host ""
Write-Host "==============================================" -ForegroundColor Cyan
Write-Host "  T3 DeepSeek 插件安装 — DeepSeek 官方 API"    -ForegroundColor Cyan
Write-Host "==============================================" -ForegroundColor Cyan
Write-Host ""

function Read-Secret([string]$Prompt) {
    Write-Host $Prompt -NoNewline -ForegroundColor Yellow
    $secure = Read-Host -AsSecureString
    if ($null -eq $secure) { return "" }
    $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { return [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
    finally { [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

# 1. 检查 T3 Code
if (-not (Test-Path $T3_EXE)) {
    Write-Host "未找到 T3 Code，请先安装（t3.chat）。" -ForegroundColor Red
    exit 1
}

# 2. 收集 API Key
$apiKey = $ApiKey.Trim()
if ([string]::IsNullOrWhiteSpace($apiKey)) {
    if ($NonInteractive) {
        Write-Host "非交互模式需要 -ApiKey 参数。" -ForegroundColor Red
        exit 1
    }
    Write-Host "DeepSeek API Key 获取地址：https://platform.deepseek.com/api_keys" -ForegroundColor DarkGray
    $apiKey = Read-Secret "请输入 DeepSeek API Key（输入不回显，直接粘贴后回车）："
}
if ([string]::IsNullOrWhiteSpace($apiKey)) {
    Write-Host "未输入 API Key，已取消。"
    exit 1
}

# 3. 可选：API 地址与默认模型
$baseUrl = "https://api.deepseek.com"
if (-not [string]::IsNullOrWhiteSpace($BaseUrl)) {
    $baseUrl = $BaseUrl.Trim()
} elseif (-not $NonInteractive) {
    $custom = Read-Host "API 地址（回车使用官方 $baseUrl）"
    if (-not [string]::IsNullOrWhiteSpace($custom)) { $baseUrl = $custom.Trim() }
}

$defaultModel = "deepseek-chat"
if ($DefaultModel -in @("2", "deepseek-reasoner", "reasoner")) {
    $defaultModel = "deepseek-reasoner"
} elseif ($DefaultModel -in @("1", "deepseek-chat", "chat")) {
    $defaultModel = "deepseek-chat"
} elseif (-not [string]::IsNullOrWhiteSpace($DefaultModel)) {
    Write-Host "未知默认模型：$DefaultModel（可选 deepseek-chat / deepseek-reasoner）" -ForegroundColor Red
    exit 1
} elseif (-not $NonInteractive) {
    Write-Host "默认模型："
    Write-Host "  [1] deepseek-chat     (DeepSeek-V3，通用/编码，推荐)" -ForegroundColor DarkGray
    Write-Host "  [2] deepseek-reasoner (DeepSeek-R1，深度推理)" -ForegroundColor DarkGray
    $choice = Read-Host "选择（回车默认 1）"
    if ($choice -eq "2") { $defaultModel = "deepseek-reasoner" }
}

# 4. 写入配置（仅本机用户目录，含 API Key）
if (-not (Test-Path $CONFIG_DIR)) { New-Item -ItemType Directory -Path $CONFIG_DIR | Out-Null }
$config = [ordered]@{
    version = 1
    apiKey  = $apiKey
    baseUrl = $baseUrl
    defaultModel = $defaultModel
    models = @(
        @{ id = "deepseek-chat";    name = "DeepSeek-V3 (deepseek-chat)";    description = "通用对话与编码模型" },
        @{ id = "deepseek-reasoner"; name = "DeepSeek-R1 (deepseek-reasoner)"; description = "深度推理模型" }
    )
}
# 无 BOM 写入（JSON.parse 不认 BOM）
$configJson = $config | ConvertTo-Json -Depth 10
[System.IO.File]::WriteAllText($CONFIG_FILE, $configJson, (New-Object System.Text.UTF8Encoding $false))
Write-Host "已写入配置：$CONFIG_FILE" -ForegroundColor Green

# 5. 注册 provider：先确认 T3 Code 已退出（避免它退出时覆盖 settings.json）
for (;;) {
    $running = Get-Process -Name "T3 Code (Beta)" -ErrorAction SilentlyContinue
    if ($null -eq $running) { break }
    if ($NonInteractive) {
        Write-Host "检测到 T3 Code 正在运行。非交互模式无法等待，请先退出 T3 Code 再重试。" -ForegroundColor Red
        exit 1
    }
    Write-Host ""
    Write-Host "检测到 T3 Code 正在运行。为防止配置被覆盖，请先完全退出 T3 Code。" -ForegroundColor Yellow
    Read-Host "退出完成后按回车继续（Ctrl+C 取消）"
}

# 6. 备份并修改 settings.json
if (-not (Test-Path $SETTINGS_FILE)) {
    Write-Host "未找到 T3 配置文件：$SETTINGS_FILE（请先启动过一次 T3 Code）" -ForegroundColor Red
    exit 1
}
$backup = "$SETTINGS_FILE.bak-t3deepseek-$(Get-Date -Format yyyyMMdd-HHmmss)"
Copy-Item $SETTINGS_FILE $backup
Write-Host "已备份配置：$backup" -ForegroundColor DarkGray

$settings = Get-Content $SETTINGS_FILE -Raw -Encoding UTF8 | ConvertFrom-Json
if ($null -eq $settings.providerInstances) {
    $settings | Add-Member -NotePropertyName providerInstances -NotePropertyValue ([pscustomobject]@{})
}

$entry = [ordered]@{
    driver      = "acpRegistry"
    displayName = "T3 DeepSeek"
    enabled     = $true
    config      = [ordered]@{
        source      = "local"
        commandPath = Join-Path $env:WINDIR "System32\cmd.exe"
        commandArgs = @("/d", "/c", "call", $LAUNCHER, "--profile", "acp")
    }
}

if ($null -eq $settings.providerInstances.$INSTANCE_ID) {
    $settings.providerInstances | Add-Member -NotePropertyName $INSTANCE_ID -NotePropertyValue $entry
    Write-Host "已注册新 provider：$INSTANCE_ID" -ForegroundColor Green
} else {
    $settings.providerInstances.$INSTANCE_ID = $entry
    Write-Host "已更新 provider：$INSTANCE_ID" -ForegroundColor Green
}

# 无 BOM 重写（与 T3 自己写出的 settings.json 保持一致）
$settingsJson = $settings | ConvertTo-Json -Depth 100
[System.IO.File]::WriteAllText($SETTINGS_FILE, $settingsJson, (New-Object System.Text.UTF8Encoding $false))

Write-Host ""
Write-Host "安装完成！" -ForegroundColor Green
Write-Host "  1. 启动 T3 Code"
Write-Host "  2. 新建线程时在模型选择器里选择 provider：T3 DeepSeek"
Write-Host "  3. 选择模型 deepseek-chat / deepseek-reasoner，开始对话"
Write-Host ""
Write-Host "自检：powershell -NoProfile -ExecutionPolicy Bypass -File verify.ps1" -ForegroundColor DarkGray
Write-Host "卸载：powershell -NoProfile -ExecutionPolicy Bypass -File uninstall.ps1" -ForegroundColor DarkGray
Write-Host ""
