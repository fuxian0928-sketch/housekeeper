!macro customInit
  ; Older clients launched updates with /S. Force this installer back to the
  ; normal assisted flow so the user always sees and controls installation.
  SetSilent normal
!macroend
