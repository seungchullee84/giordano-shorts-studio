import {spawn} from 'node:child_process';
import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import path from 'node:path';

export const LOGIN_PLATFORMS = ['clip', 'youtube', 'reels'];

const PS_EXE = process.platform === 'win32'
  ? 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
  : 'powershell.exe';

const cryptoFailure = () =>
  new Error('이 Windows 계정에서 로그인 정보를 암호화하거나 읽지 못했습니다. 로그인 정보 저장 창에서 다시 저장해 주세요.');

/**
 * Windows DPAPI(CurrentUser)로 민감 로그인 정보를 암호화/복호화한다.
 * 자격 증명은 명령줄 인자나 로그가 아닌 stdin으로만 전달한다.
 */
export function protectPlatformSecret(value, decrypt = false) {
  if (process.platform !== 'win32') {
    return Promise.reject(new Error('로그인 정보 암호화 저장은 Windows 환경에서 지원합니다.'));
  }
  const prefix = [
    "$ErrorActionPreference='Stop'",
    '[Console]::InputEncoding=[Text.Encoding]::UTF8',
    '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
    "$null=[Reflection.Assembly]::LoadWithPartialName('System.Security')",
    '$v=[Console]::In.ReadToEnd()',
  ].join(';');
  const script = prefix + ';' + (
    decrypt
      ? "$p=[Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($v),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Text.Encoding]::UTF8.GetString($p))"
      : "$p=[Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($v),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Convert]::ToBase64String($p))"
  );

  return new Promise((resolve, reject) => {
    const child = spawn(PS_EXE, ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let finished = false;
    const finish = (err, result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(result);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish(cryptoFailure());
    }, 15000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      out += chunk;
      if (out.length > 65536) {
        try { child.kill(); } catch {}
        finish(cryptoFailure());
      }
    });
    child.stderr.resume();
    child.on('error', () => finish(cryptoFailure()));
    child.stdin.on('error', () => finish(cryptoFailure()));
    child.on('close', code => finish(code === 0 ? null : cryptoFailure(), out.trim()));
    child.stdin.end(String(value || ''), 'utf8');
  });
}

function isValidCredentials(value) {
  return typeof value?.username === 'string' &&
    value.username.trim().length > 0 &&
    value.username.length <= 200 &&
    typeof value?.password === 'string' &&
    value.password.length > 0 &&
    value.password.length <= 256;
}

function makeAccountHint(username = '') {
  const clean = String(username || '').trim();
  if (!clean) return '';
  if (clean.includes('@')) {
    const [local, domain] = clean.split('@');
    const head = local.slice(0, Math.min(2, local.length));
    return `${head}***@${domain}`;
  }
  return clean.slice(0, Math.min(2, clean.length)) + '***';
}

async function atomicWriteJson(filePath, data) {
  await mkdir(path.dirname(filePath), {recursive: true});
  const tmp = `${filePath}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await rename(tmp, filePath);
}

/**
 * 로컬 data/platform-login-settings.json (GitHub .gitignore 대상)에
 * 플랫폼별(clip/youtube/reels) 로그인 정보를 Windows DPAPI 암호화로 안전하게 보관한다.
 */
export function createPlatformLoginStore(dataDir, {protectFn = protectPlatformSecret} = {}) {
  const filePath = path.join(dataDir, 'platform-login-settings.json');
  let queue = Promise.resolve();

  async function readStore() {
    try {
      const raw = JSON.parse((await readFile(filePath, 'utf8')).replace(/^\uFEFF/, ''));
      if (raw && typeof raw === 'object' && raw.accounts && typeof raw.accounts === 'object') {
        return raw;
      }
      return {version: 1, accounts: {}};
    } catch (err) {
      if (err?.code === 'ENOENT') return {version: 1, accounts: {}};
      throw cryptoFailure();
    }
  }

  function summarize(store) {
    const accounts = {};
    for (const key of LOGIN_PLATFORMS) {
      const item = store.accounts?.[key] || {};
      const configured = Boolean(item.encryptedLogin);
      accounts[key] = {
        configured,
        enabled: configured && item.enabled !== false,
        accountHint: configured ? String(item.accountHint || '') : '',
        updatedAt: configured ? String(item.updatedAt || '') : '',
      };
    }
    return {
      supported: process.platform === 'win32',
      accounts,
    };
  }

  return {
    async getSummary() {
      return summarize(await readStore());
    },

    update(input = {}) {
      const run = queue.catch(() => {}).then(async () => {
        const platform = String(input.platform || '').trim();
        if (!LOGIN_PLATFORMS.includes(platform)) {
          throw new Error('지원하지 않는 플랫폼입니다. (clip, youtube, reels)');
        }
        const action = String(input.action || 'save').trim();
        const store = await readStore();
        store.accounts = store.accounts || {};

        if (action === 'delete') {
          delete store.accounts[platform];
          await atomicWriteJson(filePath, store);
          return summarize(store);
        }

        if (action !== 'save') {
          throw new Error('올바르지 않은 로그인 저장 요청입니다.');
        }

        const existing = store.accounts[platform] || {};
        const enabled = input.enabled !== undefined ? Boolean(input.enabled) : true;
        const hasNewCreds = Boolean(String(input.username || '').trim() || String(input.password || ''));

        if (hasNewCreds) {
          if (!isValidCredentials(input)) {
            throw new Error('아이디와 비밀번호를 모두 입력해 주세요.');
          }
          const username = input.username.trim();
          const encryptedLogin = await protectFn(JSON.stringify({username, password: input.password}), false);
          store.accounts[platform] = {
            enabled,
            encryptedLogin,
            accountHint: makeAccountHint(username),
            updatedAt: new Date().toISOString(),
          };
        } else {
          if (!existing.encryptedLogin) {
            throw new Error('처음 저장할 때는 아이디와 비밀번호를 모두 입력해 주세요.');
          }
          store.accounts[platform] = {
            ...existing,
            enabled,
          };
        }

        await atomicWriteJson(filePath, store);
        return summarize(store);
      });
      queue = run;
      return run;
    },

    async load(platform) {
      if (!LOGIN_PLATFORMS.includes(platform)) return null;
      const store = await readStore();
      const entry = store.accounts?.[platform];
      if (!entry || entry.enabled === false || !entry.encryptedLogin) return null;
      let decoded;
      try {
        decoded = JSON.parse(await protectFn(entry.encryptedLogin, true));
      } catch {
        throw cryptoFailure();
      }
      if (!isValidCredentials(decoded)) throw cryptoFailure();
      return {
        username: decoded.username.trim(),
        password: decoded.password,
        revision: entry.updatedAt || '',
      };
    },
  };
}
