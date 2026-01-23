"""FastAPI server that serves radar data visualization as transparent overlays."""

import os
import sys
import io
import json
import base64
import tempfile
from pathlib import Path
from datetime import datetime, timedelta
from typing import Optional, List

import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware
from pydantic import BaseModel

app = FastAPI(title="Radar Viewer")

# Middleware to disable caching for static files in development
class NoCacheMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        if request.url.path.startswith("/static"):
            response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
            response.headers["Pragma"] = "no-cache"
            response.headers["Expires"] = "0"
        return response

app.add_middleware(NoCacheMiddleware)

# Mount static files
STATIC_DIR = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


# User preferences
def get_app_dir() -> Path:
    """Get the app data directory."""
    if sys.platform == 'darwin':
        app_dir = Path.home() / 'Library' / 'Application Support' / 'RadarViewer'
    elif sys.platform == 'win32':
        app_dir = Path(os.environ.get('APPDATA', '')) / 'RadarViewer'
    else:
        app_dir = Path.home() / '.config' / 'radarviewer'
    app_dir.mkdir(parents=True, exist_ok=True)
    return app_dir

def get_prefs_path() -> Path:
    return get_app_dir() / 'preferences.json'

def get_cache_dir() -> Path:
    cache_dir = get_app_dir() / 'cache'
    cache_dir.mkdir(parents=True, exist_ok=True)
    return cache_dir

def get_image_cache_dir() -> Path:
    cache_dir = get_app_dir() / 'image_cache'
    cache_dir.mkdir(parents=True, exist_ok=True)
    return cache_dir

def cleanup_old_cache(max_age_hours: int = 1) -> None:
    # Clean radar file cache
    cache_dir = get_cache_dir()
    cutoff = datetime.now().timestamp() - (max_age_hours * 3600)
    for f in cache_dir.glob('*'):
        if f.is_file() and f.stat().st_mtime < cutoff:
            try:
                f.unlink()
                print(f"Cleaned up old cache: {f.name}")
            except:
                pass
    # Clean image cache
    image_cache_dir = get_image_cache_dir()
    for f in image_cache_dir.glob('*.json'):
        if f.is_file() and f.stat().st_mtime < cutoff:
            try:
                f.unlink()
                print(f"Cleaned up old image cache: {f.name}")
            except:
                pass

def get_image_cache_key(radar_file: str, field: str) -> str:
    """Generate a cache key for a radar image."""
    import hashlib
    filename = Path(radar_file).name
    key = f"{filename}_{field}"
    return hashlib.md5(key.encode()).hexdigest()

def get_cached_image(radar_file: str, field: str) -> Optional[dict]:
    """Check if a cached image exists and return it."""
    cache_key = get_image_cache_key(radar_file, field)
    cache_file = get_image_cache_dir() / f"{cache_key}.json"
    if cache_file.exists():
        try:
            data = json.loads(cache_file.read_text())
            print(f"Cache hit: {Path(radar_file).name} ({field})")
            return data
        except:
            pass
    return None

def save_cached_image(radar_file: str, field: str, data: dict) -> None:
    """Save a radar image to the cache."""
    cache_key = get_image_cache_key(radar_file, field)
    cache_file = get_image_cache_dir() / f"{cache_key}.json"
    try:
        cache_file.write_text(json.dumps(data))
        print(f"Cached image: {Path(radar_file).name} ({field})")
    except Exception as e:
        print(f"Failed to cache image: {e}")

def load_preferences() -> dict:
    prefs_path = get_prefs_path()
    if prefs_path.exists():
        try:
            return json.loads(prefs_path.read_text())
        except:
            pass
    return {}

def save_preferences(prefs: dict) -> None:
    prefs_path = get_prefs_path()
    prefs_path.write_text(json.dumps(prefs, indent=2))


class StationPreference(BaseModel):
    station: str


