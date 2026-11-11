; Mantis для Windows: дополнения к установщику Tauri (NSIS). Установка – для всех пользователей, с правами администратора.
;
; - Перед копированием файлов закрываем встроенный Агент: иначе Windows не даст заменить mantis-agent.exe.
;   Сам Mantis (mantis.exe) установщик Tauri закрывает сам, спросив пользователя.
; - Правило брандмауэра для Агента: он ищет IP-камеры в сети магазина (ONVIF, UDP 3702) и принимает их видео.
;   Без правила Windows при первом поиске камер покажет окно «Брандмауэр заблокировал некоторые функции».
;   Только частные и доменные сети (сеть магазина), не общественные. При удалении правило убирается.

!macro NSIS_HOOK_PREINSTALL
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /IM mantis-agent.exe'
  Pop $0
!macroend

!macro NSIS_HOOK_POSTINSTALL
  nsExec::Exec '"$SYSDIR\netsh.exe" advfirewall firewall delete rule name="Mantis IP cameras"'
  Pop $0
  nsExec::Exec '"$SYSDIR\netsh.exe" advfirewall firewall add rule name="Mantis IP cameras" dir=in action=allow program="$INSTDIR\mantis-agent.exe" enable=yes profile=private,domain'
  Pop $0
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /IM mantis-agent.exe'
  Pop $0
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  nsExec::Exec '"$SYSDIR\netsh.exe" advfirewall firewall delete rule name="Mantis IP cameras"'
  Pop $0
!macroend
