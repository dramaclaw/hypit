; Per-user only. Profile, credentials, runtimes and projects are retained.
!macro customUnInstall
  ${IfNot} ${isUpdated}
    System::Call 'Kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", t "1") i.r0'
    nsExec::ExecToStack /TIMEOUT=30000 '"$INSTDIR\Hypit Setup.exe" "$INSTDIR\resources\app.asar\dist\cleanup.cjs" --integration-only'
    Pop $0
    Pop $1
    System::Call 'Kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", t "") i.r2'
    ${If} $0 != 0
      MessageBox MB_OK|MB_ICONEXCLAMATION "Hypit 本机集成清理失败。配置、凭据和视频项目已保留，请检查以下路径：$\r$\n$LOCALAPPDATA\Hypit\bin\hypit.cmd$\r$\n通用 Skill：$PROFILE\.agents\skills\hypit$\r$\nClaude Code 兼容副本：$PROFILE\.claude\skills\hypit$\r$\n旧版手动恢复：$PROFILE\.codex\skills\hypit$\r$\n用户 PATH (HKCU\Environment\Path)。$\r$\n$1"
    ${ElseIf} $1 != ""
      MessageBox MB_OK|MB_ICONINFORMATION "$1"
    ${EndIf}
  ${EndIf}
!macroend
