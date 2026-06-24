@echo off
where node >nul 2>nul || exit /b 0
node "%~dp0spor-hook.js" %*
exit /b 0
