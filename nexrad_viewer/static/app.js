// Global state
let map = null;
let radarLayers = new Map(); // Map of station code -> { layer, bounds, timestamp, field }
let currentStation = null;
let stations = {};

// Drawing/selection state
let stationMarkers = new Map(); // Map of station code -> marker
let drawnItems = null; // Feature group for drawn shapes
let selectedStations = new Set(); // Currently selected station codes

// Forecast state
let forecastData = new Map(); // station -> frames
let forecastMode = false;

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
        // Don't auto-load - let user select from timeline
    }

    // Add station markers to map
    addStationMarkers();

    // Load cache timeline
    await refreshCacheTimeline();

    // Initialize drawing controls
    initDrawControls();

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

        // Store marker reference for selection highlighting
        stationMarkers.set(code, marker);
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

    // Show/hide refresh all button
    const refreshBtn = document.getElementById('refreshAllBtn');
    if (refreshBtn) {
        refreshBtn.style.display = radarLayers.size > 0 ? 'inline-block' : 'none';
    }

    // Update loaded stations list
    updateLoadedStationsList();
}

function toggleLayersPanel() {
    const panel = document.getElementById('layersPanel').querySelector('.panel');
    const header = panel.querySelector('h3');
    panel.classList.toggle('layers-collapsed');

    if (panel.classList.contains('layers-collapsed')) {
        header.textContent = '▶ Stations';
    } else {
        header.textContent = '▼ Stations';
    }
}

async function refreshAllLayers() {
    // Refresh all currently loaded stations
    const stationsToRefresh = Array.from(radarLayers.keys());

    if (stationsToRefresh.length === 0) {
        return;
    }

    const field = document.getElementById('fieldSelect').value;
    showLoading(`Refreshing ${stationsToRefresh.length} station${stationsToRefresh.length !== 1 ? 's' : ''}...`);

    // Clear existing layers first
    radarLayers.forEach((data) => {
        if (data.layer) {
            map.removeLayer(data.layer);
        }
    });
    radarLayers.clear();

    // Load all stations in parallel
    const promises = stationsToRefresh.map(async (station) => {
        try {
            const res = await fetch(`/api/radar/${station}?field=${field}`);
            const data = await res.json();

            if (data.error) {
                console.warn(`Error refreshing ${station}:`, data.error);
                return;
            }

            const bounds = [[data.bounds.south, data.bounds.west],
                           [data.bounds.north, data.bounds.east]];

            const layer = L.imageOverlay(
                `data:image/png;base64,${data.image}`,
                bounds,
                { opacity: document.getElementById('opacitySlider').value / 100 }
            ).addTo(map);

            radarLayers.set(station, {
                layer: layer,
                bounds: data.bounds,
                timestamp: data.timestamp,
                field: field
            });
        } catch (err) {
            console.warn(`Error refreshing ${station}:`, err.message);
        }
    });

    await Promise.all(promises);
    updateLayerCount();
    saveLoadedStations();
    hideLoading();
}

// Timeline state
let cacheTimeline = [];
let activeTimeSlot = null;

function formatUtcToLocal(isoDatetime) {
    // Convert UTC datetime string to local time
    const utcDate = new Date(isoDatetime + 'Z'); // Append Z to indicate UTC
    return {
        time: utcDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }),
        date: utcDate.toLocaleDateString([], { month: '2-digit', day: '2-digit' }),
        full: utcDate.toLocaleString()
    };
}

async function refreshCacheTimeline() {
    const container = document.getElementById('timelineContainer');
    container.innerHTML = '<div class="timeline-empty">Loading cache info...</div>';

    try {
        const res = await fetch('/api/cache/timeline');
        const data = await res.json();
        cacheTimeline = data.slots || [];

        if (cacheTimeline.length === 0) {
            container.innerHTML = '<div class="timeline-empty">No cached data. Load some stations first.</div>';
            return;
        }

        // Render timeline slots (oldest to newest, left to right)
        container.innerHTML = cacheTimeline.map((slot, index) => {
            const local = formatUtcToLocal(slot.datetime);
            return `
                <div class="timeline-slot${activeTimeSlot === slot.slot_key ? ' active' : ''}"
                     onclick="loadTimeSlot(${index})"
                     title="${slot.stations.join(', ')} (${local.full})">
                    <span class="time">${local.time}</span>
                    <span class="date">${local.date}</span>
                    <span class="count">${slot.station_count} stn</span>
                </div>
            `;
        }).join('');

        // Scroll to the end (most recent)
        container.scrollLeft = container.scrollWidth;

    } catch (err) {
        console.error('Failed to load cache timeline:', err);
        container.innerHTML = '<div class="timeline-empty">Failed to load cache info</div>';
    }
}

