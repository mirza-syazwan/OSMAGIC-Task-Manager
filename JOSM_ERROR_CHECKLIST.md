# JOSM Remote Control Error Checking Checklist

## Pre-Testing Setup

### ✅ Step 1: Verify JOSM is Running
- [ ] Open JOSM application
- [ ] Check that JOSM window is visible and not minimized
- [ ] Verify JOSM is not frozen or crashed

### ✅ Step 2: Enable Remote Control in JOSM
- [ ] In JOSM, go to: **Edit → Preferences** (or press `F12`)
- [ ] Click on **"Remote Control"** in the left sidebar
- [ ] Check the box: **"Enable remote control"**
- [ ] Check the box: **"Import data from URL"** (if available)
- [ ] Click **"OK"** to save settings
- [ ] **Keep JOSM running** (don't close it)

### ✅ Step 3: Test JOSM Remote Control Connection
- [ ] Open your web browser
- [ ] Go to: `http://localhost:8111/version`
- [ ] **Expected Result**: You should see JSON like:
  ```json
  {"protocolversion":{"major":1,"minor":13},"application":"JOSM RemoteControl","version":19439,"osm_server":"default"}
  ```
- [ ] **If you see this**: Remote Control is working ✅
- [ ] **If you get an error**: 
  - JOSM is not running, OR
  - Remote Control is not enabled, OR
  - Port 8111 is blocked by firewall

### ✅ Step 4: Start Your Application Server
- [ ] Open terminal/command prompt in your project folder
- [ ] Run: `python server.py` (or double-click `start-server.bat`)
- [ ] You should see: `Serving HTTP on 0.0.0.0 port 8000...`
- [ ] **Keep this terminal open** (don't close it)

### ✅ Step 5: Open Your Application
- [ ] Open your web browser
- [ ] Go to: `http://localhost:8000`
- [ ] **Open Browser Console**:
  - Press `F12`, OR
  - Right-click → **Inspect** → **Console** tab
- [ ] **Keep console open** during testing

---

## Testing Export to JOSM

### ✅ Step 6: Load Data (if needed)
- [ ] If you don't have data loaded:
  - Click **"Choose GeoJSON File"**
  - Select your GPS trace file (GeoJSON, GPX, or CSV)
  - Wait for processing to complete
- [ ] Verify data is loaded (you should see sequence IDs)

### ✅ Step 7: Navigate to a Task
- [ ] Go to the **"Active"** tab
- [ ] Select a sequence ID that has data
- [ ] Verify you can see: Sequence ID, Status, Features, Nodes, Ways

### ✅ Step 8: Export to JOSM
- [ ] Click the **"Export to JOSM"** button
- [ ] **Watch the browser console** for messages

---

## Error Checking - Console Messages

### ✅ Step 9: Check Console for Connectivity
Look for this message in console:
```
JOSM version: {"protocolversion":{"major":1,"minor":13},...}
```
- [ ] **If you see this**: JOSM connection is working ✅
- [ ] **If you see error**: 
  - Check Step 2 (Remote Control enabled?)
  - Check Step 3 (version endpoint works?)

### ✅ Step 10: Check Console for Data Preparation
Look for this message:
```
Sending to JOSM: {xmlLength: 2575}
```
- [ ] **If you see this**: XML is being generated ✅
- [ ] **If xmlLength is 0**: No data in sequence (check your data)

### ✅ Step 11: Check Console for Method Attempted
Look for one of these messages:
```
Trying import endpoint with data URI, URL length: ...
```
OR
```
Trying load_data with format=xml parameter
```
- [ ] **If you see "import endpoint"**: Method 1 is being tried ✅
- [ ] **If you see "load_data"**: Method 1 failed, trying Method 2

### ✅ Step 12: Check for HTTP Errors
Look for red error messages in console:
- [ ] **400 Bad Request**: Data format issue (check encoding)
- [ ] **404 Not Found**: Endpoint doesn't exist (JOSM version issue?)
- [ ] **500 Internal Server Error**: JOSM processing error
- [ ] **Network Error**: Can't connect to JOSM (check Step 2 & 3)

---

## Success Verification

### ✅ Step 13: Check JOSM Window
- [ ] Look at your **JOSM window**
- [ ] **Expected**: GPS trace data should appear on the map
- [ ] **Expected**: You should see nodes and ways
- [ ] **Expected**: Data should match what you edited in preview

### ✅ Step 14: Respond to Confirmation Dialog
- [ ] After 2 seconds, you'll see: **"Data sent to JOSM via import!"**
- [ ] After 4 seconds, you'll see: **"Did the data appear in JOSM?"**
- [ ] **If data appeared**: Click **"Cancel"** (you're done! ✅)
- [ ] **If data didn't appear**: Click **"OK"** (will try fallback method)

---

## Troubleshooting Common Errors

### ❌ Error: "Cannot connect to JOSM Remote Control"
**Check:**
- [ ] JOSM is running
- [ ] Remote Control is enabled (Step 2)
- [ ] Port 8111 is not blocked
- [ ] Try Step 3 (test version endpoint)

### ❌ Error: "400 Bad Request"
**Possible causes:**
- [ ] Data encoding issue
- [ ] URL too long
- [ ] JOSM can't parse the data format

**Try:**
- [ ] Check console for exact error message
- [ ] Verify XML is valid (check console log)
- [ ] Try the fallback method (should happen automatically)

### ❌ Error: "501 Not Implemented"
**This is normal** - JOSM doesn't support POST for load_data
- [ ] Code will automatically try GET/iframe methods
- [ ] No action needed

### ❌ Data doesn't appear in JOSM
**Check:**
- [ ] JOSM window is visible (not minimized)
- [ ] JOSM map is zoomed to correct location
- [ ] Check JOSM layers panel (data might be in a layer)
- [ ] Try zooming out in JOSM to see if data is there

---

## Final Checklist

After testing, verify:
- [ ] JOSM Remote Control is enabled
- [ ] `http://localhost:8111/version` works in browser
- [ ] Browser console shows no red errors
- [ ] Data appears in JOSM automatically
- [ ] If not, fallback download works

---

## Quick Reference: Console Messages to Look For

✅ **Good Messages:**
- `JOSM version: {...}` - Connection working
- `Sending to JOSM: {xmlLength: ...}` - Data prepared
- `Trying import endpoint...` - Method 1 attempted
- `Trying load_data...` - Method 2 attempted

❌ **Error Messages:**
- `Cannot connect to JOSM Remote Control` - Connection issue
- `400 Bad Request` - Data format issue
- `404 Not Found` - Endpoint issue
- `Network Error` - Connection blocked

---

## Need Help?

If errors persist:
1. Copy all console error messages
2. Note which step failed
3. Check JOSM error log: **Help → Show Error Log** in JOSM
4. Verify JOSM version (should be 19439 or newer)

