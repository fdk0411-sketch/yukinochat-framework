@echo off
where node >nul 2>nul
if errorlevel 1 (echo Node.js 24 LTS is required. Visit https://nodejs.org/ & pause & exit /b 1)
node "%~dp0scripts\doctor.mjs"
pause