# Complete NEXRAD station list (~160 stations)
RADAR_STATIONS = {
    # Alaska
    "PAHG": {"name": "Anchorage/Kenai, AK", "lat": 60.7258, "lon": -151.3511},
    "PAIH": {"name": "Middleton Islands, AK", "lat": 59.4610, "lon": -146.3030},
    "PABC": {"name": "Bethel, AK", "lat": 60.7920, "lon": -161.8766},
    "PAEC": {"name": "Nome, AK", "lat": 64.5115, "lon": -165.2949},
    "PAPD": {"name": "Fairbanks, AK", "lat": 65.0351, "lon": -147.5014},
    "PACG": {"name": "Sitka, AK", "lat": 56.8528, "lon": -135.5292},
    "PAKC": {"name": "King Salmon, AK", "lat": 58.6793, "lon": -156.6295},
    # Hawaii
    "PHWA": {"name": "South Hawaii, HI", "lat": 19.0949, "lon": -155.5688},
    "PHKM": {"name": "Kohala, HI", "lat": 20.1254, "lon": -155.7780},
    "PHMO": {"name": "Molokai, HI", "lat": 21.1328, "lon": -157.1803},
    "PHKI": {"name": "South Kauai, HI", "lat": 21.8938, "lon": -159.5524},
    # Puerto Rico & Pacific
    "TJUA": {"name": "San Juan, PR", "lat": 18.1156, "lon": -66.0781},
    "PGUA": {"name": "Anderson AFB, Guam", "lat": 13.4544, "lon": 144.8083},
    # Continental US
    "KABR": {"name": "Aberdeen, SD", "lat": 45.4558, "lon": -98.4132},
    "KABX": {"name": "Albuquerque, NM", "lat": 35.1498, "lon": -106.8240},
    "KAKQ": {"name": "Norfolk-Richmond, VA", "lat": 36.9840, "lon": -77.0072},
    "KAMA": {"name": "Amarillo, TX", "lat": 35.2334, "lon": -101.7092},
    "KAMX": {"name": "Miami, FL", "lat": 25.6111, "lon": -80.4127},
    "KAPX": {"name": "Gaylord, MI", "lat": 44.9072, "lon": -84.7197},
    "KARX": {"name": "LaCrosse, WI", "lat": 43.8228, "lon": -91.1913},
    "KATX": {"name": "Seattle, WA", "lat": 48.1946, "lon": -122.4959},
    "KBBX": {"name": "Beale AFB, CA", "lat": 39.4957, "lon": -121.6315},
    "KBGM": {"name": "Binghamton, NY", "lat": 42.1997, "lon": -75.9848},
    "KBHX": {"name": "Eureka, CA", "lat": 40.4985, "lon": -124.2921},
    "KBIS": {"name": "Bismarck, ND", "lat": 46.7709, "lon": -100.7607},
    "KBIX": {"name": "Biloxi, MS", "lat": 30.4167, "lon": -88.9167},
    "KBLX": {"name": "Billings, MT", "lat": 45.8538, "lon": -108.6067},
    "KBMX": {"name": "Birmingham, AL", "lat": 33.1721, "lon": -86.7699},
    "KBOX": {"name": "Boston, MA", "lat": 41.9558, "lon": -71.1372},
    "KBRO": {"name": "Brownsville, TX", "lat": 25.9160, "lon": -97.4188},
    "KBUF": {"name": "Buffalo, NY", "lat": 42.9487, "lon": -78.7367},
    "KBYX": {"name": "Key West, FL", "lat": 24.5974, "lon": -81.7032},
    "KCAE": {"name": "Columbia, SC", "lat": 33.9487, "lon": -81.1181},
    "KCBW": {"name": "Caribou, ME", "lat": 46.0391, "lon": -67.8066},
    "KCBX": {"name": "Boise, ID", "lat": 43.4903, "lon": -116.2361},
    "KCCX": {"name": "State College, PA", "lat": 40.9233, "lon": -78.0036},
    "KCLE": {"name": "Cleveland, OH", "lat": 41.4132, "lon": -81.8597},
    "KCLX": {"name": "Charleston, SC", "lat": 32.6554, "lon": -81.0423},
    "KCRP": {"name": "Corpus Christi, TX", "lat": 27.7840, "lon": -97.5112},
    "KCRI": {"name": "Norman, OK", "lat": 35.2383, "lon": -97.4602},
    "KCXX": {"name": "Burlington, VT", "lat": 44.5110, "lon": -73.1664},
    "KCYS": {"name": "Cheyenne, WY", "lat": 41.1520, "lon": -104.8061},
    "KDAX": {"name": "Sacramento, CA", "lat": 38.5011, "lon": -121.6780},
    "KDDC": {"name": "Dodge City, KS", "lat": 37.7608, "lon": -99.9688},
    "KDFX": {"name": "Laughlin AFB, TX", "lat": 29.2731, "lon": -100.2803},
    "KDGX": {"name": "Brandon, MS", "lat": 32.2798, "lon": -89.9845},
    "KDIX": {"name": "Philadelphia, PA", "lat": 39.9470, "lon": -74.4107},
    "KDLH": {"name": "Duluth, MN", "lat": 46.8369, "lon": -92.2096},
    "KDMX": {"name": "Des Moines, IA", "lat": 41.7312, "lon": -93.7227},
    "KDOX": {"name": "Dover AFB, DE", "lat": 38.8258, "lon": -75.4402},
    "KDTX": {"name": "Detroit, MI", "lat": 42.7000, "lon": -83.4718},
    "KDVN": {"name": "Quad Cities, IA", "lat": 41.6116, "lon": -90.5809},
    "KDYX": {"name": "Dyess AFB, TX", "lat": 32.5386, "lon": -99.2543},
    "KEAX": {"name": "Kansas City, MO", "lat": 38.8103, "lon": -94.2646},
    "KEMX": {"name": "Tucson, AZ", "lat": 31.8936, "lon": -110.6301},
    "KENX": {"name": "Albany, NY", "lat": 42.5866, "lon": -74.0639},
    "KEOX": {"name": "Fort Rucker, AL", "lat": 31.4606, "lon": -85.4592},
    "KEPZ": {"name": "El Paso, TX", "lat": 31.8731, "lon": -106.6980},
    "KESX": {"name": "Las Vegas, NV", "lat": 35.7013, "lon": -114.8918},
    "KEVX": {"name": "Eglin AFB, FL", "lat": 30.5651, "lon": -85.9216},
    "KEWX": {"name": "Austin/San Antonio, TX", "lat": 29.7041, "lon": -98.0286},
    "KEYX": {"name": "Edwards AFB, CA", "lat": 35.0978, "lon": -117.5609},
    "KFCX": {"name": "Roanoke, VA", "lat": 37.0244, "lon": -80.2740},
    "KFDR": {"name": "Frederick, OK", "lat": 34.3622, "lon": -98.9766},
    "KFDX": {"name": "Cannon AFB, NM", "lat": 34.6350, "lon": -103.6300},
    "KFFC": {"name": "Atlanta, GA", "lat": 33.3636, "lon": -84.5661},
    "KFSD": {"name": "Sioux Falls, SD", "lat": 43.5878, "lon": -96.7293},
    "KFSX": {"name": "Flagstaff, AZ", "lat": 34.5744, "lon": -111.1983},
    "KFTG": {"name": "Denver, CO", "lat": 39.7866, "lon": -104.5455},
    "KFWS": {"name": "Dallas/Fort Worth, TX", "lat": 32.5730, "lon": -97.3033},
    "KGGW": {"name": "Glasgow, MT", "lat": 48.2063, "lon": -106.6252},
    "KGJX": {"name": "Grand Junction, CO", "lat": 39.0621, "lon": -108.2139},
    "KGLD": {"name": "Goodland, KS", "lat": 39.3668, "lon": -101.7005},
    "KGRB": {"name": "Green Bay, WI", "lat": 44.4986, "lon": -88.1112},
    "KGRK": {"name": "Fort Hood, TX", "lat": 30.7218, "lon": -97.3830},
    "KGRR": {"name": "Grand Rapids, MI", "lat": 42.8939, "lon": -85.5449},
    "KGSP": {"name": "Greenville/Spartanburg, SC", "lat": 34.8832, "lon": -82.2198},
    "KGWX": {"name": "Columbus AFB, MS", "lat": 33.8969, "lon": -88.3293},
    "KGYX": {"name": "Portland, ME", "lat": 43.8914, "lon": -70.2565},
    "KHDX": {"name": "Holloman AFB, NM", "lat": 33.0769, "lon": -106.1201},
    "KHGX": {"name": "Houston, TX", "lat": 29.4719, "lon": -95.0788},
    "KHNX": {"name": "San Joaquin Valley, CA", "lat": 36.3142, "lon": -119.6322},
    "KHPX": {"name": "Fort Campbell, KY", "lat": 36.7371, "lon": -87.2855},
    "KHTX": {"name": "Huntsville, AL", "lat": 34.9305, "lon": -86.0837},
    "KICT": {"name": "Wichita, KS", "lat": 37.6546, "lon": -97.4431},
    "KICX": {"name": "Cedar City, UT", "lat": 37.5910, "lon": -112.8622},
    "KILN": {"name": "Cincinnati, OH", "lat": 39.4203, "lon": -83.8217},
    "KILX": {"name": "Springfield, IL", "lat": 40.1505, "lon": -89.3367},
    "KIND": {"name": "Indianapolis, IN", "lat": 39.7075, "lon": -86.2804},
    "KINX": {"name": "Tulsa, OK", "lat": 36.1750, "lon": -95.5643},
    "KIWA": {"name": "Phoenix, AZ", "lat": 33.2893, "lon": -111.6700},
    "KIWX": {"name": "Fort Wayne, IN", "lat": 41.3586, "lon": -85.7001},
    "KJAN": {"name": "Jackson, MS", "lat": 32.3187, "lon": -90.0805},
    "KJAX": {"name": "Jacksonville, FL", "lat": 30.4846, "lon": -81.7018},
    "KJGX": {"name": "Robins AFB, GA", "lat": 32.6756, "lon": -83.3507},
    "KJKL": {"name": "Jackson, KY", "lat": 37.5908, "lon": -83.3130},
    "KLBB": {"name": "Lubbock, TX", "lat": 33.6541, "lon": -101.8143},
    "KLCH": {"name": "Lake Charles, LA", "lat": 30.1253, "lon": -93.2159},
    "KLGX": {"name": "Langley Hill, WA", "lat": 47.1169, "lon": -124.1068},
    "KLIX": {"name": "New Orleans, LA", "lat": 30.3367, "lon": -89.8255},
    "KLNX": {"name": "North Platte, NE", "lat": 41.9579, "lon": -100.5760},
    "KLOT": {"name": "Chicago, IL", "lat": 41.6044, "lon": -88.0844},
    "KLRX": {"name": "Elko, NV", "lat": 40.7397, "lon": -116.8025},
    "KLSX": {"name": "St. Louis, MO", "lat": 38.6987, "lon": -90.6827},
    "KLTX": {"name": "Wilmington, NC", "lat": 33.9891, "lon": -78.4291},
    "KLVX": {"name": "Louisville, KY", "lat": 37.9753, "lon": -85.9439},
    "KLWX": {"name": "Washington DC", "lat": 38.9763, "lon": -77.4875},
    "KLZK": {"name": "Little Rock, AR", "lat": 34.8365, "lon": -92.2621},
    "KMAF": {"name": "Midland/Odessa, TX", "lat": 31.9434, "lon": -102.1893},
    "KMAX": {"name": "Medford, OR", "lat": 42.0810, "lon": -122.7174},
    "KMBX": {"name": "Minot AFB, ND", "lat": 48.3930, "lon": -100.8644},
    "KMHX": {"name": "Morehead City, NC", "lat": 34.7759, "lon": -76.8762},
    "KMKX": {"name": "Milwaukee, WI", "lat": 42.9678, "lon": -88.5505},
    "KMLB": {"name": "Melbourne, FL", "lat": 28.1131, "lon": -80.6541},
    "KMOB": {"name": "Mobile, AL", "lat": 30.6794, "lon": -88.2397},
    "KMPX": {"name": "Minneapolis, MN", "lat": 44.8489, "lon": -93.5653},
    "KMQT": {"name": "Marquette, MI", "lat": 46.5311, "lon": -87.5487},
    "KMRX": {"name": "Knoxville, TN", "lat": 36.1686, "lon": -83.4017},
    "KMSX": {"name": "Missoula, MT", "lat": 47.0413, "lon": -113.9864},
    "KMTX": {"name": "Salt Lake City, UT", "lat": 41.2627, "lon": -112.4477},
    "KMUX": {"name": "San Francisco, CA", "lat": 37.1552, "lon": -121.8985},
    "KMVX": {"name": "Fargo, ND", "lat": 47.5279, "lon": -97.3253},
    "KMXX": {"name": "Maxwell AFB, AL", "lat": 32.5367, "lon": -85.7899},
    "KNKX": {"name": "San Diego, CA", "lat": 32.9190, "lon": -117.0417},
    "KNQA": {"name": "Memphis, TN", "lat": 35.3448, "lon": -89.8733},
    "KOAX": {"name": "Omaha, NE", "lat": 41.3203, "lon": -96.3669},
    "KOHX": {"name": "Nashville, TN", "lat": 36.2472, "lon": -86.5625},
    "KOKX": {"name": "New York City, NY", "lat": 40.8655, "lon": -72.8637},
    "KOTX": {"name": "Spokane, WA", "lat": 47.6804, "lon": -117.6268},
    "KPAH": {"name": "Paducah, KY", "lat": 37.0683, "lon": -88.7720},
    "KPBZ": {"name": "Pittsburgh, PA", "lat": 40.5317, "lon": -80.2178},
    "KPDT": {"name": "Pendleton, OR", "lat": 45.6906, "lon": -118.8529},
    "KPOE": {"name": "Fort Polk, LA", "lat": 31.1557, "lon": -92.9763},
    "KPUX": {"name": "Pueblo, CO", "lat": 38.4594, "lon": -104.1816},
    "KRAX": {"name": "Raleigh-Durham, NC", "lat": 35.6655, "lon": -78.4899},
    "KRGX": {"name": "Reno, NV", "lat": 39.7541, "lon": -119.4622},
    "KRIW": {"name": "Riverton, WY", "lat": 43.0661, "lon": -108.4774},
    "KRLX": {"name": "Charleston, WV", "lat": 38.3111, "lon": -81.7229},
    "KRTX": {"name": "Portland, OR", "lat": 45.7150, "lon": -122.9648},
    "KSFX": {"name": "Idaho Falls, ID", "lat": 43.1056, "lon": -112.6861},
    "KSGF": {"name": "Springfield, MO", "lat": 37.2352, "lon": -93.4004},
    "KSHV": {"name": "Shreveport, LA", "lat": 32.4508, "lon": -93.8412},
    "KSJT": {"name": "San Angelo, TX", "lat": 31.3713, "lon": -100.4926},
    "KSOX": {"name": "March AFB, CA", "lat": 33.8176, "lon": -117.6361},
    "KSRX": {"name": "Fort Smith, AR", "lat": 35.2904, "lon": -94.3620},
    "KTBW": {"name": "Tampa Bay, FL", "lat": 27.7055, "lon": -82.4017},
    "KTFX": {"name": "Great Falls, MT", "lat": 47.4596, "lon": -111.3853},
    "KTLH": {"name": "Tallahassee, FL", "lat": 30.3976, "lon": -84.3289},
    "KTLX": {"name": "Oklahoma City, OK", "lat": 35.3334, "lon": -97.2777},
    "KTWX": {"name": "Topeka, KS", "lat": 38.9969, "lon": -96.2326},
    "KTYX": {"name": "Montague, NY", "lat": 43.7557, "lon": -75.6799},
    "KUDX": {"name": "Rapid City, SD", "lat": 44.1247, "lon": -102.8297},
    "KUEX": {"name": "Grand Island, NE", "lat": 40.3209, "lon": -98.4419},
    "KVAX": {"name": "Moody AFB, GA", "lat": 30.8903, "lon": -83.0015},
    "KVBX": {"name": "Vandenberg AFB, CA", "lat": 34.8383, "lon": -120.3978},
    "KVNX": {"name": "Vance AFB, OK", "lat": 36.7406, "lon": -98.1279},
    "KVTX": {"name": "Los Angeles, CA", "lat": 34.4117, "lon": -119.1795},
    "KVWX": {"name": "Evansville, IN", "lat": 38.2604, "lon": -87.7245},
    "KYUX": {"name": "Yuma, AZ", "lat": 32.4953, "lon": -114.6567},
}


