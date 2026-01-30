/**
 * System tray icon using PowerShell + .NET NotifyIcon.
 * Communicates back to Bun via stdout lines: "open", "show", "quit".
 */

import { showConsole } from "./console";

const DASHBOARD_URL = "http://localhost:3200";

function openDashboard() {
  Bun.spawn(["cmd", "/c", "start", DASHBOARD_URL], {
    stdio: ["ignore", "ignore", "ignore"],
  });
}

function buildPowerShellScript(wallId: string, exePath: string): string {
  // Escape backslashes for PowerShell string
  const psExePath = exePath.replace(/\\/g, "\\\\");
  return `
[System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms') | Out-Null
[System.Reflection.Assembly]::LoadWithPartialName('System.Drawing') | Out-Null

try {
  $icon = [System.Drawing.Icon]::ExtractAssociatedIcon("${psExePath}")
} catch {
  $icon = [System.Drawing.SystemIcons]::Application
}

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = $icon
$notify.Text = "Vu Watchdog - Wall ${wallId}"
$notify.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip

$openItem = New-Object System.Windows.Forms.ToolStripMenuItem
$openItem.Text = "Open Dashboard"
$openItem.Add_Click({
  [Console]::Out.WriteLine("open")
  [Console]::Out.Flush()
})
$menu.Items.Add($openItem) | Out-Null

$showItem = New-Object System.Windows.Forms.ToolStripMenuItem
$showItem.Text = "Show Console"
$showItem.Add_Click({
  [Console]::Out.WriteLine("show")
  [Console]::Out.Flush()
})
$menu.Items.Add($showItem) | Out-Null

$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

$quitItem = New-Object System.Windows.Forms.ToolStripMenuItem
$quitItem.Text = "Quit"
$quitItem.Add_Click({
  [Console]::Out.WriteLine("quit")
  [Console]::Out.Flush()
  $notify.Visible = $false
  $notify.Dispose()
  [System.Windows.Forms.Application]::ExitThread()
})
$menu.Items.Add($quitItem) | Out-Null

$notify.ContextMenuStrip = $menu

$notify.Add_MouseClick({
  param($sender, $e)
  if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
    [Console]::Out.WriteLine("open")
    [Console]::Out.Flush()
  }
})

[System.Windows.Forms.Application]::Run()
`;
}

export function startTray(wallId: string): { proc: ReturnType<typeof Bun.spawn> } {
  const script = buildPowerShellScript(wallId, process.execPath);

  // Open dashboard in browser on startup
  openDashboard();

  const proc = Bun.spawn(["powershell", "-NoProfile", "-WindowStyle", "Hidden", "-Command", script], {
    stdio: ["ignore", "pipe", "ignore"],
  });

  // Read stdout lines for commands
  (async () => {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);

        switch (line) {
          case "open":
            openDashboard();
            break;
          case "show":
            showConsole();
            break;
          case "quit":
            console.log("[watchdog] Quit requested from tray");
            proc.kill();
            process.exit(0);
            break;
        }
      }
    }
  })();

  return { proc };
}
