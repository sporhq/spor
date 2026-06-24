@echo off
where node >nul 2>nul || exit /b 0
node "%~dp0spor.js" %*
exit /b %errorlevel%
