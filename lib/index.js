// dsh-liang-guard — 梁神卫士 Host 插件入口
// 接口设计参照 dsh-balance 的 host/client 双层模式，但 API 不再监听独立端口：
// 全部端点通过 ctx.webServer.register 挂载到 DSH web 端口的同源路径
// /plugins/dsh-liang-guard/api/*（无 CORS、无额外端口、局域网设备可用，
// 且有 Host/Origin 信任围栏；见文末 registerWebRoute）。
// 所有系统操作都通过固定字符串的 PowerShell 命令在服务端执行（Windows 真实干活），
// 客户端只能传白名单参数（扫描模式 / 修复级别），无任何文件路径或自由命令注入面。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PS = 'powershell.exe';
const PS_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];

// ---------------------------------------------------------------------------
// 历史持久化：体检/查杀记录落盘（~/.dsh/liang-guard/history.json，各留最近 20 条）
// ---------------------------------------------------------------------------
const DATA_DIR = path.join(os.homedir(), '.dsh', 'liang-guard');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const HISTORY_MAX = 20;

// 可配置项（设置卡片读写，落盘 config.json；端口例外——随 DSH 进程环境变量生效）
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const CONFIG_DEFAULTS = { historyMax: 20, speedMB: 10, notify: true, pollSec: 2 };
function loadConfig() {
  try { return Object.assign({}, CONFIG_DEFAULTS, JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))); }
  catch { return Object.assign({}, CONFIG_DEFAULTS); }
}
function saveConfigFile(c) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2), 'utf8');
  } catch { /* 配置写失败用默认值继续 */ }
}
/** 白名单式合并：只接受合法范围内的已知键 */
function mergeConfig(patch) {
  const c = loadConfig();
  const clampInt = (v, lo, hi) => Number.isInteger(v) ? Math.min(hi, Math.max(lo, v)) : undefined;
  if (patch.historyMax != null) { const v = clampInt(patch.historyMax, 5, 100); if (v != null) c.historyMax = v; }
  if (patch.speedMB != null) { const v = clampInt(patch.speedMB, 5, 50); if (v != null) c.speedMB = v; }
  if (patch.pollSec != null) { const v = clampInt(patch.pollSec, 1, 10); if (v != null) c.pollSec = v; }
  if (typeof patch.notify === 'boolean') c.notify = patch.notify;
  saveConfigFile(c);
  return c;
}

function loadHistory() {
  try {
    const h = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    return { checks: Array.isArray(h.checks) ? h.checks : [], scans: Array.isArray(h.scans) ? h.scans : [] };
  } catch { return { checks: [], scans: [] }; }
}
function saveHistory(h) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(h), 'utf8');
  } catch { /* 历史写失败不影响主功能 */ }
}
function pushHistory(key, rec) {
  const h = loadHistory();
  const max = loadConfig().historyMax || HISTORY_MAX;
  h[key].unshift(rec);
  if (h[key].length > max) h[key].length = max;
  saveHistory(h);
}

/** 把脚本编码为 -EncodedCommand 参数（Base64 UTF-16LE） */
function encodePs(script) {
  return PS_ARGS.concat(['-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]);
}

/** 运行一段 PowerShell 脚本，超时杀进程；resolve {code, stdout, stderr} */
function runPs(script, timeoutMs = 30000) {
  // 用 -EncodedCommand 传输脚本（Base64 UTF-16LE），彻底规避引号/换行/编码解析问题
  return new Promise((resolve) => {
    const child = spawn(PS, encodePs(script), { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '', err = '', timer = null;
    child.stdout.on('data', (c) => { out += c; if (out.length > 4e6) child.kill(); });
    child.stderr.on('data', (c) => { err += c; if (err.length > 1e5) child.kill(); });
    timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, stdout: '', stderr: String(e && e.message || e) }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code == null ? -1 : code, stdout: out, stderr: err }); });
  });
}

/** 运行 PowerShell 并把 stdout 解析为 JSON；失败时抛出可读错误 */
async function runPsJson(script, timeoutMs) {
  const r = await runPs(script, timeoutMs);
  const text = (r.stdout || '').trim();
  // Get-* cmdlet 在对象为空时输出空字符串，视作 null
  if (!text) return null;
  try { return JSON.parse(text); } catch {
    // 有时 stdout 前后混入了警告行，尝试截取第一个 { 到最后一个 }
    const i = text.indexOf('{'), j = text.lastIndexOf('}');
    if (i >= 0 && j > i) { try { return JSON.parse(text.slice(i, j + 1)); } catch {} }
    throw new Error('powershell output parse failed: ' + text.slice(0, 300) + (r.stderr ? ' | stderr: ' + r.stderr.slice(0, 300) : ''));
  }
}

