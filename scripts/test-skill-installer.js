import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { buildSkillInstallCommand, buildSkillInstallScript, buildSkillManifest, buildSkillPackage } from '../skill-package.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const execFileAsync = promisify(execFile);

test('npx-style installer copies the skill and writes the server URL', async () => {
  const targetRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'image2-skill-install-'));
  try {
    execFileSync(process.execPath, [
      path.join(root, 'bin', 'image2-studio-skill.mjs'),
      'install',
      '--url',
      'http://192.0.2.44:3020',
      '--target',
      targetRoot,
    ], { cwd: root, stdio: 'pipe' });

    const skillDir = path.join(targetRoot, 'image2-studio-generate');
    const skillText = await fs.readFile(path.join(skillDir, 'SKILL.md'), 'utf8');
    const scriptText = await fs.readFile(path.join(skillDir, 'scripts', 'generate-image.mjs'), 'utf8');

    assert.match(skillText, /name: image2-studio-generate/);
    assert.match(scriptText, /http:\/\/192\.0\.2\.44:3020/);
    assert.doesNotMatch(scriptText, /IMAGE2_STUDIO_PACKAGE_URL/);
  } finally {
    await fs.rm(targetRoot, { recursive: true, force: true });
  }
});

test('remote installer endpoints require HTTPS outside loopback', async () => {
  assert.throws(
    () => buildSkillInstallCommand({ serverUrl: 'http://192.0.2.44:3020' }),
    /requires an HTTPS Image2 Studio URL/,
  );
  const command = buildSkillInstallCommand({ serverUrl: 'http://127.0.0.1:3020' });
  assert.doesNotMatch(command, /Invoke-Expression|IEX/i);
  const skillDir = path.join(root, 'codex-skill', 'image2-studio-generate');
  await assert.rejects(
    () => buildSkillPackage({ skillDir, serverUrl: 'http://192.0.2.44:3020' }),
    /requires an HTTPS Image2 Studio URL/,
  );
  await assert.rejects(
    () => buildSkillManifest({ skillDir, serverUrl: 'http://192.0.2.44:3020' }),
    /requires an HTTPS Image2 Studio URL/,
  );
});

test('LAN installer is allowed and falls back to the GitHub package', async () => {
  const serverUrl = 'http://192.168.1.103:3020';
  const skillDir = path.join(root, 'codex-skill', 'image2-studio-generate');
  const command = buildSkillInstallCommand({ serverUrl, allowInsecureLan: true });
  const script = buildSkillInstallScript({ serverUrl, allowInsecureLan: true });

  assert.match(command, /api\/codex-skill\/install\.ps1/);
  assert.match(script, /https:\/\/github\.com\/weibinliao\/image2-studio\/archive\/refs\/heads\/main\.zip/);
  assert.match(script, /Join-Path \$extractPath \$githubArchiveRoot/);
  assert.match(script, /IMAGE2_STUDIO_PACKAGE_URL/);
  assert.ok(script.includes("$relativePath = ([string]$file.path).Replace('\\', '/')"));
  assert.ok(script.includes("-match '(^|/)\\.\\.(?:/|$)'"));
  assert.match(script, /generator\.Contains/);
  await assert.doesNotReject(() => buildSkillPackage({ skillDir, serverUrl, allowInsecureLan: true }));
  await assert.doesNotReject(() => buildSkillManifest({ skillDir, serverUrl, allowInsecureLan: true }));
});

test('PowerShell download command writes the installer file', { skip: process.platform !== 'win32' }, async () => {
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'image2-skill-download-command-'));
  const destination = path.join(testRoot, 'install-image2-studio-skill.ps1');
  const server = http.createServer();

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    const serverUrl = `http://127.0.0.1:${address.port}`;
    server.on('request', (request, response) => {
      if (request.url !== '/api/codex-skill/install.ps1') {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end("Write-Host 'Image2 Skill installer'");
    });

    await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-Command',
      buildSkillInstallCommand({ serverUrl }),
    ], {
      env: { ...process.env, TEMP: testRoot, TMP: testRoot },
      windowsHide: true,
    });

    assert.equal(await fs.readFile(destination, 'utf8'), "Write-Host 'Image2 Skill installer'");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(testRoot, { recursive: true, force: true });
  }
});