def get_radar_scans(station: str, count: int = 6) -> List[str]:
    """Get radar files from AWS S3 with local caching."""
    import nexradaws
    import shutil

    cleanup_old_cache(max_age_hours=1)

    conn = nexradaws.NexradAwsInterface()
    cache_dir = get_cache_dir()
    downloaded_files = []

    for days_ago in range(2):
        date = datetime.utcnow() - timedelta(days=days_ago)

        try:
            scans = conn.get_avail_scans(date.year, date.month, date.day, station)

            if scans:
                valid_scans = [s for s in scans if '_MDM' not in str(s.key)]

                if not valid_scans:
                    continue

                recent_scans = valid_scans[-count:] if len(valid_scans) >= count else valid_scans

                for scan in recent_scans:
                    filename = scan.key.split('/')[-1]
                    cached_file = cache_dir / filename

                    if cached_file.exists():
                        print(f"Using cached: {filename}")
                        downloaded_files.append(str(cached_file))
                    else:
                        print(f"Downloading: {filename}")
                        try:
                            temp_dir = tempfile.mkdtemp()
                            results = conn.download(scan, temp_dir)

                            for local_scan in results.iter_success():
                                shutil.move(local_scan.filepath, cached_file)
                                downloaded_files.append(str(cached_file))
                                print(f"Cached: {filename}")

                        except Exception as e:
                            print(f"Error downloading {filename}: {e}")
                            continue

                    if len(downloaded_files) >= count:
                        # Sort by filename (which contains timestamp) to ensure chronological order
                        downloaded_files.sort()
                        return downloaded_files[-count:]

        except Exception as e:
            print(f"Error getting scans for {station}: {e}")
            continue

    # Sort by filename to ensure chronological order (oldest first)
    downloaded_files.sort()
    return downloaded_files


