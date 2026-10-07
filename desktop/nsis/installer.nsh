; Replace a leftover capitalized Intelio.lnk with a lowercase intelio shortcut to intelio.exe.
; Windows treats the two names as one file, so the old link is deleted before the new one is created.

!macro intelioReplaceShortcut dir
  Delete "${dir}\Intelio.lnk"
  Delete "${dir}\intelio.lnk"
  CreateShortCut "${dir}\intelio.lnk" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
  ClearErrors
  WinShell::SetLnkAUMI "${dir}\intelio.lnk" "${APP_ID}"
!macroend

!macro customInstall
  !insertmacro intelioReplaceShortcut "$DESKTOP"
  !insertmacro intelioReplaceShortcut "$SMPROGRAMS"
  Delete "$SMPROGRAMS\Intelio\Intelio.lnk"
  RMDir "$SMPROGRAMS\Intelio"
  Delete "$SMPROGRAMS\intelio\Intelio.lnk"
!macroend
