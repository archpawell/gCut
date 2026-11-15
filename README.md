# gCut — macOS Non-Destructive Video Montage Web App

A lightweight, local-first video montage web application tailored specifically for **macOS** (Apple Silicon & Intel Macs), built with Node.js/Express, Vanilla JS (Google Material 3 aesthetic), and local **FFmpeg / FFprobe** binaries.

## Prerequisites (macOS)

1. **Node.js** (v18+):
   ```bash
   brew install node
   ```
2. **FFmpeg & FFprobe**:
   ```bash
   brew install ffmpeg
   ```
   gCut automatically probes `/opt/homebrew/bin` (Apple Silicon), `/usr/local/bin` (Intel Mac), and your system `PATH`, plus probes `h264_videotoolbox` / `hevc_videotoolbox` hardware encoding on startup (with automatic fallback to `libx264` / `libx265`).

## Quick Launch

Double-click **`start.command`** in macOS Finder (or run `./start.command` in Terminal):
- Checks if `localhost:3456` is already active (opens browser immediately if running).
- Installs dependencies on first launch if `node_modules/` is missing.
- Starts `server.js` and opens `http://localhost:3456` automatically.

## Isolated Multi-Project Workspace

All projects live under `~/Documents/MontageStudio/projects/<project_id>/`:
- `project.json` — Non-destructive timeline metadata (24 fps, `inFrame`, `outFrame`, `speed`, `reversed`, `volume`, `fadeInSec`, `fadeOutSec`).
- `sources/` — Media dropped directly from Finder (duplicated projects create zero-copy APFS hardlinks).
- `cache/` — Generated thumbnails and compact 800-sample JSON waveform peaks.
- `exports/` — Final rendered MP4 deliverables (1920×1080, 24 fps, 48 kHz stereo AAC).
