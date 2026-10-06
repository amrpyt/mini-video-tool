@echo off
cd /d "%~dp0"
where bun >nul 2>nul
if errorlevel 1 (
  echo Bun is not installed or not on PATH.
  pause
  exit /b 1
)
bun local-web\server.ts
