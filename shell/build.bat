@echo off
rem ============================================================
rem  DaFeiYu Toolbox shell build script
rem  Output: DaFeiYuToolbox.exe (this folder)
rem  Needs: .NET Framework 4 builtin compiler + WebView2 DLLs
rem  NOTE: keep this file ASCII-only. cmd.exe reads bat files
rem  in the ANSI codepage (GBK here); UTF-8 Chinese comments
rem  turn into garbage and shred every line (seen in practice).
rem ============================================================
setlocal
cd /d "%~dp0"

rem ---- WebView2 SDK binaries are NOT shipped with this repo (see .gitignore) ----
rem Check them before calling csc, otherwise the error is a cryptic "file not found".
set "MISSING="
if not exist "..\panel\Microsoft.Web.WebView2.Core.dll"    set "MISSING=1"
if not exist "..\panel\Microsoft.Web.WebView2.WinForms.dll" set "MISSING=1"
if not exist "..\panel\WebView2Loader.dll"                  set "MISSING=1"
if not defined MISSING goto dll_ok

echo [ERROR] WebView2 SDK DLLs are missing from panel\ ^(3 files^)
echo.
echo   This repo does not redistribute Microsoft's WebView2 binaries.
echo   Download them once, then build:
echo.
echo     1. Open  https://www.nuget.org/packages/Microsoft.Web.WebView2
echo     2. Download the .nupkg  ^(it is just a zip^), version 1.0.3351.48 or newer
echo     3. Copy these three files into panel\
echo.
echo          lib\net45\Microsoft.Web.WebView2.Core.dll
echo          lib\net45\Microsoft.Web.WebView2.WinForms.dll
echo          runtimes\win-x64\native\WebView2Loader.dll
echo.
echo   Detailed steps: see README.md
if not "%1"=="/nopause" pause
exit /b 1
:dll_ok

set FW=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319
if not exist "%FW%\csc.exe" (
  echo [ERROR] .NET Framework compiler not found: %FW%\csc.exe
  if not "%1"=="/nopause" pause
  exit /b 1
)

"%FW%\csc.exe" /nologo /target:winexe /platform:anycpu ^
  /r:System.dll /r:System.Core.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll ^
  /r:"..\panel\Microsoft.Web.WebView2.Core.dll" ^
  /r:"..\panel\Microsoft.Web.WebView2.WinForms.dll" ^
  /win32icon:..\web\brand.ico ^
  /out:DaFeiYuToolbox.exe ToolboxShell.cs

if errorlevel 1 (
  echo.
  echo [FAILED] compile error, send the output above to the assistant.
  if not "%1"=="/nopause" pause
  exit /b 1
)

echo.
echo [OK] DaFeiYuToolbox.exe built.

rem managed WebView2 DLLs + native loader must sit next to the exe at runtime
copy "..\panel\Microsoft.Web.WebView2.Core.dll" . >nul
copy "..\panel\Microsoft.Web.WebView2.WinForms.dll" . >nul
if not exist WebView2Loader.dll copy "..\panel\WebView2Loader.dll" . >nul

if not "%1"=="/nopause" pause
