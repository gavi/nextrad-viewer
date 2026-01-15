// Global state
let map = null;
let radarLayers = new Map(); // Map of station code -> { layer, bounds, timestamp, field }
let currentStation = null;
let stations = {};

// Animation state
let animationData = new Map(); // Map of station code -> array of frames
let animationIndex = 0;
let animationInterval = null;
let isPlaying = false;
let syncedTimestamps = []; // Array of timestamps for synced animation

// Initialize the app
async function init() {
    // Initialize Leaflet map centered on US
    map = L.map('map', {
        center: [39.8283, -98.5795],
        zoom: 4,
        zoomControl: false  // Hide default zoom control
    });

    // Add OpenStreetMap tiles
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap contributors'
    }).addTo(map);

    // Fetch stations
    stations = await fetch('/api/stations').then(r => r.json());

    // Populate dropdowns
    populateStationDropdowns();

    // Render station list
    renderStationList();

    // Check preferences
    const prefs = await fetch('/api/preferences').then(r => r.json());

    if (prefs.is_first_launch) {
        document.getElementById('welcomeOverlay').style.display = 'flex';
    } else {
        currentStation = prefs.default_station;
        document.getElementById('stationSelect').value = currentStation;
        updateStationInfo();
        loadRadar();
    }

    // Add station markers to map
    addStationMarkers();

    // Update layer count display
    updateLayerCount();
}

function populateStationDropdowns() {
    const sortedStations = Object.entries(stations)
        .sort((a, b) => a[1].name.localeCompare(b[1].name));

    const optionsHtml = sortedStations
        .map(([code, info]) => `<option value="${code}">${code} - ${info.name}</option>`)
        .join('');

    document.getElementById('stationSelect').innerHTML = optionsHtml;
    document.getElementById('welcomeStationSelect').innerHTML = optionsHtml;
}

function renderStationList() {
    // Station list panel removed - stations selectable via dropdown or map markers
}

function addStationMarkers() {
    Object.entries(stations).forEach(([code, info]) => {
        const marker = L.circleMarker([info.lat, info.lon], {
            radius: 6,
            fillColor: '#00d9ff',
            color: '#fff',
            weight: 1,
            opacity: 0.8,
            fillOpacity: 0.6
        }).addTo(map);

        marker.bindTooltip(`${code}: ${info.name}`, {
            permanent: false,
            direction: 'top'
        });

        marker.on('click', () => selectStation(code));
    });
}

async function setDefaultStation() {
    const select = document.getElementById('welcomeStationSelect');
    currentStation = select.value;

    await fetch('/api/preferences/station', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({station: currentStation})
    });

    document.getElementById('welcomeOverlay').style.display = 'none';
    document.getElementById('stationSelect').value = currentStation;
    updateStationInfo();
    renderStationList();
    loadRadar();
}

async function selectStation(code) {
    currentStation = code;
    document.getElementById('stationSelect').value = code;
    renderStationList();
    updateStationInfo();

    // Pan map to station
    const info = stations[code];
    map.setView([info.lat, info.lon], 8);

    await fetch('/api/preferences/station', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({station: code})
    });
}

function updateStationInfo() {
    if (currentStation && stations[currentStation]) {
        document.getElementById('currentCode').textContent = currentStation;
        document.getElementById('currentName').textContent = ' - ' + stations[currentStation].name;
    }
}

function updateLayerCount() {
    const countEl = document.getElementById('layerCount');
    if (countEl) {
        countEl.textContent = `${radarLayers.size} station${radarLayers.size !== 1 ? 's' : ''} loaded`;
    }

    // Show/hide clear all button
    const clearBtn = document.getElementById('clearAllBtn');
    if (clearBtn) {
        clearBtn.style.display = radarLayers.size > 0 ? 'inline-block' : 'none';
    }

    // Update loaded stations list
    updateLoadedStationsList();
}

function updateLoadedStationsList() {
    const listEl = document.getElementById('loadedStations');
    if (!listEl) return;

    if (radarLayers.size === 0) {
        listEl.innerHTML = '<span class="no-layers">No layers loaded</span>';
        return;
    }

    const items = [];
    radarLayers.forEach((data, code) => {
        items.push(`<span class="loaded-station" onclick="focusStation('${code}')" title="${data.timestamp}">${code} <button class="remove-btn" onclick="event.stopPropagation(); removeLayer('${code}')">&times;</button></span>`);
    });
    listEl.innerHTML = items.join('');
}

