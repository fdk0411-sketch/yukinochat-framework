@echo off
powershell.exe -NoLogo -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0Start-YukinoChat.ps1" %*
exit /b %errorlevel%
