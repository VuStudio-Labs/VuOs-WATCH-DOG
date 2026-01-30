/**
 * Hide/show the console window using Windows API via PowerShell.
 */

function runPowerShell(command: string) {
  Bun.spawnSync(["powershell", "-NoProfile", "-Command", command], {
    stdio: ["ignore", "ignore", "ignore"],
  });
}

const WIN32_TYPE = `
Add-Type -Name Win32 -Namespace Console -MemberDefinition '
[DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
'`;

export function hideConsole() {
  runPowerShell(`${WIN32_TYPE}; [Console.Win32]::ShowWindow([Console.Win32]::GetConsoleWindow(), 0)`);
}

export function showConsole() {
  runPowerShell(`${WIN32_TYPE}; [Console.Win32]::ShowWindow([Console.Win32]::GetConsoleWindow(), 5)`);
}
