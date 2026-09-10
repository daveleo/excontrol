; eXcontrol NSIS customisations.

!macro customInstall
  ; start eXcontrol automatically at any user login (this is a dedicated control PC)
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "eXcontrol" '"$INSTDIR\eXcontrol.exe"'
  ; allow the control UI through the Windows Firewall on the LAN (phones / tablets)
  nsExec::Exec 'netsh advfirewall firewall delete rule name="eXcontrol"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="eXcontrol" dir=in action=allow program="$INSTDIR\eXcontrol.exe" enable=yes profile=any'
!macroend

!macro customUnInstall
  DeleteRegValue HKLM "Software\Microsoft\Windows\CurrentVersion\Run" "eXcontrol"
  nsExec::Exec 'netsh advfirewall firewall delete rule name="eXcontrol"'
!macroend
