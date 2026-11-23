@echo off
setlocal EnableDelayedExpansion
title Install Live Video Preview Panel
cd /d "%~dp0"

echo ========================================================
echo Installing Live Video Preview Panel for Premiere ^& AE
echo ========================================================
echo.

set "TARGET_DIR=%APPDATA%\Adobe\CEP\extensions\com.screenlive.video"
set "SOURCE_DIR=%~dp0extension"

if not exist "%APPDATA%\Adobe\CEP\extensions" (
  mkdir "%APPDATA%\Adobe\CEP\extensions" 2>nul
)

if exist "%TARGET_DIR%" (
  echo Removing existing extension link...
  rmdir "%TARGET_DIR%" 2>nul
  if exist "%TARGET_DIR%" (
    del /f /q "%TARGET_DIR%" 2>nul
  )
)

echo Linking extension to Adobe CEP directory...
mklink /J "%TARGET_DIR%" "%SOURCE_DIR%" >nul 2>&1
if errorlevel 1 (
  echo Note: Junction failed, copying files directly...
  xcopy /E /I /Y "%SOURCE_DIR%" "%TARGET_DIR%" >nul
)

echo.
echo Enabling PlayerDebugMode in Windows Registry...
for %%V in (9 10 11 12 13 14 15 16 17 18 19 20 21 22) do (
  reg add "HKCU\Software\Adobe\CSXS.%%V" /v PlayerDebugMode /t REG_SZ /d 1 /f >nul 2>&1
)

echo.
echo ========================================================
echo INSTALLATION COMPLETE!
echo.
echo How to use:
echo 1. Launch "Start Live Preview.bat"
echo 2. Open Adobe Premiere Pro or Adobe After Effects
echo 3. In the top menu, go to:
echo    Window -^> Extensions -^> Live Video Preview
echo 4. Click "Start Preview" and scan the QR code with your phone!
echo ========================================================
echo.
pause
