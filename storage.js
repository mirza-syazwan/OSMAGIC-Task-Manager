// IndexedDB Storage Manager for OSMAGIC Task Manager
class StorageManager {
    constructor() {
        this.dbName = 'OSMAGIC_TaskManager';
        this.dbVersion = 1;
        this.db = null;
    }

    async init() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.dbVersion);

            request.onerror = () => {
                console.error('IndexedDB error:', request.error);
                reject(request.error);
            };

            request.onsuccess = () => {
                this.db = request.result;
                resolve(this.db);
            };

            request.onupgradeneeded = (event) => {
                const db = event.target.result;

                // Create object stores if they don't exist
                if (!db.objectStoreNames.contains('taskData')) {
                    const taskStore = db.createObjectStore('taskData', { keyPath: 'id' });
                    taskStore.createIndex('timestamp', 'timestamp', { unique: false });
                }

                if (!db.objectStoreNames.contains('geojsonData')) {
                    db.createObjectStore('geojsonData', { keyPath: 'id' });
                }
            };
        });
    }

    async saveTaskData(data) {
        if (!this.db) await this.init();

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['taskData'], 'readwrite');
            const store = transaction.objectStore('taskData');
            
            const taskData = {
                id: 'main',
                sequences: data.sequences,
                currentIndex: data.currentIndex,
                currentView: data.currentView || 'all',
                timestamp: new Date().toISOString()
            };

            const request = store.put(taskData);

            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    async loadTaskData() {
        if (!this.db) await this.init();

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['taskData'], 'readonly');
            const store = transaction.objectStore('taskData');
            const request = store.get('main');

            request.onsuccess = () => {
                resolve(request.result || null);
            };

            request.onerror = () => reject(request.error);
        });
    }

    async saveGeoJSONData(geojsonData) {
        if (!this.db) await this.init();

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['geojsonData'], 'readwrite');
            const store = transaction.objectStore('geojsonData');
            
            const data = {
                id: 'main',
                geojson: geojsonData,
                timestamp: new Date().toISOString()
            };

            const request = store.put(data);

            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    async loadGeoJSONData() {
        if (!this.db) await this.init();

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['geojsonData'], 'readonly');
            const store = transaction.objectStore('geojsonData');
            const request = store.get('main');

            request.onsuccess = () => {
                resolve(request.result ? request.result.geojson : null);
            };

            request.onerror = () => reject(request.error);
        });
    }

    async clearAll() {
        if (!this.db) await this.init();

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['taskData', 'geojsonData'], 'readwrite');
            
            const taskRequest = transaction.objectStore('taskData').clear();
            const geoRequest = transaction.objectStore('geojsonData').clear();

            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error);
        });
    }
}

// Create global instance
const storageManager = new StorageManager();

