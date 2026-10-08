/* intelio workspace UI — vanilla JS, works inside an opaque-origin sandboxed iframe (no storage, no window.confirm). */
(function () {
  'use strict';
  const $ = (s, el = document) => el.querySelector(s);
  const H = { 'X-Intelio-Workspace': '1', 'Content-Type': 'application/json' };
  const state = { tasks: [], config: null, current: null, convVersion: null, tab: 'changes', changes: null, term: null, termWin: 'shell', files: null, filePath: null, pollTimer: null };

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  async function api(path, opts = {}) {
    const res = await fetch(path, { method: opts.method || 'GET', headers: opts.body ? H : (opts.method === 'POST' ? H : {}), body: opts.body ? JSON.stringify(opts.body) : (opts.method === 'POST' ? '{}' : undefined), cache: 'no-store' });
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
    return data;
  }
  const post = (path, body) => api(path, { method: 'POST', body: body || {} });
  function toast(msg, ms = 3500) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.tm); toast.tm = setTimeout(() => { t.hidden = true; }, ms); }

  // ---------------------------------------------------------------- tiny markdown
  function md(src) {
    const parts = String(src || '').split(/```/);
    return parts.map((p, i) => {
      if (i % 2) { const nl = p.indexOf('\n'); return `<pre><code>${esc(nl >= 0 ? p.slice(nl + 1) : p)}</code></pre>`; }
      return esc(p).split(/\n{2,}/).map((para) => {
        if (!para.trim()) return '';
        let h = para.replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
          .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
          .replace(/^#{1,4} (.*)$/gm, '<strong>$1</strong>').replace(/^[-*] (.*)$/gm, '• $1');
        return `<p>${h.replace(/\n/g, '<br>')}</p>`;
      }).join('');
    }).join('');
  }

  // ---------------------------------------------------------------- modal helpers
  function modal(html) { $('#modalBox').innerHTML = html; $('#modal').hidden = false; return $('#modalBox'); }
  function closeModal() { $('#modal').hidden = true; $('#modalBox').innerHTML = ''; }
  $('#modal').addEventListener('mousedown', (e) => { if (e.target.id === 'modal') closeModal(); });
  function confirmBox(title, body, okLabel) {
    return new Promise((resolve) => {
      const box = modal(`<h3>${esc(title)}</h3><div class="small">${body}</div><div class="modal-actions"><button class="btn" data-a="no">Cancel</button><button class="btn primary" data-a="yes">${esc(okLabel || 'Confirm')}</button></div>`);
      box.querySelector('[data-a=no]').onclick = () => { closeModal(); resolve(false); };
      box.querySelector('[data-a=yes]').onclick = () => { closeModal(); resolve(true); };
    });
  }

  // ---------------------------------------------------------------- sidebar
  function statusIcon(s) {
    if (s === 'running') return '<span class="st"><span class="spinner"></span></span>';
    if (s === 'needs-you') return '<span class="st dot" title="Needs you"></span>';
    if (s === 'queued') return '<span class="st" title="Queued">◷</span>';
    if (s === 'failed') return '<span class="st failed" title="Failed">✕</span>';
    if (s === 'done') return '<span class="st done" title="Done">✓</span>';
    return '<span class="st icon-branch"></span>';
  }
  function ago(ts) {
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return 'just now'; if (s < 3600) return `${Math.floor(s / 60)}m ago`; if (s < 86400) return `${Math.floor(s / 3600)}h ago`; return `${Math.floor(s / 86400)}d ago`;
  }
  function renderTasks() {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const groups = { Today: [], 'Last 7 days': [], Older: [] };
    for (const t of state.tasks) {
      if (t.updated >= start.getTime()) groups.Today.push(t);
      else if (t.updated >= start.getTime() - 6 * 86400000) groups['Last 7 days'].push(t);
      else groups.Older.push(t);
    }
    let html = '';
    for (const [name, list] of Object.entries(groups)) {
      if (!list.length) continue;
      html += `<div class="section-title">${name}</div>`;
      for (const t of list) {
        html += `<div class="task-item ${state.current === t.id ? 'active' : ''}" data-id="${t.id}">${statusIcon(t.status)}<div class="ti-main"><div class="ti-title">${esc(t.title)}</div><div class="ti-sub"><span class="icon-branch"></span> ${esc(t.repo)} · ${ago(t.updated)}</div></div></div>`;
      }
    }
    if (!state.tasks.length) html += '<div class="section-title">Tasks</div><div class="muted small pad">No tasks yet.</div>';
    $('#taskList').innerHTML = html;
    for (const el of document.querySelectorAll('.task-item')) el.onclick = () => selectTask(el.dataset.id);
  }
  async function refreshTasks() {
    try { state.tasks = (await api('api/tasks')).tasks; renderTasks(); } catch (e) { toast(e.message); }
  }

  // ---------------------------------------------------------------- new task
  function modelOptions(selected) {
    const sel = selected ? `${selected.provider}/${selected.model}` : `${state.config.defaultModel.provider}/${state.config.defaultModel.model}`;
    return state.config.providers.map((p) => `<optgroup label="${esc(p.label)}${!p.signedIn ? ' — needs sign-in' : p.state === 'no-working-models' ? ' — no working models' : ''}">${(p.models.length ? p.models : [{ id: '(no models)' }]).map((m) => {
      const v = `${p.id}/${m.id}`;
      const mark = m.probe ? (m.probe.ok ? ' ✓' : ' ✕') : '';
      return `<option value="${esc(v)}" ${p.signedIn && m.id !== '(no models)' ? '' : 'disabled'} ${v === sel ? 'selected' : ''}>${esc(m.id)}${mark}</option>`;
    }).join('')}</optgroup>`).join('');
  }
  function parseModel(v) { const i = v.indexOf('/'); return { provider: v.slice(0, i), model: v.slice(i + 1) }; }
  function helperBoxes(checked) {
    return state.config.helpers.map((h) => `<label class="${h.state === 'ready' ? '' : 'disabled'}" title="${h.state === 'ready' ? 'Signed in' : esc(`${h.state} — ${h.login}`)}"><input type="checkbox" name="helper" value="${h.id}" ${checked.includes(h.id) ? 'checked' : ''} ${h.state === 'ready' ? '' : 'disabled'}><span>${esc(h.label)}${h.state === 'ready' ? '' : ` (${h.state.replace(/-/g, ' ')})`}</span></label>`).join('');
  }
  window.openNewTask = async function () {
    let repos = [];
    try { repos = (await api('api/repos')).repos; } catch (e) { toast(e.message); }
    const box = modal(`<h3>New task <span class="muted small">· runs on Hermes (builder)</span></h3>
      <div class="field"><label>Repository</label><select id="ntRepo">${repos.map((r) => `<option value="${esc(r.name)}">${esc(r.name)}${r.source === 'workspace' ? ' (workspace clone)' : ''}</option>`).join('')}<option value="__gh">Clone from GitHub…</option></select></div>
      <div class="field" id="ntGhWrap" hidden><label>GitHub repo (owner/repo)</label><div class="row"><input id="ntGh" placeholder="inteliodev/strength-flow-site"><button class="btn small" id="ntGhCheck" type="button">Check</button></div><div id="ntGhMsg" class="small muted"></div></div>
      <div class="field"><label>Start from</label><div class="seg"><label><input type="radio" name="from" value="new" checked><span>New branch</span></label><label><input type="radio" name="from" value="pr"><span>Existing PR</span></label></div></div>
      <div class="field" id="ntPrWrap" hidden><label>PR number or URL</label><input id="ntPr" placeholder="12 or https://github.com/owner/repo/pull/12"></div>
      <div class="field"><label>Title</label><input id="ntTitle" maxlength="200" placeholder="Optional — defaults to the first line of the brief / the PR title"></div>
      <div class="field"><label>Brief</label><textarea id="ntBrief" rows="7" placeholder="What should Hermes do?"></textarea></div>
      <div class="field"><label>Model</label><select id="ntModel">${modelOptions(null)}</select></div>
      <div class="field"><label>Hermes may hand work to</label><div class="seg">${helperBoxes([])}</div></div>
      <div class="modal-actions"><button class="btn" id="ntCancel">Cancel</button><button class="btn primary" id="ntCreate">Start task</button></div>`);
    const sel = box.querySelector('#ntRepo');
    let ghOk = null;
    sel.onchange = () => { box.querySelector('#ntGhWrap').hidden = sel.value !== '__gh'; };
    if (!repos.length) { sel.value = '__gh'; sel.onchange(); }
    for (const r of box.querySelectorAll('input[name=from]')) r.onchange = () => { box.querySelector('#ntPrWrap').hidden = box.querySelector('input[name=from]:checked').value !== 'pr'; };
    box.querySelector('#ntGhCheck').onclick = async () => {
      const v = box.querySelector('#ntGh').value.trim();
      box.querySelector('#ntGhMsg').textContent = 'Checking…';
      try { const r = await post('api/repos/validate', { repo: v }); ghOk = r.ok ? r.nameWithOwner : null; box.querySelector('#ntGhMsg').textContent = r.ok ? `✓ ${r.nameWithOwner} (${r.visibility.toLowerCase()}, default ${r.defaultBranch})` : `✕ ${r.error}`; }
      catch (e) { box.querySelector('#ntGhMsg').textContent = e.message; }
    };
    box.querySelector('#ntCancel').onclick = closeModal;
    box.querySelector('#ntCreate').onclick = async () => {
      let repo = sel.value;
      if (repo === '__gh') {
        const v = box.querySelector('#ntGh').value.trim();
        if (ghOk !== v) { await box.querySelector('#ntGhCheck').onclick(); if (!ghOk) return; }
        repo = ghOk;
      }
      const fromPr = box.querySelector('input[name=from]:checked').value === 'pr';
      const body = {
        repo, title: box.querySelector('#ntTitle').value, brief: box.querySelector('#ntBrief').value,
        pr: fromPr ? box.querySelector('#ntPr').value.trim() : '', model: parseModel(box.querySelector('#ntModel').value),
        helpers: [...box.querySelectorAll('input[name=helper]:checked')].map((x) => x.value),
      };
      if (fromPr && !body.pr) { toast('Enter the PR number or URL.'); return; }
      if (!fromPr && !body.brief.trim()) { toast('Write a brief first.'); return; }
      try { const r = await post('api/tasks', body); closeModal(); await refreshTasks(); selectTask(r.task.id); }
      catch (e) { toast(e.message, 6000); }
    };
    box.querySelector('#ntBrief').focus();
  };
  $('#statusLink').onclick = (e) => { e.preventDefault(); openStatus(); };
  async function openStatus(refresh) {
    if (refresh) { try { Object.assign(state.config, await post('api/status/refresh')); } catch (e) { toast(e.message); } }
    const c = state.config;
    const box = modal(`<h3>Hermes builder runtime</h3>
      <div class="small muted">Every task runs <code>hermes -p builder chat</code> in its worktree. Checked ${c.checkedAt ? ago(c.checkedAt) : 'never'}.</div>
      <div class="section-title">Model providers</div>
      ${c.providers.map((p) => `<div class="card-row" style="cursor:default"><span class="path">${esc(p.label)}</span><span class="${p.signedIn ? 'plus' : 'minus'}">${p.signedIn ? 'signed in' : 'needs sign-in'}</span></div>
        ${p.signedIn ? `<div class="pad small">${p.models.map((m) => `<span class="chip" data-probe="${esc(p.id)}/${esc(m.id)}" title="${esc(m.probe && m.probe.error || 'Click to test')}">${esc(m.id)}${m.probe ? (m.probe.ok ? ' ✓' : ' ✕') : ''}</span>`).join(' ')}</div>` : `<div class="pad small muted">Sign in on the VPS: <code>${esc(p.login)}</code></div>`}`).join('')}
      <div class="section-title">Helpers Hermes can delegate to</div>
      ${c.helpers.map((h) => `<div class="card-row" style="cursor:default"><span class="path">${esc(h.label)}</span><span class="${h.state === 'ready' ? 'plus' : 'minus'}">${esc(h.state.replace(/-/g, ' '))}</span></div>${h.state === 'ready' ? '' : `<div class="pad small muted">Sign in on the VPS: <code>${esc(h.login)}</code></div>`}`).join('')}
      <div class="modal-actions"><button class="btn" id="stRefresh">Re-check</button><button class="btn primary" id="stClose">Close</button></div>`);
    box.querySelector('#stClose').onclick = closeModal;
    box.querySelector('#stRefresh').onclick = () => openStatus(true);
    for (const chip of box.querySelectorAll('[data-probe]')) chip.onclick = async () => {
      chip.textContent += ' …';
      try { const m = parseModel(chip.dataset.probe); const r = await post('api/models/probe', m); toast(r.ok ? `${m.model} works` : `${m.model}: ${r.error}`, 6000); state.config = { ...state.config, ...(await api('api/config')) }; openStatus(); }
      catch (e) { toast(e.message); }
    };
  }
  $('#newTaskBtn').onclick = () => window.openNewTask();

  // ---------------------------------------------------------------- task view
  function curTask() { return state.tasks.find((t) => t.id === state.current) || null; }
  async function selectTask(id) {
    state.current = id; state.convVersion = null; state.changes = null; state.files = null; state.filePath = null;
    closeTerm();
    $('#empty').hidden = true; $('#taskView').hidden = false; $('#right').hidden = false;
    $('#conversation').innerHTML = ''; $('#tab-changes').innerHTML = ''; $('#tab-desktop').innerHTML = ''; $('#fileTree').innerHTML = ''; $('#fileView').innerHTML = '<div class="muted pad">Select a file.</div>';
    renderTasks();
    const url = new URL(location.href); url.searchParams.set('task', id);
    try { history.replaceState(null, '', url); } catch { /* sandboxed */ }
    await pollTask(true);
    showTab(state.tab);
    api(`api/tasks/${id}/pr`).then(() => pollTask(true)).catch(() => {});
  }
  function renderHeader(t) {
    $('#taskTitle').textContent = t.title;
    $('#taskMeta').innerHTML = `${esc(t.repo)} · <span class="icon-branch"></span> ${esc(t.branch || '…')} · Hermes · ${esc(t.model ? t.model.model : '')}`;
    const st = $('#taskStatus'); st.className = `pill ${t.status}`; st.textContent = t.status === 'needs-you' ? 'needs you' : t.status + (t.pendingCount ? ` (+${t.pendingCount} queued)` : '');
    $('#stopBtn').hidden = !(t.status === 'running' || t.status === 'queued');
    $('#markDoneBtn').hidden = !(t.status === 'needs-you' || t.status === 'failed');
    $('#prBranch').textContent = t.branch; $('#prBase').textContent = t.base || '…';
    const link = $('#prLink');
    const ps = $('#prState');
    if (t.pr && t.pr.url) {
      link.hidden = false; link.href = t.pr.url; link.textContent = `PR #${t.pr.number || t.pr.url.split('/').pop()}`;
      ps.hidden = false; const st = t.pr.state === 'MERGED' ? 'merged' : t.pr.state === 'CLOSED' ? 'closed' : t.pr.draft ? 'draft' : 'open';
      ps.textContent = st + (t.pr.review ? ` · ${t.pr.review.toLowerCase().replace(/_/g, ' ')}` : ''); ps.className = `pill ${st === 'merged' ? 'done' : st === 'closed' ? 'failed' : st === 'draft' ? '' : 'running'}`;
    } else { link.hidden = true; ps.hidden = true; }
    const open = t.pr && t.pr.state === 'OPEN';
    $('#openPrBtn').hidden = !!t.pr;
    $('#readyBtn').hidden = !(open && t.pr.draft);
    $('#mergeBtn').hidden = !open;
    $('#pushBtn').disabled = !!t.crossRepo;
    const sel = $('#modelSelect');
    const cur = t.model ? `${t.model.provider}/${t.model.model}` : '';
    const sig = `${t.id}|${state.config.checkedAt}`;
    if (sel.dataset.sig !== sig) { sel.innerHTML = modelOptions(t.model); sel.dataset.sig = sig; }
    $('#helperChips').innerHTML = `helpers: ${state.config.helpers.map((h) => `<label title="${h.state === 'ready' ? '' : esc(h.login)}" style="${h.state === 'ready' ? '' : 'opacity:.5'}"><input type="checkbox" data-helper="${h.id}" ${(t.helpers || []).includes(h.id) ? 'checked' : ''} ${h.state === 'ready' ? '' : 'disabled'}>${esc(h.label)}</label>`).join(' ')}`;
    for (const cb of document.querySelectorAll('#helperChips input')) cb.onchange = async () => {
      const helpers = [...document.querySelectorAll('#helperChips input:checked')].map((x) => x.dataset.helper);
      try { await post(`api/tasks/${t.id}/helpers`, { helpers }); toast('Helpers updated for the next message.'); } catch (e) { toast(e.message); }
    };
    void cur;
  }

  function renderConversation(conv) {
    const box = $('#conversation');
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    let html = '';
    for (const turn of conv.turns) {
      if (turn.user != null) html += `<div class="msg-user"><div class="who">Hayden → Hermes</div>${esc(turn.user)}</div>`;
      const items = turn.items;
      const finalIdx = turn.running ? -1 : turn.final;
      let group = [];
      const flush = (open) => {
        if (!group.length) return;
        const n = group.filter((g) => g.kind === 'step').length;
        const label = n ? `${n} step${n === 1 ? '' : 's'}${group.some((g) => g.kind === 'assistant') ? ' · notes' : ''}` : 'Notes';
        html += `<details class="steps" ${open ? 'open' : ''}><summary>${label}</summary>${group.map(stepHtml).join('')}</details>`;
        group = [];
      };
      items.forEach((it, i) => {
        if (it.kind === 'note' || it.kind === 'error') { flush(false); html += `<div class="msg-${it.kind}">${esc(it.text)}</div>`; return; }
        if (i === finalIdx) { flush(false); html += `<div class="msg-asst final">${md(it.text)}</div>`; return; }
        if (it.kind === 'assistant' && turn.running && i === items.length - 1) { flush(false); html += `<div class="msg-asst">${md(it.text)}</div>`; return; }
        group.push(it);
      });
      flush(!!turn.running);
      if (turn.running && turn.user != null) html += '<div class="worked"><span class="spinner"></span> Working…</div>';
      else if (turn.elapsed) html += `<div class="worked">${esc(turn.elapsed)}${turn.code && turn.code !== 0 ? ` · exit ${esc(turn.code)}` : ''}</div>`;
    }
    box.innerHTML = html || '<div class="muted">Waiting for the runner…</div>';
    if (nearBottom || state.convVersion === null) box.scrollTop = box.scrollHeight;
  }
  function stepHtml(s) {
    if (s.kind === 'assistant') return `<div class="step"><div class="inner-msg">${md(s.text)}</div></div>`;
    const out = s.output ? `<pre>${esc(s.output)}</pre>` : '';
    return `<div class="step ${s.failed ? 'failed' : ''}"><details><summary><span class="tool">${s.running ? '<span class="spinner" style="display:inline-block"></span>' : esc(s.tool)}</span><span class="stitle">${esc(s.title)}</span>${s.exit != null && s.exit !== 0 ? `<span class="minus">exit ${esc(s.exit)}</span>` : ''}</summary>${out || '<div class="muted small">No output.</div>'}</details></div>`;
  }

  function renderChangesCard(ch) {
    const card = $('#changesCard');
    if (!ch || !ch.files.length) { card.hidden = true; return; }
    card.hidden = false;
    card.innerHTML = `<div class="card-head">${ch.files.length} file${ch.files.length === 1 ? '' : 's'} changed <span class="plus">+${ch.totals.add}</span> <span class="minus">-${ch.totals.del}</span><span class="spacer"></span><button class="btn ghost small" id="ccView">Review</button></div>`
      + ch.files.slice(0, 8).map((f, i) => `<div class="card-row" data-i="${i}"><span class="path">${esc(f.path)}</span><span class="plus">+${f.add}</span><span class="minus">-${f.del}</span></div>`).join('')
      + (ch.files.length > 8 ? `<div class="card-row muted">…and ${ch.files.length - 8} more</div>` : '');
    card.querySelector('#ccView').onclick = () => showTab('changes');
    for (const r of card.querySelectorAll('.card-row[data-i]')) r.onclick = () => { showTab('changes'); const el = document.getElementById(`df-${r.dataset.i}`); if (el) { el.open = true; el.scrollIntoView(); } };
  }

  async function pollTask(force) {
    const id = state.current;
    if (!id) return;
    try {
      const conv = await api(`api/tasks/${id}/conversation${!force && state.convVersion != null ? `?v=${state.convVersion}` : ''}`);
      if (id !== state.current) return;
      const idx = state.tasks.findIndex((t) => t.id === id);
      if (idx >= 0) state.tasks[idx] = conv.task; else state.tasks.unshift(conv.task);
      renderHeader(conv.task);
      if (!conv.unchanged) { renderConversation(conv); state.convVersion = conv.version; loadChanges(); }
    } catch (e) { toast(e.message); }
  }

  // ---------------------------------------------------------------- composer
  $('#composer').onsubmit = async (e) => {
    e.preventDefault();
    const text = $('#composerText').value.trim();
    if (!text || !state.current) return;
    try { await post(`api/tasks/${state.current}/message`, { text, model: parseModel($('#modelSelect').value) }); $('#composerText').value = ''; await pollTask(true); refreshTasks(); }
    catch (err) { toast(err.message); }
  };
  $('#composerText').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) $('#composer').requestSubmit(); });
  $('#stopBtn').onclick = async () => { try { await post(`api/tasks/${state.current}/stop`); await pollTask(true); refreshTasks(); } catch (e) { toast(e.message); } };
  $('#markDoneBtn').onclick = async () => { try { await post(`api/tasks/${state.current}/status`, { status: 'done' }); await pollTask(true); refreshTasks(); } catch (e) { toast(e.message); } };

  // ---------------------------------------------------------------- PR actions (explicit approval)
  $('#commitBtn').onclick = async () => {
    const t = curTask();
    try { const r = await post(`api/tasks/${t.id}/commit`, { message: t.title }); toast(r.committed ? 'Committed.' : r.message); await pollTask(true); }
    catch (e) { toast(e.message); }
  };
  $('#pushBtn').onclick = async () => {
    const t = curTask();
    toast('Pushing…', 20000);
    try { await post(`api/tasks/${t.id}/push`); toast(`Pushed ${t.branch}.`); await pollTask(true); }
    catch (e) { toast(e.message, 8000); }
  };
  $('#openPrBtn').onclick = async () => {
    const t = curTask();
    toast('Pushing and opening a draft PR…', 20000);
    try { const r = await post(`api/tasks/${t.id}/pr/open`); toast(`Draft PR: ${r.pr.url}`, 6000); await pollTask(true); }
    catch (e) { toast(e.message, 8000); }
  };
  $('#readyBtn').onclick = async () => {
    const t = curTask();
    try { await post(`api/tasks/${t.id}/ready`); toast('PR is ready for review.'); await pollTask(true); }
    catch (e) { toast(e.message); }
  };
  $('#mergeBtn').onclick = async () => {
    const t = curTask();
    const box = modal(`<h3>Merge to ${esc(t.base)}?</h3><div class="small">This lands <a href="${esc(t.pr.url)}" target="_blank" rel="noopener">PR #${esc(t.pr.number)}</a> (<code>${esc(t.branch)}</code>) on <strong>${esc(t.base)}</strong>${t.pr.draft ? ' (it is marked ready first)' : ''}. This click is your approval; a one-time grant is created for this merge and removed right after.</div>
      <div class="field" style="margin-top:10px"><label>Method</label><select id="mgMethod"><option value="squash">Squash and merge</option><option value="merge">Merge commit</option><option value="rebase">Rebase and merge</option></select></div>
      <div class="modal-actions"><button class="btn" id="mgNo">Cancel</button><button class="btn primary" id="mgYes">Approve &amp; merge</button></div>`);
    box.querySelector('#mgNo').onclick = closeModal;
    box.querySelector('#mgYes').onclick = async () => {
      const method = box.querySelector('#mgMethod').value; closeModal(); toast('Merging…', 20000);
      try { await post(`api/tasks/${t.id}/merge`, { method, confirm: 'merge-to-main' }); toast('Merged.'); await pollTask(true); refreshTasks(); }
      catch (e) { toast(e.message, 8000); }
    };
  };

  // ---------------------------------------------------------------- tabs
  for (const b of document.querySelectorAll('.tabs button')) b.onclick = () => showTab(b.dataset.tab);
  function showTab(tab) {
    state.tab = tab;
    for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('active', b.dataset.tab === tab);
    for (const el of document.querySelectorAll('.tab')) el.classList.toggle('active', el.id === `tab-${tab}`);
    if (!state.current) return;
    if (tab === 'changes') renderChanges();
    if (tab === 'desktop') loadDesktop();
    if (tab === 'terminal') openTerm();
    if (tab === 'files') loadFiles();
  }

  // ---------------------------------------------------------------- changes
  let changesBusy = false;
  async function loadChanges() {
    if (changesBusy || !state.current) return;
    changesBusy = true;
    try { const id = state.current; const ch = await api(`api/tasks/${id}/changes`); if (id === state.current) { state.changes = ch; renderChangesCard(ch); if (state.tab === 'changes') renderChanges(); } }
    catch (e) { /* worktree may not be ready yet */ }
    finally { changesBusy = false; }
  }
  function renderChanges() {
    const ch = state.changes; const el = $('#tab-changes');
    if (!ch) { el.innerHTML = '<div class="muted pad">Loading…</div>'; loadChanges(); return; }
    const open = new Set([...el.querySelectorAll('details.dfile[open]')].map((d) => d.dataset.path));
    const first = !el.querySelector('details.dfile');
    let html = `<div class="diff-summary"><strong>${ch.files.length}</strong> file${ch.files.length === 1 ? '' : 's'} <span class="plus">+${ch.totals ? ch.totals.add : 0}</span> <span class="minus">-${ch.totals ? ch.totals.del : 0}</span> <span class="muted small">vs origin/${esc(ch.base)}${ch.dirty ? ' · uncommitted changes' : ''}</span><span class="spacer"></span><button class="btn ghost small" id="chRefresh">Refresh</button></div>`;
    if (ch.commits && ch.commits.length) html += `<div class="commits"><div class="muted">${ch.commits.length} commit${ch.commits.length === 1 ? '' : 's'}</div>${ch.commits.map((c) => `<div><code>${esc(c.sha)}</code> ${esc(c.subject)} <span class="muted">· ${esc(c.when)}</span></div>`).join('')}</div>`;
    if (!ch.files.length) html += '<div class="muted pad">No changes yet.</div>';
    ch.files.forEach((f, i) => {
      const isOpen = first ? ch.files.length <= 6 : open.has(f.path);
      html += `<details class="dfile" id="df-${i}" data-path="${esc(f.path)}" ${isOpen ? 'open' : ''}><summary><span class="path">${esc(f.path)}</span><span class="muted small">${esc(f.status)}</span><span class="plus">+${f.add}</span><span class="minus">-${f.del}</span></summary><div class="diff">${diffHtml(f.patch)}</div></details>`;
    });
    el.innerHTML = html;
    el.querySelector('#chRefresh').onclick = () => { state.changes = null; renderChanges(); };
  }
  function diffHtml(p) {
    const lines = String(p || '').split('\n');
    let start = lines.findIndex((l) => l.startsWith('@@'));
    if (start < 0) start = lines.length;
    const meta = lines.slice(0, start).filter((l) => /^(new file|deleted file|rename|Binary)/.test(l));
    return meta.map((l) => `<div class="m">${esc(l)}</div>`).join('') + lines.slice(start).map((l) => {
      const c = l.startsWith('@@') ? 'h' : l.startsWith('+') ? 'a' : l.startsWith('-') ? 'd' : l.startsWith('\\') ? 'm' : '';
      return `<div class="${c}">${esc(l) || ' '}</div>`;
    }).join('');
  }

  // ---------------------------------------------------------------- desktop (dev-server preview)
  let deskTimer = null;
  async function loadDesktop() {
    clearTimeout(deskTimer);
    const id = state.current; const el = $('#tab-desktop');
    let st;
    try { st = await api(`api/tasks/${id}/preview`); } catch (e) { el.innerHTML = `<div class="pad msg-error">${esc(e.message)}</div>`; return; }
    if (id !== state.current || state.tab !== 'desktop') return;
    const frame = el.querySelector('iframe');
    if (st.state === 'stopped') {
      el.innerHTML = '<div class="desk-bar"><span class="muted">Dev server is not running.</span><span class="spacer"></span><button class="btn primary small" id="dkStart">Start dev server</button></div><div class="pad muted small">Runs <code>npm ci</code> (first time) and <code>npm run dev</code> in this worktree inside the task\'s tmux session (window “dev”), then serves it over Tailscale HTTPS.</div>';
      el.querySelector('#dkStart').onclick = async () => { try { await post(`api/tasks/${id}/preview/start`); loadDesktop(); } catch (e) { toast(e.message, 6000); } };
      return;
    }
    if (st.state === 'running' && frame && frame.dataset.url === st.url) { deskTimer = setTimeout(loadDesktop, 10000); return; }
    el.innerHTML = `<div class="desk-bar"><span class="pill ${st.state === 'running' ? 'done' : 'running'}">${st.state}</span><a href="${esc(st.url)}" target="_blank" rel="noopener" class="small">${esc(st.url)}</a><span class="spacer"></span><button class="btn ghost small" id="dkReload">Reload</button><button class="btn danger small" id="dkStop">Stop</button></div>`
      + (st.state === 'running' ? `<iframe class="desk-frame" data-url="${esc(st.url)}" src="${esc(st.url)}"></iframe>` : `<pre class="desk-log">${esc(st.log || 'Starting…')}</pre>`);
    el.querySelector('#dkStop').onclick = async () => { await post(`api/tasks/${id}/preview/stop`).catch((e) => toast(e.message)); loadDesktop(); };
    el.querySelector('#dkReload').onclick = () => { const f = el.querySelector('iframe'); if (f) f.src = f.src; else loadDesktop(); };
    deskTimer = setTimeout(loadDesktop, st.state === 'running' ? 10000 : 2000);
  }

  // ---------------------------------------------------------------- terminal
  function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
  function closeTerm() {
    if (state.term) { try { state.term.ws.close(); } catch { /* closed */ } try { state.term.xterm.dispose(); } catch { /* gone */ } state.term = null; }
    $('#term').innerHTML = '';
  }
  async function loadProcs() {
    try {
      const r = await api(`api/tasks/${state.current}/processes`);
      $('#procList').innerHTML = r.windows.map((w) => `<span class="chip ${w.name === state.termWin ? 'active' : ''}" data-w="${esc(w.name)}" title="${esc(w.command)} (pid ${w.pid})">${esc(w.name)} · ${esc(w.command)}</span>`).join(' ') || '<span class="muted small">none</span>';
      for (const c of document.querySelectorAll('#procList .chip')) c.onclick = () => { state.termWin = c.dataset.w; closeTerm(); openTerm(); };
    } catch { /* ignore */ }
  }
  function openTerm() {
    loadProcs();
    if (state.term && state.term.id === state.current && state.term.ws.readyState <= 1) { state.term.fit.fit(); return; }
    closeTerm();
    if (!window.Terminal) { $('#term').innerHTML = '<div class="pad msg-error">xterm.js failed to load.</div>'; return; }
    const xterm = new window.Terminal({ fontSize: 12.5, fontFamily: '"Geist Mono", ui-monospace, Consolas, monospace', cursorBlink: true, scrollback: 5000, theme: { background: '#111111', foreground: '#e6e6e6' } });
    const fit = new window.FitAddon.FitAddon();
    xterm.loadAddon(fit);
    xterm.open($('#term'));
    try { fit.fit(); } catch { /* hidden */ }
    const url = new URL(`ws/terminal/${state.current}`, location.href);
    url.protocol = 'wss:'; url.searchParams.set('window', state.termWin); url.searchParams.set('cols', xterm.cols); url.searchParams.set('rows', xterm.rows);
    const ws = new WebSocket(url.toString());
    ws.onmessage = (e) => xterm.write(typeof e.data === 'string' ? e.data : new Uint8Array(e.data));
    ws.onclose = () => xterm.write('\r\n\x1b[90m[disconnected — click Reconnect]\x1b[0m\r\n');
    xterm.onData((d) => { if (ws.readyState === 1) ws.send(d); });
    xterm.onResize(({ cols, rows }) => { if (ws.readyState === 1) ws.send(`\u0000${JSON.stringify({ resize: { cols, rows } })}`); });
    state.term = { id: state.current, xterm, ws, fit };
    xterm.focus();
  }
  $('#termReconnect').onclick = () => { closeTerm(); openTerm(); };
  window.addEventListener('resize', () => { if (state.term && state.tab === 'terminal') { try { state.term.fit.fit(); } catch { /* hidden */ } } });

  // ---------------------------------------------------------------- files
  async function loadFiles() {
    if (state.files) return;
    const id = state.current;
    try { const r = await api(`api/tasks/${id}/files`); if (id !== state.current) return; state.files = r.files; renderTree(); }
    catch (e) { $('#fileTree').innerHTML = `<div class="pad msg-error">${esc(e.message)}</div>`; }
  }
  function renderTree() {
    const root = {};
    for (const f of state.files) { let node = root; const parts = f.split('/'); parts.forEach((p, i) => { if (i === parts.length - 1) node[p] = f; else node = node[p] = (typeof node[p] === 'object' ? node[p] : {}); }); }
    const openDirs = state.openDirs || (state.openDirs = new Set());
    const rows = [];
    const walk = (node, depth, prefix) => {
      const entries = Object.entries(node).sort(([a, av], [b, bv]) => (typeof av === 'object') === (typeof bv === 'object') ? a.localeCompare(b) : (typeof av === 'object' ? -1 : 1));
      for (const [name, v] of entries) {
        const p = prefix ? `${prefix}/${name}` : name;
        if (typeof v === 'object') {
          const open = openDirs.has(p);
          rows.push(`<div class="tree-row" data-dir="${esc(p)}" style="padding-left:${8 + depth * 12}px">${open ? '▾' : '▸'} ${esc(name)}</div>`);
          if (open) walk(v, depth + 1, p);
        } else rows.push(`<div class="tree-row ${state.filePath === v ? 'active' : ''}" data-file="${esc(v)}" style="padding-left:${20 + depth * 12}px">${esc(name)}</div>`);
      }
    };
    walk(root, 0, '');
    $('#fileTree').innerHTML = rows.join('');
    for (const r of document.querySelectorAll('#fileTree .tree-row')) {
      r.onclick = () => {
        if (r.dataset.dir) { openDirs.has(r.dataset.dir) ? openDirs.delete(r.dataset.dir) : openDirs.add(r.dataset.dir); renderTree(); }
        else openFile(r.dataset.file);
      };
    }
  }
  async function openFile(p) {
    state.filePath = p; renderTree();
    try {
      const r = await api(`api/tasks/${state.current}/file?path=${encodeURIComponent(p)}`);
      const body = r.binary ? '<div class="pad muted">Binary file.</div>' : r.tooLarge ? '<div class="pad muted">File is larger than 1 MB.</div>'
        : `<div class="code-view">${r.content.split('\n').map((l) => `<div>${esc(l) || ' '}</div>`).join('')}</div>`;
      $('#fileView').innerHTML = `<div class="file-head">${esc(p)} <span class="muted">· ${r.size} bytes · read-only</span></div>${body}`;
    } catch (e) { $('#fileView').innerHTML = `<div class="pad msg-error">${esc(e.message)}</div>`; }
  }

  // ---------------------------------------------------------------- boot
  async function boot() {
    try { state.config = await api('api/config'); }
    catch (e) { document.body.innerHTML = `<div class="empty"><h2>intelio workspace</h2><p class="msg-error">${esc(e.message)}</p></div>`; return; }
    await refreshTasks();
    const qtab = new URLSearchParams(location.search).get('tab');
    if (['changes', 'desktop', 'terminal', 'files'].includes(qtab)) state.tab = qtab;
    const want = new URLSearchParams(location.search).get('task');
    if (want && state.tasks.some((t) => t.id === want)) selectTask(want);
    setInterval(() => { refreshTasks(); }, 5000);
    setInterval(async () => { try { Object.assign(state.config, await api('api/config')); } catch { /* offline */ } }, 30000);
    setInterval(() => { const t = curTask(); if (t) pollTask(false); }, 2000);
    setInterval(() => { if (state.current && (curTask() || {}).status === 'running') loadChanges(); if (state.tab === 'terminal' && state.current) loadProcs(); }, 8000);
  }
  boot();
})();
