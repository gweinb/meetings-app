'use strict';

// ---------- utilities ----------
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const enc = encodeURIComponent;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const todayStr = () => new Date().toLocaleDateString('sv-SE');
const addDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toLocaleDateString('sv-SE'); };
const parseDate = (d) => new Date(d + 'T00:00:00');
const fmtDate = (d) => (d ? parseDate(d).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) : '');
const fmtShort = (d) => (d ? parseDate(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '');
const fmtDateTime = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');

const ACTION_STATUSES = ['open', 'in-progress', 'waiting', 'done', 'cancelled'];
const ADHOC_GROUP = 'Ad-hoc';
const MEETING_STATUSES = ['planned', 'held', 'cancelled'];
const PRIORITIES = ['high', 'medium', 'low'];
const isOpen = (a) => a.status !== 'done' && a.status !== 'cancelled';
const isOverdue = (a) => isOpen(a) && a.dueDate && a.dueDate < todayStr();
// One consistent "how are this meeting's actions doing" line: total, open, overdue, done.
function actionSummary(list, { emptyText = 'No actions' } = {}) {
  if (!list.length) return `<span class="action-summary muted" data-action-summary="0">${esc(emptyText)}</span>`;
  const open = list.filter(isOpen).length;
  const overdue = list.filter(isOverdue).length;
  const done = list.filter((a) => a.status === 'done').length;
  const pill = (cls, text, key) => `<span class="as-pill ${cls}" data-as="${key}">${text}</span>`;
  return `<span class="action-summary" data-action-summary="${list.length}">${pill('as-total', `📌 ${list.length} action${list.length > 1 ? 's' : ''}`, 'total')}${open ? pill('as-open', `${open} open`, 'open') : ''}${overdue ? pill('as-overdue', `⚠ ${overdue} overdue`, 'overdue') : ''}${done ? pill('as-done', `✓ ${done} done`, 'done') : ''}</span>`;
}
const DEFAULT_FILTERS = { status: 'active', forum: '', owner: '', bucket: '', overdue: false, q: '' };

const S = { config: { people: [], meetingTypes: [], buckets: [] }, forums: [], meetings: [], actions: [], root: '' };
const UI = { actionFilters: { ...DEFAULT_FILTERS }, adminTab: 'people', meetingTab: 'agenda', meetingTabFor: '', meetingsFilter: { when: 'upcoming', forum: '' }, preview: false, showClosed: false };
let pendingSave = null;

// The app runs on GitHub Pages and works with the local Meetings service on this computer, which owns
// the database (meetings.db). Every request carries the session from the password sign-in.
const API_BASE = localStorage.getItem('meetings-api-base') || 'http://127.0.0.1:4317';
const TOKEN_KEY = 'meetings-token';
const getToken = () => localStorage.getItem(TOKEN_KEY) || '';

class AuthError extends Error {}

async function apiFetch(url, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  let res;
  try {
    // targetAddressSpace lets Chrome ask for "local network access" instead of failing.
    res = await fetch(API_BASE + url, { ...opts, headers, targetAddressSpace: 'loopback' });
  } catch {
    throw new AuthError('offline');
  }
  if (res.status === 401 && !/^\/api\/auth\/(login|setup|password)/.test(url)) {
    localStorage.removeItem(TOKEN_KEY);
    throw new AuthError('login');
  }
  return res;
}

async function api(method, url, body) {
  // Writes always send JSON: the server rejects other content types (cross-site protection).
  if (body === undefined && ['POST', 'PUT', 'PATCH'].includes(method)) body = {};
  const res = await apiFetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (isError ? ' error' : '');
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), isError ? 5000 : 2200);
}

async function guarded(fn) {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof AuthError) return renderGate(e.message);
    toast(e.message, true);
  }
}

const person = (id) => S.config.people.find((p) => p.id === id);
const bucket = (id) => S.config.buckets.find((b) => b.id === id);
const mtype = (id) => S.config.meetingTypes.find((t) => t.id === id);
const personName = (id) => person(id)?.name || '';
const forumHref = (f) => `#/group/${enc(f)}`;
const meetingHref = (f, m) => `#/meeting/${enc(f)}/${enc(m)}`;

// ---------- presentation helpers ----------
function hue(str) {
  let h = 0;
  for (const c of String(str)) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}
const initials = (name) => String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
const avatar = (id, name) => `<span class="avatar" style="background:hsl(${hue(id)} 55% 48%)" title="${esc(name)}">${esc(initials(name))}</span>`;
const personTag = (id) => {
  const name = personName(id) || id;
  return `<span class="person">${avatar(id, name)}${esc(name)}</span>`;
};
const peopleList = (ids) => (ids || []).map(personTag).join('') || '<span class="muted small">No participants</span>';
// Meeting attendees: you, plus the chosen attendees; without attendees, the person / group the meeting is with (e.g. a 1:1).
function attendeeNames(forumName, attendeeIds) {
  const others = attendeeIds?.length ? attendeeIds.map((id) => personName(id) || id) : forumName.toLowerCase() === ADHOC_GROUP.toLowerCase() ? [] : [forumName];
  return [...new Set([S.config.myName || '', ...others].filter(Boolean))];
}
const attendeeTags = (names) => names.map((n) => `<span class="person">${avatar(n, n)}${esc(n)}</span>`).join('');
// Fills an "## Attendees" section that is still empty (only blanks or "-") with the attendee names.
function withAttendees(md, names) {
  return String(md || '').replace(/(^|\n)(##\s*Attendees[^\n]*\n)((?:[ \t]*-?[ \t]*(?:\n|$))*)(?=##|$)/i, (all, pre, head, body) =>
    names.length ? `${pre}${head}\n${names.map((n) => `- ${n}`).join('\n')}\n\n` : all);
}

function bucketChips(ids) {
  return (ids || [])
    .map((id) => {
      const b = bucket(id);
      const color = b?.color || '#94a3b8';
      return `<span class="chip"><span class="dot" style="background:${esc(color)}"></span>${esc(b?.name || id)}</span>`;
    })
    .join('');
}

const statusBadge = (s) => `<span class="status ${esc(s)}">${esc(s.replace('-', ' '))}</span>`;
const dateBadge = (d) => {
  if (!d) return '<div class="date-badge"><div class="m">—</div><div class="d">?</div></div>';
  const dt = parseDate(d);
  return `<div class="date-badge"><div class="m">${esc(dt.toLocaleDateString(undefined, { month: 'short' }))}</div><div class="d">${dt.getDate()}</div></div>`;
};
const emptyState = (html) => `<div class="empty">${html}</div>`;
const fmtSize = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

// Uploads files into the meeting (stored in the database). The server accepts raw bytes only as application/octet-stream.
async function uploadFiles(forum, meeting, files) {
  for (const file of files) {
    const res = await apiFetch(`/api/forums/${enc(forum)}/meetings/${enc(meeting)}/attachments?name=${enc(file.name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-File-Type': file.type || 'application/octet-stream' },
      body: file,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${file.name}: ${data.error || `upload failed (${res.status})`}`);
  }
}

const options = (list, selected, { blank } = {}) =>
  (blank !== undefined ? `<option value="">${esc(blank)}</option>` : '') +
  list.map((o) => {
    const [value, label] = typeof o === 'string' ? [o, o] : [o.id, o.name];
    return `<option value="${esc(value)}" ${value === selected ? 'selected' : ''}>${esc(label)}</option>`;
  }).join('');

const checkboxes = (name, list, selected) =>
  list.length
    ? `<div class="checks">${list.map((o) => `<label><input type="checkbox" name="${name}" value="${esc(o.id)}" ${selected.includes(o.id) ? 'checked' : ''}/> ${esc(o.name)}</label>`).join('')}</div>`
    : emptyState('None defined yet — add them in <a href="#/admin">Admin</a>.');

const checkedValues = (root, name) => $$(`input[name="${name}"]:checked`, root).map((i) => i.value);

// Attendee picker: checkboxes for known people plus an inline field to add someone new.
const peoplePicker = (name, selected) => `<div class="checks" data-picker="${name}">
    ${S.config.people.map((o) => `<label><input type="checkbox" name="${name}" value="${esc(o.id)}" ${selected.includes(o.id) ? 'checked' : ''}/> ${esc(o.name)}</label>`).join('')}
    <span class="add-person"><input data-add-person="${name}" placeholder="${S.config.people.length ? '+ Add person' : 'Type a name + Enter'}" aria-label="Add person" /></span>
  </div>`;

async function addPersonInline(input) {
  const name = input.value.trim();
  if (!name) return;
  const picker = input.closest('[data-picker]');
  const fieldName = picker.dataset.picker;
  let p = S.config.people.find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (!p) {
    S.config = await api('PUT', '/api/config', { ...S.config, people: [...S.config.people, { name }] });
    p = S.config.people.find((x) => x.name === name);
    toast(`Added ${name} to people`);
  }
  let box = $(`input[name="${fieldName}"][value="${CSS.escape(p.id)}"]`, picker);
  if (!box) {
    const label = document.createElement('label');
    label.innerHTML = `<input type="checkbox" name="${fieldName}" value="${esc(p.id)}" /> ${esc(p.name)}`;
    picker.insertBefore(label, input.closest('.add-person'));
    box = $('input', label);
  }
  box.checked = true;
  input.value = '';
  input.placeholder = '+ Add person';
}

function bindPeoplePickers(root) {
  $$('[data-add-person]', root).forEach((input) =>
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      guarded(() => addPersonInline(input));
    })
  );
}

