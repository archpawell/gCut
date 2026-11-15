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
    fsSortMode: 'date', // 'date' (Change Date Newest First) | 'alpha' (Folders A-Z, Files A-Z)
    fsDirectories: [],
    fsFiles: [],

    // Drag / trim interaction state
    dragSourceId: null,
    exportPollTimer: null,
    transitionPopover: null, // { fromClipId, toClipId }
    fullscreenActive: false,
    fullscreenHudTimer: null,
    cgPreDragSnapshot: null,
    lastRenderedColorClipId: null,
    exportFilenameTouched: false,
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
    magSnapIcon: document.getElementById('magSnapIcon'),
    updateAppBtn: document.getElementById('updateAppBtn'),
    themeToggleBtn: document.getElementById('themeToggleBtn'),
    themeIcon: document.getElementById('themeIcon'),
    exportModalBtn: document.getElementById('exportModalBtn'),
    customExportBtn: document.getElementById('customExportBtn'),

    sourceCountPill: document.getElementById('sourceCountPill'),
    verifySourcesBtn: document.getElementById('verifySourcesBtn'),
    addFromDiskBtn: document.getElementById('addFromDiskBtn'),
    finderDropZone: document.getElementById('finderDropZone'),
    finderFileInput: document.getElementById('finderFileInput'),
    sourcesList: document.getElementById('sourcesList'),

    previewFullscreenContainer: document.getElementById('previewFullscreenContainer'),
    previewStage: document.getElementById('previewStage'),
    videoPlayerA: document.getElementById('videoPlayerA'),
    videoPlayerB: document.getElementById('videoPlayerB'),
    previewTransitionOverlay: document.getElementById('previewTransitionOverlay'),
    previewEmptyOverlay: document.getElementById('previewEmptyOverlay'),
    previewClipBadge: document.getElementById('previewClipBadge'),
    fullscreenHud: document.getElementById('fullscreenHud'),
    fsPlayPauseBtn: document.getElementById('fsPlayPauseBtn'),
    fsPlayPauseIcon: document.getElementById('fsPlayPauseIcon'),
    fsPlayPauseLabel: document.getElementById('fsPlayPauseLabel'),
    fsExitBtn: document.getElementById('fsExitBtn'),
    colorGradingPanel: document.getElementById('colorGradingPanel'),
    cgClipTargetLabel: document.getElementById('cgClipTargetLabel'),
    cgResetAllBtn: document.getElementById('cgResetAllBtn'),
    cgExposureSlider: document.getElementById('cgExposureSlider'),
    cgExposureVal: document.getElementById('cgExposureVal'),
    cgSaturationSlider: document.getElementById('cgSaturationSlider'),
    cgSaturationVal: document.getElementById('cgSaturationVal'),
    cgContrastSlider: document.getElementById('cgContrastSlider'),
    cgContrastVal: document.getElementById('cgContrastVal'),
    cgHueSlider: document.getElementById('cgHueSlider'),
    cgHueVal: document.getElementById('cgHueVal'),
    cgRedSlider: document.getElementById('cgRedSlider'),
    cgRedVal: document.getElementById('cgRedVal'),
    cgGreenSlider: document.getElementById('cgGreenSlider'),
    cgGreenVal: document.getElementById('cgGreenVal'),
    cgBlueSlider: document.getElementById('cgBlueSlider'),
    cgBlueVal: document.getElementById('cgBlueVal'),
    clipRgbMatrixA: document.getElementById('clipRgbMatrixA'),
    clipRgbMatrixB: document.getElementById('clipRgbMatrixB'),
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
    fullscreenBtn: document.getElementById('fullscreenBtn'),

    inspectorEmpty: document.getElementById('inspectorEmpty'),
    inspectorControls: document.getElementById('inspectorControls'),
    inspectorTrackBadge: document.getElementById('inspectorTrackBadge'),
    inspectorClipName: document.getElementById('inspectorClipName'),
    inspectorClipRange: document.getElementById('inspectorClipRange'),
    videoInspectorGroup: document.getElementById('videoInspectorGroup'),
    speedPresetSelect: document.getElementById('speedPresetSelect'),
    speedFineInput: document.getElementById('speedFineInput'),
    reverseToggleBtn: document.getElementById('reverseToggleBtn'),
    mirrorToggleBtn: document.getElementById('mirrorToggleBtn'),
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
    fsSortDateBtn: document.getElementById('fsSortDateBtn'),
    fsSortAlphaBtn: document.getElementById('fsSortAlphaBtn'),
    closeFsBrowserBtn: document.getElementById('closeFsBrowserBtn'),
    fsShortcuts: document.getElementById('fsShortcuts'),
    fsUpBtn: document.getElementById('fsUpBtn'),
    fsCurrentPath: document.getElementById('fsCurrentPath'),
    fsEntriesList: document.getElementById('fsEntriesList'),
    fsSelectionInfo: document.getElementById('fsSelectionInfo'),
    fsCancelBtn: document.getElementById('fsCancelBtn'),
    fsConfirmBtn: document.getElementById('fsConfirmBtn'),

    exportModal: document.getElementById('exportModal'),
    exportModalTitle: document.getElementById('exportModalTitle'),
    exportFormArea: document.getElementById('exportFormArea'),
    closeExportModalBtn: document.getElementById('closeExportModalBtn'),
    exportFilenameInput: document.getElementById('exportFilenameInput'),
    exportResolutionSelect: document.getElementById('exportResolutionSelect'),
    exportAudioBitrateSelect: document.getElementById('exportAudioBitrateSelect'),
    exportCodecSelect: document.getElementById('exportCodecSelect'),
    exportEncoderModeSelect: document.getElementById('exportEncoderModeSelect'),
    exportRateControlSelect: document.getElementById('exportRateControlSelect'),
    exportCrfRow: document.getElementById('exportCrfRow'),
    exportCrfSlider: document.getElementById('exportCrfSlider'),
    exportCrfInput: document.getElementById('exportCrfInput'),
    exportCrfMappedHint: document.getElementById('exportCrfMappedHint'),
    exportBitrateRow: document.getElementById('exportBitrateRow'),
    exportBitrateSlider: document.getElementById('exportBitrateSlider'),
    exportBitrateInput: document.getElementById('exportBitrateInput'),
    exportBitrateMappedHint: document.getElementById('exportBitrateMappedHint'),
    exportPresetRow: document.getElementById('exportPresetRow'),
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

    transitionPopover: document.getElementById('transitionPopover'),
    closeTransitionPopoverBtn: document.getElementById('closeTransitionPopoverBtn'),
    transitionPopoverMeta: document.getElementById('transitionPopoverMeta'),
    transOptTransformBtn: document.getElementById('transOptTransformBtn'),
    transOptTransformHint: document.getElementById('transOptTransformHint'),
    transOptFadeBlackBtn: document.getElementById('transOptFadeBlackBtn'),
    transOptFadeBlackHint: document.getElementById('transOptFadeBlackHint'),
    transOptFadeWhiteBtn: document.getElementById('transOptFadeWhiteBtn'),
    transOptFadeWhiteHint: document.getElementById('transOptFadeWhiteHint'),
    transitionRampRow: document.getElementById('transitionRampRow'),
    transitionRampMaxHint: document.getElementById('transitionRampMaxHint'),
    transitionRampMinusBtn: document.getElementById('transitionRampMinusBtn'),
    transitionRampInput: document.getElementById('transitionRampInput'),
    transitionRampPlusBtn: document.getElementById('transitionRampPlusBtn'),

    updateOverlay: document.getElementById('updateOverlay'),
    updateOverlayTitle: document.getElementById('updateOverlayTitle'),
    updateOverlaySub: document.getElementById('updateOverlaySub'),
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

  function clampColorGrade(val) {
    const n = Math.round(Number(val) || 0);
    return Math.max(-100, Math.min(100, n));
  }

  function clampHueGrade(val) {
    const n = Math.round(Number(val) || 0);
    return Math.max(-180, Math.min(180, n));
  }

  function formatSignedGrade(val) {
    const v = clampColorGrade(val);
    return v > 0 ? `+${v}` : String(v);
  }

  function formatSignedHue(val) {
    const v = clampHueGrade(val);
    return `${v > 0 ? `+${v}` : String(v)}°`;
  }

  function isClipColorDefault(clip) {
    if (!clip) return true;
    return (
      clampColorGrade(clip.exposure) === 0 &&
      clampColorGrade(clip.saturation) === 0 &&
      clampColorGrade(clip.contrast) === 0 &&
      clampHueGrade(clip.hue) === 0 &&
      clampColorGrade(clip.red) === 0 &&
      clampColorGrade(clip.green) === 0 &&
      clampColorGrade(clip.blue) === 0
    );
  }

  function normalizeProjectModel(project) {
    if (!project || typeof project !== 'object') return project;
    if (!project.tracks || typeof project.tracks !== 'object') {
      project.tracks = { track1: [], track2: [], track3: [] };
    }
    project.tracks.track1 = Array.isArray(project.tracks.track1)
      ? project.tracks.track1.map((c) => ({
          ...c,
          mirrored: Boolean(c.mirrored),
          exposure: clampColorGrade(c.exposure),
          saturation: clampColorGrade(c.saturation),
          contrast: clampColorGrade(c.contrast),
          hue: clampHueGrade(c.hue),
          red: clampColorGrade(c.red),
          green: clampColorGrade(c.green),
          blue: clampColorGrade(c.blue),
        }))
      : [];
    project.tracks.track2 = Array.isArray(project.tracks.track2) ? project.tracks.track2 : [];
    project.tracks.track3 = Array.isArray(project.tracks.track3) ? project.tracks.track3 : [];
    project.transitions = Array.isArray(project.transitions)
      ? project.transitions
          .filter(
            (t) =>
              t &&
              typeof t.fromClipId === 'string' &&
              typeof t.toClipId === 'string' &&
              ['transform', 'fade_black', 'fade_white'].includes(t.type)
          )
          .map((t) => ({
            fromClipId: t.fromClipId,
            toClipId: t.toClipId,
            type: t.type,
            rampFrames: t.type === 'transform' ? 1 : Math.max(1, Math.round(Number(t.rampFrames) || 1)),
          }))
      : [];
    return project;
  }

  function getClipDurationFrames(clip, trackKey) {
    const span = Math.max(1, (clip.outFrame || 0) - (clip.inFrame || 0));
    if (trackKey === 'track1') {
      const speed = Number(clip.speed) > 0 ? Number(clip.speed) : 1;
      return Math.max(1, Math.floor(span / speed));
    }
    return span;
  }

  function getTransitionNetDelta(type) {
    if (type === 'transform') return -1;
    if (type === 'fade_black' || type === 'fade_white') return 1;
    return 0;
  }

  function getTransitionFootprintFrames(t) {
    if (!t) return 0;
    if (t.type === 'transform') return 1;
    if (t.type === 'fade_black' || t.type === 'fade_white') {
      return Math.max(1, Math.round(Number(t.rampFrames) || 1));
    }
    return 0;
  }

  function getAdjacentTransition(fromClipId, toClipId) {
    if (!state.project || !fromClipId || !toClipId) return null;
    return (
      (state.project.transitions || []).find(
        (t) => t.fromClipId === fromClipId && t.toClipId === toClipId
      ) || null
    );
  }

  function getMinRequiredFramesForTransitions(leftTrans, rightTrans) {
    const leftFrames = getTransitionFootprintFrames(leftTrans);
    const rightFrames = getTransitionFootprintFrames(rightTrans);
    let minTypeFrames = 1;
    if (
      (leftTrans && (leftTrans.type === 'fade_black' || leftTrans.type === 'fade_white')) ||
      (rightTrans && (rightTrans.type === 'fade_black' || rightTrans.type === 'fade_white'))
    ) {
      minTypeFrames = 7;
    } else if (
      (leftTrans && leftTrans.type === 'transform') ||
      (rightTrans && rightTrans.type === 'transform')
    ) {
      minTypeFrames = 3;
    }
    return Math.max(minTypeFrames, leftFrames + rightFrames + 1);
  }

  function getClipTransitionInfo(clipId) {
    const t1 = state.project?.tracks?.track1 || [];
    const idx = t1.findIndex((c) => c.id === clipId);
    const leftTransition = idx > 0 ? getAdjacentTransition(t1[idx - 1].id, clipId) : null;
    const rightTransition =
      idx >= 0 && idx < t1.length - 1 ? getAdjacentTransition(clipId, t1[idx + 1].id) : null;
    const leftTransitionFrames = getTransitionFootprintFrames(leftTransition);
    const rightTransitionFrames = getTransitionFootprintFrames(rightTransition);
    const minAllowedFrames = getMinRequiredFramesForTransitions(leftTransition, rightTransition);
    return {
      leftTransition,
      rightTransition,
      leftTransitionFrames,
      rightTransitionFrames,
      minAllowedFrames,
    };
  }

  function getMaxRampFrames(clipA, clipB) {
    const infoA = getClipTransitionInfo(clipA.id);
    const infoB = getClipTransitionInfo(clipB.id);
    const durA = getClipDurationFrames(clipA, 'track1');
    const durB = getClipDurationFrames(clipB, 'track1');
    return Math.max(
      0,
      Math.min(durA - 1 - infoA.leftTransitionFrames, durB - 1 - infoB.rightTransitionFrames)
    );
  }

  function snapshotValidJunctions() {
    if (!state.project) return [];
    const t1 = state.project.tracks?.track1 || [];
    const snaps = [];
    for (let i = 0; i < t1.length - 1; i += 1) {
      const a = t1[i];
      const b = t1[i + 1];
      const t = getAdjacentTransition(a.id, b.id);
      if (!t) continue;
      snaps.push({
        fromClipId: a.id,
        toClipId: b.id,
        type: t.type,
        rampFrames: t.rampFrames,
        delta: getTransitionNetDelta(t.type),
        junctionFrame: b.timelineStartFrame || 0,
      });
    }
    return snaps;
  }

  function pruneInvalidTransitionsAndRestoreAudio(beforeJunctions = []) {
    if (!state.project) return;
    const t1 = state.project.tracks?.track1 || [];
    const validPairs = new Set();
    for (let i = 0; i < t1.length - 1; i += 1) {
      validPairs.add(`${t1[i].id}::${t1[i + 1].id}`);
    }

    const survivingKeys = new Set();
    state.project.transitions = (state.project.transitions || []).filter((t) => {
      const key = `${t.fromClipId}::${t.toClipId}`;
      if (!validPairs.has(key)) return false;
      const a = t1.find((c) => c.id === t.fromClipId);
      const b = t1.find((c) => c.id === t.toClipId);
      if (!a || !b) return false;
      const durA = getClipDurationFrames(a, 'track1');
      const durB = getClipDurationFrames(b, 'track1');
      if (t.type === 'transform' && (durA < 3 || durB < 3)) return false;
      if ((t.type === 'fade_black' || t.type === 'fade_white') && (durA < 7 || durB < 7)) return false;
      survivingKeys.add(key);
      return true;
    });

    // Restore downstream audio for transitions that became invalid during reorder/insert
    const removed = beforeJunctions
      .filter((s) => !survivingKeys.has(`${s.fromClipId}::${s.toClipId}`))
      .sort((x, y) => y.junctionFrame - x.junctionFrame);
    for (const s of removed) {
      const restoreShift = -s.delta;
      if (restoreShift > 0) {
        shiftAudioFromSegmentStart(s.junctionFrame, restoreShift);
      } else if (restoreShift < 0) {
        applyAudioCutRipple(s.junctionFrame + restoreShift, s.junctionFrame);
      }
    }

    repackTrack1();
  }

  function getTotalTrack1Frames() {
    if (!state.project) return 0;
    const t1 = state.project.tracks?.track1 || [];
    let total = 0;
    for (let i = 0; i < t1.length; i += 1) {
      total += getClipDurationFrames(t1[i], 'track1');
      if (i < t1.length - 1) {
        const t = getAdjacentTransition(t1[i].id, t1[i + 1].id);
        if (t) total += getTransitionNetDelta(t.type);
      }
    }
    return Math.max(0, total);
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
    const t1 = state.project.tracks.track1;
    let cursor = 0;
    for (let i = 0; i < t1.length; i += 1) {
      t1[i].timelineStartFrame = cursor;
      cursor += getClipDurationFrames(t1[i], 'track1');
      if (i < t1.length - 1) {
        const t = getAdjacentTransition(t1[i].id, t1[i + 1].id);
        if (t) cursor += getTransitionNetDelta(t.type);
      }
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

  function applyAudioCutRipple(cutStartFrame, cutEndFrame) {
    if (!state.project || cutEndFrame <= cutStartFrame) return;
    const removedFrames = cutEndFrame - cutStartFrame;
    const safeSnap = Math.max(0, Math.round(cutStartFrame));
    for (const tk of ['track2', 'track3']) {
      for (const clip of state.project.tracks[tk]) {
        const curStart = clip.timelineStartFrame || 0;
        if (curStart < cutStartFrame) continue;
        if (curStart >= cutEndFrame) {
          clip.timelineStartFrame = Math.max(0, Math.round(curStart - removedFrames));
        } else {
          clip.timelineStartFrame = safeSnap;
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
  const brandLogoDataUrlCache = new Map();

  function buildCircularBrandLogoDataUrl(img) {
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
    const tolerance = 34;

    const visited = new Uint8Array(size * size);
    const queue = new Int32Array(size * size);
    let head = 0;
    let tail = 0;

    const enqueueIfOuterBg = (idx) => {
      if (visited[idx]) return;
      const off = idx * 4;
      const dist = Math.hypot(data[off] - bgR, data[off + 1] - bgG, data[off + 2] - bgB);
      if (dist < tolerance) {
        visited[idx] = 1;
        queue[tail++] = idx;
      }
    };

    enqueueIfOuterBg(0);
    enqueueIfOuterBg(size - 1);
    enqueueIfOuterBg((size - 1) * size);
    enqueueIfOuterBg(size * size - 1);

    while (head < tail) {
      const idx = queue[head++];
      data[idx * 4 + 3] = 0;

      const x = idx % size;
      const y = (idx - x) / size;
      if (x > 0) enqueueIfOuterBg(idx - 1);
      if (x < size - 1) enqueueIfOuterBg(idx + 1);
      if (y > 0) enqueueIfOuterBg(idx - size);
      if (y < size - 1) enqueueIfOuterBg(idx + size);
    }

    // Apply circular emblem boundary mask so no square corners survive in Dark Mode
    const cx = (size - 1) / 2;
    const cy = (size - 1) / 2;
    const innerR = 121.0;
    const outerR = 124.5;
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const d = Math.hypot(x - cx, y - cy);
        if (d > innerR) {
          const off = (y * size + x) * 4;
          if (d >= outerR) {
            data[off + 3] = 0;
          } else {
            const factor = Math.max(0, Math.min(1, (outerR - d) / (outerR - innerR)));
            data[off + 3] = Math.round(data[off + 3] * factor);
          }
        }
      }
    }

    workCtx.putImageData(imgData, 0, 0);
    return workCanvas.toDataURL('image/png');
  }

  function updateCircularBrandLogo(resolvedTheme) {
    if (!el.brandLogoImg) return;
    if (brandLogoDataUrlCache.has(resolvedTheme)) {
      el.brandLogoImg.src = brandLogoDataUrlCache.get(resolvedTheme);
      return;
    }

    const srcUrl = resolvedTheme === 'light' ? '/LOGO_W.jpg' : '/LOGO_B.jpg';
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const dataUrl = buildCircularBrandLogoDataUrl(img);
        brandLogoDataUrlCache.set(resolvedTheme, dataUrl);
        if (document.documentElement.dataset.theme === resolvedTheme && el.brandLogoImg) {
          el.brandLogoImg.src = dataUrl;
        }
      } catch {
        el.brandLogoImg.src = srcUrl;
      }
    };
    img.onerror = () => {
      if (el.brandLogoImg) el.brandLogoImg.src = srcUrl;
    };
    img.src = srcUrl;
  }

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

  function prepareMagSnapIcon() {
    if (!el.magSnapIcon) return;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const size = 64;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, size, size);
        ctx.drawImage(img, 0, 0, size, size);
        const imgData = ctx.getImageData(0, 0, size, size);
        const data = imgData.data;

        const cornerAlpha = data[3];
        if (cornerAlpha >= 20) {
          // Opaque background: flood-fill 4 corners to clear light background cleanly
          const cr = data[0];
          const cg = data[1];
          const cb = data[2];
          const visited = new Uint8Array(size * size);
          const queue = [0, size - 1, (size - 1) * size, size * size - 1];
          let head = 0;
          while (head < queue.length) {
            const p = queue[head++];
            if (visited[p]) continue;
            visited[p] = 1;
            const i = p * 4;
            const dist = Math.hypot(data[i] - cr, data[i + 1] - cg, data[i + 2] - cb);
            if (dist < 42) {
              data[i + 3] = 0;
              const x = p % size;
              const y = (p - x) / size;
              if (x > 0 && !visited[p - 1]) queue.push(p - 1);
              if (x + 1 < size && !visited[p + 1]) queue.push(p + 1);
              if (y > 0 && !visited[p - size]) queue.push(p - size);
              if (y + 1 < size && !visited[p + size]) queue.push(p + size);
            }
          }
        }

        // Normalize all visible foreground artwork to pure black (#000000) so invert(1) works cleanly
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] > 0) {
            data[i] = 0;
            data[i + 1] = 0;
            data[i + 2] = 0;
          }
        }
        ctx.putImageData(imgData, 0, 0);
        el.magSnapIcon.src = canvas.toDataURL('image/png');
      } catch {
        // Keep static /magnet.png fallback on error
      }
    };
    img.src = '/magnet.png';
  }

  function applyTheme(theme) {
    const resolved = theme === 'light' ? 'light' : 'dark';
    document.documentElement.dataset.theme = resolved;
    localStorage.setItem('montage_theme', resolved);
    el.themeIcon.textContent = resolved === 'dark' ? 'light_mode' : 'dark_mode';
    updateCircularBrandLogo(resolved);
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
      transitions: state.project.transitions || [],
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
    state.project.transitions = Array.isArray(snap.transitions) ? snap.transitions : [];
    state.project.snapEnabled = snap.snapEnabled;
    state.project.rippleSyncAudio = snap.rippleSyncAudio;
    normalizeProjectModel(state.project);
    closeTransitionPopover();
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

  function clearProjectHistory() {
    if (!state.project) return;
    const hist = getProjectHistory();
    hist.undo.length = 0;
    hist.redo.length = 0;
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

  async function flushProjectSaveNow() {
    if (!state.project) return;
    if (state.saveTimer) {
      clearTimeout(state.saveTimer);
      state.saveTimer = null;
    }
    const targetProjectId = state.project.id;
    setSaveBadge('saving');
    await apiJson(`/api/projects/${targetProjectId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: state.project.name,
        snapEnabled: state.project.snapEnabled,
        rippleSyncAudio: state.project.rippleSyncAudio,
        sources: state.project.sources,
        tracks: state.project.tracks,
        transitions: state.project.transitions || [],
      }),
    });
    state.isDirty = false;
    setSaveBadge('saved');
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
            transitions: state.project.transitions || [],
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
    state.project = normalizeProjectModel(project);
    state.selectedClip = null;
    closeTransitionPopover();
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

  function isSourceUsedOnTimeline(sourceId) {
    const tracks = state.project?.tracks;
    if (!tracks || !sourceId) return false;
    for (const tk of ['track1', 'track2', 'track3']) {
      const clips = tracks[tk] || [];
      if (clips.some((c) => c.sourceId === sourceId)) return true;
    }
    return false;
  }

  function filterDuplicateFilesByName(items, getName) {
    const existingNames = new Set(
      (state.project?.sources || []).map((s) => String(s.name || '').toLowerCase())
    );
    const accepted = [];
    const skipped = [];
    for (const item of items) {
      const name = String(getName(item) || '');
      const lower = name.toLowerCase();
      if (existingNames.has(lower)) {
        skipped.push(name);
      } else {
        existingNames.add(lower);
        accepted.push(item);
      }
    }
    return { accepted, skipped };
  }

  async function deleteUnusedSource(src, triggerBtn) {
    if (!state.project || !src) return;
    if (isSourceUsedOnTimeline(src.id)) {
      showToast('Delete clips from timeline before deleting source file.', 'warn');
      renderSourcesList();
      return;
    }

    if (triggerBtn) triggerBtn.disabled = true;
    try {
      await flushProjectSaveNow();
      const url = `/api/projects/${state.project.id}/media/${encodeURIComponent(src.name)}?sourceId=${encodeURIComponent(src.id)}`;
      const data = await apiJson(url, { method: 'DELETE' });
      state.peaksCache.delete(src.id);
      state.project.sources = Array.isArray(data.sources)
        ? data.sources
        : (state.project.sources || []).filter((s) => s.id !== src.id);
      clearProjectHistory();
      state.isDirty = false;
      setSaveBadge('saved');
      renderSourcesList();
      showToast(`Deleted unused media: ${src.name}`, 'success');
    } catch (err) {
      if (triggerBtn) triggerBtn.disabled = false;
      showToast(err.message || 'Failed to delete media file.', 'error');
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
      const inUse = isSourceUsedOnTimeline(src.id);
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

      if (inUse) {
        const inUseBadge = document.createElement('span');
        inUseBadge.className = 'meta-badge in-use';
        inUseBadge.title = 'Referenced by timeline clip(s) — delete clips from timeline to unlock deletion';
        inUseBadge.textContent = 'In use';
        badges.appendChild(inUseBadge);
      }

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

      if (!inUse) {
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'source-delete-btn';
        delBtn.title = `Delete unused file: ${src.name}`;
        delBtn.setAttribute('aria-label', `Delete ${src.name}`);
        delBtn.textContent = 'X';
        delBtn.draggable = false;
        delBtn.onmousedown = (ev) => ev.stopPropagation();
        delBtn.onclick = (ev) => {
          ev.stopPropagation();
          deleteUnusedSource(src, delBtn);
        };
        card.appendChild(delBtn);
      }

      el.sourcesList.appendChild(card);
    }
  }

  async function uploadFinderFiles(fileList) {
    if (!state.project) return;
    const files = Array.from(fileList || []);
    if (files.length === 0) return;

    const { accepted, skipped } = filterDuplicateFilesByName(files, (f) => f.name);
    if (skipped.length > 0) {
      for (const name of skipped) {
        showToast(`Skipped duplicate filename: ${name}`, 'warn');
      }
    }
    if (accepted.length === 0) return;

    if (accepted.length > MAX_IMPORT_BATCH) {
      showToast(`Batch limit exceeded: you dropped ${accepted.length} clips. Maximum is ${MAX_IMPORT_BATCH} clips at once.`, 'error');
      return;
    }

    const invalid = accepted.filter((f) => !hasAllowedExtension(f.name));
    if (invalid.length > 0) {
      showToast(`Unsupported extension(s): ${invalid.map((f) => f.name).join(', ')}`, 'error');
      return;
    }

    const formData = new FormData();
    for (const f of accepted) {
      formData.append('files', f);
    }

    try {
      showToast(`Inspecting & importing ${accepted.length} clip(s)...`, 'info');
      const data = await apiJson(`/api/projects/${state.project.id}/sources/upload`, {
        method: 'POST',
        body: formData,
      });
      state.project.sources = data.sources;
      await preloadMissingPeaks();
      renderSourcesList();
      if (data.skipped?.length) {
        for (const name of data.skipped) {
          showToast(`Skipped duplicate filename: ${name}`, 'warn');
        }
      }
      if (data.errors?.length) {
        showToast(data.errors.join(' | '), 'warn');
      } else if (data.added?.length) {
        showToast(`Imported ${data.added.length} clip(s) into project sources/`, 'success');
      }
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  // -------------------------------------------------------------------------
  // macOS Folder Browser Modal (Add from Disk / Relocate Missing)
  // -------------------------------------------------------------------------
  function formatFsChangeDate(ms) {
    const n = Number(ms) || 0;
    if (!n) return '';
    const d = new Date(n);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (v) => String(v).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function syncFsSortButtons() {
    const isDate = state.fsSortMode !== 'alpha';
    if (el.fsSortDateBtn) el.fsSortDateBtn.classList.toggle('active', isDate);
    if (el.fsSortAlphaBtn) el.fsSortAlphaBtn.classList.toggle('active', !isDate);
  }

  function renderFsEntriesList() {
    el.fsEntriesList.innerHTML = '';

    // Always pin ".." parent navigation at the top regardless of sort mode
    if (state.fsParentDir) {
      const parentRow = document.createElement('div');
      parentRow.className = 'fs-entry fs-entry-parent';
      parentRow.dataset.path = state.fsParentDir;
      parentRow.innerHTML = `
        <div class="fs-entry-left">
          <span class="material-symbols-rounded" style="color:var(--accent-amber)">drive_folder_upload</span>
          <span class="fs-entry-name">..</span>
        </div>
        <div class="fs-entry-right">
          <span class="fs-entry-meta">Parent Folder</span>
        </div>
      `;
      parentRow.onclick = () => loadFsDirectory(state.fsParentDir);
      el.fsEntriesList.appendChild(parentRow);
    }

    const cmpAlpha = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    let orderedEntries = [];
    if (state.fsSortMode === 'alpha') {
      const dirsSorted = [...state.fsDirectories].sort(cmpAlpha);
      const filesSorted = [...state.fsFiles].sort(cmpAlpha);
      orderedEntries = [...dirsSorted, ...filesSorted];
    } else {
      orderedEntries = [...state.fsDirectories, ...state.fsFiles].sort((a, b) => {
        const diff = (Number(b.changeMs) || 0) - (Number(a.changeMs) || 0);
        if (diff !== 0) return diff;
        return cmpAlpha(a, b);
      });
    }

    if (orderedEntries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-hint';
      empty.textContent = 'No subfolders or supported media files in this directory.';
      el.fsEntriesList.appendChild(empty);
      updateFsFooter();
      return;
    }

    for (const item of orderedEntries) {
      const dateStr = formatFsChangeDate(item.changeMs);
      if (item.isDirectory) {
        const row = document.createElement('div');
        row.className = 'fs-entry';
        row.dataset.path = item.path;
        row.innerHTML = `
          <div class="fs-entry-left">
            <span class="material-symbols-rounded" style="color:var(--accent-amber)">folder</span>
            <span class="fs-entry-name">${escapeHtml(item.name)}</span>
          </div>
          <div class="fs-entry-right">
            ${dateStr ? `<span class="fs-entry-date">${escapeHtml(dateStr)}</span>` : ''}
            <span class="fs-entry-meta">Folder</span>
          </div>
        `;
        row.onclick = () => loadFsDirectory(item.path);
        el.fsEntriesList.appendChild(row);
      } else {
        const isSelected = state.fsSelectedPaths.includes(item.path);
        const row = document.createElement('div');
        row.className = `fs-entry${isSelected ? ' selected' : ''}`;
        row.dataset.path = item.path;
        const isVideo = ['.mp4', '.mov', '.mkv'].includes(item.ext);
        row.innerHTML = `
          <div class="fs-entry-left">
            <input type="checkbox" class="fs-entry-checkbox" ${isSelected ? 'checked' : ''} aria-label="Select ${escapeHtml(item.name)}" />
            <span class="material-symbols-rounded" style="color:${isVideo ? 'var(--accent-blue)' : 'var(--accent-green)'}">
              ${isVideo ? 'movie' : 'audiotrack'}
            </span>
            <span class="fs-entry-name">${escapeHtml(item.name)}</span>
          </div>
          <div class="fs-entry-right">
            ${dateStr ? `<span class="fs-entry-date">${escapeHtml(dateStr)}</span>` : ''}
            <span class="fs-entry-meta">${formatBytes(item.size)}</span>
          </div>
        `;

        const checkbox = row.querySelector('.fs-entry-checkbox');
        const toggleSelection = () => {
          if (state.fsMode === 'relink') {
            state.fsSelectedPaths = [item.path];
            Array.from(el.fsEntriesList.children).forEach((c) => {
              c.classList.remove('selected');
              const cb = c.querySelector('.fs-entry-checkbox');
              if (cb) cb.checked = false;
            });
            row.classList.add('selected');
            if (checkbox) checkbox.checked = true;
          } else {
            const idx = state.fsSelectedPaths.indexOf(item.path);
            if (idx >= 0) {
              state.fsSelectedPaths.splice(idx, 1);
              row.classList.remove('selected');
              if (checkbox) checkbox.checked = false;
            } else {
              if (state.fsSelectedPaths.length >= MAX_IMPORT_BATCH) {
                if (checkbox) checkbox.checked = false;
                showToast(`Maximum ${MAX_IMPORT_BATCH} clips can be imported at once.`, 'warn');
                return;
              }
              state.fsSelectedPaths.push(item.path);
              row.classList.add('selected');
              if (checkbox) checkbox.checked = true;
            }
          }
          updateFsFooter();
        };

        row.onclick = (ev) => {
          if (ev.target === checkbox) return;
          toggleSelection();
        };
        if (checkbox) {
          checkbox.onclick = (ev) => ev.stopPropagation();
          checkbox.onchange = toggleSelection;
        }
        el.fsEntriesList.appendChild(row);
      }
    }

    updateFsFooter();
  }

  async function loadFsDirectory(dirPath = '') {
    const query = dirPath ? `?dir=${encodeURIComponent(dirPath)}` : '';
    const data = await apiJson(`/api/fs/browse${query}`);
    state.fsCurrentDir = data.currentDir;
    state.fsParentDir = data.parentDir;
    state.fsSelectedPaths = [];
    state.fsDirectories = (data.directories || []).map((d) => ({ ...d, isDirectory: true }));
    state.fsFiles = (data.files || []).map((f) => ({ ...f, isDirectory: false }));

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

    renderFsEntriesList();
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
    state.fsSortMode = 'date';
    syncFsSortButtons();
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

    closeTransitionPopover();
    pushUndoState();

    const newClip = {
      id: makeClipId(),
      sourceId: src.id,
      inFrame: 0,
      outFrame: Math.max(1, src.totalFrames || 24),
      speed: 1.0,
      reversed: false,
      mirrored: false,
      exposure: 0,
      saturation: 0,
      contrast: 0,
      hue: 0,
      red: 0,
      green: 0,
      blue: 0,
      timelineStartFrame: Math.max(0, Math.round(dropFrame)),
      volume: 1.0,
      fadeInSec: 0.0,
      fadeOutSec: 0.0,
    };

    if (trackKey === 'track1') {
      const beforeJunctions = snapshotValidJunctions();
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
      pruneInvalidTransitionsAndRestoreAudio(beforeJunctions);
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
    closeTransitionPopover();
    clearProjectHistory();
    const list = state.project.tracks[sel.trackKey];
    const idx = list.findIndex((c) => c.id === sel.clip.id);
    if (idx !== -1) {
      if (sel.trackKey === 'track1') {
        const oldRightBoundary =
          idx < list.length - 1
            ? (list[idx + 1].timelineStartFrame || 0)
            : (sel.clip.timelineStartFrame || 0) + getClipDurationFrames(sel.clip, 'track1');
        list.splice(idx, 1);
        state.project.transitions = (state.project.transitions || []).filter(
          (t) => t.fromClipId !== sel.clip.id && t.toClipId !== sel.clip.id
        );
        repackTrack1();
        const newRightBoundary =
          idx < list.length ? (list[idx].timelineStartFrame || 0) : getTotalTrack1Frames();
        if (oldRightBoundary > newRightBoundary) {
          applyAudioCutRipple(newRightBoundary, oldRightBoundary);
        }
      } else {
        list.splice(idx, 1);
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

    const baseGrades = trackKey === 'track1'
      ? {
          exposure: clampColorGrade(clip.exposure),
          saturation: clampColorGrade(clip.saturation),
          contrast: clampColorGrade(clip.contrast),
          hue: clampHueGrade(clip.hue),
          red: clampColorGrade(clip.red),
          green: clampColorGrade(clip.green),
          blue: clampColorGrade(clip.blue),
        }
      : {};

    if (clip.reversed) {
      return {
        leftSeg: {
          ...clip,
          ...baseGrades,
          inFrame: splitSourceFrame,
          outFrame: clip.outFrame,
          fadeOutSec: 0,
        },
        rightSeg: {
          ...clip,
          ...baseGrades,
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
        ...baseGrades,
        inFrame: clip.inFrame,
        outFrame: splitSourceFrame,
        fadeOutSec: 0,
      },
      rightSeg: {
        ...clip,
        ...baseGrades,
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

    if (target.trackKey === 'track1') {
      const info = getClipTransitionInfo(target.clip.id);
      const leftMin = getMinRequiredFramesForTransitions(info.leftTransition, null);
      const rightMin = getMinRequiredFramesForTransitions(null, info.rightTransition);
      const leftDur = getClipDurationFrames(segs.leftSeg, 'track1');
      const rightDur = getClipDurationFrames(segs.rightSeg, 'track1');
      if (leftDur < leftMin || rightDur < rightMin) {
        showToast(
          `Split blocked: attached transitions require at least ${leftMin}f (left) and ${rightMin}f (right).`,
          'warn'
        );
        return;
      }
    }

    closeTransitionPopover();
    pushUndoState();
    const totalBefore = target.trackKey === 'track1' ? getTotalTrack1Frames() : 0;
    const list = state.project.tracks[target.trackKey];
    const idx = list.findIndex((c) => c.id === target.clip.id);
    list.splice(idx, 1, segs.leftSeg, segs.rightSeg);

    if (target.trackKey === 'track1') {
      // Transfer any outgoing transition ownership from original clip ID to rightSeg
      for (const t of state.project.transitions || []) {
        if (t.fromClipId === target.clip.id) {
          t.fromClipId = segs.rightSeg.id;
        }
      }
      repackTrack1();
      const totalAfter = getTotalTrack1Frames();
      if (totalAfter < totalBefore) {
        applyAudioCutRipple(target.end - (totalBefore - totalAfter), target.end);
      }
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

    const { trackKey, clip, start } = target;
    const rightSeg = trackKey === 'track1' ? { ...segs.rightSeg, id: clip.id } : segs.rightSeg;
    if (trackKey === 'track1') {
      const info = getClipTransitionInfo(clip.id);
      const newDur = getClipDurationFrames(rightSeg, 'track1');
      if (newDur < info.minAllowedFrames) {
        showToast(
          `Trim Left blocked: attached transition requires at least ${info.minAllowedFrames} frames.`,
          'warn'
        );
        return;
      }
    }

    closeTransitionPopover();
    pushUndoState();
    const oldDur = getClipDurationFrames(clip, trackKey);
    const list = state.project.tracks[trackKey];
    const idx = list.findIndex((c) => c.id === clip.id);
    list.splice(idx, 1, rightSeg);

    if (trackKey === 'track1') {
      repackTrack1();
      const newDur = getClipDurationFrames(rightSeg, 'track1');
      const removedFrames = oldDur - newDur;
      if (removedFrames > 0) {
        applyAudioCutRipple(start, start + removedFrames);
      } else if (removedFrames < 0) {
        shiftAudioFromSegmentStart(start, -removedFrames);
      }
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

    const { trackKey, clip, start } = target;
    const leftSeg = segs.leftSeg;
    if (trackKey === 'track1') {
      const info = getClipTransitionInfo(clip.id);
      const newDur = getClipDurationFrames(leftSeg, 'track1');
      if (newDur < info.minAllowedFrames) {
        showToast(
          `Trim Right blocked: attached transition requires at least ${info.minAllowedFrames} frames.`,
          'warn'
        );
        return;
      }
    }

    closeTransitionPopover();
    pushUndoState();
    const oldDur = getClipDurationFrames(clip, trackKey);
    const list = state.project.tracks[trackKey];
    const idx = list.findIndex((c) => c.id === clip.id);
    list.splice(idx, 1, leftSeg);

    if (trackKey === 'track1') {
      repackTrack1();
      const newDur = getClipDurationFrames(leftSeg, 'track1');
      const removedFrames = oldDur - newDur;
      if (removedFrames > 0) {
        applyAudioCutRipple(start + newDur, start + oldDur);
      } else if (removedFrames < 0) {
        shiftAudioFromSegmentStart(start + oldDur, -removedFrames);
      }
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
          if (clip.mirrored) {
            const mir = document.createElement('span');
            mir.className = 'tl-badge mirror-badge';
            mir.textContent = 'MIR';
            pills.appendChild(mir);
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

      if (lane.key === 'track1' && clips.length > 1) {
        for (let i = 0; i < clips.length - 1; i += 1) {
          const clipA = clips[i];
          const clipB = clips[i + 1];
          const durA = getClipDurationFrames(clipA, 'track1');
          const endA = (clipA.timelineStartFrame || 0) + durA;
          const t = getAdjacentTransition(clipA.id, clipB.id);

          let boundaryFrame = endA;
          if (t && t.type === 'transform') boundaryFrame = endA - 0.5;
          else if (t && (t.type === 'fade_black' || t.type === 'fade_white')) boundaryFrame = endA + 0.5;

          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'tl-junction-btn';
          btn.style.left = `${boundaryFrame * state.pxPerFrame}px`;

          let iconName = 'commit';
          let titleText = 'Add transition between clips';
          if (t && t.type === 'transform') {
            btn.classList.add('active');
            iconName = 'blur_on';
            titleText = 'Transform (1f 50/50 Mix)';
          } else if (t && t.type === 'fade_black') {
            btn.classList.add('active', 'fade-black');
            iconName = 'contrast';
            titleText = `Fade Black (±${t.rampFrames}f)`;
          } else if (t && t.type === 'fade_white') {
            btn.classList.add('active', 'fade-white');
            iconName = 'brightness_high';
            titleText = `Fade White (±${t.rampFrames}f)`;
          }

          if (
            state.transitionPopover &&
            state.transitionPopover.fromClipId === clipA.id &&
            state.transitionPopover.toClipId === clipB.id
          ) {
            btn.classList.add('open');
          }

          btn.title = titleText;
          btn.innerHTML = `<span class="material-symbols-rounded">${iconName}</span>`;
          btn.addEventListener('mousedown', (e) => e.stopPropagation());
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            openTransitionPopover(clipA, clipB, btn);
          });
          lane.el.appendChild(btn);
        }
      }
    }
  }

  function closeTransitionPopover() {
    state.transitionPopover = null;
    if (el.transitionPopover) {
      el.transitionPopover.classList.add('hidden');
    }
    Array.from(document.querySelectorAll('.tl-junction-btn.open')).forEach((b) =>
      b.classList.remove('open')
    );
  }

  function refreshTransitionPopoverUI() {
    if (!state.transitionPopover || !state.project) return;
    const t1 = state.project.tracks?.track1 || [];
    const idx = t1.findIndex((c) => c.id === state.transitionPopover.fromClipId);
    if (idx === -1 || !t1[idx + 1] || t1[idx + 1].id !== state.transitionPopover.toClipId) {
      closeTransitionPopover();
      return;
    }

    const clipA = t1[idx];
    const clipB = t1[idx + 1];
    const srcA = getSourceById(clipA.sourceId);
    const srcB = getSourceById(clipB.sourceId);
    const durA = getClipDurationFrames(clipA, 'track1');
    const durB = getClipDurationFrames(clipB, 'track1');
    const activeTrans = getAdjacentTransition(clipA.id, clipB.id);
    const activeType = activeTrans ? activeTrans.type : 'none';

    el.transitionPopoverMeta.textContent = `${srcA?.name || 'Clip A'} (${durA}f) → ${srcB?.name || 'Clip B'} (${durB}f)`;

    const canTransform = durA >= 3 && durB >= 3;
    const maxRamp = getMaxRampFrames(clipA, clipB);
    const canFade = durA >= 7 && durB >= 7 && maxRamp >= 1;

    el.transOptTransformBtn.disabled = !canTransform;
    el.transOptTransformHint.textContent = canTransform
      ? 'Blends last & first frame (-1f duration)'
      : 'Requires >= 3 frames on both clips';

    el.transOptFadeBlackBtn.disabled = !canFade;
    el.transOptFadeBlackHint.textContent = canFade
      ? 'Symmetrical ramp + 1f black (+1f duration)'
      : 'Requires >= 7 frames each + body room';

    el.transOptFadeWhiteBtn.disabled = !canFade;
    el.transOptFadeWhiteHint.textContent = canFade
      ? 'Symmetrical ramp + 1f white (+1f duration)'
      : 'Requires >= 7 frames each + body room';

    Array.from(el.transitionPopover.querySelectorAll('.transition-opt-btn')).forEach((b) => {
      b.classList.toggle('selected', b.dataset.transitionType === activeType);
    });

    const isFade = activeType === 'fade_black' || activeType === 'fade_white';
    el.transitionRampRow.classList.toggle('hidden', !isFade || maxRamp < 1);
    if (isFade && maxRamp >= 1) {
      const rampVal = Math.max(1, Math.min(maxRamp, activeTrans.rampFrames || 4));
      el.transitionRampInput.min = '1';
      el.transitionRampInput.max = String(maxRamp);
      el.transitionRampInput.value = String(rampVal);
      el.transitionRampMaxHint.textContent = `Max: ${maxRamp}f (span ${2 * rampVal + 1}f)`;
      el.transitionRampMinusBtn.disabled = rampVal <= 1;
      el.transitionRampPlusBtn.disabled = rampVal >= maxRamp;
    }
  }

  function openTransitionPopover(clipA, clipB, anchorBtn) {
    if (
      state.transitionPopover &&
      state.transitionPopover.fromClipId === clipA.id &&
      state.transitionPopover.toClipId === clipB.id
    ) {
      closeTransitionPopover();
      return;
    }

    state.transitionPopover = { fromClipId: clipA.id, toClipId: clipB.id };
    el.transitionPopover.classList.remove('hidden');
    refreshTransitionPopoverUI();

    const btnRect = anchorBtn.getBoundingClientRect();
    const popRect = el.transitionPopover.getBoundingClientRect();
    const popW = popRect.width || 288;
    const popH = popRect.height || 260;

    let left = Math.round(btnRect.left + btnRect.width / 2 - popW / 2);
    left = Math.max(8, Math.min(window.innerWidth - popW - 8, left));

    let top = Math.round(btnRect.top - popH - 10);
    if (top < 8) {
      top = Math.round(btnRect.bottom + 10);
    }
    top = Math.max(8, Math.min(window.innerHeight - popH - 8, top));

    el.transitionPopover.style.left = `${left}px`;
    el.transitionPopover.style.top = `${top}px`;

    Array.from(document.querySelectorAll('.tl-junction-btn')).forEach((b) =>
      b.classList.toggle('open', b === anchorBtn)
    );
  }

  function applyJunctionTransition(nextType, explicitRamp = null) {
    if (!state.transitionPopover || !state.project) return;
    const t1 = state.project.tracks?.track1 || [];
    const idx = t1.findIndex((c) => c.id === state.transitionPopover.fromClipId);
    if (idx === -1 || !t1[idx + 1] || t1[idx + 1].id !== state.transitionPopover.toClipId) {
      closeTransitionPopover();
      return;
    }

    const clipA = t1[idx];
    const clipB = t1[idx + 1];
    const durA = getClipDurationFrames(clipA, 'track1');
    const durB = getClipDurationFrames(clipB, 'track1');
    const maxRamp = getMaxRampFrames(clipA, clipB);

    if (nextType === 'transform' && (durA < 3 || durB < 3)) {
      showToast('Transform requires both adjacent clips to be at least 3 frames.', 'warn');
      return;
    }
    if ((nextType === 'fade_black' || nextType === 'fade_white') && (durA < 7 || durB < 7 || maxRamp < 1)) {
      showToast('Fade transitions require both adjacent clips to be at least 7 frames.', 'warn');
      return;
    }

    const existingIdx = (state.project.transitions || []).findIndex(
      (t) => t.fromClipId === clipA.id && t.toClipId === clipB.id
    );
    const existing = existingIdx !== -1 ? state.project.transitions[existingIdx] : null;
    const oldDelta = getTransitionNetDelta(existing?.type);
    const newDelta = getTransitionNetDelta(nextType);
    const oldClipBStart = clipB.timelineStartFrame || 0;

    let desiredRamp = 1;
    if (nextType === 'fade_black' || nextType === 'fade_white') {
      const baseRamp =
        explicitRamp !== null
          ? Number(explicitRamp)
          : (existing && (existing.type === 'fade_black' || existing.type === 'fade_white')
              ? existing.rampFrames
              : Math.min(4, maxRamp));
      desiredRamp = Math.max(1, Math.min(maxRamp, Math.round(baseRamp) || 1));
    }

    if (
      (nextType === 'none' && !existing) ||
      (existing && existing.type === nextType && (nextType !== 'fade_black' && nextType !== 'fade_white' || existing.rampFrames === desiredRamp))
    ) {
      if (nextType === 'none' || nextType === 'transform') closeTransitionPopover();
      return;
    }

    pushUndoState();
    if (!Array.isArray(state.project.transitions)) state.project.transitions = [];
    if (nextType === 'none') {
      if (existingIdx !== -1) state.project.transitions.splice(existingIdx, 1);
    } else {
      const nextObj = {
        fromClipId: clipA.id,
        toClipId: clipB.id,
        type: nextType,
        rampFrames: desiredRamp,
      };
      if (existingIdx !== -1) state.project.transitions[existingIdx] = nextObj;
      else state.project.transitions.push(nextObj);
    }

    repackTrack1();
    const netDelta = newDelta - oldDelta;
    if (netDelta > 0) {
      shiftAudioFromSegmentStart(oldClipBStart, netDelta);
    } else if (netDelta < 0) {
      applyAudioCutRipple(oldClipBStart + netDelta, oldClipBStart);
    }

    renderTimelineAndInspector();
    if (nextType === 'none' || nextType === 'transform') {
      closeTransitionPopover();
    } else {
      refreshTransitionPopoverUI();
    }
    syncPreviewAtCurrentFrame();
    scheduleAutoSave();
  }

  function startClipDrag(downEvent, trackKey, clip, clipEl) {
    const startX = downEvent.clientX;
    const origStartFrame = clip.timelineStartFrame || 0;
    const beforeJunctions = trackKey === 'track1' ? snapshotValidJunctions() : [];
    let pushedUndo = false;

    const onMove = (moveEvent) => {
      const dx = moveEvent.clientX - startX;
      if (Math.abs(dx) < 3 && !pushedUndo) return;
      if (!pushedUndo) {
        closeTransitionPopover();
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
        if (trackKey === 'track1') {
          pruneInvalidTransitionsAndRestoreAudio(beforeJunctions);
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

  function startClipTrim(downEvent, trackKey, clip, side) {
    const src = getSourceById(clip.sourceId);
    const maxSourceFrames = Math.max(2, src?.totalFrames || clip.outFrame);
    const speed = trackKey === 'track1' ? (Number(clip.speed) > 0 ? Number(clip.speed) : 1) : 1;
    const minAllowedFrames = trackKey === 'track1' ? getClipTransitionInfo(clip.id).minAllowedFrames : 1;
    const startX = downEvent.clientX;
    const origIn = clip.inFrame;
    const origOut = clip.outFrame;
    const origTlStart = clip.timelineStartFrame || 0;
    const origTlDur = getClipDurationFrames(clip, trackKey);
    let pushedUndo = false;
    let warnedMinTrim = false;

    const minSrcSpanForMinFrames = () => {
      if (trackKey !== 'track1' || minAllowedFrames <= 1) return 1;
      let s = Math.max(1, Math.ceil(minAllowedFrames * speed));
      while (s > 1 && Math.floor((s - 1) / speed) >= minAllowedFrames) s -= 1;
      while (Math.floor(s / speed) < minAllowedFrames) s += 1;
      return s;
    };
    const minSrcSpan = minSrcSpanForMinFrames();

    const onMove = (moveEvent) => {
      const dx = moveEvent.clientX - startX;
      if (Math.abs(dx) < 2 && !pushedUndo) return;
      if (!pushedUndo) {
        closeTransitionPopover();
        pushUndoState();
        pushedUndo = true;
      }

      const rawDeltaTimelineFrames = Math.round(dx / state.pxPerFrame);

      if (trackKey === 'track1') {
        const deltaSrc = Math.round(rawDeltaTimelineFrames * speed);
        let nextIn = clip.inFrame;
        let nextOut = clip.outFrame;
        if (side === 'left') {
          if (clip.reversed) {
            nextOut = Math.min(maxSourceFrames, Math.max(clip.inFrame + minSrcSpan, origOut - deltaSrc));
          } else {
            nextIn = Math.max(0, Math.min(clip.outFrame - minSrcSpan, origIn + deltaSrc));
          }
        } else {
          if (clip.reversed) {
            nextIn = Math.max(0, Math.min(clip.outFrame - minSrcSpan, origIn - deltaSrc));
          } else {
            nextOut = Math.min(maxSourceFrames, Math.max(clip.inFrame + minSrcSpan, origOut + deltaSrc));
          }
        }
        const hitMinClamp =
          minAllowedFrames > 1 &&
          nextOut - nextIn === minSrcSpan &&
          Math.floor((origOut - origIn) / speed) >= minAllowedFrames &&
          ((side === 'left' && ((clip.reversed && origOut - deltaSrc < clip.inFrame + minSrcSpan) || (!clip.reversed && origIn + deltaSrc > clip.outFrame - minSrcSpan))) ||
           (side === 'right' && ((clip.reversed && origIn - deltaSrc > clip.outFrame - minSrcSpan) || (!clip.reversed && origOut + deltaSrc < clip.inFrame + minSrcSpan))));
        if (hitMinClamp && !warnedMinTrim) {
          warnedMinTrim = true;
          showToast(`Trim limited: attached transition requires at least ${minAllowedFrames} frames.`, 'warn');
        }
        clip.inFrame = nextIn;
        clip.outFrame = nextOut;
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
          const deltaDur = newTlDur - origTlDur;
          if (deltaDur < 0) {
            const removed = -deltaDur;
            if (side === 'left') {
              applyAudioCutRipple(origTlStart, origTlStart + removed);
            } else {
              applyAudioCutRipple(origTlStart + newTlDur, origTlStart + origTlDur);
            }
          } else if (deltaDur > 0) {
            if (side === 'left') {
              shiftAudioFromSegmentStart(origTlStart, deltaDur);
            } else {
              shiftAudioFromSegmentStart(origTlStart + origTlDur, deltaDur);
            }
          }
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
      renderColorGradingPanel();
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
      const span = Math.max(1, (clip.outFrame || 0) - (clip.inFrame || 0));
      const { minAllowedFrames } = getClipTransitionInfo(clip.id);
      const maxValidSpeed = span / minAllowedFrames;

      Array.from(el.speedPresetSelect.options).forEach((o) => {
        if (o.value === 'custom') {
          o.disabled = false;
        } else {
          const optSpeed = Number(o.value);
          o.disabled = Math.max(1, Math.floor(span / optSpeed)) < minAllowedFrames;
        }
      });

      const steppedMax = Math.max(0.25, Math.min(4.0, Math.floor((maxValidSpeed + 1e-6) * 20) / 20));
      el.speedFineInput.max = steppedMax.toFixed(2);
      el.speedFineInput.value = sp.toFixed(2);
      const presetOpt = Array.from(el.speedPresetSelect.options).find((o) => Number(o.value) === sp);
      el.speedPresetSelect.value = presetOpt ? presetOpt.value : 'custom';
      el.reverseToggleBtn.classList.toggle('active', Boolean(clip.reversed));
      el.mirrorToggleBtn.classList.toggle('active', Boolean(clip.mirrored));

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
    renderColorGradingPanel();
  }

  function renderTimelineAndInspector() {
    drawTimelineRuler();
    renderAllTimelineClips();
    updatePlayheadUI();
    renderInspector();
    renderColorGradingPanel();
    renderSourcesList();
  }

  function getColorGradeTargetClip() {
    const sel = getSelectedClipObj();
    if (sel && sel.trackKey === 'track1') {
      return { clip: sel.clip, source: sel.source, mode: 'selected' };
    }
    const timelineSec = (state.playheadFrame + 0.01) / FPS;
    const { active } = getTrack1ClipAtTime(timelineSec);
    if (active && active.clip) {
      return { clip: active.clip, source: getSourceById(active.clip.sourceId), mode: 'playhead' };
    }
    return null;
  }

  function renderColorGradingPanel() {
    const sliders = [
      el.cgExposureSlider,
      el.cgSaturationSlider,
      el.cgContrastSlider,
      el.cgHueSlider,
      el.cgRedSlider,
      el.cgGreenSlider,
      el.cgBlueSlider,
    ];
    if (!el.cgExposureSlider || !el.cgSaturationSlider || !el.cgContrastSlider) return;

    const target = getColorGradeTargetClip();
    if (!target || !target.clip) {
      state.lastRenderedColorClipId = null;
      if (el.cgClipTargetLabel) el.cgClipTargetLabel.textContent = 'No video clip';
      for (const s of sliders) {
        if (s) {
          s.value = '0';
          s.disabled = true;
        }
      }
      if (el.cgResetAllBtn) el.cgResetAllBtn.disabled = true;
      if (el.cgExposureVal) el.cgExposureVal.textContent = '0';
      if (el.cgSaturationVal) el.cgSaturationVal.textContent = '0';
      if (el.cgContrastVal) el.cgContrastVal.textContent = '0';
      if (el.cgHueVal) el.cgHueVal.textContent = '0°';
      if (el.cgRedVal) el.cgRedVal.textContent = '0';
      if (el.cgGreenVal) el.cgGreenVal.textContent = '0';
      if (el.cgBlueVal) el.cgBlueVal.textContent = '0';
      return;
    }

    const { clip, source } = target;
    state.lastRenderedColorClipId = clip.id;
    const exp = clampColorGrade(clip.exposure);
    const sat = clampColorGrade(clip.saturation);
    const con = clampColorGrade(clip.contrast);
    const hue = clampHueGrade(clip.hue);
    const red = clampColorGrade(clip.red);
    const green = clampColorGrade(clip.green);
    const blue = clampColorGrade(clip.blue);

    if (el.cgClipTargetLabel) {
      el.cgClipTargetLabel.textContent = source ? source.name : 'Track 1 Clip';
      el.cgClipTargetLabel.title = el.cgClipTargetLabel.textContent;
    }

    for (const s of sliders) {
      if (s) s.disabled = false;
    }
    el.cgExposureSlider.value = String(exp);
    el.cgSaturationSlider.value = String(sat);
    el.cgContrastSlider.value = String(con);
    if (el.cgHueSlider) el.cgHueSlider.value = String(hue);
    if (el.cgRedSlider) el.cgRedSlider.value = String(red);
    if (el.cgGreenSlider) el.cgGreenSlider.value = String(green);
    if (el.cgBlueSlider) el.cgBlueSlider.value = String(blue);

    if (el.cgExposureVal) el.cgExposureVal.textContent = formatSignedGrade(exp);
    if (el.cgSaturationVal) el.cgSaturationVal.textContent = formatSignedGrade(sat);
    if (el.cgContrastVal) el.cgContrastVal.textContent = formatSignedGrade(con);
    if (el.cgHueVal) el.cgHueVal.textContent = formatSignedHue(hue);
    if (el.cgRedVal) el.cgRedVal.textContent = formatSignedGrade(red);
    if (el.cgGreenVal) el.cgGreenVal.textContent = formatSignedGrade(green);
    if (el.cgBlueVal) el.cgBlueVal.textContent = formatSignedGrade(blue);
    if (el.cgResetAllBtn) {
      el.cgResetAllBtn.disabled = isClipColorDefault(clip);
    }
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

  function clearBlendAndOverlay() {
    el.videoPlayerA.classList.remove('blending');
    el.videoPlayerB.classList.remove('blending');
    if (el.previewTransitionOverlay) {
      el.previewTransitionOverlay.style.opacity = '0';
    }
  }

  function updateSlotSvgMatrix(slot, clip) {
    const playerKey = String(slot || 'A').toLowerCase() === 'b' ? 'b' : 'a';
    const matrixEl = playerKey === 'b' ? el.clipRgbMatrixB : el.clipRgbMatrixA;
    if (!matrixEl) return;
    const red = clip ? clampColorGrade(clip.red) : 0;
    const green = clip ? clampColorGrade(clip.green) : 0;
    const blue = clip ? clampColorGrade(clip.blue) : 0;
    const rGain = Math.max(0, 1 + red / 100);
    const gGain = Math.max(0, 1 + green / 100);
    const bGain = Math.max(0, 1 + blue / 100);
    matrixEl.setAttribute(
      'values',
      `${rGain} 0 0 0 0  0 ${gGain} 0 0 0  0 0 ${bGain} 0 0  0 0 0 1 0`
    );
  }

  function buildClipCssFilter(clip, slot = 'A') {
    const playerKey = String(slot || 'A').toLowerCase() === 'b' ? 'b' : 'a';
    updateSlotSvgMatrix(slot, clip);
    if (!clip || isClipColorDefault(clip)) return '';
    const exposure = clampColorGrade(clip.exposure);
    const saturation = clampColorGrade(clip.saturation);
    const contrast = clampColorGrade(clip.contrast);
    const hue = clampHueGrade(clip.hue);
    const expGain = Math.max(0.05, 1 + exposure / 100);
    const satGain = Math.max(0, 1 + saturation / 100);
    const conGain = Math.max(0, 1 + contrast / 100);
    return `brightness(${expGain}) contrast(${conGain}) saturate(${satGain}) hue-rotate(${hue}deg) url(#clip-rgb-filter-${playerKey})`;
  }

  function applyLiveColorFilterToActiveSlots(clip) {
    if (!clip) return;
    if (state.slotState.A.clipId === clip.id) {
      el.videoPlayerA.style.filter = buildClipCssFilter(clip, 'A');
    }
    if (state.slotState.B.clipId === clip.id) {
      el.videoPlayerB.style.filter = buildClipCssFilter(clip, 'B');
    }
  }

  function applyVideoSlotMirror(slot, clip) {
    const player = slot === 'A' ? el.videoPlayerA : el.videoPlayerB;
    player.style.transform = clip && clip.mirrored ? 'scaleX(-1)' : '';
    player.style.filter = buildClipCssFilter(clip, slot);
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
      player.style.transform = '';
      player.style.filter = '';
      updateSlotSvgMatrix(slot, null);
      player.classList.remove('blending');
      state.slotState[slot] = { clipId: null, sourceId: null, preseekedSec: null, pendingSeekSec: null };
    }
    if (el.previewTransitionOverlay) {
      el.previewTransitionOverlay.style.opacity = '0';
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
      if (st.sourceId !== null || st.clipId !== null) {
        player.pause();
        player.removeAttribute('src');
        player.load();
        player.style.transform = '';
        player.style.filter = '';
        updateSlotSvgMatrix(slot, null);
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
    } else if (st.clipId !== clip.id) {
      st.preseekedSec = null;
    }
    st.clipId = clip.id;
    applyVideoSlotMirror(slot, clip);
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

  function getSourceSecForClipFrame(clip, timelineFrame) {
    const speed = Number(clip.speed) > 0 ? Number(clip.speed) : 1;
    const startFrame = clip.timelineStartFrame || 0;
    const durFrames = getClipDurationFrames(clip, 'track1');
    const offsetFrames = Math.max(0, Math.min(durFrames - 1, timelineFrame - startFrame));
    const elapsedInClip = offsetFrames / FPS;
    return clip.reversed
      ? Math.max(clip.inFrame / FPS, clip.outFrame / FPS - elapsedInClip * speed)
      : Math.min(clip.outFrame / FPS, clip.inFrame / FPS + elapsedInClip * speed);
  }

  function getActiveTransformAtFrame(frame) {
    if (!state.project) return null;
    const t1 = state.project.tracks?.track1 || [];
    for (let i = 0; i < t1.length - 1; i += 1) {
      const clipA = t1[i];
      const clipB = t1[i + 1];
      const t = getAdjacentTransition(clipA.id, clipB.id);
      if (t && t.type === 'transform') {
        const blendFrame = clipB.timelineStartFrame || 0;
        if (frame === blendFrame) {
          return { clipA, clipB, blendFrame };
        }
      }
    }
    return null;
  }

  function getActiveFadeOverlayAtFrame(frame) {
    if (!state.project) return null;
    const t1 = state.project.tracks?.track1 || [];
    for (let i = 0; i < t1.length - 1; i += 1) {
      const clipA = t1[i];
      const clipB = t1[i + 1];
      const t = getAdjacentTransition(clipA.id, clipB.id);
      if (t && (t.type === 'fade_black' || t.type === 'fade_white')) {
        const centerFrame = (clipA.timelineStartFrame || 0) + getClipDurationFrames(clipA, 'track1');
        const ramp = Math.max(1, Math.round(Number(t.rampFrames) || 1));
        const dist = Math.abs(frame - centerFrame);
        if (dist <= ramp) {
          const opacity = dist === 0 ? 1 : (ramp + 1 - dist) / (ramp + 1);
          return {
            color: t.type === 'fade_white' ? '#FFFFFF' : '#000000',
            opacity,
            isCenter: dist === 0,
            clipA,
            clipB,
          };
        }
      }
    }
    return null;
  }

  function applyFadeOverlay(fadeInfo) {
    if (!el.previewTransitionOverlay) return;
    if (!fadeInfo) {
      el.previewTransitionOverlay.style.opacity = '0';
      return;
    }
    el.previewTransitionOverlay.style.background = fadeInfo.color;
    el.previewTransitionOverlay.style.opacity = String(fadeInfo.opacity);
  }

  function getSlotPairForTransform(clipA) {
    const other = state.activeVideoSlot === 'A' ? 'B' : 'A';
    if (state.slotState[state.activeVideoSlot].clipId === clipA.id) {
      return { slotA: state.activeVideoSlot, slotB: other };
    }
    if (state.slotState[other].clipId === clipA.id) {
      swapActiveVideoSlot(other);
      return { slotA: other, slotB: state.activeVideoSlot === 'A' ? 'B' : 'A' };
    }
    return { slotA: state.activeVideoSlot, slotB: other };
  }

  function formatClipBadgeText(clip, src) {
    const speed = Number(clip.speed) > 0 ? Number(clip.speed) : 1;
    return `${src.name} • ${speed}x${clip.reversed ? ' • REV' : ''}${clip.mirrored ? ' • MIR' : ''}`;
  }

  function syncPreviewAtCurrentFrame() {
    if (!state.project) return;
    const t1 = state.project.tracks.track1 || [];
    el.previewEmptyOverlay.classList.toggle('hidden', t1.length > 0);
    if (t1.length === 0) {
      el.previewClipBadge.classList.add('hidden');
      clearBlendAndOverlay();
      setVideoSlotSource('A', null);
      setVideoSlotSource('B', null);
      renderColorGradingPanel();
      return;
    }

    const totalT1 = getTotalTrack1Frames();
    const clampedFrame = Math.max(0, Math.min(Math.max(0, totalT1 - 1), state.playheadFrame));
    const fadeInfo = getActiveFadeOverlayAtFrame(clampedFrame);
    applyFadeOverlay(fadeInfo);

    const transInfo = getActiveTransformAtFrame(clampedFrame);
    if (transInfo) {
      const { clipA, clipB } = transInfo;
      const srcA = getSourceById(clipA.sourceId);
      const srcB = getSourceById(clipB.sourceId);
      const { slotA, slotB } = getSlotPairForTransform(clipA);
      const playerA = setVideoSlotSource(slotA, clipA);
      const playerB = setVideoSlotSource(slotB, clipB);

      playerA.classList.add('active');
      playerA.classList.remove('blending');
      playerB.classList.remove('active');
      playerB.classList.add('blending');

      playerA.pause();
      playerB.pause();
      seekVideoSlot(slotA, getSourceSecForClipFrame(clipA, clampedFrame));
      seekVideoSlot(slotB, getSourceSecForClipFrame(clipB, clampedFrame));

      el.previewClipBadge.textContent = `${srcA?.name || 'Clip A'} ⟷ ${srcB?.name || 'Clip B'} • 50/50 Transform`;
      el.previewClipBadge.classList.remove('hidden');
      if (state.lastRenderedColorClipId !== clipA.id) renderColorGradingPanel();
      return;
    }

    el.videoPlayerA.classList.remove('blending');
    el.videoPlayerB.classList.remove('blending');

    if (fadeInfo && fadeInfo.isCenter) {
      const playerA = setVideoSlotSource(state.activeVideoSlot, fadeInfo.clipA);
      playerA.pause();
      const nextSlot = state.activeVideoSlot === 'A' ? 'B' : 'A';
      const nextPlayer = setVideoSlotSource(nextSlot, fadeInfo.clipB);
      nextPlayer.pause();
      seekVideoSlot(nextSlot, fadeInfo.clipB.reversed ? fadeInfo.clipB.outFrame / FPS : fadeInfo.clipB.inFrame / FPS);
      el.previewClipBadge.textContent = fadeInfo.color === '#FFFFFF' ? 'Fade White (Center)' : 'Fade Black (Center)';
      el.previewClipBadge.classList.remove('hidden');
      return;
    }

    const timelineSec = (clampedFrame + 0.01) / FPS;
    const { active, next } = getTrack1ClipAtTime(timelineSec);
    if (!active) return;

    const { clip } = active;
    const src = getSourceById(clip.sourceId);
    if (!src || src.missing) return;

    const activeSlot = state.activeVideoSlot;
    const player = setVideoSlotSource(activeSlot, clip);
    player.pause();
    seekVideoSlot(activeSlot, getSourceSecForClipFrame(clip, clampedFrame));

    const inactiveSlot = activeSlot === 'A' ? 'B' : 'A';
    if (next && next.clip) {
      const nextPlayer = setVideoSlotSource(inactiveSlot, next.clip);
      nextPlayer.pause();
      const nextStartSrc = next.clip.reversed ? next.clip.outFrame / FPS : next.clip.inFrame / FPS;
      seekVideoSlot(inactiveSlot, nextStartSrc);
      state.slotState[inactiveSlot].preseekedSec = nextStartSrc;
    }

    el.previewClipBadge.textContent = formatClipBadgeText(clip, src);
    el.previewClipBadge.classList.remove('hidden');
    if (state.lastRenderedColorClipId !== clip.id) renderColorGradingPanel();
  }

  function updateMasterPlaybackLoop() {
    if (!state.isPlaying || !state.project) return;

    const totalT1Frames = getTotalTrack1Frames();
    const totalT1Sec = totalT1Frames / FPS;
    const elapsedSincePlay = state.audioCtx.currentTime - state.playStartAudioTime;
    const timelineSec = state.playStartTimelineSec + elapsedSincePlay;

    if (totalT1Frames === 0 || timelineSec >= totalT1Sec) {
      state.playheadFrame = Math.max(0, totalT1Frames);
      clearBlendAndOverlay();
      updatePlayheadUI();
      stopPlayback();
      return;
    }

    const frame = Math.min(Math.max(0, totalT1Frames - 1), Math.floor(timelineSec * FPS));
    state.playheadFrame = frame;
    updatePlayheadUI();

    const fadeInfo = getActiveFadeOverlayAtFrame(frame);
    applyFadeOverlay(fadeInfo);

    const transInfo = getActiveTransformAtFrame(frame);

    // 1. Track 1 Dual-Player Gap-Free Video Sync & Transitions
    if (transInfo) {
      // Transform 1-frame 50/50 blend: render A (opacity: 1) + B (opacity: 0.5) simultaneously
      const { clipA, clipB } = transInfo;
      const srcA = getSourceById(clipA.sourceId);
      const srcB = getSourceById(clipB.sourceId);
      const { slotA, slotB } = getSlotPairForTransform(clipA);
      const playerA = setVideoSlotSource(slotA, clipA);
      const playerB = setVideoSlotSource(slotB, clipB);

      playerA.classList.add('active');
      playerA.classList.remove('blending');
      playerB.classList.remove('active');
      playerB.classList.add('blending');

      const entrySecB = clipB.reversed ? clipB.outFrame / FPS : clipB.inFrame / FPS;
      if (!playerB.paused) playerB.pause();
      playerB.muted = true;
      if (!playerB.seeking && Math.abs(playerB.currentTime - entrySecB) > 0.01) {
        playerB.currentTime = entrySecB;
      }

      const speedA = Number(clipA.speed) > 0 ? Number(clipA.speed) : 1;
      const targetSecA = getSourceSecForClipFrame(clipA, frame);
      if (clipA.reversed) {
        if (!playerA.paused) playerA.pause();
        if (!playerA.seeking && Math.abs(playerA.currentTime - targetSecA) >= 0.5 / FPS) {
          playerA.currentTime = targetSecA;
        }
      } else {
        playerA.playbackRate = speedA;
        if (playerA.paused && playerA.readyState >= 2) {
          playerA.play().catch(() => {});
        }
      }

      const gainA = slotA === 'A' ? state.videoGainA : state.videoGainB;
      const gainB = slotB === 'A' ? state.videoGainA : state.videoGainB;
      if (gainB) gainB.gain.setTargetAtTime(0, state.audioCtx.currentTime, 0.008);
      if (gainA && (!srcA || !srcA.hasAudio || clipA.reversed)) {
        gainA.gain.setTargetAtTime(0, state.audioCtx.currentTime, 0.01);
      }

      el.previewClipBadge.textContent = `${srcA?.name || 'Clip A'} ⟷ ${srcB?.name || 'Clip B'} • 50/50 Transform`;
      el.previewClipBadge.classList.remove('hidden');
    } else if (fadeInfo && fadeInfo.isCenter) {
      el.videoPlayerA.classList.remove('blending');
      el.videoPlayerB.classList.remove('blending');
      if (state.videoGainA) state.videoGainA.gain.setTargetAtTime(0, state.audioCtx.currentTime, 0.008);
      if (state.videoGainB) state.videoGainB.gain.setTargetAtTime(0, state.audioCtx.currentTime, 0.008);
      el.videoPlayerA.pause();
      el.videoPlayerB.pause();

      // Keep incoming clip pre-parked and paused for next frame
      const nextSlot = state.activeVideoSlot === 'A' ? 'B' : 'A';
      const nextPlayer = setVideoSlotSource(nextSlot, fadeInfo.clipB);
      nextPlayer.pause();
      const nextStartSrc = fadeInfo.clipB.reversed ? fadeInfo.clipB.outFrame / FPS : fadeInfo.clipB.inFrame / FPS;
      if (!nextPlayer.seeking && nextPlayer.readyState >= 1 && Math.abs(nextPlayer.currentTime - nextStartSrc) > 0.01) {
        nextPlayer.currentTime = nextStartSrc;
        state.slotState[nextSlot].preseekedSec = nextStartSrc;
      }

      el.previewClipBadge.textContent = fadeInfo.color === '#FFFFFF' ? 'Fade White (Center)' : 'Fade Black (Center)';
      el.previewClipBadge.classList.remove('hidden');
    } else {
      el.videoPlayerA.classList.remove('blending');
      el.videoPlayerB.classList.remove('blending');

      const { active, next } = getTrack1ClipAtTime(timelineSec);
      if (active) {
        const { clip, startSec, endSec } = active;
        const src = getSourceById(clip.sourceId);
        const inactiveSlot = state.activeVideoSlot === 'A' ? 'B' : 'A';

        // Switch to preloaded inactive slot once transition/cut passes onto Clip B
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

        // Preload and pre-seek next Track 1 clip into inactive player (at least 10-15 frames before junction)
        const nextSlot = state.activeVideoSlot === 'A' ? 'B' : 'A';
        const remainingFrames = (endSec - timelineSec) * FPS;
        if (next && next.clip && remainingFrames <= 24) {
          const nextPlayer = setVideoSlotSource(nextSlot, next.clip);
          nextPlayer.pause();
          nextPlayer.muted = true;
          const nextStartSrc = next.clip.reversed ? next.clip.outFrame / FPS : next.clip.inFrame / FPS;
          if (
            (state.slotState[nextSlot].preseekedSec !== nextStartSrc ||
              (remainingFrames <= 15 && Math.abs(nextPlayer.currentTime - nextStartSrc) > 0.01)) &&
            !nextPlayer.seeking &&
            nextPlayer.readyState >= 1
          ) {
            nextPlayer.currentTime = nextStartSrc;
            state.slotState[nextSlot].preseekedSec = nextStartSrc;
          }
        } else if (!next || !next.clip) {
          setVideoSlotSource(nextSlot, null);
        }

        if (src) {
          el.previewClipBadge.textContent = formatClipBadgeText(clip, src);
          el.previewClipBadge.classList.remove('hidden');
        }
        if (state.lastRenderedColorClipId !== clip.id) {
          renderColorGradingPanel();
        }
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

  function getFullscreenElement() {
    return document.fullscreenElement || document.webkitFullscreenElement || null;
  }

  function isPreviewFullscreen() {
    return Boolean(el.previewFullscreenContainer && getFullscreenElement() === el.previewFullscreenContainer);
  }

  function updateFullscreenHudPlayIcon() {
    if (el.fsPlayPauseIcon) {
      el.fsPlayPauseIcon.textContent = state.isPlaying ? 'pause' : 'play_arrow';
    }
    if (el.fsPlayPauseLabel) {
      el.fsPlayPauseLabel.textContent = state.isPlaying ? 'Pause' : 'Play';
    }
  }

  function showFullscreenHudTemporarily() {
    if (!el.fullscreenHud) return;
    el.fullscreenHud.classList.remove('hud-idle');
    if (state.fullscreenHudTimer) {
      clearTimeout(state.fullscreenHudTimer);
      state.fullscreenHudTimer = null;
    }
    if (state.fullscreenActive && state.isPlaying) {
      state.fullscreenHudTimer = setTimeout(() => {
        if (state.fullscreenActive && state.isPlaying && el.fullscreenHud) {
          el.fullscreenHud.classList.add('hud-idle');
        }
      }, 2000);
    }
  }

  function syncFullscreenUI() {
    const active = isPreviewFullscreen();
    state.fullscreenActive = active;
    document.body.classList.toggle('is-fullscreen', active);
    if (el.fullscreenHud) {
      el.fullscreenHud.classList.toggle('hidden', !active);
    }
    updateFullscreenHudPlayIcon();
    if (active) {
      showFullscreenHudTemporarily();
    } else if (state.fullscreenHudTimer) {
      clearTimeout(state.fullscreenHudTimer);
      state.fullscreenHudTimer = null;
      el.fullscreenHud?.classList.remove('hud-idle');
    }
  }

  async function enterPreviewFullscreen() {
    const container = el.previewFullscreenContainer;
    if (!container) return;
    try {
      if (container.requestFullscreen) {
        await container.requestFullscreen();
      } else if (container.webkitRequestFullscreen) {
        container.webkitRequestFullscreen();
      }
    } catch (err) {
      showToast(`Unable to enter full screen: ${err.message}`, 'warn');
    }
  }

  async function exitPreviewFullscreen() {
    if (!getFullscreenElement()) return;
    try {
      if (document.exitFullscreen) {
        await document.exitFullscreen();
      } else if (document.webkitExitFullscreen) {
        document.webkitExitFullscreen();
      }
    } catch {
      // Ignore fullscreen exit errors
    }
  }

  async function triggerAppUpdate() {
    if (
      !window.confirm(
        'Pull the latest gCut update from GitHub and restart? Current edits will be saved before restarting.'
      )
    ) {
      return;
    }

    if (el.updateAppBtn) el.updateAppBtn.disabled = true;
    try {
      if (state.project) {
        await flushProjectSaveNow();
      }
      if (el.updateOverlayTitle) {
        el.updateOverlayTitle.textContent = 'Updating gCut and restarting...';
      }
      if (el.updateOverlaySub) {
        el.updateOverlaySub.textContent =
          'Pulling latest version from GitHub and waiting for server relaunch...';
      }
      el.updateOverlay?.classList.remove('hidden');

      await apiJson('/api/system/update', { method: 'POST' });

      // Wait briefly for shutdown, then poll /api/health every 1 second until server returns
      await new Promise((r) => setTimeout(r, 1000));
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        try {
          const res = await fetch('/api/health', { cache: 'no-store' });
          if (res.ok) {
            const payload = await res.json().catch(() => null);
            if (payload && payload.ok) {
              if (el.updateOverlayTitle) {
                el.updateOverlayTitle.textContent = 'Update complete! Reloading gCut...';
              }
              window.location.reload();
              return;
            }
          }
        } catch {
          // Server is restarting; keep polling every 1 second
        }
        await new Promise((r) => setTimeout(r, 1000));
      }

      if (el.updateOverlayTitle) {
        el.updateOverlayTitle.textContent = 'Server is taking longer than expected...';
      }
      if (el.updateOverlaySub) {
        el.updateOverlaySub.textContent =
          'Please refresh the page manually or check /tmp/gcut_update.log.';
      }
      if (el.updateAppBtn) el.updateAppBtn.disabled = false;
    } catch (err) {
      el.updateOverlay?.classList.add('hidden');
      if (el.updateAppBtn) el.updateAppBtn.disabled = false;
      showToast(`Update failed: ${err.message}`, 'error');
    }
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
    updateFullscreenHudPlayIcon();
    showFullscreenHudTemporarily();
    state.playStartAudioTime = state.audioCtx.currentTime;
    state.playStartTimelineSec = state.playheadFrame / FPS;
    state.rafId = requestAnimationFrame(updateMasterPlaybackLoop);
  }

  function stopPlayback() {
    state.isPlaying = false;
    el.playPauseIcon.textContent = 'play_arrow';
    updateFullscreenHudPlayIcon();
    showFullscreenHudTemporarily();
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
  // Export Modal & Progress Polling (Quick Export + Custom Export Settings)
  // -------------------------------------------------------------------------
  const DEFAULT_EXPORT_PREFS = {
    resolution: '1920x1080',
    codec: 'h264',
    encoderMode: 'hardware',
    rateControlMode: 'crf',
    crf: 18,
    bitrateMbps: 15,
    quality: 'high',
    audioBitrate: '192k',
  };

  function loadCustomExportPrefs(projectId) {
    try {
      const projRaw = projectId ? localStorage.getItem(`gcut_export_prefs_${projectId}`) : null;
      const sessRaw = sessionStorage.getItem('gcut_export_prefs_session') || localStorage.getItem('gcut_export_prefs_last');
      const parsed = JSON.parse(projRaw || sessRaw || '{}');
      return { ...DEFAULT_EXPORT_PREFS, ...(parsed && typeof parsed === 'object' ? parsed : {}) };
    } catch {
      return { ...DEFAULT_EXPORT_PREFS };
    }
  }

  function saveCustomExportPrefs(projectId, prefs) {
    try {
      const serialized = JSON.stringify(prefs);
      if (projectId) localStorage.setItem(`gcut_export_prefs_${projectId}`, serialized);
      localStorage.setItem('gcut_export_prefs_last', serialized);
      sessionStorage.setItem('gcut_export_prefs_session', serialized);
    } catch {
      // Ignore storage quota errors
    }
  }

  function getResolutionTag(resolution) {
    if (resolution === '1280x720') return '720p';
    if (resolution === '3840x2160') return '4k';
    return '1080p';
  }

  function buildDefaultExportFilename(resolution, codec) {
    const rawName = (state.project?.name || 'gcut').trim() || 'gcut';
    const slug = rawName.replace(/[<>:"/\\|?*\x00-\x1F]+/g, '_').replace(/\s+/g, '_');
    const resTag = getResolutionTag(resolution);
    const codecTag = codec === 'h265' ? 'h265' : 'h264';
    return `${slug}_${resTag}_${codecTag}.mp4`;
  }

  function syncCustomExportModalHints(forceFilenameSync = false) {
    if (!el.exportCodecSelect || !el.exportResolutionSelect) return;
    const hw = state.systemStatus.hwSupport || {};
    const resolution = el.exportResolutionSelect.value || '1920x1080';
    const codec = el.exportCodecSelect.value === 'h265' ? 'h265' : 'h264';
    const encoderMode = el.exportEncoderModeSelect?.value === 'software' ? 'software' : 'hardware';
    const rateMode = el.exportRateControlSelect?.value || 'crf';

    const hasVt = codec === 'h265' ? hw.hevc_videotoolbox : hw.h264_videotoolbox;
    if (encoderMode === 'software') {
      el.exportEncoderText.textContent = `Software encoder selected (${codec === 'h265' ? 'libx265 • -tag:v hvc1' : 'libx264 High Profile'})`;
    } else if (hasVt) {
      el.exportEncoderText.textContent = `Hardware VideoToolbox ready (${codec === 'h265' ? 'hevc_videotoolbox • -tag:v hvc1' : 'h264_videotoolbox'} w/ SW fallback)`;
    } else {
      el.exportEncoderText.textContent = `VideoToolbox unavailable — automatic software fallback (${codec === 'h265' ? 'libx265' : 'libx264'})`;
    }

    el.exportCrfRow?.classList.toggle('hidden', rateMode !== 'crf');
    el.exportBitrateRow?.classList.toggle('hidden', rateMode !== 'bitrate');
    el.exportPresetRow?.classList.toggle('hidden', rateMode !== 'preset');

    if (el.exportCrfSlider && el.exportCrfInput && el.exportCrfMappedHint) {
      const crfVal = Math.max(14, Math.min(32, Math.round(Number(el.exportCrfInput.value) || 18)));
      const vtQ = Math.max(1, Math.min(100, Math.round(100 - crfVal * 1.8)));
      el.exportCrfMappedHint.textContent = `CRF ${crfVal} • VideoToolbox -q:v ${vtQ}`;
    }

    if (el.exportBitrateSlider && el.exportBitrateInput && el.exportBitrateMappedHint) {
      const mbps = Math.max(2, Math.min(80, Math.round(Number(el.exportBitrateInput.value) || 15)));
      const maxRate = Number((mbps * 1.5).toFixed(2));
      const bufSize = Number((mbps * 2).toFixed(2));
      el.exportBitrateMappedHint.textContent = `-b:v ${mbps}M -maxrate ${maxRate}M -bufsize ${bufSize}M`;
    }

    if (el.exportFilenameInput && (forceFilenameSync || !state.exportFilenameTouched)) {
      el.exportFilenameInput.value = buildDefaultExportFilename(resolution, codec);
    }
  }

  function collectCustomExportPrefs() {
    const crf = Math.max(14, Math.min(32, Math.round(Number(el.exportCrfInput?.value) || 18)));
    const bitrateMbps = Math.max(2, Math.min(80, Math.round(Number(el.exportBitrateInput?.value) || 15)));
    return {
      resolution: el.exportResolutionSelect?.value || '1920x1080',
      codec: el.exportCodecSelect?.value === 'h265' ? 'h265' : 'h264',
      encoderMode: el.exportEncoderModeSelect?.value === 'software' ? 'software' : 'hardware',
      rateControlMode: el.exportRateControlSelect?.value || 'crf',
      crf,
      bitrateMbps,
      quality: el.exportQualitySelect?.value || 'high',
      audioBitrate: el.exportAudioBitrateSelect?.value || '192k',
    };
  }

  function openCustomExportModal() {
    if (!state.project) return;
    if ((state.project.tracks?.track1 || []).length === 0) {
      showToast('Add at least one clip to Track 1 before exporting.', 'warn');
      return;
    }

    const prefs = loadCustomExportPrefs(state.project.id);
    if (el.exportModalTitle) el.exportModalTitle.textContent = 'Custom Export Settings';
    el.exportFormArea?.classList.remove('hidden');
    el.startExportBtn.classList.remove('hidden');
    el.startExportBtn.disabled = false;
    el.exportProgressArea.classList.add('hidden');
    el.exportDoneActions.classList.add('hidden');

    if (el.exportResolutionSelect) el.exportResolutionSelect.value = prefs.resolution;
    if (el.exportCodecSelect) el.exportCodecSelect.value = prefs.codec;
    if (el.exportEncoderModeSelect) el.exportEncoderModeSelect.value = prefs.encoderMode;
    if (el.exportRateControlSelect) el.exportRateControlSelect.value = prefs.rateControlMode;
    if (el.exportCrfSlider) el.exportCrfSlider.value = String(prefs.crf);
    if (el.exportCrfInput) el.exportCrfInput.value = String(prefs.crf);
    if (el.exportBitrateSlider) el.exportBitrateSlider.value = String(prefs.bitrateMbps);
    if (el.exportBitrateInput) el.exportBitrateInput.value = String(prefs.bitrateMbps);
    if (el.exportQualitySelect) el.exportQualitySelect.value = prefs.quality;
    if (el.exportAudioBitrateSelect) el.exportAudioBitrateSelect.value = prefs.audioBitrate;

    state.exportFilenameTouched = false;
    syncCustomExportModalHints(true);
    el.exportModal.classList.remove('hidden');
  }

  async function runExportJob(exportPayload) {
    if (!state.project) return;
    el.startExportBtn.disabled = true;
    el.exportProgressArea.classList.remove('hidden');
    el.exportDoneActions.classList.add('hidden');
    el.exportStatusText.textContent = 'Saving latest edits and starting FFmpeg...';
    el.exportPercentText.textContent = '0%';
    el.exportProgressBar.style.width = '0%';

    try {
      await flushProjectSaveNow();
      const { job } = await apiJson(`/api/projects/${state.project.id}/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(exportPayload),
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
            state.exportPollTimer = null;
            el.exportStatusText.textContent = 'Export complete!';
            el.exportDownloadLink.href = `/api/projects/${state.project.id}/exports/file/${encodeURIComponent(j.filename)}`;
            el.exportSavedPathNote.textContent = `Saved in project exports/${j.filename}`;
            el.exportDoneActions.classList.remove('hidden');
            el.startExportBtn.disabled = false;
            showToast(`Exported ${j.filename}`, 'success');
          } else if (j.status === 'failed') {
            clearInterval(state.exportPollTimer);
            state.exportPollTimer = null;
            el.exportStatusText.textContent = `Export failed: ${j.error || 'Unknown error'}`;
            el.startExportBtn.disabled = false;
            showToast('FFmpeg export failed', 'error');
          }
        } catch (err) {
          clearInterval(state.exportPollTimer);
          state.exportPollTimer = null;
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

  function triggerQuickExport() {
    if (!state.project) return;
    if ((state.project.tracks?.track1 || []).length === 0) {
      showToast('Add at least one clip to Track 1 before exporting.', 'warn');
      return;
    }
    if (el.exportModalTitle) {
      el.exportModalTitle.textContent = 'Export Final gCut Video (1080p • H.264 • 192k AAC)';
    }
    el.exportFormArea?.classList.add('hidden');
    el.startExportBtn.classList.add('hidden');
    el.exportModal.classList.remove('hidden');

    runExportJob({
      resolution: '1920x1080',
      codec: 'h264',
      encoderMode: 'hardware',
      rateControlMode: 'preset',
      quality: 'high',
      audioBitrate: '192k',
      filename: buildDefaultExportFilename('1920x1080', 'h264'),
    });
  }

  function startExport() {
    if (!state.project) return;
    const prefs = collectCustomExportPrefs();
    saveCustomExportPrefs(state.project.id, prefs);
    const filename =
      el.exportFilenameInput?.value.trim() ||
      buildDefaultExportFilename(prefs.resolution, prefs.codec);
    runExportJob({
      ...prefs,
      filename,
    });
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
    el.finderFileInput.onchange = async (e) => {
      try {
        await uploadFinderFiles(e.target.files);
      } finally {
        el.finderFileInput.value = '';
      }
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
    if (el.fsSortDateBtn) {
      el.fsSortDateBtn.onclick = () => {
        if (state.fsSortMode === 'date') return;
        state.fsSortMode = 'date';
        syncFsSortButtons();
        renderFsEntriesList();
      };
    }
    if (el.fsSortAlphaBtn) {
      el.fsSortAlphaBtn.onclick = () => {
        if (state.fsSortMode === 'alpha') return;
        state.fsSortMode = 'alpha';
        syncFsSortButtons();
        renderFsEntriesList();
      };
    }
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
          const { accepted, skipped } = filterDuplicateFilesByName(
            state.fsSelectedPaths,
            (p) => String(p).split(/[/\\]/).pop()
          );
          if (skipped.length > 0) {
            for (const name of skipped) {
              showToast(`Skipped duplicate filename: ${name}`, 'warn');
            }
          }
          if (accepted.length > 0) {
            const data = await apiJson(`/api/projects/${state.project.id}/sources/link`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ paths: accepted }),
            });
            state.project.sources = data.sources;
            await preloadMissingPeaks();
            renderSourcesList();
            if (data.skipped?.length) {
              for (const name of data.skipped) {
                showToast(`Skipped duplicate filename: ${name}`, 'warn');
              }
            }
            if (data.errors?.length) showToast(data.errors.join(' | '), 'warn');
            else if (data.added?.length) showToast(`Linked ${data.added.length} file(s)`, 'success');
          }
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
      const span = Math.max(1, (sel.clip.outFrame || 0) - (sel.clip.inFrame || 0));
      const candidateDur = Math.max(1, Math.floor(span / clamped));
      const { minAllowedFrames } = getClipTransitionInfo(sel.clip.id);
      if (candidateDur < minAllowedFrames) {
        showToast(
          `Speed ${clamped.toFixed(2)}x blocked: attached transition requires at least ${minAllowedFrames} frames.`,
          'warn'
        );
        renderInspector();
        return;
      }

      closeTransitionPopover();
      pushUndoState();
      const segStart = sel.clip.timelineStartFrame || 0;
      const oldDur = getClipDurationFrames(sel.clip, 'track1');
      sel.clip.speed = Number(clamped.toFixed(3));
      repackTrack1();
      const newDur = getClipDurationFrames(sel.clip, 'track1');
      if (newDur < oldDur) {
        applyAudioCutRipple(segStart + newDur, segStart + oldDur);
      } else if (newDur > oldDur) {
        shiftAudioFromSegmentStart(segStart + oldDur, newDur - oldDur);
      }
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

    el.mirrorToggleBtn.onclick = () => {
      const sel = getSelectedClipObj();
      if (!sel || sel.trackKey !== 'track1') return;
      pushUndoState();
      sel.clip.mirrored = !sel.clip.mirrored;
      renderTimelineAndInspector();
      syncPreviewAtCurrentFrame();
      scheduleAutoSave();
    };

    // Junction Transition Popover Wiring
    el.closeTransitionPopoverBtn.onclick = closeTransitionPopover;
    Array.from(el.transitionPopover.querySelectorAll('.transition-opt-btn')).forEach((btn) => {
      btn.onclick = () => applyJunctionTransition(btn.dataset.transitionType);
    });
    const applyPopoverRamp = (nextRamp) => {
      if (!state.transitionPopover || !state.project) return;
      const t = getAdjacentTransition(state.transitionPopover.fromClipId, state.transitionPopover.toClipId);
      if (!t || (t.type !== 'fade_black' && t.type !== 'fade_white')) return;
      applyJunctionTransition(t.type, nextRamp);
    };
    el.transitionRampMinusBtn.onclick = () => {
      applyPopoverRamp(Math.max(1, (Number(el.transitionRampInput.value) || 1) - 1));
    };
    el.transitionRampPlusBtn.onclick = () => {
      applyPopoverRamp((Number(el.transitionRampInput.value) || 1) + 1);
    };
    el.transitionRampInput.onchange = () => {
      applyPopoverRamp(Number(el.transitionRampInput.value) || 1);
    };
    document.addEventListener('mousedown', (e) => {
      if (!state.transitionPopover) return;
      if (el.transitionPopover.contains(e.target)) return;
      if (e.target.closest && e.target.closest('.tl-junction-btn')) return;
      closeTransitionPopover();
    });

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

    // Export & Custom Export Modal
    el.exportModalBtn.onclick = triggerQuickExport;
    if (el.customExportBtn) el.customExportBtn.onclick = openCustomExportModal;
    el.closeExportModalBtn.onclick = () => el.exportModal.classList.add('hidden');
    el.cancelExportBtn.onclick = () => el.exportModal.classList.add('hidden');
    if (el.exportFilenameInput) {
      el.exportFilenameInput.oninput = () => {
        state.exportFilenameTouched = true;
      };
    }
    const onExportParamChange = () => {
      syncCustomExportModalHints(false);
      if (state.project) saveCustomExportPrefs(state.project.id, collectCustomExportPrefs());
    };
    if (el.exportResolutionSelect) el.exportResolutionSelect.onchange = onExportParamChange;
    if (el.exportCodecSelect) el.exportCodecSelect.onchange = onExportParamChange;
    if (el.exportEncoderModeSelect) el.exportEncoderModeSelect.onchange = onExportParamChange;
    if (el.exportRateControlSelect) el.exportRateControlSelect.onchange = onExportParamChange;
    if (el.exportQualitySelect) el.exportQualitySelect.onchange = onExportParamChange;
    if (el.exportAudioBitrateSelect) el.exportAudioBitrateSelect.onchange = onExportParamChange;

    if (el.exportCrfSlider && el.exportCrfInput) {
      const syncCrf = (raw) => {
        const clamped = Math.max(14, Math.min(32, Math.round(Number(raw) || 18)));
        el.exportCrfSlider.value = String(clamped);
        el.exportCrfInput.value = String(clamped);
        onExportParamChange();
      };
      el.exportCrfSlider.oninput = () => syncCrf(el.exportCrfSlider.value);
      el.exportCrfInput.onchange = () => syncCrf(el.exportCrfInput.value);
    }
    if (el.exportBitrateSlider && el.exportBitrateInput) {
      const syncBr = (raw) => {
        const clamped = Math.max(2, Math.min(80, Math.round(Number(raw) || 15)));
        el.exportBitrateSlider.value = String(clamped);
        el.exportBitrateInput.value = String(clamped);
        onExportParamChange();
      };
      el.exportBitrateSlider.oninput = () => syncBr(el.exportBitrateSlider.value);
      el.exportBitrateInput.onchange = () => syncBr(el.exportBitrateInput.value);
    }
    el.startExportBtn.onclick = startExport;

    // Color Grading Sliders (live preview drag + push Undo only on release)
    const colorSliderSpecs = [
      { field: 'exposure', slider: el.cgExposureSlider, badge: el.cgExposureVal, clamp: clampColorGrade, fmt: formatSignedGrade },
      { field: 'saturation', slider: el.cgSaturationSlider, badge: el.cgSaturationVal, clamp: clampColorGrade, fmt: formatSignedGrade },
      { field: 'contrast', slider: el.cgContrastSlider, badge: el.cgContrastVal, clamp: clampColorGrade, fmt: formatSignedGrade },
      { field: 'hue', slider: el.cgHueSlider, badge: el.cgHueVal, clamp: clampHueGrade, fmt: formatSignedHue },
      { field: 'red', slider: el.cgRedSlider, badge: el.cgRedVal, clamp: clampColorGrade, fmt: formatSignedGrade },
      { field: 'green', slider: el.cgGreenSlider, badge: el.cgGreenVal, clamp: clampColorGrade, fmt: formatSignedGrade },
      { field: 'blue', slider: el.cgBlueSlider, badge: el.cgBlueVal, clamp: clampColorGrade, fmt: formatSignedGrade },
    ];
    for (const { field, slider, badge, clamp, fmt } of colorSliderSpecs) {
      if (!slider) continue;
      const beginBaseline = () => {
        const target = getColorGradeTargetClip();
        if (!target || !target.clip || state.cgPreDragSnapshot) return;
        state.cgPreDragSnapshot = {
          field,
          clipId: target.clip.id,
          snapshot: captureSnapshot(),
          startVal: clamp(target.clip[field]),
        };
      };
      const commitChange = () => {
        if (!state.cgPreDragSnapshot || state.cgPreDragSnapshot.field !== field) return;
        const target = getColorGradeTargetClip();
        const baseline = state.cgPreDragSnapshot;
        state.cgPreDragSnapshot = null;
        if (target && target.clip && target.clip.id === baseline.clipId) {
          const finalVal = clamp(target.clip[field]);
          if (finalVal !== baseline.startVal) {
            const hist = getProjectHistory();
            hist.undo.push(baseline.snapshot);
            if (hist.undo.length > 80) hist.undo.shift();
            hist.redo = [];
            updateUndoRedoButtons();
            scheduleAutoSave();
          }
        }
      };

      slider.addEventListener('pointerdown', beginBaseline);
      slider.addEventListener('keydown', () => beginBaseline());
      slider.addEventListener('input', () => {
        const target = getColorGradeTargetClip();
        if (!target || !target.clip) return;
        if (!state.cgPreDragSnapshot) beginBaseline();
        const nextVal = clamp(slider.value);
        target.clip[field] = nextVal;
        if (badge) badge.textContent = fmt(nextVal);
        applyLiveColorFilterToActiveSlots(target.clip);
        if (el.cgResetAllBtn) {
          el.cgResetAllBtn.disabled = isClipColorDefault(target.clip);
        }
      });
      slider.addEventListener('change', commitChange);
      slider.addEventListener('pointerup', commitChange);
      slider.addEventListener('keyup', commitChange);
      slider.addEventListener('dblclick', () => {
        const target = getColorGradeTargetClip();
        if (!target || !target.clip) return;
        state.cgPreDragSnapshot = null;
        if (clamp(target.clip[field]) === 0) return;
        pushUndoState();
        target.clip[field] = 0;
        renderColorGradingPanel();
        applyLiveColorFilterToActiveSlots(target.clip);
        syncPreviewAtCurrentFrame();
        scheduleAutoSave();
      });
    }
    if (el.cgResetAllBtn) {
      el.cgResetAllBtn.onclick = () => {
        const target = getColorGradeTargetClip();
        if (!target || !target.clip) return;
        const { clip } = target;
        if (isClipColorDefault(clip)) {
          return;
        }
        state.cgPreDragSnapshot = null;
        pushUndoState();
        clip.exposure = 0;
        clip.saturation = 0;
        clip.contrast = 0;
        clip.hue = 0;
        clip.red = 0;
        clip.green = 0;
        clip.blue = 0;
        renderColorGradingPanel();
        applyLiveColorFilterToActiveSlots(clip);
        syncPreviewAtCurrentFrame();
        scheduleAutoSave();
      };
    }

    // GitHub Self-Update
    if (el.updateAppBtn) {
      el.updateAppBtn.onclick = triggerAppUpdate;
    }

    // 16:9 Full-Screen Preview & Floating HUD
    if (el.fullscreenBtn) {
      el.fullscreenBtn.onclick = () => {
        if (isPreviewFullscreen()) exitPreviewFullscreen();
        else enterPreviewFullscreen();
      };
    }
    if (el.fsPlayPauseBtn) {
      el.fsPlayPauseBtn.onclick = (e) => {
        e.stopPropagation();
        togglePlayback();
        showFullscreenHudTemporarily();
      };
    }
    if (el.fsExitBtn) {
      el.fsExitBtn.onclick = (e) => {
        e.stopPropagation();
        exitPreviewFullscreen();
      };
    }
    if (el.previewFullscreenContainer) {
      const wakeHud = () => {
        if (state.fullscreenActive) showFullscreenHudTemporarily();
      };
      el.previewFullscreenContainer.addEventListener('mousemove', wakeHud);
      el.previewFullscreenContainer.addEventListener('mousedown', wakeHud);
      el.previewFullscreenContainer.addEventListener('touchstart', wakeHud, { passive: true });
    }
    document.addEventListener('fullscreenchange', syncFullscreenUI);
    document.addEventListener('webkitfullscreenchange', syncFullscreenUI);

    // Global Keyboard Shortcuts
    window.addEventListener('keydown', (e) => {
      if (isPreviewFullscreen() || state.fullscreenActive) {
        if (e.key === 'Escape') {
          exitPreviewFullscreen();
          return;
        }
        const tag = document.activeElement?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable) {
          return;
        }
        if (e.code === 'Space') {
          e.preventDefault();
          togglePlayback();
          showFullscreenHudTemporarily();
        }
        return; // Ignore timeline editing hotkeys while in full screen
      }

      if (e.key === 'Escape' && state.transitionPopover) {
        closeTransitionPopover();
        return;
      }
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
    prepareMagSnapIcon();
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