// ---------------------------------------------------------------------------
// 管理员权限探测（60s 缓存）
// ---------------------------------------------------------------------------
let adminCache = null, adminTs = 0;
async function isAdmin() {
  if (adminCache != null && Date.now() - adminTs < 60000) return adminCache;
  const r = await runPs(
    "([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
    8000);
  adminCache = r.stdout.trim() === 'True';
  adminTs = Date.now();
  return adminCache;
}

// ---------------------------------------------------------------------------
// 各功能对应的固定 PowerShell 脚本
// ---------------------------------------------------------------------------
const PS_METRICS = `
$ErrorActionPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.Encoding]::UTF8
$cpu=(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
$os=Get-CimInstance Win32_OperatingSystem
$memT=[double]$os.TotalVisibleMemorySize
$memF=[double]$os.FreePhysicalMemory
$disks=@(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object {
  $t=[double]$_.Size; $f=[double]$_.FreeSpace
  [pscustomobject]@{ drive=$_.DeviceID; totalGB=[math]::Round($t/1GB,1); freeGB=[math]::Round($f/1GB,1); usedPct=[int](100-100*$f/$t) }
})
$up=((Get-Date)-$os.LastBootUpTime).TotalHours
[pscustomobject]@{ ok=$true; cpu=[int]$cpu;
  memTotalGB=[math]::Round($memT/1MB,1); memFreeGB=[math]::Round($memF/1MB,1);
  memUsedPct=[int](100-100*$memF/$memT); memUsedGB=[math]::Round(($memT-$memF)/1MB,1);
  disks=$disks; uptimeHours=[math]::Round($up,1) } | ConvertTo-Json -Compress
`;

const PS_PROCS = `
$ErrorActionPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.Encoding]::UTF8
Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 12 `
  + `@{n='name';e={$_.ProcessName}}, @{n='pid';e={$_.Id}}, `
  + `@{n='memMB';e={[math]::Round($_.WorkingSet64/1MB,0)}}, @{n='cpu';e={[math]::Round($_.CPU,0)}} `
  + `| ConvertTo-Json -Compress
`;

// 一键体检：Defender / 防火墙 / 磁盘水位 / 内存压力 / 临时文件 / 启动项 / 网络延迟
const PS_CHECK = `
$ErrorActionPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.Encoding]::UTF8
$out=@{}
# Defender
try {
  $mp=Get-MpComputerStatus
  $out.defender=@{ present=$true; realtime=[bool]$mp.RealTimeProtectionEnabled; sigAge=[int]$mp.AntivirusSignatureAge; engine=[string]$mp.AMProductVersion }
} catch { $out.defender=@{ present=$false } }
# 防火墙
$fw=@(Get-NetFirewallProfile | ForEach-Object { [pscustomobject]@{ name=$_.Name; enabled=[bool]$_.Enabled } })
$out.firewall=$fw
# 磁盘 & 内存
$os=Get-CimInstance Win32_OperatingSystem
$memT=[double]$os.TotalVisibleMemorySize; $memF=[double]$os.FreePhysicalMemory
$disks=@(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object {
  $t=[double]$_.Size; $f=[double]$_.FreeSpace
  [pscustomobject]@{ drive=$_.DeviceID; usedPct=[int](100-100*$f/$t) }
})
$out.memUsedPct=[int](100-100*$memF/$memT)
$out.disks=$disks
# 临时文件体积（限 $env:TEMP）
$tmpSum=0
try { $tmpSum=(Get-ChildItem $env:TEMP -Recurse -Force -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum } catch {}
if (-not $tmpSum) { $tmpSum=0 }
$out.tempMB=[math]::Round($tmpSum/1MB,0)
# 启动项数量
$startup=0
try { $startup=@(Get-CimInstance Win32_StartupCommand).Count } catch {}
$out.startupCount=[int]$startup
# 网络延迟（223.5.5.5，2 包）
$lat=$null
try { $lat=(Test-Connection -ComputerName 223.5.5.5 -Count 2 -ErrorAction Stop | Measure-Object -Property ResponseTime -Average).Average } catch {}
$out.dnsLatency=$lat
[pscustomobject]$out | ConvertTo-Json -Compress -Depth 4
`;