// Minimal, safe Markdown renderer (input is escaped first).
function markdown(src) {
  const inline = (s) =>
    esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
      .replace(/(^|\W)_([^_]+)_(?=\W|$)/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\(((?:https?:|mailto:)[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  const out = [];
  let list = null;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const line of String(src || '').split(/\r?\n/)) {
    let m;
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      closeList();
      const n = Math.min(m[1].length, 3);
      out.push(`<h${n}>${inline(m[2])}</h${n}>`);
    } else if ((m = line.match(/^\s*[-*]\s+\[( |x|X)\]\s*(.*)$/))) {
      if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
      out.push(`<li class="task"><input type="checkbox" disabled ${m[1] !== ' ' ? 'checked' : ''}/> ${inline(m[2])}</li>`);
    } else if ((m = line.match(/^\s*[-*]\s+(.*)$/))) {
      if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
      out.push(`<li>${inline(m[1])}</li>`);
    } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; }
      out.push(`<li>${inline(m[1])}</li>`);
    } else if (!line.trim()) {
      closeList();
    } else {
      closeList();
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  closeList();
  return out.join('\n') || '<p class="muted">Nothing written yet.</p>';
}

function sortActions(list) {
  const prio = { high: 0, medium: 1, low: 2 };
  return [...list].sort((a, b) => {
    if (isOpen(a) !== isOpen(b)) return isOpen(a) ? -1 : 1;
    const da = a.dueDate || '9999';
    const db = b.dueDate || '9999';
    if (da !== db) return da.localeCompare(db);
    return (prio[a.priority] ?? 1) - (prio[b.priority] ?? 1);
  });
}

// ---------- action table + dialogs ----------
function actionTable(list, { showForum = true, showMeeting = true, compact = false, empty = 'No action items.' } = {}) {
  if (!list.length) return emptyState(esc(empty));
  if (compact) {
    // Narrow panels: owner / due / priority under the title, status always visible.
    const rows = sortActions(list)
      .map((a) => `
      <tr class="${isOverdue(a) ? 'overdue' : ''} ${isOpen(a) ? '' : 'closed'}" data-row="${esc(a.id)}">
        <td class="title"><a href="#" data-edit="${esc(a.id)}">${esc(a.title)}</a>
          <div class="action-meta">${a.ownerId ? personTag(a.ownerId) : '<span class="muted">unassigned</span>'}
            <span class="due ${isOverdue(a) ? 'overdue-text' : ''}">${a.dueDate ? `${isOverdue(a) ? '⚠ ' : ''}due ${esc(fmtShort(a.dueDate))}` : ''}</span>
            <span class="prio prio-${esc(a.priority)}">${esc(a.priority)}</span>
            ${showMeeting ? `<span class="muted">from <a href="${meetingHref(a.forum, a.meeting)}">${esc(fmtShort(a.meetingDate))}</a></span>` : ''}</div>
          ${a.bucketIds.length ? `<div>${bucketChips(a.bucketIds)}</div>` : ''}</td>
        <td style="width:1%"><select data-status="${esc(a.id)}" aria-label="Status">${options(ACTION_STATUSES, a.status)}</select></td>
      </tr>`)
      .join('');
    return `<table class="compact"><tbody>${rows}</tbody></table>`;
  }
  const rows = sortActions(list)
    .map((a) => `
      <tr class="${isOverdue(a) ? 'overdue' : ''} ${isOpen(a) ? '' : 'closed'}" data-row="${esc(a.id)}">
        <td class="title"><a href="#" data-edit="${esc(a.id)}">${esc(a.title)}</a>
          ${a.details ? `<div class="muted small">${esc(a.details.slice(0, 140))}${a.details.length > 140 ? '…' : ''}</div>` : ''}
          ${a.bucketIds.length ? `<div>${bucketChips(a.bucketIds)}</div>` : ''}</td>
        <td>${a.ownerId ? personTag(a.ownerId) : '<span class="muted">—</span>'}</td>
        <td class="due">${a.dueDate ? esc(fmtShort(a.dueDate)) : '<span class="muted">—</span>'}</td>
        <td><span class="prio prio-${esc(a.priority)}">${esc(a.priority)}</span></td>
        <td><select data-status="${esc(a.id)}" aria-label="Status">${options(ACTION_STATUSES, a.status)}</select></td>
        ${showForum ? `<td><a href="${forumHref(a.forum)}">${esc(a.forum)}</a></td>` : ''}
        ${showMeeting ? `<td><a href="${meetingHref(a.forum, a.meeting)}">${esc(fmtShort(a.meetingDate))}</a><div class="muted small">${esc(a.meetingTitle)}</div></td>` : ''}
      </tr>`)
    .join('');
  return `<table><thead><tr><th>Action</th><th>Owner</th><th>Due</th><th>Priority</th><th>Status</th>${showForum ? '<th>With</th>' : ''}${showMeeting ? '<th>From meeting</th>' : ''}</tr></thead><tbody>${rows}</tbody></table>`;
}

function bindActionTable(root, list, onChange) {
  $$('[data-status]', root).forEach((sel) =>
    sel.addEventListener('change', () =>
      guarded(async () => {
        await api('PATCH', `/api/actions/${enc(sel.dataset.status)}`, { status: sel.value });
        toast('Status updated');
        await onChange();
      })
    )
  );
  $$('[data-edit]', root).forEach((a) =>
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const action = list.find((x) => x.id === a.dataset.edit);
      openActionDialog({ action, onSaved: onChange });
    })
  );
}

function openDialog(html, bind) {
  const dlg = $('#dialog');
  const form = $('#dialog-form');
  form.innerHTML = html;
  form.onsubmit = null;
  const close = () => dlg.close();
  $$('[data-close]', form).forEach((b) => b.addEventListener('click', close));
  $$('a[href^="#"]', form).forEach((a) => a.addEventListener('click', close));
  bindPeoplePickers(form);
  bind(form, close);
  dlg.showModal();
  $('input:not([type=checkbox]), textarea, select', form)?.focus();
}

function openActionDialog({ action, forum, meeting, defaults = {}, onSaved }) {
  const a = action || { title: '', details: '', ownerId: '', dueDate: '', status: 'open', priority: 'medium', bucketIds: [], externalRef: '', updates: [], ...defaults };
  const isNew = !action;
  const bucketsByCat = S.config.buckets.reduce((acc, b) => ((acc[b.category || 'Other'] ||= []).push(b), acc), {});
  openDialog(
    `<h2>${isNew ? 'New action item' : 'Edit action item'}</h2>
     ${!isNew ? `<div class="muted small" style="margin:-.4rem 0 .9rem">From <a href="${meetingHref(a.forum, a.meeting)}">${esc(a.forum)} · ${esc(fmtShort(a.meetingDate))} ${esc(a.meetingTitle)}</a></div>` : ''}
     <div class="field"><label>Title *</label><input name="title" value="${esc(a.title)}" required /></div>
     <div class="field"><label>Details</label><textarea class="short" name="details">${esc(a.details)}</textarea></div>
     <div class="row">
       <div class="field"><label>Owner</label><select name="ownerId">${options(S.config.people, a.ownerId, { blank: '— unassigned —' })}</select></div>
       <div class="field"><label>Due date</label><input type="date" name="dueDate" value="${esc(a.dueDate)}" /></div>
     </div>
     <div class="row">
       <div class="field"><label>Status</label><select name="status">${options(ACTION_STATUSES, a.status)}</select></div>
       <div class="field"><label>Priority</label><select name="priority">${options(PRIORITIES, a.priority)}</select></div>
       <div class="field"><label>External ref (task tool ID)</label><input name="externalRef" value="${esc(a.externalRef)}" /></div>
     </div>
     <div class="field"><label>Buckets / topics / areas</label>
       ${Object.keys(bucketsByCat).length ? Object.entries(bucketsByCat).map(([cat, list]) => `<div class="muted small" style="margin:.35rem 0 .1rem">${esc(cat)}</div>${checkboxes('bucketIds', list, a.bucketIds)}`).join('') : checkboxes('bucketIds', [], [])}
     </div>
     ${!isNew ? `
       <div class="field"><label>Add follow-up note</label><input name="note" placeholder="e.g. Discussed with Larry, waiting on budget" /></div>
       ${a.updates?.length ? `<label>History</label><div class="history">${a.updates.slice().reverse().map((u) => `<div><span class="muted">${esc(fmtDateTime(u.at))}</span> — ${esc(u.text)}</div>`).join('')}</div>` : ''}` : ''}
     <div class="dialog-actions">
       ${!isNew ? '<button type="button" class="danger" data-delete style="margin-right:auto">Delete</button>' : ''}
       <button type="button" data-close>Cancel</button>
       <button type="submit" class="primary">${isNew ? 'Add action' : 'Save'}</button>
     </div>`,
    (form, close) => {
      form.onsubmit = (e) => {
        e.preventDefault();
        const body = {
          title: form.elements.title.value.trim(),
          details: form.elements.details.value,
          ownerId: form.elements.ownerId.value,
          dueDate: form.elements.dueDate.value,
          status: form.elements.status.value,
          priority: form.elements.priority.value,
          externalRef: form.elements.externalRef.value.trim(),
          bucketIds: checkedValues(form, 'bucketIds'),
        };
        if (!body.title) return toast('Title is required', true);
        if (form.elements.note) body.note = form.elements.note.value;
        guarded(async () => {
          if (isNew) await api('POST', `/api/forums/${enc(forum)}/meetings/${enc(meeting)}/actions`, body);
          else await api('PATCH', `/api/actions/${enc(a.id)}`, body);
          close();
          toast(isNew ? 'Action added' : 'Action saved');
          await onSaved?.();
        });
      };
      $('[data-delete]', form)?.addEventListener('click', () => {
        if (!confirm(`Delete action "${a.title}"?`)) return;
        guarded(async () => {
          await api('DELETE', `/api/actions/${enc(a.id)}`);
          close();
          toast('Action deleted');
          await onSaved?.();
        });
      });
    }
  );
}

function openForumDialog(forum) {
  const f = forum || { name: '', typeId: '', participantIds: [], cadence: '', description: '' };
  const isNew = !forum;
  openDialog(
    `<h2>${isNew ? 'New person / group' : 'Edit person / group'}</h2>
     <p class="muted small" style="margin-top:-.4rem">Someone you meet with: one person (e.g. a 1:1 with Larry) or a group (e.g. Leadership Team). It keeps background info and all meetings with them.</p>
     <div class="field"><label>Name (also the folder name) *</label><input name="name" value="${esc(f.name)}" required placeholder="e.g. Larry, Leadership Team" /></div>
     <div class="row">
       <div class="field"><label>Meeting type</label><select name="typeId">${options(S.config.meetingTypes, f.typeId, { blank: '— none —' })}</select></div>
       <div class="field"><label>How often</label><input name="cadence" value="${esc(f.cadence)}" placeholder="e.g. Weekly, Bi-weekly Tue" /></div>
     </div>
     <div class="field"><label>Who attends (default attendees)</label>${peoplePicker('participantIds', f.participantIds)}</div>
     <div class="field"><label>Short description</label><textarea class="short" name="description">${esc(f.description)}</textarea></div>
     <div class="dialog-actions">
       <button type="button" data-close>Cancel</button>
       <button type="submit" class="primary">${isNew ? 'Create' : 'Save'}</button>
     </div>`,
    (form, close) => {
      form.onsubmit = (e) => {
        e.preventDefault();
        const el = form.elements;
        const body = { name: el.name.value.trim(), typeId: el.typeId.value, cadence: el.cadence.value.trim(), description: el.description.value, participantIds: checkedValues(form, 'participantIds') };
        if (!body.name) return toast('Name is required', true);
        guarded(async () => {
          const saved = isNew ? await api('POST', '/api/forums', body) : await api('PUT', `/api/forums/${enc(f.id)}`, body);
          close();
          toast(isNew ? 'Person / group created' : 'Person / group saved');
          const target = forumHref(saved.id);
          if (location.hash.startsWith('#/group/') || isNew) {
            if (location.hash !== target) location.hash = target;
            else render();
          } else render();
        });
      };
    }
  );
}

