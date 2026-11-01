@echo off
setlocal
cd /d "%~dp0"
title Melvor Idle 2 Companion

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   The companion needs Node.js, which isn't installed yet.
  echo   Download the LTS version from https://nodejs.org , install it, then run this again.
  echo.
  start "" "https://nodejs.org/en/download"
  pause
  exit /b 1
)

node server\server.js %*
if errorlevel 1 pause
