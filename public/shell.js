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
    { id: 'sketchpad', name: 'Sketch Pad', path: '/studios/sketchpad/index.html', available: true },
    { id: 'resizer', name: 'Creative Resizer', path: '/studios/resizer/index.html', available: true },
    { id: 'mockup', name: 'Mock-up Studio', path: '/studios/mockup/index.html', available: true },
    { id: 'lookbook', name: 'Creative Lookbook', path: '/studios/lookbook/index.html', available: true },
    { id: 'pages', name: 'Pattern Pages', path: '/studios/pages/index.html', available: true },
  ];

  const LAST_STATE_KEY = 'sc.shell.lastState.v1';

  const el = {
    projectName: document.getElementById('scProjectName'),
    projectSwitcher: document.getElementById('scProjectSwitcher'),
    projectList: document.getElementById('scProjectList'),
    projectSummary: document.getElementById('scProjectSummary'),
    selectModeBtn: document.getElementById('scSelectModeBtn'),
    deleteAllBtn: document.getElementById('scDeleteAllBtn'),
    bulkBar: document.getElementById('scBulkBar'),
    bulkCount: document.getElementById('scBulkCount'),
    bulkDeleteBtn: document.getElementById('scBulkDeleteBtn'),
    bulkCancelBtn: document.getElementById('scBulkCancelBtn'),
    newProjectBtn: document.getElementById('scNewProjectBtn'),
    statusDot: document.getElementById('scStatusDot'),
    statusText: document.getElementById('scStatusText'),
    backupBtn: document.getElementById('scBackupBtn'),
    restoreBtn: document.getElementById('scRestoreBtn'),
    restoreInput: document.getElementById('scRestoreInput'),
    studioTabs: document.getElementById('scStudioTabs'),
    frameHost: document.getElementById('scFrameHost'),
    emptyState: document.getElementById('scEmptyState'),
    createFirstBtn: document.getElementById('scCreateFirstBtn'),
  };

  let currentProjectId = null;
  let currentStudioId = null;
  let statusTimer = null;
  // "Select multiple" mode for the project switcher's bulk-delete flow — never affects the single
  // delete (✕) button on each row, which keeps working exactly as it always has.
  let selectionMode = false;
  let selectedIds = new Set();

  function formatBytes(bytes) {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let n = bytes, i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return (i === 0 ? n : n.toFixed(1)) + ' ' + units[i];
  }
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
    // One size lookup per project, in parallel — reads raw byte lengths straight out of IndexedDB
    // (see getProjectAssetsSize), not full asset Blobs, so this stays cheap even with many/large
    // assets. Powers both each row's own size label and the "N projects · X MB total" summary.
    const sizes = await Promise.all(projects.map((p) => window.SCLibrary.getProjectAssetsSize(p.id)));
    const sizeById = new Map(projects.map((p, i) => [p.id, sizes[i]]));
    const totalBytes = sizes.reduce((sum, s) => sum + s.bytes, 0);

    el.projectSummary.textContent = projects.length
      ? `${projects.length} project${projects.length === 1 ? '' : 's'} · ${formatBytes(totalBytes)} total`
      : 'No projects yet';

    // Dropped (rather than discarded) any selected id that no longer exists — e.g. it was just
    // deleted by the very bulk action that triggered this refresh.
    const liveIds = new Set(projects.map((p) => p.id));
    selectedIds.forEach((id) => { if (!liveIds.has(id)) selectedIds.delete(id); });

    el.projectList.innerHTML = '';
    projects.forEach((p) => {
      const row = document.createElement('div');
      row.className = 'sc-project-row';

      let checkbox = null;
      if (selectionMode) {
        checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'sc-project-checkbox';
        checkbox.checked = selectedIds.has(p.id);
        checkbox.setAttribute('aria-label', 'Select project "' + p.name + '"');
        checkbox.addEventListener('click', (e) => e.stopPropagation());
        checkbox.addEventListener('change', () => {
          if (checkbox.checked) selectedIds.add(p.id); else selectedIds.delete(p.id);
          updateSelectionUI();
        });
      }

      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'sc-project-item' + (p.id === currentProjectId ? ' active' : '');
      const nameSpan = document.createElement('span');
      nameSpan.className = 'sc-project-item-name';
      nameSpan.textContent = p.name;
      const sizeSpan = document.createElement('span');
      sizeSpan.className = 'sc-project-item-size';
      const size = sizeById.get(p.id);
      sizeSpan.textContent = size && size.assetCount
        ? `${formatBytes(size.bytes)} · ${size.assetCount} asset${size.assetCount === 1 ? '' : 's'}`
        : 'empty';
      item.appendChild(nameSpan);
      item.appendChild(sizeSpan);
      item.addEventListener('click', () => {
        if (selectionMode) {
          checkbox.checked = !checkbox.checked;
          checkbox.dispatchEvent(new Event('change'));
          return;
        }
        el.projectSwitcher.removeAttribute('open');
        openProject(p.id);
      });

      // Own button, not part of the row's main click target, so a
      // stray tap while switching projects can never rename one by
      // accident. Hidden (not removed) in selection mode so the row's
      // layout doesn't jump when toggling modes.
      const renameBtn = document.createElement('button');
      renameBtn.type = 'button';
      renameBtn.className = 'sc-project-rename';
      renameBtn.title = 'Rename project';
      renameBtn.setAttribute('aria-label', 'Rename project "' + p.name + '"');
      renameBtn.textContent = '✎';
      renameBtn.hidden = selectionMode;
      renameBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        renameProjectFlow(p);
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
      deleteBtn.hidden = selectionMode;
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteProjectsFlow([p]);
      });

      if (checkbox) row.appendChild(checkbox);
      row.appendChild(item);
      row.appendChild(renameBtn);
      row.appendChild(deleteBtn);
      el.projectList.appendChild(row);
    });
    updateSelectionUI();
    return projects;
  }

  function updateSelectionUI() {
    el.selectModeBtn.textContent = selectionMode ? 'Cancel select' : 'Select';
    el.selectModeBtn.classList.toggle('active', selectionMode);
    el.bulkBar.hidden = !(selectionMode && selectedIds.size > 0);
    el.bulkCount.textContent = selectedIds.size + ' selected';
  }

  function exitSelectionMode() {
    selectionMode = false;
    selectedIds = new Set();
    refreshProjectSwitcher();
  }

  el.selectModeBtn.addEventListener('click', () => {
    selectionMode = !selectionMode;
    if (!selectionMode) selectedIds = new Set();
    refreshProjectSwitcher();
  });

  el.bulkCancelBtn.addEventListener('click', () => exitSelectionMode());

  el.bulkDeleteBtn.addEventListener('click', async () => {
    const projects = (await window.SCLibrary.listProjects()).filter((p) => selectedIds.has(p.id));
    await deleteProjectsFlow(projects);
  });

  el.deleteAllBtn.addEventListener('click', () => deleteAllProjectsFlow());

  // Renames via the same generic patch path project creation itself
  // uses (SCLibrary.touchProject) — no new storage or ID involved,
  // just an update to the one existing `name` field. If the renamed
  // project is the one currently open, the top bar's name is updated
  // in place too so it doesn't sit stale until the next project switch.
  async function renameProjectFlow(project) {
    const name = prompt('Rename project', project.name);
    if (!name || !name.trim() || name.trim() === project.name) return;
    await window.SCLibrary.touchProject(project.id, { name: name.trim() });
    if (project.id === currentProjectId) el.projectName.textContent = name.trim();
    await refreshProjectSwitcher();
  }

  function teardownAllFrames() {
    mountedFrames.forEach(({ iframe }) => iframe.remove());
    mountedFrames.clear();
  }

  // Deletes one or more projects AND every asset in the shared project
  // library that belongs to each one (SCLibrary.deleteProject already
  // cascades that per project — see project-library.js). Never touches
  // any studio's own database — a pattern saved inside Playground, a
  // mock-up layout inside Mock-up Studio, a .ppages autosave inside
  // Pattern Pages are all untouched; this only removes what the suite
  // itself added to the shared asset library for these projects.
  // Shared by the per-row ✕ button (a single-project array), "Delete
  // Selected" (the checked projects), and "Delete All" below (every
  // project, with its own stronger typed confirmation in place of this
  // one — see skipConfirm).
  async function deleteProjectsFlow(projects, opts) {
    if (!projects.length) return;
    opts = opts || {};

    if (!opts.skipConfirm) {
      const sizes = await Promise.all(projects.map((p) => window.SCLibrary.getProjectAssetsSize(p.id)));
      const totalAssets = sizes.reduce((sum, s) => sum + s.assetCount, 0);
      const totalBytes = sizes.reduce((sum, s) => sum + s.bytes, 0);
      const who = projects.length === 1 ? `"${projects[0].name}"` : `${projects.length} projects`;
      const warning = totalAssets
        ? `Delete ${who} and ${totalAssets} project asset${totalAssets === 1 ? '' : 's'} (${formatBytes(totalBytes)})? ` +
          `This only removes them from Seamlessly Creative's shared project library — nothing saved inside ` +
          `Pattern Playground, Mock-up Studio or Pattern Pages themselves is touched. This can't be undone.`
        : `Delete ${who}? This can't be undone.`;
      if (!confirm(warning)) return;
    }

    const ids = new Set(projects.map((p) => p.id));
    const hitCurrent = currentProjectId && ids.has(currentProjectId);

    for (const p of projects) {
      await window.SCLibrary.deleteProject(p.id);
    }

    selectionMode = false;
    selectedIds = new Set();

    if (!hitCurrent) {
      await refreshProjectSwitcher();
      return;
    }

    // One of the deleted projects was the one actually open — every
    // studio iframe mounted for it is showing data that no longer
    // exists anywhere (this is what makes the deletion "disappear
    // across all connected apps": each studio only ever reads its
    // project data through its own iframe, torn down here exactly like
    // a genuine project switch already does).
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

  // "Delete All" — for clearing out old test/throwaway projects in bulk. Deliberately a stronger
  // confirmation than a single/selected delete (typing an exact phrase, not just OK/Cancel) since
  // there's no selection step to review first and this can wipe every project in one action.
  async function deleteAllProjectsFlow() {
    el.projectSwitcher.removeAttribute('open');
    const projects = await window.SCLibrary.listProjects();
    if (!projects.length) {
      alert('No projects to delete.');
      return;
    }
    const sizes = await Promise.all(projects.map((p) => window.SCLibrary.getProjectAssetsSize(p.id)));
    const totalAssets = sizes.reduce((sum, s) => sum + s.assetCount, 0);
    const totalBytes = sizes.reduce((sum, s) => sum + s.bytes, 0);
    const typed = prompt(
      `This deletes ALL ${projects.length} project${projects.length === 1 ? '' : 's'} and ` +
      `${totalAssets} asset${totalAssets === 1 ? '' : 's'} (${formatBytes(totalBytes)}) from Seamlessly ` +
      `Creative's shared project library.\n\nNothing saved inside Pattern Playground, Mock-up Studio or ` +
      `Pattern Pages themselves is touched — only what the suite's project library holds. This can't be undone.\n\n` +
      `Type DELETE ALL to confirm:`
    );
    if (typed !== 'DELETE ALL') return;
    await deleteProjectsFlow(projects, { skipConfirm: true });
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

  // Upload Project Backup — the counterpart to Download above. Always
  // creates a brand-new project rather than merging into whatever's
  // currently open, so a restore can't silently mix into or overwrite
  // an unrelated project. No Safari two-tap trick needed here (that
  // workaround is only for triggering a file SAVE from code after an
  // await; reading a file the user just picked has no such issue), so
  // this is a normal single click -> file picker -> import.
  const restoreBtnDefaultText = el.restoreBtn.textContent;
  el.restoreBtn.addEventListener('click', () => el.restoreInput.click());
  el.restoreInput.addEventListener('change', async () => {
    const file = el.restoreInput.files && el.restoreInput.files[0];
    el.restoreInput.value = ''; // allow picking the same file again later
    if (!file) return;
    el.restoreBtn.disabled = true;
    el.restoreBtn.textContent = 'restoring…';
    try {
      const result = await window.SCLibrary.importProjectBackup(file);
      el.restoreBtn.textContent = result.skippedCount
        ? `restored ${result.importedCount} of ${result.totalCount} (${result.skippedCount} skipped)`
        : `restored ${result.importedCount} asset${result.importedCount === 1 ? '' : 's'} ✓`;
      await refreshProjectSwitcher();
      await openProject(result.project.id);
    } catch (err) {
      console.error('[suite] restore failed', err);
      el.restoreBtn.textContent = (err && err.message) || 'restore failed';
    } finally {
      setTimeout(() => {
        el.restoreBtn.disabled = false;
        el.restoreBtn.textContent = restoreBtnDefaultText;
      }, 3000);
    }
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