def get_latest_radar_file(station: str) -> Optional[str]:
    files = get_radar_scans(station, count=1)
    return files[0] if files else None


def generate_radar_image(station: str, field: str = 'reflectivity',
                         radar_file: Optional[str] = None) -> dict:
    """Generate a transparent radar image overlay and return with bounds."""
    import pyart

    if radar_file is None:
        radar_file = get_latest_radar_file(station)

    if not radar_file:
        return {
            "image": None,
            "error": f"No recent data for {station}",
            "timestamp": None,
            "bounds": None
        }

    # Check image cache first
    cached = get_cached_image(radar_file, field)
    if cached:
        return cached

    try:
        radar = pyart.io.read_nexrad_archive(radar_file)

        radar_lat = radar.latitude['data'][0]
        radar_lon = radar.longitude['data'][0]

        # Get scan time
        try:
            time_start = radar.time['units'].split(' ')[-1]
            scan_time = time_start
        except:
            scan_time = "Unknown"

        # Calculate bounds (approx 250km radius)
        extent_deg = 2.5
        bounds = {
            "north": float(radar_lat + extent_deg),
            "south": float(radar_lat - extent_deg),
            "east": float(radar_lon + extent_deg),
            "west": float(radar_lon - extent_deg)
        }

        # Create figure with transparent background
        fig = plt.figure(figsize=(10, 10), dpi=100)
        fig.patch.set_alpha(0)

        ax = fig.add_axes([0, 0, 1, 1])
        ax.set_xlim(bounds['west'], bounds['east'])
        ax.set_ylim(bounds['south'], bounds['north'])
        ax.set_aspect('equal')
        ax.axis('off')
        ax.patch.set_alpha(0)

        # Get radar data for the sweep
        sweep = 0
        if field == 'reflectivity':
            field_name = 'reflectivity'
            vmin, vmax = -10, 70
            cmap = 'NWSRef'
        else:
            field_name = 'velocity'
            vmin, vmax = -30, 30
            cmap = 'NWSVel'

        # Get sweep data
        start_idx = radar.sweep_start_ray_index['data'][sweep]
        end_idx = radar.sweep_end_ray_index['data'][sweep]

        # Extract data
        azimuth = radar.azimuth['data'][start_idx:end_idx+1]
        rng = radar.range['data'] / 1000.0  # Convert to km

        # Find the correct field name
        data = None
        if field == 'reflectivity':
            for try_field in ['reflectivity', 'REF', 'DBZH', 'DBZ']:
                if try_field in radar.fields:
                    data = radar.fields[try_field]['data'][start_idx:end_idx+1]
                    break
        else:  # velocity
            for try_field in ['velocity', 'VEL', 'V']:
                if try_field in radar.fields:
                    data = radar.fields[try_field]['data'][start_idx:end_idx+1]
                    break

        if data is None:
            available = list(radar.fields.keys())
            return {
                "image": None,
                "error": f"Field '{field}' not found. Available: {available}",
                "timestamp": None,
                "bounds": None
            }

        # Convert polar to cartesian coordinates
        azimuth_rad = np.deg2rad(azimuth)
        r, az = np.meshgrid(rng, azimuth_rad)

        # Calculate x, y in km from radar
        x = r * np.sin(az)
        y = r * np.cos(az)

        # Convert to lat/lon
        km_per_deg = 111.0
        lons = radar_lon + x / (km_per_deg * np.cos(np.deg2rad(radar_lat)))
        lats = radar_lat + y / km_per_deg

        # Apply noise threshold - mask out low values
        if field == 'reflectivity':
            # Filter out values below 5 dBZ (noise/ground clutter)
            noise_threshold = 5
            data = np.ma.masked_where(data < noise_threshold, data)
        else:
            # For velocity, mask out very low absolute values (near zero = no motion)
            noise_threshold = 1
            data = np.ma.masked_where(np.abs(data) < noise_threshold, data)

        # Plot with transparency
        mesh = ax.pcolormesh(lons, lats, data, cmap=cmap,
                            vmin=vmin, vmax=vmax, alpha=0.8,
                            shading='auto')

        # Save to buffer with transparency
        buf = io.BytesIO()
        fig.savefig(buf, format='png', transparent=True,
                   bbox_inches='tight', pad_inches=0, dpi=100)
        buf.seek(0)
        image_base64 = base64.b64encode(buf.read()).decode('utf-8')
        plt.close(fig)

        result = {
            "image": image_base64,
            "timestamp": scan_time,
            "bounds": bounds,
            "error": None
        }

        # Save to image cache
        save_cached_image(radar_file, field, result)

        return result

    except Exception as e:
        print(f"Error reading radar: {e}")
        import traceback
        traceback.print_exc()
        return {
            "image": None,
            "error": str(e),
            "timestamp": None,
            "bounds": None
        }


