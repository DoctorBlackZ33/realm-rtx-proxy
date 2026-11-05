@echo off
setlocal
cd /d "%~dp0"

set "NODE=%~dp0runtime\node.exe"
if exist "%NODE%" goto launch
set "NODE=%~dp0runtime\node"
if exist "%NODE%" goto launch
where node >nul 2>nul
if errorlevel 1 goto missing
set "NODE=node"

:launch
"%NODE%" "%~dp0app.js" %*
set "RESULT=%ERRORLEVEL%"
goto finish

:missing
echo Node.js 24 or newer is required. Place the bundled runtime in runtime\ or install Node.js 24+ for source use.
set "RESULT=1"

:finish
echo.
pause
exit /b %RESULT%
