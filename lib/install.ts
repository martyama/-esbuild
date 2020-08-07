import fs = require('fs');
import os = require('os');
import url = require('url');
import path = require('path');
import zlib = require('zlib');
import https = require('https');
import child_process = require('child_process');

const version = require('./package.json').version;
const binPath = path.join(__dirname, 'bin', 'esbuild');
const stampPath = path.join(__dirname, 'stamp.txt');

async function installBinaryFromPackage(name: string, fromPath: string, toPath: string): Promise<void> {
  // It turns out that some package managers (e.g. yarn) sometimes re-run the
  // postinstall script for this package after we have already been installed.
  // That means this script must be idempotent. Let's skip the install if it's
  // already happened.
  if (fs.existsSync(stampPath)) {
    return;
  }

  // Try to install from the cache if possible
  const cachePath = getCachePath(name);
  try {
    // Copy from the cache
    fs.copyFileSync(cachePath, toPath);
    fs.chmodSync(toPath, 0o755);

    // Mark the cache entry as used for LRU
    const now = new Date;
    fs.utimesSync(cachePath, now, now);

    // Mark the operation as successful so this script is idempotent
    fs.writeFileSync(stampPath, '');
    return;
  } catch {
  }

  // Download the package from npm
  let officialRegistry = 'registry.npmjs.org';
  let urls = [`https://${officialRegistry}/${name}/-/${name}-${version}.tgz`];
  let debug = false;

  let finishInstall = (buffer: Buffer): void => {
    // Write out the binary executable that was extracted from the package
    fs.writeFileSync(toPath, buffer, { mode: 0o755 });

    // Mark the operation as successful so this script is idempotent
    fs.writeFileSync(stampPath, '');

    // Also try to cache the file to speed up future installs
    try {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      fs.copyFileSync(toPath, cachePath);
      cleanCacheLRU(cachePath);
    } catch {
    }

    if (debug) console.error(`Install successful`);
  };

  // Try downloading from a custom registry first if one is configured
  try {
    let env = url.parse(process.env.npm_config_registry || '');
    if (env.protocol && env.host && env.pathname && env.host !== officialRegistry) {
      let query = url.format({ ...env, pathname: path.posix.join(env.pathname, `${name}/${version}`) });
      try {
        // Query the API for the tarball location
        let tarball = JSON.parse((await fetch(query)).toString()).dist.tarball;
        if (urls.indexOf(tarball) < 0) urls.unshift(tarball);
      } catch (err) {
        console.error(`Failed to download ${JSON.stringify(query)}: ${err && err.message || err}`);
        debug = true;
      }
    }
  } catch {
  }

  // Try each registry URL in succession
  for (let url of urls) {
    let tryText = `Trying to download ${JSON.stringify(url)}`;
    try {
      if (debug) console.error(tryText);
      finishInstall(extractFileFromTarGzip(await fetch(url), fromPath));
      return;
    } catch (err) {
      if (!debug) console.error(tryText);
      console.error(`Failed to download ${JSON.stringify(url)}: ${err && err.message || err}`);
      debug = true;
    }
  }

  // If all of this fails, try using npm install instead. This is an attempt to
  // work around users that cannot send normal HTTP requests. For example, they
  // may have blocked registry.npmjs.org and configured a HTTPS proxy instead.
  try {
    console.log(`Trying to install "${name}" using npm`)
    finishInstall(installUsingNPM(name, fromPath));
    return;
  } catch (err) {
    console.error(`Failed to install "${name}" using npm: ${err && err.message || err}`);
  }

  console.error(`Install unsuccessful`);
  process.exit(1);
}

function getCachePath(name: string): string {
  const home = os.homedir();
  const common = ['esbuild', 'bin', `${name}@${version}`];
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Caches', ...common);
  if (process.platform === 'win32') return path.join(home, 'AppData', 'Local', 'Cache', ...common);
  return path.join(home, '.cache', ...common);
}

function cleanCacheLRU(fileToKeep: string): void {
  // Gather all entries in the cache
  const dir = path.dirname(fileToKeep);
  const entries: { path: string, mtime: Date }[] = [];
  for (const entry of fs.readdirSync(dir)) {
    const entryPath = path.join(dir, entry);
    try {
      const stats = fs.statSync(entryPath);
      entries.push({ path: entryPath, mtime: stats.mtime });
    } catch {
    }
  }

  // Only keep the most recent entries
  entries.sort((a, b) => +b.mtime - +a.mtime);
  for (const entry of entries.slice(5)) {
    try {
      fs.unlinkSync(entry.path);
    } catch {
    }
  }
}