test('Skill persists and reuses its signed session cookie', async () => {
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'image2-skill-identity-'));
  const outputDir = path.join(testRoot, 'outputs');
  const stateDir = path.join(testRoot, 'localappdata');
  const homeDir = path.join(testRoot, 'home');
  const scriptPath = path.join(root, 'codex-skill', 'image2-studio-generate', 'scripts', 'generate-image.mjs');
  const statusCookies = [];
  const server = http.createServer();

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    const serverUrl = `http://127.0.0.1:${address.port}`;
    server.on('request', (request, response) => {
      const requestUrl = new URL(request.url, serverUrl);
      if (requestUrl.pathname === '/api/status') {
        statusCookies.push(String(request.headers.cookie || ''));
        if (!request.headers.cookie) {
          response.setHeader('Set-Cookie', 'image2_client_token=user_test.signature; Path=/; HttpOnly');
        }
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ admin: false }));
        return;
      }
      if (requestUrl.pathname === '/api/jobs' && request.method === 'POST') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ job: { id: 'test-job' } }));
        return;
      }
      if (requestUrl.pathname === '/api/jobs/test-job') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({
          job: {
            status: 'succeeded',
            progress: 100,
            result: { images: [{ url: `${serverUrl}/outputs/test.png` }] },
          },
        }));
        return;
      }
      if (requestUrl.pathname === '/outputs/test.png') {
        response.writeHead(200, { 'Content-Type': 'image/png' });
        response.end(Buffer.from('test-image'));
        return;
      }
      response.writeHead(404).end();
    });

    const env = {
      ...process.env,
      LOCALAPPDATA: stateDir,
      USERPROFILE: homeDir,
      HOME: homeDir,
    };
    const runArgs = [
      scriptPath,
      '--prompt', 'identity test',
      '--base-url', serverUrl,
      '--client-id', 'explicit-member',
      '--output-dir', outputDir,
    ];
    await execFileAsync(process.execPath, runArgs, { cwd: root, env });
    await execFileAsync(process.execPath, runArgs, { cwd: root, env });

    assert.equal(statusCookies.length, 2);
    assert.equal(statusCookies[0], '');
    assert.match(statusCookies[1], /image2_client_token=user_test\.signature/);
    const state = JSON.parse(await fs.readFile(path.join(stateDir, 'Image2 Studio', 'codex-skill-client-id'), 'utf8'));
    assert.equal(state.clientId, 'explicit-member');
    assert.equal(state.sessionCookie, 'image2_client_token=user_test.signature');
    assert.equal(state.sessionOrigin, serverUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(testRoot, { recursive: true, force: true });
  }
});

test('Skill never sends a persisted session cookie to a different origin', async () => {
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'image2-skill-origin-'));
  const stateDir = path.join(testRoot, 'localappdata');
  const homeDir = path.join(testRoot, 'home');
  const scriptPath = path.join(root, 'codex-skill', 'image2-studio-generate', 'scripts', 'generate-image.mjs');
  const firstCookies = [];
  const secondCookies = [];
  const firstServer = createStatusOnlyServer(firstCookies, 'image2_client_token=first_server.signature; Path=/; HttpOnly');
  const secondServer = createStatusOnlyServer(secondCookies, 'image2_client_token=second_server.signature; Path=/; HttpOnly');

  try {
    const firstUrl = await listenForTest(firstServer);
    const secondUrl = await listenForTest(secondServer);
    const env = {
      ...process.env,
      LOCALAPPDATA: stateDir,
      USERPROFILE: homeDir,
      HOME: homeDir,
    };
    const run = (serverUrl) => execFileAsync(process.execPath, [
      scriptPath,
      '--prompt', 'origin test',
      '--base-url', serverUrl,
      '--output-dir', path.join(testRoot, 'outputs'),
    ], { cwd: root, env });

    await assert.rejects(run(firstUrl), /HTTP 404/);
    await assert.rejects(run(secondUrl), /HTTP 404/);

    assert.equal(firstCookies[0], '');
    assert.equal(secondCookies[0], '');
  } finally {
    await Promise.all([
      new Promise((resolve) => firstServer.close(resolve)),
      new Promise((resolve) => secondServer.close(resolve)),
    ]);
    await fs.rm(testRoot, { recursive: true, force: true });
  }
});

