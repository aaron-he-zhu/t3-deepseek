@echo off
rem T3 DeepSeek - local ACP agent launcher for T3 Code.
rem Uses node >= 18 from PATH when present; otherwise reuses T3 Code's bundled Electron runtime (ELECTRON_RUN_AS_NODE).
setlocal EnableExtensions
set "SERVER=%~dp0..\src\acp-server.mjs"

rem Allow overriding the T3 Code install location.
if not defined T3CODE_EXE set "T3CODE_EXE=%LOCALAPPDATA%\Programs\t3code\T3 Code (Beta).exe"

rem Detect node major version; only node >= 18 has fetch/findLast.
set "NODE_MAJOR="
where node >nul 2>nul
if not errorlevel 1 for /f "delims=v." %%v in ('node -v 2^>nul') do set "NODE_MAJOR=%%v"

if not defined NODE_MAJOR goto check_electron
if %NODE_MAJOR% GEQ 18 goto use_node

:check_electron
if exist "%T3CODE_EXE%" goto electron
echo [t3-deepseek] failed to start: no Node 18+ and no T3 Code (%T3CODE_EXE%). 1>&2
exit /b 127

:use_node
node "%SERVER%" %*
exit /b %ERRORLEVEL%

:electron
set "ELECTRON_RUN_AS_NODE=1"
"%T3CODE_EXE%" "%SERVER%" %*
exit /b %ERRORLEVEL%