def generate_animation_frames(station: str, field: str = 'reflectivity',
                              frame_count: int = 6) -> List[dict]:
    """Generate multiple radar frames for animation."""
    files = get_radar_scans(station, count=frame_count)

    if not files:
        result = generate_radar_image(station, field)
        return [result]

    frames = []
    for radar_file in files:
        try:
            result = generate_radar_image(station, field, radar_file=radar_file)
            if result['image']:
                frames.append(result)
        except Exception as e:
            print(f"Error generating frame: {e}")
            continue

    return frames if frames else [generate_radar_image(station, field)]


def extract_radar_grid(radar_file: str, field: str = 'reflectivity',
                       grid_size: int = 500) -> dict:
    """Extract radar data as a regular Cartesian grid for pysteps."""
    import pyart

    try:
        radar = pyart.io.read_nexrad_archive(radar_file)

        radar_lat = radar.latitude['data'][0]
        radar_lon = radar.longitude['data'][0]

        # Get scan time
        try:
            time_start = radar.time['units'].split(' ')[-1]
            scan_time = time_start
        except:
            scan_time = "Unknown"

        # Calculate bounds (approx 250km radius)
        extent_deg = 2.5
        bounds = {
            "north": float(radar_lat + extent_deg),
            "south": float(radar_lat - extent_deg),
            "east": float(radar_lon + extent_deg),
            "west": float(radar_lon - extent_deg)
        }

        # Get sweep data
        sweep = 0
        start_idx = radar.sweep_start_ray_index['data'][sweep]
        end_idx = radar.sweep_end_ray_index['data'][sweep]

        # Extract data
        azimuth = radar.azimuth['data'][start_idx:end_idx+1]
        rng = radar.range['data'] / 1000.0  # Convert to km

        # Find the correct field name
        data = None
        if field == 'reflectivity':
            for try_field in ['reflectivity', 'REF', 'DBZH', 'DBZ']:
                if try_field in radar.fields:
                    data = radar.fields[try_field]['data'][start_idx:end_idx+1]
                    break
        else:
            for try_field in ['velocity', 'VEL', 'V']:
                if try_field in radar.fields:
                    data = radar.fields[try_field]['data'][start_idx:end_idx+1]
                    break

        if data is None:
            return None

        # Convert masked array to regular array with NaN for missing
        if hasattr(data, 'filled'):
            data = data.filled(np.nan)

        # Apply noise threshold - same as in generate_radar_image
        # This is critical to prevent noise from polluting the forecast
        if field == 'reflectivity':
            noise_threshold = 5  # Filter out values below 5 dBZ
            data = np.where(data < noise_threshold, np.nan, data)
        else:
            noise_threshold = 1  # For velocity, mask near-zero values
            data = np.where(np.abs(data) < noise_threshold, np.nan, data)

        # Convert polar to cartesian coordinates
        azimuth_rad = np.deg2rad(azimuth)
        r, az = np.meshgrid(rng, azimuth_rad)

        # Calculate x, y in km from radar
        x_polar = r * np.sin(az)
        y_polar = r * np.cos(az)

        # Convert to lat/lon
        km_per_deg = 111.0
        lons_polar = radar_lon + x_polar / (km_per_deg * np.cos(np.deg2rad(radar_lat)))
        lats_polar = radar_lat + y_polar / km_per_deg

        # Create regular grid
        # Note: lat_grid goes from NORTH to SOUTH so row 0 = north (image convention)
        lon_grid = np.linspace(bounds['west'], bounds['east'], grid_size)
        lat_grid = np.linspace(bounds['north'], bounds['south'], grid_size)  # North to South!
        lon_mesh, lat_mesh = np.meshgrid(lon_grid, lat_grid)

        # Interpolate to regular grid using scipy
        from scipy.interpolate import griddata

        # Flatten polar coordinates and data
        points = np.column_stack([lons_polar.ravel(), lats_polar.ravel()])
        values = data.ravel()

        # Remove NaN points for interpolation
        valid_mask = ~np.isnan(values)
        if np.sum(valid_mask) < 100:
            return None

        grid_data = griddata(
            points[valid_mask],
            values[valid_mask],
            (lon_mesh, lat_mesh),
            method='linear',
            fill_value=np.nan
        )

        return {
            "data": grid_data,
            "timestamp": scan_time,
            "bounds": bounds,
            "lat_grid": lat_grid,
            "lon_grid": lon_grid,
            "radar_lat": radar_lat,
            "radar_lon": radar_lon
        }

    except Exception as e:
        print(f"Error extracting radar grid: {e}")
        import traceback
        traceback.print_exc()
        return None


