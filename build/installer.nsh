; FusionKit NSIS additions (electron-builder nsis.include).
;
; Local transcription needs Microsoft's VC++ v14 x64 runtime (MSVCP140, VCRUNTIME140,
; VCRUNTIME140_1, VCOMP140). The Windows build ships the signed redistributable in
; resources\vc-redist; scripts/packaging/vc-redist.mjs stages it and generates the version
; defines included below. After the files are installed, the redistributable runs only when the
; runtime is missing or older than the oldest one the transcription programs can use
; (VC_RUNTIME_MIN_*), not merely older than the bundled build, so updates (electron-updater runs
; this installer with /S) do not ask again on a computer where it works. It elevates itself:
; Windows shows one confirmation. Declining it, or any failure, never fails FusionKit's own
; installation; the application checks again and offers a repair button. A declined confirmation is
; remembered, so later updates do not ask again (a manual reinstall still does).

!include "vc-redist\vc-redist-version.nsh"

!define FUSIONKIT_SETUP_KEY "Software\FusionKit\Setup"

!macro customInstall
  Push $0
  Push $1
  Push $2
  Push $3

  ; The x64 runtime registers itself in the 64-bit registry view.
  SetRegView 64
  ReadRegDWORD $0 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Installed"
  ReadRegDWORD $1 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Major"
  ReadRegDWORD $2 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Minor"
  ReadRegDWORD $3 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Bld"
  SetRegView lastused

  ; Missing values read as empty strings; IntCmp treats them as 0.
  StrCmp $0 "1" 0 fusionkit_vc_install
  IntCmp $1 ${VC_RUNTIME_MIN_MAJOR} 0 fusionkit_vc_install fusionkit_vc_done
  IntCmp $2 ${VC_RUNTIME_MIN_MINOR} 0 fusionkit_vc_install fusionkit_vc_done
  IntCmp $3 ${VC_RUNTIME_MIN_BUILD} fusionkit_vc_done fusionkit_vc_install fusionkit_vc_done

  fusionkit_vc_install:
    IfFileExists "$INSTDIR\resources\vc-redist\vc_redist.x64.exe" 0 fusionkit_vc_done
    ; An update after the user declined once does not ask again; the application offers the repair.
    ${If} ${isUpdated}
      ReadRegStr $1 HKCU "${FUSIONKIT_SETUP_KEY}" "VcRedistDeclined"
      StrCmp $1 "" 0 fusionkit_vc_done
    ${EndIf}
    ; The progress page's status line, in the installer's language, before Windows asks.
    ${If} $LANGUAGE == 2052
      DetailPrint "正在安装微软运行库（本地转写需要）。Windows 弹出确认框时请选“是”。"
    ${ElseIf} $LANGUAGE == 1028
      DetailPrint "正在安裝微軟執行庫（本機轉寫需要）。Windows 跳出確認視窗時請選「是」。"
    ${ElseIf} $LANGUAGE == 1041
      DetailPrint "Microsoft ランタイムをインストールしています（ローカル文字起こしに必要）。Windows の確認画面では「はい」を選んでください。"
    ${Else}
      DetailPrint "Installing the Microsoft Visual C++ runtime ${VC_REDIST_VERSION} (needed for local transcription). Choose Yes when Windows asks."
    ${EndIf}
    ClearErrors
    ExecWait '"$INSTDIR\resources\vc-redist\vc_redist.x64.exe" /install /quiet /norestart' $0
    IfErrors fusionkit_vc_not_started
    ; 0 installed, 1638 a newer version is present, 3010 installed but needs a restart.
    StrCmp $0 "0" fusionkit_vc_installed
    StrCmp $0 "1638" fusionkit_vc_installed
    StrCmp $0 "3010" fusionkit_vc_installed
    ; 1602 or 1223: the confirmation was declined.
    StrCmp $0 "1602" fusionkit_vc_declined
    StrCmp $0 "1223" fusionkit_vc_declined
    DetailPrint "Microsoft Visual C++ Redistributable was skipped (exit code $0); FusionKit will offer to repair it."
    Goto fusionkit_vc_done

  fusionkit_vc_not_started:
    DetailPrint "Microsoft Visual C++ Redistributable was not started; FusionKit will offer to repair it."
    Goto fusionkit_vc_done

  fusionkit_vc_declined:
    WriteRegStr HKCU "${FUSIONKIT_SETUP_KEY}" "VcRedistDeclined" "${VC_REDIST_VERSION}"
    DetailPrint "Microsoft Visual C++ Redistributable was declined (exit code $0); FusionKit will offer to repair it."
    Goto fusionkit_vc_done

  fusionkit_vc_installed:
    DeleteRegValue HKCU "${FUSIONKIT_SETUP_KEY}" "VcRedistDeclined"

  fusionkit_vc_done:
  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend

; Uninstalling (not an update's removal of the old version) forgets the declined confirmation.
!macro customUnInstall
  ${IfNot} ${isUpdated}
    DeleteRegKey HKCU "${FUSIONKIT_SETUP_KEY}"
    DeleteRegKey /ifempty HKCU "Software\FusionKit"
  ${EndIf}
!macroend