// 病毒查杀（异步 job 调用）：mode 只能是 quick(1)/full(2)（服务端白名单）
// 用 Defender 专用 CLI MpCmdRun.exe 驱动真实扫描——Start-MpScan 在非交互/非提权
// 上下文会无限挂起（实测：引擎 0 CPU 干等），MpCmdRun 流式输出。
// 坑：MpCmdRun 被拒时（如已有扫描进行中 hr=0x8050111c）退出码可能返回 2（=“干净”），
// 只看退出码会把"扫描没跑"伪装成"查完无威胁"（实测踩过：全面查杀 2 秒"完成"）。
// 因此必须同时检查输出文本："Failed with hr"/"0x8050" 一律视为错误。
function psScan(mode) {
  const scanType = mode === 'full' ? 2 : 1;
  return `
$ErrorActionPreference='Continue'
[Console]::OutputEncoding=[Text.Encoding]::UTF8
$mp=Join-Path $env:ProgramFiles 'Windows Defender\\MpCmdRun.exe'
if(-not (Test-Path $mp)){ $mp=Join-Path \${env:ProgramFiles(x86)} 'Windows Defender\\MpCmdRun.exe' }
if(-not (Test-Path $mp)){ Write-Output 'SCAN-ERROR: MpCmdRun.exe not found'; Exit 0 }
Write-Output 'SCAN-RUNNING'
$scanOut=(& $mp -Scan -ScanType ${scanType} 2>&1 | Out-String)
$code=$LASTEXITCODE
if($scanOut -match 'Failed with hr' -or $scanOut -match '0x8050' -or ($code -ne 0 -and $code -ne 2)){
  $line=($scanOut.Trim() -replace '\s+',' ')
  Write-Output ('SCAN-ERROR: MpCmdRun(' + $code + ') ' + $line.Substring(0,[math]::Min(200,$line.Length)))
  Exit 0
}
$th=@(Get-MpThreat -ErrorAction SilentlyContinue | Select-Object -First 20 `
    + `@{n='name';e={$_.ThreatName}}, @{n='severity';e={[int]$_.SeverityID}}, @{n='resources';e={@($_.Resources)}})
Write-Output 'SCAN-DONE'
Write-Output ($th | ConvertTo-Json -Compress -Depth 3)
`;
}

// 把 MpCmdRun 的 hr 错误码翻译成人话（UI 直接展示）
function translateScanError(e) {
  const s = String(e || '');
  if (/0x8050111c/i.test(s)) return 'Defender 报告已有另一个扫描在进行中（残留任务或系统计划扫描），本次未启动新扫描。稍后重试；若持续出现，请重启 Windows 安全中心或重启电脑。';
  if (/0x80508023/i.test(s)) return '未发现威胁（Defender 报告干净）。';
  if (/MpCmdRun\((\d+)\)/.test(s)) return 'Defender 扫描失败（退出码 ' + s.match(/MpCmdRun\((\d+)\)/)[1] + '）。' + s.replace(/^SCAN-ERROR:\s*/, '');
  return s;
}

const PS_THREATS = `
$ErrorActionPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.Encoding]::UTF8
$t=@(Get-MpThreat | Select-Object -First 30 @{n='name';e={$_.ThreatName}}, @{n='severity';e={[int]$_.SeverityID}}, @{n='resources';e={@($_.Resources)}})
if ($t.Count -eq 0) { '[]' } else { $t | ConvertTo-Json -Compress -Depth 3 }
`;

const PS_THREATS_REMOVE = `
$ErrorActionPreference='Continue'
[Console]::OutputEncoding=[Text.Encoding]::UTF8
try { Remove-MpThreat -ErrorAction Stop; 'ok' } catch { ('fail: ' + $_.Exception.Message) }
`;

// 网络延迟
const PS_LATENCY = `
$ErrorActionPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.Encoding]::UTF8
$targets=@('223.5.5.5','1.1.1.1','www.baidu.com')
$r=@()
foreach($t in $targets){
  $m=$null
  try { $m=(Test-Connection -ComputerName $t -Count 3 -ErrorAction Stop | Measure-Object -Property ResponseTime -Average).Average } catch {}
  $r+=[pscustomobject]@{ host=$t; avgMs=if($m -ne $null){[math]::Round($m,0)}else{$null} }
}
$r | ConvertTo-Json -Compress
`;

// 带宽测速：真实下载固定字节（大小来自设置卡片；PS5.1 关掉进度条渲染，否则速度被严重拖慢）
function psSpeed(primaryBytes, fallbackBytes) {
  return `
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12
function Test-One($bytes){
  $sw=[Diagnostics.Stopwatch]::StartNew()
  $r=Invoke-WebRequest -Uri ('https://speed.cloudflare.com/__down?bytes=' + $bytes) -UseBasicParsing -TimeoutSec 40
  $sw.Stop()
  $len=0
  if($r.Content -is [byte[]]){ $len=$r.Content.Length } else { $len=$r.RawContentLength }
  [math]::Round($len*8/1KB/$sw.ElapsedMilliseconds,2)
}
$mbps=$null
try { $mbps=Test-One ${primaryBytes} } catch { try { $mbps=Test-One ${fallbackBytes} } catch { throw } }
[pscustomobject]@{ mbps=$mbps } | ConvertTo-Json -Compress
`;
}

