(() => {
  'use strict';

  const FPS = 24;
  const MAX_IMPORT_BATCH = 10;
  const SNAP_PX_THRESHOLD = 8;
  const ALLOWED_EXTENSIONS = ['.mp4', '.mov', '.mkv', '.wav', '.mp3', '.m4a'];

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------
  const state = {
    systemStatus: {
      ffmpegFound: true,
      ffprobeFound: true,
      hwSupport: { h264_videotoolbox: false, hevc_videotoolbox: false },
      downloadsDir: '',
    },
    project: null,
    projectsList: [],
    historyByProject: new Map(), // projectId -> { undo: string[], redo: string[] }
    saveTimer: null,
    isDirty: false,

    selectedClip: null, // { trackKey, clipId }
    playheadFrame: 0,
    isPlaying: false,
    pxPerFrame: 4.0,

    peaksCache: new Map(), // sourceId -> number[]

    // Audio / Master Clock
    audioCtx: null,
    masterGain: null,
    analyserL: null,
    analyserR: null,
    videoNodesReady: false,
    videoGainA: null,
    videoGainB: null,
    audioNodePool: new Map(), // clipId -> { clipId, sourceId, audioEl, sourceNode, gainNode }

    // Dual video playback state
    activeVideoSlot: 'A',
    slotState: {
      A: { clipId: null, sourceId: null, preseekedSec: null, pendingSeekSec: null },
      B: { clipId: null, sourceId: null, preseekedSec: null, pendingSeekSec: null },
    },
    playStartAudioTime: 0,
    playStartTimelineSec: 0,
    rafId: null,

    // Folder browser modal state
    fsMode: 'link', // 'link' | 'relink'
    relinkSourceId: null,
    fsCurrentDir: '',
    fsParentDir: null,
    fsSelectedPaths: [],

    // Drag / trim interaction state
    dragSourceId: null,
    exportPollTimer: null,
  };

  // -------------------------------------------------------------------------
  // DOM Elements
  // -------------------------------------------------------------------------
  const el = {
    appFavicon: document.getElementById('app-favicon'),
    brandLogoImg: document.getElementById('brandLogoImg'),
    ffmpegBanner: document.getElementById('ffmpegBanner'),
    ffmpegBannerText: document.getElementById('ffmpegBannerText'),
    activeProjectName: document.getElementById('activeProjectName'),
    projectsBtn: document.getElementById('projectsBtn'),
    saveStatusBadge: document.getElementById('saveStatusBadge'),
    saveStatusText: document.getElementById('saveStatusText'),
    undoBtn: document.getElementById('undoBtn'),
    redoBtn: document.getElementById('redoBtn'),
    snapToggleBtn: document.getElementById('snapToggleBtn'),
    themeToggleBtn: document.getElementById('themeToggleBtn'),
    themeIcon: document.getElementById('themeIcon'),
    exportModalBtn: document.getElementById('exportModalBtn'),

    sourceCountPill: document.getElementById('sourceCountPill'),
    verifySourcesBtn: document.getElementById('verifySourcesBtn'),
    addFromDiskBtn: document.getElementById('addFromDiskBtn'),
    finderDropZone: document.getElementById('finderDropZone'),
    finderFileInput: document.getElementById('finderFileInput'),
    sourcesList: document.getElementById('sourcesList'),

    previewStage: document.getElementById('previewStage'),
    videoPlayerA: document.getElementById('videoPlayerA'),
    videoPlayerB: document.getElementById('videoPlayerB'),
    previewEmptyOverlay: document.getElementById('previewEmptyOverlay'),
    previewClipBadge: document.getElementById('previewClipBadge'),
    vuMeterCanvas: document.getElementById('vuMeterCanvas'),

    currentTimecode: document.getElementById('currentTimecode'),
    totalTimecode: document.getElementById('totalTimecode'),
    frameCounterBadge: document.getElementById('frameCounterBadge'),
    jumpStartBtn: document.getElementById('jumpStartBtn'),
    stepBackBtn: document.getElementById('stepBackBtn'),
    playPauseBtn: document.getElementById('playPauseBtn'),
    playPauseIcon: document.getElementById('playPauseIcon'),
    stepForwardBtn: document.getElementById('stepForwardBtn'),
    trimLeftBtn: document.getElementById('trimLeftBtn'),
    splitBtn: document.getElementById('splitBtn'),
    trimRightBtn: document.getElementById('trimRightBtn'),

    inspectorEmpty: document.getElementById('inspectorEmpty'),
    inspectorControls: document.getElementById('inspectorControls'),
    inspectorTrackBadge: document.getElementById('inspectorTrackBadge'),
    inspectorClipName: document.getElementById('inspectorClipName'),
    inspectorClipRange: document.getElementById('inspectorClipRange'),
    videoInspectorGroup: document.getElementById('videoInspectorGroup'),
    speedPresetSelect: document.getElementById('speedPresetSelect'),
    speedFineInput: document.getElementById('speedFineInput'),
    reverseToggleBtn: document.getElementById('reverseToggleBtn'),
    audioInspectorGroup: document.getElementById('audioInspectorGroup'),
    volumeRange: document.getElementById('volumeRange'),
    volumeLabel: document.getElementById('volumeLabel'),
    fadeInInput: document.getElementById('fadeInInput'),
    fadeOutInput: document.getElementById('fadeOutInput'),
    deleteClipBtn: document.getElementById('deleteClipBtn'),

    zoomFitBtn: document.getElementById('zoomFitBtn'),
    zoomSlider: document.getElementById('zoomSlider'),
    zoomScaleLabel: document.getElementById('zoomScaleLabel'),
    timelineViewport: document.getElementById('timelineViewport'),
    timelineInner: document.getElementById('timelineInner'),
    timelineRuler: document.getElementById('timelineRuler'),
    track1Lane: document.getElementById('track1Lane'),
    track2Lane: document.getElementById('track2Lane'),
    track3Lane: document.getElementById('track3Lane'),
    snapGuideLine: document.getElementById('snapGuideLine'),
    playheadEl: document.getElementById('playheadEl'),

    projectsModal: document.getElementById('projectsModal'),
    closeProjectsModalBtn: document.getElementById('closeProjectsModalBtn'),
    createProjectForm: document.getElementById('createProjectForm'),
    newProjectNameInput: document.getElementById('newProjectNameInput'),
    projectsList: document.getElementById('projectsList'),

    fsBrowserModal: document.getElementById('fsBrowserModal'),
    fsBrowserTitle: document.getElementById('fsBrowserTitle'),
    closeFsBrowserBtn: document.getElementById('closeFsBrowserBtn'),
    fsShortcuts: document.getElementById('fsShortcuts'),
    fsUpBtn: document.getElementById('fsUpBtn'),
    fsCurrentPath: document.getElementById('fsCurrentPath'),
    fsEntriesList: document.getElementById('fsEntriesList'),
    fsSelectionInfo: document.getElementById('fsSelectionInfo'),
    fsCancelBtn: document.getElementById('fsCancelBtn'),
    fsConfirmBtn: document.getElementById('fsConfirmBtn'),

    exportModal: document.getElementById('exportModal'),
    closeExportModalBtn: document.getElementById('closeExportModalBtn'),
    exportFilenameInput: document.getElementById('exportFilenameInput'),
    exportCodecSelect: document.getElementById('exportCodecSelect'),
    exportQualitySelect: document.getElementById('exportQualitySelect'),
    exportEncoderText: document.getElementById('exportEncoderText'),
    exportProgressArea: document.getElementById('exportProgressArea'),
    exportStatusText: document.getElementById('exportStatusText'),
    exportPercentText: document.getElementById('exportPercentText'),
    exportProgressBar: document.getElementById('exportProgressBar'),
    exportDoneActions: document.getElementById('exportDoneActions'),
    exportDownloadLink: document.getElementById('exportDownloadLink'),
    exportSavedPathNote: document.getElementById('exportSavedPathNote'),
    cancelExportBtn: document.getElementById('cancelExportBtn'),
    startExportBtn: document.getElementById('startExportBtn'),

    toastContainer: document.getElementById('toastContainer'),
  };

  // -------------------------------------------------------------------------
  // Utilities & Formatting
  // -------------------------------------------------------------------------
  function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    el.toastContainer.appendChild(toast);
    setTimeout(() => {
      toast.remove();
    }, 4200);
  }

  async function apiJson(url, options = {}) {
    const res = await fetch(url, options);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || `Request failed (${res.status})`);
    }
    return data;
  }

  function framesToTimecode(totalFrames) {
    const f = Math.max(0, Math.round(totalFrames));
    const frames = f % FPS;
    const totalSecs = Math.floor(f / FPS);
    const secs = totalSecs % 60;
    const mins = Math.floor(totalSecs / 60) % 60;
    const hrs = Math.floor(totalSecs / 3600);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(hrs)}:${pad(mins)}:${pad(secs)}:${pad(frames)}`;
  }

  function formatDurationShort(sec) {
    const s = Math.max(0, Number(sec) || 0);
    const mins = Math.floor(s / 60);
    const rem = (s % 60).toFixed(1).padStart(4, '0');
    return `${mins}:${rem}`;
  }

  function formatBytes(bytes) {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let idx = 0;
    let val = bytes;
    while (val >= 1024 && idx < units.length - 1) {
      val /= 1024;
      idx += 1;
    }
    return `${val.toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
  }

  function hasAllowedExtension(filename) {
    const lower = String(filename || '').toLowerCase();
    return ALLOWED_EXTENSIONS.some((ext) => lower.endsWith(ext));
  }

  function makeClipId() {
    return `clip_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  }

  function getSourceById(sourceId) {
    if (!state.project) return null;
    return (state.project.sources || []).find((s) => s.id === sourceId) || null;
  }

  function getClipDurationFrames(clip, trackKey) {
    const span = Math.max(1, (clip.outFrame || 0) - (clip.inFrame || 0));
    if (trackKey === 'track1') {
      const speed = Number(clip.speed) > 0 ? Number(clip.speed) : 1;
      return Math.max(1, Math.round(span / speed));
    }
    return span;
  }

  function getTotalTrack1Frames() {
    if (!state.project) return 0;
    const t1 = state.project.tracks?.track1 || [];
    return t1.reduce((sum, clip) => sum + getClipDurationFrames(clip, 'track1'), 0);
  }

  function getTotalProjectFrames() {
    if (!state.project) return 0;
    let maxF = getTotalTrack1Frames();
    for (const tk of ['track2', 'track3']) {
      for (const c of state.project.tracks?.[tk] || []) {
        const end = (c.timelineStartFrame || 0) + getClipDurationFrames(c, tk);
        if (end > maxF) maxF = end;
      }
    }
    return maxF;
  }

  function repackTrack1() {
    if (!state.project) return;
    let cursor = 0;
    for (const clip of state.project.tracks.track1) {
      clip.timelineStartFrame = cursor;
      cursor += getClipDurationFrames(clip, 'track1');
    }
  }

  function shiftAudioFromSegmentStart(segmentStartFrame, deltaFrames) {
    if (!state.project || deltaFrames === 0) return;
    for (const tk of ['track2', 'track3']) {
      for (const clip of state.project.tracks[tk]) {
        const curStart = clip.timelineStartFrame || 0;
        if (curStart >= segmentStartFrame) {
          clip.timelineStartFrame = Math.max(0, Math.round(curStart + deltaFrames));
        }
      }
    }
  }

  function getSnapTargets(excludeClipId = null) {
    if (!state.project) return [];
    const targets = new Set([0, state.playheadFrame]);
    for (const tk of ['track1', 'track2', 'track3']) {
      for (const c of state.project.tracks?.[tk] || []) {
        if (c.id === excludeClipId) continue;
        const start = c.timelineStartFrame || 0;
        const end = start + getClipDurationFrames(c, tk);
        targets.add(start);
        targets.add(end);
      }
    }
    return Array.from(targets);
  }

  function snapFrameIfEnabled(rawFrame, excludeClipId = null) {
    const rounded = Math.max(0, Math.round(rawFrame));
    if (!state.project?.snapEnabled) {
      return { frame: rounded, snappedTo: null };
    }
    const frameThreshold = SNAP_PX_THRESHOLD / state.pxPerFrame;
    const targets = getSnapTargets(excludeClipId);
    let bestFrame = rounded;
    let bestDist = Infinity;
    let snappedTo = null;

    for (const t of targets) {
      const dist = Math.abs(t - rounded);
      if (dist <= frameThreshold && dist < bestDist) {
        bestDist = dist;
        bestFrame = t;
        snappedTo = t;
      }
    }
    return { frame: bestFrame, snappedTo };
  }

  function showSnapGuide(snappedFrame) {
    if (snappedFrame === null || snappedFrame === undefined) {
      el.snapGuideLine.classList.add('hidden');
      return;
    }
    el.snapGuideLine.style.left = `${snappedFrame * state.pxPerFrame}px`;
    el.snapGuideLine.classList.remove('hidden');
  }

  // -------------------------------------------------------------------------
  // Theme (Day / Night Mode persisted in localStorage) & Transparent Favicon
  // -------------------------------------------------------------------------
  const faviconDataUrlCache = new Map();

  function buildTransparentFaviconDataUrl(img) {
    const size = 256;
    const workCanvas = document.createElement('canvas');
    workCanvas.width = size;
    workCanvas.height = size;
    const workCtx = workCanvas.getContext('2d', { willReadFrequently: true });
    workCtx.drawImage(img, 0, 0, size, size);

    const imgData = workCtx.getImageData(0, 0, size, size);
    const data = imgData.data;

    const bgR = data[0];
    const bgG = data[1];
    const bgB = data[2];
    const tolerance = 25;

    const visited = new Uint8Array(size * size);
    const queue = new Int32Array(size * size);
    let head = 0;
    let tail = 0;

    const enqueueIfBg = (idx) => {
      if (visited[idx]) return;
      const off = idx * 4;
      const dist = Math.hypot(data[off] - bgR, data[off + 1] - bgG, data[off + 2] - bgB);
      if (dist < tolerance) {
        visited[idx] = 1;
        queue[tail++] = idx;
      }
    };

    // Seed all 4 corners to clear connected outer JPEG background only
    enqueueIfBg(0);
    enqueueIfBg(size - 1);
    enqueueIfBg((size - 1) * size);
    enqueueIfBg(size * size - 1);

    while (head < tail) {
      const idx = queue[head++];
      data[idx * 4 + 3] = 0;

      const x = idx % size;
      const y = (idx - x) / size;
      if (x > 0) enqueueIfBg(idx - 1);
      if (x < size - 1) enqueueIfBg(idx + 1);
      if (y > 0) enqueueIfBg(idx - size);
      if (y < size - 1) enqueueIfBg(idx + size);
    }

    workCtx.putImageData(imgData, 0, 0);

    const outCanvas = document.createElement('canvas');
    outCanvas.width = 64;
    outCanvas.height = 64;
    const outCtx = outCanvas.getContext('2d');
    outCtx.imageSmoothingEnabled = true;
    outCtx.imageSmoothingQuality = 'high';
    outCtx.drawImage(workCanvas, 0, 0, 64, 64);

    return outCanvas.toDataURL('image/png');
  }

  function updateTransparentFavicon(resolvedTheme) {
    if (!el.appFavicon) return;
    if (faviconDataUrlCache.has(resolvedTheme)) {
      el.appFavicon.type = 'image/png';
      el.appFavicon.href = faviconDataUrlCache.get(resolvedTheme);
      return;
    }

    const srcUrl = resolvedTheme === 'light' ? '/LOGO_W.jpg' : '/LOGO_B.jpg';
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const dataUrl = buildTransparentFaviconDataUrl(img);
      faviconDataUrlCache.set(resolvedTheme, dataUrl);
      if (document.documentElement.dataset.theme === resolvedTheme && el.appFavicon) {
        el.appFavicon.type = 'image/png';
        el.appFavicon.href = dataUrl;
      }
    };
    img.src = srcUrl;
  }

  function applyTheme(theme) {
    const resolved = theme === 'light' ? 'light' : 'dark';
    document.documentElement.dataset.theme = resolved;
    localStorage.setItem('montage_theme', resolved);
    el.themeIcon.textContent = resolved === 'dark' ? 'light_mode' : 'dark_mode';
    if (el.brandLogoImg) {
      el.brandLogoImg.src = resolved === 'light' ? '/LOGO_W.jpg' : '/LOGO_B.jpg';
    }
    updateTransparentFavicon(resolved);
    drawTimelineRuler();
    renderAllTimelineClips();
  }

  // -------------------------------------------------------------------------
  // Undo / Redo & Debounced Auto-Save (2 seconds)
  // -------------------------------------------------------------------------
  function getProjectHistory() {
    if (!state.project) return { undo: [], redo: [] };
    if (!state.historyByProject.has(state.project.id)) {
      state.historyByProject.set(state.project.id, { undo: [], redo: [] });
    }
    return state.historyByProject.get(state.project.id);
  }

  function updateUndoRedoButtons() {
    const hist = getProjectHistory();
    el.undoBtn.disabled = hist.undo.length === 0;
    el.redoBtn.disabled = hist.redo.length === 0;
  }

  function captureSnapshot() {
    if (!state.project) return '';
    return JSON.stringify({
      tracks: state.project.tracks,
      snapEnabled: state.project.snapEnabled,
      rippleSyncAudio: state.project.rippleSyncAudio,
    });
  }

  function pushUndoState() {
    if (!state.project) return;
    const hist = getProjectHistory();
    hist.undo.push(captureSnapshot());
    if (hist.undo.length > 80) hist.undo.shift();
    hist.redo = [];
    updateUndoRedoButtons();
  }

  function restoreSnapshot(snapJson) {
    const snap = JSON.parse(snapJson);
    state.project.tracks = snap.tracks;
    state.project.snapEnabled = snap.snapEnabled;
    state.project.rippleSyncAudio = snap.rippleSyncAudio;
    repackTrack1();
    syncToolbarToggles();
    renderTimelineAndInspector();
    syncAudioPool();
    syncPreviewAtCurrentFrame();
    scheduleAutoSave();
  }

  function performUndo() {
    if (!state.project) return;
    const hist = getProjectHistory();
    if (hist.undo.length === 0) return;
    hist.redo.push(captureSnapshot());
    const prev = hist.undo.pop();
    restoreSnapshot(prev);
    updateUndoRedoButtons();
  }

  function performRedo() {
    if (!state.project) return;
    const hist = getProjectHistory();
    if (hist.redo.length === 0) return;
    hist.undo.push(captureSnapshot());
    const next = hist.redo.pop();
    restoreSnapshot(next);
    updateUndoRedoButtons();
  }

  function setSaveBadge(status) {
    el.saveStatusBadge.classList.remove('saved', 'saving');
    if (status === 'saving') {
      el.saveStatusBadge.classList.add('saving');
      el.saveStatusText.textContent = 'Saving...';
    } else {
      el.saveStatusBadge.classList.add('saved');
      el.saveStatusText.textContent = 'Saved';
    }
  }

  function scheduleAutoSave() {
    if (!state.project) return;
    state.isDirty = true;
    setSaveBadge('saving');
    if (state.saveTimer) clearTimeout(state.saveTimer);
    const targetProjectId = state.project.id;
    state.saveTimer = setTimeout(async () => {
      if (!state.project || state.project.id !== targetProjectId) return;
      try {
        await apiJson(`/api/projects/${targetProjectId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: state.project.name,
            snapEnabled: state.project.snapEnabled,
            rippleSyncAudio: state.project.rippleSyncAudio,
            sources: state.project.sources,
            tracks: state.project.tracks,
          }),
        });
        state.isDirty = false;
        setSaveBadge('saved');
      } catch (err) {
        showToast(`Auto-save failed: ${err.message}`, 'error');
      }
    }, 2000);
  }

  // -------------------------------------------------------------------------
  // Project Management & Projects Hub Modal
  // -------------------------------------------------------------------------
  async function loadProject(projectId) {
    stopPlayback();
    releaseAllMediaBuffers();

    const { project } = await apiJson(`/api/projects/${projectId}`);
    state.project = project;
    state.selectedClip = null;
    state.playheadFrame = 0;
    localStorage.setItem('montage_last_project', project.id);

    repackTrack1();
    el.activeProjectName.textContent = project.name;
    syncToolbarToggles();
    updateUndoRedoButtons();
    setSaveBadge('saved');

    await preloadMissingPeaks();
    renderSourcesList();
    fitTimelineToProject();
    renderTimelineAndInspector();
    syncAudioPool();
    syncPreviewAtCurrentFrame();
  }

  async function refreshProjectsModalList() {
    const data = await apiJson('/api/projects');
    state.projectsList = data.projects || [];
    el.projectsList.innerHTML = '';

    if (state.projectsList.length === 0) {
      el.projectsList.innerHTML = '<div class="empty-hint">No projects yet. Create your first project above.</div>';
      return;
    }

    for (const proj of state.projectsList) {
      const row = document.createElement('div');
      row.className = `project-row ${state.project?.id === proj.id ? 'active' : ''}`;

      const modDate = proj.updatedAt ? new Date(proj.updatedAt).toLocaleString() : 'Unknown';
      const info = document.createElement('div');
      info.className = 'project-row-info';
      info.innerHTML = `
        <strong>${escapeHtml(proj.name)}</strong>
        <span>Modified: ${escapeHtml(modDate)} • ${proj.clipCount} clips • ${formatDurationShort(proj.durationSec)}</span>
      `;

      const actions = document.createElement('div');
      actions.className = 'project-row-actions';

      const openBtn = document.createElement('button');
      openBtn.className = 'btn btn-tonal btn-sm';
      openBtn.innerHTML = '<span class="material-symbols-rounded">folder_open</span><span>Open</span>';
      openBtn.onclick = async () => {
        await loadProject(proj.id);
        closeProjectsModal();
      };

      const dupBtn = document.createElement('button');
      dupBtn.className = 'btn btn-outlined btn-sm';
      dupBtn.title = 'Duplicate with APFS Hardlinks';
      dupBtn.innerHTML = '<span class="material-symbols-rounded">content_copy</span><span>Duplicate</span>';
      dupBtn.onclick = async () => {
        try {
          await apiJson(`/api/projects/${proj.id}/duplicate`, { method: 'POST' });
          showToast(`Duplicated "${proj.name}" using APFS hardlinks`, 'success');
          await refreshProjectsModalList();
        } catch (err) {
          showToast(err.message, 'error');
        }
      };

      const renameBtn = document.createElement('button');
      renameBtn.className = 'icon-btn icon-btn-sm';
      renameBtn.title = 'Rename Project';
      renameBtn.innerHTML = '<span class="material-symbols-rounded">edit</span>';
      renameBtn.onclick = async () => {
        const nextName = window.prompt('Rename project:', proj.name);
        if (!nextName || !nextName.trim()) return;
        try {
          const { project } = await apiJson(`/api/projects/${proj.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: nextName.trim() }),
          });
          if (state.project?.id === proj.id) {
            state.project.name = project.name;
            el.activeProjectName.textContent = project.name;
          }
          await refreshProjectsModalList();
        } catch (err) {
          showToast(err.message, 'error');
        }
      };

      const delBtn = document.createElement('button');
      delBtn.className = 'icon-btn icon-btn-sm';
      delBtn.title = 'Delete Project';
      delBtn.style.color = 'var(--accent-red)';
      delBtn.innerHTML = '<span class="material-symbols-rounded">delete</span>';
      delBtn.onclick = async () => {
        if (!window.confirm(`Delete project "${proj.name}" permanently?`)) return;
        try {
          await apiJson(`/api/projects/${proj.id}`, { method: 'DELETE' });
          if (state.project?.id === proj.id) {
            state.project = null;
            el.activeProjectName.textContent = 'No Project';
          }
          await refreshProjectsModalList();
          if (!state.project && state.projectsList.length > 0) {
            await loadProject(state.projectsList[0].id);
          }
        } catch (err) {
          showToast(err.message, 'error');
        }
      };

      actions.append(openBtn, dupBtn, renameBtn, delBtn);
      row.append(info, actions);
      el.projectsList.appendChild(row);
    }
  }

  function openProjectsModal() {
    el.projectsModal.classList.remove('hidden');
    refreshProjectsModalList().catch((err) => showToast(err.message, 'error'));
  }

  function closeProjectsModal() {
    if (!state.project) {
      showToast('Create or open a project first.', 'warn');
      return;
    }
    el.projectsModal.classList.add('hidden');
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // -------------------------------------------------------------------------
  // Sources Media Bin, Waveform Peaks & Missing File Relink
  // -------------------------------------------------------------------------
  async function preloadMissingPeaks() {
    if (!state.project) return;
    const tasks = [];
    for (const src of state.project.sources || []) {
      if (src.hasAudio && src.peaksUrl && !state.peaksCache.has(src.id)) {
        tasks.push(
          fetch(src.peaksUrl)
            .then((r) => (r.ok ? r.json() : null))
            .then((data) => {
              if (data && Array.isArray(data.peaks)) {
                state.peaksCache.set(src.id, data.peaks);
              }
            })
            .catch(() => {})
        );
      }
    }
    await Promise.all(tasks);
  }

  function drawWaveformOnCanvas(canvas, peaks, color, fadeInFrac = 0, fadeOutFrac = 0) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    if (!peaks || peaks.length === 0) return;

    ctx.fillStyle = color;
    const midY = h / 2;
    const barCount = Math.max(1, Math.min(w, peaks.length));
    const step = w / barCount;

    for (let i = 0; i < barCount; i += 1) {
      const peakIdx = Math.min(peaks.length - 1, Math.floor((i / barCount) * peaks.length));
      const normX = i / barCount;
      let env = 1;
      if (fadeInFrac > 0 && normX < fadeInFrac) {
        env *= normX / fadeInFrac;
      }
      if (fadeOutFrac > 0 && normX > 1 - fadeOutFrac) {
        env *= (1 - normX) / fadeOutFrac;
      }
      const amp = Math.max(0.03, peaks[peakIdx] * env);
      const barH = amp * (h * 0.84);
      ctx.fillRect(i * step, midY - barH / 2, Math.max(1, step * 0.72), barH);
    }

    // Visual fade slope overlay lines
    if (fadeInFrac > 0) {
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(0, h - 2);
      ctx.lineTo(w * fadeInFrac, 3);
      ctx.stroke();
    }
    if (fadeOutFrac > 0) {
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(w * (1 - fadeOutFrac), 3);
      ctx.lineTo(w, h - 2);
      ctx.stroke();
    }
  }

  function renderSourcesList() {
    if (!state.project) return;
    const sources = state.project.sources || [];
    el.sourceCountPill.textContent = String(sources.length);
    el.sourcesList.innerHTML = '';

    if (sources.length === 0) {
      el.sourcesList.innerHTML = '<div class="empty-hint">No media in this project yet. Drop up to 10 files from Finder or click "+ Add from Disk".</div>';
      return;
    }

    for (const src of sources) {
      const card = document.createElement('div');
      card.className = `source-card ${src.missing ? 'is-missing' : ''}`;
      card.draggable = !src.missing;

      card.addEventListener('dragstart', (e) => {
        if (src.missing) {
          e.preventDefault();
          return;
        }
        state.dragSourceId = src.id;
        e.dataTransfer.setData('text/plain', JSON.stringify({ kind: 'source', sourceId: src.id }));
        e.dataTransfer.effectAllowed = 'copy';
      });

      const thumbBox = document.createElement('div');
      thumbBox.className = 'source-thumb-box';
      if (src.mediaType === 'video' && src.thumbnailUrl && !src.missing) {
        const img = document.createElement('img');
        img.src = src.thumbnailUrl;
        img.alt = src.name;
        thumbBox.appendChild(img);
      } else if (src.hasAudio && !src.missing) {
        const canvas = document.createElement('canvas');
        canvas.width = 144;
        canvas.height = 64;
        thumbBox.appendChild(canvas);
        const peaks = state.peaksCache.get(src.id);
        drawWaveformOnCanvas(canvas, peaks, '#81C995');
      } else {
        thumbBox.innerHTML = `<span class="material-symbols-rounded" style="color:#9AA0A6">${src.mediaType === 'video' ? 'movie' : 'audiotrack'}</span>`;
      }

      const meta = document.createElement('div');
      meta.className = 'source-meta';
      const resLabel = src.mediaType === 'video'
        ? `${src.height || 1080}p • ${src.sourceFps || 24}fps`
        : `${Math.round((src.sampleRate || 48000) / 1000)}kHz ${src.channels === 1 ? 'Mono' : 'Stereo'}`;

      const badges = document.createElement('div');
      badges.className = 'source-badges';
      badges.innerHTML = `
        <span class="meta-badge ${src.mediaType === 'video' ? 'video' : 'audio'}">${src.mediaType === 'video' ? 'VIDEO' : 'AUDIO'}</span>
        <span class="meta-badge">${formatDurationShort(src.durationSec)}</span>
        <span class="meta-badge">${resLabel}</span>
        <span class="meta-badge">${src.storageType === 'linked' ? 'Linked' : 'Copied'}</span>
      `;

      if (src.missing) {
        const missingBadge = document.createElement('span');
        missingBadge.className = 'meta-badge missing';
        missingBadge.textContent = 'Missing';
        badges.appendChild(missingBadge);
      }

      const nameEl = document.createElement('div');
      nameEl.className = 'source-name';
      nameEl.title = src.path || src.name;
      nameEl.textContent = src.name;

      meta.append(nameEl, badges);
      card.append(thumbBox, meta);

      if (src.missing) {
        const relinkBtn = document.createElement('button');
        relinkBtn.className = 'btn btn-tonal btn-sm';
        relinkBtn.textContent = 'Relocate...';
        relinkBtn.onclick = (ev) => {
          ev.stopPropagation();
          openFsBrowser('relink', src.id);
        };
        card.appendChild(relinkBtn);
      }

      el.sourcesList.appendChild(card);
    }
  }

  async function uploadFinderFiles(fileList) {
    if (!state.project) return;
    const files = Array.from(fileList || []);
    if (files.length === 0) return;

    if (files.length > MAX_IMPORT_BATCH) {
      showToast(`Batch limit exceeded: you dropped ${files.length} clips. Maximum is ${MAX_IMPORT_BATCH} clips at once.`, 'error');
      return;
    }

    const invalid = files.filter((f) => !hasAllowedExtension(f.name));
    if (invalid.length > 0) {
      showToast(`Unsupported extension(s): ${invalid.map((f) => f.name).join(', ')}`, 'error');
      return;
    }

    const formData = new FormData();
    for (const f of files) {
      formData.append('files', f);
    }

    try {
      showToast(`Inspecting & importing ${files.length} clip(s)...`, 'info');
      const data = await apiJson(`/api/projects/${state.project.id}/sources/upload`, {
        method: 'POST',
        body: formData,
      });
      state.project.sources = data.sources;
      await preloadMissingPeaks();
      renderSourcesList();
      if (data.errors?.length) {
        showToast(data.errors.join(' | '), 'warn');
      } else {
        showToast(`Imported ${data.added.length} clip(s) into project sources/`, 'success');
      }
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  // -------------------------------------------------------------------------
  // macOS Folder Browser Modal (Add from Disk / Relocate Missing)
  // -------------------------------------------------------------------------
  async function loadFsDirectory(dirPath = '') {
    const query = dirPath ? `?dir=${encodeURIComponent(dirPath)}` : '';
    const data = await apiJson(`/api/fs/browse${query}`);
    state.fsCurrentDir = data.currentDir;
    state.fsParentDir = data.parentDir;
    state.fsSelectedPaths = [];

    el.fsCurrentPath.textContent = data.currentDir;
    el.fsUpBtn.disabled = !data.parentDir;

    el.fsShortcuts.innerHTML = '';
    for (const sc of data.shortcuts || []) {
      const btn = document.createElement('button');
      btn.className = 'btn btn-tonal btn-sm';
      btn.textContent = sc.label;
      btn.onclick = () => loadFsDirectory(sc.path);
      el.fsShortcuts.appendChild(btn);
    }

    el.fsEntriesList.innerHTML = '';
    for (const dir of data.directories || []) {
      const row = document.createElement('div');
      row.className = 'fs-entry';
      row.innerHTML = `
        <div class="fs-entry-left">
          <span class="material-symbols-rounded" style="color:var(--accent-amber)">folder</span>
          <span class="fs-entry-name">${escapeHtml(dir.name)}</span>
        </div>
        <span class="fs-entry-meta">Folder</span>
      `;
      row.onclick = () => loadFsDirectory(dir.path);
      el.fsEntriesList.appendChild(row);
    }

    for (const file of data.files || []) {
      const row = document.createElement('div');
      row.className = 'fs-entry';
      row.dataset.path = file.path;
      const isVideo = ['.mp4', '.mov', '.mkv'].includes(file.ext);
      row.innerHTML = `
        <div class="fs-entry-left">
          <span class="material-symbols-rounded" style="color:${isVideo ? 'var(--accent-blue)' : 'var(--accent-green)'}">
            ${isVideo ? 'movie' : 'audiotrack'}
          </span>
          <span class="fs-entry-name">${escapeHtml(file.name)}</span>
        </div>
        <span class="fs-entry-meta">${formatBytes(file.size)}</span>
      `;

      row.onclick = () => {
        if (state.fsMode === 'relink') {
          state.fsSelectedPaths = [file.path];
          Array.from(el.fsEntriesList.children).forEach((c) => c.classList.remove('selected'));
          row.classList.add('selected');
        } else {
          const idx = state.fsSelectedPaths.indexOf(file.path);
          if (idx >= 0) {
            state.fsSelectedPaths.splice(idx, 1);
            row.classList.remove('selected');
          } else {
            if (state.fsSelectedPaths.length >= MAX_IMPORT_BATCH) {
              showToast(`Maximum ${MAX_IMPORT_BATCH} clips can be imported at once.`, 'warn');
              return;
            }
            state.fsSelectedPaths.push(file.path);
            row.classList.add('selected');
          }
        }
        updateFsFooter();
      };
      el.fsEntriesList.appendChild(row);
    }

    if (data.directories.length === 0 && data.files.length === 0) {
      el.fsEntriesList.innerHTML = '<div class="empty-hint">No subfolders or supported media files in this directory.</div>';
    }

    updateFsFooter();
  }

  function updateFsFooter() {
    const count = state.fsSelectedPaths.length;
    if (state.fsMode === 'relink') {
      el.fsSelectionInfo.textContent = count ? '1 replacement file selected' : 'Select replacement media file';
      el.fsConfirmBtn.textContent = 'Relocate File';
      el.fsConfirmBtn.disabled = count !== 1;
    } else {
      el.fsSelectionInfo.textContent = `${count} selected (max ${MAX_IMPORT_BATCH} clips)`;
      el.fsConfirmBtn.textContent = 'Link Selected';
      el.fsConfirmBtn.disabled = count === 0;
    }
  }

  function openFsBrowser(mode = 'link', relinkSourceId = null) {
    state.fsMode = mode;
    state.relinkSourceId = relinkSourceId;
    el.fsBrowserTitle.textContent = mode === 'relink' ? 'Relocate Missing Media File' : 'Add Media from macOS Disk';
    el.fsBrowserModal.classList.remove('hidden');
    loadFsDirectory(state.systemStatus.downloadsDir || '').catch((err) => showToast(err.message, 'error'));
  }

  function closeFsBrowser() {
    el.fsBrowserModal.classList.add('hidden');
  }

  // -------------------------------------------------------------------------
  // Timeline Editing, Trimming, Splitting & Zoom
  // -------------------------------------------------------------------------
  function addSourceToTrack(sourceId, trackKey, dropFrame = 0) {
    if (!state.project) return;
    const src = getSourceById(sourceId);
    if (!src) return;
    if (src.missing) {
      showToast(`"${src.name}" is missing. Relocate it first.`, 'error');
      return;
    }

    if (trackKey === 'track1' && src.mediaType !== 'video') {
      showToast('Track 1 accepts video clips only. Drop audio onto Track 2 or Track 3.', 'warn');
      return;
    }
    if ((trackKey === 'track2' || trackKey === 'track3') && !src.hasAudio) {
      showToast('Selected source has no audio stream.', 'warn');
      return;
    }

    pushUndoState();

    const newClip = {
      id: makeClipId(),
      sourceId: src.id,
      inFrame: 0,
      outFrame: Math.max(1, src.totalFrames || 24),
      speed: 1.0,
      reversed: false,
      timelineStartFrame: Math.max(0, Math.round(dropFrame)),
      volume: 1.0,
      fadeInSec: 0.0,
      fadeOutSec: 0.0,
    };

    if (trackKey === 'track1') {
      const t1 = state.project.tracks.track1;
      let insertIndex = t1.length;
      for (let i = 0; i < t1.length; i += 1) {
        const c = t1[i];
        const mid = (c.timelineStartFrame || 0) + getClipDurationFrames(c, 'track1') / 2;
        if (dropFrame < mid) {
          insertIndex = i;
          break;
        }
      }
      const insertAtFrame = insertIndex < t1.length
        ? (t1[insertIndex].timelineStartFrame || 0)
        : getTotalTrack1Frames();
      t1.splice(insertIndex, 0, newClip);
      repackTrack1();
      shiftAudioFromSegmentStart(insertAtFrame, getClipDurationFrames(newClip, 'track1'));
    } else {
      state.project.tracks[trackKey].push(newClip);
    }

    state.selectedClip = { trackKey, clipId: newClip.id };
    renderTimelineAndInspector();
    syncAudioPool();
    syncPreviewAtCurrentFrame();
    scheduleAutoSave();
  }

  function getSelectedClipObj() {
    if (!state.project || !state.selectedClip) return null;
    const list = state.project.tracks?.[state.selectedClip.trackKey] || [];
    const clip = list.find((c) => c.id === state.selectedClip.clipId);
    if (!clip) return null;
    return { trackKey: state.selectedClip.trackKey, clip, source: getSourceById(clip.sourceId) };
  }

  function deleteSelectedClip() {
    const sel = getSelectedClipObj();
    if (!sel) return;
    pushUndoState();
    const list = state.project.tracks[sel.trackKey];
    const idx = list.findIndex((c) => c.id === sel.clip.id);
    if (idx !== -1) {
      const removedDur = getClipDurationFrames(sel.clip, sel.trackKey);
      const removedStart = sel.clip.timelineStartFrame || 0;
      list.splice(idx, 1);
      if (sel.trackKey === 'track1') {
        repackTrack1();
        shiftAudioFromSegmentStart(removedStart, -removedDur);
      }
    }
    state.selectedClip = null;
    renderTimelineAndInspector();
    syncAudioPool();
    syncPreviewAtCurrentFrame();
    scheduleAutoSave();
  }

  function resolvePlayheadCutTarget(mode) {
    if (!state.project) return null;
    const frame = state.playheadFrame;

    let target = getSelectedClipObj();
    if (target) {
      const start = target.clip.timelineStartFrame || 0;
      const end = start + getClipDurationFrames(target.clip, target.trackKey);
      if (frame >= start && frame <= end) {
        if (frame === start || frame === end) {
          return null; // Boundary on explicitly selected clip -> safe no-op
        }
        return { ...target, start, end };
      }
    }

    for (const tk of ['track1', 'track2', 'track3']) {
      for (const c of state.project.tracks[tk]) {
        const start = c.timelineStartFrame || 0;
        const end = start + getClipDurationFrames(c, tk);
        if (frame > start && frame < end) {
          return { trackKey: tk, clip: c, source: getSourceById(c.sourceId), start, end };
        }
      }
    }
    if (mode === 'split') {
      showToast('Move the playhead inside a clip to split it.', 'warn');
    }
    return null;
  }

  function computeSplitSegments(target, frame) {
    const { trackKey, clip, start } = target;
    const speed = trackKey === 'track1' ? (Number(clip.speed) > 0 ? Number(clip.speed) : 1) : 1;
    const offsetTimelineFrames = frame - start;

    let splitSourceFrame = clip.reversed
      ? Math.round(clip.outFrame - offsetTimelineFrames * speed)
      : Math.round(clip.inFrame + offsetTimelineFrames * speed);

    splitSourceFrame = Math.max(clip.inFrame, Math.min(clip.outFrame, splitSourceFrame));
    if (splitSourceFrame <= clip.inFrame || splitSourceFrame >= clip.outFrame) {
      return null;
    }

    if (clip.reversed) {
      return {
        leftSeg: {
          ...clip,
          inFrame: splitSourceFrame,
          outFrame: clip.outFrame,
          fadeOutSec: 0,
        },
        rightSeg: {
          ...clip,
          id: makeClipId(),
          inFrame: clip.inFrame,
          outFrame: splitSourceFrame,
          timelineStartFrame: frame,
          fadeInSec: 0,
        },
      };
    }

    return {
      leftSeg: {
        ...clip,
        inFrame: clip.inFrame,
        outFrame: splitSourceFrame,
        fadeOutSec: 0,
      },
      rightSeg: {
        ...clip,
        id: makeClipId(),
        inFrame: splitSourceFrame,
        outFrame: clip.outFrame,
        timelineStartFrame: frame,
        fadeInSec: 0,
      },
    };
  }

  function splitAtPlayhead() {
    const frame = state.playheadFrame;
    const target = resolvePlayheadCutTarget('split');
    if (!target) return;

    const segs = computeSplitSegments(target, frame);
    if (!segs) {
      showToast('Clip segment is too short to split at this frame.', 'warn');
      return;
    }

    pushUndoState();
    const list = state.project.tracks[target.trackKey];
    const idx = list.findIndex((c) => c.id === target.clip.id);
    list.splice(idx, 1, segs.leftSeg, segs.rightSeg);
    if (target.trackKey === 'track1') {
      repackTrack1();
    }

    state.selectedClip = { trackKey: target.trackKey, clipId: segs.rightSeg.id };
    renderTimelineAndInspector();
    syncAudioPool();
    syncPreviewAtCurrentFrame();
    scheduleAutoSave();
  }

  function trimLeftAtPlayhead() {
    const frame = state.playheadFrame;
    const target = resolvePlayheadCutTarget('trimLeft');
    if (!target) return;

    const segs = computeSplitSegments(target, frame);
    if (!segs) return;

    pushUndoState();
    const { trackKey, clip, start } = target;
    const oldDur = getClipDurationFrames(clip, trackKey);
    const list = state.project.tracks[trackKey];
    const idx = list.findIndex((c) => c.id === clip.id);
    const rightSeg = segs.rightSeg;
    list.splice(idx, 1, rightSeg);

    if (trackKey === 'track1') {
      repackTrack1();
      const newDur = getClipDurationFrames(rightSeg, 'track1');
      shiftAudioFromSegmentStart(start, newDur - oldDur);
      state.playheadFrame = rightSeg.timelineStartFrame;
    } else {
      rightSeg.timelineStartFrame = frame;
    }

    state.selectedClip = { trackKey, clipId: rightSeg.id };
    renderTimelineAndInspector();
    syncAudioPool();
    syncPreviewAtCurrentFrame();
    scheduleAutoSave();
  }

  function trimRightAtPlayhead() {
    const frame = state.playheadFrame;
    const target = resolvePlayheadCutTarget('trimRight');
    if (!target) return;

    const segs = computeSplitSegments(target, frame);
    if (!segs) return;

    pushUndoState();
    const { trackKey, clip, start } = target;
    const oldDur = getClipDurationFrames(clip, trackKey);
    const list = state.project.tracks[trackKey];
    const idx = list.findIndex((c) => c.id === clip.id);
    const leftSeg = segs.leftSeg;
    list.splice(idx, 1, leftSeg);

    if (trackKey === 'track1') {
      repackTrack1();
      const newDur = getClipDurationFrames(leftSeg, 'track1');
      shiftAudioFromSegmentStart(start, newDur - oldDur);
    } else {
      leftSeg.timelineStartFrame = start;
    }

    state.selectedClip = { trackKey, clipId: leftSeg.id };
    renderTimelineAndInspector();
    syncAudioPool();
    syncPreviewAtCurrentFrame();
    scheduleAutoSave();
  }

  function updateZoomFromSlider(sliderVal, anchorOnPlayhead = true) {
    // Exponential map from 0.25 px/frame up to 20 px/frame
    const minPx = 0.25;
    const maxPx = 20.0;
    const t = Number(sliderVal) / 100;
    const newPx = Number((minPx * Math.pow(maxPx / minPx, t)).toFixed(3));
    setZoomScale(newPx, anchorOnPlayhead);
  }

  function setZoomScale(newPxPerFrame, anchorOnPlayhead = true) {
    const clamped = Math.max(0.25, Math.min(20, newPxPerFrame));
    const oldPx = state.pxPerFrame;
    const viewport = el.timelineViewport;
    const playheadViewportX = state.playheadFrame * oldPx - viewport.scrollLeft;

    state.pxPerFrame = clamped;
    const t = Math.log(clamped / 0.25) / Math.log(20 / 0.25);
    el.zoomSlider.value = String(Math.round(Math.max(0, Math.min(100, t * 100))));
    el.zoomScaleLabel.textContent = `${clamped.toFixed(1)} px/f`;

    renderAllTimelineClips();
    drawTimelineRuler();
    updatePlayheadUI();

    if (anchorOnPlayhead) {
      const targetPlayheadViewportX =
        playheadViewportX >= 0 && playheadViewportX <= viewport.clientWidth
          ? playheadViewportX
          : viewport.clientWidth * 0.45;
      viewport.scrollLeft = Math.max(0, state.playheadFrame * clamped - targetPlayheadViewportX);
    }
  }

  function fitTimelineToProject() {
    const totalFrames = Math.max(240, getTotalProjectFrames() + 48);
    const availWidth = Math.max(400, el.timelineViewport.clientWidth - 40);
    setZoomScale(availWidth / totalFrames, false);
    el.timelineViewport.scrollLeft = 0;
  }

  // -------------------------------------------------------------------------
  // Timeline Rendering, Dragging & Trimming
  // -------------------------------------------------------------------------
  function drawTimelineRuler() {
    const canvas = el.timelineRuler;
    const width = Math.max(el.timelineViewport.clientWidth, Math.ceil((getTotalProjectFrames() + 240) * state.pxPerFrame));
    canvas.width = width;
    canvas.height = 28;
    el.timelineInner.style.width = `${width}px`;

    const ctx = canvas.getContext('2d');
    const isDark = document.documentElement.dataset.theme === 'dark';
    ctx.clearRect(0, 0, width, 28);
    ctx.fillStyle = isDark ? '#9AA0A6' : '#5F6368';
    ctx.strokeStyle = isDark ? '#444746' : '#DADCE0';
    ctx.font = '10.5px "Google Sans Mono", monospace';

    // Choose readable step in frames based on zoom
    let majorStep = 24 * 10;
    if (state.pxPerFrame >= 10) majorStep = 12;
    else if (state.pxPerFrame >= 4) majorStep = 24;
    else if (state.pxPerFrame >= 1.5) majorStep = 24 * 2;
    else if (state.pxPerFrame >= 0.6) majorStep = 24 * 5;

    const minorStep = Math.max(1, Math.floor(majorStep / 4));
    const maxFrames = Math.ceil(width / state.pxPerFrame);

    for (let f = 0; f <= maxFrames; f += minorStep) {
      const x = Math.round(f * state.pxPerFrame) + 0.5;
      const isMajor = f % majorStep === 0;
      ctx.beginPath();
      ctx.moveTo(x, isMajor ? 10 : 20);
      ctx.lineTo(x, 28);
      ctx.stroke();

      if (isMajor) {
        ctx.fillText(`${framesToTimecode(f)}`, x + 4, 12);
      }
    }
  }

  function updatePlayheadUI() {
    const x = state.playheadFrame * state.pxPerFrame;
    el.playheadEl.style.left = `${x}px`;
    el.currentTimecode.textContent = framesToTimecode(state.playheadFrame);
    el.frameCounterBadge.textContent = `Frame ${state.playheadFrame}`;
    el.totalTimecode.textContent = framesToTimecode(getTotalTrack1Frames());
  }

  function renderAllTimelineClips() {
    if (!state.project) return;
    const lanes = [
      { key: 'track1', el: el.track1Lane, cls: 'v1', hint: 'Drop Video Clips Here (Sequential Magnetic Track)' },
      { key: 'track2', el: el.track2Lane, cls: 'a1', hint: 'Drop Audio 1 Clips Here' },
      { key: 'track3', el: el.track3Lane, cls: 'a2', hint: 'Drop Audio 2 Clips Here' },
    ];

    const totalWidth = Math.max(
      el.timelineViewport.clientWidth,
      Math.ceil((getTotalProjectFrames() + 240) * state.pxPerFrame)
    );
    el.timelineInner.style.width = `${totalWidth}px`;

    for (const lane of lanes) {
      lane.el.innerHTML = `<div class="lane-drop-hint">${lane.hint}</div>`;
      const clips = state.project.tracks[lane.key] || [];
      for (const clip of clips) {
        const src = getSourceById(clip.sourceId);
        const durFrames = getClipDurationFrames(clip, lane.key);
        const widthPx = Math.max(8, durFrames * state.pxPerFrame);
        const leftPx = (clip.timelineStartFrame || 0) * state.pxPerFrame;

        const clipEl = document.createElement('div');
        clipEl.className = `tl-clip ${lane.cls} ${
          state.selectedClip?.trackKey === lane.key && state.selectedClip?.clipId === clip.id ? 'selected' : ''
        }`;
        clipEl.style.left = `${leftPx}px`;
        clipEl.style.width = `${widthPx}px`;

        if (src && src.hasAudio) {
          const waveCanvas = document.createElement('canvas');
          waveCanvas.className = 'tl-clip-waveform';
          waveCanvas.width = Math.max(32, Math.min(800, Math.round(widthPx)));
          waveCanvas.height = 60;
          clipEl.appendChild(waveCanvas);

          const fullPeaks = state.peaksCache.get(src.id) || [];
          const totalSrcFrames = Math.max(1, src.totalFrames || 1);
          const startIdx = Math.floor((clip.inFrame / totalSrcFrames) * fullPeaks.length);
          const endIdx = Math.max(startIdx + 1, Math.ceil((clip.outFrame / totalSrcFrames) * fullPeaks.length));
          let slicePeaks = fullPeaks.slice(startIdx, endIdx);
          if (clip.reversed) slicePeaks = slicePeaks.slice().reverse();

          const durSec = durFrames / FPS;
          const fadeInFrac = Math.min(1, Math.max(0, (clip.fadeInSec || 0) / Math.max(0.01, durSec)));
          const fadeOutFrac = Math.min(1 - fadeInFrac, Math.max(0, (clip.fadeOutSec || 0) / Math.max(0.01, durSec)));
          const color = lane.key === 'track2' ? '#81C995' : (lane.key === 'track3' ? '#FDD663' : '#8AB4F8');
          drawWaveformOnCanvas(waveCanvas, slicePeaks, color, fadeInFrac, fadeOutFrac);
        }

        const header = document.createElement('div');
        header.className = 'tl-clip-header';
        const title = document.createElement('span');
        title.className = 'tl-clip-title';
        title.textContent = src ? src.name : 'Unknown';

        const pills = document.createElement('div');
        pills.className = 'tl-clip-pills';
        if (lane.key === 'track1') {
          if (Math.abs((clip.speed || 1) - 1) > 0.001) {
            const sp = document.createElement('span');
            sp.className = 'tl-badge';
            sp.textContent = `${Number(clip.speed).toFixed(2).replace(/\.?0+$/, '')}x`;
            pills.appendChild(sp);
          }
          if (clip.reversed) {
            const rev = document.createElement('span');
            rev.className = 'tl-badge';
            rev.textContent = 'REV';
            pills.appendChild(rev);
          }
        }
        header.append(title, pills);

        const footer = document.createElement('div');
        footer.className = 'tl-clip-footer';
        footer.textContent = `${durFrames}f (${formatDurationShort(durFrames / FPS)})`;

        const leftTrim = document.createElement('div');
        leftTrim.className = 'trim-handle left';
        const rightTrim = document.createElement('div');
        rightTrim.className = 'trim-handle right';

        clipEl.append(header, footer, leftTrim, rightTrim);

        // Select & Move Clip
        clipEl.addEventListener('mousedown', (e) => {
          if (e.target === leftTrim || e.target === rightTrim) return;
          e.stopPropagation();
          state.selectedClip = { trackKey: lane.key, clipId: clip.id };
          renderInspector();
          Array.from(document.querySelectorAll('.tl-clip.selected')).forEach((n) => n.classList.remove('selected'));
          clipEl.classList.add('selected');
          startClipDrag(e, lane.key, clip, clipEl);
        });

        // Trim Left / Right Edge (1-frame precision)
        leftTrim.addEventListener('mousedown', (e) => {
          e.stopPropagation();
          state.selectedClip = { trackKey: lane.key, clipId: clip.id };
          renderInspector();
          startClipTrim(e, lane.key, clip, 'left');
        });

        rightTrim.addEventListener('mousedown', (e) => {
          e.stopPropagation();
          state.selectedClip = { trackKey: lane.key, clipId: clip.id };
          renderInspector();
          startClipTrim(e, lane.key, clip, 'right');
        });

        lane.el.appendChild(clipEl);
      }
    }
  }

  function startClipDrag(downEvent, trackKey, clip, clipEl) {
    const startX = downEvent.clientX;
    const origStartFrame = clip.timelineStartFrame || 0;
    let pushedUndo = false;

    const onMove = (moveEvent) => {
      const dx = moveEvent.clientX - startX;
      if (Math.abs(dx) < 3 && !pushedUndo) return;
      if (!pushedUndo) {
        pushUndoState();
        pushedUndo = true;
      }

      if (trackKey === 'track1') {
        const rect = el.track1Lane.getBoundingClientRect();
        const relX = moveEvent.clientX - rect.left;
        const t1 = state.project.tracks.track1;
        const currIdx = t1.findIndex((c) => c.id === clip.id);
        let newIdx = t1.length - 1;
        for (let i = 0; i < t1.length; i += 1) {
          const other = t1[i];
          const midX = ((other.timelineStartFrame || 0) + getClipDurationFrames(other, 'track1') / 2) * state.pxPerFrame;
          if (relX < midX) {
            newIdx = i;
            break;
          }
        }
        if (currIdx !== -1 && newIdx !== currIdx) {
          const [moved] = t1.splice(currIdx, 1);
          t1.splice(newIdx, 0, moved);
          repackTrack1();
          renderAllTimelineClips();
        }
      } else {
        const deltaFrames = Math.round(dx / state.pxPerFrame);
        const rawStart = Math.max(0, origStartFrame + deltaFrames);
        const durFrames = getClipDurationFrames(clip, trackKey);

        // Snap start edge or end edge
        const snapStart = snapFrameIfEnabled(rawStart, clip.id);
        const snapEnd = snapFrameIfEnabled(rawStart + durFrames, clip.id);
        let finalStart = rawStart;
        let guide = null;

        if (snapStart.snappedTo !== null && (snapEnd.snappedTo === null || Math.abs(snapStart.frame - rawStart) <= Math.abs(snapEnd.frame - (rawStart + durFrames)))) {
          finalStart = snapStart.frame;
          guide = snapStart.snappedTo;
        } else if (snapEnd.snappedTo !== null) {
          finalStart = Math.max(0, snapEnd.frame - durFrames);
          guide = snapEnd.snappedTo;
        }

        clip.timelineStartFrame = finalStart;
        clipEl.style.left = `${finalStart * state.pxPerFrame}px`;
        showSnapGuide(guide);
      }
    };

    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      showSnapGuide(null);
      if (pushedUndo) {
        renderTimelineAndInspector();
        syncAudioPool();
        syncPreviewAtCurrentFrame();
        scheduleAutoSave();
      }
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  function startClipTrim(downEvent, trackKey, clip, side) {
    const src = getSourceById(clip.sourceId);
    const maxSourceFrames = Math.max(2, src?.totalFrames || clip.outFrame);
    const speed = trackKey === 'track1' ? (Number(clip.speed) > 0 ? Number(clip.speed) : 1) : 1;
    const startX = downEvent.clientX;
    const origIn = clip.inFrame;
    const origOut = clip.outFrame;
    const origTlStart = clip.timelineStartFrame || 0;
    const origTlDur = getClipDurationFrames(clip, trackKey);
    let pushedUndo = false;

    const onMove = (moveEvent) => {
      const dx = moveEvent.clientX - startX;
      if (Math.abs(dx) < 2 && !pushedUndo) return;
      if (!pushedUndo) {
        pushUndoState();
        pushedUndo = true;
      }

      const rawDeltaTimelineFrames = Math.round(dx / state.pxPerFrame);

      if (trackKey === 'track1') {
        const deltaSrc = Math.round(rawDeltaTimelineFrames * speed);
        if (side === 'left') {
          if (clip.reversed) {
            clip.outFrame = Math.max(clip.inFrame + 1, Math.min(maxSourceFrames, origOut - deltaSrc));
          } else {
            clip.inFrame = Math.max(0, Math.min(clip.outFrame - 1, origIn + deltaSrc));
          }
        } else {
          if (clip.reversed) {
            clip.inFrame = Math.max(0, Math.min(clip.outFrame - 1, origIn - deltaSrc));
          } else {
            clip.outFrame = Math.max(clip.inFrame + 1, Math.min(maxSourceFrames, origOut + deltaSrc));
          }
        }
        repackTrack1();
      } else {
        // Free audio track: left edge trims inFrame + shifts timelineStartFrame; right edge trims outFrame
        if (side === 'left') {
          const targetStartRaw = Math.max(0, origTlStart + rawDeltaTimelineFrames);
          const snap = snapFrameIfEnabled(targetStartRaw, clip.id);
          const maxShift = origOut - origIn - 1;
          const clampedShift = Math.max(-origIn, Math.min(maxShift, snap.frame - origTlStart));
          clip.inFrame = origIn + clampedShift;
          clip.timelineStartFrame = Math.max(0, origTlStart + clampedShift);
          showSnapGuide(snap.snappedTo);
        } else {
          const targetEndRaw = origTlStart + origTlDur + rawDeltaTimelineFrames;
          const snap = snapFrameIfEnabled(targetEndRaw, clip.id);
          const desiredDur = Math.max(1, snap.frame - origTlStart);
          clip.outFrame = Math.max(clip.inFrame + 1, Math.min(maxSourceFrames, origIn + desiredDur));
          showSnapGuide(snap.snappedTo);
        }
      }
      renderAllTimelineClips();
      renderInspector();
    };

    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      showSnapGuide(null);
      if (pushedUndo) {
        if (trackKey === 'track1') {
          const newTlDur = getClipDurationFrames(clip, 'track1');
          shiftAudioFromSegmentStart(origTlStart, newTlDur - origTlDur);
        }
        renderTimelineAndInspector();
        syncAudioPool();
        syncPreviewAtCurrentFrame();
        scheduleAutoSave();
      }
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  // -------------------------------------------------------------------------
  // Inspector Bar
  // -------------------------------------------------------------------------
  function renderInspector() {
    const sel = getSelectedClipObj();
    if (!sel) {
      el.inspectorEmpty.classList.remove('hidden');
      el.inspectorControls.classList.add('hidden');
      return;
    }

    const { trackKey, clip, source } = sel;
    el.inspectorEmpty.classList.add('hidden');
    el.inspectorControls.classList.remove('hidden');

    el.inspectorTrackBadge.className = `track-pill ${trackKey === 'track2' ? 'a1' : trackKey === 'track3' ? 'a2' : ''}`;
    el.inspectorTrackBadge.textContent = trackKey === 'track1' ? 'V1' : trackKey === 'track2' ? 'A1' : 'A2';
    el.inspectorClipName.textContent = source ? source.name : 'Clip';

    const durFrames = getClipDurationFrames(clip, trackKey);
    el.inspectorClipRange.textContent = `${clip.inFrame}f → ${clip.outFrame}f (${formatDurationShort(durFrames / FPS)})`;

    if (trackKey === 'track1') {
      el.videoInspectorGroup.classList.remove('hidden');
      const sp = Number(clip.speed) || 1;
      el.speedFineInput.value = sp.toFixed(2);
      const presetOpt = Array.from(el.speedPresetSelect.options).find((o) => Number(o.value) === sp);
      el.speedPresetSelect.value = presetOpt ? presetOpt.value : 'custom';
      el.reverseToggleBtn.classList.toggle('active', Boolean(clip.reversed));

      // Hide audio controls cleanly for silent Google Flow video clips
      if (source && source.hasAudio) {
        el.audioInspectorGroup.classList.remove('hidden');
      } else {
        el.audioInspectorGroup.classList.add('hidden');
      }
    } else {
      el.videoInspectorGroup.classList.add('hidden');
      el.audioInspectorGroup.classList.remove('hidden');
    }

    const volPct = Math.round((clip.volume !== undefined ? clip.volume : 1) * 100);
    el.volumeRange.value = String(volPct);
    el.volumeLabel.textContent = `${volPct}%`;
    el.fadeInInput.value = Number(clip.fadeInSec || 0).toFixed(1);
    el.fadeOutInput.value = Number(clip.fadeOutSec || 0).toFixed(1);
  }

  function renderTimelineAndInspector() {
    drawTimelineRuler();
    renderAllTimelineClips();
    updatePlayheadUI();
    renderInspector();
  }

  function syncToolbarToggles() {
    if (!state.project) return;
    el.snapToggleBtn.classList.toggle('active', Boolean(state.project.snapEnabled));
  }

  // -------------------------------------------------------------------------
  // Web Audio Node Pool, VU Meter & Dual-Player Master Clock Sync
  // -------------------------------------------------------------------------
  function ensureAudioContext() {
    if (!state.audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      state.audioCtx = new Ctx();
      state.masterGain = state.audioCtx.createGain();
      state.masterGain.gain.value = 1.0;

      const splitter = state.audioCtx.createChannelSplitter(2);
      state.analyserL = state.audioCtx.createAnalyser();
      state.analyserR = state.audioCtx.createAnalyser();
      state.analyserL.fftSize = 256;
      state.analyserR.fftSize = 256;

      state.masterGain.connect(state.audioCtx.destination);
      state.masterGain.connect(splitter);
      splitter.connect(state.analyserL, 0);
      splitter.connect(state.analyserR, 1);

      if (!state.videoNodesReady) {
        const srcA = state.audioCtx.createMediaElementSource(el.videoPlayerA);
        const srcB = state.audioCtx.createMediaElementSource(el.videoPlayerB);
        state.videoGainA = state.audioCtx.createGain();
        state.videoGainB = state.audioCtx.createGain();
        srcA.connect(state.videoGainA).connect(state.masterGain);
        srcB.connect(state.videoGainB).connect(state.masterGain);
        state.videoNodesReady = true;
      }
    }
    if (state.audioCtx.state === 'suspended') {
      state.audioCtx.resume().catch(() => {});
    }
  }

  function releaseClipAudioNode(nodeEntry) {
    try {
      nodeEntry.audioEl.pause();
      nodeEntry.audioEl.removeAttribute('src');
      nodeEntry.audioEl.load();
      nodeEntry.sourceNode.disconnect();
      nodeEntry.gainNode.disconnect();
    } catch {
      // Ignore already disconnected nodes
    }
  }

  function releaseAllMediaBuffers() {
    for (const entry of state.audioNodePool.values()) {
      releaseClipAudioNode(entry);
    }
    state.audioNodePool.clear();

    for (const [slot, player] of [['A', el.videoPlayerA], ['B', el.videoPlayerB]]) {
      player.pause();
      player.removeAttribute('src');
      player.load();
      state.slotState[slot] = { clipId: null, sourceId: null, preseekedSec: null, pendingSeekSec: null };
    }
  }

  function syncAudioPool() {
    if (!state.project) return;
    const activeClipIds = new Set();

    for (const tk of ['track2', 'track3']) {
      for (const clip of state.project.tracks[tk] || []) {
        const src = getSourceById(clip.sourceId);
        if (!src || src.missing || !src.hasAudio) continue;
        activeClipIds.add(clip.id);

        if (!state.audioNodePool.has(clip.id) && state.audioCtx) {
          const audioEl = new Audio();
          audioEl.crossOrigin = 'anonymous';
          audioEl.preload = 'auto';
          audioEl.src = `/api/projects/${state.project.id}/stream/${src.id}`;
          const sourceNode = state.audioCtx.createMediaElementSource(audioEl);
          const gainNode = state.audioCtx.createGain();
          sourceNode.connect(gainNode).connect(state.masterGain);
          state.audioNodePool.set(clip.id, {
            clipId: clip.id,
            sourceId: src.id,
            audioEl,
            sourceNode,
            gainNode,
          });
        }
      }
    }

    for (const [clipId, entry] of state.audioNodePool.entries()) {
      if (!activeClipIds.has(clipId)) {
        releaseClipAudioNode(entry);
        state.audioNodePool.delete(clipId);
      }
    }
  }

  function computeEnvelopeGain(clip, elapsedInClipSec, clipDurSec) {
    const baseVol = clip.volume !== undefined ? Number(clip.volume) : 1.0;
    const fadeIn = Math.min(Math.max(0, Number(clip.fadeInSec) || 0), clipDurSec);
    const fadeOut = Math.min(Math.max(0, Number(clip.fadeOutSec) || 0), Math.max(0, clipDurSec - fadeIn));
    let env = 1.0;
    if (fadeIn > 0.001 && elapsedInClipSec < fadeIn) {
      env *= Math.max(0, elapsedInClipSec / fadeIn);
    }
    if (fadeOut > 0.001 && elapsedInClipSec > clipDurSec - fadeOut) {
      env *= Math.max(0, (clipDurSec - elapsedInClipSec) / fadeOut);
    }
    return baseVol * env;
  }

  function getTrack1ClipAtTime(timelineSec) {
    if (!state.project) return { active: null, next: null };
    const t1 = state.project.tracks.track1 || [];
    for (let i = 0; i < t1.length; i += 1) {
      const clip = t1[i];
      const startSec = (clip.timelineStartFrame || 0) / FPS;
      const durSec = getClipDurationFrames(clip, 'track1') / FPS;
      const endSec = startSec + durSec;
      if (timelineSec >= startSec && timelineSec < endSec) {
        return {
          active: { clip, startSec, endSec, durSec },
          next: t1[i + 1]
            ? {
                clip: t1[i + 1],
                startSec: (t1[i + 1].timelineStartFrame || 0) / FPS,
              }
            : null,
        };
      }
    }
    return { active: null, next: null };
  }

  function setVideoSlotSource(slot, clip) {
    const player = slot === 'A' ? el.videoPlayerA : el.videoPlayerB;
    const st = state.slotState[slot];
    if (!clip || !state.project) {
      if (st.sourceId !== null) {
        player.pause();
        player.removeAttribute('src');
        player.load();
        state.slotState[slot] = { clipId: null, sourceId: null, preseekedSec: null, pendingSeekSec: null };
      }
      return player;
    }

    const src = getSourceById(clip.sourceId);
    if (!src || src.missing) return player;
    const url = `/api/projects/${state.project.id}/stream/${src.id}`;
    if (st.sourceId !== src.id) {
      player.pause();
      player.src = url;
      player.load();
      st.sourceId = src.id;
      st.preseekedSec = null;
      st.pendingSeekSec = null;
    }
    st.clipId = clip.id;
    return player;
  }

  function seekVideoSlot(slot, targetSec) {
    const player = slot === 'A' ? el.videoPlayerA : el.videoPlayerB;
    const st = state.slotState[slot];
    if (player.readyState >= 1) {
      st.pendingSeekSec = null;
      if (!player.seeking && Math.abs(player.currentTime - targetSec) > 0.01) {
        player.currentTime = targetSec;
      }
    } else {
      st.pendingSeekSec = targetSec;
    }
  }

  function swapActiveVideoSlot(nextSlot) {
    state.activeVideoSlot = nextSlot;
    el.videoPlayerA.classList.toggle('active', nextSlot === 'A');
    el.videoPlayerB.classList.toggle('active', nextSlot === 'B');
  }

  function syncPreviewAtCurrentFrame() {
    if (!state.project) return;
    const t1 = state.project.tracks.track1 || [];
    el.previewEmptyOverlay.classList.toggle('hidden', t1.length > 0);
    if (t1.length === 0) {
      el.previewClipBadge.classList.add('hidden');
      setVideoSlotSource('A', null);
      setVideoSlotSource('B', null);
      return;
    }

    const totalT1 = getTotalTrack1Frames();
    const clampedFrame = Math.max(0, Math.min(Math.max(0, totalT1 - 1), state.playheadFrame));
    const timelineSec = clampedFrame / FPS;
    const { active } = getTrack1ClipAtTime(timelineSec);
    if (!active) return;

    const { clip, startSec } = active;
    const src = getSourceById(clip.sourceId);
    if (!src || src.missing) return;

    const speed = Number(clip.speed) > 0 ? Number(clip.speed) : 1;
    const elapsedInClip = Math.max(0, timelineSec - startSec);
    const targetSrcSec = clip.reversed
      ? Math.max(clip.inFrame / FPS, clip.outFrame / FPS - elapsedInClip * speed)
      : Math.min(clip.outFrame / FPS, clip.inFrame / FPS + elapsedInClip * speed);

    const player = setVideoSlotSource(state.activeVideoSlot, clip);
    player.pause();
    seekVideoSlot(state.activeVideoSlot, targetSrcSec);
    el.previewClipBadge.textContent = `${src.name} • ${speed}x${clip.reversed ? ' • REV' : ''}`;
    el.previewClipBadge.classList.remove('hidden');
  }

  function updateMasterPlaybackLoop() {
    if (!state.isPlaying || !state.project) return;

    const totalT1Frames = getTotalTrack1Frames();
    const totalT1Sec = totalT1Frames / FPS;
    const elapsedSincePlay = state.audioCtx.currentTime - state.playStartAudioTime;
    const timelineSec = state.playStartTimelineSec + elapsedSincePlay;

    if (totalT1Frames === 0 || timelineSec >= totalT1Sec) {
      state.playheadFrame = Math.max(0, totalT1Frames);
      updatePlayheadUI();
      stopPlayback();
      return;
    }

    state.playheadFrame = Math.floor(timelineSec * FPS);
    updatePlayheadUI();

    // 1. Track 1 Dual-Player Gap-Free Video Sync
    const { active, next } = getTrack1ClipAtTime(timelineSec);
    if (active) {
      const { clip, startSec } = active;
      const src = getSourceById(clip.sourceId);
      const inactiveSlot = state.activeVideoSlot === 'A' ? 'B' : 'A';

      // Switch to preloaded inactive slot if it already holds this clip
      if (state.slotState[state.activeVideoSlot].clipId !== clip.id) {
        if (state.slotState[inactiveSlot].clipId === clip.id) {
          const oldPlayer = state.activeVideoSlot === 'A' ? el.videoPlayerA : el.videoPlayerB;
          oldPlayer.pause();
          swapActiveVideoSlot(inactiveSlot);
        }
      }

      const activePlayer = setVideoSlotSource(state.activeVideoSlot, clip);
      const activeGain = state.activeVideoSlot === 'A' ? state.videoGainA : state.videoGainB;
      const inactiveGain = state.activeVideoSlot === 'A' ? state.videoGainB : state.videoGainA;
      if (inactiveGain) inactiveGain.gain.setTargetAtTime(0, state.audioCtx.currentTime, 0.008);

      const speed = Number(clip.speed) > 0 ? Number(clip.speed) : 1;
      const elapsedInClip = Math.max(0, timelineSec - startSec);
      const durSec = getClipDurationFrames(clip, 'track1') / FPS;

      if (clip.reversed) {
        if (!activePlayer.paused) activePlayer.pause();
        activePlayer.muted = true;
        if (activeGain) activeGain.gain.setTargetAtTime(0, state.audioCtx.currentTime, 0.01);
        const targetSrcSec = Math.max(clip.inFrame / FPS, clip.outFrame / FPS - elapsedInClip * speed);
        if (!activePlayer.seeking && Math.abs(activePlayer.currentTime - targetSrcSec) >= 0.5 / FPS) {
          activePlayer.currentTime = targetSrcSec;
        }
      } else {
        const hasAudio = Boolean(src && src.hasAudio);
        activePlayer.muted = !hasAudio;
        if (activeGain) {
          const g = hasAudio ? computeEnvelopeGain(clip, elapsedInClip, durSec) : 0;
          activeGain.gain.setTargetAtTime(g, state.audioCtx.currentTime, 0.015);
        }
        activePlayer.playbackRate = speed;
        activePlayer.preservesPitch = true;

        const targetSrcSec = Math.min(clip.outFrame / FPS, clip.inFrame / FPS + elapsedInClip * speed);
        if (activePlayer.paused && activePlayer.readyState >= 2) {
          activePlayer.play().catch(() => {});
        }
        if (!activePlayer.seeking && Math.abs(activePlayer.currentTime - targetSrcSec) > 1 / FPS) {
          activePlayer.currentTime = targetSrcSec;
        }
      }

      // Preload next Track 1 clip into inactive player
      const nextSlot = state.activeVideoSlot === 'A' ? 'B' : 'A';
      if (next && next.clip) {
        const nextPlayer = setVideoSlotSource(nextSlot, next.clip);
        nextPlayer.pause();
        nextPlayer.muted = true;
        const nextStartSrc = next.clip.reversed ? next.clip.outFrame / FPS : next.clip.inFrame / FPS;
        if (
          state.slotState[nextSlot].preseekedSec !== nextStartSrc &&
          !nextPlayer.seeking &&
          nextPlayer.readyState >= 1
        ) {
          nextPlayer.currentTime = nextStartSrc;
          state.slotState[nextSlot].preseekedSec = nextStartSrc;
        }
      } else {
        setVideoSlotSource(nextSlot, null);
      }

      if (src) {
        el.previewClipBadge.textContent = `${src.name} • ${speed}x${clip.reversed ? ' • REV' : ''}`;
        el.previewClipBadge.classList.remove('hidden');
      }
    }

    // 2. Track 2 & Track 3 Streaming Audio Node Pool Sync
    for (const tk of ['track2', 'track3']) {
      for (const clip of state.project.tracks[tk] || []) {
        const entry = state.audioNodePool.get(clip.id);
        if (!entry) continue;
        const startSec = (clip.timelineStartFrame || 0) / FPS;
        const durSec = getClipDurationFrames(clip, tk) / FPS;
        const endSec = startSec + durSec;
        const { audioEl, gainNode } = entry;

        if (timelineSec >= startSec && timelineSec < endSec) {
          const elapsedInClip = timelineSec - startSec;
          const targetSrcSec = clip.inFrame / FPS + elapsedInClip;
          const g = computeEnvelopeGain(clip, elapsedInClip, durSec);
          gainNode.gain.setTargetAtTime(g, state.audioCtx.currentTime, 0.015);
          if (audioEl.paused && audioEl.readyState >= 2) {
            if (Math.abs(audioEl.currentTime - targetSrcSec) > 0.04) {
              audioEl.currentTime = targetSrcSec;
            }
            audioEl.play().catch(() => {});
          } else if (!audioEl.seeking && Math.abs(audioEl.currentTime - targetSrcSec) > 1 / FPS) {
            audioEl.currentTime = targetSrcSec;
          }
        } else {
          if (!audioEl.paused) audioEl.pause();
          gainNode.gain.setTargetAtTime(0, state.audioCtx.currentTime, 0.01);
        }
      }
    }

    drawVuMeter();
    state.rafId = requestAnimationFrame(updateMasterPlaybackLoop);
  }

  function startPlayback() {
    if (!state.project) return;
    const totalT1 = getTotalTrack1Frames();
    if (totalT1 === 0) {
      showToast('Add a video clip to Track 1 to preview playback.', 'warn');
      return;
    }

    ensureAudioContext();
    syncAudioPool();

    if (state.playheadFrame >= totalT1) {
      state.playheadFrame = 0;
    }

    state.isPlaying = true;
    el.playPauseIcon.textContent = 'pause';
    state.playStartAudioTime = state.audioCtx.currentTime;
    state.playStartTimelineSec = state.playheadFrame / FPS;
    state.rafId = requestAnimationFrame(updateMasterPlaybackLoop);
  }

  function stopPlayback() {
    state.isPlaying = false;
    el.playPauseIcon.textContent = 'play_arrow';
    if (state.rafId) {
      cancelAnimationFrame(state.rafId);
      state.rafId = null;
    }
    el.videoPlayerA.pause();
    el.videoPlayerB.pause();
    for (const entry of state.audioNodePool.values()) {
      entry.audioEl.pause();
    }
    drawVuMeter(true);
  }

  function togglePlayback() {
    if (state.isPlaying) stopPlayback();
    else startPlayback();
  }

  function stepFrames(delta) {
    if (!state.project) return;
    stopPlayback();
    const maxFrame = Math.max(0, getTotalTrack1Frames() - 1);
    state.playheadFrame = Math.max(0, Math.min(maxFrame, state.playheadFrame + delta));
    updatePlayheadUI();
    syncPreviewAtCurrentFrame();
  }

  function drawVuMeter(zeroOut = false) {
    const canvas = el.vuMeterCanvas;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    ctx.fillStyle = '#101214';
    ctx.fillRect(0, 0, w, h);

    let levelL = 0;
    let levelR = 0;

    if (!zeroOut && state.analyserL && state.analyserR) {
      const calcPeak = (analyser) => {
        const buf = new Float32Array(analyser.fftSize);
        analyser.getFloatTimeDomainData(buf);
        let peak = 0;
        for (let i = 0; i < buf.length; i += 1) {
          const a = Math.abs(buf[i]);
          if (a > peak) peak = a;
        }
        return Math.min(1, peak);
      };
      levelL = calcPeak(state.analyserL);
      levelR = calcPeak(state.analyserR);
    }

    const drawBar = (x, barW, level) => {
      const grad = ctx.createLinearGradient(0, h, 0, 0);
      grad.addColorStop(0.0, '#1E8E3E');
      grad.addColorStop(0.7, '#F9AB00');
      grad.addColorStop(0.95, '#D93025');
      ctx.fillStyle = '#1E2226';
      ctx.fillRect(x, 6, barW, h - 12);

      const fillH = Math.round((h - 12) * level);
      ctx.fillStyle = grad;
      ctx.fillRect(x, h - 6 - fillH, barW, fillH);
    };

    drawBar(8, 15, levelL);
    drawBar(31, 15, levelR);
  }

  // -------------------------------------------------------------------------
  // Export Modal & Progress Polling
  // -------------------------------------------------------------------------
  function openExportModal() {
    if (!state.project) return;
    if ((state.project.tracks?.track1 || []).length === 0) {
      showToast('Add at least one clip to Track 1 before exporting.', 'warn');
      return;
    }
    el.exportFilenameInput.value = `${state.project.name || 'gcut'}_export`;
    el.exportProgressArea.classList.add('hidden');
    el.exportDoneActions.classList.add('hidden');
    el.startExportBtn.disabled = false;

    const hw = state.systemStatus.hwSupport || {};
    const codec = el.exportCodecSelect.value;
    const hasVt = codec === 'h265' ? hw.hevc_videotoolbox : hw.h264_videotoolbox;
    el.exportEncoderText.textContent = hasVt
      ? `VideoToolbox hardware encoder ready (${codec.toUpperCase()} -allow_sw 1)`
      : `Software fallback encoder active (${codec === 'h265' ? 'libx265' : 'libx264'})`;

    el.exportModal.classList.remove('hidden');
  }

  async function startExport() {
    if (!state.project) return;
    el.startExportBtn.disabled = true;
    el.exportProgressArea.classList.remove('hidden');
    el.exportDoneActions.classList.add('hidden');
    el.exportStatusText.textContent = 'Starting single-pass FFmpeg export...';
    el.exportPercentText.textContent = '0%';
    el.exportProgressBar.style.width = '0%';

    try {
      const { job } = await apiJson(`/api/projects/${state.project.id}/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          codec: el.exportCodecSelect.value,
          quality: el.exportQualitySelect.value,
          filename: el.exportFilenameInput.value.trim(),
        }),
      });

      el.exportStatusText.textContent = `Rendering (${job.encoderUsed})...`;

      if (state.exportPollTimer) clearInterval(state.exportPollTimer);
      state.exportPollTimer = setInterval(async () => {
        try {
          const data = await apiJson(`/api/projects/${state.project.id}/exports/${job.id}`);
          const j = data.job;
          el.exportPercentText.textContent = `${j.percent}%`;
          el.exportProgressBar.style.width = `${j.percent}%`;

          if (j.status === 'completed') {
            clearInterval(state.exportPollTimer);
            el.exportStatusText.textContent = 'Export complete!';
            el.exportDownloadLink.href = `/api/projects/${state.project.id}/exports/file/${encodeURIComponent(j.filename)}`;
            el.exportSavedPathNote.textContent = `Saved in project exports/${j.filename}`;
            el.exportDoneActions.classList.remove('hidden');
            el.startExportBtn.disabled = false;
            showToast(`Exported ${j.filename}`, 'success');
          } else if (j.status === 'failed') {
            clearInterval(state.exportPollTimer);
            el.exportStatusText.textContent = `Export failed: ${j.error || 'Unknown error'}`;
            el.startExportBtn.disabled = false;
            showToast('FFmpeg export failed', 'error');
          }
        } catch (err) {
          clearInterval(state.exportPollTimer);
          el.exportStatusText.textContent = `Error: ${err.message}`;
          el.startExportBtn.disabled = false;
        }
      }, 450);
    } catch (err) {
      el.exportStatusText.textContent = `Export error: ${err.message}`;
      el.startExportBtn.disabled = false;
      showToast(err.message, 'error');
    }
  }

  // -------------------------------------------------------------------------
  // Event Wiring
  // -------------------------------------------------------------------------
  function wireEvents() {
    [['A', el.videoPlayerA], ['B', el.videoPlayerB]].forEach(([slot, player]) => {
      player.addEventListener('loadedmetadata', () => {
        const pending = state.slotState[slot]?.pendingSeekSec;
        if (pending !== null && pending !== undefined && !player.seeking) {
          player.currentTime = pending;
          state.slotState[slot].pendingSeekSec = null;
        }
      });
    });

    el.themeToggleBtn.onclick = () => {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      applyTheme(next);
    };

    el.projectsBtn.onclick = openProjectsModal;
    el.closeProjectsModalBtn.onclick = closeProjectsModal;
    el.createProjectForm.onsubmit = async (e) => {
      e.preventDefault();
      const name = el.newProjectNameInput.value.trim();
      if (!name) return;
      try {
        const { project } = await apiJson('/api/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        });
        el.newProjectNameInput.value = '';
        await loadProject(project.id);
        closeProjectsModal();
        showToast(`Created project "${project.name}"`, 'success');
      } catch (err) {
        showToast(err.message, 'error');
      }
    };

    el.undoBtn.onclick = performUndo;
    el.redoBtn.onclick = performRedo;

    el.snapToggleBtn.onclick = () => {
      if (!state.project) return;
      pushUndoState();
      state.project.snapEnabled = !state.project.snapEnabled;
      syncToolbarToggles();
      scheduleAutoSave();
    };

    // Finder Drag-and-Drop
    el.finderDropZone.onclick = () => el.finderFileInput.click();
    el.finderFileInput.onchange = (e) => {
      uploadFinderFiles(e.target.files);
      el.finderFileInput.value = '';
    };
    el.finderDropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      el.finderDropZone.classList.add('drag-over');
    });
    el.finderDropZone.addEventListener('dragleave', () => {
      el.finderDropZone.classList.remove('drag-over');
    });
    el.finderDropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      el.finderDropZone.classList.remove('drag-over');
      if (e.dataTransfer?.files?.length) {
        uploadFinderFiles(e.dataTransfer.files);
      }
    });

    el.addFromDiskBtn.onclick = () => openFsBrowser('link');
    el.verifySourcesBtn.onclick = async () => {
      if (!state.project) return;
      try {
        const data = await apiJson(`/api/projects/${state.project.id}/verify-sources`, { method: 'POST' });
        state.project.sources = data.sources;
        renderSourcesList();
        const missingCount = data.sources.filter((s) => s.missing).length;
        showToast(
          missingCount > 0 ? `${missingCount} source file(s) missing on disk.` : 'All source files verified.',
          missingCount > 0 ? 'warn' : 'success'
        );
      } catch (err) {
        showToast(err.message, 'error');
      }
    };

    // Folder Browser Modal
    el.closeFsBrowserBtn.onclick = closeFsBrowser;
    el.fsCancelBtn.onclick = closeFsBrowser;
    el.fsUpBtn.onclick = () => {
      if (state.fsParentDir) loadFsDirectory(state.fsParentDir);
    };
    el.fsConfirmBtn.onclick = async () => {
      if (!state.project || state.fsSelectedPaths.length === 0) return;
      el.fsConfirmBtn.disabled = true;
      try {
        if (state.fsMode === 'relink') {
          const data = await apiJson(
            `/api/projects/${state.project.id}/sources/${state.relinkSourceId}/relink`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ newPath: state.fsSelectedPaths[0] }),
            }
          );
          state.project.sources = data.sources;
          await preloadMissingPeaks();
          renderSourcesList();
          renderTimelineAndInspector();
          syncAudioPool();
          syncPreviewAtCurrentFrame();
          showToast('Relocated missing file successfully.', 'success');
        } else {
          const data = await apiJson(`/api/projects/${state.project.id}/sources/link`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ paths: state.fsSelectedPaths }),
          });
          state.project.sources = data.sources;
          await preloadMissingPeaks();
          renderSourcesList();
          if (data.errors?.length) showToast(data.errors.join(' | '), 'warn');
          else showToast(`Linked ${data.added.length} file(s)`, 'success');
        }
        closeFsBrowser();
      } catch (err) {
        showToast(err.message, 'error');
        el.fsConfirmBtn.disabled = false;
      }
    };

    // Transport Controls
    el.jumpStartBtn.onclick = () => {
      stopPlayback();
      state.playheadFrame = 0;
      updatePlayheadUI();
      syncPreviewAtCurrentFrame();
    };
    el.stepBackBtn.onclick = () => stepFrames(-1);
    el.stepForwardBtn.onclick = () => stepFrames(1);
    el.playPauseBtn.onclick = togglePlayback;
    el.trimLeftBtn.onclick = trimLeftAtPlayhead;
    el.splitBtn.onclick = splitAtPlayhead;
    el.trimRightBtn.onclick = trimRightAtPlayhead;

    // Ruler Scrubbing (1-frame increments)
    const scrubToClientX = (clientX) => {
      const rect = el.timelineRuler.getBoundingClientRect();
      const rawFrame = Math.max(0, Math.round((clientX - rect.left) / state.pxPerFrame));
      const snap = snapFrameIfEnabled(rawFrame);
      state.playheadFrame = snap.frame;
      showSnapGuide(snap.snappedTo);
      updatePlayheadUI();
      syncPreviewAtCurrentFrame();
    };

    el.timelineRuler.addEventListener('mousedown', (e) => {
      stopPlayback();
      scrubToClientX(e.clientX);
      const onMove = (me) => scrubToClientX(me.clientX);
      const onUp = () => {
        showSnapGuide(null);
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });

    // Drop from Sources Bin onto 3 Timeline Lanes
    [
      { lane: el.track1Lane, key: 'track1' },
      { lane: el.track2Lane, key: 'track2' },
      { lane: el.track3Lane, key: 'track3' },
    ].forEach(({ lane, key }) => {
      lane.addEventListener('dragover', (e) => {
        e.preventDefault();
        lane.classList.add('drag-target');
      });
      lane.addEventListener('dragleave', () => {
        lane.classList.remove('drag-target');
      });
      lane.addEventListener('drop', (e) => {
        e.preventDefault();
        lane.classList.remove('drag-target');
        let sourceId = state.dragSourceId;
        try {
          const parsed = JSON.parse(e.dataTransfer.getData('text/plain'));
          if (parsed && parsed.kind === 'source') sourceId = parsed.sourceId;
        } catch {
          // Use fallback state.dragSourceId
        }
        state.dragSourceId = null;
        if (!sourceId) return;
        const rect = lane.getBoundingClientRect();
        const rawFrame = Math.max(0, Math.round((e.clientX - rect.left) / state.pxPerFrame));
        const snapped = key === 'track1' ? rawFrame : snapFrameIfEnabled(rawFrame).frame;
        addSourceToTrack(sourceId, key, snapped);
      });
    });

    // Inspector Controls
    const applySpeedChange = (newSpeed) => {
      const sel = getSelectedClipObj();
      if (!sel || sel.trackKey !== 'track1') return;
      const clamped = Math.max(0.25, Math.min(4.0, Number(newSpeed) || 1));
      pushUndoState();
      const segStart = sel.clip.timelineStartFrame || 0;
      const oldDur = getClipDurationFrames(sel.clip, 'track1');
      sel.clip.speed = Number(clamped.toFixed(3));
      repackTrack1();
      const newDur = getClipDurationFrames(sel.clip, 'track1');
      shiftAudioFromSegmentStart(segStart, newDur - oldDur);
      renderTimelineAndInspector();
      syncPreviewAtCurrentFrame();
      scheduleAutoSave();
    };

    el.speedPresetSelect.onchange = () => {
      if (el.speedPresetSelect.value !== 'custom') {
        applySpeedChange(Number(el.speedPresetSelect.value));
      }
    };
    el.speedFineInput.onchange = () => applySpeedChange(Number(el.speedFineInput.value));

    el.reverseToggleBtn.onclick = () => {
      const sel = getSelectedClipObj();
      if (!sel || sel.trackKey !== 'track1') return;
      pushUndoState();
      sel.clip.reversed = !sel.clip.reversed;
      renderTimelineAndInspector();
      syncPreviewAtCurrentFrame();
      scheduleAutoSave();
    };

    let volumeUndoPending = false;
    el.volumeRange.oninput = () => {
      const sel = getSelectedClipObj();
      if (!sel) return;
      if (!volumeUndoPending) {
        pushUndoState();
        volumeUndoPending = true;
      }
      const val = Number(el.volumeRange.value) / 100;
      sel.clip.volume = val;
      el.volumeLabel.textContent = `${Math.round(val * 100)}%`;
    };
    el.volumeRange.onchange = () => {
      volumeUndoPending = false;
      scheduleAutoSave();
    };

    const applyFadeChange = (field, rawVal) => {
      const sel = getSelectedClipObj();
      if (!sel) return;
      const durSec = getClipDurationFrames(sel.clip, sel.trackKey) / FPS;
      // Round strictly to 0.1s steps and clamp safely to clip duration
      const stepped = Math.round(Math.max(0, Number(rawVal) || 0) * 10) / 10;
      const otherField = field === 'fadeInSec' ? 'fadeOutSec' : 'fadeInSec';
      const otherVal = Number(sel.clip[otherField]) || 0;
      const maxAllowed = Math.max(0, Math.floor((durSec - otherVal) * 10) / 10);
      const clamped = Math.min(stepped, maxAllowed);

      pushUndoState();
      sel.clip[field] = Number(clamped.toFixed(1));
      renderTimelineAndInspector();
      scheduleAutoSave();
    };

    el.fadeInInput.onchange = () => applyFadeChange('fadeInSec', el.fadeInInput.value);
    el.fadeOutInput.onchange = () => applyFadeChange('fadeOutSec', el.fadeOutInput.value);
    el.deleteClipBtn.onclick = deleteSelectedClip;

    // Zoom Controls (Slider + Cmd/Ctrl + Wheel centered on playhead)
    el.zoomSlider.oninput = () => updateZoomFromSlider(el.zoomSlider.value, true);
    el.zoomFitBtn.onclick = fitTimelineToProject;
    el.timelineViewport.addEventListener(
      'wheel',
      (e) => {
        if (e.metaKey || e.ctrlKey) {
          e.preventDefault();
          const factor = e.deltaY < 0 ? 1.15 : 0.87;
          setZoomScale(state.pxPerFrame * factor, true);
        }
      },
      { passive: false }
    );

    // Export Modal
    el.exportModalBtn.onclick = openExportModal;
    el.closeExportModalBtn.onclick = () => el.exportModal.classList.add('hidden');
    el.cancelExportBtn.onclick = () => el.exportModal.classList.add('hidden');
    el.exportCodecSelect.onchange = () => {
      const hw = state.systemStatus.hwSupport || {};
      const codec = el.exportCodecSelect.value;
      const hasVt = codec === 'h265' ? hw.hevc_videotoolbox : hw.h264_videotoolbox;
      el.exportEncoderText.textContent = hasVt
        ? `VideoToolbox hardware encoder ready (${codec.toUpperCase()} -allow_sw 1)`
        : `Software fallback encoder active (${codec === 'h265' ? 'libx265' : 'libx264'})`;
    };
    el.startExportBtn.onclick = startExport;

    // Global Keyboard Shortcuts
    window.addEventListener('keydown', (e) => {
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable) return;

      const isMod = e.metaKey || e.ctrlKey;
      if (isMod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) performRedo();
        else performUndo();
        return;
      }

      if (e.code === 'Space') {
        e.preventDefault();
        togglePlayback();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        stepFrames(-1);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        stepFrames(1);
      } else if (e.key.toLowerCase() === 's' && !isMod) {
        e.preventDefault();
        splitAtPlayhead();
      } else if (e.key === '[' && !isMod) {
        e.preventDefault();
        trimLeftAtPlayhead();
      } else if (e.key === ']' && !isMod) {
        e.preventDefault();
        trimRightAtPlayhead();
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (state.selectedClip) {
          e.preventDefault();
          deleteSelectedClip();
        }
      }
    });
  }

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------
  async function init() {
    applyTheme(localStorage.getItem('montage_theme') || 'dark');
    drawVuMeter(true);
    wireEvents();

    try {
      state.systemStatus = await apiJson('/api/system/status');
      if (!state.systemStatus.ffmpegFound || !state.systemStatus.ffprobeFound) {
        el.ffmpegBanner.classList.remove('hidden');
        el.ffmpegBannerText.innerHTML =
          'FFmpeg or FFprobe was not found in <code>/opt/homebrew/bin</code>, <code>/usr/local/bin</code>, or <code>PATH</code>. Install via <code>brew install ffmpeg</code> and restart.';
      }
    } catch {
      // Non-fatal
    }

    try {
      const { projects } = await apiJson('/api/projects');
      state.projectsList = projects || [];
      const lastId = localStorage.getItem('montage_last_project');
      const targetProj = state.projectsList.find((p) => p.id === lastId) || state.projectsList[0];

      if (targetProj) {
        await loadProject(targetProj.id);
      }
      // Always expose Projects Hub on startup so user can create, clone, or switch projects
      openProjectsModal();
    } catch (err) {
      showToast(`Startup error: ${err.message}`, 'error');
    }
  }

  init();
})();
