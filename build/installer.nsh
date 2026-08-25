; Two things the packaged installer does not do on its own: put the tandem CLI
; where a shell can find it, and offer a folder to Tandem from Explorer.
;
; The PATH edit goes through PowerShell rather than raw registry writes. The
; user PATH is REG_EXPAND_SZ, it has a length limit worth respecting, and
; SetEnvironmentVariable broadcasts the change so a shell opened afterwards
; sees it. Hand-rolling that in NSIS is a well known way to eat somebody's PATH.

!macro tandemRunPS Script
  InitPluginsDir
  FileOpen $9 "$PLUGINSDIR\tandem-path.ps1" w
  FileWrite $9 "${Script}"
  FileClose $9
  nsExec::ExecToLog 'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\tandem-path.ps1"'
  Pop $9
!macroend

!macro customInstall
  ; `tandem .` from PowerShell or cmd, the way the .deb puts it on PATH.
  !insertmacro tandemRunPS "$$dir = '$INSTDIR'; $$p = [Environment]::GetEnvironmentVariable('Path','User'); if ($$null -eq $$p) { $$p = '' }; if (-not (($$p -split ';') -contains $$dir)) { [Environment]::SetEnvironmentVariable('Path', ($$p.TrimEnd(';') + ';' + $$dir).TrimStart(';'), 'User') }"

  ; Right-click a folder, or the background of one you are inside, and open it.
  ; %V is the folder in both cases; %1 is not, for the background verb.
  WriteRegStr HKCU "Software\Classes\Directory\shell\Tandem" "" "Open with Tandem"
  WriteRegStr HKCU "Software\Classes\Directory\shell\Tandem" "Icon" "$INSTDIR\tandem.exe"
  WriteRegStr HKCU "Software\Classes\Directory\shell\Tandem\command" "" '"$INSTDIR\tandem.exe" "%V"'
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\Tandem" "" "Open with Tandem"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\Tandem" "Icon" "$INSTDIR\tandem.exe"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\Tandem\command" "" '"$INSTDIR\tandem.exe" "%V"'
!macroend

!macro customUnInstall
  !insertmacro tandemRunPS "$$dir = '$INSTDIR'; $$p = [Environment]::GetEnvironmentVariable('Path','User'); if ($$p) { $$kept = ($$p -split ';' | Where-Object { $$_ -and $$_ -ne $$dir }) -join ';'; [Environment]::SetEnvironmentVariable('Path', $$kept, 'User') }"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\Tandem"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\Tandem"
!macroend
