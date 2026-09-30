@echo off
title FixPath - Smart Guided Troubleshooting Engine
cd /d "%~dp0"
echo.
echo Starting FixPath...
echo If port 8080 is busy, the server will automatically try the next free port.
echo.
node server\index.js
pause