async function loadTimeSlot(index) {
    const slot = cacheTimeline[index];
    if (!slot) return;

    activeTimeSlot = slot.slot_key;
    const field = document.getElementById('fieldSelect').value;

    showLoading(`Loading ${slot.station_count} stations from ${slot.display_time}...`);

    // Clear existing layers
    radarLayers.forEach((data) => {
        if (data.layer) {
            map.removeLayer(data.layer);
        }
    });
    radarLayers.clear();

    // Load all stations from this time slot
    const promises = slot.files.map(async ({ station }) => {
        try {
            const res = await fetch(`/api/radar/${station}/cached?field=${field}`);
            const data = await res.json();

            if (data.error) {
                console.warn(`Error loading ${station}:`, data.error);
                return;
            }

            const bounds = [[data.bounds.south, data.bounds.west],
                           [data.bounds.north, data.bounds.east]];

            const layer = L.imageOverlay(
                `data:image/png;base64,${data.image}`,
                bounds,
                { opacity: document.getElementById('opacitySlider').value / 100 }
            ).addTo(map);

            radarLayers.set(station, {
                layer: layer,
                bounds: data.bounds,
                timestamp: data.timestamp,
                field: field
            });
        } catch (err) {
            console.warn(`Error loading ${station}:`, err.message);
        }
    });

    await Promise.all(promises);
    updateLayerCount();
    saveLoadedStations();
    hideLoading();

    // Update timeline UI to show active slot
    refreshCacheTimeline();

    // Update time display with local time
    const local = formatUtcToLocal(slot.datetime);
    document.getElementById('timeInfo').textContent = `${local.date} ${local.time} (Local)`;

    // Fit map to show all loaded layers
    if (radarLayers.size > 0) {
        const allBounds = [];
        radarLayers.forEach((data) => {
            if (data.bounds) {
                allBounds.push([data.bounds.south, data.bounds.west]);
                allBounds.push([data.bounds.north, data.bounds.east]);
            }
        });
        if (allBounds.length > 0) {
            map.fitBounds(allBounds);
        }
    }
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

function saveLoadedStations() {
    // Save current loaded stations to localStorage
    const stationsList = [];
    radarLayers.forEach((data, code) => {
        stationsList.push({ station: code, field: data.field });
    });

    try {
        localStorage.setItem('nexrad_loaded_stations', JSON.stringify(stationsList));
    } catch (err) {
        console.warn('Failed to save loaded stations:', err);
    }
}

async function loadSavedStations() {
    // Load previously saved stations from localStorage
    try {
        const saved = localStorage.getItem('nexrad_loaded_stations');
        if (!saved) return;

        const stationsList = JSON.parse(saved);

        if (stationsList && stationsList.length > 0) {
            console.log(`Loading ${stationsList.length} saved stations...`);
            showLoading(`Restoring ${stationsList.length} saved station${stationsList.length !== 1 ? 's' : ''}...`);

            const field = document.getElementById('fieldSelect').value;

            // Load all saved stations in parallel
            const promises = stationsList.map(async ({ station, field: savedField }) => {
                try {
                    const useField = savedField || field;
                    const res = await fetch(`/api/radar/${station}?field=${useField}`);
                    const radarData = await res.json();

                    if (radarData.error) {
                        console.warn(`Error loading saved station ${station}:`, radarData.error);
                        return;
                    }

                    // Add radar image as overlay
                    const bounds = [[radarData.bounds.south, radarData.bounds.west],
                                   [radarData.bounds.north, radarData.bounds.east]];

                    const layer = L.imageOverlay(
                        `data:image/png;base64,${radarData.image}`,
                        bounds,
                        { opacity: document.getElementById('opacitySlider').value / 100 }
                    ).addTo(map);

                    // Store layer data
                    radarLayers.set(station, {
                        layer: layer,
                        bounds: radarData.bounds,
                        timestamp: radarData.timestamp,
                        field: useField
                    });
                } catch (err) {
                    console.warn(`Error loading saved station ${station}:`, err.message);
                }
            });

            await Promise.all(promises);
            updateLayerCount();
            hideLoading();

            // Fit map to show all loaded layers
            if (radarLayers.size > 0) {
                const allBounds = [];
                radarLayers.forEach((data) => {
                    if (data.bounds) {
                        allBounds.push([data.bounds.south, data.bounds.west]);
                        allBounds.push([data.bounds.north, data.bounds.east]);
                    }
                });
                if (allBounds.length > 0) {
                    map.fitBounds(allBounds);
                }
            }
        }
    } catch (err) {
        console.warn('Failed to load saved stations:', err);
    }
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
    saveLoadedStations();

    // If we removed the current station, clear the time info
    if (code === currentStation) {
        document.getElementById('timeInfo').textContent = '';
    }
}

function clearAllLayers() {
    radarLayers.forEach((data) => {
        if (data.layer) {
            map.removeLayer(data.layer);
        }
    });
    radarLayers.clear();
    updateLayerCount();
    saveLoadedStations();
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

        // Save loaded stations
        saveLoadedStations();

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
            try {
                const res = await fetch(`/api/radar/${station}/animation?field=${field}&frames=6`);
                const data = await res.json();
                return { station, data, success: true };
            } catch (err) {
                console.warn(`Failed to fetch animation for ${station}:`, err.message);
                return { station, data: null, success: false, error: err.message };
            }
        });

        const results = await Promise.all(fetchPromises);

        // Clear previous animation data
        animationData.clear();

        // Process results and build synced timeline
        const allTimestamps = new Set();
        const errors = [];

        results.forEach(({ station, data, success, error }) => {
            if (!success || !data) {
                errors.push(`${station}: ${error || 'unknown error'}`);
                return;
            }
            if (data.error) {
                errors.push(`${station}: ${data.error}`);
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

        // Log errors but continue with successful stations
        if (errors.length > 0) {
            console.warn('Some stations failed to load:', errors);
        }

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

    // Handle forecast mode
    if (forecastMode && forecastData.size > 0) {
        forecastData.forEach((frames, station) => {
            const frame = frames[index];
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
                field: document.getElementById('fieldSelect').value,
                is_forecast: true
            });
        });

        // Update layer list
        updateLoadedStationsList();

        // Update UI with forecast indicator
        const leadTime = forecastData.get(currentStation)?.[index]?.lead_time_min || (index + 1) * 5;
        document.getElementById('frameInfo').textContent = `+${leadTime} min (${index + 1}/${syncedTimestamps.length})`;
        document.getElementById('progressFill').style.width = `${((index + 1) / syncedTimestamps.length) * 100}%`;
        document.getElementById('timeInfo').textContent = `FORECAST: ${targetTimestamp}`;
        return;
    }

    // Normal animation mode
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
    forecastData.clear();
    forecastMode = false;
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

async function loadForecast() {
    stopAnimation();
    forecastMode = true;

    const station = document.getElementById('stationSelect').value;
    const field = document.getElementById('fieldSelect').value;
    currentStation = station;
    updateStationInfo();

    showLoading('Generating forecast (this may take a moment)...');

    try {
        const res = await fetch(`/api/radar/${station}/forecast?field=${field}&lead_times=6&timestep_min=5`);
        const data = await res.json();

        if (data.error) {
            hideLoading();
            alert('Forecast error: ' + data.error);
            return;
        }

        if (!data.frames || data.frames.length === 0) {
            hideLoading();
            alert('No forecast frames generated');
            return;
        }

        // Clear previous forecast data
        forecastData.clear();
        forecastData.set(station, data.frames);

        // Build synced timestamps from forecast
        syncedTimestamps = data.frames.map(f => f.timestamp);
        animationIndex = 0;

        // Show animation controls
        document.getElementById('animControls').style.display = 'block';

        // Display first forecast frame
        showFrame(0);

        // Start playing
        playAnimation();

        hideLoading();

    } catch (err) {
        hideLoading();
        alert('Forecast error: ' + err.message);
    }
}

function setRadarOpacity(opacity) {
    // Update opacity for all layers
    radarLayers.forEach((data) => {
        if (data.layer) {
            data.layer.setOpacity(opacity);
        }
    });
}

function toggleStationMarkers(visible) {
    stationMarkers.forEach((marker) => {
        if (visible) {
            marker.addTo(map);
        } else {
            map.removeLayer(marker);
        }
    });
}

// Drawing and selection functions
function initDrawControls() {
    // Check if Leaflet.Draw is loaded
    if (typeof L.Control.Draw === 'undefined') {
        console.error('Leaflet.Draw not loaded!');
        return;
    }

    // Create feature group for drawn shapes
    drawnItems = new L.FeatureGroup();
    map.addLayer(drawnItems);

    // Initialize draw control with toolbar
    const drawControl = new L.Control.Draw({
        position: 'topright',
        draw: {
            polygon: {
                shapeOptions: {
                    color: '#00d9ff',
                    fillColor: '#00d9ff',
                    fillOpacity: 0.1
                }
            },
            rectangle: {
                shapeOptions: {
                    color: '#00d9ff',
                    fillColor: '#00d9ff',
                    fillOpacity: 0.1
                }
            },
            circle: {
                shapeOptions: {
                    color: '#00d9ff',
                    fillColor: '#00d9ff',
                    fillOpacity: 0.1
                }
            },
            polyline: false,
            marker: false,
            circlemarker: false
        },
        edit: {
            featureGroup: drawnItems,
            remove: true
        }
    });
    map.addControl(drawControl);

    // Handle draw:created event
    map.on('draw:created', (e) => {
        // Clear previous selection
        clearStationSelection();
        drawnItems.clearLayers();

        // Add new shape
        drawnItems.addLayer(e.layer);

        // Select stations inside the shape
        selectStationsInShape(e.layer);
    });

    // Handle draw:deleted event - clear selection when shape is removed
    map.on('draw:deleted', () => {
        clearStationSelection();
    });

    // Handle draw:edited event - reselect when shape is modified
    map.on('draw:edited', (e) => {
        clearStationSelection();
        e.layers.eachLayer((layer) => {
            selectStationsInShape(layer);
        });
    });
}

function selectStationsInShape(layer) {
    const newlySelected = [];

    Object.entries(stations).forEach(([code, info]) => {
        const point = L.latLng(info.lat, info.lon);
        let isInside = false;

        if (layer instanceof L.Circle) {
            // For circles, check distance from center
            isInside = point.distanceTo(layer.getLatLng()) <= layer.getRadius();
        } else if (layer instanceof L.Polygon || layer instanceof L.Rectangle) {
            // For polygons/rectangles, check if point is inside bounds first (quick check)
            if (layer.getBounds().contains(point)) {
                // For rectangles, bounds check is sufficient
                if (layer instanceof L.Rectangle) {
                    isInside = true;
                } else {
                    // For polygons, use ray-casting algorithm
                    isInside = isPointInPolygon(point, layer);
                }
            }
        }

        if (isInside) {
            selectedStations.add(code);
            highlightStation(code, true);
            newlySelected.push(code);
        }
    });

    // Load radar for selected stations
    if (newlySelected.length > 0) {
        console.log(`Selected ${newlySelected.length} stations:`, newlySelected);
        loadRadarForStations(newlySelected);
    }
}

async function loadRadarForStations(stationCodes) {
    const field = document.getElementById('fieldSelect').value;

    // Filter out stations that already have radar loaded
    const toLoad = stationCodes.filter(code => !radarLayers.has(code));

    if (toLoad.length === 0) {
        console.log('All selected stations already loaded');
        return;
    }

    showLoading(`Loading radar for ${toLoad.length} station${toLoad.length !== 1 ? 's' : ''}...`);

    // Load all stations in parallel
    const promises = toLoad.map(async (station) => {
        try {
            const res = await fetch(`/api/radar/${station}?field=${field}`);
            const data = await res.json();

            if (data.error) {
                console.warn(`Error loading ${station}:`, data.error);
                return;
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
        } catch (err) {
            console.warn(`Error loading ${station}:`, err.message);
        }
    });

    await Promise.all(promises);

    // Update UI
    updateLayerCount();
    saveLoadedStations();
    hideLoading();
}

function isPointInPolygon(point, polygon) {
    // Ray-casting algorithm for point-in-polygon
    const latlngs = polygon.getLatLngs()[0]; // Get outer ring
    let inside = false;

    for (let i = 0, j = latlngs.length - 1; i < latlngs.length; j = i++) {
        const xi = latlngs[i].lat, yi = latlngs[i].lng;
        const xj = latlngs[j].lat, yj = latlngs[j].lng;

        const intersect = ((yi > point.lng) !== (yj > point.lng))
            && (point.lat < (xj - xi) * (point.lng - yi) / (yj - yi) + xi);

        if (intersect) inside = !inside;
    }

    return inside;
}

function highlightStation(code, selected) {
    const marker = stationMarkers.get(code);
    if (marker) {
        marker.setStyle({
            fillColor: selected ? '#ff6b6b' : '#00d9ff',
            radius: selected ? 8 : 6,
            fillOpacity: selected ? 0.9 : 0.6,
            weight: selected ? 2 : 1
        });

        // Bring selected markers to front
        if (selected) {
            marker.bringToFront();
        }
    }
}

function clearStationSelection() {
    selectedStations.forEach((code) => {
        highlightStation(code, false);
    });
    selectedStations.clear();
}

// Initialize on load
init();
