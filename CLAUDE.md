# NEXRAD Viewer - Project Guide

## Overview
Interactive NEXRAD weather radar viewer desktop application built with Electron + Python, following ComfyUI's architecture pattern.

## Architecture

### Three-Layer Design (ComfyUI Style)
```
┌─────────────────────────────────────┐
│     Electron (Renderer Process)     │  <- HTML/CSS/JS UI with Leaflet maps
├─────────────────────────────────────┤
│     Electron (Main Process)         │  <- Node.js, spawns Python subprocess
├─────────────────────────────────────┤
│     Python (FastAPI Server)         │  <- Radar data processing, serves API
└─────────────────────────────────────┘
```

### Communication Flow
- Electron main process spawns Python server via `uv run`
- Python FastAPI serves on `http://127.0.0.1:8188`
- Renderer loads UI and communicates via HTTP/REST
- Radar images rendered as transparent PNG overlays on Leaflet map

## Project Structure
```
nexrad-viewer/
├── nexrad_viewer/              # Python backend
│   ├── server.py             # FastAPI server, radar processing
│   └── static/               # Frontend static files
│       ├── index.html        # Main UI with Leaflet
│       └── app.js            # Frontend JavaScript
├── electron/                 # Electron frontend
│   ├── src/
│   │   ├── main.ts           # Electron main process
│   │   ├── python-server.ts  # Python subprocess manager
│   │   └── preload.ts        # Preload script
│   ├── package.json
│   └── tsconfig.json
├── pyproject.toml            # Python dependencies (uv)
└── CLAUDE.md                 # This file
```

## Key Technologies
- **Electron**: Desktop shell, window management
- **Python/FastAPI**: Backend API server
- **uv**: Python package manager (fast, auto-installs deps on startup)
- **Py-ART**: NEXRAD radar data processing library
- **nexradaws**: Downloads radar data from AWS S3 (unidata-nexrad-level2 bucket)
- **Leaflet.js**: Interactive maps with OpenStreetMap tiles
- **Matplotlib**: Renders radar data to transparent PNG

## Important Implementation Details

### Radar Data Source
- Uses `nexradaws` package to fetch from AWS S3
- Bucket: `unidata-nexrad-level2` (NOT `noaa-nexrad-level2` - changed in 2023)
- Must filter out `_MDM` (metadata) files - PyART can't read them
- Cache downloaded files locally for 1 hour

### Colormap Names
- Use `NWSRef` and `NWSVel` (NOT `pyart_NWSRef` - causes errors in newer versions)

### User Preferences
Stored in platform-specific locations:
- macOS: `~/Library/Application Support/RadarViewer/`
- Windows: `%APPDATA%/RadarViewer/`
- Linux: `~/.config/radarviewer/`

### Station List
- 161 NEXRAD stations (Alaska, Hawaii, PR, Guam, Continental US)
- Data from NOAA/ClimateViewer GeoJSON

## Running the App
```bash
cd electron
npm install
npm run dev
```

## API Endpoints
- `GET /` - Main UI (serves index.html)
- `GET /api/stations` - List all 161 stations with coordinates
- `GET /api/preferences` - Get user preferences (default station)
- `POST /api/preferences/station` - Set default station
- `GET /api/radar/{station}?field=reflectivity` - Get radar image overlay with bounds
- `GET /api/radar/{station}/animation?frames=6` - Get animation frames
- `GET /api/health` - Health check

## Common Issues & Fixes
1. **Port 8000 in use**: Uses port 8188 instead
2. **Colormap errors**: Use `NWSRef` not `pyart_NWSRef`
3. **S3 access denied**: Use `nexradaws` package (handles bucket correctly)
4. **MDM files can't be read**: Filter out files with `_MDM` in filename
5. **Velocity field not found**: Some scans don't have velocity in sweep 0

## Future Enhancements
- Add more radar products (dual-pol: ZDR, KDP, CC)
- Historical data browsing
- Multiple station overlay
- Storm tracking
- Mobile/web version
