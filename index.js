#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable no-console */
/**
 * Smart npm link script (ESM, Windows-safe).
 * - Detects existing global link, app link.
 * - If app has a non-symlink install, removes it then links.
 * - Optional: --watch (runs "npm run build -- --watch" in the library)
 * - Optional: --unlink [--unlink-global]
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import semver from 'semver';

const isWin = process.platform === 'win32';
const npmExe = isWin ? 'npm.cmd' : 'npm';

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    stdio: 'inherit',
    ...opts,
  });
  if (res.status !== 0) {
    throw new Error(`Command failed: ${cmd} ${args.join(' ')}`);
  }
}

function runCapture(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  });
  if (res.status !== 0) {
    const msg = (res.stderr || '').toString() || (res.stdout || '').toString();
    throw new Error(`Command failed: ${cmd} ${args.join(' ')}\n${msg}`);
  }
  return (res.stdout || '').toString().trim();
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

function npmRootGlobal() {
  const prefix = runCapture(npmExe, ['config', 'get', 'prefix']);
  return path.join(prefix, 'node_modules');
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
  node link-lib.mjs <relative-path-to-library> [--watch] [--unlink] [--unlink-global]

Examples:
  node link-lib.mjs ../AP.PlatformModules.VueComponents
  node link-lib.mjs ../AP.PlatformModules.VueComponents --watch
  node link-lib.mjs ../AP.PlatformModules.VueComponents --unlink
  node link-lib.mjs ../AP.PlatformModules.VueComponents --unlink --unlink-global
`);
  process.exit(1);
}

(async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) usageAndExit();

  const appDir = process.cwd();
  const libRel = args[0].replace(/[\\/]+$/, '');
  const doWatch = args.includes('--watch');
  const doUnlink = args.includes('--unlink');
  const doUnlinkGlobal = args.includes('--unlink-global');

  const libDir = path.resolve(appDir, libRel);
  const appPkgPath = path.join(appDir, 'package.json');
  const libPkgPath = path.join(libDir, 'package.json');

  if (!fs.existsSync(appPkgPath)) throw new Error(`No package.json in app: ${appDir}`);
  if (!fs.existsSync(libPkgPath)) throw new Error(`No package.json in library: ${libDir}`);

  const appPkg = readJson(appPkgPath);
  const libPkg = readJson(libPkgPath);
  const libName = libPkg.name;
  if (!libName) throw new Error(`Library has no "name" in ${libPkgPath}`);

  const appNodeModulesLib = path.join(appDir, 'node_modules', libName);
  const globalRoot = npmRootGlobal();
  const globalLinkPath = path.join(globalRoot, libName);

  // --- unlink flows ---
  if (doUnlink) {
    console.log(`\n➡️  Unlinking ${libName} from app...`);
    try {
      run(npmExe, ['unlink', libName], { cwd: appDir });
    } catch (e) {
      console.warn(`(npm unlink ${libName} in app): ${e.message}`);
    }

    const inDeps = appPkg.dependencies && libName in appPkg.dependencies;
    const inDevDeps = appPkg.devDependencies && libName in appPkg.devDependencies;
    const originalSpec = (inDeps && appPkg.dependencies[libName]) || (inDevDeps && appPkg.devDependencies[libName]) || null;

    // Build the right install args
    const installArgs = ['install'];
    if (inDevDeps)
      installArgs.push('--save-dev'); // keep it in devDeps if that’s where it was
    else installArgs.push('--save-prod'); // default

    if (originalSpec && !originalSpec.startsWith('file:')) {
      // Reinstall the SAME spec the app had (could be exact, range, tag, or dist-tag like "nightly")
      installArgs.push(`${libName}@${originalSpec}`);

      // If it looks like an exact version (e.g. 0.5.0-nightly.5 or 1.2.3), force exact save
      // so npm doesn't rewrite it as ^x.y.z
      const isExact = !!semver.valid(originalSpec) || /-\w+/.test(originalSpec); // crude check for prerelease
      if (isExact) installArgs.push('--save-exact');
    } else {
      // No prior spec (or was file:), fall back to registry latest
      installArgs.push(libName);
    }

    console.log('📦 Reinstalling registry version in app with preserved spec...');
    run(npmExe, installArgs, { cwd: appDir });

    console.log('✅ App dependency restored.');

    if (doUnlinkGlobal) {
      console.log(`\n➡️  Removing global link for ${libName}...`);
      try {
        run(npmExe, ['unlink', '-g', libName], { cwd: appDir });
      } catch (e) {
        console.warn(`(npm -g unlink ${libName}): ${e.message}`);
      }
      try {
        if (fs.existsSync(globalLinkPath)) fs.rmSync(globalLinkPath, { recursive: true, force: true });
      } catch (e) {
        console.warn(`(cleanup failed): ${e.message}`);
      }
      console.log('✅ Global link removed.');
    }
    return;
  }

  // --- detection ---
  const globalIsLinkedToLib = isSymlinkTo(globalLinkPath, libDir);
  const appIsLinkedToLib = isSymlinkTo(appNodeModulesLib, libDir);
  const appHasInstalledFolder = fs.existsSync(appNodeModulesLib) && !appIsLinkedToLib;

  console.log(`\nStatus:
  • Global link ${globalIsLinkedToLib ? '✅ exists (points to library)' : fs.existsSync(globalLinkPath) ? '⚠️ exists but points elsewhere' : '❌ not present'}
  • App link    ${appIsLinkedToLib ? '✅ exists (points to library)' : appHasInstalledFolder ? 'ℹ️ installed (not linked)' : '❌ not present'}
  `);

  // --- ensure global link ---
  if (!globalIsLinkedToLib) {
    console.log(`\n📦 Creating/refreshing global link for ${libName} from library...`);
    run(npmExe, ['link'], { cwd: libDir });
    console.log('✅ Global link ready.');
  } else {
    console.log('↩️  Global link already set — skipping.');
  }

  // --- ensure app link ---
  if (appIsLinkedToLib) {
    console.log('↩️  App is already linked to the library — nothing to do.');
  } else {
    if (appHasInstalledFolder) {
      console.log(`🧹 Removing existing non-symlink install: ${appNodeModulesLib}`);
      try {
        fs.rmSync(appNodeModulesLib, { recursive: true, force: true });
      } catch (e) {
        console.warn(`(cleanup failed): ${e.message}`);
      }
    }

    console.log(`\n📦 Linking ${libName} into app...`);
    try {
      run(npmExe, ['link', libName], { cwd: appDir });
    } catch (e1) {
      console.warn(`⚠️  First link attempt failed. Trying "npm unlink ${libName}" then relink...`);
      try {
        run(npmExe, ['unlink', libName], { cwd: appDir });
      } catch (e) {
        console.warn(`(npm unlink ${libName} in app): ${e.message}`);
      }
      run(npmExe, ['link', libName], { cwd: appDir });
    }

    const ok = isSymlinkTo(appNodeModulesLib, libDir);
    if (ok) {
      console.log(`✅ Verified: node_modules/${libName} -> ${libDir}`);
    } else {
      console.warn('⚠️  Link done but verification failed; check symlink permissions / paths.');
    }
  }

  warnPeerDeps(appPkg, libPkg);

  if (doWatch) {
    console.log(`\n👀 Starting build watcher in library...\n`);
    const child = spawn(npmExe, ['run', 'build', '--', '--watch'], {
      cwd: libDir,
      stdio: 'inherit',
      shell: true,
    });
    child.on('exit', (code) => console.log(`\nℹ️  Watcher exited with code ${code}`));
  }
})().catch((err) => {
  console.error(`\n❌ Error: ${err.message}`);
  process.exit(1);
});
