@echo off
rem The tandem CLI, run on the app's own Node, so a machine with no node
rem installed still gets a working `tandem`. The installer puts this next to
rem tandem.exe and puts that folder on PATH; see build/installer.nsh.
setlocal
set ELECTRON_RUN_AS_NODE=1
"%~dp0tandem.exe" "%~dp0resources\app.asar.unpacked\cli\tandem.js" %*
exit /b %errorlevel%