def generate_forecast(station: str, field: str = 'reflectivity',
                      lead_times: int = 6, timestep_min: int = 5) -> dict:
    """Generate optical flow forecast using pysteps."""
    try:
        from pysteps import motion
    except ImportError:
        return {
            "error": "Forecast feature requires pysteps library. Install with: uv pip install pysteps",
            "frames": []
        }

    # Get more radar scans for better motion estimation (6 frames = ~30 min history)
    files = get_radar_scans(station, count=6)

    if len(files) < 2:
        return {
            "error": f"Not enough radar scans for forecasting (need 2+, got {len(files)})",
            "frames": []
        }

    print(f"Generating forecast from {len(files)} radar files...")

    # Extract radar data as grids
    grids = []
    for f in files:
        grid = extract_radar_grid(f, field)
        if grid is not None:
            grids.append(grid)

    if len(grids) < 2:
        return {
            "error": "Failed to extract radar grids for forecasting",
            "frames": []
        }

    # Stack grids into 3D array (time, y, x)
    # IMPORTANT: frames must be in chronological order (oldest first)
    radar_stack = np.stack([g['data'] for g in grids], axis=0)

    print(f"Radar stack shape: {radar_stack.shape}")
    print(f"Frame timestamps (should be oldest to newest):")
    for i, g in enumerate(grids):
        print(f"  Frame {i}: {g['timestamp']}")

    # Check if there's enough precipitation to track
    # Count pixels with significant reflectivity (> 10 dBZ)
    significant_pixels = np.sum(radar_stack > 10) / radar_stack.size
    print(f"Significant precipitation coverage: {significant_pixels*100:.1f}%")

    if significant_pixels < 0.01:  # Less than 1% coverage
        return {
            "error": "Not enough precipitation to generate forecast. Forecast works best with active weather.",
            "frames": []
        }

    # Replace NaN with 0 for motion estimation (no echo = 0 reflectivity)
    radar_stack_filled = np.nan_to_num(radar_stack, nan=0.0)

    # Note: Smoothing removed since noise filtering is now applied during grid extraction
    # Keeping the data sharp for better motion tracking

    # Estimate motion field using optical flow
    use_persistence = False
    V = None

    try:
        # Use Lucas-Kanade with better parameters for radar
        V = motion.lucaskanade.dense_lucaskanade(
            radar_stack_filled,
            fd_method="shitomasi",
            interp_method="idwinterp2d",
            verbose=False
        )
        print(f"Motion field estimated using Lucas-Kanade, shape: {V.shape}")

        # Debug: Print motion statistics
        # V[0] = motion in y (row) direction, V[1] = motion in x (column) direction
        v_y = V[0][~np.isnan(V[0])]
        v_x = V[1][~np.isnan(V[1])]
        if len(v_y) > 0:
            mean_vy = np.mean(v_y)
            mean_vx = np.mean(v_x)
            print(f"Motion V_y (rows/timestep): mean={mean_vy:.2f}, range=[{np.min(v_y):.2f}, {np.max(v_y):.2f}]")
            print(f"Motion V_x (cols/timestep): mean={mean_vx:.2f}, range=[{np.min(v_x):.2f}, {np.max(v_x):.2f}]")

            # Convert to approximate km/h for understanding
            # Grid resolution: ~5 degrees / 500 pixels = 0.01 deg/pixel = ~1.1 km/pixel
            # Time step: ~5 minutes between frames
            km_per_pixel = 1.1
            min_per_step = 5
            speed_kmh = np.sqrt(mean_vy**2 + mean_vx**2) * km_per_pixel * (60 / min_per_step)
            print(f"Estimated mean motion: {speed_kmh:.1f} km/h")

            # If motion is essentially zero, fall back to persistence
            if np.abs(mean_vy) < 0.3 and np.abs(mean_vx) < 0.3:
                print("WARNING: Motion vectors near zero - will use persistence forecast")
                use_persistence = True

    except Exception as e:
        print(f"Error estimating motion: {e}")
        import traceback
        traceback.print_exc()
        print("Falling back to persistence forecast")
        use_persistence = True

    # Generate forecast
    last_frame = radar_stack_filled[-1]

    if use_persistence or V is None:
        # Persistence forecast - just repeat the last frame
        print("Using persistence forecast (last frame repeated)")
        forecast = np.stack([last_frame] * lead_times, axis=0)
    else:
        # Extrapolate forward using semi-Lagrangian advection
        try:
            # Debug: Compare first and last input frames to see actual motion
            diff = radar_stack_filled[-1] - radar_stack_filled[0]
            diff_valid = diff[~np.isnan(diff)]
            if len(diff_valid) > 0:
                print(f"Frame difference (last-first): mean={np.mean(diff_valid):.2f}, max change={np.max(np.abs(diff_valid)):.2f}")

            # Get mean motion for simple shift test
            v_y_mean = np.nanmean(V[0])
            v_x_mean = np.nanmean(V[1])

            # Try simple shift-based extrapolation first for debugging
            # This uses scipy.ndimage.shift which is straightforward
            from scipy.ndimage import shift as ndshift
            print(f"Testing simple shift extrapolation with mean motion: dy={v_y_mean:.2f}, dx={v_x_mean:.2f}")

            forecast = []
            for i in range(lead_times):
                # Shift by accumulated motion
                # Note: shift uses (y, x) order and shifts in the direction of the motion
                # For weather moving south (positive V[0]), we shift the data north (negative shift)
                # to show where the weather WILL BE
                shift_y = (i + 1) * v_y_mean
                shift_x = (i + 1) * v_x_mean
                shifted = ndshift(last_frame, [shift_y, shift_x], mode='constant', cval=0)
                forecast.append(shifted)

            forecast = np.stack(forecast, axis=0)
            print(f"Simple shift forecast generated, shape: {forecast.shape}")

            # Debug: Show how much forecast differs from persistence
            for i in range(min(3, lead_times)):
                fc_diff = forecast[i] - last_frame
                fc_diff_valid = fc_diff[~np.isnan(fc_diff)]
                if len(fc_diff_valid) > 0:
                    print(f"  Forecast frame {i+1} differs from last by: mean abs={np.mean(np.abs(fc_diff_valid)):.2f}")

        except Exception as e:
            print(f"Error in extrapolation: {e}, using persistence instead")
            import traceback
            traceback.print_exc()
            forecast = np.stack([last_frame] * lead_times, axis=0)

    # Generate images for each forecast frame
    frames = []
    bounds = grids[-1]['bounds']
    last_timestamp = grids[-1]['timestamp']

    # Parse last timestamp to generate forecast timestamps
    try:
        base_time = datetime.fromisoformat(last_timestamp.replace('Z', '+00:00'))
    except:
        base_time = datetime.utcnow()

    if field == 'reflectivity':
        vmin, vmax = -10, 70
        cmap = 'NWSRef'
    else:
        vmin, vmax = -30, 30
        cmap = 'NWSVel'

    for i in range(lead_times):
        try:
            frame_data = forecast[i]

            # Create figure
            fig = plt.figure(figsize=(10, 10), dpi=100)
            fig.patch.set_alpha(0)

            ax = fig.add_axes([0, 0, 1, 1])
            ax.set_xlim(bounds['west'], bounds['east'])
            ax.set_ylim(bounds['south'], bounds['north'])
            ax.set_aspect('equal')
            ax.axis('off')
            ax.patch.set_alpha(0)

            # Create meshgrid for plotting
            lon_mesh, lat_mesh = np.meshgrid(grids[-1]['lon_grid'], grids[-1]['lat_grid'])

            # Apply noise threshold - same as radar image generation
            if field == 'reflectivity':
                noise_threshold = 5  # Filter out values below 5 dBZ
                frame_masked = np.ma.masked_where(
                    (frame_data < noise_threshold) | np.isnan(frame_data),
                    frame_data
                )
            else:
                noise_threshold = 1  # For velocity, mask near-zero values
                frame_masked = np.ma.masked_where(
                    (np.abs(frame_data) < noise_threshold) | np.isnan(frame_data),
                    frame_data
                )

            ax.pcolormesh(lon_mesh, lat_mesh, frame_masked,
                         cmap=cmap, vmin=vmin, vmax=vmax,
                         alpha=0.8, shading='auto')

            # Save to buffer
            buf = io.BytesIO()
            fig.savefig(buf, format='png', transparent=True,
                       bbox_inches='tight', pad_inches=0, dpi=100)
            buf.seek(0)
            image_base64 = base64.b64encode(buf.read()).decode('utf-8')
            plt.close(fig)

            # Calculate forecast timestamp
            forecast_time = base_time + timedelta(minutes=(i + 1) * timestep_min)

            frames.append({
                "image": image_base64,
                "timestamp": forecast_time.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "bounds": bounds,
                "lead_time_min": (i + 1) * timestep_min,
                "is_forecast": True
            })

        except Exception as e:
            print(f"Error generating forecast frame {i}: {e}")
            continue

    return {
        "station": station,
        "field": field,
        "frames": frames,
        "timestep_min": timestep_min,
        "method": "optical_flow_extrapolation"
    }


