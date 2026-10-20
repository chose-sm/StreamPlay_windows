; Firewall: povolí príchod spojení len pre StreamPlay, port 8765 a len z lokálnej podsiete.
; Platí pre súkromné aj verejné siete (Windows často označí domácu sieť ako verejnú).
; Vďaka tomu sa Windows pri prvom spustení nebude pýtať a pravidlo nie je širšie než treba.
!macro customInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="StreamPlay"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="StreamPlay" dir=in action=allow program="$INSTDIR\${APP_EXECUTABLE_FILENAME}" protocol=TCP localport=8765 remoteip=localsubnet profile=any enable=yes'
!macroend

!macro customUnInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="StreamPlay"'
!macroend
