# OSMAGIC Task Manager

A task manager to convert GPS traces (GeoJSON, GPX, CSV) to JOSM format with automatic transfer to JOSM.

## Quick Start

### Option 1: Run the Server (Recommended)

1. **Double-click `start-server.bat`** (Windows)
   - OR run: `python server.py` in terminal

2. **Open your browser and go to:**
   ```
   http://localhost:8000
   ```

3. Upload your GPS trace file and start managing tasks!

### Option 2: Open Directly

Just double-click `index.html` to open it in your browser (no server needed).
**Note:** Automatic JOSM transfer requires the server to be running.

## Features

- ✅ Upload GPS traces (GeoJSON, GPX, CSV formats)
- ✅ Identify sequences by sequence_id
- ✅ View tasks by status (All, Active, Done, Skipped)
- ✅ Status management (Active, Skipped, Done)
- ✅ Convert to JOSM format (.osm files)
- ✅ **Automatic transfer to JOSM** (requires JOSM Remote Control enabled)
- ✅ Interactive map preview with geometry editing
- ✅ Local storage persistence (IndexedDB)

## Requirements

- Python 3.x (for server and automatic JOSM transfer)
- JOSM (for automatic transfer feature)
- Modern web browser

## JOSM Setup (for Automatic Transfer)

1. **Enable Remote Control in JOSM:**
   - Open JOSM
   - Go to: Edit → Preferences → Remote Control
   - Check "Enable remote control"
   - Check "Import data from URL" (if available)
   - Keep JOSM running while using the app

2. **Test Connection:**
   - Open `http://localhost:8111/version` in your browser
   - You should see JOSM version information

## Usage

1. **Start the server:** Double-click `start-server.bat` or run `python server.py`
2. **Open the app:** Go to `http://localhost:8000` in your browser
3. **Upload data:** Click "Choose GeoJSON File" and select your GPS trace file
4. **Navigate tasks:** Use the tabs (All, Active, Done, Skipped) to view tasks
5. **Edit geometry:** Click "Preview" to edit GPS traces on an interactive map
6. **Export to JOSM:** Click "Export to JOSM" - data will automatically transfer to JOSM!

## Automatic JOSM Transfer

When you click "Export to JOSM":
1. The OSM file is uploaded to the server
2. Server makes it available at `http://localhost:8000/exports/sequence_XXX.osm`
3. JOSM's import endpoint is called with the file URL
4. JOSM automatically loads the data - **no manual navigation needed!**

If automatic transfer fails, the file will be downloaded as a backup.

## Notes

- Exported OSM files are stored in the `exports/` directory
- All data is saved to browser's IndexedDB (larger storage capacity than localStorage)
- No internet connection required (everything runs locally)