const defaultMeetingTitle = (f) => {
  const type = mtype(f.typeId);
  return type ? `${f.name} ${type.name}` : f.name;
};

// Create a meeting. "Meeting with" picks an existing person / group or creates a new one inline.
function openNewMeetingDialog(preselect = '') {
  const NEW = '__new__';
  const groups = S.forums;
  const initial = groups.some((g) => g.id === preselect) ? preselect : groups.length ? groups[0].id : NEW;
  const initialGroup = groups.find((g) => g.id === initial);
  openDialog(
    `<h2>New meeting</h2>
     <p class="muted small" style="margin-top:-.4rem">Creates the meeting with a preparation page (agenda), minutes and an action list. Open actions from earlier meetings with the same person / group are carried over into the preparation.</p>
     <div class="field"><label>Meeting with *</label>
       <select name="forum">${options(groups, initial)}<option value="${NEW}" ${initial === NEW ? 'selected' : ''}>+ New person / group…</option></select></div>
     <div class="subpanel" id="new-group" ${initial === NEW ? '' : 'hidden'}>
       <div class="row">
         <div class="field"><label>Name of the person or group *</label><input name="groupName" placeholder="e.g. Larry, Leadership Team" /></div>
         <div class="field"><label>Meeting type</label><select name="typeId">${options(S.config.meetingTypes, '', { blank: '— none —' })}</select></div>
       </div>
     </div>
     <div class="field"><label>Title *</label><input name="title" value="${esc(initialGroup ? defaultMeetingTitle(initialGroup) : '')}" /></div>
     <div class="row">
       <div class="field"><label>Date *</label><input type="date" name="date" value="${esc(todayStr())}" /></div>
       <div class="field"><label>Time</label><input type="time" name="time" /></div>
     </div>
     <div class="field"><label>Attendees</label>${peoplePicker('attendeeIds', initialGroup?.participantIds || [])}</div>
     <div class="dialog-actions">
       <button type="button" data-close>Cancel</button>
       <button type="submit" class="primary">Create meeting</button>
     </div>`,
    (form, close) => {
      const el = form.elements;
      let titleTouched = false;
      el.title.addEventListener('input', () => (titleTouched = true));
      const sync = () => {
        const isNew = el.forum.value === NEW;
        $('#new-group', form).hidden = !isNew;
        const g = groups.find((x) => x.id === el.forum.value);
        if (!titleTouched) el.title.value = g ? defaultMeetingTitle(g) : el.groupName.value.trim();
        if (g) $$('input[name="attendeeIds"]', form).forEach((i) => (i.checked = g.participantIds.includes(i.value)));
      };
      el.forum.addEventListener('change', () => {
        sync();
        if (el.forum.value === NEW) {
          $$('input[name="attendeeIds"]', form).forEach((i) => (i.checked = false));
          el.groupName.focus();
        }
      });
      el.groupName.addEventListener('input', sync);
      el.typeId.addEventListener('change', () => {
        if (!titleTouched) {
          const t = mtype(el.typeId.value);
          el.title.value = [el.groupName.value.trim(), t?.name].filter(Boolean).join(' ');
        }
      });
      if (initial === NEW) setTimeout(() => el.groupName.focus());
      form.onsubmit = (e) => {
        e.preventDefault();
        const isNew = el.forum.value === NEW;
        const groupName = el.groupName.value.trim();
        const body = { title: el.title.value.trim(), date: el.date.value, time: el.time.value, attendeeIds: checkedValues(form, 'attendeeIds') };
        if (isNew && !groupName) return toast('Enter the name of the person or group', true);
        if (!body.title || !body.date) return toast('Title and date are required', true);
        guarded(async () => {
          let forumId = el.forum.value;
          if (isNew) {
            const g = await api('POST', '/api/forums', { name: groupName, typeId: el.typeId.value, participantIds: body.attendeeIds });
            forumId = g.id;
          }
          const saved = await api('POST', `/api/forums/${enc(forumId)}/meetings`, body);
          close();
          toast('Meeting created');
          location.hash = meetingHref(forumId, saved.id);
        });
      };
    }
  );
}

function openMeetingDialog(forum, meeting) {
  const m = meeting;
  openDialog(
    `<h2>Edit meeting · ${esc(forum.name)}</h2>
     <div class="field"><label>Title *</label><input name="title" value="${esc(m.title)}" required /></div>
     <div class="row">
       <div class="field"><label>Date *</label><input type="date" name="date" value="${esc(m.date)}" required /></div>
       <div class="field"><label>Time</label><input type="time" name="time" value="${esc(m.time)}" /></div>
       <div class="field"><label>Status</label><select name="status">${options(MEETING_STATUSES, m.status)}</select></div>
     </div>
     <div class="field"><label>Attendees</label>${peoplePicker('attendeeIds', m.attendeeIds)}</div>
     <div class="dialog-actions">
       <button type="button" data-close>Cancel</button>
       <button type="submit" class="primary">Save</button>
     </div>`,
    (form, close) => {
      form.onsubmit = (e) => {
        e.preventDefault();
        const el = form.elements;
        const body = { title: el.title.value.trim(), date: el.date.value, time: el.time.value, status: el.status.value, attendeeIds: checkedValues(form, 'attendeeIds') };
        if (!body.title || !body.date) return toast('Title and date are required', true);
        guarded(async () => {
          const saved = await api('PUT', `/api/forums/${enc(forum.id)}/meetings/${enc(m.id)}`, body);
          close();
          toast('Meeting saved');
          if (saved.id !== m.id) {
            if (UI.meetingTabFor === `${forum.id}/${m.id}`) UI.meetingTabFor = `${forum.id}/${saved.id}`;
            location.hash = meetingHref(forum.id, saved.id);
          } else render();
        });
      };
    }
  );
}

// ---------- views ----------
function statCard({ icon, label, value, cls = '', href = '', attrs = '' }) {
  const inner = `<div class="icon">${icon}</div><div><div class="num">${value}</div><div class="label">${esc(label)}</div></div>`;
  return href ? `<a class="card stat ${cls}" href="${href}" ${attrs}>${inner}</a>` : `<div class="card stat ${cls}" ${attrs}>${inner}</div>`;
}

function meetingRow(m, cta) {
  return `<div class="list-row" data-meeting-row="${esc(m.id)}">${dateBadge(m.date)}
    <div class="grow"><a href="${meetingHref(m.forum, m.id)}"><b>${esc(m.title)}</b></a>
      <div class="muted small">with ${esc(m.forum)}${m.time ? ' · ' + esc(m.time) : ''}</div>
      <div class="row-summary">${actionSummary(S.actions.filter((a) => a.forum === m.forum && a.meeting === m.id))}</div></div>
    ${statusBadge(m.status)}
    <a class="btn small" href="${meetingHref(m.forum, m.id)}">${cta}</a></div>`;
}

function howItWorks({ id = '', withButtons = true } = {}) {
  const hasPeople = S.config.people.length > 0;
  const step = (n, title, text, extra = '') => `<li><span class="step-num">${n}</span><div><b>${title}</b><div class="muted small">${text}</div>${extra}</div></li>`;
  return `<div class="card callout" ${id ? `id="${id}"` : ''}><h2>How it works</h2><ol class="steps">
    ${step(hasPeople ? '✓' : 1, 'Add the people you meet', 'Admin → People. Also set up meeting types and buckets (topics / areas) for actions.', withButtons && !hasPeople ? '<a class="btn small" href="#/admin">Add people</a>' : '')}
    ${step(2, 'Create a meeting', 'Pick who it is with — one person (1:1) or a group. Everything is saved in one database file in your Meetings folder.', withButtons ? '<button class="small primary" data-new-meeting>+ New meeting</button>' : '')}
    ${step(3, 'Prepare', 'Open the meeting and write your agenda on the <b>① Prepare</b> tab. Open actions from earlier meetings are listed automatically.')}
    ${step(4, 'Take minutes & log actions', 'During or after the meeting use <b>② Minutes</b>, and add action items in <b>③ Actions</b> (owner, due date, buckets).')}
    ${step(5, 'Follow up', 'Track open and overdue actions on the Dashboard and Actions page, and export them to your task tool.')}
  </ol></div>`;
}

