/**
 * Intelio Bops-mode. This stays in the Intelio layer.
 *
 * Parallel work is app-side fan-out: one user message (typed or a voice
 * transcript) is split here, and each piece is its own Hermes session send.
 * Hermes is not given a new tool and does not see a secret.
 *
 * Handoff is a stub. Hermes has no peer-delegation tool in this build.
 * Intelio opens a session on the target profile (intelio, prc, alignment, hhp)
 * and sends a redacted handoff note. Profile keys stay on the VPS and are not
 * copied. The app can show a 2–4 screen grid. Dedicated email and a Twilio
 * in-app waveform are follow-ups, not this module.
 *
 * Login walls are a Secure Sign-in card. Field values stay on the write-only
 * effect and are never copied onto the run, the plan, or a status line.
 * Payments and other pauses are one status line. There is no approval card.
 */
(function intelioBops(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.IntelioBops = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function intelioBopsFactory() {
  const PROFILES = ['intelio', 'prc', 'alignment', 'hhp'];
  const NAMES = { intelio: 'intelio', prc: 'PRC', alignment: 'Alignment', hhp: 'HHP' };
  const HIGHLIGHT = { intelio: '#7a5cff', prc: '#059669', alignment: '#1d4ed8', hhp: '#d97706' };
  const DISPLAY_STREAM = '/api/display/ws';
  const HANDOFF_STUB = 'Hermes has no peer-delegation tool in this build. intelio opens a session on the target profile and sends a redacted handoff note. Profile keys stay on the VPS and are not copied.';

  function redactSecrets(text) {
    return String(text || '')
      .replace(/\b(?:sk|rk|pk|api|key|token|password|secret|bearer)[-_\s][A-Za-z0-9._~+/-]{6,}\b/gi, '[redacted]')
      .replace(/\b[A-Za-z0-9_-]{24,}\b/g, '[redacted]')
      .slice(0, 240);
  }

  function cleanTitle(text) {
    return redactSecrets(text).replace(/\s+/g, ' ').trim().slice(0, 80);
  }

  function splitTasks(text) {
    const raw = String(text || '').trim();
    if (!raw) return [];
    const lines = raw.split(/\n+/).map((line) => line.trim()).filter(Boolean);
    // A single sentence stays one task. Splitting on "and" turned the user's
    // own words into progress chips.
    const parts = lines.length >= 2
      ? lines.map((line) => line.replace(/^(\d+[.)]|[-*•])\s+/, ''))
      : [raw];
    return parts.slice(0, 8).map((title, index) => ({
      id: `task-${index + 1}`,
      title: cleanTitle(title) || `Task ${index + 1}`,
      status: 'running',
      blocker: null,
      dismissed: false,
      sessionId: '',
    }));
  }

  function planHandoff(text, fromProfile) {
    const match = String(text || '').match(/\b(?:hand(?:ed)?(?:\s+this|\s+off)?(?:\s+over)?\s+to|ask)\s+(intelio|prc|alignment|hhp)\b/i);
    if (!match) return null;
    const target = match[1].toLowerCase();
    if (!PROFILES.includes(target) || target === String(fromProfile || '').toLowerCase()) return null;
    const from = String(fromProfile || 'intelio').toLowerCase();
    return {
      target,
      targetName: NAMES[target],
      from,
      stub: true,
      note: redactSecrets(text),
      label: `handed to ${NAMES[target]}`,
      sessionTitle: `Handoff from ${NAMES[from] || from}`,
    };
  }

  function startRun({ text, profile = 'intelio', agentName = '' } = {}) {
    const id = PROFILES.includes(String(profile || '').toLowerCase()) ? String(profile).toLowerCase() : 'intelio';
    const tasks = splitTasks(text);
    return {
      profile: id,
      agentName: (String(agentName || '').toLowerCase() === 'intelio' ? 'intelio' : agentName) || NAMES[id] || 'intelio',
      tasks,
      focusedId: tasks[0]?.id || '',
      handoff: planHandoff(text, id),
      stopped: false,
      orchestration: tasks.length > 1 ? 'app-fan-out' : 'single-session',
    };
  }

  function workingHeader(run) {
    const count = run?.tasks?.length || 0;
    if (count < 2) return '';
    const active = run.tasks.some((task) => task.status === 'running');
    return active ? `Working on ${count} things` : `${count} things`;
  }

  function focusTask(run, taskId) {
    if (!run?.tasks?.some((task) => task.id === taskId)) return run;
    return { ...run, focusedId: taskId, tasks: run.tasks.map((task) => ({ ...task })) };
  }

  function stopAll(run) {
    if (!run) return run;
    return {
      ...run,
      stopped: true,
      tasks: run.tasks.map((task) => (task.status === 'running' ? { ...task, status: 'stopped' } : { ...task })),
    };
  }

  function domainFrom(signal) {
    const blob = `${signal?.url || ''} ${signal?.domain || ''} ${signal?.error || ''} ${signal?.message || ''} ${signal?.title || ''}`;
    const match = blob.match(/https?:\/\/([a-z0-9.-]+)/i) || blob.match(/\b((?:[a-z0-9-]+\.)+[a-z]{2,})\b/i);
    if (!match) return '';
    return match[1].toLowerCase().replace(/^www\./, '').replace(/[.:]+$/, '');
  }

  function cleanSelector(value) {
    const text = String(value || '').trim();
    if (!text || text.length > 300 || /[\r\n]/.test(text)) return '';
    return text;
  }

  function selectorsFrom(signal) {
    const raw = signal?.selectors && typeof signal.selectors === 'object' ? signal.selectors : {};
    const defaults = {
      username: 'input[autocomplete="username"], input[type="email"], input[name="username"], input[name="email"]',
      password: 'input[autocomplete="current-password"], input[name="password"], input[type="password"]:not([autocomplete="one-time-code"])',
      otp: 'input[autocomplete="one-time-code"], input[name="otp"], input[name="code"]',
    };
    return {
      username: cleanSelector(raw.username) || defaults.username,
      password: cleanSelector(raw.password) || defaults.password,
      otp: cleanSelector(raw.otp) || defaults.otp,
    };
  }

  function classifyBlocker(signal) {
    const text = `${signal?.code || ''} ${signal?.error || ''} ${signal?.message || ''} ${signal?.tool || ''} ${signal?.title || ''}`.toLowerCase();
    if (!text.trim()) return null;
    if (/payment|invoice|checkout|billing|\bpay\b/.test(text)) {
      return { kind: 'payment', statusLine: 'Payment paused. intelio does not submit payments.', moneyMove: false };
    }
    if (/login|sign in|signin|password|credential|otp/.test(text)) {
      return { kind: 'login', domain: domainFrom(signal), selectors: selectorsFrom(signal), moneyMove: false };
    }
    if (/human_has_control|approval_required|missing credential|blocked/.test(text)) {
      return { kind: 'pause', statusLine: 'Paused.', moneyMove: false };
    }
    return null;
  }

  function signalFromEvent(event, data) {
    const tool = data?.tool_name || data?.name || data?.tool || '';
    const error = data?.error || data?.message || data?.summary || '';
    const code = `${event || ''} ${data?.code || ''}`;
    const blocker = classifyBlocker({ code, error, tool, title: data?.title || error || tool });
    if (!blocker) return null;
    return { ok: false, error: String(error || code).slice(0, 180), code, title: blocker.title };
  }

  function applyTaskResult(run, taskId, result) {
    if (!run) return run;
    return {
      ...run,
      tasks: run.tasks.map((task) => {
        if (task.id !== taskId) return task;
        if (task.status === 'stopped') return task;
        if (result?.ok) return { ...task, status: 'done', blocker: null, note: '' };
        const blocker = classifyBlocker({ ...result, title: result?.title || task.title });
        if (blocker?.kind === 'login') {
          return {
            ...task,
            status: 'blocked',
            dismissed: false,
            note: '',
            blocker: { kind: 'login', domain: blocker.domain || '', selectors: blocker.selectors },
          };
        }
        return {
          ...task,
          status: 'paused',
          dismissed: false,
          blocker: null,
          note: blocker?.statusLine || 'Paused.',
        };
      }),
    };
  }

  function rememberSession(run, taskId, sessionId) {
    if (!run) return run;
    return {
      ...run,
      tasks: run.tasks.map((task) => (task.id === taskId ? { ...task, sessionId: String(sessionId || '') } : task)),
    };
  }

  function signInFor(task) {
    if (!task || task.status !== 'blocked' || task.blocker?.kind !== 'login' || task.dismissed) return null;
    const domain = task.blocker.domain || '';
    return {
      kind: 'signin',
      taskId: task.id,
      domain,
      title: domain || 'Secure sign-in',
      fields: [
        { id: 'username', label: 'Username', type: 'text', autocomplete: 'username' },
        { id: 'password', label: 'Password', type: 'password', autocomplete: 'current-password' },
        { id: 'otp', label: 'One-time code', type: 'password', autocomplete: 'one-time-code' },
      ],
      saveLabel: 'Save login',
      selectors: task.blocker.selectors || selectorsFrom(task.blocker),
      actions: [
        { id: 'submit', label: 'Submit' },
        { id: 'on-screen', label: 'Do it on screen' },
      ],
    };
  }

  function visibleSignIn(run) {
    const tasks = run?.tasks || [];
    const focused = tasks.find((task) => task.id === run.focusedId);
    return signInFor(focused) || signInFor(tasks.find((task) => task.status === 'blocked' && task.blocker?.kind === 'login'));
  }

  function submitSignIn(run, taskId, values = {}) {
    const task = run?.tasks?.find((item) => item.id === taskId);
    if (!task?.blocker || task.blocker.kind !== 'login') {
      return { run, effect: { type: 'noop', writeOnly: true, moneyMove: false } };
    }
    const next = {
      ...run,
      tasks: run.tasks.map((item) => (item.id === taskId ? { ...item, status: 'running', blocker: null, note: '' } : item)),
    };
    return {
      run: next,
      effect: {
        type: 'secure-signin',
        writeOnly: true,
        taskId,
        domain: task.blocker.domain || '',
        username: String(values.username || '').slice(0, 200),
        password: String(values.password || ''),
        otp: String(values.otp || ''),
        save: values.save === true,
        selectors: task.blocker.selectors || selectorsFrom(task.blocker),
        moneyMove: false,
      },
    };
  }

  function doOnScreen(run, taskId) {
    return {
      run: focusTask(run, taskId),
      effect: { type: 'on-screen', writeOnly: true, lease: 'human', taskId, moneyMove: false },
    };
  }

  function publicEffect(effect) {
    if (!effect) return null;
    return {
      type: effect.type || 'noop',
      taskId: effect.taskId || '',
      domain: effect.domain || '',
      save: effect.save === true,
      writeOnly: true,
      moneyMove: false,
      lease: effect.lease || '',
    };
  }

  function statusLines(run) {
    return (run?.tasks || []).filter((task) => task.note).map((task) => ({ taskId: task.id, text: task.note }));
  }

  function previewFor(run, caption) {
    const task = run?.tasks?.find((item) => item.id === run.focusedId) || run?.tasks?.[0];
    const profile = run?.profile || 'intelio';
    const rawName = run?.agentName || NAMES[profile] || 'intelio';
    const name = String(rawName).toLowerCase() === 'intelio' ? 'intelio' : rawName;
    return {
      badge: `${name} is browsing`,
      profile,
      taskId: task?.id || '',
      highlight: HIGHLIGHT[profile] || '#7a5cff',
      stream: DISPLAY_STREAM,
      caption: String(caption || ''),
    };
  }

  function viewModel(run, caption) {
    const tasks = run?.tasks || [];
    return {
      header: workingHeader(run),
      stopAll: tasks.some((task) => task.status === 'running'),
      pills: tasks.map((task) => ({
        id: task.id,
        title: task.title,
        status: task.status,
        focused: task.id === run.focusedId,
      })),
      signIn: visibleSignIn(run),
      statusLines: statusLines(run),
      handoff: run?.handoff ? { label: run.handoff.label, stub: true, target: run.handoff.target } : null,
      preview: previewFor(run, caption),
      orchestration: run?.orchestration || 'single-session',
    };
  }

  function executionPlan(run) {
    const many = (run?.tasks?.length || 0) > 1;
    return {
      orchestration: many ? 'app-fan-out' : 'single-session',
      header: workingHeader(run),
      tasks: (run?.tasks || []).map((task) => ({
        taskId: task.id,
        profile: run.profile,
        input: task.title,
        createSession: many,
      })),
      handoff: run?.handoff ? {
        stub: true,
        profile: run.handoff.target,
        title: run.handoff.sessionTitle,
        input: `Handoff note: ${run.handoff.note}`,
      } : null,
    };
  }

  return {
    PROFILES,
    NAMES,
    HIGHLIGHT,
    DISPLAY_STREAM,
    HANDOFF_STUB,
    redactSecrets,
    splitTasks,
    startRun,
    workingHeader,
    focusTask,
    stopAll,
    classifyBlocker,
    signalFromEvent,
    applyTaskResult,
    rememberSession,
    signInFor,
    submitSignIn,
    doOnScreen,
    publicEffect,
    previewFor,
    viewModel,
    executionPlan,
  };
});
