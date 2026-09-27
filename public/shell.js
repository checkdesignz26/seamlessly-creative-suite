/**
 * Seamlessly Creative — suite shell.
 *
 * Owns: the project list, the persistent top bar (project name / save
 * status / project switcher / Download Project Backup), and which
 * studio is currently visible. The shell itself never touches a
 * studio's assets directly — it only creates/selects projects and
 * shows/hides each studio's iframe; each studio's own adapter (loaded
 * inside that iframe) does the actual reading/writing via
 * window.SCLibrary.
 *
 * IMPORTANT (found via real iPad testing): switching studios must NOT
 * reload a studio's iframe. Pattern Playground's own boot sequence
 * (index.html: hydrateSavedItemsFromIDB -> archiveAutosaveIfAny ->
 * setPreset('grid')) deliberately archives whatever pattern was live
 * into a new "unsaved work - ..." card and resets to a blank canvas on
 * EVERY load — by design in the standalone app ("every launch starts
 * on a genuinely blank canvas"), where "launch" only ever means
 * actually opening the app. An earlier version of this shell
 * reassigned one shared iframe's `src` on every studio switch, which
 * is indistinguishable from closing and reopening Playground - so
 * going Playground -> Mock-up Studio -> Playground silently archived
 * and blanked whatever pattern was on screen. Each studio now gets
 * its OWN iframe, created once and kept alive (just hidden, never
 * reloaded) for as long as the current project stays open, exactly
 * like switching tabs in a real app rather than closing and reopening
 * one. A studio's iframe IS torn down and recreated when the PROJECT
 * itself changes (a genuinely different project's data), since a
 * studio adapter only reads ?project= once, at load.
 *
 * "Last open project" / "last open studio" are a UI convenience,
 * stored under one localStorage key of the shell's own — not part of
 * any studio's data and not read by any studio.
 */