# Routes
@app.get("/", response_class=HTMLResponse)
async def root():
    """Serve the main page from static files."""
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/stations")
async def get_stations():
    """Return the list of radar stations."""
    return RADAR_STATIONS


@app.get("/api/preferences")
async def get_preferences():
    """Get user preferences."""
    prefs = load_preferences()
    return {
        "default_station": prefs.get("default_station", "KOKX"),
        "is_first_launch": "default_station" not in prefs
    }


@app.post("/api/preferences/station")
async def set_station_preference(pref: StationPreference):
    """Set the default station preference."""
    prefs = load_preferences()
    prefs["default_station"] = pref.station.upper()
    save_preferences(prefs)
    return {"status": "ok", "station": pref.station}


@app.get("/api/radar/{station}")
async def get_radar(station: str, field: str = 'reflectivity'):
    """Get radar image overlay for a station."""
    station = station.upper()

    if station not in RADAR_STATIONS:
        raise HTTPException(status_code=404, detail=f"Unknown station: {station}")

    try:
        result = generate_radar_image(station, field)

        if result['error']:
            return JSONResponse(
                status_code=200,
                content={
                    "error": result['error'],
                    "station": station
                }
            )

        return {
            "station": station,
            "name": RADAR_STATIONS[station]["name"],
            "field": field,
            "image": result["image"],
            "timestamp": result["timestamp"],
            "bounds": result["bounds"]
        }
    except Exception as e:
        import traceback
        traceback.print_exc()
        return JSONResponse(
            status_code=500,
            content={"error": str(e), "station": station}
        )


@app.get("/api/radar/{station}/animation")
async def get_radar_animation(station: str, field: str = 'reflectivity', frames: int = 6):
    """Get multiple radar frames for animation."""
    station = station.upper()

    if station not in RADAR_STATIONS:
        raise HTTPException(status_code=404, detail=f"Unknown station: {station}")

    try:
        frame_list = generate_animation_frames(station, field, frames)

        return {
            "station": station,
            "name": RADAR_STATIONS[station]["name"],
            "field": field,
            "frames": frame_list
        }
    except Exception as e:
        import traceback
        traceback.print_exc()
        return JSONResponse(
            status_code=500,
            content={"error": str(e), "station": station}
        )


@app.get("/api/radar/{station}/forecast")
async def get_radar_forecast(station: str, field: str = 'reflectivity',
                              lead_times: int = 6, timestep_min: int = 5):
    """Generate optical flow forecast for a station."""
    station = station.upper()

    if station not in RADAR_STATIONS:
        raise HTTPException(status_code=404, detail=f"Unknown station: {station}")

    try:
        result = generate_forecast(station, field, lead_times, timestep_min)

        if result.get('error'):
            return JSONResponse(
                status_code=200,
                content={
                    "error": result['error'],
                    "station": station,
                    "frames": []
                }
            )

        return {
            "station": station,
            "name": RADAR_STATIONS[station]["name"],
            "field": field,
            "frames": result['frames'],
            "timestep_min": timestep_min,
            "method": result.get('method', 'optical_flow')
        }
    except Exception as e:
        import traceback
        traceback.print_exc()
        return JSONResponse(
            status_code=500,
            content={"error": str(e), "station": station, "frames": []}
        )


@app.get("/api/health")
async def health():
    """Health check endpoint."""
    return {"status": "ok"}