async function viewDashboard(app) {
  const today = todayStr();
  const week = addDays(7);
  const open = S.actions.filter(isOpen);
  const overdue = open.filter(isOverdue);
  const dueSoon = open.filter((a) => a.dueDate && a.dueDate >= today && a.dueDate <= week);
  const upcoming = S.meetings.filter((m) => m.status === 'planned' && m.date >= today).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  const needsFollowUp = S.meetings.filter((m) => m.status === 'planned' && m.date < today).sort((a, b) => b.date.localeCompare(a.date));
  const byBucket = S.config.buckets.map((b) => ({ ...b, n: open.filter((a) => a.bucketIds.includes(b.id)).length })).filter((b) => b.n);
  const noBucket = open.filter((a) => !a.bucketIds.length).length;
  const byOwner = [...S.config.people.map((p) => ({ id: p.id, name: p.name, n: open.filter((a) => a.ownerId === p.id).length })), { id: '', name: 'Unassigned', n: open.filter((a) => !a.ownerId).length }].filter((x) => x.n).sort((a, b) => b.n - a.n);
  const bucketRows = [...byBucket, ...(noBucket ? [{ id: '', name: 'No bucket', n: noBucket, color: '#94a3b8' }] : [])];
  const max = Math.max(1, ...bucketRows.map((b) => b.n));
  const attention = [...overdue, ...dueSoon];
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

  app.innerHTML = `
    <div class="page-head"><div><h1>${greeting} 👋</h1><div class="subtitle">${esc(fmtDate(today))}</div></div>
      <div class="toolbar"><a class="btn" href="#/meetings">All meetings</a><button id="adhoc-meeting" data-adhoc title="Start an ad-hoc meeting now (shortcut: A)">⚡ Ad-hoc meeting<kbd>A</kbd></button><button class="primary" id="new-meeting-global" data-new-meeting title="New meeting (shortcut: N)">+ New meeting<kbd>N</kbd></button></div></div>
    ${S.meetings.length ? '' : howItWorks({ id: 'getting-started' })}
    <div class="grid stats">
      ${statCard({ icon: '📌', label: 'Open actions', value: open.length, href: '#/actions', attrs: 'data-stat="open"' })}
      ${statCard({ icon: '⏰', label: 'Overdue', value: overdue.length, cls: overdue.length ? 'danger' : 'ok', href: '#/actions', attrs: 'data-stat="overdue"' })}
      ${statCard({ icon: '📆', label: 'Due in 7 days', value: dueSoon.length, cls: dueSoon.length ? 'warn' : '' })}
      ${statCard({ icon: '🗓️', label: 'Upcoming meetings', value: upcoming.length, href: '#/meetings' })}
      ${statCard({ icon: '👥', label: 'People & groups', value: S.forums.length, href: '#/groups' })}
    </div>
    <div class="grid cols-2">
      <div class="card" id="upcoming"><div class="card-head"><h2>Upcoming meetings</h2><a class="small" href="#/meetings">all meetings →</a></div>
        ${upcoming.length ? upcoming.slice(0, 8).map((m) => meetingRow(m, 'Prepare →')).join('') : emptyState('No upcoming meetings. <button class="small primary" data-new-meeting>+ New meeting</button>')}
        ${needsFollowUp.length ? `<h3 style="margin-top:1.2rem">Past meetings — write minutes & actions</h3>${needsFollowUp.slice(0, 6).map((m) => meetingRow(m, 'Minutes →')).join('')}` : ''}
      </div>
      <div class="card"><div class="card-head"><h2>Open actions by bucket</h2></div>
        ${bucketRows.length ? `<div class="kv">${bucketRows.map((b) => `
          <div><div class="small"><b>${esc(b.name)}</b> <span class="muted">${esc(b.category || '')}</span></div><div class="bar"><span style="width:${(b.n / max) * 100}%;background:${esc(b.color || '#4f46e5')}"></span></div></div><b>${b.n}</b>`).join('')}</div>` : emptyState('No open actions.')}
        <h3 style="margin-top:1.2rem">By owner</h3>
        ${byOwner.length ? `<div class="kv">${byOwner.map((o) => `<div>${o.id ? personTag(o.id) : `<span class="muted">${esc(o.name)}</span>`}</div><b>${o.n}</b>`).join('')}</div>` : emptyState('No open actions.')}
      </div>
    </div>
    <div class="card" id="attention"><div class="card-head"><h2>Needs attention</h2><span class="muted small">overdue & due within 7 days</span></div>
      ${actionTable(attention, { empty: 'Nothing overdue or due this week. 🎉' })}</div>
    <h2 class="section-title">People & groups you meet</h2>
    <div class="grid cols-3">${S.forums.map(forumCard).join('') || emptyState('Nobody yet — they are created when you add your first meeting.')}</div>`;

  bindNewMeetingButtons(app);
  bindActionTable($('#attention', app), attention, render);
  $('[data-stat="overdue"]', app).addEventListener('click', () => (UI.actionFilters = { ...DEFAULT_FILTERS, overdue: true }));
  $('[data-stat="open"]', app).addEventListener('click', () => (UI.actionFilters = { ...DEFAULT_FILTERS }));
}

function bindNewMeetingButtons(root, preselect = '') {
  $$('[data-new-meeting]', root).forEach((b) => (b.onclick = () => openNewMeetingDialog(preselect)));
  $$('[data-adhoc]', root).forEach((b) => (b.onclick = () => openAdhocDialog()));
}

// Ad-hoc meeting: starts right now, no person / group needed, opens on the minutes.
function openAdhocDialog() {
  const now = new Date();
  const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  openDialog(
    `<h2>⚡ Ad-hoc meeting</h2>
     <p class="muted small" style="margin-top:-.4rem">Starts now (${esc(fmtDate(todayStr()))}, ${esc(time)}) and opens the minutes. It is filed under <b>${esc(ADHOC_GROUP)}</b> in People & groups.</p>
     <div class="field"><label>Topic</label><input name="title" placeholder="Ad-hoc ${esc(time)}" /></div>
     <div class="field"><label>Attendees</label>${peoplePicker('attendeeIds', [])}</div>
     <div class="dialog-actions">
       <button type="button" data-close>Cancel</button>
       <button type="submit" class="primary">Start meeting</button>
     </div>`,
    (form, close) => {
      setTimeout(() => form.elements.title.focus());
      form.onsubmit = (e) => {
        e.preventDefault();
        guarded(async () => {
          const saved = await api('POST', '/api/adhoc', { title: form.elements.title.value.trim(), date: todayStr(), time, attendeeIds: checkedValues(form, 'attendeeIds') });
          close();
          toast('Ad-hoc meeting started');
          UI.meetingTabFor = `${saved.forum}/${saved.id}`;
          UI.meetingTab = 'minutes';
          UI.preview = false;
          location.hash = meetingHref(saved.forum, saved.id);
        });
      };
    }
  );
}

function forumCard(f) {
  return `<div class="card forum-card" data-forum="${esc(f.id)}">
    <div><h3><a href="${forumHref(f.id)}">${esc(f.name)}</a></h3>
    <div class="muted small">${esc(mtype(f.typeId)?.name || 'No type')}${f.cadence ? ' · ' + esc(f.cadence) : ''}</div></div>
    <div>${peopleList(f.participantIds)}</div>
    <div class="meta">
      <span>Meetings <b>${f.meetingCount}</b></span>
      <span>Open actions <b>${f.openActions}</b> / ${f.totalActions}</span>
      <span>Next ${f.nextMeeting ? `<a href="${meetingHref(f.id, f.nextMeeting.id)}"><b>${esc(fmtShort(f.nextMeeting.date))}</b></a>` : '—'}</span>
      <span>Last ${f.lastMeeting ? `<a href="${meetingHref(f.id, f.lastMeeting.id)}"><b>${esc(fmtShort(f.lastMeeting.date))}</b></a>` : '—'}</span>
    </div></div>`;
}

async function viewMeetings(app) {
  const F = UI.meetingsFilter;
  const today = todayStr();
  const isUpcoming = (m) => m.date >= today && m.status !== 'cancelled';
  const list = S.meetings
    .filter((m) => !F.forum || m.forum === F.forum)
    .filter((m) => (F.when === 'upcoming' ? isUpcoming(m) : F.when === 'past' ? !isUpcoming(m) : true))
    .sort((a, b) => (F.when === 'upcoming' ? 1 : -1) * (a.date + a.time).localeCompare(b.date + b.time));
  const tabs = { upcoming: 'Upcoming', past: 'Past', all: 'All' };
  app.innerHTML = `
    <div class="page-head"><div><h1>Meetings</h1><div class="subtitle">Click a meeting to prepare it, take minutes and log actions.</div></div>
      <div class="toolbar"><button id="adhoc-meeting" data-adhoc title="Start an ad-hoc meeting now (shortcut: A)">⚡ Ad-hoc meeting<kbd>A</kbd></button><button class="primary" id="new-meeting" data-new-meeting title="New meeting (shortcut: N)">+ New meeting<kbd>N</kbd></button></div></div>
    <div class="card">
      <div class="filters">
        <div class="segmented">${Object.entries(tabs).map(([k, v]) => `<button data-when="${k}" class="${F.when === k ? 'active' : ''}">${v}</button>`).join('')}</div>
        <select id="m-forum" aria-label="Meeting with">${options(S.forums, F.forum, { blank: 'With anyone' })}</select>
      </div>
      <div id="meeting-list">${list.length ? list.map((m) => meetingRow(m, isUpcoming(m) && m.status === 'planned' ? 'Prepare →' : 'Open →')).join('')
        : emptyState(S.meetings.length ? 'No meetings match.' : 'No meetings yet. <button class="small primary" data-new-meeting>+ New meeting</button>')}</div>
    </div>
    ${S.meetings.length ? '' : howItWorks({ withButtons: false })}`;
  bindNewMeetingButtons(app, F.forum);
  $$('[data-when]', app).forEach((b) => (b.onclick = () => { F.when = b.dataset.when; render(); }));
  $('#m-forum', app).onchange = (e) => { F.forum = e.target.value; render(); };
}

async function viewForums(app) {
  app.innerHTML = `
    <div class="page-head"><div><h1>People & groups</h1><div class="subtitle">Everyone you meet with — one person (1:1) or a group, with background info and all its meetings.</div></div>
      <div class="toolbar"><button class="primary" id="new-forum">+ New person / group</button></div></div>
    <div class="grid cols-3">${S.forums.map(forumCard).join('') || emptyState('Nobody yet. Create one here, or directly when you add a meeting.')}</div>`;
  $('#new-forum', app).onclick = () => openForumDialog();
}

function autosave(textarea, save, stateEl) {
  let timer;
  textarea.addEventListener('input', () => {
    stateEl.textContent = 'Unsaved…';
    stateEl.className = 'save-state dirty';
    clearTimeout(timer);
    pendingSave = save;
    timer = setTimeout(() => pendingSave === save && flushPendingSave(), 1200);
  });
  textarea.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      clearTimeout(timer);
      pendingSave = null;
      save().then(() => toast('Saved'));
    }
  });
}

function markSaved(el, label) {
  if (!el) return;
  el.textContent = `${label} · saved`;
  el.className = 'save-state saved';
}

