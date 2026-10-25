/* Browser backend: runs the Meetings core directly against a local folder via the File System Access API
 * (Chrome / Edge). Used when the page is served without the Node server, e.g. from GitHub Pages.
 * Nothing is uploaded anywhere: the browser reads and writes the folder you pick.
 * Test mode: ?store=opfs uses the browser's private file system instead of a picked folder.
 */
(function () {
  'use strict';
  const { createCore, httpError } = window.MeetingsCore;
  const DB = 'meetings-dashboard';
  const NAME_RE = /^meetings-backup-\d{4}-\d{2}-\d{2}_\d{6}\.zip$/;
  const DAY_MS = 24 * 60 * 60 * 1000;
  const SKIP_TOP = new Set(['_app', '_backups', 'node_modules']);

  // ---------- handle persistence (IndexedDB) ----------
  function idb(mode, fn) {
    return new Promise((resolve, reject) => {
      const open = indexedDB.open(DB, 1);
      open.onupgradeneeded = () => open.result.createObjectStore('handles');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const tx = open.result.transaction('handles', mode);
        const req = fn(tx.objectStore('handles'));
        tx.oncomplete = () => resolve(req && req.result);
        tx.onerror = () => reject(tx.error);
      };
    });
  }
  const saveHandle = (key, h) => idb('readwrite', (s) => s.put(h, key));
  const loadHandle = (key) => idb('readonly', (s) => s.get(key)).catch(() => undefined);

  async function hasPermission(h, request) {
    if (!h.queryPermission) return true; // OPFS handles
    const opts = { mode: 'readwrite' };
    if ((await h.queryPermission(opts)) === 'granted') return true;
    return request ? (await h.requestPermission(opts)) === 'granted' : false;
  }

  // ---------- store over a FileSystemDirectoryHandle ----------
  const parts = (p) => String(p || '').split('/').filter(Boolean);
  const isNotFound = (e) => e && (e.name === 'NotFoundError' || e.name === 'TypeMismatchError');

  function createStore(rootHandle) {
    async function dir(p, create = false) {
      let d = rootHandle;
      for (const seg of parts(p)) d = await d.getDirectoryHandle(seg, { create });
      return d;
    }
    async function entry(p) {
      const segs = parts(p);
      if (!segs.length) return rootHandle;
      const parent = await dir(segs.slice(0, -1).join('/'));
      const name = segs[segs.length - 1];
      try {
        return await parent.getFileHandle(name);
      } catch (e) {
        if (!isNotFound(e)) throw e;
        return parent.getDirectoryHandle(name);
      }
    }
    async function writeBlob(dirHandle, name, data) {
      const fh = await dirHandle.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      await w.write(data);
      await w.close();
    }
    async function copyInto(src, dstParent, name) {
      if (src.kind === 'file') return writeBlob(dstParent, name, await src.getFile());
      const dst = await dstParent.getDirectoryHandle(name, { create: true });
      for await (const [n, h] of src.entries()) await copyInto(h, dst, n);
    }
    const store = {
      async exists(p) {
        try {
          await entry(p);
          return true;
        } catch (e) {
          if (isNotFound(e)) return false;
          throw e;
        }
      },
      async readText(p) {
        try {
          const h = await entry(p);
          return h.kind === 'file' ? await (await h.getFile()).text() : null;
        } catch (e) {
          if (isNotFound(e)) return null;
          throw e;
        }
      },
      async writeText(p, text) {
        const segs = parts(p);
        await writeBlob(await dir(segs.slice(0, -1).join('/'), true), segs[segs.length - 1], text);
      },
      async list(p) {
        try {
          const d = await dir(p);
          const out = [];
          for await (const [name, h] of d.entries()) out.push({ name, dir: h.kind === 'directory' });
          return out.sort((a, b) => a.name.localeCompare(b.name));
        } catch (e) {
          if (isNotFound(e)) return [];
          throw e;
        }
      },
      async mkdir(p) {
        await dir(p, true);
      },
      // The API has no portable rename: copy, then delete. Case-only renames go via a temporary name.
      async rename(from, to) {
        if (from.toLowerCase() === to.toLowerCase()) {
          const tmp = `${to}.renaming-${Date.now()}`;
          await store.rename(from, tmp);
          return store.rename(tmp, to);
        }
        const src = await entry(from);
        const toSegs = parts(to);
        const dstParent = await dir(toSegs.slice(0, -1).join('/'), true);
        await copyInto(src, dstParent, toSegs[toSegs.length - 1]);
        const fromSegs = parts(from);
        await (await dir(fromSegs.slice(0, -1).join('/'))).removeEntry(fromSegs[fromSegs.length - 1], { recursive: true });
      },
      display: (p) => [rootHandle.name || 'Meetings', ...parts(p)].join('/'),
      handle: rootHandle,
      dir,
    };
    return store;
  }

  // ---------- ZIP (deflate) in the browser ----------
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  async function deflateRaw(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  async function buildZip(entries) {
    const enc = new TextEncoder();
    const chunks = [];
    const central = [];
    let offset = 0;
    for (const { name, data, mtime } of entries) {
      const nameBytes = enc.encode(name);
      const comp = await deflateRaw(data);
      const crc = crc32(data);
      const d = mtime || new Date();
      const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
      const date = ((Math.max(d.getFullYear(), 1980) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
      const local = new DataView(new ArrayBuffer(30));
      [[0, 0x04034b50, 4], [4, 20, 2], [6, 0x0800, 2], [8, 8, 2], [10, time, 2], [12, date, 2], [14, crc, 4], [18, comp.length, 4], [22, data.length, 4], [26, nameBytes.length, 2]].forEach(([o, v, s]) =>
        s === 4 ? local.setUint32(o, v, true) : local.setUint16(o, v, true)
      );
      chunks.push(new Uint8Array(local.buffer), nameBytes, comp);
      const cen = new DataView(new ArrayBuffer(46));
      [[0, 0x02014b50, 4], [4, 20, 2], [6, 20, 2], [8, 0x0800, 2], [10, 8, 2], [12, time, 2], [14, date, 2], [16, crc, 4], [20, comp.length, 4], [24, data.length, 4], [28, nameBytes.length, 2], [42, offset, 4]].forEach(([o, v, s]) =>
        s === 4 ? cen.setUint32(o, v, true) : cen.setUint16(o, v, true)
      );
      central.push(new Uint8Array(cen.buffer), nameBytes);
      offset += 30 + nameBytes.length + comp.length;
    }
    const cenSize = central.reduce((n, c) => n + c.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, entries.length, true);
    end.setUint16(10, entries.length, true);
    end.setUint32(12, cenSize, true);
    end.setUint32(16, offset, true);
    return new Blob([...chunks, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
  }

  // Reads a ZIP via its central directory (works for ZIPs from this app, Windows Explorer, 7-Zip, …).
  async function readZip(blob) {
    const buf = new Uint8Array(await blob.arrayBuffer());
    const dv = new DataView(buf.buffer);
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw httpError(400, 'Not a valid ZIP file');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const dec = new TextDecoder();
    const out = [];
    for (let n = 0; n < count; n++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw httpError(400, 'Corrupt ZIP central directory');
      const method = dv.getUint16(p + 10, true);
      const compSize = dv.getUint32(p + 20, true);
      const nameLen = dv.getUint16(p + 28, true);
      const extraLen = dv.getUint16(p + 30, true);
      const commentLen = dv.getUint16(p + 32, true);
      const localOff = dv.getUint32(p + 42, true);
      const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen)).replace(/\\/g, '/');
      p += 46 + nameLen + extraLen + commentLen;
      if (name.endsWith('/')) continue;
      const start = localOff + 30 + dv.getUint16(localOff + 26, true) + dv.getUint16(localOff + 28, true);
      const raw = buf.subarray(start, start + compSize);
      let data;
      if (method === 0) data = raw;
      else if (method === 8) data = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
      else throw httpError(400, `Unsupported compression in ${name}`);
      out.push({ name, data });
    }
    return out;
  }

  const stamp = (d = new Date()) => {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  };

  // ---------- backend ----------
  function createBackend(rootHandle, backupHandle, kind = 'folder') {
    const store = createStore(rootHandle);
    const core = createCore(store);
    let backupDir = backupHandle || null;

    async function backupDirHandle() {
      return backupDir || store.dir('_backups', true);
    }

    async function loadSettings() {
      const s = await core.readJson('_config/settings.json', {});
      return {
        backupFolder: backupDir ? backupDir.name : kind === 'browser-storage' ? 'Inside this browser — download backups to keep copies elsewhere' : `${store.display('_backups')} (inside the data folder)`,
        backupKeep: Number.isInteger(s.backupKeep) && s.backupKeep > 0 ? s.backupKeep : 30,
        autoBackup: s.autoBackup !== false,
        browserMode: true,
        storageKind: kind,
      };
    }

    async function listBackups() {
      const d = await backupDirHandle();
      const out = [];
      for await (const [name, h] of d.entries()) {
        if (h.kind !== 'file' || !NAME_RE.test(name)) continue;
        const f = await h.getFile();
        out.push({ name, size: f.size, createdAt: new Date(f.lastModified).toISOString() });
      }
      return out.sort((a, b) => b.name.localeCompare(a.name));
    }

    async function status() {
      const backups = await listBackups();
      return { ...(await loadSettings()), backups, lastBackup: backups[0]?.createdAt || '' };
    }

    async function collectFiles(d, rel, out) {
      for await (const [name, h] of d.entries()) {
        if (name.startsWith('.') || name.endsWith('.tmp') || (!rel && SKIP_TOP.has(name))) continue;
        if (backupDir && h.kind === 'directory' && (await h.isSameEntry(backupDir))) continue;
        const r = rel ? `${rel}/${name}` : name;
        if (h.kind === 'directory') await collectFiles(h, r, out);
        else {
          const f = await h.getFile();
          out.push({ name: r, data: new Uint8Array(await f.arrayBuffer()), mtime: new Date(f.lastModified) });
        }
      }
      return out;
    }

    async function runBackup() {
      const files = await collectFiles(rootHandle, '', []);
      const zip = await buildZip(files);
      const d = await backupDirHandle();
      const name = `meetings-backup-${stamp()}.zip`;
      const fh = await d.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      await w.write(zip);
      await w.close();
      const keep = (await loadSettings()).backupKeep;
      for (const old of (await listBackups()).slice(Math.max(1, keep))) await d.removeEntry(old.name);
      return { name, size: zip.size, files: files.length, folder: d.name };
    }

    async function autoBackup() {
      const s = await loadSettings();
      if (!s.autoBackup) return null;
      const last = (await listBackups())[0];
      if (last && Date.now() - new Date(last.createdAt).getTime() < DAY_MS) return null;
      return runBackup();
    }

    async function api(method, url, body) {
      const u = new URL(url, 'http://local');
      const query = Object.fromEntries(u.searchParams);
      const p = u.pathname;
      if (p === '/api/backups' && method === 'GET') return status();
      if (p === '/api/backups' && method === 'POST') return { ...(await runBackup()), status: await status() };
      if (p === '/api/backups/settings' && method === 'PUT') {
        const cur = await core.readJson('_config/settings.json', {});
        if (body.backupKeep !== undefined) {
          const n = Number(body.backupKeep);
          if (!Number.isInteger(n) || n < 1 || n > 365) throw httpError(400, 'Keep must be between 1 and 365');
          cur.backupKeep = n;
        }
        if (body.autoBackup !== undefined) cur.autoBackup = Boolean(body.autoBackup);
        await core.writeJson('_config/settings.json', cur);
        return status();
      }
      if (p === '/api/open-folder') throw httpError(400, 'Opening folders is only available in the desktop (local server) version');
      const r = await core.handle(method, p, query, body);
      if (!r.matched) throw httpError(404, 'Not found');
      return JSON.parse(JSON.stringify(r.result));
    }

    // Returns { blob, filename } for export / backup download links.
    async function download(url) {
      const u = new URL(url, 'http://local');
      if (u.pathname === '/api/export') {
        const out = await core.exportActions(Object.fromEntries(u.searchParams));
        return { blob: new Blob([out.body], { type: out.type }), filename: out.filename };
      }
      const m = u.pathname.match(/^\/api\/backups\/([^/]+)\/download$/);
      if (m) {
        const name = decodeURIComponent(m[1]);
        if (!NAME_RE.test(name)) throw httpError(404, 'Backup not found');
        const fh = await (await backupDirHandle()).getFileHandle(name);
        return { blob: await fh.getFile(), filename: name };
      }
      throw httpError(404, 'Not found');
    }

    async function chooseBackupFolder() {
      const h = await window.showDirectoryPicker({ id: 'meetings-backups', mode: 'readwrite' });
      if (!(await hasPermission(h, true))) throw httpError(403, 'Permission to the backup folder was not granted');
      backupDir = h;
      await saveHandle('backupDir', h);
      return status();
    }

    // Restores / moves data from a backup ZIP (from either version). Backs up the current data first.
    async function importZip(file) {
      const entries = await readZip(file);
      const safe = entries.filter(({ name }) => {
        const segs = name.split('/');
        return name && !name.endsWith('/') && !/^([a-z]:|\/)/i.test(name) && !segs.some((s) => !s || s === '..' || s.startsWith('.')) && !['_app', '_backups', 'node_modules'].includes(segs[0]);
      });
      if (!safe.length) throw httpError(400, 'This ZIP contains no meeting data');
      let backupName = '';
      if ((await store.list('')).some((e) => !['_backups'].includes(e.name))) backupName = (await runBackup()).name;
      for (const { name, data } of safe) {
        const segs = name.split('/');
        const fh = await (await store.dir(segs.slice(0, -1).join('/'), true)).getFileHandle(segs[segs.length - 1], { create: true });
        const w = await fh.createWritable();
        await w.write(data);
        await w.close();
      }
      return { files: safe.length, skipped: entries.length - safe.length, backup: backupName };
    }

    return { api, download, autoBackup, chooseBackupFolder, importZip, name: rootHandle.name, kind, core };
  }

  // ---------- connecting to a folder ----------
  const supported = () => typeof window.showDirectoryPicker === 'function';
  const testMode = () => new URLSearchParams(location.search).get('store') === 'opfs';
  const opfsRoot = async (name) => (await navigator.storage.getDirectory()).getDirectoryHandle(name, { create: true });

  async function restore({ request = false } = {}) {
    if (testMode()) return createBackend(await opfsRoot('meetings-test'), null, 'folder');
    if ((await loadHandle('kind')) === 'browser-storage') return useBrowserStorage();
    const root = await loadHandle('root');
    if (!root || !(await hasPermission(root, request))) return null;
    const backupDir = await loadHandle('backupDir');
    const backupOk = backupDir && (await hasPermission(backupDir, request).catch(() => false));
    return createBackend(root, backupOk ? backupDir : null, 'folder');
  }

  async function choose() {
    const root = await window.showDirectoryPicker({ id: 'meetings-data', mode: 'readwrite' });
    if (!(await hasPermission(root, true))) throw httpError(403, 'Permission to the folder was not granted');
    await saveHandle('root', root);
    await saveHandle('kind', 'folder');
    return restore();
  }

  // Data kept in the browser's private storage (origin private file system). Works where company
  // policy blocks write access to user folders; protected by downloadable backups.
  async function useBrowserStorage() {
    if (navigator.storage.persist) await navigator.storage.persist().catch(() => false);
    await saveHandle('kind', 'browser-storage');
    return createBackend(await opfsRoot('meetings'), null, 'browser-storage');
  }

  async function disconnect() {
    await saveHandle('kind', '');
  }

  async function storedName() {
    if ((await loadHandle('kind')) === 'browser-storage') return '';
    const h = await loadHandle('root');
    return h ? h.name : '';
  }

  // True when the browser / company policy refuses the folder picker (not when the user cancels it).
  const isBlocked = (e) => e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');

  window.MeetingsBrowser = { supported, testMode, restore, choose, useBrowserStorage, disconnect, storedName, isBlocked, buildZip, readZip, crc32 };
})();