function focusStation(code) {
    const data = radarLayers.get(code);
    if (data && data.bounds) {
        map.fitBounds([[data.bounds.south, data.bounds.west], [data.bounds.north, data.bounds.east]]);
    }
    currentStation = code;
    document.getElementById('stationSelect').value = code;
    updateStationInfo();
    document.getElementById('timeInfo').textContent = data?.timestamp || '';
}

function removeLayer(code) {
    const data = radarLayers.get(code);
    if (data && data.layer) {
        map.removeLayer(data.layer);
    }
    radarLayers.delete(code);
    updateLayerCount();

    // If we removed the current station, clear the time info
    if (code === currentStation) {
        document.getElementById('timeInfo').textContent = '';
    }
}

function clearAllLayers() {
    radarLayers.forEach((data, code) => {
        if (data.layer) {
            map.removeLayer(data.layer);
        }
    });
    radarLayers.clear();
    updateLayerCount();
    document.getElementById('timeInfo').textContent = '';
}

function showLoading(text = 'Loading radar data...') {
    document.getElementById('loadingText').textContent = text;
    document.getElementById('loadingOverlay').style.display = 'block';
}

function hideLoading() {
    document.getElementById('loadingOverlay').style.display = 'none';
}

async function loadRadar() {
    stopAnimation();
    document.getElementById('animControls').style.display = 'none';

    const station = document.getElementById('stationSelect').value;
    const field = document.getElementById('fieldSelect').value;
    currentStation = station;
    updateStationInfo();
    renderStationList();

    showLoading('Fetching radar data...');

    try {
        const res = await fetch(`/api/radar/${station}?field=${field}`);
        const data = await res.json();

        if (data.error) {
            hideLoading();
            alert('Error: ' + data.error);
            return;
        }

        // Remove existing layer for this station if exists
        if (radarLayers.has(station)) {
            map.removeLayer(radarLayers.get(station).layer);
        }

        // Add radar image as overlay
        const bounds = [[data.bounds.south, data.bounds.west],
                       [data.bounds.north, data.bounds.east]];

        const layer = L.imageOverlay(
            `data:image/png;base64,${data.image}`,
            bounds,
            { opacity: document.getElementById('opacitySlider').value / 100 }
        ).addTo(map);

        // Store layer data
        radarLayers.set(station, {
            layer: layer,
            bounds: data.bounds,
            timestamp: data.timestamp,
            field: field
        });

        // Update layer count
        updateLayerCount();

        // Pan to radar coverage
        map.fitBounds(bounds);

        // Update time info
        document.getElementById('timeInfo').textContent = data.timestamp || '';

        hideLoading();
    } catch (err) {
        hideLoading();
        alert('Error: ' + err.message);
    }
}

async function loadAnimation() {
    stopAnimation();

    const field = document.getElementById('fieldSelect').value;

    // Get stations to animate - either all loaded stations, or just current if none loaded
    let stationsToAnimate = Array.from(radarLayers.keys());
    if (stationsToAnimate.length === 0) {
        // No stations loaded, use currently selected station
        stationsToAnimate = [document.getElementById('stationSelect').value];
    }

    showLoading(`Loading animation for ${stationsToAnimate.length} station${stationsToAnimate.length !== 1 ? 's' : ''}...`);

    try {
        // Fetch animation frames for all stations in parallel
        const fetchPromises = stationsToAnimate.map(async (station) => {
            const res = await fetch(`/api/radar/${station}/animation?field=${field}&frames=6`);
            const data = await res.json();
            return { station, data };
        });

        const results = await Promise.all(fetchPromises);

        // Clear previous animation data
        animationData.clear();

        // Process results and build synced timeline
        const allTimestamps = new Set();

        results.forEach(({ station, data }) => {
            if (data.error) {
                console.warn(`Error loading animation for ${station}:`, data.error);
                return;
            }

            // Store frames for this station
            animationData.set(station, data.frames);

            // Collect all timestamps
            data.frames.forEach(frame => {
                if (frame.timestamp) {
                    allTimestamps.add(frame.timestamp);
                }
            });
        });

        if (animationData.size === 0) {
            hideLoading();
            alert('Error: Could not load animation data for any station');
            return;
        }

        // Sort timestamps chronologically
        syncedTimestamps = Array.from(allTimestamps).sort();

        // If we have more timestamps than frames, sample evenly
        if (syncedTimestamps.length > 6) {
            const step = Math.floor(syncedTimestamps.length / 6);
            syncedTimestamps = syncedTimestamps.filter((_, i) => i % step === 0).slice(0, 6);
        }

        animationIndex = 0;

        // Show animation controls
        document.getElementById('animControls').style.display = 'block';

        // Display first frame
        showFrame(0);

        // Start playing
        playAnimation();

        hideLoading();
    } catch (err) {
        hideLoading();
        alert('Error: ' + err.message);
    }
}

