import fs from 'node:fs/promises';
import path from 'node:path';

const PACKAGE_ROOT = 'image2-studio-generate';
const SERVER_URL_TOKEN = "'IMAGE2_STUDIO_PACKAGE_URL'";
const GITHUB_ARCHIVE_URL = 'https://github.com/weibinliao/image2-studio/archive/refs/heads/main.zip';
const GITHUB_ARCHIVE_ROOT = 'image2-studio-main';
const PACKAGE_FILES = [
  'SKILL.md',
  'agents/openai.yaml',
  'scripts/generate-image.mjs',
];

export async function buildSkillPackage({ skillDir, serverUrl, allowInsecureLan = false }) {
  const baseUrl = normalizeServerUrl(serverUrl);
  assertRemoteInstallIsSafe(baseUrl, { allowInsecureLan });
  const files = await buildSkillFiles({ skillDir, serverUrl: baseUrl });
  return createStoredZip(files);
}

export async function buildSkillManifest({ skillDir, serverUrl, allowInsecureLan = false }) {
  const baseUrl = normalizeServerUrl(serverUrl);
  assertRemoteInstallIsSafe(baseUrl, { allowInsecureLan });
  const files = await buildSkillFiles({ skillDir, serverUrl: baseUrl });
  return {
    name: PACKAGE_ROOT,
    version: 1,
    files: files.map((file) => ({
      path: String(file.name).slice(`${PACKAGE_ROOT}/`.length),
      encoding: 'utf8',
      content: Buffer.from(file.content).toString('utf8'),
    })),
  };
}

async function buildSkillFiles({ skillDir, serverUrl }) {
  return Promise.all(PACKAGE_FILES.map(async (relativePath) => {
    const sourcePath = path.join(skillDir, ...relativePath.split('/'));
    let content = await fs.readFile(sourcePath);
    if (relativePath === 'scripts/generate-image.mjs') {
      const source = content.toString('utf8');
      if (!source.includes(SERVER_URL_TOKEN)) {
        throw new Error('Skill package URL placeholder is missing');
      }
      content = Buffer.from(source.replace(SERVER_URL_TOKEN, JSON.stringify(normalizeServerUrl(serverUrl))), 'utf8');
    }
    return {
      name: `${PACKAGE_ROOT}/${relativePath}`,
      content,
    };
  }));
}

export function buildSkillInstallCommand({ serverUrl, allowInsecureLan = false }) {
  const baseUrl = normalizeServerUrl(serverUrl);
  assertRemoteInstallIsSafe(baseUrl, { allowInsecureLan });
  const scriptUrl = `${baseUrl}/api/codex-skill/install.ps1`;
  return `powershell -NoProfile -Command '$scriptPath = Join-Path $env:TEMP ''install-image2-studio-skill.ps1''; Invoke-WebRequest -UseBasicParsing ''${escapePowerShellSingleQuoted(scriptUrl)}'' -OutFile $scriptPath; Write-Host "Downloaded: $scriptPath"; Write-Host (''Run: powershell -NoProfile -ExecutionPolicy Bypass -File '' + [char]34 + $scriptPath + [char]34)'`;
}

export const buildSkillInstallPrompt = buildSkillInstallCommand;