// 网络修复：level=dns 仅清缓存（无需管理员）；level=full 追加 winsock / ip 重置（需管理员）
function psRepair(level) {
  const dns = `Clear-DnsClientCache -ErrorAction Continue; ipconfig /flushdns`;
  if (level === 'dns') return `
$ErrorActionPreference='Continue'
${dns}
'DNS cache flushed'
`;
  return `
$ErrorActionPreference='Continue'
${dns}
$admin=([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if(-not $admin){ Write-Output 'NEED-ADMIN'; Exit 0 }
netsh winsock reset
netsh int ip reset
'FULL-REPAIR-DONE (restart required)'
`;
}

// 一键释放内存：收缩大进程工作集（对他人进程需管理员；失败计数如实上报）
const PS_MEMFREE = `
$ErrorActionPreference='Continue'
[Console]::OutputEncoding=[Text.Encoding]::UTF8
$before=(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory
Add-Type -Namespace LgWin -Name Psapi -MemberDefinition '[DllImport("psapi.dll")] public static extern int EmptyWorkingSet(IntPtr h);'
Add-Type -Namespace LgWin -Name Kern -MemberDefinition '[DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint access, bool inherit, int pid); [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);'
$targets=Get-Process | Where-Object { $_.WorkingSet64 -gt 100MB } | Sort-Object WorkingSet64 -Descending | Select-Object -First 30
$ok=0; $fail=0
foreach($p in $targets){
  $h=[LgWin.Kern]::OpenProcess(0x0200 -bor 0x0400, $false, $p.Id)
  if($h -ne [IntPtr]::Zero){
    if([LgWin.Psapi]::EmptyWorkingSet($h) -ne 0){ $ok++ } else { $fail++ }
    [void][LgWin.Kern]::CloseHandle($h)
  } else { $fail++ }
}
Start-Sleep -Seconds 2
$after=(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory
[pscustomobject]@{ trimmed=$ok; skipped=$fail; freedMB=[math]::Round(($after-$before)/1024,0); freeNowMB=[math]::Round($after/1024,0) } | ConvertTo-Json -Compress
`;

// ---------------------------------------------------------------------------
// 磁盘空间分析 job（单次递归遍历：一级目录体积 + TOP 大文件，异步）
// ---------------------------------------------------------------------------
// drive 由服务端白名单校验（单字母），PS 内拼为 X:\ 根，无注入面
function psDiskAnalyze(drive) {
  return `
$ErrorActionPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.Encoding]::UTF8
$root='${drive}:\'
Write-Output 'DISK-RUNNING'
$dirs=@{}
$files=New-Object System.Collections.Generic.List[object]
Get-ChildItem -LiteralPath $root -Recurse -File -Force -ErrorAction SilentlyContinue | ForEach-Object {
  $rel=$_.FullName.Substring(3)
  $top=($rel -split '[\\\\/]')[0]
  if(-not $top){ $top='(根目录)' }
  if($dirs.ContainsKey($top)){ $dirs[$top]+=$_.Length } else { $dirs[$top]=[double]$_.Length }
  if($_.Length -gt 200MB){ $files.Add([pscustomobject]@{ path=$_.FullName; sizeMB=[math]::Round($_.Length/1MB,0) }) }
}
$topDirs=$dirs.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 15 | ForEach-Object {
  [pscustomobject]@{ name=$_.Key; sizeGB=[math]::Round($_.Value/1GB,2) }
}
$topFiles=$files | Sort-Object sizeMB -Descending | Select-Object -First 15
Write-Output 'DISK-DONE'
[pscustomobject]@{ drive='${drive}'; dirs=$topDirs; files=$topFiles } | ConvertTo-Json -Compress -Depth 3
`;
}

let diskJob = null; // { id, drive, startedAt, child, running, error, result, finishedAt }

