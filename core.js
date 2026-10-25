/* Meetings core: all business logic, independent of where the files live.
 * Used by the Node server (file-system store) and by the browser (File System Access API store).
 *
 * Layout (relative to the data root):
 *   _config/config.json                         people, meeting types, buckets
 *   <Group>/forum.json, <Group>/context.md        person / group definition + background ("forum" internally)
 *   <Group>/<YYYY-MM-DD - Title>/meeting.json    meeting metadata
 *   <Group>/<YYYY-MM-DD - Title>/agenda.md       preparation
 *   <Group>/<YYYY-MM-DD - Title>/minutes.md      minutes (older meetings: notes.md)
 *   <Group>/<YYYY-MM-DD - Title>/actions.json    action items
 *
 * A store implements (all async, paths are relative and use "/"):
 *   exists(p) -> bool, readText(p) -> string|null, writeText(p, text), list(p) -> [{ name, dir }],
 *   mkdir(p), rename(from, to), display(p) -> string shown to the user
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MeetingsCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const ACTION_STATUSES = ['open', 'in-progress', 'waiting', 'done', 'cancelled'];
  const MEETING_STATUSES = ['planned', 'held', 'cancelled'];
  const PRIORITIES = ['low', 'medium', 'high'];
  const ACTION_FIELDS = ['title', 'details', 'ownerId', 'dueDate', 'status', 'priority', 'bucketIds', 'externalRef'];
  const CONFIG_FILE = '_config/config.json';
  const DEFAULT_CONFIG = {
    people: [],
    meetingTypes: [
      { id: 'one-on-one', name: '1:1', description: 'Meeting with a single person' },
      { id: 'team', name: 'Team meeting', description: 'Recurring meeting with a team' },
      { id: 'steering', name: 'Steering committee', description: 'Decision / governance forum' },
    ],
    buckets: [
      { id: 'strategy', name: 'Strategy', category: 'Area', color: '#6f42c1' },
      { id: 'people', name: 'People', category: 'Area', color: '#2f9e44' },
      { id: 'operations', name: 'Operations', category: 'Area', color: '#1c7ed6' },
      { id: 'follow-up', name: 'Follow-up', category: 'Topic', color: '#e8590c' },
    ],
  };

  // ---------- pure helpers ----------
  const newId = () => globalThis.crypto.randomUUID();
  const nowIso = () => new Date().toISOString();
  const localToday = () => new Date().toLocaleDateString('sv-SE');
  const isOpen = (a) => a.status !== 'done' && a.status !== 'cancelled';
  const join = (...parts) => parts.filter((p) => p !== '' && p !== undefined).join('/');

  function httpError(status, message) {
    const e = new Error(message);
    e.status = status;
    return e;
  }

  function safeName(name) {
    return String(name || '')
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[. ]+$/, '')
      .slice(0, 100);
  }

  const isReserved = (name) => !name || name.startsWith('_') || name.startsWith('.') || name === 'node_modules';

  function checkSegment(seg) {
    if (!seg || seg.length > 200 || /[<>:"/\\|?*\x00-\x1f]/.test(seg) || isReserved(seg) || /^\.+$/.test(seg)) {
      throw httpError(400, `Invalid name: ${seg}`);
    }
    return seg;
  }

  function slugId(name, existing) {
    const base = String(name || 'item').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'item';
    let id = base;
    let i = 2;
    while (existing.has(id)) id = `${base}-${i++}`;
    return id;
  }

  function pick(obj, keys) {
    const out = {};
    for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
    return out;
  }

  function normalizeAction(a) {
    return {
      id: a.id || newId(),
      title: String(a.title || '').trim(),
      details: a.details || '',
      ownerId: a.ownerId || '',
      dueDate: a.dueDate || '',
      status: ACTION_STATUSES.includes(a.status) ? a.status : 'open',
      priority: PRIORITIES.includes(a.priority) ? a.priority : 'medium',
      bucketIds: Array.isArray(a.bucketIds) ? a.bucketIds : [],
      externalRef: a.externalRef || '',
      updates: Array.isArray(a.updates) ? a.updates : [],
      createdAt: a.createdAt || nowIso(),
      updatedAt: a.updatedAt || a.createdAt || nowIso(),
      completedAt: a.completedAt || '',
    };
  }

  function filterActions(list, q) {
    const today = localToday();
    return list.filter((a) => {
      if (q.status === 'active' && !isOpen(a)) return false;
      if (q.status && q.status !== 'active' && q.status !== 'all' && a.status !== q.status) return false;
      if (q.forum && a.forum !== q.forum) return false;
      if (q.owner && a.ownerId !== q.owner) return false;
      if (q.bucket && !a.bucketIds.includes(q.bucket)) return false;
      if (q.overdue === '1' && !(isOpen(a) && a.dueDate && a.dueDate < today)) return false;
      if (q.q && !`${a.title} ${a.details}`.toLowerCase().includes(q.q.toLowerCase())) return false;
      return true;
    });
  }

  function toCsv(rows) {
    const cols = ['id', 'title', 'details', 'owner', 'ownerEmail', 'dueDate', 'status', 'priority', 'buckets', 'meetingWith', 'meeting', 'meetingDate', 'externalRef', 'createdAt', 'completedAt'];
    const cell = (v) => {
      const s = Array.isArray(v) ? v.join('; ') : String(v ?? '');
      return /[",\r\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return '\ufeff' + [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\r\n') + '\r\n';
  }

  const meetingFolderName = (date, title) => safeName(`${date} - ${title || 'Meeting'}`);
  const contextTemplate = (name) => `# ${name}\n\n## Purpose\n\n## Background\n\n## Key topics\n`;

  // ---------- store-backed logic ----------
  function createCore(store) {
    async function readJson(p, fallback) {
      const t = await store.readText(p);
      if (t === null) return fallback;
      try {
        return JSON.parse(t);
      } catch {
        return fallback;
      }
    }
    const writeJson = (p, data) => store.writeText(p, JSON.stringify(data, null, 2) + '\n');
    const readText = async (p) => (await store.readText(p)) ?? '';
    const listDirs = async (p) => (await store.list(p)).filter((e) => e.dir && !isReserved(e.name)).map((e) => e.name);

    // config
    async function loadConfig() {
      if (!(await store.exists(CONFIG_FILE))) await writeJson(CONFIG_FILE, DEFAULT_CONFIG);
      const cfg = await readJson(CONFIG_FILE, DEFAULT_CONFIG);
      return {
        people: Array.isArray(cfg.people) ? cfg.people : [],
        meetingTypes: Array.isArray(cfg.meetingTypes) ? cfg.meetingTypes : [],
        buckets: Array.isArray(cfg.buckets) ? cfg.buckets : [],
      };
    }

    async function saveConfig(input) {
      const cfg = {};
      for (const key of ['people', 'meetingTypes', 'buckets']) {
        const list = Array.isArray(input[key]) ? input[key] : [];
        const ids = new Set();
        cfg[key] = list
          .filter((x) => x && String(x.name || '').trim())
          .map((x) => {
            const item = { ...x, name: String(x.name).trim() };
            if (!item.id || ids.has(item.id)) item.id = slugId(item.name, ids);
            ids.add(item.id);
            return item;
          });
      }
      await writeJson(CONFIG_FILE, cfg);
      return cfg;
    }

    // people & groups ("forums")
    async function readForum(name) {
      checkSegment(name);
      if (!(await store.exists(name))) throw httpError(404, `Person / group not found: ${name}`);
      const data = await readJson(join(name, 'forum.json'), {});
      return {
        id: name,
        name,
        typeId: data.typeId || '',
        participantIds: Array.isArray(data.participantIds) ? data.participantIds : [],
        cadence: data.cadence || '',
        description: data.description || '',
        createdAt: data.createdAt || '',
      };
    }

    const writeForumMeta = (name, f) =>
      writeJson(join(checkSegment(name), 'forum.json'), {
        name,
        typeId: f.typeId || '',
        participantIds: Array.isArray(f.participantIds) ? f.participantIds : [],
        cadence: f.cadence || '',
        description: f.description || '',
        createdAt: f.createdAt || nowIso(),
      });

    async function createForum(body) {
      const name = safeName(body.name);
      if (!name || isReserved(name)) throw httpError(400, 'Name is required (cannot start with "_" or ".")');
      if (await store.exists(name)) throw httpError(409, `A folder named "${name}" already exists`);
      await store.mkdir(name);
      await writeForumMeta(name, { ...body, createdAt: nowIso() });
      await store.writeText(join(name, 'context.md'), body.context || contextTemplate(name));
      return readForum(name);
    }

    async function updateForum(name, body) {
      const current = await readForum(name);
      let target = name;
      if (body.name !== undefined) {
        const newName = safeName(body.name);
        if (!newName || isReserved(newName)) throw httpError(400, 'Invalid name');
        if (newName !== name) {
          if (newName.toLowerCase() !== name.toLowerCase() && (await store.exists(newName))) throw httpError(409, `A folder named "${newName}" already exists`);
          await store.rename(name, newName);
          target = newName;
        }
      }
      await writeForumMeta(target, { ...current, ...pick(body, ['typeId', 'participantIds', 'cadence', 'description']) });
      if (typeof body.context === 'string') await store.writeText(join(target, 'context.md'), body.context);
      else if (!(await store.exists(join(target, 'context.md')))) await store.writeText(join(target, 'context.md'), contextTemplate(target));
      return readForum(target);
    }

    async function archiveForum(name) {
      checkSegment(name);
      if (!(await store.exists(name))) throw httpError(404, 'Person / group not found');
      await store.mkdir('_archive');
      await store.rename(name, join('_archive', `${name} (${new Date().toISOString().replace(/[:.]/g, '-')})`));
    }

    // meetings
    const isMeetingFolder = async (forum, name) => /^\d{4}-\d{2}-\d{2}/.test(name) || store.exists(join(forum, name, 'meeting.json'));

    async function meetingFolders(forum) {
      const out = [];
      for (const n of await listDirs(forum)) if (await isMeetingFolder(forum, n)) out.push(n);
      return out;
    }

    async function readActions(forum, meeting) {
      const list = await readJson(join(forum, meeting, 'actions.json'), []);
      return (Array.isArray(list) ? list : []).map(normalizeAction);
    }

    async function readMeeting(forum, folder, { full = false } = {}) {
      checkSegment(forum);
      checkSegment(folder);
      const dir = join(forum, folder);
      if (!(await store.exists(dir))) throw httpError(404, `Meeting not found: ${folder}`);
      const meta = await readJson(join(dir, 'meeting.json'), {});
      const m = {
        id: folder,
        forum,
        title: meta.title || folder.replace(/^\d{4}-\d{2}-\d{2}\s*-?\s*/, '') || folder,
        date: meta.date || (folder.match(/^(\d{4}-\d{2}-\d{2})/) || [])[1] || '',
        time: meta.time || '',
        status: meta.status || 'planned',
        attendeeIds: Array.isArray(meta.attendeeIds) ? meta.attendeeIds : [],
        createdAt: meta.createdAt || '',
        actions: await readActions(forum, folder),
      };
      if (full) {
        m.agenda = await readText(join(dir, 'agenda.md'));
        const hasMinutes = await store.exists(join(dir, 'minutes.md'));
        m.minutes = await readText(join(dir, hasMinutes ? 'minutes.md' : 'notes.md'));
        const internal = ['meeting.json', 'agenda.md', 'minutes.md', 'actions.json', ...(hasMinutes ? [] : ['notes.md'])];
        m.files = (await store.list(dir)).filter((e) => !internal.includes(e.name) && !e.name.endsWith('.tmp')).map((e) => (e.dir ? e.name + '/' : e.name));
        m.folder = store.display(dir);
      }
      return m;
    }

    async function listMeetings(forum) {
      checkSegment(forum);
      const list = [];
      for (const f of await meetingFolders(forum)) list.push(await readMeeting(forum, f));
      return list.sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));
    }

    const writeMeetingMeta = (forum, folder, m) =>
      writeJson(join(forum, folder, 'meeting.json'), {
        title: m.title,
        date: m.date,
        time: m.time || '',
        status: MEETING_STATUSES.includes(m.status) ? m.status : 'planned',
        attendeeIds: Array.isArray(m.attendeeIds) ? m.attendeeIds : [],
        createdAt: m.createdAt || nowIso(),
      });

    async function buildMinutesTemplate(title, date, attendeeIds) {
      const people = new Map((await loadConfig()).people.map((p) => [p.id, p.name]));
      const attendees = attendeeIds.map((id) => `- ${people.get(id) || id}`);
      return [`# Minutes - ${title} (${date})`, '', '## Attendees', '', ...(attendees.length ? attendees : ['- ']), '', '## Discussion', '', '- ', '', '## Decisions', '', '- ', '', '## Actions', '', '_Log action items in the Actions panel so they can be tracked and exported._', ''].join('\n');
    }

    async function buildAgendaTemplate(forum, title, date) {
      const people = new Map((await loadConfig()).people.map((p) => [p.id, p.name]));
      const open = (await allActions()).filter((a) => a.forum === forum && isOpen(a));
      const lines = [`# Preparation - ${title} (${date})`, '', '## Goals', '', '- ', '', '## Agenda', '', '1. Review open actions', '2. ', '', '## Open actions carried over', ''];
      if (!open.length) lines.push('_None_');
      for (const a of open) lines.push(`- [ ] ${a.title} (${people.get(a.ownerId) || 'unassigned'}${a.dueDate ? ', due ' + a.dueDate : ''}) - ${a.status}`);
      lines.push('', '## Questions / points to raise', '', '- ', '');
      return lines.join('\n');
    }

    async function createMeeting(forum, body) {
      const f = await readForum(forum);
      const date = /^\d{4}-\d{2}-\d{2}$/.test(body.date || '') ? body.date : localToday();
      const title = String(body.title || '').trim() || f.name;
      let folder = meetingFolderName(date, title);
      for (let i = 2; await store.exists(join(forum, folder)); i++) folder = meetingFolderName(date, `${title} (${i})`);
      const agenda = await buildAgendaTemplate(forum, title, date);
      const attendeeIds = Array.isArray(body.attendeeIds) ? body.attendeeIds : f.participantIds;
      await store.mkdir(join(forum, folder));
      await writeMeetingMeta(forum, folder, { title, date, time: body.time, status: 'planned', attendeeIds, createdAt: nowIso() });
      await store.writeText(join(forum, folder, 'agenda.md'), agenda);
      await store.writeText(join(forum, folder, 'minutes.md'), await buildMinutesTemplate(title, date, attendeeIds));
      await writeJson(join(forum, folder, 'actions.json'), []);
      return readMeeting(forum, folder, { full: true });
    }

    async function updateMeeting(forum, folder, body) {
      const current = await readMeeting(forum, folder);
      const next = { ...current, ...pick(body, ['title', 'date', 'time', 'status', 'attendeeIds']) };
      next.title = String(next.title || '').trim() || current.title;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(next.date || '')) throw httpError(400, 'Invalid date');
      let target = folder;
      const desired = meetingFolderName(next.date, next.title);
      if (desired !== folder && !isReserved(desired) && (desired.toLowerCase() === folder.toLowerCase() || !(await store.exists(join(forum, desired))))) {
        await store.rename(join(forum, folder), join(forum, desired));
        target = desired;
      }
      await writeMeetingMeta(forum, target, next);
      if (typeof body.agenda === 'string') await store.writeText(join(forum, target, 'agenda.md'), body.agenda);
      const minutes = typeof body.minutes === 'string' ? body.minutes : body.notes;
      if (typeof minutes === 'string') await store.writeText(join(forum, target, 'minutes.md'), minutes);
      return readMeeting(forum, target, { full: true });
    }

    async function archiveMeeting(forum, folder) {
      checkSegment(forum);
      checkSegment(folder);
      if (!(await store.exists(join(forum, folder)))) throw httpError(404, 'Meeting not found');
      await store.mkdir(join(forum, '_archive'));
      await store.rename(join(forum, folder), join(forum, '_archive', `${folder} (${Date.now()})`));
    }

    // actions
    async function allActions() {
      const out = [];
      for (const forum of await listDirs('')) {
        for (const meeting of await meetingFolders(forum)) {
          const meta = await readJson(join(forum, meeting, 'meeting.json'), {});
          const date = meta.date || (meeting.match(/^(\d{4}-\d{2}-\d{2})/) || [])[1] || '';
          for (const a of await readActions(forum, meeting)) out.push({ ...a, forum, meeting, meetingTitle: meta.title || meeting, meetingDate: date });
        }
      }
      return out;
    }

    async function findAction(id) {
      for (const forum of await listDirs('')) {
        for (const meeting of await meetingFolders(forum)) {
          const list = await readActions(forum, meeting);
          const idx = list.findIndex((a) => a.id === id);
          if (idx >= 0) return { forum, meeting, list, idx };
        }
      }
      throw httpError(404, 'Action not found');
    }

    async function createAction(forum, meeting, body) {
      if (!String(body.title || '').trim()) throw httpError(400, 'Title is required');
      await readMeeting(forum, meeting);
      const list = await readActions(forum, meeting);
      const a = normalizeAction({ ...pick(body, ACTION_FIELDS), id: newId(), createdAt: nowIso() });
      if (a.status === 'done') a.completedAt = nowIso();
      list.push(a);
      await writeJson(join(forum, meeting, 'actions.json'), list);
      return a;
    }

    async function updateAction(id, body) {
      const { forum, meeting, list, idx } = await findAction(id);
      const prev = list[idx];
      const next = normalizeAction({ ...prev, ...pick(body, ACTION_FIELDS), updatedAt: nowIso() });
      if (!next.title) throw httpError(400, 'Title is required');
      if (next.status === 'done' && prev.status !== 'done') next.completedAt = nowIso();
      if (next.status !== 'done') next.completedAt = '';
      if (prev.status !== next.status) next.updates = [...next.updates, { at: nowIso(), text: `Status: ${prev.status} -> ${next.status}` }];
      if (typeof body.note === 'string' && body.note.trim()) next.updates = [...next.updates, { at: nowIso(), text: body.note.trim() }];
      list[idx] = next;
      await writeJson(join(forum, meeting, 'actions.json'), list);
      return next;
    }

    async function deleteAction(id) {
      const { forum, meeting, list, idx } = await findAction(id);
      list.splice(idx, 1);
      await writeJson(join(forum, meeting, 'actions.json'), list);
    }

    // export
    async function enrichForExport(list) {
      const cfg = await loadConfig();
      const people = new Map(cfg.people.map((p) => [p.id, p]));
      const buckets = new Map(cfg.buckets.map((b) => [b.id, b]));
      return list.map((a) => ({
        id: a.id,
        title: a.title,
        details: a.details,
        owner: people.get(a.ownerId)?.name || '',
        ownerEmail: people.get(a.ownerId)?.email || '',
        dueDate: a.dueDate,
        status: a.status,
        priority: a.priority,
        buckets: a.bucketIds.map((id) => buckets.get(id)?.name || id),
        meetingWith: a.forum,
        meeting: a.meetingTitle,
        meetingDate: a.meetingDate,
        externalRef: a.externalRef,
        createdAt: a.createdAt,
        completedAt: a.completedAt,
      }));
    }

    async function exportActions(q) {
      const rows = await enrichForExport(filterActions(await allActions(), q));
      const stamp = localToday();
      return q.format === 'json'
        ? { body: JSON.stringify(rows, null, 2), type: 'application/json; charset=utf-8', filename: `actions-${stamp}.json` }
        : { body: toCsv(rows), type: 'text/csv; charset=utf-8', filename: `actions-${stamp}.csv` };
    }

    // overview
    async function overview() {
      const cfg = await loadConfig();
      const today = localToday();
      const meetings = [];
      const forums = [];
      for (const name of await listDirs('')) {
        const f = await readForum(name);
        const list = await listMeetings(name);
        const upcoming = list.filter((m) => m.status === 'planned' && m.date >= today).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
        const past = list.filter((m) => m.status === 'held' || (m.status !== 'cancelled' && m.date < today));
        const actions = list.flatMap((m) => m.actions);
        for (const m of list) meetings.push({ ...pick(m, ['id', 'forum', 'title', 'date', 'time', 'status', 'attendeeIds']), openActions: m.actions.filter(isOpen).length, totalActions: m.actions.length });
        forums.push({
          ...f,
          meetingCount: list.length,
          nextMeeting: upcoming[0] ? pick(upcoming[0], ['id', 'title', 'date', 'time']) : null,
          lastMeeting: past[0] ? pick(past[0], ['id', 'title', 'date']) : null,
          openActions: actions.filter(isOpen).length,
          totalActions: actions.length,
        });
      }
      return { config: cfg, forums, meetings, actions: await allActions(), root: store.display('') };
    }

    async function forumDetail(f) {
      return { ...(await readForum(f)), context: await readText(join(f, 'context.md')), folder: store.display(f), meetings: await listMeetings(f) };
    }

    // routing shared by the HTTP server and the in-browser backend
    const routes = [];
    const route = (method, pattern, handler) => routes.push({ method, re: new RegExp(`^${pattern}$`), handler });
    route('GET', '/api/overview', () => overview());
    route('GET', '/api/config', () => loadConfig());
    route('PUT', '/api/config', (_p, body) => saveConfig(body));
    route('POST', '/api/forums', (_p, body) => createForum(body));
    route('GET', '/api/forums/([^/]+)', ([f]) => forumDetail(f));
    route('PUT', '/api/forums/([^/]+)', ([f], body) => updateForum(f, body));
    route('DELETE', '/api/forums/([^/]+)', async ([f]) => (await archiveForum(f), { ok: true }));
    route('POST', '/api/forums/([^/]+)/meetings', ([f], body) => createMeeting(f, body));
    route('GET', '/api/forums/([^/]+)/meetings/([^/]+)', ([f, m]) => readMeeting(f, m, { full: true }));
    route('PUT', '/api/forums/([^/]+)/meetings/([^/]+)', ([f, m], body) => updateMeeting(f, m, body));
    route('DELETE', '/api/forums/([^/]+)/meetings/([^/]+)', async ([f, m]) => (await archiveMeeting(f, m), { ok: true }));
    route('POST', '/api/forums/([^/]+)/meetings/([^/]+)/actions', ([f, m], body) => createAction(f, m, body));
    route('GET', '/api/actions', (_p, _b, q) => allActions().then((list) => filterActions(list, q)));
    route('PATCH', '/api/actions/([^/]+)', ([id], body) => updateAction(id, body));
    route('DELETE', '/api/actions/([^/]+)', async ([id]) => (await deleteAction(id), { ok: true }));

    // Returns { matched: false } when no core route handles the request.
    async function handle(method, pathname, query = {}, body = {}) {
      for (const r of routes) {
        if (r.method !== method) continue;
        const m = pathname.match(r.re);
        if (!m) continue;
        const params = m.slice(1).map((s) => decodeURIComponent(s));
        return { matched: true, result: await r.handler(params, body || {}, query) };
      }
      return { matched: false };
    }

    return { handle, loadConfig, saveConfig, overview, allActions, exportActions, readJson, writeJson, checkSegment, readForum, readMeeting };
  }

  return { createCore, safeName, checkSegment, isReserved, httpError, toCsv, filterActions, localToday, DEFAULT_CONFIG };
});
