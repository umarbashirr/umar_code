@echo off
rem The tandem CLI, run on the app's own Node, so a machine with no node
rem installed still gets a working `tandem`. Lives in %INSTDIR%\bin so PATH
rem never sees tandem.exe beside it: PATHEXT prefers .EXE over .CMD, and a
rem shared folder made bare `tandem` launch the GUI. See build/installer.nsh.
setlocal
set ELECTRON_RUN_AS_NODE=1
"%~dp0..\tandem.exe" "%~dp0..\resources\app.asar.unpacked\cli\tandem.js" %*
exit /b %errorlevel%