export function buildSkillInstallScript({ serverUrl, allowInsecureLan = false }) {
  const baseUrl = normalizeServerUrl(serverUrl);
  assertRemoteInstallIsSafe(baseUrl, { allowInsecureLan });
  const manifestUrl = `${baseUrl}/api/codex-skill/manifest`;
  const archiveUrl = `${baseUrl}/api/codex-skill`;

  return [
    "$ErrorActionPreference = 'Stop'",
    "$skillName = 'image2-studio-generate'",
    `$manifestUrl = '${escapePowerShellSingleQuoted(manifestUrl)}'`,
    `$archiveUrl = '${escapePowerShellSingleQuoted(archiveUrl)}'`,
    `$githubArchiveUrl = '${escapePowerShellSingleQuoted(GITHUB_ARCHIVE_URL)}'`,
    `$githubArchiveRoot = '${GITHUB_ARCHIVE_ROOT}'`,
    `$packageUrl = '${escapePowerShellSingleQuoted(baseUrl)}'`,
    "$installHome = if ($env:IMAGE2_SKILL_HOME) { $env:IMAGE2_SKILL_HOME } else { $HOME }",
    "$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ('image2-skill-' + [guid]::NewGuid().ToString('N'))",
    "$zipPath = Join-Path $tempRoot 'skill.zip'",
    "$extractPath = Join-Path $tempRoot 'extract'",
    'try {',
    '  $sourceDir = Join-Path $tempRoot $skillName',
    '  New-Item -ItemType Directory -Path $sourceDir -Force | Out-Null',
    '  try {',
    '    $manifest = Invoke-RestMethod -UseBasicParsing -Uri $manifestUrl',
    "    if ($manifest.name -ne $skillName -or [int]$manifest.version -ne 1 -or -not $manifest.files) { throw 'Invalid Image2 Studio Skill manifest.' }",
    '    foreach ($file in @($manifest.files)) {',
    "      $relativePath = ([string]$file.path).Replace('\\', '/')",
    "      if (-not $relativePath -or [IO.Path]::IsPathRooted($relativePath) -or $relativePath -match '(^|/)\\.\\.(?:/|$)') { throw 'Invalid Skill file path.' }",
    '      $targetPath = Join-Path $sourceDir $relativePath',
    '      New-Item -ItemType Directory -Path (Split-Path -Parent $targetPath) -Force | Out-Null',
    '      [IO.File]::WriteAllText($targetPath, [string]$file.content, (New-Object Text.UTF8Encoding($false)))',
    '    }',
    "    if (-not (Test-Path -LiteralPath (Join-Path $sourceDir 'SKILL.md')) -or -not (Test-Path -LiteralPath (Join-Path $sourceDir 'scripts/generate-image.mjs'))) { throw 'Invalid Image2 Studio Skill manifest.' }",
    '  } catch {',
    '    Remove-Item -LiteralPath $sourceDir -Recurse -Force -ErrorAction SilentlyContinue',
    '    try {',
    '      New-Item -ItemType Directory -Path $extractPath -Force | Out-Null',
    '      Invoke-WebRequest -UseBasicParsing -Uri $archiveUrl -OutFile $zipPath',
    '      try {',
    '        Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction Stop',
    '        [IO.Compression.ZipFile]::ExtractToDirectory($zipPath, $extractPath)',
    '      } catch {',
    '        if (Get-Command tar.exe -ErrorAction SilentlyContinue) {',
    '          & tar.exe -xf $zipPath -C $extractPath',
    '          if ($LASTEXITCODE -ne 0) { throw }',
    '        } else {',
    '          Expand-Archive -LiteralPath $zipPath -DestinationPath $extractPath -Force',
    '        }',
    '      }',
    '      $sourceDir = Join-Path $extractPath $skillName',
    "      if (-not (Test-Path -LiteralPath (Join-Path $sourceDir 'SKILL.md')) -or -not (Test-Path -LiteralPath (Join-Path $sourceDir 'scripts/generate-image.mjs'))) { throw 'LAN archive is not a valid Image2 Studio Skill.' }",
    '    } catch {',
    '      Remove-Item -LiteralPath $extractPath -Recurse -Force -ErrorAction SilentlyContinue',
    '      Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue',
    '      New-Item -ItemType Directory -Path $extractPath -Force | Out-Null',
    '      Invoke-WebRequest -UseBasicParsing -Uri $githubArchiveUrl -OutFile $zipPath',
    '      try {',
    '        Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction Stop',
    '        [IO.Compression.ZipFile]::ExtractToDirectory($zipPath, $extractPath)',
    '      } catch {',
    '        if (Get-Command tar.exe -ErrorAction SilentlyContinue) {',
    '          & tar.exe -xf $zipPath -C $extractPath',
    '          if ($LASTEXITCODE -ne 0) { throw }',
    '        } else {',
    '          Expand-Archive -LiteralPath $zipPath -DestinationPath $extractPath -Force',
    '        }',
    '      }',
    '      $sourceDir = Join-Path (Join-Path $extractPath $githubArchiveRoot) (Join-Path \'codex-skill\' $skillName)',
    '    }',
    '  }',
    "  if (-not (Test-Path -LiteralPath (Join-Path $sourceDir 'SKILL.md')) -or -not (Test-Path -LiteralPath (Join-Path $sourceDir 'scripts/generate-image.mjs'))) { throw 'Downloaded source is not a valid Image2 Studio Skill.' }",
    "  $generatorPath = Join-Path $sourceDir 'scripts/generate-image.mjs'",
    '  $generator = [IO.File]::ReadAllText($generatorPath)',
    "  $generator = $generator.Replace(\"'IMAGE2_STUDIO_PACKAGE_URL'\", (\"'\" + $packageUrl + \"'\"))",
    "  if ($generator.Contains(\"'IMAGE2_STUDIO_PACKAGE_URL'\")) { throw 'Downloaded Skill generator is missing a usable server URL.' }",
    '  [IO.File]::WriteAllText($generatorPath, $generator, (New-Object Text.UTF8Encoding($false)))',
    '  $targetRoots = @(',
    "    (Join-Path (Join-Path $installHome '.agents') 'skills')",
    "    (Join-Path (Join-Path $installHome '.codex') 'skills')",
    '  ) | Select-Object -Unique',
    '  foreach ($targetRoot in $targetRoots) {',
    '    New-Item -ItemType Directory -Path $targetRoot -Force | Out-Null',
    '    $targetDir = Join-Path $targetRoot $skillName',
    "    $stagingDir = \"$targetDir.next-$([guid]::NewGuid().ToString('N'))\"",
    "    $backupDir = \"$targetDir.backup-$([guid]::NewGuid().ToString('N'))\"",
    '    Copy-Item -LiteralPath $sourceDir -Destination $stagingDir -Recurse -Force',
    "    if (-not (Test-Path -LiteralPath (Join-Path $stagingDir 'SKILL.md'))) { throw 'Staged Image2 Studio Skill is invalid.' }",
    '    $movedExisting = $false',
    '    try {',
    '      if (Test-Path -LiteralPath $targetDir) { Move-Item -LiteralPath $targetDir -Destination $backupDir -ErrorAction Stop; $movedExisting = $true }',
    '      Move-Item -LiteralPath $stagingDir -Destination $targetDir -ErrorAction Stop',
    '      if ($movedExisting -and (Test-Path -LiteralPath $backupDir)) { Remove-Item -LiteralPath $backupDir -Recurse -Force }',
    '    } catch {',
    '      if ($movedExisting -and -not (Test-Path -LiteralPath $targetDir) -and (Test-Path -LiteralPath $backupDir)) { Move-Item -LiteralPath $backupDir -Destination $targetDir -ErrorAction SilentlyContinue }',
    '      throw',
    '    } finally {',
    '      if (Test-Path -LiteralPath $stagingDir) { Remove-Item -LiteralPath $stagingDir -Recurse -Force -ErrorAction SilentlyContinue }',
    '    }',
    '    Write-Host "Installed Image2 Studio Skill -> $targetDir"',
    '  }',
    '} finally {',
    '  if (Test-Path -LiteralPath $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue }',
    '}',
    '',
  ].join('\r\n');
}

