import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readdir, readFile, rename, stat, writeFile} from 'node:fs/promises';
import path from 'node:path';

const IGNORED_DIRS = new Set(['data', 'node_modules', '.git', 'outputs', 'workspaces', 'test']);

export function formatReleaseDate(value) {
  const parts = new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(value));
  const p = Object.fromEntries(parts.map(v => [v.type, v.value]));
  return `${p.year}.${p.month}.${p.day} (${p.weekday}) ${p.hour}:${p.minute}`;
}

function readShortCommit(root) {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

async function computeFingerprint(root, cache) {
  const files = [];
  async function walk(dir) {
    const entries = await readdir(dir, {withFileTypes: true});
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name.startsWith('node_modules-') || IGNORED_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && /\.(mjs|js|json|html|css|ps1|cmd)$/.test(entry.name) && entry.name !== 'package-lock.json' && entry.name !== 'pnpm-lock.yaml') {
        files.push(full);
      }
    }
  }
  await walk(root);

  const hash = createHash('sha256');
  let modified = 0;
  const entries = await Promise.all(files.sort().map(async file => {
    const info = await stat(file);
    const sig = `${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
    let entry = cache.get(file);
    if (entry?.sig !== sig) {
      let bytes = await readFile(file);
      if (file === path.join(root, 'package.json')) {
        try {
          const parsed = JSON.parse(bytes.toString('utf8'));
          delete parsed.version;
          bytes = Buffer.from(JSON.stringify(parsed), 'utf8');
        } catch {}
      }
      entry = {sig, bytes};
      cache.set(file, entry);
    }
    return {file, bytes: entry.bytes, modified: info.mtimeMs};
  }));

  const present = new Set(files);
  for (const file of cache.keys()) {
    if (!present.has(file)) cache.delete(file);
  }
  for (const {file, bytes, modified: mtime} of entries) {
    hash.update(path.relative(root, file).replaceAll('\\', '/'));
    hash.update('\0');
    hash.update(bytes);
    hash.update('\0');
    modified = Math.max(modified, mtime);
  }
  return {hash: hash.digest('hex'), modified};
}

export function createReleaseTracker(root, {interval = 5000, initialVersion = 67} = {}) {
  const file = path.join(root, '.app-release.json');
  const fingerprints = new Map();
  let cached = null;
  let bootVersion = null;
  let bootHash = null;
  let nextCheck = 0;
  let inflight = null;

  function toPayload(info) {
    const commit = readShortCommit(root);
    return {
      ...info,
      bootVersion: bootVersion ?? info.version,
      needsRestart: Boolean(bootHash && info.hash && bootHash !== info.hash),
      commit,
      displayDate: formatReleaseDate(info.updatedAt),
    };
  }

  async function check() {
    let previous = cached;
    if (!previous) {
      try {
        previous = JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
      } catch (err) {
        if (err?.code !== 'ENOENT') throw err;
      }
    }
    const current = await computeFingerprint(root, fingerprints);
    if (!previous || current.hash !== previous.hash) {
      cached = {
        version: previous ? Number(previous.version || initialVersion) + 1 : initialVersion,
        updatedAt: new Date(current.modified || Date.now()).toISOString(),
        hash: current.hash,
      };
      const tmp = `${file}.tmp`;
      await writeFile(tmp, JSON.stringify(cached, null, 2) + '\n', 'utf8');
      await rename(tmp, file);
    } else {
      cached = previous;
    }

    if (bootVersion === null) {
      bootVersion = cached.version;
      bootHash = cached.hash;
    }

    const pkgPath = path.join(root, 'package.json');
    try {
      const pkg = JSON.parse((await readFile(pkgPath, 'utf8')).replace(/^\uFEFF/, ''));
      const desired = `1.${cached.version}.0`;
      if (pkg.version !== desired) {
        pkg.version = desired;
        await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
      }
    } catch {}

    nextCheck = Date.now() + interval;
    return toPayload(cached);
  }

  return {
    async get() {
      if (inflight) return inflight;
      if (cached && Date.now() < nextCheck) return toPayload(cached);
      inflight = check();
      try {
        return await inflight;
      } finally {
        inflight = null;
      }
    },
  };
}
