# T3 DeepSeek 一键引导安装（供 coding agent 或命令行直接调用）
# 对任意 agent 说："安装 aaron-he-zhu/t3-deepseek"，agent 只需执行：
#   powershell -NoProfile -ExecutionPolicy Bypass -Command "iwr 'https://raw.githubusercontent.com/aaron-he-zhu/t3-deepseek/main/bootstrap.ps1' -OutFile $env:TEMP\t3ds-bootstrap.ps1; & $env:TEMP\t3ds-bootstrap.ps1"
# 也可以手动运行（PowerShell 5.1 兼容）。
# 说明：API Key 不必在安装时提供——安装后重启 T3 Code，选中 T3 DeepSeek 发起对话时，
#       插件会通过 T3 的表单弹出输入框索取 Key，提交后自动保存。

param(
    [string]$ApiKey = "",
    [string]$InstallDir = "",
    [string]$SourceUrl = "https://codeload.github.com/aaron-he-zhu/t3-deepseek/zip/refs/heads/main"
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$INSTANCE_ID   = "acp_t3deepseek"
if ([string]::IsNullOrWhiteSpace($InstallDir)) {
    $InstallDir = Join-Path $env:USERPROFILE ".t3-deepseek\plugin"
}
$CONFIG_DIR    = Join-Path $env:USERPROFILE ".t3-deepseek"
$CONFIG_FILE   = Join-Path $CONFIG_DIR "config.json"
$T3_HOME       = Join-Path $env:USERPROFILE ".t3"
$SETTINGS_FILE = Join-Path $T3_HOME "userdata\settings.json"
$LAUNCHER      = Join-Path $InstallDir "bin\t3-deepseek.cmd"

Write-Host ""
Write-Host "========== T3 DeepSeek 一键安装 ==========" -ForegroundColor Cyan

# 1. 下载并部署插件
$zip = Join-Path $env:TEMP "t3-deepseek-main.zip"
$extract = Join-Path $env:TEMP "t3-deepseek-extract"
Write-Host "[1/4] 下载插件：$SourceUrl"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Invoke-WebRequest -Uri $SourceUrl -OutFile $zip -TimeoutSec 180
if (Test-Path $extract) { Remove-Item $extract -Recurse -Force }
Expand-Archive -Path $zip -DestinationPath $extract -Force
$sourceDir = Get-ChildItem $extract -Directory | Select-Object -First 1
if ($null -eq $sourceDir) { throw "解压失败：未找到插件目录" }
if (Test-Path $InstallDir) { Remove-Item $InstallDir -Recurse -Force }
New-Item -ItemType Directory -Path (Split-Path -Parent $InstallDir) -Force | Out-Null
Copy-Item (Join-Path $sourceDir.FullName "*") $InstallDir -Recurse -Force
Remove-Item $zip -Force -ErrorAction SilentlyContinue
Remove-Item $extract -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "已安装到：$InstallDir" -ForegroundColor Green

# 2. 可选：写入 API Key（不提供则首次对话时由插件弹表单索取）
if (-not [string]::IsNullOrWhiteSpace($ApiKey)) {
    if (-not (Test-Path $CONFIG_DIR)) { New-Item -ItemType Directory -Path $CONFIG_DIR | Out-Null }
    $config = [ordered]@{
        version = 1
        apiKey  = $ApiKey.Trim()
        baseUrl = "https://api.deepseek.com"
        defaultModel = "deepseek-chat"
        models = @(
            @{ id = "deepseek-chat";    name = "DeepSeek-V3 (deepseek-chat)";    description = "通用对话与编码模型" },
            @{ id = "deepseek-reasoner"; name = "DeepSeek-R1 (deepseek-reasoner)"; description = "深度推理模型" }
        )
    }
    $configJson = $config | ConvertTo-Json -Depth 10
    [System.IO.File]::WriteAllText($CONFIG_FILE, $configJson, (New-Object System.Text.UTF8Encoding $false))
    Write-Host "[2/4] 已保存 API Key 到 $CONFIG_FILE" -ForegroundColor Green
} else {
    Write-Host "[2/4] 未提供 -ApiKey：首次对话时插件会弹出输入框索取" -ForegroundColor DarkGray
}

# 3. 注册 T3 provider（允许 T3 运行中：写入后重启 T3 生效）
if (-not (Test-Path $SETTINGS_FILE)) {
    Write-Host "[3/4] 未找到 T3 配置：$SETTINGS_FILE（请先启动过一次 T3 Code 再重试）" -ForegroundColor Red
    exit 1
}
$backup = "$SETTINGS_FILE.bak-t3deepseek-$(Get-Date -Format yyyyMMdd-HHmmss)"
Copy-Item $SETTINGS_FILE $backup
Write-Host "[3/4] 已备份 T3 配置：$backup" -ForegroundColor DarkGray

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
} else {
    $settings.providerInstances.$INSTANCE_ID = $entry
}
# 无 BOM 重写（与 T3 自己写出的 settings.json 保持一致）
$settingsJson = $settings | ConvertTo-Json -Depth 100
[System.IO.File]::WriteAllText($SETTINGS_FILE, $settingsJson, (New-Object System.Text.UTF8Encoding $false))
Write-Host "[3/4] 已注册 provider：$INSTANCE_ID" -ForegroundColor Green

# 4. 完成提示
Write-Host "[4/4] 安装完成！" -ForegroundColor Green
Write-Host ""
Write-Host "接下来："
Write-Host "  1. 重启 T3 Code（重启前请勿修改任何 T3 设置，避免覆盖注册）"
Write-Host "  2. 新建线程，在模型选择器里选择 provider：T3 DeepSeek"
Write-Host "  3. 首次对话会弹出 DeepSeek API Key 输入框，粘贴提交即完成"
Write-Host ""
Write-Host "卸载：powershell -NoProfile -ExecutionPolicy Bypass -File `"$InstallDir\uninstall.ps1`"" -ForegroundColor DarkGray
Write-Host ""
