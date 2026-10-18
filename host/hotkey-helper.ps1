# dsh-screencapture global hotkey helper.
#
# Warm Windows PowerShell worker owned by host/hotkey.js. It registers exactly
# one OS-global hotkey with Win32 RegisterHotKey on a hidden WinForms form and
# pumps that form's message loop, printing one `hotkey` line per WM_HOTKEY.
#
#   powershell.exe -NoLogo -NoProfile -NonInteractive -STA -ExecutionPolicy Bypass \
#     -File hotkey-helper.ps1 <vk> <modifiers>
#
# <vk>        decimal virtual-key code (for example 65 = 0x41 = KeyA)
# <modifiers> decimal bit mask: MOD_ALT 0x1, MOD_CONTROL 0x2, MOD_SHIFT 0x4, MOD_WIN 0x8
#
# stdout protocol (one line per event, flushed):
#   ready|<vk>|<modifiers>   registration succeeded (exactly one line)
#   error|<win32code>        registration failed (the process then exits)
#   hotkey                   WM_HOTKEY received (one line per press)
#
# stdin protocol (one line per command):
#   exit                     the process exits
#   ping                     prints OK|hotkey-ping
#   (closing stdin also exits, so a dead parent can never leak this process)
#
# A background .NET thread reads stdin (Console.In) so the main thread can stay
# inside the WinForms message pump; the pump polls that queue every few
# milliseconds. MOD_NOREPEAT is added to the registered mask so holding the
# chord does not auto-repeat capture; the host also debounces per event.

param(
  [Parameter(Mandatory = $true)][int]$VirtualKey,
  [Parameter(Mandatory = $true)][int]$Modifiers
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type -ReferencedAssemblies @('System.Windows.Forms', 'System.Drawing') -TypeDefinition @"
using System;
using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

public static class DshScreenshotHotkeyNative
{
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool RegisterHotKey(IntPtr hWnd, int id, int fsModifiers, int vk);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool UnregisterHotKey(IntPtr hWnd, int id);
}

// Hidden form whose only job is to receive WM_HOTKEY. The window handle is
// created by the owning window thread (the PowerShell main thread) and is never
// shown; the message loop below pumps its messages.
public class DshScreenshotHotkeyForm : Form
{
    public int HotkeyCount;

    public DshScreenshotHotkeyForm()
    {
        ShowInTaskbar = false;
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.Manual;
        Location = new System.Drawing.Point(-32000, -32000);
        Size = new System.Drawing.Size(1, 1);
    }

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == 0x0312)   // WM_HOTKEY
        {
            HotkeyCount++;
            return;
        }
        base.WndProc(ref m);
    }
}

// Background stdin reader: Console.In is read on a managed thread so that the
// main PowerShell thread can keep pumping Windows messages. Closing stdin marks
// the reader closed, which the host loop treats as "parent is gone, exit".
public class DshScreenshotStdinReader
{
    private readonly ConcurrentQueue<string> lines = new ConcurrentQueue<string>();
    private volatile bool closed;

    public bool Closed { get { return closed; } }
    public ConcurrentQueue<string> Lines { get { return lines; } }

    public void Start()
    {
        Thread thread = new Thread(delegate()
        {
            try
            {
                while (true)
                {
                    string line = Console.In.ReadLine();
                    if (line == null)
                    {
                        closed = true;
                        return;
                    }
                    lines.Enqueue(line);
                }
            }
            catch
            {
                closed = true;
            }
        });
        thread.IsBackground = true;
        thread.Name = "dsh-screencapture-hotkey-stdin";
        thread.Start();
    }
}
"@

function Write-Response([string]$Text) {
  [Console]::Out.WriteLine($Text)
  [Console]::Out.Flush()
}

$form = New-Object DshScreenshotHotkeyForm
# Force native window creation without ever showing it.
$handle = $form.Handle
$stdin = New-Object DshScreenshotStdinReader
$stdin.Start()

# MOD_NOREPEAT (0x4000) suppresses auto-repeat while the chord is held; the
# reported modifiers stay exactly what the caller asked for.
$registeredModifiers = $Modifiers -bor 0x4000
$hotkeyId = 1
if (-not [DshScreenshotHotkeyNative]::RegisterHotKey($handle, $hotkeyId, $registeredModifiers, $VirtualKey)) {
  $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
  Write-Response ("error|" + $code)
  exit 1
}

Write-Response ("ready|" + $VirtualKey + "|" + $Modifiers)

:messageLoop while ($true) {
  # Pump the form message loop (includes WM_HOTKEY dispatch to the form WndProc).
  [System.Windows.Forms.Application]::DoEvents()

  $presses = $form.HotkeyCount
  if ($presses -gt 0) {
    $form.HotkeyCount = 0
    for ($index = 0; $index -lt $presses; $index++) {
      Write-Response 'hotkey'
    }
  }

  if ($stdin.Closed) { break messageLoop }

  $line = $null
  while ($stdin.Lines.TryDequeue([ref]$line)) {
    $line = $line.Trim()
    if ($line.Length -eq 0) { continue }
    if ($line -eq 'exit') { break messageLoop }
    if ($line -eq 'ping') {
      Write-Response 'OK|hotkey-ping'
      continue
    }
    Write-Response ("ERR|" + $line + "|unknown command")
  }

  Start-Sleep -Milliseconds 10
}

[int][DshScreenshotHotkeyNative]::UnregisterHotKey($handle, $hotkeyId) | Out-Null
$form.Dispose()
exit 0
