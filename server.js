'use strict';

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFile, execFileSync } = require('child_process');

const app = express();
const PORT = Number(process.env.PORT) || 3456;
const FPS = 24;
const SAMPLE_RATE = 48000;
const MAX_IMPORT_BATCH = 10;
const ALLOWED_EXTENSIONS = new Set(['.mp4', '.mov', '.mkv', '.wav', '.mp3', '.m4a']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.mkv']);

const MONTAGE_ROOT = path.join(os.homedir(), 'Documents', 'MontageStudio');
const PROJECTS_ROOT = path.join(MONTAGE_ROOT, 'projects');
const DOWNLOADS_DIR = path.join(os.homedir(), 'Downloads');

const PUBLIC_DIR = path.join(__dirname, 'public');

function syncAssetToPublic(filename) {
  try {
    const rootFile = path.join(__dirname, filename);
    const pubFile = path.join(PUBLIC_DIR, filename);
    if (fs.existsSync(rootFile) && !fs.existsSync(pubFile)) {
      fs.copyFileSync(rootFile, pubFile);
    } else if (fs.existsSync(pubFile) && !fs.existsSync(rootFile)) {
      fs.copyFileSync(pubFile, rootFile);
    }
  } catch {
    // Ignore asset sync errors on read-only paths
  }
}

fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
syncAssetToPublic('magnet.png');

app.use(express.json({ limit: '25mb' }));
app.use(express.static(PUBLIC_DIR));
app.get('/magnet.png', (req, res, next) => {
  const pubMagnet = path.join(PUBLIC_DIR, 'magnet.png');
  if (fs.existsSync(pubMagnet)) return res.sendFile(pubMagnet);
  const rootMagnet = path.join(__dirname, 'magnet.png');
  if (fs.existsSync(rootMagnet)) return res.sendFile(rootMagnet);
  return next();
});

// ---------------------------------------------------------------------------
// Binary Discovery & Hardware Acceleration Probe
// ---------------------------------------------------------------------------

function findBinary(name) {
  const candidates = [
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(cmd, [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (out) {
      return out.split(/\r?\n/)[0].trim();
    }
  } catch {
    // Binary not found in PATH
  }
  return null;
}

const ffmpegPath = findBinary('ffmpeg');
const ffprobePath = findBinary('ffprobe');

const hwSupport = {
  h264_videotoolbox: false,
  hevc_videotoolbox: false,
  probed: false,
};

function testVideoToolboxEncoder(encoder) {
  return new Promise((resolve) => {
    if (!ffmpegPath) return resolve(false);
    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-f', 'lavfi',
      '-i', 'color=c=black:s=64x64:r=24:d=0.1',
      '-c:v', encoder,
      '-allow_sw', '1',
      '-f', 'null',
      '-',
    ];
    execFile(ffmpegPath, args, { timeout: 8000 }, (err) => {
      resolve(!err);
    });
  });
}

async function probeHardwareEncoders() {
  if (!ffmpegPath) {
    hwSupport.probed = true;
    return;
  }
  const [h264Ok, hevcOk] = await Promise.all([
    testVideoToolboxEncoder('h264_videotoolbox'),
    testVideoToolboxEncoder('hevc_videotoolbox'),
  ]);
  hwSupport.h264_videotoolbox = h264Ok;
  hwSupport.hevc_videotoolbox = hevcOk;
  hwSupport.probed = true;
}

probeHardwareEncoders();

// ---------------------------------------------------------------------------
// Helpers & Project Persistence
// ---------------------------------------------------------------------------

function sanitizeProjectId(id) {
  if (!id || typeof id !== 'string' || !/^[a-zA-Z0-9_-]{3,64}$/.test(id)) {
    return null;
  }
  return id;
}

function getProjectPaths(projectId) {
  const safeId = sanitizeProjectId(projectId);
  if (!safeId) return null;
  const root = path.join(PROJECTS_ROOT, safeId);
  return {
    id: safeId,
    root,
    jsonFile: path.join(root, 'project.json'),
    sourcesDir: path.join(root, 'sources'),
    cacheDir: path.join(root, 'cache'),
    exportsDir: path.join(root, 'exports'),
  };
}

function ensureProjectDirs(pathsObj) {
  fs.mkdirSync(pathsObj.root, { recursive: true });
  fs.mkdirSync(pathsObj.sourcesDir, { recursive: true });
  fs.mkdirSync(pathsObj.cacheDir, { recursive: true });
  fs.mkdirSync(pathsObj.exportsDir, { recursive: true });
}

function readProjectJson(pathsObj) {
  if (!fs.existsSync(pathsObj.jsonFile)) return null;
  const raw = fs.readFileSync(pathsObj.jsonFile, 'utf8');
  return JSON.parse(raw);
}

function writeProjectJsonAtomic(pathsObj, project) {
  const tmpFile = `${pathsObj.jsonFile}.tmp.${process.pid}`;
  fs.writeFileSync(tmpFile, JSON.stringify(project, null, 2), 'utf8');
  fs.renameSync(tmpFile, pathsObj.jsonFile);
}

function verifyProjectSources(project) {
  if (!Array.isArray(project.sources)) project.sources = [];
  for (const src of project.sources) {
    src.missing = !src.path || !fs.existsSync(src.path);
  }
  return project;
}

function getPostSpeedDurationFrames(inFrame, outFrame, speed) {
  const safeSpeed = Number(speed) > 0 ? Number(speed) : 1;
  const safeIn = Math.max(0, Math.round(inFrame || 0));
  const safeOut = Math.max(safeIn + 1, Math.round(outFrame || safeIn + 1));
  const span = Math.max(1, safeOut - safeIn);
  return Math.max(1, Math.floor(span / safeSpeed));
}

function clampColorGrade(val) {
  const n = Math.round(Number(val) || 0);
  return Math.max(-100, Math.min(100, n));
}

function getTransitionNetDelta(type) {
  if (type === 'transform') return -1;
  if (type === 'fade_black' || type === 'fade_white') return 1;
  return 0;
}

function resolveTrack1LayoutAndTransitions(track1, rawTransitions) {
  const list = Array.isArray(track1) ? track1 : [];
  const transList = Array.isArray(rawTransitions) ? rawTransitions : [];

  const clips = list.map((clip) => {
    const speed = Number(clip.speed) > 0 ? Number(clip.speed) : 1;
    const inFrame = Math.max(0, Math.round(clip.inFrame || 0));
    const outFrame = Math.max(inFrame + 1, Math.round(clip.outFrame || inFrame + 1));
    const durationFrames = getPostSpeedDurationFrames(inFrame, outFrame, speed);
    return {
      ...clip,
      speed,
      inFrame,
      outFrame,
      reversed: Boolean(clip.reversed),
      mirrored: Boolean(clip.mirrored),
      exposure: clampColorGrade(clip.exposure),
      saturation: clampColorGrade(clip.saturation),
      contrast: clampColorGrade(clip.contrast),
      durationFrames,
      leftTransitionFrames: 0,
      rightTransitionFrames: 0,
      timelineStartFrame: 0,
    };
  });

  const transMap = new Map();
  for (const t of transList) {
    if (!t || typeof t.fromClipId !== 'string' || typeof t.toClipId !== 'string') continue;
    transMap.set(`${t.fromClipId}::${t.toClipId}`, t);
  }

  // First assign fixed 1-frame footprint for eligible transforms so ramp caps see them
  const junctionRaw = [];
  for (let i = 0; i < clips.length - 1; i += 1) {
    const a = clips[i];
    const b = clips[i + 1];
    const candidate = a.id && b.id ? transMap.get(`${a.id}::${b.id}`) : null;
    if (!candidate) {
      junctionRaw.push(null);
      continue;
    }
    if (candidate.type === 'transform' && a.durationFrames >= 3 && b.durationFrames >= 3) {
      junctionRaw.push({ fromClipId: a.id, toClipId: b.id, type: 'transform', rampFrames: 1 });
      a.rightTransitionFrames = 1;
      b.leftTransitionFrames = 1;
    } else if (
      (candidate.type === 'fade_black' || candidate.type === 'fade_white') &&
      a.durationFrames >= 7 &&
      b.durationFrames >= 7
    ) {
      junctionRaw.push({
        fromClipId: a.id,
        toClipId: b.id,
        type: candidate.type,
        rampFrames: Math.max(1, Math.round(Number(candidate.rampFrames) || 1)),
      });
    } else {
      junctionRaw.push(null);
    }
  }

  // Second pass: clamp fade rampFrames leaving >= 1 body frame per clip
  const resolvedTransitions = [];
  for (let i = 0; i < junctionRaw.length; i += 1) {
    const t = junctionRaw[i];
    if (!t) {
      resolvedTransitions.push(null);
      continue;
    }
    if (t.type === 'transform') {
      resolvedTransitions.push(t);
      continue;
    }
    const a = clips[i];
    const b = clips[i + 1];
    // Reserve at least 1 frame for an unassigned downstream fade on B if needed
    const bNext = junctionRaw[i + 1];
    const bReservedRight =
      bNext && (bNext.type === 'fade_black' || bNext.type === 'fade_white') ? 1 : b.rightTransitionFrames;
    const maxRamp = Math.min(
      a.durationFrames - 1 - a.leftTransitionFrames,
      b.durationFrames - 1 - bReservedRight
    );
    if (maxRamp < 1) {
      resolvedTransitions.push(null);
      continue;
    }
    const ramp = Math.max(1, Math.min(t.rampFrames, maxRamp));
    a.rightTransitionFrames = ramp;
    b.leftTransitionFrames = ramp;
    resolvedTransitions.push({ ...t, rampFrames: ramp });
  }

  let cursorFrames = 0;
  for (let i = 0; i < clips.length; i += 1) {
    clips[i].timelineStartFrame = cursorFrames;
    cursorFrames += clips[i].durationFrames;
    if (i < resolvedTransitions.length && resolvedTransitions[i]) {
      cursorFrames += getTransitionNetDelta(resolvedTransitions[i].type);
    }
  }

  return {
    clips,
    junctionTransitions: resolvedTransitions,
    totalFrames: Math.max(0, cursorFrames),
  };
}

function normalizeProjectData(project) {
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
      }))
    : [];
  project.tracks.track2 = Array.isArray(project.tracks.track2) ? project.tracks.track2 : [];
  project.tracks.track3 = Array.isArray(project.tracks.track3) ? project.tracks.track3 : [];
  project.transitions = Array.isArray(project.transitions)
    ? project.transitions.filter(
        (t) =>
          t &&
          typeof t.fromClipId === 'string' &&
          typeof t.toClipId === 'string' &&
          ['transform', 'fade_black', 'fade_white'].includes(t.type)
      )
    : [];
  return project;
}

