class TaskManager {
    constructor() {
        this.geojsonData = null;
        this.sequences = [];
        this.selectedSequences = new Set();
        this.map = null;
        this.currentPreviewSequence = null;
        this.currentSequenceIndex = 0; // Track which sequence is currently displayed
        
        // Load cached data on page load (async)
        this.loadFromCache();
        
        // Load and display file info
        this.loadFileInfo();
        
        this.initializeEventListeners();
    }



    initializeEventListeners() {
        const fileInput = document.getElementById('geojsonFileInput');

        if (fileInput) {
            fileInput.addEventListener('change', (e) => this.handleFileUpload(e));
        }
    }

    handleFileUpload(event) {
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
        Promise.allSettled(promises).then(async results => {
            const newFeatures = [];
            const errors = [];
            let loadedCount = 0;

            results.forEach((result, index) => {
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
                this.processGeoJSON(combinedGeoJSON);
            }
            
            // Upload to server and save metadata to cache
            this.uploadToServerAndSave().catch(console.error);
            
            const errorMsg = errors.length > 0 ? ` (${errors.length} error(s))` : '';
            const totalFeatures = allFeatures.length;
            const addedCount = newFeatures.length;
            const fileInfoText = `✓ Loaded ${loadedCount} file(s)${errorMsg}: ${addedCount} features (Total: ${totalFeatures} features)`;
            
            if (fileInfo) {
                fileInfo.textContent = fileInfoText;
            }
            
            // Save file info to storage so it persists across pages
            await storageManager.saveFileInfo(fileInfoText);
            
            const exportBtn = document.getElementById('exportAllBtn');
            if (exportBtn) {
                exportBtn.disabled = false;
            }
        });
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
                            // Try to get sequence ID from track name or metadata
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

    processGeoJSON(geojson) {
        // Synchronous version for small datasets
        this.processGeoJSONSync(geojson);
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
            if (seq.status) {
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
                    `sequence_${i}`
                );

                if (!sequenceMap.has(sequenceId)) {
                    const existingStatus = existingStatusMap.get(sequenceId) || '';
                    sequenceMap.set(sequenceId, {
                        id: sequenceId,
                        features: [],
                        status: existingStatus,
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
                const stats = this.calculateSequenceStats(seq.features);
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
        await this.renderTableAsync();
        this.updateSummary();
    }

    processGeoJSONSync(geojson) {
        if (!geojson.features || !Array.isArray(geojson.features)) {
            console.error('Invalid GeoJSON: missing features array');
            return;
        }

        // Preserve existing status values when refreshing
        const existingStatusMap = new Map();
        this.sequences.forEach(seq => {
            if (seq.status) {
                existingStatusMap.set(String(seq.id), seq.status);
            }
        });

        // Group features by sequence ID
        const sequenceMap = new Map();

        geojson.features.forEach((feature, index) => {
            const sequenceId = String(
                feature.properties?.sequence_id || 
                feature.properties?.sequenceId || 
                feature.properties?.sequence || 
                feature.properties?.id ||
                feature.properties?.seq ||
                `sequence_${index}`
            );

            if (!sequenceMap.has(sequenceId)) {
                const existingStatus = existingStatusMap.get(sequenceId) || '';
                sequenceMap.set(sequenceId, {
                    id: sequenceId,
                    features: [],
                    status: existingStatus,
                    date: new Date().toLocaleDateString()
                });
            }

            sequenceMap.get(sequenceId).features.push(feature);
        });

        // Convert to array and calculate stats
        this.sequences = Array.from(sequenceMap.values()).map(seq => {
            const stats = this.calculateSequenceStats(seq.features);
            return {
                ...seq,
                featureCount: stats.features,
                nodeCount: stats.nodes,
                wayCount: stats.ways
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

        // Reset to first sequence when new data is loaded
        this.currentSequenceIndex = 0;
        
        this.renderTable();
        this.updateSummary();
    }

    calculateSequenceStats(features) {
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

    getFilteredSequences() {
        // Always exclude done and skipped tasks (they're on separate pages)
        return this.sequences.filter(seq => seq.status !== 'done' && seq.status !== 'skipped');
    }

    renderTable() {
        // Synchronous version for small datasets
        this.renderTableSync();
    }

    async renderTableAsync() {
        // Async version - shows one sequence at a time
        const tbody = document.getElementById('taskTableBody');
        if (!tbody) return;

        tbody.innerHTML = '';

        const filteredSequences = this.getFilteredSequences();

        if (filteredSequences.length === 0) {
            tbody.innerHTML = `
                <tr class="empty-row">
                    <td colspan="7" class="empty-message">
                        ${this.sequences.length === 0 ? 'No sequences found in GeoJSON file' : 'No active sequences (all tasks are either done or skipped)'}
                    </td>
                </tr>
            `;
            this.updateNavigationControls(filteredSequences.length);
            return;
        }

        // Ensure current index is valid
        if (this.currentSequenceIndex >= filteredSequences.length) {
            this.currentSequenceIndex = 0;
        }
        if (this.currentSequenceIndex < 0) {
            this.currentSequenceIndex = filteredSequences.length - 1;
        }

        // Show only the current sequence
        const currentSequence = filteredSequences[this.currentSequenceIndex];
        const row = this.createTableRow(currentSequence);
        tbody.appendChild(row);
        
        this.updateNavigationControls(filteredSequences.length);
    }

    updateNavigationControls(totalSequences) {
        const prevBtn = document.getElementById('prevBtn');
        const nextBtn = document.getElementById('nextBtn');
        const counter = document.getElementById('sequenceCounter');
        const exportCurrentBtn = document.getElementById('exportCurrentBtn');

        if (totalSequences === 0) {
            if (prevBtn) prevBtn.style.display = 'none';
            if (nextBtn) nextBtn.style.display = 'none';
            if (counter) counter.textContent = '';
            if (exportCurrentBtn) exportCurrentBtn.style.display = 'none';
            return;
        }

        // Show navigation controls
        if (prevBtn) prevBtn.style.display = 'inline-block';
        if (nextBtn) nextBtn.style.display = 'inline-block';
        if (exportCurrentBtn) exportCurrentBtn.style.display = 'inline-block';
        
        // Update counter
        if (counter) {
            counter.textContent = `Sequence ${this.currentSequenceIndex + 1} of ${totalSequences}`;
        }

        // Enable/disable buttons
        if (prevBtn) {
            prevBtn.disabled = this.currentSequenceIndex === 0;
        }
        if (nextBtn) {
            nextBtn.disabled = this.currentSequenceIndex === totalSequences - 1;
        }
    }

    showPreviousSequence() {
        const filteredSequences = this.getFilteredSequences();
        if (filteredSequences.length === 0) return;
        
        this.currentSequenceIndex--;
        if (this.currentSequenceIndex < 0) {
            this.currentSequenceIndex = filteredSequences.length - 1;
        }
        this.renderTable();
    }

    showNextSequence() {
        const filteredSequences = this.getFilteredSequences();
        if (filteredSequences.length === 0) return;
        
        this.currentSequenceIndex++;
        if (this.currentSequenceIndex >= filteredSequences.length) {
            this.currentSequenceIndex = 0;
        }
        this.renderTable();
    }

    exportCurrentSequence() {
        const filteredSequences = this.getFilteredSequences();
        if (filteredSequences.length === 0 || this.currentSequenceIndex >= filteredSequences.length) {
            alert('No sequence to export');
            return;
        }
        
        const currentSequence = filteredSequences[this.currentSequenceIndex];
        this.exportSequence(currentSequence.id);
    }

    renderTableSync() {
        const tbody = document.getElementById('taskTableBody');
        if (!tbody) return;

        tbody.innerHTML = '';

        const filteredSequences = this.getFilteredSequences();

        if (filteredSequences.length === 0) {
            tbody.innerHTML = `
                <tr class="empty-row">
                    <td colspan="7" class="empty-message">
                        ${this.sequences.length === 0 ? 'No sequences found in GeoJSON file' : 'No active sequences (all tasks are either done or skipped)'}
                    </td>
                </tr>
            `;
            this.updateNavigationControls(filteredSequences.length);
            return;
        }

        // Ensure current index is valid
        if (this.currentSequenceIndex >= filteredSequences.length) {
            this.currentSequenceIndex = 0;
        }
        if (this.currentSequenceIndex < 0) {
            this.currentSequenceIndex = filteredSequences.length - 1;
        }

        // Show only the current sequence
        const currentSequence = filteredSequences[this.currentSequenceIndex];
        const row = this.createTableRow(currentSequence);
        tbody.appendChild(row);
        
        this.updateNavigationControls(filteredSequences.length);
    }

    createTableRow(sequence) {
        const row = document.createElement('tr');
        row.dataset.sequenceId = sequence.id;

        const escapedId = String(sequence.id).replace(/'/g, "\\'");
        
        row.innerHTML = `
            <td class="col-id">${sequence.id}</td>
            <td class="col-status">
                <select class="status-dropdown" data-sequence-id="${sequence.id}" onchange="taskManager.updateSequenceStatus('${escapedId}', this.value)">
                    <option value="" ${!sequence.status || sequence.status === '' ? 'selected' : ''}></option>
                    <option value="skipped" ${sequence.status === 'skipped' ? 'selected' : ''}>Skipped</option>
                    <option value="done" ${sequence.status === 'done' ? 'selected' : ''}>Done</option>
                </select>
            </td>
            <td class="col-features">${sequence.featureCount}</td>
            <td class="col-nodes">${sequence.nodeCount}</td>
            <td class="col-ways">${sequence.wayCount}</td>
            <td class="col-date">${sequence.date}</td>
            <td class="col-actions">
                <button class="btn btn-preview" onclick="taskManager.previewSequence('${escapedId}')">
                    👁️ Preview
                </button>
                <button class="btn btn-josm" onclick="taskManager.openInJOSM('${escapedId}')">
                    🗺️ Open in JOSM
                </button>
                <button class="btn btn-export" onclick="taskManager.exportSequence('${escapedId}')">
                    📥 Download
                </button>
            </td>
        `;

        return row;
    }


    exportSequence(sequenceId) {
        // Convert to string for comparison
        const idStr = String(sequenceId);
        const sequence = this.sequences.find(s => String(s.id) === idStr);
        if (!sequence) {
            alert('Sequence not found');
            return;
        }

        try {
            const josmXml = this.generateJOSMForSequence(sequence);
            this.downloadFile(josmXml, `sequence_${sequenceId}.osm`, 'application/xml');
        } catch (error) {
            console.error('Export error:', error);
            alert(`Error exporting sequence: ${error.message}`);
        }
    }

    async openInJOSM(sequenceId) {
        // Convert to string for comparison
        const idStr = String(sequenceId);
        let sequence = this.sequences.find(s => String(s.id) === idStr);
        
        // If sequence doesn't have features, fetch from server
        if (!sequence || !sequence.features) {
            try {
                sequence = await sequenceAPI.getSequence(idStr);
            } catch (error) {
                console.warn('Failed to fetch from server, using local data:', error);
                if (!sequence) {
                    alert('Sequence not found');
                    return;
                }
            }
        }

        // Update status
        try {
            const josmXml = this.generateJOSMForSequence(sequence);
            
            // Use JOSM remote control HTTP API (port 8111)
            // Method 1: Try POST with data in body (most reliable)
            const base64Data = btoa(unescape(encodeURIComponent(josmXml)));
            
            // Try POST method first - JOSM load_data expects data as form parameter
            // Format: POST to /load_data with body: data=<base64_encoded_xml>
            fetch('http://localhost:8111/load_data', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                body: `data=${encodeURIComponent(base64Data)}`,
                mode: 'no-cors' // Bypass CORS for localhost
            })
                .then(() => {
                    // With no-cors, we can't check response, so assume success
                    alert('Successfully loaded into JOSM!');
                })
                .catch(error => {
                    console.log('POST method failed, trying GET method:', error);
                    // Fallback: Try GET method
                    const josmUrl = `http://localhost:8111/load_data?data=${encodeURIComponent(base64Data)}`;
                    return fetch(josmUrl, {
                        method: 'GET',
                        mode: 'no-cors'
                    });
                })
                .then(() => {
                    // If we get here, GET worked
                    alert('Successfully loaded into JOSM!');
                })
                .catch(error => {
                    console.log('Fetch methods failed, trying iframe method:', error);
                    // Final fallback: use iframe method (bypasses CORS completely)
                    const base64Data = btoa(unescape(encodeURIComponent(josmXml)));
                    const josmUrl = `http://localhost:8111/load_data?data=${encodeURIComponent(base64Data)}`;
                    const iframe = document.createElement('iframe');
                    iframe.style.display = 'none';
                    iframe.src = josmUrl;
                    document.body.appendChild(iframe);
                    
                    // Check if it worked after a delay
                    setTimeout(() => {
                        document.body.removeChild(iframe);
                        const worked = confirm('Attempted to load into JOSM via remote control. Did it work?\n\n(If JOSM didn\'t open or load the data, make sure:\n1. JOSM is running\n2. Remote control is enabled in Preferences\n3. "Import data from URL" is checked)\n\nWould you like to download the file instead?');
                        if (!worked) {
                            this.downloadFile(josmXml, `sequence_${sequenceId}.osm`, 'application/xml');
                        }
                    }, 2000);
                });
        } catch (error) {
            console.error('JOSM open error:', error);
            alert(`Error opening in JOSM: ${error.message}`);
        }
    }

    async exportAllSelected() {
        if (this.selectedSequences.size === 0) {
            alert('Please select at least one sequence to export');
            return;
        }

        const selected = Array.from(this.selectedSequences);
        let exported = 0;

        for (const sequenceId of selected) {
            let sequence = this.sequences.find(s => s.id === sequenceId);
            
            // If sequence doesn't have features, fetch from server
            if (!sequence || !sequence.features) {
                try {
                    sequence = await sequenceAPI.getSequence(String(sequenceId));
                } catch (error) {
                    console.error(`Error fetching sequence ${sequenceId}:`, error);
                    continue;
                }
            }
            
            if (sequence) {
                try {
                    const josmXml = this.generateJOSMForSequence(sequence);
                    this.downloadFile(josmXml, `sequence_${sequenceId}.osm`, 'application/xml');
                    exported++;
                } catch (error) {
                    console.error(`Error exporting ${sequenceId}:`, error);
                }
            }
        }

        this.renderTable();
        alert(`Exported ${exported} of ${selected.length} sequences`);
    }

    generateJOSMForSequence(sequence) {
        // Default Singapore coordinates
        const defaultLat = 1.301965;
        const defaultLng = 103.9003035;

        let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
        xml += '<osm version="0.6" generator="OSMAGIC Task Manager">\n';
        xml += `  <!-- Sequence ID: ${sequence.id} -->\n`;
        xml += `  <!-- Features: ${sequence.featureCount} -->\n`;
        xml += `  <!-- Generated: ${new Date().toISOString()} -->\n\n`;

        let nodeId = -1000;
        let wayId = -1000;
        const nodeMap = new Map();
        const nodeTolerance = 0.00001; // ~1 meter

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

            // Add tags from properties
            if (feature.properties) {
                Object.entries(feature.properties).forEach(([key, value]) => {
                    if (key !== 'sequence_id' && key !== 'sequenceId' && key !== 'sequence' && key !== 'seq') {
                        xml += `    <tag k="${this.escapeXml(key)}" v="${this.escapeXml(String(value))}" />\n`;
                    }
                });
            }

            // Default highway tag if not present
            if (!feature.properties?.highway) {
                xml += `    <tag k="highway" v="unclassified" />\n`;
            }

            xml += `    <tag k="source" v="OSMAGIC Task Manager" />\n`;
            xml += `    <tag k="sequence_id" v="${sequence.id}" />\n`;
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


    async updateSequenceStatus(sequenceId, newStatus) {
        const idStr = String(sequenceId);
        const sequence = this.sequences.find(s => String(s.id) === idStr);
        if (sequence) {
            const oldStatus = sequence.status;
            sequence.status = newStatus;
            
            // If marked as "done", save to completed tasks
            if (newStatus === 'done') {
                await this.saveCompletedTask(sequence);
                // Remove from skipped if it was skipped
                if (oldStatus === 'skipped') {
                    await this.removeSkippedTask(sequenceId);
                }
            } 
            // If marked as "skipped", save to skipped tasks
            else if (newStatus === 'skipped') {
                await this.saveSkippedTask(sequence);
                // Remove from completed if it was done
                if (oldStatus === 'done') {
                    await this.removeCompletedTask(sequenceId);
                }
            }
            // If unmarking from "done" or "skipped", remove from respective lists
            else {
                if (oldStatus === 'done') {
                    await this.removeCompletedTask(sequenceId);
                } else if (oldStatus === 'skipped') {
                    await this.removeSkippedTask(sequenceId);
                }
            }
            
            // Save metadata to cache (and upload to server if needed)
            await this.uploadToServerAndSave();
            
            this.renderTable(); // Re-render to apply filter
            this.updateSummary(); // Update summary counts
        }
    }

    async saveCompletedTask(sequence) {
        try {
            // OPTIMIZATION: Don't store full features - only store metadata
            // Features can be reconstructed from geojsonData when needed for preview/export
            const taskData = {
                id: String(sequence.id),
                status: sequence.status,
                featureCount: sequence.featureCount,
                nodeCount: sequence.nodeCount,
                wayCount: sequence.wayCount,
                date: sequence.date,
                completedDate: new Date().toISOString()
                // Don't store features - reconstruct from geojsonData when needed
            };
            
            await storageManager.saveCompletedTask(taskData);
        } catch (error) {
            console.error('Error saving completed task:', error);
        }
    }

    async removeCompletedTask(sequenceId) {
        try {
            await storageManager.removeCompletedTask(sequenceId);
        } catch (error) {
            console.error('Error removing completed task:', error);
        }
    }

    async getCompletedTasks() {
        try {
            return await storageManager.getAllCompletedTasks();
        } catch (error) {
            console.error('Error loading completed tasks:', error);
            return [];
        }
    }

    async saveSkippedTask(sequence) {
        try {
            // OPTIMIZATION: Don't store full features - only store metadata
            // Features can be reconstructed from geojsonData when needed for preview/export
            const taskData = {
                id: String(sequence.id),
                status: sequence.status,
                featureCount: sequence.featureCount,
                nodeCount: sequence.nodeCount,
                wayCount: sequence.wayCount,
                date: sequence.date,
                skippedDate: new Date().toISOString()
                // Don't store features - reconstruct from geojsonData when needed
            };
            
            await storageManager.saveSkippedTask(taskData);
        } catch (error) {
            console.error('Error saving skipped task:', error);
        }
    }

    async removeSkippedTask(sequenceId) {
        try {
            await storageManager.removeSkippedTask(sequenceId);
        } catch (error) {
            console.error('Error removing skipped task:', error);
        }
    }

    async getSkippedTasks() {
        try {
            return await storageManager.getAllSkippedTasks();
        } catch (error) {
            console.error('Error loading skipped tasks:', error);
            return [];
        }
    }

    updateSummary() {
        const summary = document.getElementById('summaryInfo');
        const filteredSequences = this.getFilteredSequences();
        const totalFeatures = this.sequences.reduce((sum, seq) => sum + seq.featureCount, 0);
        const doneCount = this.sequences.filter(seq => seq.status === 'done').length;
        const skippedCount = this.sequences.filter(seq => seq.status === 'skipped').length;
        const blankCount = this.sequences.filter(seq => !seq.status || seq.status === '').length;

        summary.innerHTML = `
            <span>Total Sequences: ${this.sequences.length}</span>
            <span>Showing: ${filteredSequences.length}</span>
            <span>Total Features: ${totalFeatures}</span>
            <span>Done: ${doneCount}</span>
            <span>Skipped: ${skippedCount}</span>
            <span>Blank: ${blankCount}</span>
        `;
    }

    async previewSequence(sequenceId) {
        // Convert to string for comparison
        const idStr = String(sequenceId);
        let sequence = this.sequences.find(s => String(s.id) === idStr);
        
        // If sequence doesn't have features, fetch from server
        if (!sequence || !sequence.features) {
            try {
                sequence = await sequenceAPI.getSequence(idStr);
            } catch (error) {
                console.warn('Failed to fetch from server, using local data:', error);
                if (!sequence) {
                    alert('Sequence not found');
                    return;
                }
            }
        }

        this.currentPreviewSequence = sequence;
        document.getElementById('previewSequenceId').textContent = idStr;
        
        // Show modal
        const modal = document.getElementById('previewModal');
        modal.style.display = 'block';

        // Initialize map - need to wait a bit for modal to be visible
        setTimeout(() => {
            if (!this.map) {
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
                if (layer instanceof L.GeoJSON) {
                    this.map.removeLayer(layer);
                }
            });

            // Create GeoJSON from sequence features
            const geojson = {
                type: 'FeatureCollection',
                features: sequence.features
            };

            // Add GeoJSON layer to map
            const geoJsonLayer = L.geoJSON(geojson, {
                style: (feature) => {
                    return {
                        color: '#3388ff',
                        weight: 4,
                        opacity: 0.8
                    };
                },
                onEachFeature: (feature, layer) => {
                    if (feature.properties) {
                        const props = Object.entries(feature.properties)
                            .map(([key, value]) => `${key}: ${value}`)
                            .join('<br>');
                        layer.bindPopup(`<strong>Properties:</strong><br>${props}`);
                    }
                }
            }).addTo(this.map);

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

    closePreview() {
        const modal = document.getElementById('previewModal');
        modal.style.display = 'none';
        this.currentPreviewSequence = null;
        
        // Invalidate map size when hidden
        if (this.map) {
            setTimeout(() => {
                this.map.invalidateSize();
            }, 100);
        }
    }

    exportFromPreview() {
        if (this.currentPreviewSequence) {
            this.exportSequence(this.currentPreviewSequence.id);
            this.closePreview();
        }
    }

    async uploadToServerAndSave() {
        try {
            // Upload full dataset to server (if available)
            if (this.geojsonData && this.sequences.length > 0) {
                try {
                    await sequenceAPI.uploadDataset(this.geojsonData, this.sequences);
                    console.log('Dataset uploaded to server successfully');
                } catch (serverError) {
                    console.warn('Server upload failed, falling back to local storage:', serverError);
                    // Fallback to local storage if server is not available
                    await this.saveToCacheLocal();
                    return;
                }
            }
            
            // Save only metadata to local cache (no GeoJSON data)
            const activeSequences = this.sequences
                .filter(seq => seq.status !== 'done' && seq.status !== 'skipped')
                .map(seq => ({
                    id: seq.id,
                    status: seq.status,
                    featureCount: seq.featureCount,
                    nodeCount: seq.nodeCount,
                    wayCount: seq.wayCount,
                    date: seq.date
                }));
            
            const cacheData = {
                sequences: activeSequences, // Only metadata, no features, no geojsonData
                timestamp: new Date().toISOString(),
                serverMode: true // Flag to indicate server-side storage
            };
            await storageManager.saveActiveTasksCache(cacheData);
        } catch (error) {
            console.error('Error uploading to server:', error);
            // Fallback to local storage
            await this.saveToCacheLocal();
        }
    }

    async saveToCacheLocal() {
        // Fallback: Save to local storage if server is unavailable
        try {
            const activeSequences = this.sequences
                .filter(seq => seq.status !== 'done' && seq.status !== 'skipped')
                .map(seq => ({
                    id: seq.id,
                    status: seq.status,
                    featureCount: seq.featureCount,
                    nodeCount: seq.nodeCount,
                    wayCount: seq.wayCount,
                    date: seq.date
                }));
            
            const cacheData = {
                geojsonData: this.geojsonData, // Store full GeoJSON locally as fallback
                sequences: activeSequences,
                timestamp: new Date().toISOString(),
                serverMode: false
            };
            await storageManager.saveActiveTasksCache(cacheData);
        } catch (error) {
            console.error('Error saving to local cache:', error);
            alert('Error saving data. Your browser storage may be full.');
        }
    }

    async loadFromCache() {
        try {
            const cacheData = await storageManager.loadActiveTasksCache();
            if (!cacheData) return;

            // Check if we're in server mode
            if (cacheData.serverMode) {
                // Try to load from server
                try {
                    const serverAvailable = await sequenceAPI.checkServerStatus();
                    if (serverAvailable) {
                        // Load GeoJSON from server
                        this.geojsonData = await sequenceAPI.getGeoJSON();
                        // Reprocess to get sequences
                        this.processGeoJSON(this.geojsonData);
                        // Restore status from cached sequences
                        const statusMap = new Map();
                        cacheData.sequences.forEach(seq => {
                            statusMap.set(String(seq.id), seq.status);
                        });
                        this.sequences.forEach(seq => {
                            const cachedStatus = statusMap.get(String(seq.id));
                            if (cachedStatus !== undefined) {
                                seq.status = cachedStatus;
                            }
                        });
                    } else {
                        throw new Error('Server not available');
                    }
                } catch (serverError) {
                    console.warn('Server not available, trying local fallback:', serverError);
                    // Fallback to local storage if available
                    if (cacheData.geojsonData) {
                        this.geojsonData = cacheData.geojsonData;
                        this.processGeoJSON(cacheData.geojsonData);
                        const statusMap = new Map();
                        cacheData.sequences.forEach(seq => {
                            statusMap.set(String(seq.id), seq.status);
                        });
                        this.sequences.forEach(seq => {
                            const cachedStatus = statusMap.get(String(seq.id));
                            if (cachedStatus !== undefined) {
                                seq.status = cachedStatus;
                            }
                        });
                    } else {
                        console.warn('No local fallback data available');
                        return;
                    }
                }
            } else {
                // Legacy mode: load from local storage
                if (cacheData.geojsonData) {
                    this.geojsonData = cacheData.geojsonData;
                }
                
                if (cacheData.sequences && Array.isArray(cacheData.sequences)) {
                    if (cacheData.geojsonData) {
                        this.processGeoJSON(cacheData.geojsonData);
                        const statusMap = new Map();
                        cacheData.sequences.forEach(seq => {
                            statusMap.set(String(seq.id), seq.status);
                        });
                        this.sequences.forEach(seq => {
                            const cachedStatus = statusMap.get(String(seq.id));
                            if (cachedStatus !== undefined) {
                                seq.status = cachedStatus;
                            }
                        });
                    } else if (cacheData.sequences.length > 0 && cacheData.sequences[0].features) {
                        this.sequences = cacheData.sequences;
                    }
                }
            }
            
            // Render table if we have data
            if (this.sequences.length > 0) {
                this.renderTable();
                this.updateSummary();
                const exportBtn = document.getElementById('exportAllBtn');
                if (exportBtn) {
                    exportBtn.disabled = false;
                }
            }
        } catch (error) {
            console.error('Error loading from cache:', error);
        }
    }

    async loadFileInfo() {
        try {
            const fileInfo = await storageManager.loadFileInfo();
            const fileInfoElement = document.getElementById('fileInfo');
            if (fileInfo && fileInfoElement) {
                fileInfoElement.textContent = fileInfo;
            }
        } catch (error) {
            console.error('Error loading file info:', error);
        }
    }

    async finishReview() {
        if (confirm('Finish reviewing this project?\n\nThis will clear:\n• All active tasks\n• All skipped tasks\n• All completed tasks\n• All uploaded files\n• Server data\n\nData will be permanently removed. This action cannot be undone!')) {
            try {
                // Clear server data first
                try {
                    await sequenceAPI.clearAll();
                    console.log('Server data cleared');
                } catch (serverError) {
                    console.warn('Could not clear server data (server may not be running):', serverError);
                }
                
                // Clear all caches from IndexedDB - this clears everything
                // Wait for the transaction to complete
                await storageManager.clearAllData();
                
                // Small delay to ensure transaction completes
                await new Promise(resolve => setTimeout(resolve, 200));
                
                // Double-check: Verify data is cleared
                let completedTasks = await storageManager.getAllCompletedTasks();
                let skippedTasks = await storageManager.getAllSkippedTasks();
                
                if (completedTasks.length > 0 || skippedTasks.length > 0) {
                    console.warn('Some data still exists, force clearing...');
                    // Force clear again with individual calls
                    await storageManager.clearAllSkippedTasks();
                    await storageManager.clearAllCompletedTasks();
                    await storageManager.clearActiveTasksCache();
                    await storageManager.clearFileInfo();
                    
                    // Wait again
                    await new Promise(resolve => setTimeout(resolve, 200));
                    
                    // Use force clear method to delete by key
                    await storageManager.forceClearAllData();
                    
                    // Wait once more
                    await new Promise(resolve => setTimeout(resolve, 200));
                    
                    // Verify again
                    completedTasks = await storageManager.getAllCompletedTasks();
                    skippedTasks = await storageManager.getAllSkippedTasks();
                    
                    if (completedTasks.length > 0 || skippedTasks.length > 0) {
                        console.error('Data still exists after clearing:', {
                            completed: completedTasks.length,
                            skipped: skippedTasks.length
                        });
                        // Log the IDs that remain
                        if (completedTasks.length > 0) {
                            console.error('Remaining completed tasks:', completedTasks.map(t => t.id));
                        }
                        if (skippedTasks.length > 0) {
                            console.error('Remaining skipped tasks:', skippedTasks.map(t => t.id));
                        }
                    }
                }
                
                // Reset local data
                this.geojsonData = null;
                this.sequences = [];
                this.selectedSequences.clear();
                this.currentSequenceIndex = 0;
                
                // Clear file input
                const fileInput = document.getElementById('geojsonFileInput');
                if (fileInput) {
                    fileInput.value = '';
                }
                
                // Clear file info
                const fileInfo = document.getElementById('fileInfo');
                if (fileInfo) {
                    fileInfo.textContent = '';
                }
                
                // Re-render
                this.renderTable();
                this.updateSummary();
                this.updateNavigationControls(0);
                
                const exportBtn = document.getElementById('exportAllBtn');
                if (exportBtn) {
                    exportBtn.disabled = true;
                }
                
                const exportCurrentBtn = document.getElementById('exportCurrentBtn');
                if (exportCurrentBtn) {
                    exportCurrentBtn.style.display = 'none';
                }
                
                // Set a timestamp to indicate data was cleared
                // This will be checked by other pages when they become visible
                try {
                    const clearTimestamp = Date.now().toString();
                    localStorage.setItem('taskManagerDataCleared', clearTimestamp);
                    // Also set a flag that persists
                    localStorage.setItem('taskManagerDataClearedFlag', clearTimestamp);
                    // Trigger storage event (works across tabs)
                    // Note: storage event only fires in OTHER tabs, not the current one
                    setTimeout(() => {
                        localStorage.removeItem('taskManagerDataCleared');
                    }, 100);
                } catch (e) {
                    console.warn('Could not trigger storage event:', e);
                }
                
                alert('Project review completed! All data has been cleared.\n\nThe Skipped and Completed pages will automatically refresh when you switch to them.');
            } catch (error) {
                console.error('Error finishing review:', error);
                alert('Error clearing data: ' + error.message + '\n\nPlease try again.');
            }
        }
    }
}

// Initialize task manager when page loads
let taskManager;
document.addEventListener('DOMContentLoaded', () => {
    taskManager = new TaskManager();
});