function findClosestFrame(frames, targetTimestamp) {
    if (!frames || frames.length === 0) return null;

    // Parse target timestamp
    const targetTime = new Date(targetTimestamp).getTime();

    let closest = frames[0];
    let closestDiff = Math.abs(new Date(closest.timestamp).getTime() - targetTime);

    for (const frame of frames) {
        const diff = Math.abs(new Date(frame.timestamp).getTime() - targetTime);
        if (diff < closestDiff) {
            closest = frame;
            closestDiff = diff;
        }
    }

    return closest;
}

function showFrame(index) {
    if (syncedTimestamps.length === 0) return;

    const targetTimestamp = syncedTimestamps[index];
    const opacity = document.getElementById('opacitySlider').value / 100;

    // Update each station's layer with the closest frame to this timestamp
    animationData.forEach((frames, station) => {
        const frame = findClosestFrame(frames, targetTimestamp);
        if (!frame) return;

        // Remove existing layer for this station
        if (radarLayers.has(station)) {
            map.removeLayer(radarLayers.get(station).layer);
        }

        // Add frame as overlay
        const bounds = [[frame.bounds.south, frame.bounds.west],
                       [frame.bounds.north, frame.bounds.east]];

        const layer = L.imageOverlay(
            `data:image/png;base64,${frame.image}`,
            bounds,
            { opacity: opacity }
        ).addTo(map);

        // Store layer data
        radarLayers.set(station, {
            layer: layer,
            bounds: frame.bounds,
            timestamp: frame.timestamp,
            field: document.getElementById('fieldSelect').value
        });
    });

    // Update layer list
    updateLoadedStationsList();

    // Update UI
    document.getElementById('frameInfo').textContent = `${index + 1} / ${syncedTimestamps.length}`;
    document.getElementById('progressFill').style.width = `${((index + 1) / syncedTimestamps.length) * 100}%`;
    document.getElementById('timeInfo').textContent = targetTimestamp || '';
}

function playAnimation() {
    if (animationInterval) clearInterval(animationInterval);
    isPlaying = true;
    document.getElementById('playPauseBtn').textContent = 'Pause';

    animationInterval = setInterval(() => {
        animationIndex = (animationIndex + 1) % syncedTimestamps.length;
        showFrame(animationIndex);
    }, 500);
}

function stopAnimation() {
    if (animationInterval) {
        clearInterval(animationInterval);
        animationInterval = null;
    }
    isPlaying = false;
    animationData.clear();
    animationIndex = 0;
    syncedTimestamps = [];
}

function togglePlayPause() {
    if (isPlaying) {
        clearInterval(animationInterval);
        isPlaying = false;
        document.getElementById('playPauseBtn').textContent = 'Play';
    } else {
        playAnimation();
    }
}

function prevFrame() {
    animationIndex = (animationIndex - 1 + syncedTimestamps.length) % syncedTimestamps.length;
    showFrame(animationIndex);
}

function nextFrame() {
    animationIndex = (animationIndex + 1) % syncedTimestamps.length;
    showFrame(animationIndex);
}

function setRadarOpacity(opacity) {
    // Update opacity for all layers
    radarLayers.forEach((data, code) => {
        if (data.layer) {
            data.layer.setOpacity(opacity);
        }
    });
}

// Initialize on load
init();