function fetch(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location)
        return fetch(res.headers.location).then(resolve, reject);
      if (res.statusCode !== 200)
        return reject(new Error(`Server responded with ${res.statusCode}`));
      let chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

function extractFileFromTarGzip(buffer: Buffer, file: string): Buffer {
  try {
    buffer = zlib.unzipSync(buffer);
  } catch (err) {
    throw new Error(`Invalid gzip data in archive: ${err && err.message || err}`);
  }
  let str = (i: number, n: number) => String.fromCharCode(...buffer.subarray(i, i + n)).replace(/\0.*$/, '');
  let offset = 0;
  file = `package/${file}`;
  while (offset < buffer.length) {
    let name = str(offset, 100);
    let size = parseInt(str(offset + 124, 12), 8);
    offset += 512;
    if (!isNaN(size)) {
      if (name === file) return buffer.subarray(offset, offset + size);
      offset += (size + 511) & ~511;
    }
  }
  throw new Error(`Could not find ${JSON.stringify(file)} in archive`);
}

function installUsingNPM(name: string, file: string): Buffer {
  const installDir = path.join(__dirname, '.install');
  fs.mkdirSync(installDir);
  fs.writeFileSync(path.join(installDir, 'package.json'), '{}');

  // Erase "npm_config_global" so that "npm install --global esbuild" works.
  // Otherwise this nested "npm install" will also be global, and the install
  // will deadlock waiting for the global installation lock.
  const env = { ...process.env, npm_config_global: undefined };

  child_process.execSync(`npm install --loglevel=error --prefer-offline --no-audit --progress=false ${name}@${version}`,
    { cwd: installDir, stdio: 'inherit', env });
  const buffer = fs.readFileSync(path.join(installDir, 'node_modules', name, file));
  removeRecursive(installDir);
  return buffer;
}

function removeRecursive(dir: string): void {
  for (const entry of fs.readdirSync(dir)) {
    const entryPath = path.join(dir, entry);
    let stats;
    try {
      stats = fs.lstatSync(entryPath);
    } catch (e) {
      continue; // Guard against https://github.com/nodejs/node/issues/4760
    }
    if (stats.isDirectory()) removeRecursive(entryPath);
    else fs.unlinkSync(entryPath);
  }
  fs.rmdirSync(dir);
}

function installOnUnix(name: string): void {
  if (process.env.ESBUILD_BIN_PATH_FOR_TESTS) {
    fs.unlinkSync(binPath);
    fs.symlinkSync(process.env.ESBUILD_BIN_PATH_FOR_TESTS, binPath);
  } else {
    installBinaryFromPackage(name, 'bin/esbuild', binPath)
      .catch(e => setImmediate(() => { throw e; }));
  }
}

function installOnWindows(name: string): void {
  fs.writeFileSync(
    binPath,
    `#!/usr/bin/env node
const path = require('path');
const esbuild_exe = path.join(__dirname, '..', 'esbuild.exe');
const child_process = require('child_process');
child_process.spawnSync(esbuild_exe, process.argv.slice(2), { stdio: 'inherit' });
`);
  const exePath = path.join(__dirname, 'esbuild.exe');
  if (process.env.ESBUILD_BIN_PATH_FOR_TESTS) {
    fs.copyFileSync(process.env.ESBUILD_BIN_PATH_FOR_TESTS, exePath);
  } else {
    installBinaryFromPackage(name, 'esbuild.exe', exePath)
      .catch(e => setImmediate(() => { throw e; }));
  }
}

const key = `${process.platform} ${os.arch()} ${os.endianness()}`;
const knownWindowsPackages: Record<string, string> = {
  'win32 ia32 LE': 'esbuild-windows-32',
  'win32 x64 LE': 'esbuild-windows-64',
};
const knownUnixlikePackages: Record<string, string> = {
  'darwin x64 LE': 'esbuild-darwin-64',
  'freebsd arm64 LE': 'esbuild-freebsd-arm64',
  'freebsd x64 LE': 'esbuild-freebsd-64',
  'linux arm64 LE': 'esbuild-linux-arm64',
  'linux ia32 LE': 'esbuild-linux-32',
  'linux ppc64 LE': 'esbuild-linux-ppc64le',
  'linux x64 LE': 'esbuild-linux-64',
};

// Pick a package to install
if (key in knownWindowsPackages) {
  installOnWindows(knownWindowsPackages[key]);
} else if (key in knownUnixlikePackages) {
  installOnUnix(knownUnixlikePackages[key]);
} else {
  console.error(`Unsupported platform: ${key}`);
  process.exit(1);
}
