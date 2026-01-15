# NEXRAD Viewer

Interactive desktop application for viewing real-time NEXRAD weather radar data with OpenStreetMap integration.

## Features

- **Real-time radar data** from all 161 NEXRAD stations across the US
- **Interactive map** with pan/zoom using OpenStreetMap
- **Radar overlay** with adjustable opacity
- **Animation** - loop through 6 recent radar scans
- **Station markers** - click any station on the map to load its data
- **Local caching** - downloaded radar files cached for 1 hour
- **Cross-platform** - works on macOS, Windows, and Linux

## Architecture

Built following [ComfyUI's](https://github.com/comfyanonymous/ComfyUI) desktop architecture:

```
┌─────────────────────────────────────────────────────┐
│                   Electron Shell                     │
│  ┌─────────────┐  ┌────────────┐  ┌──────────────┐ │
│  │ Main Process │  │  Preload   │  │   Renderer   │ │
│  │  (Node.js)   │◄─┤  (IPC)     │─►│  (Chromium)  │ │
│  └──────┬───────┘  └────────────┘  └──────────────┘ │
│         │                                ▲           │
│         │ spawn                          │ HTTP      │
│         ▼                                │           │
│  ┌──────────────────────────────────────┴─┐         │
│  │         Python FastAPI Server          │         │
│  │     (runs as subprocess via uv)        │         │
│  └────────────────────────────────────────┘         │
└─────────────────────────────────────────────────────┘
```

- **Electron** - Desktop shell and window management
- **Python/FastAPI** - Backend server for radar data processing
- **Py-ART** - NEXRAD radar data reading and processing
- **Leaflet.js** - Interactive OpenStreetMap interface

## Requirements

- **Node.js** >= 18
- **Python** >= 3.12
- **uv** - Python package manager ([install](https://github.com/astral-sh/uv))

## Quick Start

```bash
# Clone the repository
git clone <repo-url>
cd nexrad-viewer

# Install and run
cd electron
npm install
npm run dev
```

The app will:
1. Install Python dependencies automatically via `uv sync`
2. Start the Python backend server on port 8188
3. Open the Electron window with the radar viewer

## Project Structure

```
nexrad-viewer/
├── nexrad_viewer/              # Python backend
│   ├── server.py             # FastAPI server, radar processing
│   └── static/               # Frontend static files
│       ├── index.html        # Main UI with Leaflet map
│       └── app.js            # Frontend JavaScript
├── electron/                 # Electron app
│   ├── src/
│   │   ├── main.ts           # Electron main process
│   │   ├── python-server.ts  # Python subprocess manager
│   │   └── preload.ts        # IPC security bridge
│   ├── loading.html          # Loading screen
│   ├── error.html            # Error screen
│   ├── package.json
│   └── tsconfig.json
├── pyproject.toml            # Python dependencies
├── CLAUDE.md                 # Developer guide for AI assistants
└── README.md
```

## Usage

### Controls
- **Station dropdown** - Select from 161 NEXRAD stations
- **Field selector** - Choose Reflectivity or Velocity
- **Load button** - Load current radar data
- **Animate button** - Load and loop 6 recent scans
- **Opacity slider** - Adjust radar layer transparency
- **Map** - Pan/zoom freely, click station markers to switch

### First Launch
On first launch, select your default station. This preference is saved locally.

### Reset Preferences
```bash
# macOS
rm ~/Library/Application\ Support/RadarViewer/preferences.json

# Windows
del %APPDATA%\RadarViewer\preferences.json

# Linux
rm ~/.config/radarviewer/preferences.json
```

## Development

### Run locally (without Electron)
```bash
# From project root
uv run python main.py
# Open http://localhost:8188 in browser
```

### Or run as module
```bash
uv run python -m nexrad_viewer.server
```

### Build for distribution
```bash
cd electron
npm run package
```
Output in `electron/release/`.

## Data Sources

- **Radar Data**: [NOAA NEXRAD on AWS](https://registry.opendata.aws/noaa-nexrad/) (`unidata-nexrad-level2` bucket)
- **Base Map**: [OpenStreetMap](https://www.openstreetmap.org/)
- **Station Coordinates**: [NOAA Radar Operations Center](https://www.roc.noaa.gov/)

## Technologies

- [Electron](https://www.electronjs.org/) - Desktop framework
- [FastAPI](https://fastapi.tiangolo.com/) - Python web framework
- [Py-ART](https://arm-doe.github.io/pyart/) - Python ARM Radar Toolkit
- [nexradaws](https://github.com/aarande/nexradaws) - NEXRAD AWS downloader
- [Leaflet](https://leafletjs.com/) - Interactive maps
- [uv](https://github.com/astral-sh/uv) - Fast Python package manager

## License

MIT
