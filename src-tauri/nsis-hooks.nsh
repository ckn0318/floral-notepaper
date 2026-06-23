!macro NSIS_HOOK_PREINSTALL
  ; Prefer D:\<ProductName> when the user kept the standard per-user
  ; (LocalAppData) default AND a D: drive exists. Explicit choices on other
  ; drives, and machines without a D: drive (only C:/E:/F:…), keep their chosen
  ; location / the C: standard location.
  StrLen $R2 "$LOCALAPPDATA"
  StrCpy $R3 "$INSTDIR" $R2
  StrCmp $R3 "$LOCALAPPDATA" 0 floral_suffix
  IfFileExists "D:\*.*" 0 floral_suffix
  StrCpy $INSTDIR "D:\${PRODUCTNAME}"

  floral_suffix:
  ; Append the product name subdirectory if a generic parent folder was chosen.
  StrLen $R0 "\${PRODUCTNAME}"
  IntOp $R0 0 - $R0
  StrCpy $R1 "$INSTDIR" "" $R0
  StrCmp $R1 "\${PRODUCTNAME}" floral_done
  StrCpy $INSTDIR "$INSTDIR\${PRODUCTNAME}"
  floral_done:
!macroend
