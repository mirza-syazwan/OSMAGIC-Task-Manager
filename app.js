class TaskManager {
    constructor() {
        this.geojsonData = null;
        this.sequences = [];
        this.currentIndex = 0;
        this.map = null;
        this.currentPreviewSequence = null;
        this.currentView = 'all'; // 'all', 'active', 'done', or 'skipped'
        this.navigatingToSequenceId = null; // Track sequence we're navigating to for highlighting
        this.allTasksSearchTerm = ''; // Track search term for "All Tasks" tab
        this.previewEditMode = false; // Track if preview is in edit mode
        this.originalPreviewFeatures = null; // Store original features for revert
        this.editableLayers = []; // Track editable layers
        
        this.init();
    }

    async init() {
        // Initialize IndexedDB
        try {
            await storageManager.init();
        } catch (error) {
            console.error('Failed to initialize IndexedDB:', error);
        }
        
        this.initializeEventListeners();
        await this.loadFromStorage();
    }

    initializeEventListeners() {
        const fileInput = document.getElementById('fileInput');
        const prevBtn = document.getElementById('prevBtn');
        const nextBtn = document.getElementById('nextBtn');

        if (fileInput) {
            fileInput.addEventListener('change', (e) => this.handleFileUpload(e));
        }

        if (prevBtn) {
            prevBtn.addEventListener('click', () => this.showPrevious());
        }

        if (nextBtn) {
            nextBtn.addEventListener('click', () => this.showNext());
        }
    }

    async handleFileUpload(event) {
        const files = Array.from(event.target.files);
        if (files.length === 0) return;

        const fileInfo = document.getElementById('fileInfo');
        if (fileInfo) {
            fileInfo.textContent = `Loading ${files.length} file(s)...`;
        }

        // Process all files with progress tracking
        const promises = files.map(file => {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = async (e) => {
                    try {
                        const fileName = file.name.toLowerCase();
                        let geojson;

                        // Detect file type and parse accordingly
                        if (fileName.endsWith('.gpx')) {
                            geojson = this.parseGPX(e.target.result);
                        } else if (fileName.endsWith('.csv')) {
                            // Use async CSV parsing for large files (> 100 rows)
                            const lineCount = (e.target.result.match(/\n/g) || []).length;
                            if (lineCount > 100) {
                                geojson = await this.parseCSVAsync(e.target.result, (progress) => {
                                    if (fileInfo && files.length === 1) {
                                        fileInfo.textContent = `Processing CSV: ${progress}%...`;
                                    }
                                });
                            } else {
                                geojson = this.parseCSV(e.target.result);
                            }
                        } else {
                            // Assume GeoJSON
                            geojson = JSON.parse(e.target.result);
                        }

                        resolve({ geojson, fileName: file.name });
                    } catch (error) {
                        reject({ error, fileName: file.name });
                    }
                };
                reader.onerror = () => reject({ error: new Error('Failed to read file'), fileName: file.name });
                reader.readAsText(file);
            });
        });

        // Combine all files into one GeoJSON
        const results = await Promise.allSettled(promises);
        const newFeatures = [];
        const errors = [];
        let loadedCount = 0;

        results.forEach((result) => {
            if (result.status === 'fulfilled') {
                newFeatures.push(...result.value.geojson.features);
                loadedCount++;
            } else {
                errors.push(`${result.reason.fileName}: ${result.reason.error.message}`);
            }
        });

        if (newFeatures.length === 0) {
            if (fileInfo) {
                fileInfo.textContent = `✗ Error: No valid files loaded. ${errors.join('; ')}`;
            }
            return;
        }

        // Merge with existing cached data instead of replacing
        const existingFeatures = this.geojsonData?.features || [];
        const allFeatures = [...existingFeatures, ...newFeatures];

        // Combine all features into one GeoJSON
        const combinedGeoJSON = {
            type: 'FeatureCollection',
            features: allFeatures
        };

        this.geojsonData = combinedGeoJSON;
        
        // Process with progress indicator for large datasets
        if (allFeatures.length > 50) {
            if (fileInfo) {
                fileInfo.textContent = `Processing ${allFeatures.length} features...`;
            }
            await this.processGeoJSONAsync(combinedGeoJSON, (progress) => {
                if (fileInfo) {
                    fileInfo.textContent = `Processing: ${progress}%...`;
                }
            });
            } else {
                await this.processGeoJSON(combinedGeoJSON);
            }
        
        // Save to IndexedDB
        await this.saveToStorage();
        
        const errorMsg = errors.length > 0 ? ` (${errors.length} error(s))` : '';
        const totalFeatures = allFeatures.length;
        const addedCount = newFeatures.length;
        const fileInfoText = `✓ Loaded ${loadedCount} file(s)${errorMsg}: ${addedCount} features (Total: ${totalFeatures} features)`;
        
        if (fileInfo) {
            fileInfo.textContent = fileInfoText;
        }
    }

    async processGeoJSON(geojson) {
        if (!geojson.features || !Array.isArray(geojson.features)) {
            throw new Error('Invalid GeoJSON: missing features array');
        }

        // Preserve existing status values
        const existingStatusMap = new Map();
        this.sequences.forEach(seq => {
            if (seq.status !== undefined) {
                existingStatusMap.set(String(seq.id), seq.status);
            }
        });

        // Group features by sequence ID
        const sequenceMap = new Map();

        geojson.features.forEach((feature) => {
            const sequenceId = String(
                feature.properties?.sequence_id || 
                feature.properties?.sequenceId || 
                feature.properties?.sequence || 
                feature.properties?.id ||
                feature.properties?.seq ||
                `sequence_${feature.properties?.id || Math.random().toString(36).substr(2, 9)}`
            );

            if (!sequenceMap.has(sequenceId)) {
                const existingStatus = existingStatusMap.get(sequenceId);
                sequenceMap.set(sequenceId, {
                    id: sequenceId,
                    features: [],
                    status: existingStatus !== undefined ? existingStatus : '', // blank = active
                    date: new Date().toLocaleDateString()
                });
            }

            sequenceMap.get(sequenceId).features.push(feature);
        });

        // Convert to array and calculate stats
        this.sequences = Array.from(sequenceMap.values()).map(seq => {
            const stats = this.calculateStats(seq.features);
            return {
                ...seq,
                featureCount: stats.features,
                nodeCount: stats.nodes,
                wayCount: stats.ways
            };
        });

        // Sort by sequence ID (numeric if possible, otherwise alphabetical)
        this.sequences.sort((a, b) => {
            const aNum = parseInt(a.id);
            const bNum = parseInt(b.id);
            if (!isNaN(aNum) && !isNaN(bNum)) {
                return aNum - bNum;
            }
            return a.id.localeCompare(b.id);
        });

        // Reset to first item in current view
        const viewSequences = this.getCurrentViewSequences();
        if (viewSequences.length > 0) {
            const firstSequence = viewSequences[0];
            this.currentIndex = this.sequences.findIndex(seq => seq.id === firstSequence.id);
        } else {
            this.currentIndex = 0;
        }

        this.geojsonData = geojson;
        await this.saveToStorage();
        this.renderCurrentTask();
        this.updateSummary();
    }

    async processGeoJSONAsync(geojson, progressCallback) {
        // Async version for large datasets - processes in chunks
        if (!geojson.features || !Array.isArray(geojson.features)) {
            console.error('Invalid GeoJSON: missing features array');
            return;
        }

        // Preserve existing status values
        const existingStatusMap = new Map();
        this.sequences.forEach(seq => {
            if (seq.status !== undefined) {
                existingStatusMap.set(String(seq.id), seq.status);
            }
        });

        // Group features by sequence ID - process in chunks
        const sequenceMap = new Map();
        const totalFeatures = geojson.features.length;
        const chunkSize = 100; // Process 100 features at a time

        for (let start = 0; start < totalFeatures; start += chunkSize) {
            const end = Math.min(start + chunkSize, totalFeatures);
            
            for (let i = start; i < end; i++) {
                const feature = geojson.features[i];
                const sequenceId = String(
                    feature.properties?.sequence_id || 
                    feature.properties?.sequenceId || 
                    feature.properties?.sequence || 
                    feature.properties?.id ||
                    feature.properties?.seq ||
                    `sequence_${feature.properties?.id || Math.random().toString(36).substr(2, 9)}`
                );

                if (!sequenceMap.has(sequenceId)) {
                    const existingStatus = existingStatusMap.get(sequenceId);
                    sequenceMap.set(sequenceId, {
                        id: sequenceId,
                        features: [],
                        status: existingStatus !== undefined ? existingStatus : '',
                        date: new Date().toLocaleDateString()
                    });
                }

                sequenceMap.get(sequenceId).features.push(feature);
            }

            // Update progress
            if (progressCallback) {
                const progress = Math.round((end / totalFeatures) * 50); // First 50% for grouping
                progressCallback(progress);
            }

            // Yield to browser
            await new Promise(resolve => setTimeout(resolve, 0));
        }

        // Calculate stats in chunks
        const sequences = Array.from(sequenceMap.values());
        const processedSequences = [];
        const statsChunkSize = 50;

        for (let start = 0; start < sequences.length; start += statsChunkSize) {
            const end = Math.min(start + statsChunkSize, sequences.length);
            
            for (let i = start; i < end; i++) {
                const seq = sequences[i];
                const stats = this.calculateStats(seq.features);
                processedSequences.push({
                    ...seq,
                    featureCount: stats.features,
                    nodeCount: stats.nodes,
                    wayCount: stats.ways
                });
            }

            // Update progress
            if (progressCallback) {
                const progress = 50 + Math.round((end / sequences.length) * 50); // Second 50% for stats
                progressCallback(progress);
            }

            // Yield to browser
            await new Promise(resolve => setTimeout(resolve, 0));
        }

        // Sort by sequence ID
        processedSequences.sort((a, b) => {
            const aNum = parseInt(a.id);
            const bNum = parseInt(b.id);
            if (!isNaN(aNum) && !isNaN(bNum)) {
                return aNum - bNum;
            }
            return a.id.localeCompare(b.id);
        });

        this.sequences = processedSequences;
        this.geojsonData = geojson;
        
        // Reset to first item in current view
        const viewSequences = this.getCurrentViewSequences();
        if (viewSequences.length > 0) {
            const firstSequence = viewSequences[0];
            this.currentIndex = this.sequences.findIndex(seq => seq.id === firstSequence.id);
        } else {
            this.currentIndex = 0;
        }
        
        await this.saveToStorage();
        this.renderCurrentTask();
        this.updateSummary();
    }

    calculateStats(features) {
        let nodes = 0;
        let ways = 0;

        features.forEach(feature => {
            if (feature.geometry) {
                if (feature.geometry.type === 'Point') {
                    nodes++;
                } else if (feature.geometry.type === 'LineString' || feature.geometry.type === 'MultiLineString') {
                    ways++;
                    if (feature.geometry.coordinates) {
                        if (Array.isArray(feature.geometry.coordinates[0])) {
                            nodes += feature.geometry.coordinates.length;
                        } else {
                            nodes += 1;
                        }
                    }
                } else if (feature.geometry.type === 'Polygon' || feature.geometry.type === 'MultiPolygon') {
                    ways++;
                    if (feature.geometry.coordinates && feature.geometry.coordinates[0]) {
                        nodes += feature.geometry.coordinates[0].length;
                    }
                }
            }
        });

        return {
            features: features.length,
            nodes: nodes,
            ways: ways
        };
    }

    parseGPX(gpxText) {
        // Parse GPX XML to GeoJSON format
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(gpxText, 'text/xml');
        
        const features = [];
        
        // Parse tracks
        const tracks = xmlDoc.getElementsByTagName('trk');
        for (const track of tracks) {
            const segments = track.getElementsByTagName('trkseg');
            for (const segment of segments) {
                const points = segment.getElementsByTagName('trkpt');
                const coordinates = [];
                
                for (const point of points) {
                    const lat = parseFloat(point.getAttribute('lat'));
                    const lon = parseFloat(point.getAttribute('lon'));
                    if (!isNaN(lat) && !isNaN(lon)) {
                        coordinates.push([lon, lat]);
                    }
                }
                
                if (coordinates.length > 0) {
                    features.push({
                        type: 'Feature',
                        geometry: {
                            type: 'LineString',
                            coordinates: coordinates
                        },
                        properties: {
                            sequence_id: this.extractSequenceIdFromGPX(track) || `gpx_track_${features.length + 1}`
                        }
                    });
                }
            }
        }
        
        // Parse routes
        const routes = xmlDoc.getElementsByTagName('rte');
        for (const route of routes) {
            const points = route.getElementsByTagName('rtept');
            const coordinates = [];
            
            for (const point of points) {
                const lat = parseFloat(point.getAttribute('lat'));
                const lon = parseFloat(point.getAttribute('lon'));
                if (!isNaN(lat) && !isNaN(lon)) {
                    coordinates.push([lon, lat]);
                }
            }
            
            if (coordinates.length > 0) {
                features.push({
                    type: 'Feature',
                    geometry: {
                        type: 'LineString',
                        coordinates: coordinates
                    },
                    properties: {
                        sequence_id: this.extractSequenceIdFromGPX(route) || `gpx_route_${features.length + 1}`
                    }
                });
            }
        }
        
        // Parse waypoints as points
        const waypoints = xmlDoc.getElementsByTagName('wpt');
        for (const waypoint of waypoints) {
            const lat = parseFloat(waypoint.getAttribute('lat'));
            const lon = parseFloat(waypoint.getAttribute('lon'));
            if (!isNaN(lat) && !isNaN(lon)) {
                const nameEl = waypoint.getElementsByTagName('name')[0];
                const name = nameEl ? nameEl.textContent : '';
                
                features.push({
                    type: 'Feature',
                    geometry: {
                        type: 'Point',
                        coordinates: [lon, lat]
                    },
                    properties: {
                        name: name,
                        sequence_id: name || `gpx_waypoint_${features.length + 1}`
                    }
                });
            }
        }
        
        return {
            type: 'FeatureCollection',
            features: features
        };
    }

    extractSequenceIdFromGPX(element) {
        // Try to find sequence ID in name, desc, or extensions
        const nameEl = element.getElementsByTagName('name')[0];
        if (nameEl) {
            const name = nameEl.textContent.trim();
            // Check if name contains a sequence ID pattern
            const seqMatch = name.match(/(?:sequence[_\s]?id|seq[_\s]?id|id)[:\s=]+(\d+)/i);
            if (seqMatch) {
                return seqMatch[1];
            }
            // If name is just a number, use it as sequence ID
            if (/^\d+$/.test(name)) {
                return name;
            }
        }
        return null;
    }

    parseCSV(csvText) {
        // Synchronous version for small files (< 100 rows)
        return this.parseCSVSync(csvText);
    }

    async parseCSVAsync(csvText, progressCallback) {
        // Async version for large files - processes in chunks
        const lines = csvText.split('\n').filter(line => line.trim());
        if (lines.length < 2) {
            throw new Error('CSV file must have at least a header row and one data row');
        }

        // Parse header
        const header = this.parseCSVLine(lines[0]);
        
        // Find columns (case-insensitive)
        let latLongArrayIndex = -1;
        let latIndex = -1;
        let lonIndex = -1;
        let sequenceIdIndex = -1;
        
        const latLongArrayNames = ['lat_long_array', 'latlongarray', 'coordinates', 'coords', 'points'];
        const latNames = ['lat', 'latitude', 'y', 'ycoord'];
        const lonNames = ['lon', 'lng', 'longitude', 'long', 'x', 'xcoord'];
        const seqIdNames = ['offroad_sequence_id', 'sequence_id', 'sequenceid', 'sequence', 'seq', 'id'];
        
        header.forEach((col, index) => {
            const colLower = col.toLowerCase().trim();
            if (latLongArrayIndex === -1 && latLongArrayNames.some(name => colLower === name)) {
                latLongArrayIndex = index;
            }
            if (latIndex === -1 && latNames.some(name => colLower.includes(name))) {
                latIndex = index;
            }
            if (lonIndex === -1 && lonNames.some(name => colLower.includes(name))) {
                lonIndex = index;
            }
            if (sequenceIdIndex === -1 && seqIdNames.some(name => colLower === name)) {
                sequenceIdIndex = index;
            }
        });

        // Check if we have lat_long_array format or separate lat/lon columns
        if (latLongArrayIndex === -1 && (latIndex === -1 || lonIndex === -1)) {
            throw new Error('CSV must contain either:\n1. A lat_long_array column with coordinate arrays, OR\n2. Separate latitude and longitude columns');
        }

        // Group rows by sequence ID - process in chunks
        const sequenceMap = new Map();
        const totalRows = lines.length - 1;
        const chunkSize = 50; // Process 50 rows at a time
        
        for (let start = 1; start < lines.length; start += chunkSize) {
            const end = Math.min(start + chunkSize, lines.length);
            
            for (let i = start; i < end; i++) {
                const row = this.parseCSVLine(lines[i]);
                if (row.length === 0) continue;
                
                // Get sequence ID
                let sequenceId;
                if (sequenceIdIndex >= 0 && row[sequenceIdIndex] && row[sequenceIdIndex].trim()) {
                    sequenceId = String(row[sequenceIdIndex]).trim();
                } else {
                    const groupIndex = header.findIndex(col => col.toLowerCase().trim() === 'group');
                    if (groupIndex >= 0 && row[groupIndex] && row[groupIndex].trim()) {
                        sequenceId = String(row[groupIndex]).trim();
                    } else {
                        sequenceId = `csv_sequence_${i}`;
                    }
                }
                
                if (!sequenceMap.has(sequenceId)) {
                    sequenceMap.set(sequenceId, {
                        id: sequenceId,
                        coordinates: [],
                        properties: {},
                        rowCount: 0
                    });
                }
                
                const sequence = sequenceMap.get(sequenceId);
                sequence.rowCount++;
                
                // Merge properties
                if (sequence.rowCount === 1) {
                    header.forEach((colName, idx) => {
                        if (row[idx] && row[idx].trim()) {
                            sequence.properties[colName.trim()] = row[idx].trim();
                        }
                    });
                } else {
                    header.forEach((colName, idx) => {
                        const colLower = colName.toLowerCase().trim();
                        if (row[idx] && row[idx].trim()) {
                            if (colLower === 'bookingcodes' || colLower === 'wheels') {
                                try {
                                    const existing = JSON.parse(sequence.properties[colName] || '[]');
                                    const newArray = JSON.parse(row[idx].trim());
                                    if (Array.isArray(existing) && Array.isArray(newArray)) {
                                        const merged = [...new Set([...existing, ...newArray])];
                                        sequence.properties[colName] = JSON.stringify(merged);
                                    }
                                } catch (e) {
                                    // Keep existing value if merge fails
                                }
                            }
                        }
                    });
                }
                
                // Extract coordinates
                let rowCoordinates = [];
                if (latLongArrayIndex >= 0 && row[latLongArrayIndex]) {
                    try {
                        const arrayStr = row[latLongArrayIndex].trim();
                        const coordArray = JSON.parse(arrayStr);
                        if (Array.isArray(coordArray)) {
                            rowCoordinates = coordArray.map(coord => {
                                if (Array.isArray(coord) && coord.length >= 2) {
                                    return [parseFloat(coord[1]), parseFloat(coord[0])];
                                }
                                return null;
                            }).filter(coord => coord !== null && !isNaN(coord[0]) && !isNaN(coord[1]));
                        }
                    } catch (e) {
                        // Skip invalid coordinates
                    }
                } else if (latIndex >= 0 && lonIndex >= 0) {
                    const lat = parseFloat(row[latIndex]);
                    const lon = parseFloat(row[lonIndex]);
                    if (!isNaN(lat) && !isNaN(lon)) {
                        rowCoordinates = [[lon, lat]];
                    }
                }
                
                if (rowCoordinates.length > 0) {
                    sequence.coordinates.push(...rowCoordinates);
                }
            }
            
            // Update progress and yield to browser
            if (progressCallback) {
                const progress = Math.round(((end - 1) / totalRows) * 100);
                progressCallback(progress);
            }
            
            // Yield to browser to prevent blocking
            await new Promise(resolve => setTimeout(resolve, 0));
        }

        // Convert sequences to features
        const features = [];
        sequenceMap.forEach((sequence) => {
            if (sequence.coordinates.length === 0) return;
            
            sequence.properties.sequence_id = sequence.id;
            
            if (sequence.coordinates.length === 1) {
                features.push({
                    type: 'Feature',
                    geometry: {
                        type: 'Point',
                        coordinates: sequence.coordinates[0]
                    },
                    properties: sequence.properties
                });
            } else {
                features.push({
                    type: 'Feature',
                    geometry: {
                        type: 'LineString',
                        coordinates: sequence.coordinates
                    },
                    properties: sequence.properties
                });
            }
        });

        return {
            type: 'FeatureCollection',
            features: features
        };
    }

    parseCSVSync(csvText) {
        // Synchronous version for small files
        const lines = csvText.split('\n').filter(line => line.trim());
        if (lines.length < 2) {
            throw new Error('CSV file must have at least a header row and one data row');
        }

        const header = this.parseCSVLine(lines[0]);
        
        let latLongArrayIndex = -1;
        let latIndex = -1;
        let lonIndex = -1;
        let sequenceIdIndex = -1;
        
        const latLongArrayNames = ['lat_long_array', 'latlongarray', 'coordinates', 'coords', 'points'];
        const latNames = ['lat', 'latitude', 'y', 'ycoord'];
        const lonNames = ['lon', 'lng', 'longitude', 'long', 'x', 'xcoord'];
        const seqIdNames = ['offroad_sequence_id', 'sequence_id', 'sequenceid', 'sequence', 'seq', 'id'];
        
        header.forEach((col, index) => {
            const colLower = col.toLowerCase().trim();
            if (latLongArrayIndex === -1 && latLongArrayNames.some(name => colLower === name)) {
                latLongArrayIndex = index;
            }
            if (latIndex === -1 && latNames.some(name => colLower.includes(name))) {
                latIndex = index;
            }
            if (lonIndex === -1 && lonNames.some(name => colLower.includes(name))) {
                lonIndex = index;
            }
            if (sequenceIdIndex === -1 && seqIdNames.some(name => colLower === name)) {
                sequenceIdIndex = index;
            }
        });

        if (latLongArrayIndex === -1 && (latIndex === -1 || lonIndex === -1)) {
            throw new Error('CSV must contain either:\n1. A lat_long_array column with coordinate arrays, OR\n2. Separate latitude and longitude columns');
        }

        const sequenceMap = new Map();
        
        for (let i = 1; i < lines.length; i++) {
            const row = this.parseCSVLine(lines[i]);
            if (row.length === 0) continue;
            
            let sequenceId;
            if (sequenceIdIndex >= 0 && row[sequenceIdIndex] && row[sequenceIdIndex].trim()) {
                sequenceId = String(row[sequenceIdIndex]).trim();
            } else {
                const groupIndex = header.findIndex(col => col.toLowerCase().trim() === 'group');
                if (groupIndex >= 0 && row[groupIndex] && row[groupIndex].trim()) {
                    sequenceId = String(row[groupIndex]).trim();
                } else {
                    sequenceId = `csv_sequence_${i}`;
                }
            }
            
            if (!sequenceMap.has(sequenceId)) {
                sequenceMap.set(sequenceId, {
                    id: sequenceId,
                    coordinates: [],
                    properties: {},
                    rowCount: 0
                });
            }
            
            const sequence = sequenceMap.get(sequenceId);
            sequence.rowCount++;
            
            if (sequence.rowCount === 1) {
                header.forEach((colName, idx) => {
                    if (row[idx] && row[idx].trim()) {
                        sequence.properties[colName.trim()] = row[idx].trim();
                    }
                });
            } else {
                header.forEach((colName, idx) => {
                    const colLower = colName.toLowerCase().trim();
                    if (row[idx] && row[idx].trim()) {
                        if (colLower === 'bookingcodes' || colLower === 'wheels') {
                            try {
                                const existing = JSON.parse(sequence.properties[colName] || '[]');
                                const newArray = JSON.parse(row[idx].trim());
                                if (Array.isArray(existing) && Array.isArray(newArray)) {
                                    const merged = [...new Set([...existing, ...newArray])];
                                    sequence.properties[colName] = JSON.stringify(merged);
                                }
                            } catch (e) {
                                // Keep existing value
                            }
                        }
                    }
                });
            }
            
            let rowCoordinates = [];
            if (latLongArrayIndex >= 0 && row[latLongArrayIndex]) {
                try {
                    const arrayStr = row[latLongArrayIndex].trim();
                    const coordArray = JSON.parse(arrayStr);
                    if (Array.isArray(coordArray)) {
                        rowCoordinates = coordArray.map(coord => {
                            if (Array.isArray(coord) && coord.length >= 2) {
                                return [parseFloat(coord[1]), parseFloat(coord[0])];
                            }
                            return null;
                        }).filter(coord => coord !== null && !isNaN(coord[0]) && !isNaN(coord[1]));
                    }
                } catch (e) {
                    // Skip invalid
                }
            } else if (latIndex >= 0 && lonIndex >= 0) {
                const lat = parseFloat(row[latIndex]);
                const lon = parseFloat(row[lonIndex]);
                if (!isNaN(lat) && !isNaN(lon)) {
                    rowCoordinates = [[lon, lat]];
                }
            }
            
            if (rowCoordinates.length > 0) {
                sequence.coordinates.push(...rowCoordinates);
            }
        }

        const features = [];
        sequenceMap.forEach((sequence) => {
            if (sequence.coordinates.length === 0) return;
            
            sequence.properties.sequence_id = sequence.id;
            
            if (sequence.coordinates.length === 1) {
                features.push({
                    type: 'Feature',
                    geometry: {
                        type: 'Point',
                        coordinates: sequence.coordinates[0]
                    },
                    properties: sequence.properties
                });
            } else {
                features.push({
                    type: 'Feature',
                    geometry: {
                        type: 'LineString',
                        coordinates: sequence.coordinates
                    },
                    properties: sequence.properties
                });
            }
        });

        return {
            type: 'FeatureCollection',
            features: features
        };
    }

    parseCSVLine(line) {
        // Simple CSV parser that handles quoted fields
        const result = [];
        let current = '';
        let inQuotes = false;
        
        for (let i = 0; i < line.length; i++) {
            const char = line[i];
            
            if (char === '"') {
                inQuotes = !inQuotes;
            } else if (char === ',' && !inQuotes) {
                result.push(current.trim());
                current = '';
            } else {
                current += char;
            }
        }
        result.push(current.trim());
        
        return result;
    }

    getAllSequences() {
        // Return all sequences regardless of status (master data source)
        return this.sequences;
    }

    getActiveSequences() {
        // Return sequences that are not skipped or done (blank status = active)
        return this.sequences.filter(seq => !seq.status || seq.status === '');
    }

    getDoneSequences() {
        // Return sequences that are marked as done
        return this.sequences.filter(seq => seq.status === 'done');
    }

    getSkippedSequences() {
        // Return sequences that are marked as skipped
        return this.sequences.filter(seq => seq.status === 'skipped');
    }

    getCurrentViewSequences() {
        // Return sequences based on current view
        switch(this.currentView) {
            case 'all':
                return this.getAllSequences();
            case 'done':
                return this.getDoneSequences();
            case 'skipped':
                return this.getSkippedSequences();
            case 'active':
            default:
                return this.getActiveSequences();
        }
    }

    switchView(view, targetSequenceId = null) {
        this.currentView = view;
        
        // Update tab buttons
        document.querySelectorAll('.tab-btn').forEach(btn => {
            if (btn.dataset.view === view) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        });
        
        // If targetSequenceId is provided, navigate to that specific sequence
        if (targetSequenceId !== null) {
            const targetIndex = this.sequences.findIndex(seq => seq.id === targetSequenceId);
            if (targetIndex >= 0) {
                this.currentIndex = targetIndex;
                this.renderCurrentTask();
                return;
            }
        }
        
        // Reset to first item in the new view
        const viewSequences = this.getCurrentViewSequences();
        if (viewSequences.length > 0) {
            const firstSequence = viewSequences[0];
            this.currentIndex = this.sequences.findIndex(seq => seq.id === firstSequence.id);
        } else {
            this.currentIndex = 0;
        }
        
        this.renderCurrentTask();
    }

    navigateToSequence(sequenceId) {
        // Find the sequence in our data
        const sequence = this.sequences.find(seq => seq.id === sequenceId);
        if (!sequence) {
            console.error('Sequence not found:', sequenceId);
            return;
        }

        // Set flag to indicate we're navigating to this sequence (for highlighting)
        this.navigatingToSequenceId = sequenceId;

        // Determine which tab this sequence belongs to based on status
        let targetView = 'active'; // default to active
        if (sequence.status === 'done') {
            targetView = 'done';
        } else if (sequence.status === 'skipped') {
            targetView = 'skipped';
        } else {
            targetView = 'active';
        }

        // Switch to the appropriate tab and navigate to the sequence
        this.switchView(targetView, sequenceId);
    }

    renderCurrentTask() {
        // Route to appropriate render method based on view
        switch(this.currentView) {
            case 'all':
                this.renderAllTasksView();
                break;
            case 'skipped':
            case 'done':
                this.renderSimpleListView();
                break;
            case 'active':
            default:
                this.renderDetailedView();
                break;
        }
    }

    renderAllTasksView() {
        const taskDisplay = document.getElementById('taskDisplay');
        const prevBtn = document.getElementById('prevBtn');
        const nextBtn = document.getElementById('nextBtn');
        const taskCounter = document.getElementById('taskCounter');

        const allSequences = this.getAllSequences();
        
        if (allSequences.length === 0) {
            taskDisplay.innerHTML = `
                <div class="empty-state">
                    <p>No tasks found. Upload a file to begin.</p>
                </div>
            `;
            if (prevBtn) prevBtn.style.display = 'none';
            if (nextBtn) nextBtn.style.display = 'none';
            if (taskCounter) taskCounter.textContent = '';
            return;
        }

        // Hide navigation for "All Tasks" - show full list
        if (prevBtn) prevBtn.style.display = 'none';
        if (nextBtn) nextBtn.style.display = 'none';

        // Filter sequences based on search term
        const searchTerm = this.allTasksSearchTerm.toLowerCase().trim();
        const filteredSequences = searchTerm 
            ? allSequences.filter(seq => String(seq.id).toLowerCase().includes(searchTerm))
            : allSequences;

        if (taskCounter) {
            if (searchTerm) {
                taskCounter.textContent = `Showing ${filteredSequences.length} of ${allSequences.length} sequences`;
            } else {
                taskCounter.textContent = `Total: ${allSequences.length} sequences`;
            }
        }

        // Render simple list of all sequence IDs (clickable)
        const sequenceList = filteredSequences.map(seq => {
            const escapedId = String(seq.id).replace(/'/g, "\\'").replace(/"/g, "&quot;");
            return `<div class="sequence-id-item clickable" data-sequence-id="${escapedId}" onclick="taskManager.navigateToSequence('${escapedId}')">${seq.id}</div>`;
        }).join('');

        taskDisplay.innerHTML = `
            <div class="all-tasks-list">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; flex-wrap: wrap; gap: 10px;">
                    <h4>All Sequence IDs (${allSequences.length} total)</h4>
                    <div style="display: flex; gap: 10px; align-items: center; flex-wrap: wrap;">
                        <div style="position: relative; flex: 1; min-width: 200px;">
                            <input 
                                type="text" 
                                id="allTasksSearchInput" 
                                class="search-input" 
                                placeholder="🔍 Search sequence ID..." 
                                value="${this.allTasksSearchTerm}"
                                oninput="taskManager.handleAllTasksSearch(this.value)"
                            />
                        </div>
                        <button class="btn btn-primary" onclick="taskManager.exportAllToCSV()" style="white-space: nowrap;">
                            📊 Export to CSV
                        </button>
                    </div>
                </div>
                ${filteredSequences.length === 0 && searchTerm ? `
                    <div class="empty-state">
                        <p>No sequences found matching "${this.allTasksSearchTerm}"</p>
                    </div>
                ` : `
                    <div class="sequence-list">
                        ${sequenceList}
                    </div>
                `}
            </div>
        `;
    }

    handleAllTasksSearch(searchTerm) {
        this.allTasksSearchTerm = searchTerm;
        
        // Get the search input element to preserve focus and cursor position
        const searchInput = document.getElementById('allTasksSearchInput');
        const wasFocused = document.activeElement === searchInput;
        const cursorPosition = searchInput ? searchInput.selectionStart : null;
        
        // Re-render the view
        this.renderAllTasksView();
        
        // Restore focus and cursor position if it was focused
        if (wasFocused) {
            // Use requestAnimationFrame to ensure DOM is updated
            requestAnimationFrame(() => {
                const newSearchInput = document.getElementById('allTasksSearchInput');
                if (newSearchInput) {
                    newSearchInput.focus();
                    // Set cursor position, accounting for the new value length
                    const newCursorPos = cursorPosition !== null 
                        ? Math.min(cursorPosition, newSearchInput.value.length) 
                        : newSearchInput.value.length;
                    newSearchInput.setSelectionRange(newCursorPos, newCursorPos);
                }
            });
        }
    }

    renderSimpleListView() {
        const taskDisplay = document.getElementById('taskDisplay');
        const prevBtn = document.getElementById('prevBtn');
        const nextBtn = document.getElementById('nextBtn');
        const taskCounter = document.getElementById('taskCounter');

        const viewSequences = this.getCurrentViewSequences();
        
        if (viewSequences.length === 0) {
            const viewName = this.currentView === 'done' ? 'done' : 'skipped';
            taskDisplay.innerHTML = `
                <div class="empty-state">
                    <p>No ${viewName} tasks found.</p>
                </div>
            `;
            if (prevBtn) prevBtn.style.display = 'none';
            if (nextBtn) nextBtn.style.display = 'none';
            if (taskCounter) taskCounter.textContent = '';
            return;
        }

        // Hide navigation for list view
        if (prevBtn) prevBtn.style.display = 'none';
        if (nextBtn) nextBtn.style.display = 'none';
        if (taskCounter) taskCounter.textContent = `${viewSequences.length} ${this.currentView} sequence(s)`;

        // Render full list: Sequence ID + Status dropdown for each
        const viewName = this.currentView === 'done' ? 'Done' : 'Skipped';
        const sequenceList = viewSequences.map(seq => {
            const escapedId = String(seq.id).replace(/'/g, "\\'");
            const isTarget = this.navigatingToSequenceId && String(seq.id) === String(this.navigatingToSequenceId);
            return `
                <div class="sequence-item-with-status" data-sequence-id="${seq.id}" ${isTarget ? 'data-highlight="true"' : ''}>
                    <div class="sequence-id-display">${seq.id}</div>
                    <select class="status-dropdown-inline" data-sequence-id="${seq.id}" onchange="taskManager.updateStatus('${escapedId}', this.value)">
                        <option value="" ${!seq.status || seq.status === '' ? 'selected' : ''}>Active (Blank)</option>
                        <option value="skipped" ${seq.status === 'skipped' ? 'selected' : ''}>Skipped</option>
                        <option value="done" ${seq.status === 'done' ? 'selected' : ''}>Done</option>
                    </select>
                </div>
            `;
        }).join('');

        taskDisplay.innerHTML = `
            <div class="simple-list-view">
                <h4>${viewName} Sequences (${viewSequences.length} total)</h4>
                <div class="sequence-list-with-status">
                    ${sequenceList}
                </div>
            </div>
        `;

        // If we navigated here via navigateToSequence, scroll to and highlight the target
        if (this.navigatingToSequenceId) {
            const targetSequenceId = this.navigatingToSequenceId;
            setTimeout(() => {
                const targetElement = document.querySelector(`[data-sequence-id="${targetSequenceId}"]`);
                if (targetElement) {
                    targetElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    targetElement.classList.add('highlighted');
                    setTimeout(() => {
                        targetElement.classList.remove('highlighted');
                        this.navigatingToSequenceId = null; // Clear the flag after highlighting
                    }, 2000);
                } else {
                    this.navigatingToSequenceId = null; // Clear flag if element not found
                }
            }, 100);
        }
    }

    renderDetailedView() {
        const taskDisplay = document.getElementById('taskDisplay');
        const prevBtn = document.getElementById('prevBtn');
        const nextBtn = document.getElementById('nextBtn');
        const taskCounter = document.getElementById('taskCounter');

        const viewSequences = this.getActiveSequences();
        
        if (viewSequences.length === 0) {
            taskDisplay.innerHTML = `
                <div class="empty-state">
                    <p>No active tasks found.</p>
                </div>
            `;
            if (prevBtn) prevBtn.disabled = true;
            if (nextBtn) nextBtn.disabled = true;
            if (taskCounter) taskCounter.textContent = '';
            return;
        }

        // Show navigation
        if (prevBtn) {
            prevBtn.style.display = 'inline-block';
            prevBtn.disabled = false;
        }
        if (nextBtn) {
            nextBtn.style.display = 'inline-block';
            nextBtn.disabled = false;
        }

        // Ensure current index is valid
        const currentSequence = this.sequences[this.currentIndex];
        let currentViewIndex = viewSequences.findIndex(seq => seq.id === currentSequence?.id);
        
        if (currentViewIndex < 0) {
            const firstSequence = viewSequences[0];
            this.currentIndex = this.sequences.findIndex(seq => seq.id === firstSequence.id);
            currentViewIndex = 0;
        }

        const finalSequence = this.sequences[this.currentIndex];
        currentViewIndex = viewSequences.findIndex(seq => seq.id === finalSequence.id);

        // Update counter
        if (taskCounter) {
            taskCounter.textContent = `Task ${currentViewIndex + 1} of ${viewSequences.length}`;
        }

        // Update navigation buttons
        if (prevBtn) {
            prevBtn.disabled = currentViewIndex <= 0;
        }
        if (nextBtn) {
            nextBtn.disabled = currentViewIndex >= viewSequences.length - 1;
        }

        // Render full detailed view with all metadata (pulls from "All" tab data)
        const displaySequence = finalSequence;
        taskDisplay.innerHTML = `
            <div class="task-card">
                <div class="task-id">
                    <span class="task-id-label">Sequence ID</span>
                    ${displaySequence.id}
                </div>
                
                <div class="task-details">
                    <div class="detail-item">
                        <div class="detail-label">Features</div>
                        <div class="detail-value">${displaySequence.features ? this.calculateStats(displaySequence.features).features : (displaySequence.featureCount || 0)}</div>
                    </div>
                    <div class="detail-item">
                        <div class="detail-label">Nodes</div>
                        <div class="detail-value">${displaySequence.features ? this.calculateStats(displaySequence.features).nodes : (displaySequence.nodeCount || 0)}</div>
                    </div>
                    <div class="detail-item">
                        <div class="detail-label">Ways</div>
                        <div class="detail-value">${displaySequence.features ? this.calculateStats(displaySequence.features).ways : (displaySequence.wayCount || 0)}</div>
                    </div>
                </div>

                <div class="status-section">
                    <label class="status-label" for="statusDropdown">Status</label>
                    <select id="statusDropdown" class="status-dropdown" data-sequence-id="${displaySequence.id}">
                        <option value="" ${!displaySequence.status || displaySequence.status === '' ? 'selected' : ''}>Active (Blank)</option>
                        <option value="skipped" ${displaySequence.status === 'skipped' ? 'selected' : ''}>Skipped</option>
                        <option value="done" ${displaySequence.status === 'done' ? 'selected' : ''}>Done</option>
                    </select>
                </div>

                <div class="action-buttons">
                    <button class="action-btn btn-export" onclick="taskManager.exportToJOSM('${displaySequence.id}')">
                        📥 Export to JOSM
                    </button>
                    <button class="action-btn btn-preview" onclick="taskManager.previewSequence('${displaySequence.id}')">
                        👁️ Preview GeoJSON
                    </button>
                </div>
            </div>
        `;

        // Add event listener for status dropdown
        const statusDropdown = document.getElementById('statusDropdown');
        if (statusDropdown) {
            statusDropdown.addEventListener('change', (e) => {
                this.updateStatus(displaySequence.id, e.target.value);
            });
        }
    }

    findNextActiveIndex() {
        const activeSequences = this.getActiveSequences();
        if (activeSequences.length === 0) {
            this.currentIndex = 0;
            return;
        }

        // Find current sequence in active list
        const currentSequence = this.sequences[this.currentIndex];
        const currentActiveIndex = activeSequences.findIndex(seq => seq.id === currentSequence?.id);
        
        if (currentActiveIndex >= 0) {
            // Find the index in full sequences array
            this.currentIndex = this.sequences.findIndex(seq => seq.id === activeSequences[currentActiveIndex].id);
        } else {
            // Current is not active, find first active
            this.currentIndex = this.sequences.findIndex(seq => seq.id === activeSequences[0].id);
        }
    }


    async updateStatus(sequenceId, newStatus) {
        const sequence = this.sequences.find(s => String(s.id) === String(sequenceId));
        if (sequence) {
            sequence.status = newStatus;
            await this.saveToStorage();
            
            // If in 'all' view, stay in 'all' view (don't auto-switch)
            if (this.currentView === 'all') {
                // Stay in current view, just update
                this.renderCurrentTask();
            } else {
                // For other views, check if sequence should still be visible
                const viewSequences = this.getCurrentViewSequences();
                const stillInView = viewSequences.find(seq => seq.id === sequenceId);
                if (!stillInView && viewSequences.length > 0) {
                    // Current sequence no longer in view, go to first in view
                    const firstSequence = viewSequences[0];
                    this.currentIndex = this.sequences.findIndex(seq => seq.id === firstSequence.id);
                }
                this.renderCurrentTask();
            }
            
            this.updateSummary();
        }
    }

    showPrevious() {
        const viewSequences = this.getCurrentViewSequences();
        if (viewSequences.length === 0) return;

        const currentSequence = this.sequences[this.currentIndex];
        const currentViewIndex = viewSequences.findIndex(seq => String(seq.id) === String(currentSequence?.id));

        if (currentViewIndex > 0) {
            const prevSequence = viewSequences[currentViewIndex - 1];
            this.currentIndex = this.sequences.findIndex(seq => String(seq.id) === String(prevSequence.id));
            this.renderCurrentTask();
        }
    }

    showNext() {
        const viewSequences = this.getCurrentViewSequences();
        if (viewSequences.length === 0) return;

        const currentSequence = this.sequences[this.currentIndex];
        const currentViewIndex = viewSequences.findIndex(seq => String(seq.id) === String(currentSequence?.id));

        if (currentViewIndex < viewSequences.length - 1) {
            const nextSequence = viewSequences[currentViewIndex + 1];
            this.currentIndex = this.sequences.findIndex(seq => String(seq.id) === String(nextSequence.id));
            this.renderCurrentTask();
        }
    }

    async exportToJOSM(sequenceId) {
        const sequence = this.sequences.find(s => String(s.id) === String(sequenceId));
        if (!sequence) {
            alert('Sequence not found');
            return;
        }

        try {
            const josmXml = this.generateJOSM(sequence);
            
            // Validate XML before sending
            if (!josmXml || josmXml.trim().length === 0) {
                alert('Error: Generated OSM XML is empty. Please check your data.');
                return;
            }
            
            // Check if XML contains actual data (not just comments)
            if (!josmXml.includes('<node') && !josmXml.includes('<way')) {
                alert('Error: Generated OSM XML contains no nodes or ways. Please check your data.');
                return;
            }
            
            console.log('Generated OSM XML:', josmXml.substring(0, 500) + '...');
            await this.sendToJOSM(josmXml, sequenceId);
        } catch (error) {
            console.error('Export error:', error);
            alert(`Error exporting sequence: ${error.message}`);
        }
    }

    async sendToJOSM(josmXml, sequenceId) {
        // First, check if JOSM is running and accessible
        try {
            const versionResponse = await fetch('http://localhost:8111/version');
            if (!versionResponse.ok) {
                throw new Error('JOSM Remote Control is not responding. Please ensure JOSM is running and Remote Control is enabled.');
            }
            const version = await versionResponse.text();
            console.log('JOSM version:', version);
        } catch (error) {
            console.error('JOSM connectivity check failed:', error);
            const proceed = confirm('Cannot connect to JOSM Remote Control.\n\nPlease ensure:\n1. JOSM is running\n2. Remote Control is enabled (Edit → Preferences → Remote Control)\n3. Port 8111 is not blocked\n\nWould you like to try anyway, or download the file instead?');
            if (!proceed) {
                this.downloadFile(josmXml, `sequence_${sequenceId}.osm`, 'application/xml');
                return;
            }
        }
        
        console.log('Sending to JOSM:', {
            xmlLength: josmXml.length
        });
        
        // Method 1: Use server-side export + JOSM import endpoint (most reliable)
        // This avoids URL length limits and encoding issues
        try {
            console.log('Step 1: Uploading OSM XML to server...');
            
            // POST the OSM XML to our server
            const response = await fetch('http://localhost:8000/export', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    sequenceId: sequenceId,
                    osmXml: josmXml
                })
            });
            
            if (!response.ok) {
                throw new Error(`Server error: ${response.status}`);
            }
            
            const result = await response.json();
            
            if (!result.success || !result.url) {
                throw new Error('Server did not return file URL');
            }
            
            console.log('Step 2: File available at:', result.url);
            console.log('Step 3: Sending to JOSM via import endpoint...');
            
            // Use JOSM's import endpoint with the server URL
            const josmImportUrl = `http://localhost:8111/import?url=${encodeURIComponent(result.url)}`;
            console.log('JOSM import URL:', josmImportUrl);
            
            // Use iframe to trigger JOSM import
            const iframe = document.createElement('iframe');
            iframe.style.display = 'none';
            iframe.style.width = '0';
            iframe.style.height = '0';
            iframe.src = josmImportUrl;
            document.body.appendChild(iframe);
            
            setTimeout(() => {
                document.body.removeChild(iframe);
                // Success message - no confirmation needed
                alert('✅ Data sent to JOSM!\n\n' +
                      'The file has been uploaded and JOSM should import it automatically.\n\n' +
                      'Please check your JOSM window - the data should appear now.');
            }, 2000);
            
            // No need for confirmation - if automatic transfer fails, user can manually export
            // The file is available on the server if needed
            return;
            
        } catch (error) {
            console.error('Server-based export failed:', error);
            console.log('Falling back to direct download...');
            
            // Fallback: direct file download
            this.downloadAndOpenInJOSM(josmXml, sequenceId);
        }
    }
    
    downloadAndOpenInJOSM(josmXml, sequenceId) {
        // Download the file
        this.downloadFile(josmXml, `sequence_${sequenceId}.osm`, 'application/xml');
        
        // Provide helpful instructions
        alert('📥 File downloaded!\n\n' +
              'To open in JOSM:\n' +
              '1. Go to JOSM\n' +
              '2. File → Open (or press Ctrl+O)\n' +
              '3. Navigate to your Downloads folder\n' +
              '4. Select: sequence_' + sequenceId + '.osm\n' +
              '5. Click Open\n\n' +
              'Or simply drag and drop the file into JOSM!');
    }

    generateJOSM(sequence) {
        let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
            xml += '<osm version="0.6" generator="OSMAGIC Task Manager">\n';
        xml += `  <!-- Sequence ID: ${sequence.id} -->\n`;
        xml += `  <!-- Features: ${sequence.featureCount} -->\n`;
        xml += `  <!-- Generated: ${new Date().toISOString()} -->\n\n`;

        let nodeId = -1000;
        let wayId = -1000;
        const nodeMap = new Map();

        // Process features and create nodes
        sequence.features.forEach(feature => {
            if (!feature.geometry) return;

            const coords = this.extractCoordinates(feature.geometry);
            
            coords.forEach(coord => {
                const [lon, lat] = coord;
                const key = `${lat.toFixed(7)},${lon.toFixed(7)}`;
                
                if (!nodeMap.has(key)) {
                    nodeMap.set(key, {
                        id: nodeId--,
                        lat: lat,
                        lon: lon
                    });
                }
            });
        });

        // Write nodes
        nodeMap.forEach(node => {
            xml += `  <node id="${node.id}" lat="${node.lat.toFixed(7)}" lon="${node.lon.toFixed(7)}" version="1" />\n`;
        });

        xml += '\n';

        // Process features and create ways
        sequence.features.forEach(feature => {
            if (!feature.geometry) return;

            const coords = this.extractCoordinates(feature.geometry);
            if (coords.length < 2) return; // Skip points for ways

            xml += `  <way id="${wayId--}" version="1">\n`;

            coords.forEach(coord => {
                const [lon, lat] = coord;
                const key = `${lat.toFixed(7)},${lon.toFixed(7)}`;
                const node = nodeMap.get(key);
                if (node) {
                    xml += `    <nd ref="${node.id}" />\n`;
                }
            });

            // Only add highway tag (user requested only highway tag)
            const highwayValue = feature.properties?.highway || 'unclassified';
            xml += `    <tag k="highway" v="${this.escapeXml(String(highwayValue))}" />\n`;
            xml += `  </way>\n`;
        });

        xml += '</osm>';
        return xml;
    }

    extractCoordinates(geometry) {
        const coords = [];

        if (geometry.type === 'Point') {
            coords.push(geometry.coordinates);
        } else if (geometry.type === 'LineString') {
            coords.push(...geometry.coordinates);
        } else if (geometry.type === 'Polygon') {
            if (geometry.coordinates && geometry.coordinates[0]) {
                coords.push(...geometry.coordinates[0]);
            }
        } else if (geometry.type === 'MultiLineString') {
            geometry.coordinates.forEach(line => {
                coords.push(...line);
            });
        } else if (geometry.type === 'MultiPolygon') {
            geometry.coordinates.forEach(polygon => {
                if (polygon[0]) {
                    coords.push(...polygon[0]);
                }
            });
        }

        return coords;
    }

    escapeXml(text) {
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;');
    }

    downloadFile(content, filename, mimeType) {
        const blob = new Blob([content], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    previewSequence(sequenceId) {
        const sequence = this.sequences.find(s => String(s.id) === String(sequenceId));
        if (!sequence) {
            alert('Sequence not found');
            return;
        }

        this.currentPreviewSequence = sequence;
        this.previewEditMode = false;
        this.originalPreviewFeatures = JSON.parse(JSON.stringify(sequence.features)); // Deep copy for revert
        this.editableLayers = [];
        
        document.getElementById('previewSequenceId').textContent = sequenceId;
        
        // Set initial highway value in selector
        const highwaySelect = document.getElementById('highwaySelect');
        if (highwaySelect) {
            // Get highway value from first feature, or default to 'unclassified'
            const highwayValue = sequence.features[0]?.properties?.highway || 'unclassified';
            highwaySelect.value = highwayValue;
        }
        
        // Reset edit mode UI
        document.getElementById('toggleEditModeBtn').style.display = 'inline-block';
        document.getElementById('toggleEditModeBtn').textContent = '✏️ Enable Edit Mode';
        document.getElementById('saveEditsBtn').style.display = 'none';
        document.getElementById('revertEditsBtn').style.display = 'none';
        
        // Show modal
        const modal = document.getElementById('previewModal');
        modal.style.display = 'block';

        // Initialize map - need to wait a bit for modal to be visible
        setTimeout(() => {
            if (!this.map) {
                // Default to Singapore coordinates (as per user preference)
                this.map = L.map('previewMap', {
                    zoomControl: true
                }).setView([1.301965, 103.9003035], 13);
                
                // Add OpenStreetMap tile layer
                L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                    attribution: '© OpenStreetMap contributors',
                    maxZoom: 19
                }).addTo(this.map);
            }

            // Clear existing GeoJSON layers (but keep tile layer)
            this.map.eachLayer((layer) => {
                if (layer instanceof L.GeoJSON || layer instanceof L.Polyline || layer instanceof L.Polygon || layer instanceof L.Marker) {
                    if (!(layer instanceof L.TileLayer)) {
                        this.map.removeLayer(layer);
                    }
                }
            });
            this.editableLayers = [];

            // Create GeoJSON from sequence features
            const geojson = {
                type: 'FeatureCollection',
                features: sequence.features
            };

            // Add GeoJSON layer to map with blue lines (as per user preference)
            const geoJsonLayer = L.geoJSON(geojson, {
                style: (feature) => {
                    return {
                        color: '#0066ff', // Blue color as per user preference
                        weight: 4,
                        opacity: 0.8
                    };
                },
                onEachFeature: (feature, layer) => {
                    // No popup - user doesn't want property popups
                }
            }).addTo(this.map);

            // Store layers for editing
            geoJsonLayer.eachLayer((layer) => {
                // Store the actual layer (Polyline, Polygon, or Marker)
                this.editableLayers.push(layer);
                // Also store reference to the feature for later use
                layer.feature = layer.feature || {};
            });
            
            // Debug: log what we found
            console.log('Editable layers found:', this.editableLayers.length);
            this.editableLayers.forEach((layer, idx) => {
                console.log(`Layer ${idx}:`, layer.constructor.name, layer instanceof L.Polyline, layer instanceof L.Polygon, layer instanceof L.Marker);
            });

            // Invalidate size to ensure map renders correctly
            setTimeout(() => {
                this.map.invalidateSize();
                
                // Fit map to bounds
                if (geoJsonLayer.getBounds().isValid()) {
                    this.map.fitBounds(geoJsonLayer.getBounds(), { padding: [50, 50] });
                } else {
                    // Fallback to Singapore if bounds are invalid
                    this.map.setView([1.301965, 103.9003035], 13);
                }
            }, 200);
        }, 300);
    }

    toggleEditMode() {
        this.previewEditMode = !this.previewEditMode;
        
        if (this.previewEditMode) {
            // Disable map dragging when edit mode is enabled to prevent conflicts with node/way dragging
            // Users can still pan by clicking and dragging on empty map areas (we'll handle this separately if needed)
            this.map.dragging.disable();
            
            // Check if we have layers to edit
            if (!this.editableLayers || this.editableLayers.length === 0) {
                alert('No geometry found to edit. Make sure the sequence has features.');
                this.previewEditMode = false;
                this.map.dragging.enable(); // Re-enable if we're not entering edit mode
                return;
            }
            
            console.log('Enabling edit mode for', this.editableLayers.length, 'layers');
            
            // Enable editing - add draggable vertex markers
            let layersProcessed = 0;
            this.editableLayers.forEach((layer, idx) => {
                console.log(`Layer ${idx}:`, layer.constructor.name, 'has getLatLngs:', typeof layer.getLatLngs === 'function');
                
                // Check if it's a polyline or polygon (more flexible check)
                const isPolyline = layer instanceof L.Polyline || (layer.getLatLngs && !(layer instanceof L.Marker) && !(layer instanceof L.Circle));
                const isPolygon = layer instanceof L.Polygon;
                
                if (isPolyline || isPolygon) {
                    console.log(`  - Processing as ${isPolygon ? 'Polygon' : 'Polyline'}`);
                    layersProcessed++;
                    // Make the layer more visible when editing and make it draggable
                    layer.setStyle({ weight: 6, opacity: 0.9, cursor: 'move' });
                    
                    // Store reference to layer for dragging
                    layer._isDragging = false;
                    layer._dragStart = null;
                    layer._originalLatLngs = null;
                    
                    // Enable dragging the entire way by clicking on the line
                    // Use a flag to track if mouse is down on the path
                    layer._mouseDownOnPath = false;
                    layer._wayDragStartLatLng = null;
                    
                    layer.on('mousedown', (e) => {
                        // Check if clicking directly on the path element (not on markers)
                        const target = e.originalEvent.target;
                        const isOnMarker = target.closest('.vertex-marker') || target.closest('.delete-node-btn') || target.closest('.leaflet-marker-icon');
                        
                        if (!isOnMarker) {
                            layer._mouseDownOnPath = true;
                            layer._isDragging = true;
                            layer._wayDragStartLatLng = e.latlng; // Store initial click position
                            layer._originalLatLngs = this.flattenLatLngs(layer.getLatLngs());
                            // Map dragging is already disabled in edit mode, but ensure it stays disabled
                            this.map.dragging.disable();
                            L.DomEvent.stopPropagation(e);
                            L.DomEvent.preventDefault(e);
                        }
                    });
                    
                    // Handle mouse move for dragging entire way
                    const dragHandler = (e) => {
                        if (layer._isDragging && layer._wayDragStartLatLng && layer._mouseDownOnPath && layer._originalLatLngs) {
                            // Calculate delta from the original click position, not from last position
                            const deltaLat = e.latlng.lat - layer._wayDragStartLatLng.lat;
                            const deltaLng = e.latlng.lng - layer._wayDragStartLatLng.lng;
                            
                            // Apply delta to original positions
                            const newLatLngs = layer._originalLatLngs.map(ll => {
                                if (ll instanceof L.LatLng) {
                                    return L.latLng(ll.lat + deltaLat, ll.lng + deltaLng);
                                } else if (Array.isArray(ll)) {
                                    return L.latLng(ll[0] + deltaLat, ll[1] + deltaLng);
                                }
                                return L.latLng((ll.lat || ll[0]) + deltaLat, (ll.lng || ll[1]) + deltaLng);
                            });
                            
                            // Update layer without triggering events that might cause feedback
                            layer.setLatLngs(layer instanceof L.Polygon ? [newLatLngs] : newLatLngs);
                            
                            // Update vertex markers (but don't update during drag to avoid feedback loop)
                            if (!layer._updatingMarkers) {
                                layer._updatingMarkers = true;
                                // Use requestAnimationFrame to batch marker updates
                                requestAnimationFrame(() => {
                                    this.updateVertexMarkers(layer, newLatLngs);
                                    layer._updatingMarkers = false;
                                });
                            }
                        }
                    };
                    
                    // Handle mouse up for dragging entire way
                    const dragEndHandler = () => {
                        if (layer._isDragging) {
                            layer._isDragging = false;
                            layer._mouseDownOnPath = false;
                            layer._wayDragStartLatLng = null;
                            
                            // Final update of markers
                            if (layer._originalLatLngs) {
                                const currentLatLngs = this.flattenLatLngs(layer.getLatLngs());
                                this.updateVertexMarkers(layer, currentLatLngs);
                            }
                            
                            layer._originalLatLngs = null;
                            // Map dragging stays disabled in edit mode (we'll re-enable when exiting edit mode)
                        }
                    };
                    
                    this.map.on('mousemove', dragHandler);
                    this.map.on('mouseup', dragEndHandler);
                    this.map.on('mouseleave', dragEndHandler); // Also handle mouse leaving map
                    
                    // Store handlers for cleanup
                    layer._dragHandler = dragHandler;
                    layer._dragEndHandler = dragEndHandler;
                    
                    // Add node by clicking on the line
                    layer.on('click', (e) => {
                        // Don't add node if we just finished dragging or clicked on marker
                        if (layer._isDragging || layer._mouseDownOnPath || 
                            e.originalEvent.target.closest('.vertex-marker') || 
                            e.originalEvent.target.closest('.delete-node-btn') ||
                            e.originalEvent.target.closest('.leaflet-marker-icon')) {
                            // Reset flag after a short delay
                            setTimeout(() => {
                                layer._mouseDownOnPath = false;
                            }, 100);
                            return;
                        }
                        
                        const clickLatLng = e.latlng;
                        const latlngs = this.flattenLatLngs(layer.getLatLngs());
                        
                        // Find the closest segment
                        let minDistance = Infinity;
                        let insertIndex = -1;
                        
                        for (let i = 0; i < latlngs.length - 1; i++) {
                            const segStart = latlngs[i];
                            const segEnd = latlngs[i + 1];
                            const startLL = segStart instanceof L.LatLng ? segStart : L.latLng(segStart[0] || segStart.lat, segStart[1] || segStart.lng);
                            const endLL = segEnd instanceof L.LatLng ? segEnd : L.latLng(segEnd[0] || segEnd.lat, segEnd[1] || segEnd.lng);
                            const distance = this.distanceToSegment(clickLatLng, startLL, endLL);
                            
                            if (distance < minDistance) {
                                minDistance = distance;
                                insertIndex = i + 1;
                            }
                        }
                        
                        // Insert new node
                        if (insertIndex > 0) {
                            latlngs.splice(insertIndex, 0, clickLatLng);
                            layer.setLatLngs(layer instanceof L.Polygon ? [latlngs] : latlngs);
                            this.updateVertexMarkers(layer, latlngs);
                        }
                    });
                    
                    // Get all coordinates
                    let latlngs = layer.getLatLngs();
                    const flatLatlngs = this.flattenLatLngs(latlngs);
                    
                    if (Array.isArray(flatLatlngs) && flatLatlngs.length > 0) {
                        this.updateVertexMarkers(layer, flatLatlngs);
                    }
                } else if (layer instanceof L.Marker) {
                    console.log(`  - Processing as Marker`);
                    layer.dragging.enable();
                    layersProcessed++;
                } else {
                    console.log(`  - Skipping layer (not Polyline/Polygon/Marker)`);
                }
            });
            
            console.log(`Total layers processed: ${layersProcessed}`);
            
            if (layersProcessed === 0) {
                alert('No editable geometry found. The sequence may only contain unsupported geometry types. Check the browser console for details.');
                this.previewEditMode = false;
                document.getElementById('toggleEditModeBtn').textContent = '✏️ Enable Edit Mode';
                document.getElementById('simplifyBtn').style.display = 'none';
                document.getElementById('toleranceInput').style.display = 'none';
                document.getElementById('saveEditsBtn').style.display = 'none';
                document.getElementById('revertEditsBtn').style.display = 'none';
                return;
            }
            
            document.getElementById('toggleEditModeBtn').textContent = '👁️ Disable Edit Mode';
            document.getElementById('simplifyBtn').style.display = 'inline-block';
            document.getElementById('toleranceInput').style.display = 'inline-block';
            document.getElementById('saveEditsBtn').style.display = 'inline-block';
            document.getElementById('revertEditsBtn').style.display = 'inline-block';
        } else {
            // Disable editing - remove vertex markers and event handlers
            // Re-enable map dragging
            this.map.dragging.enable();
            
            this.editableLayers.forEach(layer => {
                if (layer instanceof L.Polyline || layer instanceof L.Polygon) {
                    // Remove event handlers
                    layer.off('mousedown');
                    layer.off('click');
                    if (layer._dragHandler) {
                        this.map.off('mousemove', layer._dragHandler);
                    }
                    if (layer._dragEndHandler) {
                        this.map.off('mouseup', layer._dragEndHandler);
                        this.map.off('mouseleave', layer._dragEndHandler);
                    }
                    
                    // Remove vertex markers
                    if (layer._vertexMarkers) {
                        layer._vertexMarkers.forEach(marker => {
                            this.map.removeLayer(marker);
                        });
                        layer._vertexMarkers = [];
                    }
                    // Restore original style
                    layer.setStyle({ weight: 4, opacity: 0.8, cursor: '' });
                } else if (layer instanceof L.Marker) {
                    layer.dragging.disable();
                }
            });
            
            document.getElementById('toggleEditModeBtn').textContent = '✏️ Enable Edit Mode';
            document.getElementById('simplifyBtn').style.display = 'none';
            document.getElementById('toleranceInput').style.display = 'none';
            document.getElementById('saveEditsBtn').style.display = 'none';
            document.getElementById('revertEditsBtn').style.display = 'none';
        }
    }

    // Helper: Flatten latlngs array
    flattenLatLngs(arr) {
        if (!arr) return [];
        if (!Array.isArray(arr)) {
            if (arr instanceof L.LatLng) return [arr];
            return [];
        }
        
        const result = [];
        arr.forEach(item => {
            if (item instanceof L.LatLng) {
                result.push(item);
            } else if (Array.isArray(item)) {
                if (item.length > 0) {
                    if (item[0] instanceof L.LatLng) {
                        result.push(...item);
                    } else if (Array.isArray(item[0])) {
                        result.push(...this.flattenLatLngs(item));
                    }
                }
            }
        });
        return result;
    }

    // Helper: Update vertex markers for a layer
    updateVertexMarkers(layer, latlngs) {
        // Clear existing markers
        if (layer._vertexMarkers) {
            layer._vertexMarkers.forEach(marker => {
                this.map.removeLayer(marker);
            });
        }
        layer._vertexMarkers = [];
        
        // Add markers for each vertex
        latlngs.forEach((latlng, index) => {
            let lat, lng;
            if (latlng instanceof L.LatLng) {
                lat = latlng.lat;
                lng = latlng.lng;
            } else if (Array.isArray(latlng)) {
                lat = latlng[0];
                lng = latlng[1];
            } else {
                lat = latlng.lat || latlng[0];
                lng = latlng.lng || latlng[1];
            }
            
            // Vertex marker
            const marker = L.marker([lat, lng], {
                draggable: true,
                icon: L.divIcon({
                    className: 'vertex-marker',
                    html: '<div class="vertex-handle"></div>',
                    iconSize: [12, 12]
                }),
                zIndexOffset: 1100, // Higher than delete button (1000) to ensure marker is on top
                interactive: true
            }).addTo(this.map);
            
            // No delete button needed - clicking the node itself will delete it
            // Ensure marker dragging is enabled
            marker.dragging.enable();
            marker.setZIndexOffset(1100);
            
            // Track mouse state to distinguish between click (delete) and drag (move)
            marker._mouseDownPos = null;
            marker._hasMoved = false;
            marker._clickTimeout = null;
            marker._isDragging = false;
            
            // Handle mousedown - track initial position
            marker.on('mousedown', (e) => {
                // Disable map dragging when clicking on marker
                this.map.dragging.disable();
                // Store initial mouse position
                marker._mouseDownPos = {
                    x: e.originalEvent.clientX,
                    y: e.originalEvent.clientY,
                    latlng: e.latlng
                };
                marker._hasMoved = false;
                marker._isDragging = false;
                
                // Set a timeout to detect click (if no drag happens)
                marker._clickTimeout = setTimeout(() => {
                    // If mouse hasn't moved significantly and drag hasn't started, treat as click
                    if (!marker._hasMoved && !marker._isDragging) {
                        // This will be handled by mouseup if it's still a click
                    }
                }, 50);
            });
            
            // Handle mousemove on marker to detect if it's a drag
            marker.on('mousemove', (e) => {
                if (marker._mouseDownPos) {
                    const dx = Math.abs(e.originalEvent.clientX - marker._mouseDownPos.x);
                    const dy = Math.abs(e.originalEvent.clientY - marker._mouseDownPos.y);
                    // If mouse moved more than 5 pixels, it's a drag
                    if (dx > 5 || dy > 5) {
                        marker._hasMoved = true;
                        // Clear click timeout since this is a drag
                        if (marker._clickTimeout) {
                            clearTimeout(marker._clickTimeout);
                            marker._clickTimeout = null;
                        }
                    }
                }
            });
            
            // Handle click (mouseup without significant movement) = DELETE
            marker.on('click', (e) => {
                // Only delete if it wasn't a drag
                if (!marker._hasMoved && !marker._isDragging) {
                    e.originalEvent.stopPropagation();
                    e.originalEvent.preventDefault();
                    
                    if (latlngs.length > 2) { // Keep at least 2 points
                        latlngs.splice(index, 1);
                        layer.setLatLngs(layer instanceof L.Polygon ? [latlngs] : latlngs);
                        this.updateVertexMarkers(layer, latlngs);
                    } else {
                        alert('Cannot delete node. A line must have at least 2 points.');
                    }
                }
                
                // Reset state
                marker._mouseDownPos = null;
                marker._hasMoved = false;
                if (marker._clickTimeout) {
                    clearTimeout(marker._clickTimeout);
                    marker._clickTimeout = null;
                }
            });
            
            // Handle dragstart - this is a DRAG, not a click
            marker.on('dragstart', (e) => {
                // Mark as dragging
                marker._isDragging = true;
                marker._hasMoved = true;
                
                // Clear click timeout since this is a drag
                if (marker._clickTimeout) {
                    clearTimeout(marker._clickTimeout);
                    marker._clickTimeout = null;
                }
                
                // Ensure map dragging is disabled
                this.map.dragging.disable();
                // Stop propagation to prevent map events
                L.DomEvent.stopPropagation(e);
            });
            
            marker.on('drag', (e) => {
                // Keep map dragging disabled during drag
                this.map.dragging.disable();
                // Stop propagation to prevent map from moving
                L.DomEvent.stopPropagation(e);
                
                const newLatlng = e.target.getLatLng();
                if (latlngs[index] instanceof L.LatLng) {
                    latlngs[index].lat = newLatlng.lat;
                    latlngs[index].lng = newLatlng.lng;
                } else {
                    latlngs[index] = newLatlng;
                }
                layer.setLatLngs(layer instanceof L.Polygon ? [latlngs] : latlngs);
            });
            
            marker.on('dragend', (e) => {
                // Mark that dragging has ended
                marker._isDragging = false;
                marker._mouseDownPos = null;
                marker._hasMoved = false;
                // Stop propagation
                L.DomEvent.stopPropagation(e);
                // Map dragging stays disabled in edit mode (we'll re-enable when exiting edit mode)
            });
            
            // Handle mouseup to clean up state
            marker.on('mouseup', (e) => {
                // Reset state
                if (marker._clickTimeout) {
                    clearTimeout(marker._clickTimeout);
                    marker._clickTimeout = null;
                }
                marker._mouseDownPos = null;
            });
            
            layer._vertexMarkers.push(marker);
        });
    }

    // Helper: Calculate distance from point to line segment
    distanceToSegment(point, segStart, segEnd) {
        const A = point.lat - segStart.lat;
        const B = point.lng - segStart.lng;
        const C = segEnd.lat - segStart.lat;
        const D = segEnd.lng - segStart.lng;
        
        const dot = A * C + B * D;
        const lenSq = C * C + D * D;
        let param = -1;
        
        if (lenSq !== 0) param = dot / lenSq;
        
        let xx, yy;
        
        if (param < 0) {
            xx = segStart.lat;
            yy = segStart.lng;
        } else if (param > 1) {
            xx = segEnd.lat;
            yy = segEnd.lng;
        } else {
            xx = segStart.lat + param * C;
            yy = segStart.lng + param * D;
        }
        
        const dx = point.lat - xx;
        const dy = point.lng - yy;
        return Math.sqrt(dx * dx + dy * dy) * 111000; // Convert to approximate meters
    }

    // Douglas-Peucker line simplification algorithm
    douglasPeucker(points, tolerance) {
        if (points.length <= 2) return points;
        
        // Find the point with maximum distance from line between first and last point
        let maxDistance = 0;
        let maxIndex = 0;
        const first = points[0];
        const last = points[points.length - 1];
        
        for (let i = 1; i < points.length - 1; i++) {
            const distance = this.perpendicularDistance(points[i], first, last);
            if (distance > maxDistance) {
                maxDistance = distance;
                maxIndex = i;
            }
        }
        
        // If max distance is greater than tolerance, recursively simplify
        if (maxDistance > tolerance) {
            // Recursive call on both sides
            const left = this.douglasPeucker(points.slice(0, maxIndex + 1), tolerance);
            const right = this.douglasPeucker(points.slice(maxIndex), tolerance);
            
            // Combine results (remove duplicate point at junction)
            return left.slice(0, -1).concat(right);
        } else {
            // Return only endpoints
            return [first, last];
        }
    }

    // Calculate perpendicular distance from point to line segment (in meters)
    perpendicularDistance(point, lineStart, lineEnd) {
        const [lon0, lat0] = point;
        const [lon1, lat1] = lineStart;
        const [lon2, lat2] = lineEnd;
        
        // Calculate distance using cross product in lat/lng space
        const dx = lon2 - lon1;
        const dy = lat2 - lat1;
        const d = Math.sqrt(dx * dx + dy * dy);
        
        if (d === 0) {
            // Line start and end are the same, calculate distance to point
            return this.haversineDistance([lon0, lat0], [lon1, lat1]);
        }
        
        // Calculate perpendicular distance
        const t = Math.max(0, Math.min(1, ((lon0 - lon1) * dx + (lat0 - lat1) * dy) / (d * d)));
        const projLon = lon1 + t * dx;
        const projLat = lat1 + t * dy;
        
        return this.haversineDistance([lon0, lat0], [projLon, projLat]);
    }

    // Haversine distance between two points (in meters)
    haversineDistance(point1, point2) {
        const R = 6371000; // Earth radius in meters
        const [lon1, lat1] = point1;
        const [lon2, lat2] = point2;
        
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;
        
        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                  Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
                  Math.sin(dLon / 2) * Math.sin(dLon / 2);
        
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
    }

    // Simplify geometry using Douglas-Peucker
    simplifyGeometry() {
        if (!this.currentPreviewSequence || !this.editableLayers || this.editableLayers.length === 0) {
            alert('No geometry to simplify. Please open a preview first.');
            return;
        }
        
        if (!this.previewEditMode) {
            alert('Please enable edit mode first.');
            return;
        }
        
        const toleranceInput = document.getElementById('toleranceInput');
        const tolerance = parseFloat(toleranceInput.value) || 5; // Default 5 meters
        
        if (tolerance <= 0) {
            alert('Tolerance must be greater than 0.');
            return;
        }
        
        let totalNodesBefore = 0;
        let totalNodesAfter = 0;
        
        // Simplify each layer
        this.editableLayers.forEach((layer) => {
            if (layer instanceof L.Polyline || layer instanceof L.Polygon) {
                const latlngs = this.flattenLatLngs(layer.getLatLngs());
                
                if (latlngs.length <= 2) {
                    return; // Can't simplify lines with 2 or fewer points
                }
                
                totalNodesBefore += latlngs.length;
                
                // Convert to [lng, lat] format for algorithm
                const points = latlngs.map(ll => {
                    if (ll instanceof L.LatLng) {
                        return [ll.lng, ll.lat];
                    } else if (Array.isArray(ll)) {
                        // Assume [lat, lng] format
                        return [ll[1] || ll[0], ll[0] || ll[1]];
                    }
                    return [ll.lng, ll.lat];
                });
                
                // Apply Douglas-Peucker
                const simplified = this.douglasPeucker(points, tolerance);
                
                totalNodesAfter += simplified.length;
                
                // Convert back to LatLng objects
                const simplifiedLatLngs = simplified.map(pt => L.latLng(pt[1], pt[0]));
                
                // Update the layer
                if (layer instanceof L.Polygon) {
                    layer.setLatLngs([simplifiedLatLngs]);
                } else {
                    layer.setLatLngs(simplifiedLatLngs);
                }
                
                // Update vertex markers
                this.updateVertexMarkers(layer, simplifiedLatLngs);
            }
        });
        
        const reduction = totalNodesBefore > 0 ? ((totalNodesBefore - totalNodesAfter) / totalNodesBefore * 100).toFixed(1) : 0;
        alert(`✅ Geometry simplified!\n\nNodes before: ${totalNodesBefore}\nNodes after: ${totalNodesAfter}\nReduction: ${reduction}%`);
    }

    savePreviewEdits() {
        if (!this.currentPreviewSequence) {
            alert('Error: No sequence loaded in preview.');
            return;
        }
        
        // Check if we have editable layers - if not, try to extract from map
        if (!this.editableLayers || this.editableLayers.length === 0) {
            console.warn('No editable layers found, trying to extract from map...');
            this.editableLayers = [];
            this.map.eachLayer((layer) => {
                if ((layer instanceof L.Polyline || layer instanceof L.Polygon || layer instanceof L.Marker) && 
                    !(layer instanceof L.TileLayer) && 
                    !layer._isVertexMarker &&
                    !layer._isDeleteButton) {
                    this.editableLayers.push(layer);
                }
            });
            
            if (this.editableLayers.length === 0) {
                alert('Error: No geometry found to save.\n\nPlease make sure:\n1. You have features visible in the preview\n2. Edit mode is enabled\n3. You have made some edits');
                return;
            }
            console.log('Found', this.editableLayers.length, 'layers from map');
        }
        
        console.log('Saving edits from', this.editableLayers.length, 'layers');
        
        // Convert edited layers back to GeoJSON features
        const editedFeatures = [];
        this.editableLayers.forEach((layer, idx) => {
            let geometry = null;
            
            try {
                if (layer instanceof L.Polyline) {
                    const latlngs = layer.getLatLngs();
                    const flatLatlngs = this.flattenLatLngs(latlngs);
                    
                    if (flatLatlngs.length > 0) {
                        const coords = flatLatlngs.map(ll => {
                            if (ll instanceof L.LatLng || (ll.lat !== undefined && ll.lng !== undefined)) {
                                return [ll.lng, ll.lat];
                            } else if (Array.isArray(ll) && ll.length >= 2) {
                                // Try to detect format: if first value > 90, it's probably lng
                                if (Math.abs(ll[0]) > 90) {
                                    return [ll[0], ll[1]]; // [lng, lat]
                                } else {
                                    return [ll[1], ll[0]]; // [lat, lng] -> [lng, lat]
                                }
                            }
                            return null;
                        }).filter(coord => coord !== null && coord[0] !== undefined && coord[1] !== undefined);
                        
                        if (coords.length >= 2) { // LineString needs at least 2 points
                            geometry = {
                                type: 'LineString',
                                coordinates: coords
                            };
                        }
                    }
                } else if (layer instanceof L.Polygon) {
                    const latlngs = layer.getLatLngs();
                    const flatLatlngs = this.flattenLatLngs(latlngs);
                    
                    if (flatLatlngs.length > 0) {
                        const coords = flatLatlngs.map(ll => {
                            if (ll instanceof L.LatLng || (ll.lat !== undefined && ll.lng !== undefined)) {
                                return [ll.lng, ll.lat];
                            } else if (Array.isArray(ll) && ll.length >= 2) {
                                if (Math.abs(ll[0]) > 90) {
                                    return [ll[0], ll[1]];
                                } else {
                                    return [ll[1], ll[0]];
                                }
                            }
                            return null;
                        }).filter(coord => coord !== null && coord[0] !== undefined && coord[1] !== undefined);
                        
                        // Close the polygon
                        if (coords.length > 0 && (coords[0][0] !== coords[coords.length - 1][0] || coords[0][1] !== coords[coords.length - 1][1])) {
                            coords.push(coords[0]);
                        }
                        
                        if (coords.length >= 4) { // Polygon needs at least 4 points (closed ring)
                            geometry = {
                                type: 'Polygon',
                                coordinates: [coords]
                            };
                        }
                    }
                } else if (layer instanceof L.Marker) {
                    const latlng = layer.getLatLng();
                    if (latlng && latlng.lat !== undefined && latlng.lng !== undefined) {
                        geometry = {
                            type: 'Point',
                            coordinates: [latlng.lng, latlng.lat]
                        };
                    }
                }
                
                if (geometry) {
                    // Preserve original feature properties
                    const originalFeature = layer.feature || { properties: {} };
                    editedFeatures.push({
                        type: 'Feature',
                        geometry: geometry,
                        properties: originalFeature.properties || {}
                    });
                    console.log(`Layer ${idx}: Converted to ${geometry.type} with ${geometry.coordinates.length} coordinates`);
                } else {
                    console.warn(`Layer ${idx}: Could not extract valid geometry`);
                }
            } catch (error) {
                console.error(`Error processing layer ${idx}:`, error);
            }
        });
        
        if (editedFeatures.length === 0) {
            alert('Error: Could not extract any valid features from the edited layers.\n\nPlease try:\n1. Make sure edit mode is enabled\n2. Make sure you have geometry visible on the map\n3. Try reverting and re-editing');
            return;
        }
        
        console.log('Successfully saved', editedFeatures.length, 'features');
        
        // Update sequence features
        this.currentPreviewSequence.features = editedFeatures;
        
        // Update the sequence in the main sequences array
        const sequenceIndex = this.sequences.findIndex(s => s.id === this.currentPreviewSequence.id);
        if (sequenceIndex >= 0) {
            this.sequences[sequenceIndex].features = editedFeatures;
            // Also update stats
            const stats = this.calculateStats(editedFeatures);
            this.sequences[sequenceIndex].featureCount = stats.features;
            this.sequences[sequenceIndex].nodeCount = stats.nodes;
            this.sequences[sequenceIndex].wayCount = stats.ways;
        }
        
        // Save to storage
        this.saveToStorage();
        
        // Update original for revert
        this.originalPreviewFeatures = JSON.parse(JSON.stringify(editedFeatures));
        
        // Changes saved silently - no popup needed
    }

    revertPreviewEdits() {
        if (!this.currentPreviewSequence || !this.originalPreviewFeatures) return;
        
        const confirmed = confirm('Are you sure you want to revert all changes? This will restore the original geometry.');
        if (!confirmed) return;
        
        // Restore original features
        this.currentPreviewSequence.features = JSON.parse(JSON.stringify(this.originalPreviewFeatures));
        
        // Update the sequence in the main sequences array
        const sequenceIndex = this.sequences.findIndex(s => s.id === this.currentPreviewSequence.id);
        if (sequenceIndex >= 0) {
            this.sequences[sequenceIndex].features = JSON.parse(JSON.stringify(this.originalPreviewFeatures));
        }
        
        // Re-render the preview
        this.previewSequence(this.currentPreviewSequence.id);
        
        alert('✅ Changes reverted successfully!');
    }

    closePreview() {
        // Disable edit mode if active
        if (this.previewEditMode) {
            this.toggleEditMode();
        }
        
        const modal = document.getElementById('previewModal');
        modal.style.display = 'none';
        this.currentPreviewSequence = null;
        this.previewEditMode = false;
        this.originalPreviewFeatures = null;
        this.editableLayers = [];
        
        // Invalidate map size when hidden
        if (this.map) {
            setTimeout(() => {
                this.map.invalidateSize();
            }, 100);
        }
    }

    updateHighwayTag(value) {
        if (!this.currentPreviewSequence) return;
        
        // Update highway property for all features in the sequence
        this.currentPreviewSequence.features.forEach(feature => {
            if (feature.properties) {
                feature.properties.highway = value;
            } else {
                feature.properties = { highway: value };
            }
        });
        
        // Update the sequence in the main sequences array
        const sequenceIndex = this.sequences.findIndex(s => s.id === this.currentPreviewSequence.id);
        if (sequenceIndex >= 0) {
            this.sequences[sequenceIndex].features = this.currentPreviewSequence.features;
        }
        
        // Save to storage
        this.saveToStorage();
    }

    async exportFromPreview() {
        if (this.currentPreviewSequence) {
            // If edit mode is enabled and there are editable layers, save edits first
            if (this.previewEditMode && this.editableLayers && this.editableLayers.length > 0) {
                // Save edits automatically before exporting
                this.savePreviewEdits();
            }
            
            // Export uses the edited geometry (saved above or from previous save)
            await this.exportToJOSM(this.currentPreviewSequence.id);
            // Don't close preview automatically - let user see the confirmation
            // this.closePreview();
        }
    }

    updateSummary() {
        const summaryInfo = document.getElementById('summaryInfo');
        if (!summaryInfo) return;

        const total = this.sequences.length;
        const active = this.sequences.filter(seq => !seq.status || seq.status === '').length;
        const skipped = this.sequences.filter(seq => seq.status === 'skipped').length;
        const done = this.sequences.filter(seq => seq.status === 'done').length;

        summaryInfo.innerHTML = `
            <span>Total Sequences: ${total}</span>
            <span>Active: ${active}</span>
            <span>Skipped: ${skipped}</span>
            <span>Done: ${done}</span>
        `;
    }

    async saveToStorage() {
        try {
            // Save id and status to IndexedDB
            const taskData = {
                sequences: this.sequences.map(seq => ({
                    id: seq.id,
                    status: seq.status
                })),
                currentIndex: this.currentIndex,
                currentView: this.currentView
            };
            
            await storageManager.saveTaskData(taskData);
            
            // Also save geojsonData to IndexedDB for full functionality
            if (this.geojsonData) {
                await storageManager.saveGeoJSONData(this.geojsonData);
            }
        } catch (error) {
            console.error('Error saving to storage:', error);
        }
    }

    exportAllToCSV() {
        const allSequences = this.getAllSequences();
        
        if (allSequences.length === 0) {
            alert('No sequences to export.');
            return;
        }

        // Create CSV content
        const headers = ['Sequence ID', 'Status'];
        const rows = allSequences.map(seq => {
            const status = seq.status || 'Active (Blank)';
            // Escape commas and quotes in sequence ID
            const sequenceId = String(seq.id).replace(/"/g, '""');
            return `"${sequenceId}","${status}"`;
        });

        const csvContent = [
            headers.join(','),
            ...rows
        ].join('\n');

        // Create blob and download
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        const url = URL.createObjectURL(blob);
        
        // Generate filename with timestamp
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
        const filename = `OSMAGIC_Tasks_Export_${timestamp}.csv`;
        
        link.setAttribute('href', url);
        link.setAttribute('download', filename);
        link.style.visibility = 'hidden';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        
        // Show success message
        alert(`✅ Successfully exported ${allSequences.length} sequences to ${filename}`);
    }

    async clearAllData() {
        // Show confirmation dialog
        const confirmed = confirm(
            '⚠️ WARNING: This will permanently delete ALL data including:\n\n' +
            '• All sequence IDs\n' +
            '• All status information\n' +
            '• All GeoJSON/GPX/CSV data\n' +
            '• All progress and metadata\n\n' +
            'This action CANNOT be undone!\n\n' +
            'Are you sure you want to clear all data?'
        );

        if (!confirmed) {
            return;
        }

        try {
            // Clear IndexedDB
            await storageManager.clearAll();

            // Reset all state
            this.geojsonData = null;
            this.sequences = [];
            this.currentIndex = 0;
            this.currentView = 'all';
            this.navigatingToSequenceId = null;
            this.currentPreviewSequence = null;

            // Clear file input
            const fileInput = document.getElementById('fileInput');
            if (fileInput) {
                fileInput.value = '';
            }

            // Clear file info
            const fileInfo = document.getElementById('fileInfo');
            if (fileInfo) {
                fileInfo.textContent = '';
            }

            // Reset tab buttons
            document.querySelectorAll('.tab-btn').forEach(btn => {
                if (btn.dataset.view === 'all') {
                    btn.classList.add('active');
                } else {
                    btn.classList.remove('active');
                }
            });

            // Update UI
            this.renderCurrentTask();
            this.updateSummary();

            // Show success message
            alert('✅ All data has been cleared successfully!');
        } catch (error) {
            console.error('Error clearing data:', error);
            alert('❌ Error clearing data. Please try again or check the console for details.');
        }
    }

    async loadFromStorage() {
        try {
            // Load task data from IndexedDB
            const taskData = await storageManager.loadTaskData();
            if (!taskData) return;

            // Load geojsonData from IndexedDB
            this.geojsonData = await storageManager.loadGeoJSONData();

            if (taskData.sequences && Array.isArray(taskData.sequences)) {
                // Restore only id and status from storage
                // If geojsonData exists, recalculate stats from features
                if (this.geojsonData && this.geojsonData.features) {
                    // Recalculate stats from geojsonData
                    const sequenceMap = new Map();
                    
                    this.geojsonData.features.forEach((feature) => {
                        const sequenceId = String(
                            feature.properties?.sequence_id || 
                            feature.properties?.sequenceId || 
                            feature.properties?.sequence || 
                            feature.properties?.id ||
                            feature.properties?.seq ||
                            `sequence_${feature.properties?.id || Math.random().toString(36).substr(2, 9)}`
                        );

                        if (!sequenceMap.has(sequenceId)) {
                            sequenceMap.set(sequenceId, {
                                id: sequenceId,
                                features: []
                            });
                        }

                        sequenceMap.get(sequenceId).features.push(feature);
                    });

                    // Restore status from saved data and calculate stats
                    const savedStatusMap = new Map();
                    taskData.sequences.forEach(seq => {
                        savedStatusMap.set(String(seq.id), seq.status);
                    });

                    this.sequences = Array.from(sequenceMap.values()).map(seq => {
                        const stats = this.calculateStats(seq.features);
                        return {
                            ...seq,
                            status: savedStatusMap.get(String(seq.id)) || '',
                            featureCount: stats.features,
                            nodeCount: stats.nodes,
                            wayCount: stats.ways,
                            date: new Date().toLocaleDateString()
                        };
                    });

                    // Sort by sequence ID
                    this.sequences.sort((a, b) => {
                        const aNum = parseInt(a.id);
                        const bNum = parseInt(b.id);
                        if (!isNaN(aNum) && !isNaN(bNum)) {
                            return aNum - bNum;
                        }
                        return a.id.localeCompare(b.id);
                    });
                } else {
                    // No geojsonData available, just restore basic structure
                    this.sequences = taskData.sequences.map(seq => ({
                        id: seq.id,
                        status: seq.status || '',
                        features: [],
                        featureCount: 0,
                        nodeCount: 0,
                        wayCount: 0,
                        date: new Date().toLocaleDateString()
                    }));
                }
                
                this.currentIndex = taskData.currentIndex || 0;
                this.currentView = taskData.currentView || 'all';
                
                // Update tab buttons to reflect current view
                document.querySelectorAll('.tab-btn').forEach(btn => {
                    if (btn.dataset.view === this.currentView) {
                        btn.classList.add('active');
                    } else {
                        btn.classList.remove('active');
                    }
                });
                
                if (this.sequences.length > 0) {
                    this.renderCurrentTask();
                    this.updateSummary();
                }
            }
        } catch (error) {
            console.error('Error loading from storage:', error);
        }
    }
}

// Initialize task manager when page loads
let taskManager;
document.addEventListener('DOMContentLoaded', () => {
    taskManager = new TaskManager();
});

