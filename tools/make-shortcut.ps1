# Ярлык «Космолёт.lnk» (владелец: tools-pack).
# По умолчанию кладёт ярлык на рабочий стол текущего пользователя:
#   powershell -ExecutionPolicy Bypass -File tools\make-shortcut.ps1
# Параметры: -OutDir <папка> (куда положить ярлык), -Name <имя без .lnk>.
# Ярлык запускает node_modules\electron\dist\electron.exe с папкой проекта, рабочая папка — проект,
# иконка — assets\icon.ico. Дополнительно ярлыку ставится AppUserModelID «Kosmolet» (как в main.js),
# чтобы Windows группировала окно Космолёта с этим ярлыком на панели задач.
param(
  [string]$OutDir = '',
  [string]$Name = 'Космолёт'
)
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
$icon = Join-Path $root 'assets\icon.ico'
if (-not (Test-Path $electron)) { Write-Error "Не найден $electron — сначала установите зависимости (npm install)."; exit 1 }
if (-not (Test-Path $icon)) { Write-Warning "Нет $icon — ярлык будет со значком Electron. Иконку собирает tools\make-icon.js." }

if (-not $OutDir) { $OutDir = [Environment]::GetFolderPath('Desktop') }
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Force $OutDir | Out-Null }
$lnk = Join-Path $OutDir ($Name + '.lnk')

$shell = New-Object -ComObject WScript.Shell
$sc = $shell.CreateShortcut($lnk)
$sc.TargetPath = $electron
$sc.Arguments = '"' + $root + '"'
$sc.WorkingDirectory = $root
if (Test-Path $icon) { $sc.IconLocation = $icon + ',0' }
$sc.Description = 'Космолёт — браузер IT-специалиста'
$sc.WindowStyle = 1
$sc.Save()

# AppUserModelID ярлыка (System.AppUserModel.ID) — необязательно: при ошибке ярлык всё равно рабочий.
$appIdSet = $false
try {
  if (-not ('KosmoLnk' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
public static class KosmoLnk {
  [ComImport, Guid("00021401-0000-0000-C000-000000000046")] class CShellLink {}
  [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
  interface IPropertyStore {
    void GetCount(out uint count);
    void GetAt(uint index, out PropertyKey key);
    void GetValue(ref PropertyKey key, out PropVariant value);
    void SetValue(ref PropertyKey key, ref PropVariant value);
    void Commit();
  }
  [StructLayout(LayoutKind.Sequential, Pack = 4)] public struct PropertyKey { public Guid fmtid; public uint pid; }
  [StructLayout(LayoutKind.Explicit)] public struct PropVariant { [FieldOffset(0)] public ushort vt; [FieldOffset(8)] public IntPtr p; [FieldOffset(12)] public int pad; }
  public static void SetAppId(string lnk, string appId) {
    object link = new CShellLink();
    ((IPersistFile)link).Load(lnk, 2);
    IPropertyStore store = (IPropertyStore)link;
    PropertyKey key = new PropertyKey { fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), pid = 5 };
    PropVariant pv = new PropVariant { vt = 31, p = Marshal.StringToCoTaskMemUni(appId) };
    try {
      store.SetValue(ref key, ref pv);
      store.Commit();
      ((IPersistFile)link).Save(lnk, true);
    } finally {
      Marshal.FreeCoTaskMem(pv.p);
      Marshal.ReleaseComObject(link);
    }
  }
}
'@
  }
  [KosmoLnk]::SetAppId($lnk, 'Kosmolet')
  $appIdSet = $true
} catch {
  Write-Warning ("AppUserModelID не записан: " + $_.Exception.Message)
}

Write-Output ("Ярлык создан: " + $lnk)
if ($appIdSet) { Write-Output 'AppUserModelID: Kosmolet' }
