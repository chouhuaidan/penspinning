@echo off
setlocal
cd /d "%~dp0"
where node.exe >nul 2>&1
if errorlevel 1 (
  echo Spinframe requires Node.js 20 or newer.
  pause
  exit /b 1
)
if not exist "node_modules\@mediapipe\tasks-vision\vision_bundle.mjs" goto install
if exist "node_modules\three\build\three.module.js" goto setup
:install
  call npm.cmd ci
  if errorlevel 1 goto failed
:setup
call npm.cmd run setup
if errorlevel 1 goto failed
node server.mjs --open
if not errorlevel 1 exit /b 0
:failed
pause
exit /b 1
