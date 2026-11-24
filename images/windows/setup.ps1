# Provisions the Windows CI job image once, at the build's automatic logon
# (autounattend.xml), from the build CD (label CIBUILD) the builder made:
# PowerShell 7, uv with a managed Python 3.12, Git, OpenSSH Server started per
# job by keys.ps1. Powers the VM off when done; the builder waits for that.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# The builder reads COM1 (a file on the host) to know how this ended.
function Report([string]$text) {
  try {
    $port = New-Object System.IO.Ports.SerialPort 'COM1', 115200
    $port.Open(); $port.WriteLine($text); $port.Close()
  } catch {}
}
Start-Transcript -Path C:\ci-setup.log
try {
  $src = (Get-Volume | Where-Object FileSystemLabel -eq 'CIBUILD' | Select-Object -First 1).DriveLetter + ':'
  New-Item -ItemType Directory -Force C:\ci | Out-Null

  Expand-Archive "$src\PowerShell-win-x64.zip" 'C:\Program Files\PowerShell\7' -Force
  # Node 24 and npm, as on GitHub's Windows runners.
  Expand-Archive "$src\node-win-x64.zip" C:\ci\node-unpack -Force
  Move-Item (Get-ChildItem C:\ci\node-unpack -Directory | Select-Object -First 1).FullName 'C:\Program Files\nodejs'
  Remove-Item C:\ci\node-unpack -Recurse -Force
  New-Item -ItemType Directory -Force 'C:\Program Files\uv' | Out-Null
  Expand-Archive "$src\uv-x86_64-pc-windows-msvc.zip" 'C:\Program Files\uv' -Force
  $git = Start-Process -Wait -PassThru -FilePath "$src\Git-64-bit.exe" -ArgumentList '/VERYSILENT', '/NORESTART', '/NOCANCEL', '/SP-', '/SUPPRESSMSGBOXES'
  if ($git.ExitCode -ne 0) { throw "Git setup exited $($git.ExitCode)" }

  # Python lives where every job's uv finds it, so no job downloads it again.
  [Environment]::SetEnvironmentVariable('UV_PYTHON_INSTALL_DIR', 'C:\ci\uv-python', 'Machine')
  $env:UV_PYTHON_INSTALL_DIR = 'C:\ci\uv-python'
  & 'C:\Program Files\uv\uv.exe' python install 3.12
  if ($LASTEXITCODE -ne 0) { throw "uv python install exited $LASTEXITCODE" }

  $path = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  [Environment]::SetEnvironmentVariable('Path', "C:\Program Files\PowerShell\7;C:\Program Files\nodejs;C:\Program Files\uv;C:\Program Files\Git\cmd;$path", 'Machine')

  # A throwaway build VM: no real-time scanning, no automatic updates.
  Set-MpPreference -DisableRealtimeMonitoring $true -ErrorAction SilentlyContinue
  New-Item -Force 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU' | Out-Null
  Set-ItemProperty 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU' -Name NoAutoUpdate -Value 1

  # OpenSSH Server ships with Windows Server 2025; keys.ps1 starts it once
  # this job's keys are in place.
  if (-not (Get-Service sshd -ErrorAction SilentlyContinue)) { Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0 | Out-Null }
  Set-Service sshd -StartupType Manual
  # Only the host's port forward reaches a job VM (QEMU user networking), and
  # on that unidentified network the Public profile blocks sshd.
  Set-NetFirewallProfile -Profile Domain, Private, Public -Enabled False
  Copy-Item "$src\keys.ps1" C:\ci\keys.ps1 -Force
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -ExecutionPolicy Bypass -File C:\ci\keys.ps1'
  Register-ScheduledTask -TaskName 'iflink-ci-keys' -Action $action -Trigger (New-ScheduledTaskTrigger -AtStartup) -User 'SYSTEM' -RunLevel Highest -Force | Out-Null

  # The build password is not needed again: no automatic logon after this.
  $winlogon = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
  Set-ItemProperty $winlogon -Name AutoAdminLogon -Value 0
  Remove-ItemProperty $winlogon -Name DefaultPassword -ErrorAction SilentlyContinue
  'ok' | Set-Content C:\ci\image-ready
  Report 'IFLINK-CI-IMAGE-READY'
} catch {
  Report "IFLINK-CI-IMAGE-FAILED: $_"
} finally {
  Stop-Transcript
  shutdown.exe /s /t 5 /f
}