function startDiskAnalyze(drive) {
  if (diskJob && diskJob.running) return { ok: false, error: '已有磁盘分析在进行中' };
  const child = spawn(PS, encodePs(psDiskAnalyze(drive)), { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  diskJob = {
    id: 'disk-' + Date.now(), drive, startedAt: Date.now(),
    child, running: true, error: null, result: null, finishedAt: null,
  };
  let buf = '';
  child.stdout.on('data', (c) => {
    buf += c;
    if (/DISK-ERROR: /.test(buf)) diskJob.error = buf.match(/DISK-ERROR: (.*)/)[1].trim();
  });
  child.on('close', () => {
    diskJob.running = false;
    diskJob.finishedAt = Date.now();
    const m = buf.lastIndexOf('DISK-DONE');
    if (m >= 0) {
      const tail = buf.slice(m + 'DISK-DONE'.length).trim();
      try { diskJob.result = JSON.parse(tail); } catch { diskJob.result = null; }
    } else if (!diskJob.error) {
      diskJob.error = '分析进程异常退出';
    }
  });
  return { ok: true, jobId: diskJob.id, drive };
}

function diskStatus() {
  if (!diskJob) return { everRan: false };
  return {
    everRan: true,
    id: diskJob.id, drive: diskJob.drive,
    running: diskJob.running,
    startedAt: diskJob.startedAt,
    elapsedMs: (diskJob.running ? Date.now() : diskJob.finishedAt) - diskJob.startedAt,
    error: diskJob.error,
    result: diskJob.result,
  };
}

// ---------------------------------------------------------------------------
// 扫描 job 管理（唯一的长任务；全面查杀可达数小时）
// ---------------------------------------------------------------------------
let scanJob = null; // { id, mode, startedAt, child, running, error, threats, finishedAt, cancelled }

// 取消后的引擎活动验证：采样 MsMpEng（Defender 引擎）与 MpCmdRun 的 CPU 时间
// 两次。Defender 没有公开的 Stop-MpScan，"取消"是否真正生效只能实测——
// 注意 MpCmdRun 在扫描正常完成后仍会驻留片刻，因此判定看 CPU 增量而非进程存在。
const PS_VERIFY_SCAN_STOPPED = `
$ErrorActionPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.Encoding]::UTF8
Start-Sleep -Milliseconds 800
function ProcCpu($name){
  $p=Get-Process -Name $name -ErrorAction SilentlyContinue
  if($p){ ($p | Measure-Object CPU -Sum).Sum } else { 0 }
}
$e1=ProcCpu 'MsMpEng'
$m1=ProcCpu 'MpCmdRun'
Start-Sleep -Seconds 2
$e2=ProcCpu 'MsMpEng'
$m2=ProcCpu 'MpCmdRun'
$ed=[math]::Round($e2-$e1,2)
$md=[math]::Round($m2-$m1,2)
$mp=@(Get-Process -Name 'MpCmdRun' -ErrorAction SilentlyContinue).Count
[pscustomobject]@{ engineCpuDelta=$ed; mpCmdRunCpuDelta=$md; mpCmdRunAlive=$mp; stopped=($ed -lt 0.2 -and $md -lt 0.1) } | ConvertTo-Json -Compress
`;

function startScan(mode) {
  if (scanJob && scanJob.running) return { ok: false, error: '已有查杀任务在进行中' };
  const child = spawn(PS, encodePs(psScan(mode)), { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  scanJob = {
    id: 'scan-' + Date.now(), mode, startedAt: Date.now(),
    child, running: true, error: null, threats: null, finishedAt: null,
  };
  let buf = '';
  child.stdout.on('data', (c) => {
    buf += c;
    if (/SCAN-ERROR: /.test(buf)) scanJob.error = translateScanError(buf.match(/SCAN-ERROR: (.*)/)[1].trim());
  });
  // stderr 完全忽略：PS5.1 会把 Defender 扫描的进度/状态流（CLIXML 本地化文本）
  // 以任意分块写到 stderr，无法可靠区分"真错误"，混进来就是 UI 乱码。
  // 真正的失败通过 stdout 的 SCAN-ERROR 标记或缺少 SCAN-DONE 判定。
  child.on('close', () => {
    scanJob.running = false;
    scanJob.finishedAt = Date.now();
    // 用户取消：close 只是 taskkill /T 的回声，收尾与历史由 /scan/cancel 端点
    // 在完成"引擎是否真停"验证后统一写入
    if (scanJob.cancelled) return;
    const m = buf.lastIndexOf('SCAN-DONE');
    if (m >= 0) {
      const tail = buf.slice(m + 'SCAN-DONE'.length).trim();
      try { scanJob.threats = JSON.parse(tail || '[]'); } catch { scanJob.threats = []; }
    } else if (!scanJob.error) {
      scanJob.error = '扫描进程异常退出';
    }
    pushHistory('scans', {
      at: scanJob.startedAt, mode: scanJob.mode,
      durationMs: scanJob.finishedAt - scanJob.startedAt,
      threatCount: scanJob.threats ? scanJob.threats.length : null,
      error: scanJob.error,
    });
  });
  return { ok: true, jobId: scanJob.id, mode };
}

function scanStatus() {
  if (!scanJob) return { active: false, everRan: false };
  return {
    active: false, everRan: true,
    id: scanJob.id, mode: scanJob.mode,
    running: scanJob.running,
    startedAt: scanJob.startedAt,
    finishedAt: scanJob.finishedAt,
    elapsedMs: (scanJob.running ? Date.now() : scanJob.finishedAt) - scanJob.startedAt,
    error: scanJob.error,
    threats: scanJob.threats,
  };
}

// ---------------------------------------------------------------------------
// 体检评分（Node 侧汇总，权重合计 100）
// ---------------------------------------------------------------------------
function scoreCheck(c) {
  const items = [];
  const push = (key, label, weight, status, detail) => items.push({ key, label, weight, status, detail });
  const d = c.defender || {};
  if (d.present === false) push('defender', '病毒防护 (Defender)', 30, 'warn', '未检测到 Windows Defender（或状态不可读取）');
  else if (d.realtime) push('defender', '病毒防护 (Defender)', 30, 'ok', '实时保护已开启 · 引擎 ' + (d.engine || '?'));
  else push('defender', '病毒防护 (Defender)', 30, 'bad', '实时保护已关闭，建议立即开启');
  if (d.present && typeof d.sigAge === 'number') {
    if (d.sigAge > 14) push('sig', '病毒库更新', 10, 'warn', '病毒库已 ' + d.sigAge + ' 天未更新');
    else push('sig', '病毒库更新', 10, 'ok', '病毒库 ' + d.sigAge + ' 天前更新');
  }
  const fwOff = (c.firewall || []).filter((p) => p && p.enabled === false);
  if (!c.firewall || !c.firewall.length) push('firewall', '防火墙', 15, 'warn', '防火墙状态不可读取');
  else if (fwOff.length === 0) push('firewall', '防火墙', 15, 'ok', '所有配置文件均已启用');
  else push('firewall', '防火墙', 15, 'bad', '配置文件 ' + fwOff.map((p) => p.name).join(', ') + ' 已关闭');
  const hotDisk = (c.disks || []).filter((dsk) => dsk.usedPct >= 90);
  if (hotDisk.length) push('disk', '磁盘水位', 15, 'warn', hotDisk.map((dsk) => dsk.drive + ' 已用 ' + dsk.usedPct + '%').join('；'));
  else push('disk', '磁盘水位', 15, 'ok', (c.disks || []).map((dsk) => dsk.drive + ' ' + dsk.usedPct + '%').join(' · ') || '无本地盘');
  if (c.memUsedPct >= 90) push('mem', '内存压力', 10, 'warn', '内存已用 ' + c.memUsedPct + '%');
  else push('mem', '内存压力', 10, 'ok', '内存已用 ' + c.memUsedPct + '%');
  if (c.tempMB > 5120) push('temp', '临时文件', 10, 'warn', '临时目录 ' + c.tempMB + ' MB，建议清理');
  else push('temp', '临时文件', 10, 'ok', '临时目录 ' + c.tempMB + ' MB');
  if (c.startupCount > 40) push('startup', '启动项', 5, 'warn', c.startupCount + ' 个启动项，偏多');
  else push('startup', '启动项', 5, 'ok', c.startupCount + ' 个启动项');
  if (c.dnsLatency == null) push('net', '网络延迟', 5, 'warn', 'ping 223.5.5.5 失败');
  else if (c.dnsLatency > 80) push('net', '网络延迟', 5, 'warn', '平均 ' + c.dnsLatency + ' ms');
  else push('net', '网络延迟', 5, 'ok', '平均 ' + c.dnsLatency + ' ms');
  let score = 0;
  for (const it of items) score += it.weight * (it.status === 'ok' ? 1 : it.status === 'warn' ? 0.5 : 0);
  return { score: Math.round(score), items };
}

// ---------------------------------------------------------------------------
// HTTP 处理：白名单路由；JSON body ≤ 4KB（同源挂载，无 CORS 头需求）
// ---------------------------------------------------------------------------
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 4096) { req.destroy(); resolve({}); } });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

async function route(req, res, url) {
  const path = url.pathname;
  if (path === '/ping') {
    return json(res, 200, { ok: true, service: 'liang-guard', version: '1.1.1', admin: await isAdmin() });
  }
  if (path === '/config') {
    if (req.method === 'POST') {
      const body = await readBody(req);
      return json(res, 200, { ok: true, config: mergeConfig(body || {}) });
    }
    return json(res, 200, { ok: true, config: loadConfig() });
  }
  if (path === '/metrics') {
    const m = await runPsJson(PS_METRICS, 20000);
    if (!m || m.cpu == null && m.memTotalGB == null) return json(res, 200, { ok: false, error: '指标读取失败' });
    return json(res, 200, { ok: true, metrics: m });
  }
  if (path === '/procs') {
    let p = await runPsJson(PS_PROCS, 15000);
    if (p && !Array.isArray(p)) p = [p];
    return json(res, 200, { ok: true, procs: p || [] });
  }
  if (path === '/check' && req.method === 'POST') {
    const c = await runPsJson(PS_CHECK, 90000);
    if (!c || c.defender == null && c.memUsedPct == null) return json(res, 200, { ok: false, error: '体检数据读取失败（权限或 WMI 异常）' });
    const s = scoreCheck(c);
    pushHistory('checks', { at: Date.now(), score: s.score, items: s.items.map((it) => ({ k: it.key, s: it.status })) });
    return json(res, 200, { ok: true, at: Date.now(), raw: c, score: s.score, items: s.items });
  }
  if (path === '/scan/start' && req.method === 'POST') {
    const body = await readBody(req);
    const mode = body.mode === 'full' ? 'full' : 'quick';
    const mp = await runPs('$ErrorActionPreference="Stop"; try{ (Get-MpComputerStatus -ErrorAction Stop) | Select-Object -ExpandProperty AMProductVersion }catch{ "MISSING" }', 15000);
    const ver = (mp.stdout || '').trim();
    if (!ver || ver === 'MISSING') return json(res, 200, { ok: false, error: '未检测到 Windows Defender，无法查杀' });
    return json(res, 200, startScan(mode));
  }
  if (path === '/scan/status') return json(res, 200, Object.assign({ ok: true }, scanStatus()));
  if (path === '/scan/cancel' && req.method === 'POST') {
    if (!scanJob || !scanJob.running) return json(res, 200, { ok: false, error: '没有进行中的查杀任务' });
    scanJob.cancelled = true;
    // 杀整棵进程树：powershell → MpCmdRun → MpCmdRun 工作进程。
    // child.kill() 只杀直接子进程（powershell），MpCmdRun 会变成孤儿继续扫描——
    // 这是"取消后扫描仍在跑"的真正原因。taskkill /T /F 连孙进程一起收。
    try {
      spawn('taskkill', ['/PID', String(scanJob.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } catch { /* 进程可能已退出 */ }
    scanJob.running = false;
    scanJob.finishedAt = Date.now();
    // 实测验证引擎是否真的停下（采样 MsMpEng CPU + 检查 MpCmdRun 存活），约 3 秒
    const verify = await runPsJson(PS_VERIFY_SCAN_STOPPED, 15000).catch(() => null);
    const stopped = !!(verify && verify.stopped);
    scanJob.error = stopped
      ? '已取消（已验证：Defender 引擎停止扫描活动）'
      : '已取消等待，但 Defender 服务级扫描仍在后台执行（无公开 API 可外部终止）；完成后威胁记录会出现在"威胁记录"卡片';
    pushHistory('scans', {
      at: scanJob.startedAt, mode: scanJob.mode,
      durationMs: scanJob.finishedAt - scanJob.startedAt,
      threatCount: null,
      error: stopped ? '已取消（引擎已停止）' : '已取消（服务端继续）',
    });
    return json(res, 200, { ok: true, stopped, detail: scanJob.error });
  }
  if (path === '/threats' && req.method === 'GET') {
    const t = await runPsJson(PS_THREATS, 15000);
    return json(res, 200, { ok: true, threats: t || [] });
  }
  if (path === '/threats/remove' && req.method === 'POST') {
    const r = await runPs(PS_THREATS_REMOVE, 60000);
    const ok = (r.stdout || '').includes('ok');
    return json(res, 200, { ok, detail: (r.stdout || r.stderr || '').trim().slice(0, 300) });
  }
  if (path === '/mem/free' && req.method === 'POST') {
    const admin = await isAdmin();
    const r = await runPsJson(PS_MEMFREE, 90000);
    if (!r || r.trimmed == null) return json(res, 200, { ok: false, error: '内存释放执行失败' });
    return json(res, 200, { ok: true, admin, result: r });
  }
  if (path === '/history') {
    return json(res, 200, Object.assign({ ok: true }, loadHistory()));
  }
  if (path === '/disk/start' && req.method === 'POST') {
    const body = await readBody(req);
    const drive = String(body.drive || '').trim();
    if (!/^[A-Za-z]$/.test(drive)) return json(res, 200, { ok: false, error: '非法盘符' });
    return json(res, 200, startDiskAnalyze(drive.toUpperCase()));
  }
  if (path === '/disk/status') return json(res, 200, Object.assign({ ok: true }, diskStatus()));
  if (path === '/disk/cancel' && req.method === 'POST') {
    if (!diskJob || !diskJob.running) return json(res, 200, { ok: false, error: '没有进行中的分析' });
    try { diskJob.child.kill('SIGKILL'); } catch {}
    diskJob.running = false; diskJob.finishedAt = Date.now(); diskJob.error = '已取消';
    return json(res, 200, { ok: true });
  }
  if (path === '/net/latency' && req.method === 'POST') {
    let l = await runPsJson(PS_LATENCY, 30000);
    if (l && !Array.isArray(l)) l = [l];
    return json(res, 200, { ok: true, targets: l || [] });
  }
  if (path === '/net/speed' && req.method === 'POST') {
    const cfg = loadConfig();
    const primary = (cfg.speedMB || 10) * 1000000;
    const fallback = Math.max(2, Math.round((cfg.speedMB || 10) / 5)) * 1000000;
    const s = await runPsJson(psSpeed(primary, fallback), 100000).catch(() => null);
    if (!s) return json(res, 200, { ok: false, error: '带宽测试失败（网络不通或被防火墙拦截）' });
    return json(res, 200, { ok: true, mbps: s.mbps });
  }
  if (path === '/net/repair' && req.method === 'POST') {
    const body = await readBody(req);
    const level = body.level === 'full' ? 'full' : 'dns';
    const r = await runPs(psRepair(level), level === 'full' ? 120000 : 30000);
    return json(res, 200, { ok: true, level, output: (r.stdout || r.stderr || '').trim().slice(0, 500) });
  }
  return json(res, 404, { ok: false, error: 'not found' });
}

// ---------------------------------------------------------------------------
// 挂载到 DSH webserver（同源 3080）：/plugins/dsh-liang-guard/api/*
// 收益：无 CORS、无额外端口、局域网设备访问 DSH 时相对路径自动可用。
// 3091 回环服务保留作兜底（老版 DSH 无 webServer 服务 / 独立测试时）。
// 信任围栏参照 dsh-better-sidebar 的 trust-fence：Host 必须是回环或可信域，
// Origin 必须同源，拒绝 sec-fetch-site: cross-site（防 DNS rebinding / CSRF）。
// ---------------------------------------------------------------------------
const API_PREFIX = '/plugins/dsh-liang-guard/api';

function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true;
  const parts = hostname.split('.');
  return parts.length === 4 && parts[0] === '127'
    && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

/** 浏览器信任围栏：请求是否允许触达卫士 API（非认证，是跨站防御） */
function isTrustedRequest(headers, trustedHosts) {
  const host = typeof headers.host === 'string' ? headers.host : undefined;
  if (host === undefined) return false;
  let hostUrl;
  try { hostUrl = new URL('http://' + host); } catch { return false; }
  const loopback = isLoopbackHostname(hostUrl.hostname);
  const trusted = !loopback && (trustedHosts || []).some((entry) => {
    try {
      const e = new URL('http://' + entry);
      return e.hostname === hostUrl.hostname && (e.port === '' || e.port === hostUrl.port);
    } catch { return false; }
  });
  if (!loopback && !trusted) return false;
  if (headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = typeof headers.origin === 'string' ? headers.origin : undefined;
  if (origin === undefined) return true;
  try { return new URL(origin).host === hostUrl.host; } catch { return false; }
}

/** 在 DSH webserver 上注册卫士 API 前缀路由；返回 disposer（不可用时返回 null） */
function registerWebRoute(ctx) {
  if (!ctx || !ctx.webServer || typeof ctx.webServer.register !== 'function') return null;
  const trustedHostsOf = () => {
    try { return (ctx.webRuntime && ctx.webRuntime.trustedHosts) || []; } catch { return []; }
  };
  return ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: (req, res) => {
      if (!isTrustedRequest(req.headers, trustedHostsOf())) {
        res.writeHead(403); res.end('forbidden'); return;
      }
      let u;
      try { u = new URL(req.url, 'http://127.0.0.1'); } catch { res.writeHead(400); res.end(); return; }
      // 剥掉前缀，剩余路径交给统一 route()（/ping、/metrics…）
      const sub = u.pathname.slice(API_PREFIX.length).replace(/^\/+/, '');
      const subUrl = new URL('/' + sub + u.search, 'http://127.0.0.1');
      route(req, res, subUrl).catch((e) => json(res, 500, { ok: false, error: String((e && e.message) || e) }));
    },
  });
}

/** Host 插件激活体：在 DSH webserver 上挂载同源 API 路由（参照 dsh-balance 的 apply(ctx) 约定） */
function apply(ctx) {
  let disposeWebRoute = null;
  try {
    disposeWebRoute = registerWebRoute(ctx);
    if (disposeWebRoute) console.log('[dsh-liang-guard] 梁神卫士 API 已挂载 ' + API_PREFIX + '/*');
    else console.warn('[dsh-liang-guard] 当前环境无 webServer 服务，卫士 API 不可用（需 DSH web profile）');
  } catch (e) {
    console.error('[dsh-liang-guard] webserver 路由注册失败: ' + e.message);
  }
  ctx.on('dispose', () => {
    try { if (disposeWebRoute) disposeWebRoute(); } catch {}
  });
}

export { apply };
/** 宿主侧依赖的 cordis 服务：webServer 提供同源路由，webRuntime 提供可信域清单 */
export const inject = ['webServer', 'webRuntime'];
