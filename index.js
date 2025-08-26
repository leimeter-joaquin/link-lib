#!/usr/bin/env node
/**
 * Smart npm-link helper (ESM, Windows-safe).
 *
 * Usage:
 *   node link-lib.js <app-path> <library-path> [--watch] [--unlink] [--unlink-global]
 *
 * Example:
 *   node link-lib.js ./apps/frontend ./libs/vue-components --watch
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import semver from 'semver';

const isWin = process.platform === 'win32';
const npmExe = isWin ? 'npm.cmd' : 'npm';

// ---------- helpers ----------
function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (res.status !== 0) {
    throw new Error(`Command failed: ${cmd} ${args.join(' ')}`);
  }
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function realEquals(aPath, bPath) {
  try {
    const a = fs.realpathSync(aPath);
    const b = fs.realpathSync(bPath);
    return a === b;
  } catch {
    return false;
  }
}

function isSymlinkTo(linkPath, expectedTargetAbs) {
  try {
    const st = fs.lstatSync(linkPath);
    if (!st.isSymbolicLink()) return false;
    const link = fs.readlinkSync(linkPath);
    const resolved = path.resolve(path.dirname(linkPath), link);
    return realEquals(resolved, expectedTargetAbs);
  } catch {
    return false;
  }
}

function warnPeerDeps(appPkg, libPkg) {
  if (!libPkg.peerDependencies) return;
  const appDeps = {
    ...appPkg.dependencies,
    ...appPkg.devDependencies,
    ...appPkg.optionalDependencies,
  };
  const missing = [];
  const outOfRange = [];

  for (const [name, range] of Object.entries(libPkg.peerDependencies)) {
    const installed = appDeps?.[name];
    if (!installed) {
      missing.push(`${name}@${range}`);
    } else if (semver.validRange(range) && semver.validRange(installed)) {
      if (!semver.intersects(range, installed)) {
        outOfRange.push(`${name} (app has ${installed}, lib expects ${range})`);
      }
    }
  }
  if (missing.length) {
    console.warn(`\n⚠️  Missing peerDependencies in app:\n  - ${missing.join('\n  - ')}\n`);
  }
  if (outOfRange.length) {
    console.warn(`\n⚠️  Version mismatch for peerDependencies:\n  - ${outOfRange.join('\n  - ')}\n`);
  }
}

function usageAndExit() {
  console.log(`Usage:
  node link-lib.js <app-path> <library-path> [--watch] [--unlink] [--unlink-global]`);
  process.exit(1);
}

// ---------- main ----------
(async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) usageAndExit();

  const appDir = path.resolve(process.cwd(), args[0]);
  const libDir = path.resolve(process.cwd(), args[1]);
  const doWatch = args.includes('--watch');
  const doUnlink = args.includes('--unlink');
  const doUnlinkGlobal = args.includes('--unlink-global');

  const appPkgPath = path.join(appDir, 'package.json');
  const libPkgPath = path.join(libDir, 'package.json');

  if (!fs.existsSync(appPkgPath)) throw new Error(`No package.json in app: ${appDir}`);
  if (!fs.existsSync(libPkgPath)) throw new Error(`No package.json in library: ${libDir}`);

  const appPkg = readJson(appPkgPath);
  const libPkg = readJson(libPkgPath);
  const libName = libPkg.name;
  if (!libName) throw new Error(`Library has no "name" in ${libPkgPath}`);

  const appNodeModulesLib = path.join(appDir, 'node_modules', libName);

  // ---------- unlink flow  ----------
  if (doUnlink) {
    console.log(`\n➡️  Unlinking ${libName} from app...`);
    try { run(npmExe, ['unlink', libName], { cwd: appDir }); }
    catch (e) { console.warn(`(npm unlink ${libName} in app): ${e.message}`); }

    const inDeps = appPkg.dependencies && libName in appPkg.dependencies;
    const inDevDeps = appPkg.devDependencies && libName in appPkg.devDependencies;
    const originalSpec =
      (inDeps && appPkg.dependencies[libName]) ||
      (inDevDeps && appPkg.devDependencies[libName]) ||
      null;

    const installArgs = ['install'];
    if (inDevDeps) installArgs.push('--save-dev'); else installArgs.push('--save-prod');

    if (originalSpec && !originalSpec.startsWith('file:')) {
      installArgs.push(`${libName}@${originalSpec}`);
      const isExact = !!semver.valid(originalSpec) || /-\w+/.test(originalSpec);
      if (isExact) installArgs.push('--save-exact');
    } else {
      installArgs.push(libName);
    }

    console.log('📦 Reinstalling dependency in app with preserved spec...');
    run(npmExe, installArgs, { cwd: appDir });
    console.log('✅ App dependency restored.');

    if (doUnlinkGlobal) {
      console.log(`\n➡️  Removing global link for ${libName}...`);
      try { run(npmExe, ['unlink', '-g', libName]); }
      catch (e) { console.warn(`(npm -g unlink ${libName}): ${e.message}`); }
      console.log('✅ Global link removed.');
    }
    return;
  }

  // ---------- detection (app link) ----------
  const appIsLinkedToLib = isSymlinkTo(appNodeModulesLib, libDir);
  const appHasInstalledFolder = fs.existsSync(appNodeModulesLib) && !appIsLinkedToLib;

  console.log(`\nStatus:
  • App link ${appIsLinkedToLib ? '✅ exists (points to library)' : (appHasInstalledFolder ? 'ℹ️ installed (not linked)' : '❌ not present')}
  `);

  // ---------- ensure global link ----------
  try {
    console.log(`\n📦 Ensuring global link is set (running "npm link" in library)...`);
    run(npmExe, ['link'], { cwd: libDir });
    console.log('✅ Global link ready (or already existed).');
  } catch (e) {
    console.warn(`⚠️  "npm link" in library reported an error (continuing): ${e.message}`);
  }

  // ---------- ensure app link ----------
  if (appIsLinkedToLib) {
    console.log('↩️  App is already linked to the library — nothing to do.');
  } else {
    if (appHasInstalledFolder) {
      console.log(`🧹 Removing existing non-symlink install: ${appNodeModulesLib}`);
      try { fs.rmSync(appNodeModulesLib, { recursive: true, force: true }); }
      catch (e) { console.warn(`(cleanup failed): ${e.message}`); }
    }

    console.log(`\n📦 Linking ${libName} into app...`);
    try {
      run(npmExe, ['link', libName], { cwd: appDir });
    } catch (e1) {
      console.warn(`⚠️  First link attempt failed. Trying "npm unlink ${libName}" then relink...`);
      try { run(npmExe, ['unlink', libName], { cwd: appDir }); } catch {}
      run(npmExe, ['link', libName], { cwd: appDir });
    }

    const ok = isSymlinkTo(appNodeModulesLib, libDir);
    if (ok) {
      console.log(`✅ Verified: node_modules/${libName} -> ${libDir}`);
    } else {
      console.warn('⚠️  Link done but verification failed; check symlink permissions / paths.');
    }
  }

  // ---------- peer deps + watch ----------
  warnPeerDeps(appPkg, libPkg);

  if (doWatch) {
    console.log(`\n👀 Starting build watcher in library...\n`);
    const child = spawn(npmExe, ['run', 'build', '--', '--watch'], {
      cwd: libDir,
      stdio: 'inherit',
    });
    child.on('exit', (code) => console.log(`\nℹ️  Watcher exited with code ${code}`));
  }
})().catch((err) => {
  console.error(`\n❌ Error: ${err.message}`);
  process.exit(1);
});
