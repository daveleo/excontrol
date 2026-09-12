; eXcontrol NSIS customisations.

!macro customInstall
  ; "Start when Windows starts" is a Settings toggle now, self-managed by the app via
  ; Electron's per-user login item (app.setLoginItemSettings, HKCU — no admin needed at
  ; runtime, unlike writing HKLM here would require). Nothing to do at install time; the app
  ; sets it on first launch (default: on, matching every install's behaviour before this was
  ; a toggle). See customUnInstall for the corresponding cleanup.
  ; allow the control UI through the Windows Firewall on the LAN (phones / tablets)
  nsExec::Exec 'netsh advfirewall firewall delete rule name="eXcontrol"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="eXcontrol" dir=in action=allow program="$INSTDIR\eXcontrol.exe" enable=yes profile=any'
!macroend

!macro customUnInstall
  ; Remove the app-managed per-user login item (HKCU). Electron's setLoginItemSettings
  ; writes it under the AppUserModelID (app.setAppUserModelId in main.ts), which matches
  ; this build's appId below -- NOT the app's display name, confirmed against a real
  ; installed instance (it does not write a value literally named "eXcontrol").
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "tech.expromo.excontrol"
  ; Also remove the old HKLM value from before autostart became a Settings toggle, in case
  ; this uninstall is running for an install from before that change.
  DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "eXcontrol"
  nsExec::Exec 'netsh advfirewall firewall delete rule name="eXcontrol"'
!macroend