@app.get("/api/cache/list")
async def list_cache():
    """List all cached images for debugging/testing."""
    image_cache_dir = get_image_cache_dir()
    radar_cache_dir = get_cache_dir()

    cached_images = []
    for f in image_cache_dir.glob('*.json'):
        try:
            data = json.loads(f.read_text())
            cached_images.append({
                "cache_key": f.stem,
                "timestamp": data.get("timestamp"),
                "has_image": data.get("image") is not None,
                "file_modified": datetime.fromtimestamp(f.stat().st_mtime).isoformat()
            })
        except:
            pass

    cached_radar_files = []
    for f in radar_cache_dir.glob('*'):
        if f.is_file() and not f.name.endswith('.json'):
            # Parse station from filename (e.g., KOKX20240121_123456_V06)
            name = f.name
            station = name[:4] if len(name) >= 4 else name
            cached_radar_files.append({
                "filename": name,
                "station": station,
                "file_modified": datetime.fromtimestamp(f.stat().st_mtime).isoformat(),
                "size_mb": round(f.stat().st_size / (1024 * 1024), 2)
            })

    return {
        "image_cache_count": len(cached_images),
        "radar_file_count": len(cached_radar_files),
        "cached_images": sorted(cached_images, key=lambda x: x.get("timestamp") or "", reverse=True),
        "cached_radar_files": sorted(cached_radar_files, key=lambda x: x["filename"], reverse=True)
    }


@app.get("/api/cache/image/{cache_key}")
async def get_cached_image_by_key(cache_key: str):
    """Get a specific cached image by its cache key."""
    cache_file = get_image_cache_dir() / f"{cache_key}.json"
    if not cache_file.exists():
        raise HTTPException(status_code=404, detail="Cache key not found")

    try:
        data = json.loads(cache_file.read_text())
        return data
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/cache/stations")
async def get_cached_stations():
    """Get list of stations that have cached data, grouped by timestamp."""
    radar_cache_dir = get_cache_dir()

    # Get all cached radar files and group by station
    station_data = {}
    for f in radar_cache_dir.glob('*'):
        if f.is_file() and not f.name.endswith('.json'):
            name = f.name
            # Extract station code (first 4 chars)
            if len(name) >= 4:
                station = name[:4]
                if station not in station_data:
                    station_data[station] = []
                station_data[station].append({
                    "filename": name,
                    "modified": datetime.fromtimestamp(f.stat().st_mtime).isoformat()
                })

    # Sort files for each station by name (which includes timestamp)
    for station in station_data:
        station_data[station] = sorted(station_data[station], key=lambda x: x["filename"], reverse=True)

    return {
        "stations": list(station_data.keys()),
        "station_files": station_data
    }


@app.get("/api/cache/timeline")
async def get_cache_timeline():
    """Get cached radar files grouped by time slots for timeline display."""
    import re
    radar_cache_dir = get_cache_dir()

    # Parse timestamps from filenames and group by rounded time
    time_slots = {}

    for f in radar_cache_dir.glob('*'):
        if f.is_file() and not f.name.endswith('.json') and '_MDM' not in f.name:
            name = f.name
            # Extract station and timestamp from filename
            # Format: KXXX20240121_123456_V06
            if len(name) >= 4:
                station = name[:4]
                # Try to parse timestamp from filename
                match = re.search(r'(\d{8})_(\d{6})', name)
                if match:
                    date_str = match.group(1)  # 20240121
                    time_str = match.group(2)  # 123456
                    try:
                        # Parse the datetime
                        dt = datetime.strptime(f"{date_str}_{time_str}", "%Y%m%d_%H%M%S")
                        # Round to nearest 5 minutes for grouping
                        minutes = (dt.minute // 5) * 5
                        slot_time = dt.replace(minute=minutes, second=0)
                        slot_key = slot_time.strftime("%Y-%m-%d %H:%M")

                        if slot_key not in time_slots:
                            time_slots[slot_key] = {
                                "datetime": slot_time.isoformat(),
                                "display_time": slot_time.strftime("%H:%M"),
                                "display_date": slot_time.strftime("%m/%d"),
                                "stations": set(),
                                "files": []
                            }
                        time_slots[slot_key]["stations"].add(station)
                        time_slots[slot_key]["files"].append({
                            "station": station,
                            "filename": name
                        })
                    except:
                        pass

    # Convert sets to lists and sort by time (oldest first for timeline)
    result = []
    for key in sorted(time_slots.keys()):  # Ascending order (oldest first)
        slot = time_slots[key]
        result.append({
            "slot_key": key,
            "datetime": slot["datetime"],
            "utc_time": slot["display_time"],
            "utc_date": slot["display_date"],
            "station_count": len(slot["stations"]),
            "stations": list(slot["stations"]),
            "files": slot["files"]
        })

    # Return last 20 slots, but in chronological order (oldest to newest)
    return {
        "slots": result[-20:] if len(result) > 20 else result
    }


@app.get("/api/radar/{station}/cached")
async def get_cached_radar(station: str, field: str = 'reflectivity'):
    """Get radar image from cache only - won't fetch new data."""
    station = station.upper()

    if station not in RADAR_STATIONS:
        raise HTTPException(status_code=404, detail=f"Unknown station: {station}")

    # Find cached radar files for this station
    radar_cache_dir = get_cache_dir()
    cached_files = sorted(
        [f for f in radar_cache_dir.glob(f'{station}*') if f.is_file() and '_MDM' not in f.name],
        key=lambda f: f.name,
        reverse=True
    )

    if not cached_files:
        return JSONResponse(
            status_code=200,
            content={"error": f"No cached data for {station}", "station": station}
        )

    # Use the most recent cached file
    radar_file = str(cached_files[0])

    # Check if we have a cached image for this file
    cached = get_cached_image(radar_file, field)
    if cached:
        return {
            "station": station,
            "name": RADAR_STATIONS[station]["name"],
            "field": field,
            "image": cached["image"],
            "timestamp": cached["timestamp"],
            "bounds": cached["bounds"],
            "from_cache": True
        }

    # Generate image from cached radar file (but don't download new data)
    try:
        result = generate_radar_image(station, field, radar_file=radar_file)

        if result['error']:
            return JSONResponse(
                status_code=200,
                content={"error": result['error'], "station": station}
            )

        return {
            "station": station,
            "name": RADAR_STATIONS[station]["name"],
            "field": field,
            "image": result["image"],
            "timestamp": result["timestamp"],
            "bounds": result["bounds"],
            "from_cache": True
        }
    except Exception as e:
        return JSONResponse(
            status_code=500,
            content={"error": str(e), "station": station}
        )


if __name__ == "__main__":
    print("Starting server on http://localhost:8188")
    uvicorn.run(app, host="127.0.0.1", port=8188)
