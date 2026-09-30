@echo off
title FixPath - Smart Guided Troubleshooting Engine
cd /d "%~dp0sgte"
echo.
echo Starting FixPath...
echo Node.js 18+ is required. No npm install is needed.
echo.
node server\index.js
pause
