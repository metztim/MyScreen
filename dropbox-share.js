'use strict';

// Dropbox link sharing for the main process: OAuth 2 PKCE (no app secret),
// chunked upload, shared-link creation. No SDK; plain fetch against the HTTP API.
//
// The app key (built into SETTINGS_DEFAULTS) identifies the "MyScreen Recorder"
// Dropbox app; each user OAuths their own account. The refresh token is stored
// in the settings store.

const http = require('http');
const crypto = require('crypto');

const REDIRECT_PORT = 53682;
const REDIRECT_PATH = '/myscreen-auth';
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}${REDIRECT_PATH}`;
const CHUNK_SIZE = 8 * 1024 * 1024;
const AUTH_TIMEOUT_MS = 5 * 60 * 1000;

function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

class DropboxShare {
  // openExternal: (url) => void ; settings: { get(), set(patch) }
  constructor({ settings, openExternal }) {
    this.settings = settings;
    this.openExternal = openExternal;
    this._authServer = null;
  }

  status() {
    const s = this.settings.get();
    return {
      appKeySet: !!s.dropboxAppKey,
      connected: !!(s.dropboxAuth && s.dropboxAuth.refreshToken),
      account: s.dropboxAccount || '',
    };
  }

  disconnect() {
    this.settings.set({ dropboxAuth: null, dropboxAccount: '' });
  }

  // --- OAuth PKCE ------------------------------------------------------------

  async connect() {
    const appKey = this.settings.get().dropboxAppKey;
    if (!appKey) throw new Error('No Dropbox app key is configured.');

    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());

    const code = await this._waitForAuthCode(appKey, challenge);

    const tokens = await this._fetchJson('https://api.dropboxapi.com/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        grant_type: 'authorization_code',
        client_id: appKey,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
      }),
    });

    this.settings.set({
      dropboxAuth: {
        refreshToken: tokens.refresh_token,
        accessToken: tokens.access_token,
        expiresAt: Date.now() + (tokens.expires_in - 60) * 1000,
      },
    });

    const account = await this._api('https://api.dropboxapi.com/2/users/get_current_account', null);
    const name = (account.name && account.name.display_name) || account.email || 'Dropbox account';
    this.settings.set({ dropboxAccount: name });
    return { account: name };
  }

  _waitForAuthCode(appKey, challenge) {
    return new Promise((resolve, reject) => {
      if (this._authServer) { try { this._authServer.close(); } catch { /* old attempt */ } }

      const server = http.createServer((req, res) => {
        const url = new URL(req.url, `http://localhost:${REDIRECT_PORT}`);
        if (url.pathname !== REDIRECT_PATH) { res.writeHead(404); res.end(); return; }
        const code = url.searchParams.get('code');
        const err = url.searchParams.get('error_description') || url.searchParams.get('error');
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<body style="font-family:sans-serif;padding:40px"><h2>' +
          (code ? 'MyScreen is connected to Dropbox.' : 'Authorization failed.') +
          '</h2>You can close this window.</body>');
        cleanup();
        if (code) resolve(code);
        else reject(new Error(err || 'Authorization was denied.'));
      });

      const timer = setTimeout(() => { cleanup(); reject(new Error('Dropbox authorization timed out.')); }, AUTH_TIMEOUT_MS);
      const cleanup = () => { clearTimeout(timer); try { server.close(); } catch { /* closed */ } this._authServer = null; };

      server.on('error', (err) => { cleanup(); reject(new Error(`Could not listen on localhost:${REDIRECT_PORT}: ${err.message}`)); });
      server.listen(REDIRECT_PORT, '127.0.0.1', () => {
        const auth = new URL('https://www.dropbox.com/oauth2/authorize');
        auth.search = new URLSearchParams({
          client_id: appKey,
          response_type: 'code',
          code_challenge: challenge,
          code_challenge_method: 'S256',
          redirect_uri: REDIRECT_URI,
          token_access_type: 'offline',
        }).toString();
        this.openExternal(auth.toString());
      });
      this._authServer = server;
    });
  }

  async _accessToken() {
    const s = this.settings.get();
    const auth = s.dropboxAuth;
    if (!auth || !auth.refreshToken) throw new Error('Dropbox is not connected.');
    if (auth.accessToken && auth.expiresAt > Date.now()) return auth.accessToken;

    const tokens = await this._fetchJson('https://api.dropboxapi.com/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: auth.refreshToken,
        client_id: s.dropboxAppKey,
      }),
    });
    this.settings.set({
      dropboxAuth: {
        ...auth,
        accessToken: tokens.access_token,
        expiresAt: Date.now() + (tokens.expires_in - 60) * 1000,
      },
    });
    return tokens.access_token;
  }

  // --- upload + share ----------------------------------------------------------

  // Uploads the file to the app folder (Apps/MyScreen Recorder/) in the user's
  // Dropbox (chunked, any size) and returns a shared link. onProgress receives 0-100.
  async uploadAndShare(filePath, onProgress) {
    const fs = require('fs');
    const path = require('path');
    const token = await this._accessToken();
    const size = fs.statSync(filePath).size;
    // App-folder access: '/' is already Apps/MyScreen Recorder/ in the user's Dropbox.
    const dest = '/' + path.basename(filePath);

    const fd = fs.openSync(filePath, 'r');
    try {
      const first = this._readChunk(fd, 0);
      const start = await this._content(token, 'https://content.dropboxapi.com/2/files/upload_session/start', { close: false }, first);
      let offset = first.length;
      if (onProgress) onProgress(Math.round((offset / size) * 90));

      while (offset < size) {
        const chunk = this._readChunk(fd, offset);
        await this._content(token, 'https://content.dropboxapi.com/2/files/upload_session/append_v2', {
          cursor: { session_id: start.session_id, offset }, close: false,
        }, chunk);
        offset += chunk.length;
        if (onProgress) onProgress(Math.round((offset / size) * 90));
      }

      const finished = await this._content(token, 'https://content.dropboxapi.com/2/files/upload_session/finish', {
        cursor: { session_id: start.session_id, offset },
        commit: { path: dest, mode: 'add', autorename: true, mute: true },
      }, Buffer.alloc(0));
      if (onProgress) onProgress(95);

      const url = await this._sharedLink(token, finished.path_display || dest);
      if (onProgress) onProgress(100);
      return { url, path: finished.path_display || dest };
    } finally {
      fs.closeSync(fd);
    }
  }

  _readChunk(fd, offset) {
    const fs = require('fs');
    const buf = Buffer.alloc(CHUNK_SIZE);
    const read = fs.readSync(fd, buf, 0, CHUNK_SIZE, offset);
    return buf.subarray(0, read);
  }

  async _sharedLink(token, path) {
    try {
      const res = await this._api('https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings', { path }, token);
      return res.url;
    } catch (err) {
      if (String(err.message).includes('shared_link_already_exists')) {
        const res = await this._api('https://api.dropboxapi.com/2/sharing/list_shared_links', { path, direct_only: true }, token);
        if (res.links && res.links[0]) return res.links[0].url;
      }
      throw err;
    }
  }

  // --- HTTP helpers ---------------------------------------------------------------

  async _api(url, body, token) {
    const tk = token || await this._accessToken();
    return this._fetchJson(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tk}`, 'Content-Type': 'application/json' },
      body: body === null ? 'null' : JSON.stringify(body),
    });
  }

  // content endpoint: binary body, JSON args in a header
  async _content(token, url, args, buf) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Dropbox-API-Arg': JSON.stringify(args),
        'Content-Type': 'application/octet-stream',
      },
      body: buf,
    });
    const text = await res.text();
    if (!res.ok) {
      let msg = text;
      try { const j = JSON.parse(text); msg = j.error_summary || text; } catch { /* raw */ }
      throw new Error(`Dropbox upload: ${msg} (HTTP ${res.status})`);
    }
    return text ? JSON.parse(text) : {};
  }

  async _fetchJson(url, init) {
    const res = await fetch(url, init);
    const text = await res.text();
    if (!res.ok) {
      let msg = text;
      try { const j = JSON.parse(text); msg = j.error_summary || j.error_description || text; } catch { /* raw */ }
      throw new Error(`Dropbox: ${msg} (HTTP ${res.status})`);
    }
    return text ? JSON.parse(text) : {};
  }
}

module.exports = DropboxShare;