(function () {
  'use strict';

  const STUDIOS = [
    { id: 'playground', name: 'Pattern Playground', path: '/studios/playground/index.html', available: true },
    { id: 'resizer', name: 'Creative Resizer', path: '/studios/resizer/index.html', available: true },
    { id: 'mockup', name: 'Mock-up Studio', path: '/studios/mockup/index.html', available: true },
    { id: 'pages', name: 'Pattern Pages', path: '/studios/pages/index.html', available: true },
  ];

  const LAST_STATE_KEY = 'sc.shell.lastState.v1';

  const el = {
    projectName: document.getElementById('scProjectName'),
    projectSwitcher: document.getElementById('scProjectSwitcher'),
    projectList: document.getElementById('scProjectList'),
    newProjectBtn: document.getElementById('scNewProjectBtn'),
    statusDot: document.getElementById('scStatusDot'),
    statusText: document.getElementById('scStatusText'),
    backupBtn: document.getElementById('scBackupBtn'),
    studioTabs: document.getElementById('scStudioTabs'),
    frameHost: document.getElementById('scFrameHost'),
    emptyState: document.getElementById('scEmptyState'),
    createFirstBtn: document.getElementById('scCreateFirstBtn'),
  };

  let currentProjectId = null;
  let currentStudioId = null;
  let statusTimer = null;
  // studioId -> { iframe, projectId } — the iframe currently mounted
  // for that studio, and which project it was opened for. Cleared and
  // rebuilt whenever the open PROJECT changes; left completely alone
  // when only the visible STUDIO changes.
  const mountedFrames = new Map();

  function readLastState() {
    try {
      return JSON.parse(localStorage.getItem(LAST_STATE_KEY) || '{}');
    } catch (e) {
      return {};
    }
  }

  function writeLastState(patch) {
    try {
      const next = Object.assign({}, readLastState(), patch);
      localStorage.setItem(LAST_STATE_KEY, JSON.stringify(next));
    } catch (e) {}
  }

  function setStatus(kind, label) {
    el.statusDot.className = 'sc-dot sc-dot-' + kind;
    el.statusText.textContent = label;
  }

  function flashSaved() {
    setStatus('saving', 'saving…');
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => setStatus('saved', 'saved'), 600);
  }

  window.addEventListener('message', (e) => {
    if (!e.data || e.data.channel !== 'sc-status') return;
    if (e.data.status === 'saving') setStatus('saving', 'saving…');
    else if (e.data.status === 'saved') flashSaved();
    else setStatus('idle', 'idle');
  });

  async function refreshProjectSwitcher() {
    const projects = await window.SCLibrary.listProjects();
    el.projectList.innerHTML = '';
    projects.forEach((p) => {
      const row = document.createElement('div');
      row.className = 'sc-project-row';

      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'sc-project-item' + (p.id === currentProjectId ? ' active' : '');
      item.textContent = p.name;
      item.addEventListener('click', () => {
        el.projectSwitcher.removeAttribute('open');
        openProject(p.id);
      });

      // Requested so old test/throwaway projects (and whatever they
      // dragged into the shared asset library — a stress-test project
      // full of assets saved before a since-fixed storage bug, in the
      // case this was first asked for) can actually be cleared out,
      // not just abandoned. Its own button, not part of the row's main
      // click target, so a stray tap while switching projects can
      // never delete one by accident.
      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'sc-project-delete';
      deleteBtn.title = 'Delete project';
      deleteBtn.setAttribute('aria-label', 'Delete project "' + p.name + '"');
      deleteBtn.textContent = '✕';
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteProjectFlow(p);
      });

      row.appendChild(item);
      row.appendChild(deleteBtn);
      el.projectList.appendChild(row);
    });
    return projects;
  }

  function teardownAllFrames() {
    mountedFrames.forEach(({ iframe }) => iframe.remove());
    mountedFrames.clear();
  }

  // Deletes the project AND every asset in the shared project library
  // that belongs to it (SCLibrary.deleteProject already cascades that
  // — see project-library.js). Never touches any studio's own database
  // — a pattern saved inside Playground, a mock-up layout inside
  // Mock-up Studio, a .ppages autosave inside Pattern Pages are all
  // untouched; this only removes what the suite itself added to this
  // project's shared asset library.
  async function deleteProjectFlow(project) {
    const assetCount = (await window.SCLibrary.listAssets(project.id)).length;
    const warning = assetCount
      ? `Delete "${project.name}" and its ${assetCount} project asset${assetCount === 1 ? '' : 's'}? ` +
        `This only removes them from Seamlessly Creative's shared project library — nothing saved inside ` +
        `Pattern Playground, Mock-up Studio or Pattern Pages themselves is touched. This can't be undone.`
      : `Delete "${project.name}"? This can't be undone.`;
    if (!confirm(warning)) return;

    const wasCurrent = project.id === currentProjectId;
    await window.SCLibrary.deleteProject(project.id);

    if (!wasCurrent) {
      await refreshProjectSwitcher();
      return;
    }

    // Deleted the project that was actually open — its studio iframes
    // are showing data for a project that no longer exists, so they
    // have to go, the same as a genuine project switch does.
    teardownAllFrames();
    currentProjectId = null;
    writeLastState({ projectId: null });

    const remaining = await window.SCLibrary.listProjects();
    if (remaining.length) {
      await openProject(remaining[0].id);
    } else {
      await refreshProjectSwitcher();
      el.projectName.textContent = '';
      el.emptyState.hidden = false;
      el.frameHost.hidden = true;
    }
  }

  async function openProject(projectId) {
    const project = await window.SCLibrary.getProject(projectId);
    if (!project) return;
    const projectChanged = projectId !== currentProjectId;
    currentProjectId = projectId;
    el.projectName.textContent = project.name;
    writeLastState({ projectId });
    setStatus('saved', 'saved');
    el.emptyState.hidden = true;
    el.frameHost.hidden = false;
    // A genuinely different project's studios must reload (each
    // adapter only reads ?project= once, at load) — but switching
    // projects is a deliberate, occasional action, not the routine
    // back-and-forth a studio switch is, so losing in-progress work
    // here is expected the same way it would be opening a different
    // document.
    if (projectChanged) teardownAllFrames();
    await refreshProjectSwitcher();
    openStudio(currentStudioId || 'playground');
  }

  function openStudio(studioId) {
    const studio = STUDIOS.find((s) => s.id === studioId) || STUDIOS[0];
    if (!studio.available) return;
    currentStudioId = studio.id;
    writeLastState({ studioId: studio.id });
    [...el.studioTabs.children].forEach((btn) => {
      const isActive = btn.dataset.studio === studio.id;
      btn.classList.toggle('active', isActive);
      // The tab strip scrolls horizontally at narrower widths (see
      // shell.css) — never leave the studio someone just opened
      // scrolled out of view.
      if (isActive) btn.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    });

    let mounted = mountedFrames.get(studio.id);
    if (!mounted) {
      const iframe = document.createElement('iframe');
      iframe.className = 'sc-studio-frame';
      iframe.title = studio.name;
      iframe.src = studio.path + '?project=' + encodeURIComponent(currentProjectId);
      el.frameHost.appendChild(iframe);
      mounted = { iframe, projectId: currentProjectId };
      mountedFrames.set(studio.id, mounted);
    }
    mountedFrames.forEach((m, id) => {
      m.iframe.classList.toggle('active', id === studio.id);
    });
  }

  function buildStudioTabs() {
    el.studioTabs.innerHTML = '';
    STUDIOS.forEach((studio) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sc-tab';
      btn.dataset.studio = studio.id;
      btn.textContent = studio.available ? studio.name : studio.name + ' (soon)';
      btn.disabled = !studio.available;
      btn.addEventListener('click', () => openStudio(studio.id));
      el.studioTabs.appendChild(btn);
    });
  }

  async function createProject(promptDefault) {
    const name = prompt('Project name', promptDefault || 'New collection');
    if (!name) return null;
    const project = await window.SCLibrary.createProject(name.trim());
    await openProject(project.id);
    return project;
  }

  el.newProjectBtn.addEventListener('click', () => createProject());
  el.createFirstBtn.addEventListener('click', () => createProject('Café Latte Collection'));

  // Real bug found on iPad Safari: the old version prepared the
  // backup (several awaited IndexedDB reads) and THEN called
  // a.click() itself, all inside this one handler. Safari only
  // honours a file-save triggered synchronously within the tap that
  // started it — once anything is awaited first, Safari silently
  // drops the save with no error, which read as "nothing happens" /
  // "can't download a project". Chromium (used for testing this)
  // doesn't enforce that as strictly, so it worked in every automated
  // test and only failed on the real device.
  //
  // Fixed as two real taps instead of one: this button prepares the
  // file (as slow as it needs to be), then a SEPARATE, genuine <a
  // download> link appears for the user to tap — that second tap is
  // its own fresh gesture, so Safari allows it.
  const backupLink = document.createElement('a');
  backupLink.id = 'scBackupLink';
  backupLink.hidden = true;
  backupLink.textContent = '⬇ tap to save backup';
  el.backupBtn.insertAdjacentElement('afterend', backupLink);

  function resetBackupUI() {
    el.backupBtn.hidden = false;
    el.backupBtn.disabled = false;
    el.backupBtn.textContent = 'Download Project Backup';
    backupLink.hidden = true;
    if (backupLink.href) URL.revokeObjectURL(backupLink.href);
    backupLink.removeAttribute('href');
  }

  el.backupBtn.addEventListener('click', async () => {
    if (!currentProjectId) return;
    el.backupBtn.disabled = true;
    el.backupBtn.textContent = 'preparing…';
    try {
      const result = await window.SCLibrary.prepareProjectBackup(currentProjectId);
      backupLink.href = URL.createObjectURL(result.blob);
      backupLink.download = result.filename;
      // A per-asset failure (see exportProjectBackup's own comment)
      // no longer blocks the whole backup — surface it here instead
      // of hiding it, so "some of my patterns are missing from this
      // backup" has an explanation rather than being a silent gap.
      backupLink.textContent = result.skippedCount
        ? `⬇ tap to save (${result.assetCount - result.skippedCount} of ${result.assetCount} assets — ${result.skippedCount} too damaged to back up)`
        : `⬇ tap to save (${result.assetCount} assets)`;
      el.backupBtn.hidden = true;
      backupLink.hidden = false;
    } catch (err) {
      console.error('[suite] backup failed', err);
      el.backupBtn.textContent = 'backup failed';
      setTimeout(resetBackupUI, 2500);
    }
  });

  backupLink.addEventListener('click', () => {
    // Let the browser's native download actually happen (don't
    // preventDefault) — just reset back to the normal button a
    // moment later, after the tap has done its job.
    setTimeout(resetBackupUI, 400);
  });

  async function boot() {
    buildStudioTabs();
    const projects = await refreshProjectSwitcher();
    const last = readLastState();
    currentStudioId = last.studioId || 'playground';

    if (last.projectId && projects.some((p) => p.id === last.projectId)) {
      await openProject(last.projectId);
      return;
    }
    if (projects.length) {
      await openProject(projects[0].id);
      return;
    }
    el.emptyState.hidden = false;
    el.frameHost.hidden = true;
  }

  boot();
})();