async function viewForum(app, forumId, isCurrent = () => true) {
  const f = await api('GET', `/api/forums/${enc(forumId)}`);
  if (!isCurrent()) return;
  const actions = S.actions.filter((a) => a.forum === forumId);
  const shown = UI.showClosed ? actions : actions.filter(isOpen);
  app.innerHTML = `
    <div class="crumbs"><a href="#/groups">People & groups</a> ›</div>
    <div class="page-head"><div><h1>${esc(f.name)}</h1>
      <div class="subtitle"><span>${esc(mtype(f.typeId)?.name || 'No type')}</span>${f.cadence ? `<span>${esc(f.cadence)}</span>` : ''}</div>
      <div style="margin-top:.5rem">${peopleList(f.participantIds)}</div>
      ${f.description ? `<p style="margin:.5rem 0 0">${esc(f.description)}</p>` : ''}</div>
      <div class="toolbar"><button id="edit-forum">Edit</button><button class="primary" id="new-meeting" data-new-meeting title="New meeting (shortcut: N)">+ New meeting<kbd>N</kbd></button></div></div>
    <div class="grid cols-2">
      <div class="card" id="meetings"><div class="card-head"><h2>Meetings</h2><span class="muted small">${f.meetings.length} total · click to open</span></div>
        ${f.meetings.length ? f.meetings.map((m) => `<div class="list-row">${dateBadge(m.date)}
            <div class="grow"><a href="${meetingHref(f.id, m.id)}"><b>${esc(m.title)}</b></a>
              <div class="muted small">${esc(fmtDate(m.date))}${m.time ? ' · ' + esc(m.time) : ''}</div>
              <div class="row-summary">${actionSummary(m.actions)}</div></div>
            ${statusBadge(m.status)}<a class="btn small" href="${meetingHref(f.id, m.id)}">Open →</a></div>`).join('')
          : emptyState('No meetings yet. <button class="small primary" data-new-meeting>+ New meeting</button>')}</div>
      <div class="card"><div class="tabs"><button class="${UI.preview ? '' : 'active'}" data-mode="edit">Edit</button><button class="${UI.preview ? 'active' : ''}" data-mode="preview">Preview</button>
          <span class="spacer"></span><span class="save-state" id="ctx-state">Background</span></div>
        <h2 style="margin-top:0">Background & context</h2>
        <p class="muted small" style="margin-top:-.4rem">Long-lived information about ${esc(f.name)}: goals, history, key topics. Visible from every meeting.</p>
        ${UI.preview ? `<div class="md">${markdown(f.context)}</div>` : `<textarea id="context" style="min-height:320px">${esc(f.context)}</textarea>
        <div class="muted small" style="margin-top:.4rem;display:flex;justify-content:space-between;align-items:center"><span>Autosaves · Ctrl+S to save now</span><button class="primary small" id="save-context">Save</button></div>`}</div>
    </div>
    <div class="card" id="forum-actions"><div class="card-head"><h2>${UI.showClosed ? 'All' : 'Open'} actions with ${esc(f.name)}</h2>
      <label class="toggle"><input type="checkbox" id="show-closed" ${UI.showClosed ? 'checked' : ''}/> Show closed</label></div>
      ${actionTable(shown, { showForum: false })}</div>`;

  $('#edit-forum', app).onclick = () => openForumDialog(f);
  bindNewMeetingButtons(app, f.id);
  $('#show-closed', app).onchange = (e) => ((UI.showClosed = e.target.checked), render());
  $$('[data-mode]', app).forEach((b) => (b.onclick = async () => { await flushPendingSave(); UI.preview = b.dataset.mode === 'preview'; render(); }));
  const ctx = $('#context', app);
  if (ctx) {
    const saveCtx = () => guarded(async () => {
      await api('PUT', `/api/forums/${enc(f.id)}`, { context: ctx.value });
      markSaved($('#ctx-state', app), 'Background');
    });
    $('#save-context', app).onclick = () => { pendingSave = null; saveCtx().then(() => toast('Context saved')); };
    autosave(ctx, saveCtx, $('#ctx-state', app));
  }
  bindActionTable($('#forum-actions', app), shown, render);
}

async function viewMeeting(app, forumId, meetingId, isCurrent = () => true) {
  const [f, m] = await Promise.all([api('GET', `/api/forums/${enc(forumId)}`), api('GET', `/api/forums/${enc(forumId)}/meetings/${enc(meetingId)}`)]);
  if (!isCurrent()) return;
  const mine = S.actions.filter((a) => a.forum === forumId && a.meeting === meetingId);
  const followUps = S.actions.filter((a) => a.forum === forumId && a.meeting !== meetingId && isOpen(a) && (a.meetingDate || '') <= m.date);
  const isPrep = m.status === 'planned' && m.date >= todayStr();
  // Each meeting opens on the step that matters: Prepare before it happens, Minutes afterwards.
  if (UI.meetingTabFor !== `${forumId}/${meetingId}`) {
    UI.meetingTabFor = `${forumId}/${meetingId}`;
    UI.meetingTab = isPrep ? 'agenda' : 'minutes';
  }
  const tab = UI.meetingTab;
  const tabs = { agenda: '① Prepare', minutes: '② Minutes', context: 'Background' };
  const hints = {
    agenda: 'Plan the meeting: goals, agenda points, questions. Open actions from earlier meetings are listed for review.',
    minutes: 'Write what was discussed and decided. Log every action item in <b>③ Actions</b> on the right so it can be tracked.',
    context: `Background on ${esc(f.name)} — shared by all meetings with them.`,
  };
  const fileLabel = { agenda: 'Agenda', minutes: 'Minutes', context: 'Background' }[tab];
  const attendees = attendeeNames(f.name, m.attendeeIds);
  const docText = tab === 'context' ? f.context : m[tab];
  const previewText = tab === 'minutes' ? withAttendees(docText, attendees) : docText;
  // f.meetings is sorted newest first.
  const pos = f.meetings.findIndex((x) => x.id === m.id);
  const prev = pos >= 0 ? f.meetings[pos + 1] : null;
  const next = pos > 0 ? f.meetings[pos - 1] : null;

  app.innerHTML = `
    <div class="crumbs"><a href="#/meetings">Meetings</a> › <a href="${forumHref(f.id)}">${esc(f.name)}</a> ›</div>
    <div class="page-head"><div><h1>${esc(m.title)} ${statusBadge(m.status)}</h1>
      <div class="subtitle"><span>📅 ${esc(fmtDate(m.date))}${m.time ? ' · ' + esc(m.time) : ''}</span><span>with <a href="${forumHref(f.id)}">${esc(f.name)}</a></span></div>
      <div style="margin-top:.5rem" id="meeting-attendees">${attendeeTags(attendees)}</div>
      <div class="meeting-summary" id="meeting-summary"><b>Actions from this meeting:</b> ${actionSummary(mine, { emptyText: 'none yet' })}${followUps.length ? `<button type="button" class="link small" id="goto-followups">${followUps.length} still open from earlier meetings</button>` : ''}</div>
      ${prev || next ? `<div class="meeting-nav">${prev ? `<a id="prev-meeting" href="${meetingHref(f.id, prev.id)}">← Previous: ${esc(fmtShort(prev.date))} ${esc(prev.title)}</a>` : ''}${next ? `<a id="next-meeting" href="${meetingHref(f.id, next.id)}">Next: ${esc(fmtShort(next.date))} ${esc(next.title)} →</a>` : ''}</div>` : ''}</div>
      <div class="toolbar">${m.status === 'planned' ? '<button id="mark-held">✓ Mark as held</button>' : ''}
        <button id="edit-meeting">Edit</button><button class="danger" id="archive-meeting">Archive</button></div></div>
    <div class="grid cols-2">
      <div class="card">
        <div class="tabs steps-tabs">${Object.entries(tabs).map(([k, v]) => `<button data-tab="${k}" class="${k === tab ? 'active' : ''}">${v}</button>`).join('')}
          <span class="spacer"></span>
          <label class="toggle"><input type="checkbox" id="preview-toggle" ${UI.preview ? 'checked' : ''}/> Preview</label>
          ${UI.preview ? `<button type="button" class="small" id="copy-preview" title="Copy as formatted text (paste into Outlook, Teams, Word…)" style="margin-left:.6rem">⧉ Copy</button>` : ''}
          <span class="save-state" id="doc-state" style="margin-left:.75rem">${fileLabel}</span></div>
        <p class="muted small" id="tab-hint" style="margin:-.25rem 0 .6rem">${hints[tab]}</p>
        ${UI.preview ? `<div class="md" id="preview" style="min-height:460px">${markdown(previewText)}${tab === 'minutes' ? `
          <div class="minutes-actions" id="minutes-actions"><h2>Actions from this meeting ${actionSummary(mine, { emptyText: 'none yet' })}</h2>
            ${mine.length ? `<table class="compact"><thead><tr><th>Action</th><th>Owner</th><th>Due</th><th>Status</th></tr></thead><tbody>${sortActions(mine).map((a) => `
              <tr class="${isOverdue(a) ? 'overdue' : ''} ${isOpen(a) ? '' : 'closed'}" data-summary-row="${esc(a.id)}"><td class="title">${esc(a.title)}${a.bucketIds.length ? `<div>${bucketChips(a.bucketIds)}</div>` : ''}</td>
                <td>${a.ownerId ? personTag(a.ownerId) : '<span class="muted">unassigned</span>'}</td>
                <td class="due">${a.dueDate ? `${isOverdue(a) ? '⚠ ' : ''}${esc(fmtShort(a.dueDate))}` : '<span class="muted">—</span>'}</td>
                <td>${esc(a.status)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted small">Log action items in ③ Actions — they appear here.</p>'}</div>` : ''}</div>` : `<textarea id="doc" style="min-height:460px">${esc(docText)}</textarea>
        <div class="muted small" style="margin-top:.35rem">Autosaves · Ctrl+S to save now · Markdown supported</div>`}
      </div>
      <div>
        <div class="card" id="meeting-actions"><div class="card-head"><h2>③ Actions</h2><button class="primary small" id="add-action">+ Action</button></div>
          <form id="quick-add" class="quick-add">
            <input name="title" placeholder="Quick add: type an action and press Enter" aria-label="Quick add action" />
            <div class="qa-row">
              <select name="ownerId" aria-label="Owner">${options(S.config.people, '', { blank: 'Owner (optional)' })}</select>
              <input type="date" name="dueDate" aria-label="Due date" title="Due date (optional)" />
              <button type="submit" class="small primary">Add</button>
            </div>
          </form>
          ${actionTable(mine, { showForum: false, showMeeting: false, compact: true, empty: 'No actions logged for this meeting yet.' })}</div>
        <div class="card" id="followups"><div class="card-head"><h2>Open actions from earlier meetings</h2><span class="muted small">review & update</span></div>
          ${actionTable(followUps, { showForum: false, compact: true, empty: 'Nothing open from earlier meetings. 🎉' })}</div>
        <div class="card" id="attachments"><div class="card-head"><h2>Files</h2>
            <label class="btn small" id="attach-label">+ Attach files<input type="file" id="attach-input" multiple hidden /></label></div>
          <div class="dropzone" id="dropzone">
            ${m.files.length ? `<table class="compact"><tbody>${m.files.map((x) => `<tr data-file="${x.id}"><td class="title"><a href="/api/attachments/${x.id}/download">📎 ${esc(x.name)}</a></td>
              <td class="muted small" style="white-space:nowrap">${fmtSize(x.size)}</td>
              <td class="actions-col"><button type="button" class="small danger" data-del-file="${x.id}" title="Delete file">✕</button></td></tr>`).join('')}</tbody></table>`
              : emptyState('Drop slides, documents or notes here (or use <b>+ Attach files</b>). They are stored in the database with this meeting.')}
          </div></div>
      </div>
    </div>`;

  $$('[data-tab]', app).forEach((b) => (b.onclick = async () => { await flushPendingSave(); UI.meetingTab = b.dataset.tab; render(); }));
  $('#preview-toggle', app).onchange = async (e) => { await flushPendingSave(); UI.preview = e.target.checked; render(); };
  const doc = $('#doc', app);
  if (doc) {
    const saveDoc = () => guarded(async () => {
      if (tab === 'context') await api('PUT', `/api/forums/${enc(f.id)}`, { context: doc.value });
      else await api('PUT', `/api/forums/${enc(f.id)}/meetings/${enc(m.id)}`, { [tab]: doc.value });
      markSaved($('#doc-state', app), fileLabel);
    });
    autosave(doc, saveDoc, $('#doc-state', app));
  }

  const refresh = async () => { await flushPendingSave(); await render(); };
  $('#add-action', app).onclick = () => openActionDialog({ forum: f.id, meeting: m.id, defaults: { ownerId: m.attendeeIds.length === 1 ? m.attendeeIds[0] : '' }, onSaved: refresh });
  $('#quick-add', app).addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.tagName === 'INPUT') {
      e.preventDefault();
      e.currentTarget.requestSubmit();
    }
  });
  $('#quick-add', app).onsubmit = (e) => {
    e.preventDefault();
    const q = e.target.elements;
    const title = q.title.value.trim();
    if (!title) return;
    guarded(async () => {
      await api('POST', `/api/forums/${enc(f.id)}/meetings/${enc(m.id)}/actions`, { title, ownerId: q.ownerId.value, dueDate: q.dueDate.value });
      toast('Action added');
      await refresh();
      $('#quick-add input[name=title]')?.focus();
    });
  };
  bindActionTable($('#meeting-actions', app), mine, refresh);
  bindActionTable($('#followups', app), followUps, refresh);
  $('#goto-followups', app)?.addEventListener('click', () => $('#followups', app).scrollIntoView({ behavior: 'smooth', block: 'center' }));
  $('#copy-preview', app)?.addEventListener('click', () => guarded(async () => {
    const actionLines = tab === 'minutes' && mine.length
      ? ['', '## Actions from this meeting', '', ...sortActions(mine).map((a) => `- [${isOpen(a) ? ' ' : 'x'}] ${a.title} (${personName(a.ownerId) || 'unassigned'}${a.dueDate ? ', due ' + a.dueDate : ''}) - ${a.status}`)]
      : [];
    await copyRich(previewForCopy($('#preview', app)), [String(previewText || '').trimEnd(), ...actionLines].join('\n') + '\n');
    toast('Copied — paste it into an email, Teams or a document');
  }));
  const attach = (files) => guarded(async () => {
    if (!files.length) return;
    await flushPendingSave();
    await uploadFiles(f.id, m.id, files);
    toast(files.length === 1 ? `Attached ${files[0].name}` : `Attached ${files.length} files`);
    await render();
  });
  $('#attach-input', app).onchange = (e) => attach([...e.target.files]);
  const drop = $('#dropzone', app);
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('dragging');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('dragging'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('dragging');
    attach([...e.dataTransfer.files]);
  });
  $$('[data-del-file]', app).forEach((b) => (b.onclick = () => {
    const name = m.files.find((x) => String(x.id) === b.dataset.delFile)?.name || 'this file';
    if (!confirm(`Delete "${name}" from this meeting?`)) return;
    guarded(async () => {
      await api('DELETE', `/api/attachments/${enc(b.dataset.delFile)}`);
      toast('File deleted');
      await render();
    });
  }));
  $('#edit-meeting', app).onclick = async () => { await flushPendingSave(); openMeetingDialog(f, m); };
  $('#mark-held', app)?.addEventListener('click', () => guarded(async () => {
    await flushPendingSave();
    await api('PUT', `/api/forums/${enc(f.id)}/meetings/${enc(m.id)}`, { status: 'held' });
    toast('Meeting marked as held');
    await render();
  }));
  $('#archive-meeting', app).onclick = () => {
    if (!confirm(`Archive meeting "${m.title}"? It is hidden together with its actions (nothing is deleted).`)) return;
    guarded(async () => {
      pendingSave = null;
      await api('DELETE', `/api/forums/${enc(f.id)}/meetings/${enc(m.id)}`);
      toast('Meeting archived');
      location.hash = forumHref(f.id);
    });
  };
}

