/**
 * Seamlessly Creative — suite shell.
 *
 * Owns: the project list, the persistent top bar (project name / save
 * status / project switcher / Download Project Backup), and which
 * studio is currently loaded in the iframe. The shell itself never
 * touches a studio's assets directly — it only creates/selects
 * projects and swaps the iframe's src; each studio's own adapter
 * (loaded inside that iframe) does the actual reading/writing via
 * window.SCLibrary.
 *
 * "Last open project" / "last open studio" are a UI convenience,
 * stored under one localStorage key of the shell's own — not part of
 * any studio's data and not read by any studio.
 */
(function () {
  'use strict';

  const STUDIOS = [
    { id: 'playground', name: 'Pattern Playground', path: '/studios/playground/index.html', available: true },
    { id: 'mockup', name: 'Mock-up Studio', path: '/studios/mockup/index.html', available: true },
    { id: 'resizer', name: 'Creative Resizer', path: null, available: false },
    { id: 'pages', name: 'Pattern Pages', path: null, available: false },
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
    frame: document.getElementById('scStudioFrame'),
    emptyState: document.getElementById('scEmptyState'),
    createFirstBtn: document.getElementById('scCreateFirstBtn'),
  };

  let currentProjectId = null;
  let currentStudioId = null;
  let statusTimer = null;

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
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'sc-project-item' + (p.id === currentProjectId ? ' active' : '');
      item.textContent = p.name;
      item.addEventListener('click', () => {
        el.projectSwitcher.removeAttribute('open');
        openProject(p.id);
      });
      el.projectList.appendChild(item);
    });
    return projects;
  }

  async function openProject(projectId) {
    const project = await window.SCLibrary.getProject(projectId);
    if (!project) return;
    currentProjectId = projectId;
    el.projectName.textContent = project.name;
    writeLastState({ projectId });
    setStatus('saved', 'saved');
    el.emptyState.hidden = true;
    el.frame.hidden = false;
    await refreshProjectSwitcher();
    openStudio(currentStudioId || 'playground');
  }

  function openStudio(studioId) {
    const studio = STUDIOS.find((s) => s.id === studioId) || STUDIOS[0];
    if (!studio.available) return;
    currentStudioId = studio.id;
    writeLastState({ studioId: studio.id });
    [...el.studioTabs.children].forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.studio === studio.id);
    });
    el.frame.src = studio.path + '?project=' + encodeURIComponent(currentProjectId);
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

  el.backupBtn.addEventListener('click', async () => {
    if (!currentProjectId) return;
    el.backupBtn.disabled = true;
    const original = el.backupBtn.textContent;
    el.backupBtn.textContent = 'preparing…';
    try {
      const result = await window.SCLibrary.downloadProjectBackup(currentProjectId);
      el.backupBtn.textContent = `✓ ${result.assetCount} assets`;
    } catch (err) {
      console.error('[suite] backup failed', err);
      el.backupBtn.textContent = 'backup failed';
    } finally {
      setTimeout(() => {
        el.backupBtn.textContent = original;
        el.backupBtn.disabled = false;
      }, 2500);
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
    el.frame.hidden = true;
  }

  boot();
})();
