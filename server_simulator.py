import time
import os
import csv
from datetime import datetime, timedelta
from flask import Flask, Response, send_file, request, jsonify
from flask_cors import CORS
from pathlib import Path

app = Flask(__name__)
CORS(app)

CURDIR = Path(os.path.dirname(os.path.abspath(__file__)))
LOG_FILE = "Z:\\TVAC Log Files\\TVAC SpecView Logs\\Live Log\\SV_Live_log.csv"

def parse_time(ts_str):
    try:
        # Expected format from JS: mm/dd/yyyy hh:mm:ss or yy-mm-dd_hh-mm-ss
        if '_' in ts_str:
            datepart, timepart = ts_str.split('_')
            yy, mm, dd = datepart.split('-')
            hh, mnt, ss = timepart.split('-')
            return datetime.strptime(f"{mm}/{dd}/20{yy} {hh}:{mnt}:{ss}", "%m/%d/%Y %H:%M:%S")
        else:
            return datetime.strptime(ts_str, "%m/%d/%Y %H:%M:%S")
    except:
        return None

def read_file_reverse(filepath, chunk_size=65536):
    """
    Yield lines from a file in reverse order (bottom to top).
    Reads the file in binary chunks to optimize memory and speed.
    """
    with open(filepath, 'rb') as f:
        f.seek(0, os.SEEK_END)
        position = f.tell()
        remainder = b''
        
        while position > 0:
            read_size = min(chunk_size, position)
            position -= read_size
            f.seek(position)
            chunk = f.read(read_size) + remainder
            
            lines = chunk.split(b'\n')
            # The first item might be an incomplete line; save it for the next chunk
            remainder = lines[0] 
            
            # Yield all lines in this chunk in reverse, skipping the remainder
            for line in reversed(lines[1:]):
                if line.strip():
                    yield line.decode('utf-8', errors='ignore')
                    
        # Yield the final remainder at the very top of the file
        if remainder.strip():
            yield remainder.decode('utf-8', errors='ignore')


@app.route('/api/history')
def api_history():
    start_ts = request.args.get('start', type=float) # Unix timestamp
    end_ts = request.args.get('end', type=float)     # Unix timestamp
    interval = request.args.get('interval', default=5, type=int) # minutes
    
    if not os.path.exists(LOG_FILE):
        return jsonify({"error": "Log file not found"}), 404

    results = []
    last_added_time = None
    interval_td = timedelta(minutes=interval)

    # Read from the bottom of the file going upwards
    for line in read_file_reverse(LOG_FILE):
        row = line.split(',')
        
        if not row or len(row) < 14 or row[0].lower().startswith('time'):
            continue
            
        row_time = parse_time(row[0].strip())
        if not row_time:
            continue
            
        row_ts = row_time.timestamp()
        
        # 1. If we are still in the future relative to the requested end_ts, skip it
        if end_ts and row_ts > end_ts:
            continue
            
        # 2. THE MEGA-OPTIMIZATION: 
        # Since we are reading backwards, if we hit a timestamp older than start_ts,
        # we have completely exited the requested time window. Stop reading immediately.
        if start_ts and row_ts < start_ts:
            break
            
        # 3. Downsample based on interval
        # Notice we do (last_added_time - row_time) because last_added_time is newer
        if last_added_time is None or (last_added_time - row_time) >= interval_td:
            formatted_time = row_time.strftime("%m/%d/%Y %H:%M:%S")
            try:
                data_points = [float(x) if x.strip() else 0.0 for x in row[1:15]]
                results.append([formatted_time] + data_points)
                last_added_time = row_time
            except ValueError:
                pass

    # Because we collected the data backwards (newest to oldest), 
    # we must reverse the list so the frontend charts it chronologically.
    results.reverse()
    return jsonify({"data": results})

def generate_log_updates():
    if not os.path.exists(LOG_FILE):
        return

    try:
        last_size = os.path.getsize(LOG_FILE)
    except Exception:
        return

    while True:
        try:
            current_size = os.path.getsize(LOG_FILE)
            if current_size > last_size:
                with open(LOG_FILE, 'r', encoding='utf-8', errors='ignore') as f:
                    f.seek(last_size)
                    new_data = f.read()
                    if new_data:
                        lines = new_data.strip().split('\n')
                        for line in lines:
                            if line.strip():
                                yield f"data: {line.strip()}\n\n"
                last_size = current_size
            elif int(time.time()) % 15 == 0:
                yield "data: heartbeat\n\n"
        except Exception:
            pass
        time.sleep(1)

@app.route('/stream')
def stream():
    return Response(generate_log_updates(), mimetype='text/event-stream')

@app.route('/')
def index():
    return send_file(CURDIR / 'index.html')

@app.route('/script.js')
def script():
    return send_file(CURDIR / 'script.js')

@app.route('/style.css')
def style():
    return send_file(CURDIR / 'style.css')

if __name__ == "__main__":
    app.run(host='0.0.0.0', port=5000, threaded=True)