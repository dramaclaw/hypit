; Per-user only. Profile/bindings, credentials, WhisperX Program Home, all caches and projects are retained.
!macro customUnInstall
  ${IfNot} ${isUpdated}
    System::Call 'Kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", t "1") i.r0'
    nsExec::ExecToStack /TIMEOUT=30000 '"$INSTDIR\Hypit Setup.exe" "$INSTDIR\resources\app.asar\dist\cleanup.cjs" --integration-only'
    Pop $0
    Pop $1
    System::Call 'Kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", t "") i.r2'
    ${If} $0 != 0
      MessageBox MB_OK|MB_ICONEXCLAMATION "Hypit 本机集成清理失败。配置、凭据和视频项目已保留。本地语音资源、模型缓存和 Profile 绑定已保留；如需释放空间，请按桌面安装指南人工检查。请检查以下路径：$\r$\n$LOCALAPPDATA\Hypit\bin\hypit.cmd$\r$\n通用 Skill：$PROFILE\.agents\skills\hypit$\r$\nClaude Code 兼容副本：$PROFILE\.claude\skills\hypit$\r$\n旧版手动恢复：$PROFILE\.codex\skills\hypit$\r$\n用户 PATH (HKCU\Environment\Path)。$\r$\n$1"
    ${ElseIf} $1 != ""
      MessageBox MB_OK|MB_ICONINFORMATION "$1"
    ${EndIf}
  ${EndIf}
!macroend