// Email-friendly copy of a preview: plain names instead of avatars, inline table borders.
function previewForCopy(el) {
  const c = el.cloneNode(true);
  c.querySelectorAll('.avatar, button, select').forEach((x) => x.remove());
  c.querySelectorAll('table').forEach((t) => t.setAttribute('style', 'border-collapse:collapse;margin-top:6px'));
  c.querySelectorAll('th, td').forEach((x) => x.setAttribute('style', 'border:1px solid #d1d5db;padding:4px 8px;text-align:left;vertical-align:top'));
  c.querySelectorAll('.as-pill').forEach((x) => x.setAttribute('style', 'font-size:12px;font-weight:600;margin-right:6px'));
  return `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px">${c.innerHTML}</div>`;
}

async function copyRich(html, text) {
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([text], { type: 'text/plain' }) })]);
    return;
  } catch {}
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {}
  const ta = Object.assign(document.createElement('textarea'), { value: text });
  ta.style.cssText = 'position:fixed;opacity:0';
  document.body.append(ta);
  ta.select();
  const ok = document.execCommand('copy');
  ta.remove();
  if (!ok) throw new Error('Copying is not allowed by the browser');
}

async function viewActions(app) {
  const F = UI.actionFilters;
  const filtered = S.actions.filter((a) => {
    if (F.status === 'active' && !isOpen(a)) return false;
    if (F.status && !['active', 'all'].includes(F.status) && a.status !== F.status) return false;
    if (F.forum && a.forum !== F.forum) return false;
    if (F.owner && a.ownerId !== F.owner) return false;
    if (F.bucket && !a.bucketIds.includes(F.bucket)) return false;
    if (F.overdue && !isOverdue(a)) return false;
    if (F.q && !`${a.title} ${a.details}`.toLowerCase().includes(F.q.toLowerCase())) return false;
    return true;
  });
  const qs = new URLSearchParams({ status: F.status, forum: F.forum, owner: F.owner, bucket: F.bucket, overdue: F.overdue ? '1' : '', q: F.q }).toString();

  app.innerHTML = `
    <div class="page-head"><div><h1>Action items</h1><div class="subtitle" id="action-count">${filtered.length} of ${S.actions.length} shown</div></div>
      <div class="toolbar"><a class="btn" id="export-csv" href="/api/export?format=csv&${qs}">⬇ Export CSV</a><a class="btn" id="export-json" href="/api/export?format=json&${qs}">⬇ Export JSON</a></div></div>
    <div class="card">
      <div class="filters">
        <input id="f-q" placeholder="🔎 Search actions…" value="${esc(F.q)}" />
        <select id="f-status" aria-label="Status filter">${options([{ id: 'active', name: 'Open (not done/cancelled)' }, { id: 'all', name: 'All statuses' }, ...ACTION_STATUSES.map((s) => ({ id: s, name: s }))], F.status)}</select>
        <select id="f-forum" aria-label="Meeting with filter">${options(S.forums, F.forum, { blank: 'With anyone' })}</select>
        <select id="f-owner" aria-label="Owner filter">${options(S.config.people, F.owner, { blank: 'All owners' })}</select>
        <select id="f-bucket" aria-label="Bucket filter">${options(S.config.buckets, F.bucket, { blank: 'All buckets' })}</select>
        <label class="toggle"><input type="checkbox" id="f-overdue" ${F.overdue ? 'checked' : ''}/> Overdue only</label>
        <button class="link" id="f-reset">Reset</button>
      </div>
      <div id="action-list">${actionTable(filtered, { empty: S.actions.length ? 'No actions match the filters.' : 'No action items yet. Capture them from a meeting page.' })}</div>
    </div>
    <p class="muted small">Exports use the current filters. CSV (UTF-8) columns: id, title, details, owner, ownerEmail, dueDate, status, priority, buckets, meetingWith, meeting, meetingDate, externalRef, createdAt, completedAt.</p>`;

  const set = (k, v) => { F[k] = v; render(); };
  $('#f-status', app).onchange = (e) => set('status', e.target.value);
  $('#f-forum', app).onchange = (e) => set('forum', e.target.value);
  $('#f-owner', app).onchange = (e) => set('owner', e.target.value);
  $('#f-bucket', app).onchange = (e) => set('bucket', e.target.value);
  $('#f-overdue', app).onchange = (e) => set('overdue', e.target.checked);
  let t;
  $('#f-q', app).oninput = (e) => {
    clearTimeout(t);
    t = setTimeout(async () => {
      F.q = e.target.value;
      await render();
      const i = $('#f-q');
      i.focus();
      i.setSelectionRange(i.value.length, i.value.length);
    }, 300);
  };
  $('#f-reset', app).onclick = () => { UI.actionFilters = { ...DEFAULT_FILTERS }; render(); };
  bindActionTable($('#action-list', app), filtered, render);
}

// ---------- admin ----------
const ADMIN_LISTS = {
  people: { title: 'People', help: 'Everyone you meet with or who can own an action item.', cols: [['name', 'Name *'], ['email', 'Email'], ['role', 'Role'], ['organization', 'Organization']] },
  meetingTypes: { title: 'Meeting types', help: 'Kinds of forums, e.g. 1:1, team meeting, steering committee.', cols: [['name', 'Name *'], ['description', 'Description']] },
  buckets: { title: 'Buckets', help: 'Used to categorise action items. The category groups them (e.g. Topic, Area).', cols: [['color', 'Color'], ['name', 'Name *'], ['category', 'Category']] },
};

