#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_NAME = 'image2-studio-generate';
const SERVER_URL_TOKEN = "'IMAGE2_STUDIO_PACKAGE_URL'";

const args = parseArgs(process.argv.slice(2));
const command = args._[0] || 'help';

try {
  if (command === 'install') {
    await installSkill();
  } else {
    printHelp(command === 'help' || command === '--help' || command === '-h' ? 0 : 1);
  }
} catch (error) {
  console.error(error.message || error);
  process.exit(1);
}

async function installSkill() {
  const serverUrl = normalizeServerUrl(requiredOption('url'));
  const sourceDir = await resolveSourceSkillDir();
  const targets = resolveTargets(args.target || 'both');

  for (const targetRoot of targets) {
    const targetDir = await installSkillDirectory({ sourceDir, targetRoot, serverUrl });
    console.log(`Installed ${SKILL_NAME} -> ${targetDir}`);
  }

  console.log(`Image2 Studio URL: ${serverUrl}`);
}

async function resolveSourceSkillDir() {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const candidates = [
    path.join(root, '.agents', 'skills', SKILL_NAME),
    path.join(root, 'codex-skill', SKILL_NAME),
  ];

  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(path.join(candidate, 'SKILL.md'));
      if (stat.isFile()) return candidate;
    } catch {
      // Try the next packaged layout.
    }
  }

  throw new Error(`Cannot find packaged ${SKILL_NAME} skill files.`);
}

function resolveTargets(value) {
  const home = os.homedir();
  const standard = path.join(home, '.agents', 'skills');
  const codex = path.join(home, '.codex', 'skills');
  const normalized = String(value || '').trim().toLowerCase();

  if (!normalized || normalized === 'both') return uniquePaths([standard, codex]);
  if (normalized === 'agents' || normalized === 'standard') return [standard];
  if (normalized === 'codex') return [codex];

  return [path.resolve(value)];
}

async function patchSkillServerUrl(skillDir, serverUrl) {
  const scriptPath = path.join(skillDir, 'scripts', 'generate-image.mjs');
  const source = await fs.readFile(scriptPath, 'utf8');
  const next = source.includes(SERVER_URL_TOKEN)
    ? source.replace(SERVER_URL_TOKEN, JSON.stringify(serverUrl))
    : source.replace(/const packagedBaseUrl = ['"][^'"]*['"];/, `const packagedBaseUrl = ${JSON.stringify(serverUrl)};`);
  await fs.writeFile(scriptPath, next, 'utf8');
}

async function installSkillDirectory({ sourceDir, targetRoot, serverUrl }) {
  const targetDir = path.join(targetRoot, SKILL_NAME);
  const stagingDir = `${targetDir}.next-${crypto.randomUUID()}`;
  const backupDir = `${targetDir}.backup-${crypto.randomUUID()}`;
  let movedExisting = false;

  await fs.mkdir(targetRoot, { recursive: true });
  try {
    await fs.cp(sourceDir, stagingDir, { recursive: true });
    await patchSkillServerUrl(stagingDir, serverUrl);
    await validateSkillDirectory(stagingDir);

    try {
      await fs.rename(targetDir, backupDir);
      movedExisting = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    await fs.rename(stagingDir, targetDir);
    if (movedExisting) await fs.rm(backupDir, { recursive: true, force: true }).catch(() => {});
    return targetDir;
  } catch (error) {
    if (movedExisting && !(await pathExists(targetDir)) && await pathExists(backupDir)) {
      await fs.rename(backupDir, targetDir).catch(() => {});
    }
    throw error;
  } finally {
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function validateSkillDirectory(skillDir) {
  await Promise.all([
    fs.access(path.join(skillDir, 'SKILL.md')),
    fs.access(path.join(skillDir, 'scripts', 'generate-image.mjs')),
  ]);
}

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function parseArgs(values) {
  const parsed = { _: [] };
  for (let index = 0; index < values.length; index += 1) {
    const token = values[index];
    if (!token.startsWith('--')) {
      parsed._.push(token);
      continue;
    }

    const key = token.slice(2);
    const value = values[index + 1];
    if (!value || value.startsWith('--')) {
      parsed[key] = true;
    } else {
      parsed[key] = value;
      index += 1;
    }
  }
  return parsed;
}

function requiredOption(name) {
  const value = String(args[name] || '').trim();
  if (!value) throw new Error(`Missing --${name}. Example: image2-studio-skill install --url http://127.0.0.1:3020`);
  return value;
}

function normalizeServerUrl(value) {
  const url = new URL(String(value));
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('--url must use http or https.');
  return url.href.replace(/\/$/, '');
}

function uniquePaths(values) {
  return [...new Set(values.map((value) => path.resolve(value)))];
}

function printHelp(exitCode) {
  console.log('Usage: image2-studio-skill install --url <Image2 Studio URL> [--target both|agents|codex|<path>]');
  process.exit(exitCode);
}
