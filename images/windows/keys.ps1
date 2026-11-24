# Runs at every boot (scheduled task iflink-ci-keys, as SYSTEM). A job VM boots
# with a small CD (label CIKEYS) holding that job's login key and the guest's
# host key; they are installed and sshd started, so the guest trusts only this
# job's runner and the runner only this guest. Without the CD (the image
# build) nothing happens. The outcome goes to COM1, the job's console.log.
$ErrorActionPreference = 'Stop'
function Report([string]$text) {
  try {
    $port = New-Object System.IO.Ports.SerialPort 'COM1', 115200
    $port.Open(); $port.WriteLine($text); $port.Close()
  } catch {}
}
try {
  # The CD can appear a little after the startup trigger fires.
  $volume = $null
  for ($i = 0; $i -lt 30 -and -not $volume; $i++) {
    $volume = Get-Volume | Where-Object FileSystemLabel -eq 'CIKEYS' | Select-Object -First 1
    if (-not $volume) { Start-Sleep -Seconds 2 }
  }
  if (-not $volume) { Report 'iflink-ci-keys: no CIKEYS disc'; exit 0 }
  $src = "$($volume.DriveLetter):"
  $ssh = 'C:\ProgramData\ssh'
  New-Item -ItemType Directory -Force $ssh | Out-Null
  Copy-Item "$src\authorized_key" "$ssh\administrators_authorized_keys" -Force
  Copy-Item "$src\host" "$ssh\ssh_host_ed25519_key" -Force
  Copy-Item "$src\host.pub" "$ssh\ssh_host_ed25519_key.pub" -Force
  foreach ($file in 'administrators_authorized_keys', 'ssh_host_ed25519_key') {
    icacls.exe "$ssh\$file" /inheritance:r /grant 'Administrators:F' /grant 'SYSTEM:F' | Out-Null
  }
  Start-Service sshd
  Report "iflink-ci-keys: sshd $((Get-Service sshd).Status)"
} catch {
  Report "iflink-ci-keys: failed: $_"
}
