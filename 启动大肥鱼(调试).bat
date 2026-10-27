@echo off
rem DaFeiYu Toolbox - debug launcher (keeps the console window so you can read errors)
setlocal
cd /d "%~dp0"

set "NODE=%~dp0runtime\node.exe"
if not exist "%NODE%" set "NODE=node.exe"

if not exist "%~dp0server\server.mjs" (
  echo [ERROR] server\server.mjs not found.
  echo Make sure the whole folder was extracted from the zip.
  pause
  exit /b 1
)

echo Using node: %NODE%
echo Starting toolbox on http://127.0.0.1:8788/
echo Close this window to stop the toolbox.
echo.

"%NODE%" "%~dp0server\server.mjs" --open

echo.
echo [server exited with code %errorlevel%]
pause
