/* CounciLLM local authentication with IndexedDB, localStorage, and local server persistence fallback. */
(() => {
  'use strict';
  const DB_NAME = 'councillm-auth', STORE = 'account', KEY = 'local-account', ITERATIONS = 100000;
  const LS_KEY = 'councillm-local-account';
  const root = document.getElementById('auth-gate');
  let attempts = 0, lockUntil = 0, recoveryPlaintext = '';
  const encoder = new TextEncoder();
  const bytesTo64 = a => btoa(String.fromCharCode(...a));
  const from64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const random = length => {
    const value = new Uint8Array(length);
    if (window.crypto?.getRandomValues) {
      crypto.getRandomValues(value);
    } else {
      for (let i = 0; i < length; i++) value[i] = Math.floor(Math.random() * 256);
    }
    return value;
  };
  const equal = (a, b) => {
    if (a.length !== b.length) return false;
    let result = 0;
    for (let i = 0; i < a.length; i++) result |= a[i] ^ b[i];
    return result === 0;
  };

  function fallbackDerive(secret, salt) {
    const input = encoder.encode(secret + ':' + bytesTo64(salt));
    const out = new Uint8Array(32);
    let h1 = 0x811c9dc5, h2 = 0x01000193;
    for (let round = 0; round < 1024; round++) {
      for (let i = 0; i < input.length; i++) {
        h1 ^= input[i] + round;
        h1 = Math.imul(h1, 0x01000193) >>> 0;
        h2 ^= (h1 >>> 13) ^ input[i];
        h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
        out[(i + round) & 31] = (out[(i + round) & 31] ^ (h1 & 0xff) ^ (h2 & 0xff)) & 0xff;
      }
    }
    return out;
  }

  async function derive(secret, salt, iterations = ITERATIONS) {
    try {
      if (window.crypto?.subtle) {
        const key = await crypto.subtle.importKey('raw', encoder.encode(secret), 'PBKDF2', false, ['deriveBits']);
        return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
      }
    } catch {
      // Fallback if Web Crypto fails inside restricted iframe
    }
    return fallbackDerive(secret, salt);
  }

  function db() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) return reject(new Error('IndexedDB unavailable'));
      try {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id' });
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(new Error('Persistent local storage is unavailable.'));
        request.onblocked = () => reject(new Error('Close other CounciLLM tabs before changing the local account.'));
      } catch (err) {
        reject(err);
      }
    });
  }

  async function getAccount() {
    try {
      const database = await db();
      const idbResult = await new Promise((resolve, reject) => {
        const request = database.transaction(STORE, 'readonly').objectStore(STORE).get(KEY);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(new Error('Could not read the local account.'));
      });
      if (idbResult) return idbResult;
    } catch {
      // Ignore IDB errors and try localStorage / backend
    }
    try {
      const lsRaw = localStorage.getItem(LS_KEY);
      if (lsRaw) return JSON.parse(lsRaw);
    } catch {
      // Ignore localStorage errors
    }
    try {
      const res = await fetch('/api/account');
      if (res.ok) {
        const data = await res.json();
        if (data?.account) return data.account;
      }
    } catch {
      // Ignore network errors
    }
    return null;
  }

  async function saveAccount(value) {
    let savedSomewhere = false;
    try {
      const database = await db();
      await new Promise((resolve, reject) => {
        const request = database.transaction(STORE, 'readwrite').objectStore(STORE).put(value);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(new Error('Could not save the local account.'));
      });
      savedSomewhere = true;
    } catch {
      // Fallback to localStorage / server
    }
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(value));
      savedSomewhere = true;
    } catch {
      // Ignore localStorage errors
    }
    try {
      const res = await fetch('/api/account', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account: value })
      });
      if (res.ok) savedSomewhere = true;
    } catch {
      // Ignore server errors
    }
    if (!savedSomewhere) {
      throw new Error('Could not save the local account.');
    }
  }

  async function removeAccount() {
    try {
      const database = await db();
      await new Promise((resolve) => {
        const request = database.transaction(STORE, 'readwrite').objectStore(STORE).delete(KEY);
        request.onsuccess = () => resolve();
        request.onerror = () => resolve();
      });
    } catch {
      // Ignore IDB errors
    }
    try {
      localStorage.removeItem(LS_KEY);
    } catch {
      // Ignore localStorage errors
    }
    try {
      await fetch('/api/account', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account: null })
      });
    } catch {
      // Ignore server errors
    }
  }

  function recoveryCode() {
    return [...random(20)].map(x => x.toString(16).padStart(2, '0')).join('').toUpperCase().match(/.{1,5}/g).join('-');
  }

  function layout(title, subtitle, content) {
    root.innerHTML = `<section class="auth-card" role="dialog" aria-modal="true" aria-labelledby="auth-title"><div class="auth-mark" aria-hidden="true"><svg width="40" height="40" viewBox="0 0 24 24" fill="currentColor" focusable="false"><path d="M12 2L13.5 9.5L21 11L13.5 12.5L12 20L10.5 12.5L3 11L10.5 9.5L12 2Z"/></svg></div><h1 id="auth-title">CounciLLM</h1><h2>${title}</h2><p class="auth-subtitle">${subtitle}</p>${content}<p class="auth-status" role="alert" aria-live="polite"></p><p class="auth-device-note">Stored locally on this workspace. Clearing account data removes this local account.</p></section>`;
    root.querySelector('input,button')?.focus();
  }

  function error(text) {
    const statusEl = root.querySelector('.auth-status');
    if (statusEl) statusEl.textContent = text;
  }

  function passwordFields(includeUsername = false) {
    return `${includeUsername ? '<label>Username<input id="auth-username" autocomplete="username" maxlength="64" placeholder="Enter any username (e.g. admin)"></label>' : ''}<label>Password <span>4+ characters</span><div class="password-field"><input id="auth-password" type="password" autocomplete="current-password" placeholder="Enter password"><button type="button" class="reveal" aria-label="Show password">Show</button></div></label>`;
  }

  function wireReveal() {
    root.querySelectorAll('.reveal').forEach(button => {
      button.onclick = () => {
        const field = button.previousElementSibling;
        field.type = field.type === 'password' ? 'text' : 'password';
        button.textContent = field.type === 'password' ? 'Show' : 'Hide';
      };
    });
  }

  function showSetup() {
    layout(
      'Create your local account',
      'This is a one-time setup. CounciLLM keeps your credentials local.',
      `<form id="auth-form">${passwordFields(true)}<label>Confirm password<div class="password-field"><input id="auth-confirm" type="password" autocomplete="new-password" placeholder="Re-enter password"><button type="button" class="reveal" aria-label="Show confirmation password">Show</button></div></label><p class="auth-hint">Choose any username and a password of at least 4 characters.</p><button class="auth-primary" type="submit">Create account</button></form>`
    );
    wireReveal();
    root.querySelector('#auth-form').onsubmit = async event => {
      event.preventDefault();
      const username = root.querySelector('#auth-username').value.trim();
      const password = root.querySelector('#auth-password').value;
      const confirm = root.querySelector('#auth-confirm').value;
      if (username.length < 1 || username.length > 64) {
        return error('Please enter a username.');
      }
      if (password.length < 4) {
        return error('Choose a password with at least 4 characters.');
      }
      if (confirm && password !== confirm) {
        return error('Passwords do not match.');
      }
      try {
        const salt = random(16), recoverySalt = random(16);
        recoveryPlaintext = recoveryCode();
        await saveAccount({
          id: KEY,
          version: 1,
          username,
          password: { salt: bytesTo64(salt), verifier: bytesTo64(await derive(password, salt)), iterations: ITERATIONS },
          recovery: { salt: bytesTo64(recoverySalt), verifier: bytesTo64(await derive(recoveryPlaintext, recoverySalt)), iterations: ITERATIONS },
          createdAt: new Date().toISOString()
        });
        showRecovery();
      } catch (e) {
        error(e.message || 'Could not create account.');
      }
    };
  }

  function showRecovery() {
    layout(
      'Save your recovery code',
      'This is the only way to reset a forgotten password offline.',
      `<div class="recovery-code" id="recovery-code">${recoveryPlaintext}</div><div class="recovery-actions"><button type="button" class="auth-secondary" id="copy-recovery">Copy recovery code</button><p class="auth-warning">Save this recovery code somewhere safe before continuing.</p><label class="auth-check"><input id="saved-recovery" type="checkbox" checked><span>I have saved my recovery code.</span></label><button class="auth-primary" id="finish-setup">Continue to CounciLLM</button></div>`
    );
    root.querySelector('#copy-recovery').onclick = async () => {
      try {
        await navigator.clipboard.writeText(recoveryPlaintext);
        error('Recovery code copied.');
      } catch {
        error('Copy is unavailable; record the displayed code manually.');
      }
    };
    const check = root.querySelector('#saved-recovery');
    check.onchange = () => {
      root.querySelector('#finish-setup').disabled = !check.checked;
    };
    root.querySelector('#finish-setup').onclick = () => {
      recoveryPlaintext = '';
      unlock();
    };
  }

  async function verify(account, secret, kind) {
    const item = account[kind];
    if (!item) return false;
    const actual = await derive(secret, from64(item.salt), item.iterations || ITERATIONS);
    return equal(actual, from64(item.verifier));
  }

  function throttle() {
    if (Date.now() < lockUntil) {
      error(`Please wait ${Math.ceil((lockUntil - Date.now()) / 1000)} seconds before trying again.`);
      return true;
    }
    return false;
  }

  function fail() {
    attempts++;
    if (attempts >= 5) {
      lockUntil = Date.now() + Math.min(15000, (attempts - 4) * 2000);
      error('Incorrect username or password. Please wait briefly before trying again.');
    } else {
      error('Incorrect username or password.');
    }
  }

  function showLogin(message = '', defaultUsername = '') {
    layout(
      'Unlock CounciLLM',
      'Sign in locally to access this CounciLLM workspace.',
      `<form id="auth-form"><label>Username<input id="auth-username" autocomplete="username" value="${defaultUsername.replace(/"/g, '&quot;')}"></label>${passwordFields()}<button class="auth-primary" type="submit">Login</button></form><div class="auth-links"><button type="button" id="forgot-password">Forgot password?</button><button type="button" class="danger-link" id="delete-account">Reset / Delete account</button></div>`
    );
    wireReveal();
    if (message) error(message);
    root.querySelector('#auth-form').onsubmit = async event => {
      event.preventDefault();
      if (throttle()) return;
      try {
        const account = await getAccount();
        const username = root.querySelector('#auth-username').value.trim();
        const password = root.querySelector('#auth-password').value;
        if (!account) return showSetup();
        if (username.toLowerCase() !== String(account.username || '').trim().toLowerCase() || !(await verify(account, password, 'password'))) {
          return fail();
        }
        attempts = 0;
        unlock();
      } catch (e) {
        error(e.message);
      }
    };
    root.querySelector('#forgot-password').onclick = showRecoveryVerify;
    root.querySelector('#delete-account').onclick = showDelete;
  }

  function showRecoveryVerify() {
    layout(
      'Recover your password',
      'Because CounciLLM is offline, use the recovery code saved during account setup.',
      `<form id="auth-form"><label>Recovery code<input id="recovery-input" autocomplete="off" spellcheck="false" placeholder="ABCDE-12345-…"></label><button class="auth-primary" type="submit">Verify recovery code</button><button class="auth-secondary" type="button" id="back-login">Back to login</button></form><p class="auth-hint">Lost your recovery code too? Use "Reset / Delete account" on the login screen to start fresh.</p>`
    );
    root.querySelector('#back-login').onclick = () => showLogin();
    root.querySelector('#auth-form').onsubmit = async event => {
      event.preventDefault();
      if (throttle()) return;
      try {
        const account = await getAccount();
        const code = root.querySelector('#recovery-input').value.trim().toUpperCase();
        if (!account || !(await verify(account, code, 'recovery'))) return fail();
        attempts = 0;
        showReset(account);
      } catch (e) {
        error(e.message);
      }
    };
  }

  function showReset(account) {
    layout(
      'Choose a new password',
      'Your recovery code was verified. Set a new local password.',
      `<form id="auth-form">${passwordFields()}<label>Confirm new password<div class="password-field"><input id="auth-confirm" type="password" autocomplete="new-password"><button type="button" class="reveal">Show</button></div></label><button class="auth-primary" type="submit">Save new password</button></form>`
    );
    wireReveal();
    root.querySelector('#auth-form').onsubmit = async event => {
      event.preventDefault();
      const password = root.querySelector('#auth-password').value;
      const confirm = root.querySelector('#auth-confirm').value;
      if (password.length < 4) return error('Choose a password with at least 4 characters.');
      if (confirm && password !== confirm) return error('Passwords do not match.');
      try {
        const salt = random(16);
        account.password = { salt: bytesTo64(salt), verifier: bytesTo64(await derive(password, salt)), iterations: ITERATIONS };
        await saveAccount(account);
        unlock();
      } catch (e) {
        error(e.message);
      }
    };
  }

  function showDelete() {
    layout(
      'Reset or delete local account',
      'This removes the current local account credentials and lets you create a fresh account.',
      `<form id="auth-form"><label class="auth-check"><input id="delete-confirm" type="checkbox" checked><span>I want to reset the local account and create a new password.</span></label><button class="auth-danger" type="submit">Reset account now</button><button class="auth-secondary" type="button" id="back-login">Cancel</button></form>`
    );
    root.querySelector('#back-login').onclick = () => showLogin();
    root.querySelector('#auth-form').onsubmit = async event => {
      event.preventDefault();
      if (!root.querySelector('#delete-confirm').checked) return error('Confirm that you want to reset the account.');
      try {
        await fetch('/api/account/data', { method: 'DELETE' });
        await removeAccount();
        attempts = 0;
        showSetup();
      } catch (e) {
        error(e.message);
      }
    };
  }

  function unlock() {
    root.classList.add('auth-unlocked');
    root.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('auth-locked');
    window.councilBootstrap?.();
  }

  async function start() {
    try {
      const existing = await getAccount();
      if (existing) {
        showLogin('', existing.username || '');
      } else {
        showSetup();
      }
    } catch {
      showSetup();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