async function viewAdmin(app) {
  const tab = UI.adminTab;
  const tabs = { ...Object.fromEntries(Object.entries(ADMIN_LISTS).map(([k, v]) => [k, `${v.title} (${S.config[k].length})`])), forums: `People & groups (${S.forums.length})`, backup: 'Backup', security: 'Security' };
  app.innerHTML = `
    <div class="page-head"><div><h1>Admin</h1><div class="subtitle">Set up the structure: people, meeting types, buckets and the people & groups you meet · stored in <span class="folder-path">${esc(S.root)}</span></div></div></div>
    <div class="card"><div class="tabs">${Object.entries(tabs).map(([k, v]) => `<button data-tab="${k}" class="${k === tab ? 'active' : ''}">${esc(v)}</button>`).join('')}</div>
      <div id="admin-body"></div></div>`;
  $$('[data-tab]', app).forEach((b) => (b.onclick = () => {
    if (UI.adminDirty && !confirm('You have unsaved changes on this tab. Discard them?')) return;
    UI.adminDirty = false;
    UI.adminTab = b.dataset.tab;
    render();
  }));
  const body = $('#admin-body', app);
  if (tab === 'forums') {
    UI.adminDirty = false;
    return adminForums(body);
  }
  if (tab === 'backup') {
    UI.adminDirty = false;
    return adminBackup(body);
  }
  if (tab === 'security') {
    UI.adminDirty = false;
    return adminSecurity(body);
  }
  adminList(body, tab);
}

async function adminSecurity(body) {
  const st = await api('GET', '/api/auth/status');
  body.innerHTML = `
    <p class="muted" style="margin-top:0">Your data is in <span class="folder-path">${esc(st.database)}</span> on this computer and is never uploaded. The password protects access to it from this web app.</p>
    <form id="pw-form" class="row" style="max-width:760px">
      <div class="field" style="flex:1"><label>Current password</label><input type="password" name="current" autocomplete="current-password" required /></div>
      <div class="field" style="flex:1"><label>New password</label><input type="password" name="password" autocomplete="new-password" minlength="4" required /></div>
      <div class="field" style="flex:1"><label>Repeat new password</label><input type="password" name="repeat" autocomplete="new-password" required /></div>
      <button type="submit" class="primary" style="margin-bottom:.8rem">Change password</button>
    </form>
    <p class="muted small">Changing the password signs out all other browsers.</p>`;
  const form = $('#pw-form', body);
  form.onsubmit = (e) => {
    e.preventDefault();
    const pw = form.elements.password.value;
    if (pw !== form.elements.repeat.value) return toast('The two new passwords do not match', true);
    guarded(async () => {
      const r = await api('PUT', '/api/auth/password', { currentPassword: form.elements.current.value, password: pw });
      if (r.token) localStorage.setItem(TOKEN_KEY, r.token);
      toast('Password changed');
      await render();
    });
  };
}

