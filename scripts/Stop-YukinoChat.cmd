@echo off
powershell.exe -NoLogo -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0Stop-YukinoChat.ps1" %*
exit /b %errorlevel%
