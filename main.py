#!/usr/bin/env python3
"""
NEXRAD Viewer - Run locally without Electron

Usage:
    uv run python main.py
    # Then open http://localhost:8188 in browser
"""
import uvicorn

if __name__ == "__main__":
    print("Starting NEXRAD Viewer server...")
    print("Open http://localhost:8188 in your browser")
    uvicorn.run("nexrad_viewer.server:app", host="127.0.0.1", port=8188, reload=True)