test('direct installer downloads only the packaged Skill files', { skip: process.platform !== 'win32' }, async () => {
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'image2-direct-skill-install-'));
  const installHome = path.join(testRoot, 'home');
  const scriptPath = path.join(testRoot, 'install.ps1');
  const skillDir = path.join(root, 'codex-skill', 'image2-studio-generate');
  const server = http.createServer();

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    const serverUrl = `http://127.0.0.1:${address.port}`;
    const archive = await buildSkillPackage({ skillDir, serverUrl });
    server.on('request', (request, response) => {
      if (request.url !== '/api/codex-skill') {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Length': archive.length,
      });
      response.end(archive);
    });

    await fs.writeFile(scriptPath, buildSkillInstallScript({ serverUrl }), 'utf8');
    await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
    ], {
      env: { ...process.env, IMAGE2_SKILL_HOME: installHome },
      windowsHide: true,
    });

    for (const rootName of ['.agents', '.codex']) {
      const installedDir = path.join(installHome, rootName, 'skills', 'image2-studio-generate');
      const files = await listRelativeFiles(installedDir);
      assert.deepEqual(files, ['SKILL.md', 'agents/openai.yaml', 'scripts/generate-image.mjs']);
      const script = await fs.readFile(path.join(installedDir, 'scripts', 'generate-image.mjs'), 'utf8');
      assert.match(script, new RegExp(serverUrl.replaceAll('.', '\\.')));
      assert.doesNotMatch(script, /IMAGE2_STUDIO_PACKAGE_URL/);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(testRoot, { recursive: true, force: true });
  }
});

test('direct installer can install from the manifest without an archive extractor', { skip: process.platform !== 'win32' }, async () => {
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'image2-manifest-skill-install-'));
  const installHome = path.join(testRoot, 'home');
  const scriptPath = path.join(testRoot, 'install.ps1');
  const skillDir = path.join(root, 'codex-skill', 'image2-studio-generate');
  const server = http.createServer();

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    const serverUrl = `http://127.0.0.1:${address.port}`;
    const manifest = await buildSkillManifest({ skillDir, serverUrl });
    server.on('request', (request, response) => {
      if (request.url !== '/api/codex-skill/manifest') {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(manifest));
    });

    await fs.writeFile(scriptPath, buildSkillInstallScript({ serverUrl }), 'utf8');
    await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
    ], {
      env: { ...process.env, IMAGE2_SKILL_HOME: installHome },
      windowsHide: true,
    });

    const installedDir = path.join(installHome, '.agents', 'skills', 'image2-studio-generate');
    assert.deepEqual(await listRelativeFiles(installedDir), [
      'SKILL.md',
      'agents/openai.yaml',
      'scripts/generate-image.mjs',
    ]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(testRoot, { recursive: true, force: true });
  }
});

function createStatusOnlyServer(cookies, issuedCookie) {
  return http.createServer((request, response) => {
    if (request.url !== '/api/status') {
      response.writeHead(404).end();
      return;
    }
    cookies.push(String(request.headers.cookie || ''));
    response.setHeader('Set-Cookie', issuedCookie);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ admin: false }));
  });
}

async function listenForTest(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

async function listRelativeFiles(directory) {
  const files = [];
  async function walk(current) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(fullPath);
      else files.push(path.relative(directory, fullPath).replaceAll('\\', '/'));
    }
  }
  await walk(directory);
  return files.sort();
}
