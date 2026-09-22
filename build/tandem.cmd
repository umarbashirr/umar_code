@echo off
setlocal
set ELECTRON_RUN_AS_NODE=1
"%~dp0..\tandem.exe" "%~dp0..\resources\app.asar.unpacked\cli\tandem.js" %*
exit /b %errorlevel%