function normalizeServerUrl(value) {
  const url = new URL(String(value));
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Skill server URL must use http or https');
  return url.href.replace(/\/$/, '');
}

function assertRemoteInstallIsSafe(baseUrl, { allowInsecureLan = false } = {}) {
  const url = new URL(baseUrl);
  const host = url.hostname.toLowerCase();
  const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  if (url.protocol === 'http:' && allowInsecureLan && isPrivateNetworkHost(host)) return;
  if (url.protocol !== 'https:' && !isLoopback) {
    throw new Error('Remote Skill installation requires an HTTPS Image2 Studio URL. Use the local install button on this computer, or configure IMAGE2_PUBLIC_BASE_URL with HTTPS.');
  }
}

function isPrivateNetworkHost(host) {
  if (host === 'localhost' || host === '::1' || host === '[::1]') return true;
  const octets = host.split('.').map((part) => Number(part));
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return octets[0] === 10
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168)
    || (octets[0] === 169 && octets[1] === 254);
}

function escapePowerShellSingleQuoted(value) {
  return String(value).replaceAll("'", "''");
}

function createStoredZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const { date, time } = dosDateTime(new Date());

  for (const file of files) {
    const name = Buffer.from(String(file.name).replace(/\\/g, '/'), 'utf8');
    const content = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content);
    const checksum = crc32(content);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(time, 10);
    localHeader.writeUInt16LE(date, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(content.length, 18);
    localHeader.writeUInt32LE(content.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, name, content);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(time, 12);
    centralHeader.writeUInt16LE(date, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(content.length, 20);
    centralHeader.writeUInt32LE(content.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, name);

    offset += localHeader.length + name.length + content.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, end]);
}

function dosDateTime(value) {
  const year = Math.max(1980, value.getFullYear());
  return {
    date: ((year - 1980) << 9) | ((value.getMonth() + 1) << 5) | value.getDate(),
    time: (value.getHours() << 11) | (value.getMinutes() << 5) | Math.floor(value.getSeconds() / 2),
  };
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  }
  return value >>> 0;
});

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}
