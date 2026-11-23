@echo off
setlocal
title Live Video Preview Relay (Premiere Pro ^& After Effects)
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo Node.js is required. Install Node.js from https://nodejs.org/
  echo then run this file again.
  echo.
  pause
  exit /b 1
)

if not exist "relay\node_modules\ws\package.json" (
  echo Installing relay dependencies ^(one time^)...
  pushd relay
  call npm install --omit=dev --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo npm install failed.
    popd
    pause
    exit /b 1
  )
  popd
)

for /f "delims=" %%p in ('node -e "try{console.log(require('./config.json').port||47825)}catch(e){console.log(47825)}"') do set PORT=%%p

echo.
echo Starting Live Video Preview Relay on port %PORT%...
echo Keep this window open while editing in Premiere Pro or After Effects.
echo.

start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:%PORT%/'"

node "relay\server.js"

echo.
echo The relay stopped.
pause