function computeTrack1DurationFrames(track1, transitions = []) {
  return resolveTrack1LayoutAndTransitions(track1, transitions).totalFrames;
}

function makeDefaultProject(id, name) {
  const now = new Date().toISOString();
  return {
    id,
    name: name || 'Untitled Project',
    createdAt: now,
    updatedAt: now,
    fps: FPS,
    width: 1920,
    height: 1080,
    snapEnabled: true,
    rippleSyncAudio: false,
    sources: [],
    tracks: {
      track1: [],
      track2: [],
      track3: [],
    },
    transitions: [],
  };
}

function hasAllowedExtension(filename) {
  const ext = path.extname(filename || '').toLowerCase();
  return ALLOWED_EXTENSIONS.has(ext);
}

function getUniqueDestPath(dir, desiredName) {
  const ext = path.extname(desiredName);
  const base = path.basename(desiredName, ext).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_') || 'media';
  let candidate = path.join(dir, `${base}${ext}`);
  let counter = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base}_${counter}${ext}`);
    counter += 1;
  }
  return candidate;
}

function getMimeTypeForExt(ext) {
  switch (ext.toLowerCase()) {
    case '.mp4': return 'video/mp4';
    case '.mov': return 'video/quicktime';
    case '.mkv': return 'video/x-matroska';
    case '.wav': return 'audio/wav';
    case '.mp3': return 'audio/mpeg';
    case '.m4a': return 'audio/mp4';
    default: return 'application/octet-stream';
  }
}

function copyDirRecursive(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function hardlinkDirFiles(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  if (!fs.existsSync(srcDir)) return;
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      hardlinkDirFiles(srcPath, destPath);
    } else if (entry.isFile()) {
      try {
        fs.linkSync(srcPath, destPath);
      } catch (err) {
        if (err.code === 'EXDEV') {
          fs.copyFileSync(srcPath, destPath);
        } else {
          throw err;
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// FFprobe Media Inspection, Thumbnail & Waveform Peak Generation
// ---------------------------------------------------------------------------

function runFfprobe(filePath) {
  return new Promise((resolve, reject) => {
    if (!ffprobePath) {
      return reject(new Error('ffprobe binary not found. Install via: brew install ffmpeg'));
    }
    const args = [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      filePath,
    ];
    execFile(ffprobePath, args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      try {
        resolve(JSON.parse(stdout));
      } catch (parseErr) {
        reject(parseErr);
      }
    });
  });
}

function parseFrameRate(rateStr) {
  if (!rateStr || typeof rateStr !== 'string') return FPS;
  if (rateStr.includes('/')) {
    const [num, den] = rateStr.split('/').map(Number);
    if (den > 0 && num > 0) return Number((num / den).toFixed(3));
  }
  const parsed = Number(rateStr);
  return parsed > 0 ? Number(parsed.toFixed(3)) : FPS;
}

function generateThumbnail(filePath, outPath, durationSec) {
  return new Promise((resolve) => {
    if (!ffmpegPath) return resolve(false);
    const seekTime = Math.min(1, Math.max(0, (durationSec || 0) * 0.1));
    const args = [
      '-y',
      '-hide_banner',
      '-loglevel', 'error',
      '-ss', seekTime.toFixed(3),
      '-i', filePath,
      '-frames:v', '1',
      '-vf', 'scale=320:-1',
      '-q:v', '4',
      outPath,
    ];
    execFile(ffmpegPath, args, { timeout: 20000 }, (err) => {
      resolve(!err && fs.existsSync(outPath));
    });
  });
}

function generateWaveformPeaks(filePath, outJsonPath, targetBins = 800) {
  return new Promise((resolve) => {
    if (!ffmpegPath) return resolve(false);
    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-i', filePath,
      '-vn',
      '-ac', '1',
      '-ar', '8000',
      '-f', 's16le',
      'pipe:1',
    ];
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];

    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.on('error', () => resolve(false));
    child.on('close', (code) => {
      if (code !== 0 || chunks.length === 0) {
        return resolve(false);
      }
      const buffer = Buffer.concat(chunks);
      const totalSamples = Math.floor(buffer.length / 2);
      if (totalSamples === 0) {
        fs.writeFileSync(outJsonPath, JSON.stringify({ peaks: new Array(targetBins).fill(0) }), 'utf8');
        return resolve(true);
      }
      const binCount = Math.min(targetBins, Math.max(1, totalSamples));
      const samplesPerBin = totalSamples / binCount;
      const rawPeaks = new Array(binCount).fill(0);
      let globalMax = 0;

      for (let i = 0; i < binCount; i += 1) {
        const startIdx = Math.floor(i * samplesPerBin);
        const endIdx = Math.min(totalSamples, Math.max(startIdx + 1, Math.floor((i + 1) * samplesPerBin)));
        let maxAbs = 0;
        for (let s = startIdx; s < endIdx; s += 1) {
          const sample = Math.abs(buffer.readInt16LE(s * 2)) / 32768;
          if (sample > maxAbs) maxAbs = sample;
        }
        rawPeaks[i] = maxAbs;
        if (maxAbs > globalMax) globalMax = maxAbs;
      }

      const normFactor = globalMax > 0.0001 ? 1 / globalMax : 1;
      const peaks = rawPeaks.map((v) => Number((v * normFactor).toFixed(4)));
      fs.writeFileSync(outJsonPath, JSON.stringify({ peaks }), 'utf8');
      resolve(true);
    });
  });
}

async function inspectAndCacheSource(pathsObj, projectId, filePath, originalName, storageType, existingSourceId = null) {
  const probe = await runFfprobe(filePath);
  const streams = Array.isArray(probe.streams) ? probe.streams : [];
  const format = probe.format || {};

  const videoStream = streams.find(
    (s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic === 1)
  );
  const audioStream = streams.find((s) => s.codec_type === 'audio');

  const ext = path.extname(originalName || filePath).toLowerCase();
  const isVideo = Boolean(videoStream) && (VIDEO_EXTENSIONS.has(ext) || Number(videoStream.width) > 0);
  const mediaType = isVideo ? 'video' : 'audio';

  let durationSec = Number(format.duration);
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    durationSec = Number(videoStream?.duration || audioStream?.duration || 0);
  }
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    durationSec = 1;
  }

  const width = videoStream ? Number(videoStream.width) || 1920 : 0;
  const height = videoStream ? Number(videoStream.height) || 1080 : 0;
  const sourceFps = videoStream ? parseFrameRate(videoStream.r_frame_rate || videoStream.avg_frame_rate) : FPS;
  const totalFrames = Math.max(1, Math.round(durationSec * FPS));
  const hasAudio = Boolean(audioStream);
  const sampleRate = audioStream ? Number(audioStream.sample_rate) || 48000 : 0;
  const channels = audioStream ? Number(audioStream.channels) || 2 : 0;

  const sourceId = existingSourceId || `src_${crypto.randomBytes(6).toString('hex')}`;
  let thumbnailUrl = null;
  let peaksUrl = null;

  if (mediaType === 'video') {
    const thumbFile = `${sourceId}.jpg`;
    const thumbOk = await generateThumbnail(filePath, path.join(pathsObj.cacheDir, thumbFile), durationSec);
    if (thumbOk) {
      thumbnailUrl = `/api/projects/${projectId}/cache/${thumbFile}`;
    }
  }

  if (hasAudio) {
    const peaksFile = `${sourceId}_peaks.json`;
    const peaksOk = await generateWaveformPeaks(filePath, path.join(pathsObj.cacheDir, peaksFile), 800);
    if (peaksOk) {
      peaksUrl = `/api/projects/${projectId}/cache/${peaksFile}`;
    }
  }

  return {
    id: sourceId,
    name: originalName || path.basename(filePath),
    path: filePath,
    storageType, // 'copied' | 'linked'
    mediaType,   // 'video' | 'audio'
    width,
    height,
    sourceFps,
    durationSec: Number(durationSec.toFixed(4)),
    totalFrames,
    hasAudio,
    sampleRate,
    channels,
    missing: false,
    thumbnailUrl,
    peaksUrl,
  };
}

// ---------------------------------------------------------------------------
// API: System Status & macOS Directory Browser
// ---------------------------------------------------------------------------

app.get('/api/system/status', (_req, res) => {
  res.json({
    ffmpegFound: Boolean(ffmpegPath),
    ffprobeFound: Boolean(ffprobePath),
    ffmpegPath,
    ffprobePath,
    hwSupport,
    downloadsDir: fs.existsSync(DOWNLOADS_DIR) ? DOWNLOADS_DIR : os.homedir(),
    projectsRoot: PROJECTS_ROOT,
    installHint: 'brew install ffmpeg',
  });
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    app: 'gCut',
    port: Number(process.env.PORT) || (req.socket && req.socket.localPort) || null,
    ts: Date.now(),
  });
});

function runExecFile(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 10 * 1024 * 1024, ...options }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || stdout || err.message || 'Command failed').trim();
        reject(new Error(msg));
        return;
      }
      resolve({ stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

app.post('/api/system/update', async (req, res) => {
  const appDir = __dirname;
  const repoUrl = 'https://github.com/archpawell/gCut.git';
  const backupDir = '/tmp/gcut_assets_backup';
  const essentialAssets = ['LOGO_W.jpg', 'LOGO_B.jpg', 'magnet.png'];

  try {
    // 1. Back up essential UI image assets outside the repo before resetting/updating
    fs.mkdirSync(backupDir, { recursive: true });
    for (const assetName of essentialAssets) {
      const candidates = [
        path.join(appDir, 'public', assetName),
        path.join(appDir, assetName),
      ];
      const existing = candidates.find((p) => fs.existsSync(p));
      if (existing) {
        fs.copyFileSync(existing, path.join(backupDir, assetName));
      }
    }

    // 2. Pull latest from standalone GitHub repository without touching ~/Documents/MontageStudio/
    const hasGit = fs.existsSync(path.join(appDir, '.git'));
    if (hasGit) {
      const updateScript = `
        set -e
        cd "$1"
        if git remote get-url origin >/dev/null 2>&1; then
          git remote set-url origin "$2"
        else
          git remote add origin "$2"
        fi
        git fetch origin
        git reset --hard origin/main
      `;
      await runExecFile('/bin/bash', ['-c', updateScript, 'gcut-git-update', appDir, repoUrl], {
        timeout: 90000,
      });
    } else {
      const cloneScript = `
        set -e
        TMP_CLONE="/tmp/gcut_repo_clone_$$"
        rm -rf "$TMP_CLONE"
        git clone --branch main "$2" "$TMP_CLONE"
        cp -a "$TMP_CLONE"/. "$1"/
        rm -rf "$TMP_CLONE"
      `;
      await runExecFile('/bin/bash', ['-c', cloneScript, 'gcut-git-clone', appDir, repoUrl], {
        timeout: 120000,
      });
    }

    // 3. Ensure essential image assets exist in public/ (and root), restoring from backup if missing
    fs.mkdirSync(PUBLIC_DIR, { recursive: true });
    for (const assetName of essentialAssets) {
      const pubAsset = path.join(PUBLIC_DIR, assetName);
      const rootAsset = path.join(appDir, assetName);
      const bakAsset = path.join(backupDir, assetName);
      if (!fs.existsSync(pubAsset)) {
        if (fs.existsSync(rootAsset)) {
          fs.copyFileSync(rootAsset, pubAsset);
        } else if (fs.existsSync(bakAsset)) {
          fs.copyFileSync(bakAsset, pubAsset);
        }
      }
      if (!fs.existsSync(rootAsset) && fs.existsSync(pubAsset)) {
        fs.copyFileSync(pubAsset, rootAsset);
      }
    }

    // 4. Ensure start.command is executable
    const startCmdPath = path.join(appDir, 'start.command');
    if (fs.existsSync(startCmdPath)) {
      fs.chmodSync(startCmdPath, 0o755);
    }

    const activePort = Number(process.env.PORT) || (req.socket && req.socket.localPort) || 3456;
    res.json({ ok: true, status: 'restarting', port: activePort });

    // 5. Detached restart script: terminate active server on port and relaunch cleanly
    const { spawn } = require('child_process');
    const restartScript = `
      sleep 0.35
      PIDS=$(lsof -ti:"$1" 2>/dev/null || true)
      if [ -n "$PIDS" ]; then
        echo "$PIDS" | xargs kill -9 2>/dev/null || true
      fi
      for _ in $(seq 1 25); do
        if ! lsof -iTCP:"$1" -sTCP:LISTEN -t >/dev/null 2>&1; then
          break
        fi
        sleep 0.15
      done
      cd "$2"
      chmod +x ./start.command
      nohup env GCUT_NO_OPEN=1 PORT="$1" ./start.command >/tmp/gcut_update.log 2>&1 &
    `;
    setTimeout(() => {
      const child = spawn('/bin/bash', ['-c', restartScript, 'gcut-restart', String(activePort), appDir], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
    }, 100);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to update from GitHub' });
  }
});

app.get('/api/fs/browse', (req, res) => {
  try {
    const requested = typeof req.query.dir === 'string' && req.query.dir.trim()
      ? req.query.dir.trim()
      : (fs.existsSync(DOWNLOADS_DIR) ? DOWNLOADS_DIR : os.homedir());

    const resolvedDir = path.resolve(requested);
    if (!fs.existsSync(resolvedDir) || !fs.statSync(resolvedDir).isDirectory()) {
      return res.status(400).json({ error: `Directory not found: ${resolvedDir}` });
    }

    const entries = fs.readdirSync(resolvedDir, { withFileTypes: true });
    const directories = [];
    const files = [];

    for (const entry of entries) {
      // Strictly filter out hidden dotfiles such as .DS_Store
      if (entry.name.startsWith('.')) continue;

      const fullPath = path.join(resolvedDir, entry.name);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          directories.push({ name: entry.name, path: fullPath });
        } else if (stat.isFile() && hasAllowedExtension(entry.name)) {
          files.push({
            name: entry.name,
            path: fullPath,
            ext: path.extname(entry.name).toLowerCase(),
            size: stat.size,
            mtime: stat.mtime.toISOString(),
          });
        }
      } catch {
        // Ignore unreadable permission-locked items
      }
    }

    directories.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    files.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

    const parentDir = path.dirname(resolvedDir);
    const home = os.homedir();
    const shortcuts = [
      { label: 'Downloads', path: path.join(home, 'Downloads') },
      { label: 'Desktop', path: path.join(home, 'Desktop') },
      { label: 'Documents', path: path.join(home, 'Documents') },
      { label: 'Movies', path: path.join(home, 'Movies') },
      { label: 'Home', path: home },
    ].filter((s) => fs.existsSync(s.path));

    res.json({
      currentDir: resolvedDir,
      parentDir: parentDir !== resolvedDir ? parentDir : null,
      shortcuts,
      directories,
      files,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// API: Multi-Project Management & APFS Hardlink Cloning
// ---------------------------------------------------------------------------

app.get('/api/projects', (_req, res) => {
  try {
    const entries = fs.readdirSync(PROJECTS_ROOT, { withFileTypes: true });
    const list = [];

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const pathsObj = getProjectPaths(entry.name);
      if (!pathsObj) continue;
      try {
        const project = readProjectJson(pathsObj);
        if (!project) continue;
        const tracks = project.tracks || {};
        const clipCount =
          (Array.isArray(tracks.track1) ? tracks.track1.length : 0) +
          (Array.isArray(tracks.track2) ? tracks.track2.length : 0) +
          (Array.isArray(tracks.track3) ? tracks.track3.length : 0);
        const totalFrames = computeTrack1DurationFrames(tracks.track1 || [], project.transitions || []);
        list.push({
          id: project.id || entry.name,
          name: project.name || 'Untitled Project',
          createdAt: project.createdAt,
          updatedAt: project.updatedAt,
          clipCount,
          sourceCount: Array.isArray(project.sources) ? project.sources.length : 0,
          durationSec: Number((totalFrames / FPS).toFixed(2)),
        });
      } catch {
        // Skip malformed directory
      }
    }

    list.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
    res.json({ projects: list });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/projects', (req, res) => {
  try {
    const name = (req.body?.name || '').trim() || 'Untitled Montage';
    const id = `proj_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
    const pathsObj = getProjectPaths(id);
    ensureProjectDirs(pathsObj);
    const project = makeDefaultProject(id, name);
    writeProjectJsonAtomic(pathsObj, project);
    res.status(201).json({ project });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/projects/:id', (req, res) => {
  const pathsObj = getProjectPaths(req.params.id);
  if (!pathsObj) return res.status(400).json({ error: 'Invalid project id' });
  try {
    const project = readProjectJson(pathsObj);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    normalizeProjectData(project);
    verifyProjectSources(project);
    res.json({ project });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/projects/:id', (req, res) => {
  const pathsObj = getProjectPaths(req.params.id);
  if (!pathsObj) return res.status(400).json({ error: 'Invalid project id' });
  try {
    const existing = readProjectJson(pathsObj);
    if (!existing) return res.status(404).json({ error: 'Project not found' });

    const payload = req.body || {};
    const updated = normalizeProjectData({
      ...existing,
      name: typeof payload.name === 'string' && payload.name.trim() ? payload.name.trim() : existing.name,
      snapEnabled: typeof payload.snapEnabled === 'boolean' ? payload.snapEnabled : existing.snapEnabled,
      rippleSyncAudio: typeof payload.rippleSyncAudio === 'boolean' ? payload.rippleSyncAudio : existing.rippleSyncAudio,
      sources: Array.isArray(payload.sources) ? payload.sources : existing.sources,
      tracks: payload.tracks && typeof payload.tracks === 'object' ? {
        track1: Array.isArray(payload.tracks.track1) ? payload.tracks.track1 : [],
        track2: Array.isArray(payload.tracks.track2) ? payload.tracks.track2 : [],
        track3: Array.isArray(payload.tracks.track3) ? payload.tracks.track3 : [],
      } : existing.tracks,
      transitions: Array.isArray(payload.transitions) ? payload.transitions : (existing.transitions || []),
      updatedAt: new Date().toISOString(),
    });
    verifyProjectSources(updated);
    writeProjectJsonAtomic(pathsObj, updated);
    res.json({ project: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/projects/:id', (req, res) => {
  const pathsObj = getProjectPaths(req.params.id);
  if (!pathsObj) return res.status(400).json({ error: 'Invalid project id' });
  try {
    const project = readProjectJson(pathsObj);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const newName = (req.body?.name || '').trim();
    if (!newName) return res.status(400).json({ error: 'Project name is required' });
    project.name = newName;
    project.updatedAt = new Date().toISOString();
    writeProjectJsonAtomic(pathsObj, project);
    res.json({ project });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/projects/:id', (req, res) => {
  const pathsObj = getProjectPaths(req.params.id);
  if (!pathsObj) return res.status(400).json({ error: 'Invalid project id' });
  try {
    if (!fs.existsSync(pathsObj.root)) {
      return res.status(404).json({ error: 'Project not found' });
    }
    fs.rmSync(pathsObj.root, { recursive: true, force: true });
    res.json({ deleted: true, id: pathsObj.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/projects/:id/duplicate', (req, res) => {
  const srcPaths = getProjectPaths(req.params.id);
  if (!srcPaths) return res.status(400).json({ error: 'Invalid project id' });

  try {
    const origProject = readProjectJson(srcPaths);
    if (!origProject) return res.status(404).json({ error: 'Project not found' });

    const newId = `proj_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
    const destPaths = getProjectPaths(newId);
    ensureProjectDirs(destPaths);

    // Clone cache files directly
    if (fs.existsSync(srcPaths.cacheDir)) {
      copyDirRecursive(srcPaths.cacheDir, destPaths.cacheDir);
    }

    // Create APFS/filesystem hardlinks for all copied files inside sources/
    if (fs.existsSync(srcPaths.sourcesDir)) {
      hardlinkDirFiles(srcPaths.sourcesDir, destPaths.sourcesDir);
    }

    const now = new Date().toISOString();
    const cloned = JSON.parse(JSON.stringify(origProject));
    cloned.id = newId;
    cloned.name = `${origProject.name || 'Untitled'} (Copy)`;
    cloned.createdAt = now;
    cloned.updatedAt = now;

    const oldSourcesPrefix = path.resolve(srcPaths.sourcesDir) + path.sep;
    cloned.sources = (cloned.sources || []).map((src) => {
      const updatedSrc = { ...src };
      if (updatedSrc.path) {
        const resolvedSrcPath = path.resolve(updatedSrc.path);
        if (resolvedSrcPath.startsWith(oldSourcesPrefix)) {
          const rel = resolvedSrcPath.slice(oldSourcesPrefix.length);
          updatedSrc.path = path.join(destPaths.sourcesDir, rel);
        }
      }
      if (updatedSrc.thumbnailUrl) {
        updatedSrc.thumbnailUrl = updatedSrc.thumbnailUrl.replace(
          `/api/projects/${srcPaths.id}/cache/`,
          `/api/projects/${newId}/cache/`
        );
      }
      if (updatedSrc.peaksUrl) {
        updatedSrc.peaksUrl = updatedSrc.peaksUrl.replace(
          `/api/projects/${srcPaths.id}/cache/`,
          `/api/projects/${newId}/cache/`
        );
      }
      return updatedSrc;
    });

    verifyProjectSources(cloned);
    writeProjectJsonAtomic(destPaths, cloned);
    res.status(201).json({ project: cloned });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// API: Media Ingestion, Verification & Relinking
// ---------------------------------------------------------------------------

const dropUploadStorage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const pathsObj = getProjectPaths(req.params.id);
    if (!pathsObj || !fs.existsSync(pathsObj.jsonFile)) {
      return cb(new Error('Project not found'));
    }
    ensureProjectDirs(pathsObj);
    cb(null, pathsObj.sourcesDir);
  },
  filename: (req, file, cb) => {
    const pathsObj = getProjectPaths(req.params.id);
    const targetPath = getUniqueDestPath(pathsObj.sourcesDir, file.originalname);
    cb(null, path.basename(targetPath));
  },
});

const uploadMiddleware = multer({ storage: dropUploadStorage });

app.post('/api/projects/:id/sources/upload', uploadMiddleware.array('files'), async (req, res) => {
  const pathsObj = getProjectPaths(req.params.id);
  const uploadedFiles = req.files || [];

  const cleanupUploaded = () => {
    for (const f of uploadedFiles) {
      try {
        if (f.path && fs.existsSync(f.path)) fs.unlinkSync(f.path);
      } catch {
        // Ignore cleanup errors
      }
    }
  };

  if (!pathsObj) {
    cleanupUploaded();
    return res.status(400).json({ error: 'Invalid project id' });
  }

  if (uploadedFiles.length === 0) {
    return res.status(400).json({ error: 'No files uploaded' });
  }

  if (uploadedFiles.length > MAX_IMPORT_BATCH) {
    cleanupUploaded();
    return res.status(400).json({
      error: `Import limit exceeded: maximum ${MAX_IMPORT_BATCH} clips can be imported at once.`,
    });
  }

  try {
    const project = readProjectJson(pathsObj);
    if (!project) {
      cleanupUploaded();
      return res.status(404).json({ error: 'Project not found' });
    }

    const added = [];
    const skipped = [];
    const errors = [];
    const existingNames = new Set(
      (project.sources || []).map((s) => String(s.name || '').toLowerCase())
    );
    const activeSourcePaths = new Set(
      (project.sources || [])
        .filter((s) => s.path)
        .map((s) => path.resolve(String(s.path)))
    );

    for (const file of uploadedFiles) {
      const originalLower = String(file.originalname || '').toLowerCase();
      if (existingNames.has(originalLower)) {
        if (
          file.path &&
          fs.existsSync(file.path) &&
          !activeSourcePaths.has(path.resolve(file.path))
        ) {
          fs.unlinkSync(file.path);
        }
        skipped.push(file.originalname);
        continue;
      }
      if (!hasAllowedExtension(file.originalname)) {
        if (
          file.path &&
          fs.existsSync(file.path) &&
          !activeSourcePaths.has(path.resolve(file.path))
        ) {
          fs.unlinkSync(file.path);
        }
        errors.push(`Unsupported extension: ${file.originalname}`);
        continue;
      }
      try {
        const sourceObj = await inspectAndCacheSource(
          pathsObj,
          pathsObj.id,
          file.path,
          file.originalname,
          'copied'
        );
        project.sources.push(sourceObj);
        added.push(sourceObj);
        existingNames.add(originalLower);
        if (sourceObj.path) activeSourcePaths.add(path.resolve(String(sourceObj.path)));
      } catch (err) {
        if (
          file.path &&
          fs.existsSync(file.path) &&
          !activeSourcePaths.has(path.resolve(file.path))
        ) {
          fs.unlinkSync(file.path);
        }
        errors.push(`Failed to inspect ${file.originalname}: ${err.message}`);
      }
    }

    project.updatedAt = new Date().toISOString();
    writeProjectJsonAtomic(pathsObj, project);
    res.json({ added, skipped, errors, sources: project.sources });
  } catch (err) {
    cleanupUploaded();
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/projects/:id/sources/link', async (req, res) => {
  const pathsObj = getProjectPaths(req.params.id);
  if (!pathsObj) return res.status(400).json({ error: 'Invalid project id' });

  const filePaths = Array.isArray(req.body?.paths) ? req.body.paths : [];
  if (filePaths.length === 0) {
    return res.status(400).json({ error: 'No files selected' });
  }
  if (filePaths.length > MAX_IMPORT_BATCH) {
    return res.status(400).json({
      error: `Import limit exceeded: maximum ${MAX_IMPORT_BATCH} clips can be imported at once.`,
    });
  }

  try {
    const project = readProjectJson(pathsObj);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const added = [];
    const skipped = [];
    const errors = [];
    const existingNames = new Set(
      (project.sources || []).map((s) => String(s.name || '').toLowerCase())
    );

    for (const rawPath of filePaths) {
      const resolved = path.resolve(String(rawPath));
      const baseName = path.basename(resolved);
      const lowerName = baseName.toLowerCase();
      if (existingNames.has(lowerName)) {
        skipped.push(baseName);
        continue;
      }
      if (!hasAllowedExtension(resolved)) {
        errors.push(`Unsupported file type: ${baseName}`);
        continue;
      }
      if (!fs.existsSync(resolved)) {
        errors.push(`File not found: ${resolved}`);
        continue;
      }
      try {
        const sourceObj = await inspectAndCacheSource(
          pathsObj,
          pathsObj.id,
          resolved,
          baseName,
          'linked'
        );
        project.sources.push(sourceObj);
        added.push(sourceObj);
        existingNames.add(lowerName);
      } catch (err) {
        errors.push(`Failed to inspect ${baseName}: ${err.message}`);
      }
    }

    project.updatedAt = new Date().toISOString();
    writeProjectJsonAtomic(pathsObj, project);
    res.json({ added, skipped, errors, sources: project.sources });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/projects/:id/verify-sources', (req, res) => {
  const pathsObj = getProjectPaths(req.params.id);
  if (!pathsObj) return res.status(400).json({ error: 'Invalid project id' });
  try {
    const project = readProjectJson(pathsObj);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    verifyProjectSources(project);
    res.json({ sources: project.sources });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/projects/:id/sources/:sourceId/relink', async (req, res) => {
  const pathsObj = getProjectPaths(req.params.id);
  if (!pathsObj) return res.status(400).json({ error: 'Invalid project id' });

  const newPathRaw = (req.body?.newPath || '').trim();
  if (!newPathRaw) return res.status(400).json({ error: 'newPath is required' });
  const newPath = path.resolve(newPathRaw);

  if (!fs.existsSync(newPath) || !fs.statSync(newPath).isFile()) {
    return res.status(404).json({ error: 'Target file does not exist' });
  }
  if (!hasAllowedExtension(newPath)) {
    return res.status(400).json({ error: 'Unsupported media file extension' });
  }

  try {
    const project = readProjectJson(pathsObj);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const idx = (project.sources || []).findIndex((s) => s.id === req.params.sourceId);
    if (idx === -1) return res.status(404).json({ error: 'Source not found in project' });

    const existing = project.sources[idx];
    const updatedSource = await inspectAndCacheSource(
      pathsObj,
      pathsObj.id,
      newPath,
      path.basename(newPath),
      existing.storageType === 'copied' ? 'linked' : (existing.storageType || 'linked'),
      existing.id
    );
    project.sources[idx] = updatedSource;
    project.updatedAt = new Date().toISOString();
    writeProjectJsonAtomic(pathsObj, project);
    res.json({ source: updatedSource, sources: project.sources });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/projects/:id/media/:filename', (req, res) => {
  const pathsObj = getProjectPaths(req.params.id);
  if (!pathsObj) return res.status(400).json({ error: 'Invalid project id' });

  try {
    const project = readProjectJson(pathsObj);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const requestedName = path.basename(decodeURIComponent(String(req.params.filename || '')));
    const requestedSourceId = req.query.sourceId ? String(req.query.sourceId) : null;
    if (!requestedName && !requestedSourceId) {
      return res.status(400).json({ error: 'Filename is required' });
    }

    const sourcesList = Array.isArray(project.sources) ? project.sources : [];
    const targetLower = requestedName.toLowerCase();
    let idx = -1;
    if (requestedSourceId) {
      idx = sourcesList.findIndex((s) => s.id === requestedSourceId);
    }
    if (idx === -1 && targetLower) {
      idx = sourcesList.findIndex(
        (s) => String(s.name || '').toLowerCase() === targetLower
      );
    }
    if (idx === -1) {
      return res.status(404).json({ error: `Media file not found: ${requestedName}` });
    }

    const targetSource = sourcesList[idx];

    // Re-verify across all tracks that this source is not referenced on the timeline
    const usedIds = new Set();
    const tracks = project.tracks || {};
    for (const tk of ['track1', 'track2', 'track3']) {
      const clips = Array.isArray(tracks[tk]) ? tracks[tk] : [];
      for (const clip of clips) {
        if (clip && clip.sourceId) usedIds.add(clip.sourceId);
      }
    }
    if (usedIds.has(targetSource.id)) {
      return res.status(409).json({
        error: 'Delete clips from timeline before deleting source file.',
      });
    }

    // Physically delete media file inside project directories (and cache artifacts)
    const projectRootResolved = path.resolve(pathsObj.root);
    const candidateFiles = new Set();
    if (targetSource.path) {
      const resolvedSrc = path.resolve(String(targetSource.path));
      if (
        resolvedSrc.startsWith(projectRootResolved + path.sep) ||
        targetSource.origin === 'copied'
      ) {
        // Safety guard: never delete external original files if origin is 'linked'
        if (resolvedSrc.startsWith(projectRootResolved + path.sep)) {
          candidateFiles.add(resolvedSrc);
        }
      }
    }
    if (targetSource.name) {
      candidateFiles.add(path.join(pathsObj.sourcesDir, path.basename(targetSource.name)));
      candidateFiles.add(path.join(pathsObj.root, 'media', path.basename(targetSource.name)));
    }
    if (targetSource.path && targetSource.origin === 'copied') {
      candidateFiles.add(path.join(pathsObj.sourcesDir, path.basename(String(targetSource.path))));
    }

    // Only unlink files that aren't still pointed to by another source entry
    const otherPaths = new Set(
      sourcesList
        .filter((s, sIdx) => sIdx !== idx && s.path)
        .map((s) => path.resolve(String(s.path)))
    );

    for (const fileToDelete of candidateFiles) {
      const resolvedDel = path.resolve(fileToDelete);
      if (
        resolvedDel.startsWith(projectRootResolved + path.sep) &&
        !otherPaths.has(resolvedDel) &&
        fs.existsSync(resolvedDel)
      ) {
        try {
          fs.unlinkSync(resolvedDel);
        } catch {
          // Ignore individual unlink failures if already removed
        }
      }
    }

    // Delete cache thumbnails / waveform peaks for this source
    if (fs.existsSync(pathsObj.cacheDir)) {
      try {
        const cacheEntries = fs.readdirSync(pathsObj.cacheDir);
        for (const entry of cacheEntries) {
          if (entry.startsWith(targetSource.id)) {
            const cacheFile = path.join(pathsObj.cacheDir, entry);
            if (fs.existsSync(cacheFile)) fs.unlinkSync(cacheFile);
          }
        }
      } catch {
        // Ignore cache cleanup errors
      }
    }

    project.sources.splice(idx, 1);
    project.updatedAt = new Date().toISOString();
    writeProjectJsonAtomic(pathsObj, project);
    res.json({ ok: true, deletedId: targetSource.id, sources: project.sources });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// API: HTTP 206 Byte-Range Media Streaming & Cache Assets
// ---------------------------------------------------------------------------

app.get('/api/projects/:id/stream/:sourceId', (req, res) => {
  const pathsObj = getProjectPaths(req.params.id);
  if (!pathsObj) return res.status(400).send('Invalid project id');

  try {
    const project = readProjectJson(pathsObj);
    if (!project) return res.status(404).send('Project not found');
    const source = (project.sources || []).find((s) => s.id === req.params.sourceId);
    if (!source || !source.path || !fs.existsSync(source.path)) {
      return res.status(404).send('Media source missing on disk');
    }

    const stat = fs.statSync(source.path);
    const totalSize = stat.size;
    const contentType = getMimeTypeForExt(path.extname(source.path));
    const range = req.headers.range;

    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'no-store');

    if (range) {
      const match = /bytes=(\d*)-(\d*)/.exec(range);
      if (!match) {
        return res.status(416).setHeader('Content-Range', `bytes */${totalSize}`).end();
      }
      let start = match[1] ? Number.parseInt(match[1], 10) : 0;
      let end = match[2] ? Number.parseInt(match[2], 10) : totalSize - 1;

      if (!match[1] && match[2]) {
        start = Math.max(0, totalSize - Number.parseInt(match[2], 10));
        end = totalSize - 1;
      }

      if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= totalSize) {
        return res.status(416).setHeader('Content-Range', `bytes */${totalSize}`).end();
      }

      end = Math.min(end, totalSize - 1);
      const chunkSize = end - start + 1;

      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${totalSize}`);
      res.setHeader('Content-Length', chunkSize);
      fs.createReadStream(source.path, { start, end }).pipe(res);
    } else {
      res.status(200);
      res.setHeader('Content-Length', totalSize);
      fs.createReadStream(source.path).pipe(res);
    }
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.get('/api/projects/:id/cache/:filename', (req, res) => {
  const pathsObj = getProjectPaths(req.params.id);
  if (!pathsObj) return res.status(400).send('Invalid project id');
  const safeName = path.basename(req.params.filename);
  const filePath = path.join(pathsObj.cacheDir, safeName);
  if (!fs.existsSync(filePath)) return res.status(404).send('Cached asset not found');
  res.sendFile(filePath);
});

// ---------------------------------------------------------------------------
// API: Single-Pass Deduplicated FFmpeg Export Engine
// ---------------------------------------------------------------------------

const exportJobs = new Map();

function buildAtempoChain(speed) {
  const filters = [];
  let remaining = speed;
  while (remaining > 2.0 + 1e-6) {
    filters.push('atempo=2.0');
    remaining /= 2.0;
  }
  while (remaining < 0.5 - 1e-6) {
    filters.push('atempo=0.5');
    remaining /= 0.5;
  }
  if (Math.abs(remaining - 1.0) > 1e-4) {
    filters.push(`atempo=${remaining.toFixed(6)}`);
  }
  return filters.join(',');
}

function parseFfmpegTimeToSeconds(line) {
  const match = /time=(\d{2}):(\d{2}):(\d{2}\.\d+)/.exec(line);
  if (!match) return null;
  const hours = Number(match[1]);
  const mins = Number(match[2]);
  const secs = Number(match[3]);
  return hours * 3600 + mins * 60 + secs;
}

function buildExportPipeline(project, pathsObj, options) {
  const RES_MAP = {
    '1920x1080': { w: 1920, h: 1080, tag: '1080p' },
    '1280x720': { w: 1280, h: 720, tag: '720p' },
    '3840x2160': { w: 3840, h: 2160, tag: '4k' },
  };
  const resSpec = RES_MAP[String(options.resolution || '1920x1080')] || RES_MAP['1920x1080'];
  const outW = resSpec.w;
  const outH = resSpec.h;

  const track1 = Array.isArray(project.tracks?.track1) ? project.tracks.track1 : [];
  const track2 = Array.isArray(project.tracks?.track2) ? project.tracks.track2 : [];
  const track3 = Array.isArray(project.tracks?.track3) ? project.tracks.track3 : [];

  if (track1.length === 0) {
    throw new Error('Track 1 must contain at least one video clip to export.');
  }

  const sourceMap = new Map((project.sources || []).map((s) => [s.id, s]));

  // Compute exact Track 1 clip offsets, adjacent transitions, and total frame count
  const { clips: layoutClips, junctionTransitions, totalFrames: totalTrack1Frames } =
    resolveTrack1LayoutAndTransitions(track1, project.transitions || []);

  const t1Resolved = layoutClips.map((clip) => {
    const source = sourceMap.get(clip.sourceId);
    if (!source) throw new Error(`Missing source metadata for Track 1 clip (${clip.sourceId})`);
    if (!source.path || !fs.existsSync(source.path)) {
      throw new Error(`Missing source file on disk: ${source.name}`);
    }
    return {
      ...clip,
      source,
    };
  });

  const totalVideoSeconds = totalTrack1Frames / FPS;

  // Collect active audio segments from Track 1 (if embedded audio exists) and Tracks 2 & 3
  const audioJobs = [];

  for (const clip of t1Resolved) {
    const vol = clip.volume !== undefined ? Number(clip.volume) : 1;
    if (clip.source.hasAudio && vol > 0.0001) {
      audioJobs.push({
        clip,
        source: clip.source,
        speed: clip.speed,
        reversed: Boolean(clip.reversed),
        inFrame: clip.inFrame,
        outFrame: clip.outFrame,
        timelineStartFrame: clip.timelineStartFrame,
        volume: vol,
        fadeInSec: Math.max(0, Number(clip.fadeInSec) || 0),
        fadeOutSec: Math.max(0, Number(clip.fadeOutSec) || 0),
      });
    }
  }

  for (const trackList of [track2, track3]) {
    for (const clip of trackList) {
      const startFrame = Math.max(0, Math.round(clip.timelineStartFrame || 0));
      if (startFrame >= totalTrack1Frames) continue;
      const source = sourceMap.get(clip.sourceId);
      if (!source) throw new Error(`Missing source metadata for audio clip (${clip.sourceId})`);
      if (!source.path || !fs.existsSync(source.path)) {
        throw new Error(`Missing audio source file on disk: ${source.name}`);
      }
      if (!source.hasAudio) continue;
      const vol = clip.volume !== undefined ? Number(clip.volume) : 1;
      if (vol <= 0.0001) continue;
      const inFrame = Math.max(0, Math.round(clip.inFrame || 0));
      const outFrame = Math.max(inFrame + 1, Math.round(clip.outFrame || inFrame + 1));
      audioJobs.push({
        clip,
        source,
        speed: 1,
        reversed: false,
        inFrame,
        outFrame,
        timelineStartFrame: startFrame,
        volume: vol,
        fadeInSec: Math.max(0, Number(clip.fadeInSec) || 0),
        fadeOutSec: Math.max(0, Number(clip.fadeOutSec) || 0),
      });
    }
  }

  // Deduplicate -i inputs across all used sources
  const uniqueSources = [];
  const inputIndexBySourceId = new Map();
  const ensureInput = (source) => {
    if (!inputIndexBySourceId.has(source.id)) {
      inputIndexBySourceId.set(source.id, uniqueSources.length);
      uniqueSources.push(source);
    }
    return inputIndexBySourceId.get(source.id);
  };

  const videoUseCount = new Map();
  const audioUseCount = new Map();

  for (const item of t1Resolved) {
    const idx = ensureInput(item.source);
    videoUseCount.set(idx, (videoUseCount.get(idx) || 0) + 1);
  }
  for (const aj of audioJobs) {
    const idx = ensureInput(aj.source);
    audioUseCount.set(idx, (audioUseCount.get(idx) || 0) + 1);
  }

  const filterLines = [];
  const videoPadCursor = new Map();
  const audioPadCursor = new Map();

  for (const [idx, count] of videoUseCount.entries()) {
    if (count > 1) {
      const outs = Array.from({ length: count }, (_, k) => `[vin_${idx}_${k}]`).join('');
      filterLines.push(`[${idx}:v]split=${count}${outs}`);
      videoPadCursor.set(idx, 0);
    }
  }
  for (const [idx, count] of audioUseCount.entries()) {
    if (count > 1) {
      const outs = Array.from({ length: count }, (_, k) => `[ain_${idx}_${k}]`).join('');
      filterLines.push(`[${idx}:a]asplit=${count}${outs}`);
      audioPadCursor.set(idx, 0);
    }
  }

  const nextVideoPad = (idx) => {
    if ((videoUseCount.get(idx) || 0) > 1) {
      const k = videoPadCursor.get(idx);
      videoPadCursor.set(idx, k + 1);
      return `[vin_${idx}_${k}]`;
    }
    return `[${idx}:v]`;
  };

  const nextAudioPad = (idx) => {
    if ((audioUseCount.get(idx) || 0) > 1) {
      const k = audioPadCursor.get(idx);
      audioPadCursor.set(idx, k + 1);
      return `[ain_${idx}_${k}]`;
    }
    return `[${idx}:a]`;
  };

  // Track 1 canonical video normalization & junction transitions graph
  t1Resolved.forEach((clip, i) => {
    const idx = inputIndexBySourceId.get(clip.source.id);
    const inPad = nextVideoPad(idx);
    const parts = [
      `fps=${FPS}`,
      `trim=start_frame=${clip.inFrame}:end_frame=${clip.outFrame}`,
      'setpts=PTS-STARTPTS',
    ];
    if (clip.reversed) {
      parts.push('reverse', 'setpts=PTS-STARTPTS');
    }
    if (Math.abs(clip.speed - 1) > 1e-4) {
      parts.push(`setpts=${(1 / clip.speed).toFixed(6)}*PTS`);
    }
    if (clip.mirrored) {
      parts.push('hflip');
    }
    const exposure = clampColorGrade(clip.exposure);
    const saturation = clampColorGrade(clip.saturation);
    const contrast = clampColorGrade(clip.contrast);
    if (exposure !== 0) {
      const expFactor = (1 + exposure / 100).toFixed(3);
      parts.push(
        'format=yuv420p',
        `lutyuv=y='clip(16+(val-16)*${expFactor},16,235)'`
      );
    }
    if (contrast !== 0 || saturation !== 0) {
      const conFactor = (1 + contrast / 100).toFixed(3);
      const satFactor = (1 + saturation / 100).toFixed(3);
      parts.push(`eq=contrast=${conFactor}:saturation=${satFactor}`);
    }
    const tailPad = clip.speed < 1 ? Math.ceil(1 / clip.speed) + 1 : 1;
    parts.push(
      `fps=${FPS}`,
      `scale=${outW}:${outH}:flags=lanczos:force_original_aspect_ratio=decrease`,
      `pad=${outW}:${outH}:(ow-iw)/2:(oh-ih)/2:black`,
      'setsar=1',
      'format=yuv420p',
      `tpad=stop_mode=clone:stop=${tailPad}`,
      `trim=start_frame=0:end_frame=${clip.durationFrames}`,
      'setpts=PTS-STARTPTS'
    );

    const hasLeft = clip.leftTransitionFrames > 0;
    const hasRight = clip.rightTransitionFrames > 0;
    const sliceCount = (hasLeft ? 1 : 0) + 1 + (hasRight ? 1 : 0);

    if (sliceCount === 1) {
      filterLines.push(`${inPad}${parts.join(',')}[v_body_${i}]`);
      return;
    }

    const normPad = `[v_norm_${i}]`;
    filterLines.push(`${inPad}${parts.join(',')}${normPad}`);

    const splitPads = [];
    if (hasLeft) splitPads.push(`[vsp_l_${i}]`);
    splitPads.push(`[vsp_b_${i}]`);
    if (hasRight) splitPads.push(`[vsp_r_${i}]`);
    filterLines.push(`${normPad}split=${sliceCount}${splitPads.join('')}`);

    const leftEnd = clip.leftTransitionFrames;
    const rightStart = clip.durationFrames - clip.rightTransitionFrames;

    if (hasLeft) {
      const inTrans = junctionTransitions[i - 1];
      if (inTrans && (inTrans.type === 'fade_black' || inTrans.type === 'fade_white')) {
        const fadeColor = inTrans.type === 'fade_white' ? 'white' : 'black';
        const ramp = leftEnd;
        filterLines.push(
          `[vsp_l_${i}]trim=start_frame=0:end_frame=${ramp},setpts=PTS-STARTPTS,` +
          `tpad=start=1:start_mode=clone,fade=t=in:start_frame=0:nb_frames=${ramp + 1}:color=${fadeColor},` +
          `trim=start_frame=1:end_frame=${ramp + 1},setpts=PTS-STARTPTS[v_left_${i}]`
        );
      } else {
        filterLines.push(`[vsp_l_${i}]trim=start_frame=0:end_frame=${leftEnd},setpts=PTS-STARTPTS[v_left_${i}]`);
      }
    }

    filterLines.push(
      `[vsp_b_${i}]trim=start_frame=${leftEnd}:end_frame=${rightStart},setpts=PTS-STARTPTS[v_body_${i}]`
    );

    if (hasRight) {
      const outTrans = junctionTransitions[i];
      if (outTrans && (outTrans.type === 'fade_black' || outTrans.type === 'fade_white')) {
        const fadeColor = outTrans.type === 'fade_white' ? 'white' : 'black';
        const ramp = clip.rightTransitionFrames;
        filterLines.push(
          `[vsp_r_${i}]trim=start_frame=${rightStart}:end_frame=${clip.durationFrames},setpts=PTS-STARTPTS,` +
          `tpad=start=1:start_mode=clone,fade=t=out:start_frame=0:nb_frames=${ramp + 1}:color=${fadeColor},` +
          `trim=start_frame=1:end_frame=${ramp + 1},setpts=PTS-STARTPTS[v_right_${i}]`
        );
      } else {
        filterLines.push(
          `[vsp_r_${i}]trim=start_frame=${rightStart}:end_frame=${clip.durationFrames},setpts=PTS-STARTPTS[v_right_${i}]`
        );
      }
    }
  });

  // Assemble ordered video segments across clips and junctions
  const vConcatPads = [];
  for (let i = 0; i < t1Resolved.length; i += 1) {
    if (i > 0) {
      const prevTrans = junctionTransitions[i - 1];
      if (prevTrans && (prevTrans.type === 'fade_black' || prevTrans.type === 'fade_white')) {
        vConcatPads.push(`[v_left_${i}]`);
      }
    }
    vConcatPads.push(`[v_body_${i}]`);
    if (i < t1Resolved.length - 1) {
      const nextTrans = junctionTransitions[i];
      if (nextTrans && nextTrans.type === 'transform') {
        filterLines.push(
          `[v_right_${i}][v_left_${i + 1}]blend=all_expr='(A+B)/2',setpts=PTS-STARTPTS[vtrans_${i}]`
        );
        vConcatPads.push(`[vtrans_${i}]`);
      } else if (nextTrans && (nextTrans.type === 'fade_black' || nextTrans.type === 'fade_white')) {
        const fadeColor = nextTrans.type === 'fade_white' ? 'white' : 'black';
        filterLines.push(
          `color=c=${fadeColor}:s=${outW}x${outH}:r=${FPS}:d=0.1,trim=start_frame=0:end_frame=1,setpts=PTS-STARTPTS,setsar=1,format=yuv420p[vcenter_${i}]`
        );
        vConcatPads.push(`[v_right_${i}]`, `[vcenter_${i}]`);
      }
    }
  }

  if (vConcatPads.length === 1) {
    filterLines.push(`${vConcatPads[0]}null[vout]`);
  } else {
    filterLines.push(`${vConcatPads.join('')}concat=n=${vConcatPads.length}:v=1:a=0[vout]`);
  }

  // Audio filter chains (48kHz stereo, exact sample trim, fades, adelay, amix + alimiter)
  const aSegPads = [];
  audioJobs.forEach((aj, j) => {
    const idx = inputIndexBySourceId.get(aj.source.id);
    const inPad = nextAudioPad(idx);
    const outPad = `[aseg_${j}]`;

    const startSample = Math.round((aj.inFrame / FPS) * SAMPLE_RATE);
    const endSample = Math.max(startSample + 1, Math.round((aj.outFrame / FPS) * SAMPLE_RATE));
    const clipDurSec = (aj.outFrame - aj.inFrame) / (FPS * aj.speed);

    const fadeIn = Math.min(aj.fadeInSec, clipDurSec);
    const fadeOut = Math.min(aj.fadeOutSec, Math.max(0, clipDurSec - fadeIn));
    const delayMs = Math.max(0, Math.round((aj.timelineStartFrame / FPS) * 1000));

    const parts = [
      `aresample=${SAMPLE_RATE}`,
      'aformat=sample_fmts=fltp:channel_layouts=stereo',
      `atrim=start_sample=${startSample}:end_sample=${endSample}`,
      'asetpts=PTS-STARTPTS',
    ];
    if (aj.reversed) {
      parts.push('areverse', 'asetpts=PTS-STARTPTS');
    }
    if (Math.abs(aj.speed - 1) > 1e-4) {
      const atempoChain = buildAtempoChain(aj.speed);
      if (atempoChain) parts.push(atempoChain);
    }
    if (Math.abs(aj.volume - 1) > 1e-4) {
      parts.push(`volume=${aj.volume.toFixed(3)}`);
    }
    if (fadeIn > 0.001) {
      parts.push(`afade=t=in:st=0:d=${fadeIn.toFixed(3)}`);
    }
    if (fadeOut > 0.001) {
      const fadeOutStart = Math.max(0, clipDurSec - fadeOut);
      parts.push(`afade=t=out:st=${fadeOutStart.toFixed(3)}:d=${fadeOut.toFixed(3)}`);
    }
    if (delayMs > 0) {
      parts.push(`adelay=${delayMs}|${delayMs}`);
    }
    filterLines.push(`${inPad}${parts.join(',')}${outPad}`);
    aSegPads.push(outPad);
  });

  if (aSegPads.length > 1) {
    filterLines.push(
      `${aSegPads.join('')}amix=inputs=${aSegPads.length}:duration=longest:dropout_transition=0:normalize=0,alimiter=limit=0.98:level=disabled,atrim=0:${totalVideoSeconds.toFixed(6)},asetpts=PTS-STARTPTS[aout]`
    );
  } else if (aSegPads.length === 1) {
    filterLines.push(
      `${aSegPads[0]}alimiter=limit=0.98:level=disabled,atrim=0:${totalVideoSeconds.toFixed(6)},asetpts=PTS-STARTPTS[aout]`
    );
  }

  const codec = options.codec === 'h265' ? 'h265' : 'h264';
  const encoderMode = options.encoderMode === 'software' ? 'software' : 'hardware';
  const useVt =
    encoderMode === 'hardware' &&
    (codec === 'h265' ? hwSupport.hevc_videotoolbox : hwSupport.h264_videotoolbox);

  let rateArgs = [];
  if (options.rateControlMode === 'bitrate') {
    const mbps = Math.max(2, Math.min(80, Number(options.bitrateMbps) || 15));
    const maxRate = Number((mbps * 1.5).toFixed(2));
    const bufSize = Number((mbps * 2).toFixed(2));
    rateArgs = ['-b:v', `${mbps}M`, '-maxrate', `${maxRate}M`, '-bufsize', `${bufSize}M`];
  } else if (options.rateControlMode === 'crf') {
    const crfVal = Math.max(14, Math.min(32, Math.round(Number(options.crf) || 18)));
    const vtQ = Math.max(1, Math.min(100, Math.round(100 - crfVal * 1.8)));
    rateArgs = useVt ? ['-q:v', String(vtQ)] : ['-crf', String(crfVal)];
  } else {
    const quality = ['super', 'high', 'medium', 'low'].includes(options.quality) ? options.quality : 'high';
    const vtQualityMap = { super: '90', high: '85', medium: '75', low: '65' };
    const swCrfMap = { super: '11', high: '14', medium: '18', low: '23' };
    rateArgs = useVt ? ['-q:v', vtQualityMap[quality]] : ['-crf', swCrfMap[quality]];
  }

  let videoCodecArgs = [];
  if (codec === 'h265') {
    if (useVt) {
      videoCodecArgs = ['-c:v', 'hevc_videotoolbox', '-allow_sw', '1', ...rateArgs, '-tag:v', 'hvc1'];
    } else {
      videoCodecArgs = ['-c:v', 'libx265', '-preset', 'medium', ...rateArgs, '-tag:v', 'hvc1'];
    }
  } else if (useVt) {
    videoCodecArgs = ['-c:v', 'h264_videotoolbox', '-allow_sw', '1', ...rateArgs];
  } else {
    videoCodecArgs = [
      '-c:v',
      'libx264',
      '-preset',
      'medium',
      ...rateArgs,
      '-profile:v',
      'high',
      '-level',
      outW > 1920 ? '5.1' : '4.1',
    ];
  }

  const allowedAudioBitrates = new Set(['128k', '192k', '256k', '320k']);
  const normAudioBr = String(options.audioBitrate || '192k').toLowerCase().replace(/\s*kbps$/i, 'k');
  const audioBitrate = allowedAudioBitrates.has(normAudioBr) ? normAudioBr : '192k';

  const safeBaseName = (options.filename || project.name || 'export')
    .replace(/\.mp4$/i, '')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .trim() || 'export';
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outFilename = `${safeBaseName}_${timestamp}.mp4`;
  const outPath = path.join(pathsObj.exportsDir, outFilename);

  const filterComplex = filterLines.join(';');
  const ffmpegArgs = ['-y', '-hide_banner'];
  for (const src of uniqueSources) {
    ffmpegArgs.push('-i', src.path);
  }

  let filterScriptPath = null;
  if (filterComplex.length > 24000) {
    filterScriptPath = path.join(pathsObj.exportsDir, `.filter_${Date.now()}.txt`);
    fs.writeFileSync(filterScriptPath, filterComplex, 'utf8');
    ffmpegArgs.push('-filter_complex_script', filterScriptPath);
  } else {
    ffmpegArgs.push('-filter_complex', filterComplex);
  }

  ffmpegArgs.push('-map', '[vout]');
  if (aSegPads.length > 0) {
    ffmpegArgs.push('-map', '[aout]', '-c:a', 'aac', '-ar', String(SAMPLE_RATE), '-ac', '2', '-b:a', audioBitrate);
  } else {
    ffmpegArgs.push('-an');
  }

  ffmpegArgs.push(
    ...videoCodecArgs,
    '-pix_fmt', 'yuv420p',
    '-r', String(FPS),
    '-t', totalVideoSeconds.toFixed(6),
    '-movflags', '+faststart',
    outPath
  );

  return {
    ffmpegArgs,
    outFilename,
    outPath,
    totalVideoSeconds,
    filterScriptPath,
    encoderUsed: videoCodecArgs[1],
  };
}

app.post('/api/projects/:id/export', (req, res) => {
  if (!ffmpegPath) {
    return res.status(400).json({ error: 'FFmpeg not found. Install via: brew install ffmpeg' });
  }
  const pathsObj = getProjectPaths(req.params.id);
  if (!pathsObj) return res.status(400).json({ error: 'Invalid project id' });

  try {
    const project = readProjectJson(pathsObj);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    ensureProjectDirs(pathsObj);

    const plan = buildExportPipeline(project, pathsObj, req.body || {});
    const jobId = `exp_${crypto.randomBytes(6).toString('hex')}`;
    const job = {
      id: jobId,
      projectId: pathsObj.id,
      status: 'running',
      percent: 0,
      filename: plan.outFilename,
      outPath: plan.outPath,
      encoderUsed: plan.encoderUsed,
      totalSeconds: plan.totalVideoSeconds,
      error: null,
      logs: [],
      startedAt: new Date().toISOString(),
    };
    exportJobs.set(jobId, job);

    const child = spawn(ffmpegPath, plan.ffmpegArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderrTail = '';

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stderrTail = (stderrTail + text).slice(-6000);
      const lines = text.split(/\r?\n|\r/);
      for (const line of lines) {
        const t = parseFfmpegTimeToSeconds(line);
        if (t !== null && plan.totalVideoSeconds > 0) {
          job.percent = Math.min(99, Math.max(job.percent, Math.round((t / plan.totalVideoSeconds) * 100)));
        }
      }
    });

    child.on('error', (err) => {
      if (plan.filterScriptPath && fs.existsSync(plan.filterScriptPath)) {
        try { fs.unlinkSync(plan.filterScriptPath); } catch {}
      }
      job.status = 'failed';
      job.error = err.message;
    });

    child.on('close', (code) => {
      if (plan.filterScriptPath && fs.existsSync(plan.filterScriptPath)) {
        try { fs.unlinkSync(plan.filterScriptPath); } catch {}
      }
      if (code === 0 && fs.existsSync(plan.outPath)) {
        job.status = 'completed';
        job.percent = 100;
        job.completedAt = new Date().toISOString();
      } else {
        job.status = 'failed';
        job.error = stderrTail.trim().split(/\r?\n/).slice(-6).join('\n') || `FFmpeg exited with code ${code}`;
      }
    });

    res.status(202).json({ job });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/projects/:id/exports/:jobId', (req, res) => {
  const job = exportJobs.get(req.params.jobId);
  if (!job || job.projectId !== req.params.id) {
    return res.status(404).json({ error: 'Export job not found' });
  }
  res.json({ job });
});

app.get('/api/projects/:id/exports/file/:filename', (req, res) => {
  const pathsObj = getProjectPaths(req.params.id);
  if (!pathsObj) return res.status(400).send('Invalid project id');
  const safeName = path.basename(req.params.filename);
  const filePath = path.join(pathsObj.exportsDir, safeName);
  if (!fs.existsSync(filePath)) return res.status(404).send('Exported file not found');
  res.download(filePath, safeName);
});

// ---------------------------------------------------------------------------
// Error Handler & Start Server
// ---------------------------------------------------------------------------

app.use((err, _req, res, _next) => {
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`gCut running at http://localhost:${PORT}`);
  console.log(`Projects workspace: ${PROJECTS_ROOT}`);
  console.log(`FFmpeg: ${ffmpegPath || 'MISSING'} | FFprobe: ${ffprobePath || 'MISSING'}`);
});