function adminList(body, key) {
  const def = ADMIN_LISTS[key];
  const draft = structuredClone(S.config[key]);
  UI.adminDirty = false;
  const markDirty = () => {
    UI.adminDirty = true;
    $('#unsaved', body)?.removeAttribute('hidden');
  };
  const usage = (item) => {
    if (key === 'people') return S.actions.filter((a) => a.ownerId === item.id).length + S.forums.filter((f) => f.participantIds.includes(item.id)).length;
    if (key === 'buckets') return S.actions.filter((a) => a.bucketIds.includes(item.id)).length;
    return S.forums.filter((f) => f.typeId === item.id).length;
  };
  const draw = () => {
    body.innerHTML = `
      ${key === 'people' ? `<form id="my-name-form" class="row my-name" style="align-items:flex-end;margin-bottom:1rem">
        <div class="field" style="margin:0"><label for="my-name">Your name</label><input id="my-name" name="myName" value="${esc(S.config.myName || '')}" placeholder="e.g. Gilad" /></div>
        <button type="submit" class="small">Save name</button>
        <span class="muted small" style="align-self:center">Added to every meeting's attendees (with a 1:1 it is you + the person).</span></form>` : ''}
      <p class="muted" style="margin-top:0">${esc(def.help)}</p>
      <datalist id="cat-list">${[...new Set(['Topic', 'Area', ...S.config.buckets.map((b) => b.category).filter(Boolean)])].map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
      ${draft.length ? `<table class="admin-list"><thead><tr>${def.cols.map(([, l]) => `<th>${esc(l)}</th>`).join('')}<th>Used</th><th></th></tr></thead><tbody>
        ${draft.map((item, i) => `<tr>${def.cols.map(([k]) => `<td${k === 'color' ? ' style="width:60px"' : ''}>${k === 'color'
          ? `<input type="color" data-i="${i}" data-k="${k}" value="${esc(item[k] || '#4f46e5')}" />`
          : `<input data-i="${i}" data-k="${k}" value="${esc(item[k] || '')}" ${k === 'category' ? 'list="cat-list"' : ''} ${k === 'email' ? 'type="email"' : ''} aria-label="${esc(k)}" />`}</td>`).join('')}
          <td class="muted" style="width:60px">${item.id ? usage(item) : 'new'}</td>
          <td class="actions-col" style="width:90px"><button type="button" class="small danger" data-del="${i}">Remove</button></td></tr>`).join('')}
      </tbody></table>` : emptyState('Nothing defined yet. Click <b>+ Add</b> to create the first entry.')}
      <div style="margin-top:1rem;display:flex;gap:.5rem"><button id="add-row">+ Add</button><span style="flex:1"></span>
        <span class="unsaved" id="unsaved" ${UI.adminDirty ? '' : 'hidden'}>● Unsaved changes</span>
        <button id="revert">Revert</button><button class="primary" id="save">Save ${esc(def.title.toLowerCase())}</button></div>`;
    $('#my-name-form', body)?.addEventListener('submit', (e) => {
      e.preventDefault();
      guarded(async () => {
        S.config = await api('PUT', '/api/config', { ...S.config, myName: e.target.elements.myName.value });
        toast('Your name is saved');
        await render();
      });
    });
    $$('input[data-i]', body).forEach((inp) => (inp.oninput = () => {
      draft[inp.dataset.i][inp.dataset.k] = inp.value;
      markDirty();
    }));
    $$('[data-del]', body).forEach((b) => (b.onclick = () => {
      const item = draft[b.dataset.del];
      const n = item.id ? usage(item) : 0;
      if (n && !confirm(`"${item.name}" is used ${n} time(s). Remove anyway? Existing references will show the raw id.`)) return;
      draft.splice(b.dataset.del, 1);
      UI.adminDirty = true;
      draw();
    }));
    $('#add-row', body).onclick = () => {
      draft.push(key === 'buckets' ? { name: '', category: 'Topic', color: '#4f46e5' } : { name: '' });
      UI.adminDirty = true;
      draw();
      $$('input[data-k="name"]', body).pop()?.focus();
    };
    $('#revert', body).onclick = () => {
      UI.adminDirty = false;
      render();
    };
    $('#save', body).onclick = () => guarded(async () => {
      if (draft.some((x) => !String(x.name || '').trim())) return toast('Every row needs a name (or remove empty rows)', true);
      S.config = await api('PUT', '/api/config', { ...S.config, [key]: draft });
      UI.adminDirty = false;
      toast('Saved');
      await render();
    });
  };
  draw();
}

async function adminBackup(body) {
  const st = await api('GET', '/api/backups');
  body.innerHTML = `
    <p class="muted" style="margin-top:0">All your data is in one database file: <span class="folder-path">${esc(st.database)}</span>. Backups are complete copies of it (people, settings, meetings, minutes, actions and files) that any SQLite tool can open.</p>
    <div class="row">
      <div class="field" style="flex:3"><label>Backup folder</label><input id="backup-folder" value="${esc(st.backupFolder)}" /></div>
      <div class="field" style="max-width:130px"><label>Keep last</label><input id="backup-keep" type="number" min="1" max="365" value="${st.backupKeep}" /></div>
    </div>
    <label class="toggle" style="margin-bottom:.8rem"><input type="checkbox" id="backup-auto" ${st.autoBackup ? 'checked' : ''}/> Automatic daily backup (while the dashboard is running)</label>
    <div style="display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;margin-bottom:1.2rem">
      <button id="backup-save">Save settings</button><button class="primary" id="backup-now">⬇ Backup now</button>
      <span class="muted small" id="backup-last">${st.lastBackup ? `Last backup: ${esc(fmtDateTime(st.lastBackup))}` : 'No backup yet'}</span>
    </div>
    <h3>Backups (${st.backups.length})</h3>
    ${st.backups.length ? `<table id="backup-list"><thead><tr><th>File</th><th>Created</th><th>Size</th><th></th></tr></thead><tbody>
      ${st.backups.map((b) => `<tr><td class="folder-path">${esc(b.name)}</td><td>${esc(fmtDateTime(b.createdAt))}</td><td>${fmtSize(b.size)}</td>
        <td class="actions-col"><a class="btn small" href="/api/backups/${enc(b.name)}/download">Download</a> <button type="button" class="small danger" data-restore="${esc(b.name)}">Restore</button></td></tr>`).join('')}</tbody></table>`
      : emptyState('No backups yet. Click <b>Backup now</b>.')}
    <p class="muted small" style="margin-top:1rem"><b>Restore</b> replaces all current data with the backup. Your current data is backed up first, so a restore can always be undone.</p>`;
  $$('[data-restore]', body).forEach((b) => (b.onclick = () => {
    const name = b.dataset.restore;
    if (!confirm(`Restore ${name}?\n\nAll current data is replaced by this backup. (Your current data is backed up first.)`)) return;
    guarded(async () => {
      await flushPendingSave();
      const r = await api('POST', `/api/backups/${enc(name)}/restore`);
      toast(`Restored ${r.restored} — previous data saved as ${r.safetyBackup}`);
      await render();
    });
  }));
  $('#backup-save', body).onclick = () => guarded(async () => {
    await api('PUT', '/api/backups/settings', { backupFolder: $('#backup-folder', body).value, backupKeep: Number($('#backup-keep', body).value), autoBackup: $('#backup-auto', body).checked });
    toast('Backup settings saved');
    await render();
  });
  $('#backup-now', body).onclick = () => guarded(async () => {
    const r = await api('POST', '/api/backups');
    toast(`Backup created: ${r.name} (${fmtSize(r.size)})`);
    await render();
  });
}

function adminForums(body) {
  body.innerHTML = `
    <p class="muted" style="margin-top:0">Everyone you meet with (one person or a group). Archiving hides them and their meetings; nothing is deleted.</p>
    ${S.forums.length ? `<table><thead><tr><th>Person / group</th><th>Type</th><th>Attendees</th><th>How often</th><th>Meetings</th><th></th></tr></thead><tbody>
      ${S.forums.map((f) => `<tr><td><a href="${forumHref(f.id)}"><b>${esc(f.name)}</b></a></td><td>${esc(mtype(f.typeId)?.name || '—')}</td>
        <td>${peopleList(f.participantIds)}</td><td>${esc(f.cadence) || '—'}</td><td>${f.meetingCount}</td>
        <td class="actions-col"><button class="small" data-edit-forum="${esc(f.id)}">Edit</button> <button class="small danger" data-archive-forum="${esc(f.id)}">Archive</button></td></tr>`).join('')}
    </tbody></table>` : emptyState('Nobody yet.')}
    <div style="margin-top:1rem"><button class="primary" id="new-forum">+ New person / group</button></div>`;
  $('#new-forum', body).onclick = () => openForumDialog();
  $$('[data-edit-forum]', body).forEach((b) => (b.onclick = () => openForumDialog(S.forums.find((f) => f.id === b.dataset.editForum))));
  $$('[data-archive-forum]', body).forEach((b) => (b.onclick = () => {
    const id = b.dataset.archiveForum;
    if (!confirm(`Archive "${id}"? It is hidden together with its meetings (nothing is deleted).`)) return;
    guarded(async () => { await api('DELETE', `/api/forums/${enc(id)}`); toast('Person / group archived'); await render(); });
  }));
}

// ---------- router ----------
async function flushPendingSave() {
  if (pendingSave) {
    const s = pendingSave;
    pendingSave = null;
    await s();
  }
}

let renderSeq = 0;

async function render() {
  const app = $('#app');
  // Overlapping renders (e.g. navigation while a save re-renders) must not let a slower, older one win.
  const token = ++renderSeq;
  const isCurrent = () => token === renderSeq;
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  const page = { forum: 'group', forums: 'groups' }[parts[0]] || parts[0] || 'dashboard';
  const navPage = page === 'group' ? 'groups' : page === 'meeting' ? 'meetings' : page;
  $$('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === navPage));
  try {
    const overview = await api('GET', '/api/overview');
    if (!isCurrent()) return;
    Object.assign(S, overview);
    const openCount = S.actions.filter(isOpen).length;
    const badge = $('#nav-open');
    badge.textContent = openCount;
    badge.hidden = !openCount;
    $('#sidebar-foot').innerHTML = `<span title="All data is stored in this SQLite database on your computer">Database on this computer:<br>${esc(S.root)}</span><br><button type="button" class="link small" id="sign-out">Sign out</button>`;
    const scrollY = window.scrollY;
    if (page === 'dashboard') await viewDashboard(app);
    else if (page === 'meetings') await viewMeetings(app);
    else if (page === 'groups') await viewForums(app);
    else if (page === 'group') await viewForum(app, parts[1], isCurrent);
    else if (page === 'meeting') await viewMeeting(app, parts[1], parts[2], isCurrent);
    else if (page === 'actions') await viewActions(app);
    else if (page === 'admin') await viewAdmin(app);
    else app.innerHTML = '<h1>Not found</h1><a href="#/">Back to dashboard</a>';
    if (!isCurrent()) return;
    if (render.lastHash === location.hash) window.scrollTo(0, scrollY);
    render.lastHash = location.hash;
    document.title = `${$('h1', app)?.textContent.trim() || 'Meetings'} · Meetings`;
    document.body.dataset.rendered = location.hash;
  } catch (e) {
    if (!isCurrent()) return;
    if (e instanceof AuthError) return renderGate(e.message);
    app.innerHTML = `<div class="card"><h2>Something went wrong</h2><p>${esc(e.message)}</p><a href="#/">Back to dashboard</a></div>`;
    document.body.dataset.rendered = location.hash;
  }
}

window.addEventListener('hashchange', async () => {
  if (UI.revertingHash) {
    UI.revertingHash = false;
    return;
  }
  if (UI.adminDirty && location.hash !== render.lastHash) {
    if (!confirm('You have unsaved changes in Admin. Leave without saving?')) {
      UI.revertingHash = true;
      location.hash = render.lastHash || '#/admin';
      return;
    }
    UI.adminDirty = false;
  }
  const dlg = $('#dialog');
  if (dlg.open) dlg.close();
  await flushPendingSave();
  render();
});
window.addEventListener('beforeunload', (e) => {
  if (pendingSave || UI.adminDirty) e.preventDefault();
});

// Shortcuts and delegated buttons that appear on several pages.
document.addEventListener('keydown', (e) => {
  const k = e.key?.toLowerCase();
  if ((k !== 'n' && k !== 'a') || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target.closest('input, textarea, select, [contenteditable]') || $('#dialog').open) return;
  if (!S.config) return;
  e.preventDefault();
  if (k === 'a') return openAdhocDialog();
  const group = (location.hash.match(/^#\/(?:group|meeting)\/([^/]+)/) || [])[1];
  openNewMeetingDialog(group ? decodeURIComponent(group) : '');
});
// ---------- installable app (PWA) ----------
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  $('#install-app').hidden = false;
});
window.addEventListener('appinstalled', () => {
  $('#install-app').hidden = true;
  toast('Meetings installed — find it in your Start menu / taskbar');
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('#install-app') || !installPrompt) return;
  installPrompt.prompt();
  installPrompt.userChoice.finally(() => {
    installPrompt = null;
    $('#install-app').hidden = true;
  });
});

async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  render();
}

// ---------- sign-in and downloads via the local Meetings service ----------
async function renderGate(reason) {
  const app = $('#app');
  let status = null;
  if (reason !== 'offline') {
    try {
      status = await (await apiFetch('/api/auth/status')).json();
    } catch {
      reason = 'offline';
    }
  }
  $('#sidebar-foot').textContent = reason === 'offline' ? 'Not connected' : 'Not signed in';
  const card = (id, title, html) => `<div class="card callout connect" id="${id}"><h2>${title}</h2>${html}</div>`;
  let inner;
  if (reason === 'offline') {
    inner = card('gate-offline', '🔌 The Meetings service on this computer is not running', `
      <p>Your meetings are stored in <span class="folder-path">meetings.db</span> in your Meetings folder. The web app reads and writes it through a small background service on this computer, which isn't reachable right now.</p>
      <ol>
        <li>It starts automatically when you sign in to Windows. To start it now, double-click the <b>Meetings</b> shortcut on your desktop.</li>
        <li>If your browser asks to let this site <b>access apps and services on this device</b>, click <b>Allow</b>.</li>
      </ol>
      <div class="toolbar"><button class="primary" id="gate-retry">Try again</button></div>`);
  } else if (!status.passwordSet) {
    inner = card('gate-setup', '🔒 Create your password', `
      <p>Welcome! Choose a password to protect your meetings. Your data stays in <span class="folder-path">${esc(status.database)}</span> on this computer — nothing is uploaded.</p>
      <form id="setup-form" class="row" style="max-width:620px">
        <div class="field" style="flex:1;margin:0"><input type="password" name="password" placeholder="Password (min. 4 characters)" autocomplete="new-password" aria-label="Password" minlength="4" required /></div>
        <div class="field" style="flex:1;margin:0"><input type="password" name="repeat" placeholder="Repeat password" autocomplete="new-password" aria-label="Repeat password" required /></div>
        <button type="submit" class="primary">Create password</button>
      </form>`);
  } else {
    inner = card('gate-login', '🔒 Sign in', `
      <p>Enter your Meetings password. Your data stays in <span class="folder-path">meetings.db</span> on this computer — nothing is uploaded.</p>
      <form id="login-form" class="row" style="max-width:460px">
        <div class="field" style="flex:1;margin:0"><input type="password" name="password" placeholder="Password" autocomplete="current-password" aria-label="Password" required /></div>
        <button type="submit" class="primary">Sign in</button>
      </form>`);
  }
  app.innerHTML = `<div class="page-head"><div><h1>Meetings</h1><div class="subtitle">Prepare meetings, take minutes and track actions — your data stays on your computer.</div></div></div>${inner}`;
  document.title = 'Sign in · Meetings';
  document.body.dataset.rendered = `gate:${reason === 'offline' ? 'offline' : status.passwordSet ? 'login' : 'setup'}`;
  $('#gate-retry', app)?.addEventListener('click', () => render());
  const setup = $('#setup-form', app);
  if (setup) {
    setup.elements.password.focus();
    setup.onsubmit = (e) => {
      e.preventDefault();
      if (setup.elements.password.value !== setup.elements.repeat.value) return toast('The two passwords do not match', true);
      guarded(async () => {
        const r = await api('POST', '/api/auth/setup', { password: setup.elements.password.value });
        localStorage.setItem(TOKEN_KEY, r.token);
        toast('Password created — you are signed in');
        await render();
      });
    };
  }
  const form = $('#login-form', app);
  if (form) {
    form.elements.password.focus();
    form.onsubmit = (e) => {
      e.preventDefault();
      guarded(async () => {
        const r = await api('POST', '/api/auth/login', { password: form.elements.password.value });
        localStorage.setItem(TOKEN_KEY, r.token);
        toast('Signed in');
        await render();
      });
    };
  }
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('#sign-out')) return;
  guarded(async () => {
    await flushPendingSave();
    await api('POST', '/api/auth/logout').catch(() => {});
    localStorage.removeItem(TOKEN_KEY);
    await renderGate('login');
  });
});

// In the web app, downloads (export, files, backups) need the sign-in token, so they are fetched and saved here.
document.addEventListener('click', (e) => {
  const link = e.target.closest('a[href^="/api/"]');
  if (!link) return;
  e.preventDefault();
  guarded(async () => {
    const res = await apiFetch(link.getAttribute('href'));
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Download failed (${res.status})`);
    const name = decodeURIComponent((res.headers.get('content-disposition') || '').match(/filename\*=UTF-8''([^;]+)/)?.[1] || 'download');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(await res.blob());
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => (URL.revokeObjectURL(a.href), a.remove()), 1000);
  });
});

boot();
