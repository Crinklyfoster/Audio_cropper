import os
import zipfile
import json
import numpy as np
import librosa
import cv2
import matplotlib
matplotlib.use('Agg')  # Use non-interactive backend
import matplotlib.pyplot as plt
from flask import Flask, request, render_template, jsonify, send_file, url_for
from werkzeug.utils import secure_filename
from pydub import AudioSegment
import tempfile
import shutil
from datetime import datetime
import base64
from io import BytesIO

app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = 500 * 1024 * 1024  # 500MB max file size
app.config['UPLOAD_FOLDER'] = 'uploads'
app.config['SPECTROGRAM_FOLDER'] = 'temp_spectrograms'
app.config['OUTPUT_FOLDER'] = 'output'

# Ensure directories exist
for folder in [app.config['UPLOAD_FOLDER'], app.config['SPECTROGRAM_FOLDER'], app.config['OUTPUT_FOLDER']]:
    os.makedirs(folder, exist_ok=True)

# Global variables to store processing data
batch_data = {}
spectrogram_cache = {}

ALLOWED_EXTENSIONS = {'wav', 'mp3', 'flac', 'aac'}

def allowed_file(filename):
    """Check if file extension is allowed"""
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS

def generate_mel_spectrogram(audio_path, output_path=None):
    """Generate mel spectrogram from audio file"""
    try:
        # Load audio file
        y, sr = librosa.load(audio_path, sr=22050)
        
        # Generate mel spectrogram
        mel_spec = librosa.feature.melspectrogram(
            y=y, sr=sr, n_mels=128, fmax=8000, hop_length=512, n_fft=2048
        )
        mel_spec_db = librosa.power_to_db(mel_spec, ref=np.max)
        
        # Create time axis
        time_frames = librosa.frames_to_time(np.arange(mel_spec.shape[1]), sr=sr, hop_length=512)
        
        # Save as PNG if output path provided
        if output_path:
            plt.figure(figsize=(12, 8))
            librosa.display.specshow(
                mel_spec_db, sr=sr, x_axis='time', y_axis='mel', 
                fmax=8000, cmap='viridis'
            )
            plt.colorbar(format='%+2.0f dB')
            plt.title('Mel Spectrogram')
            plt.tight_layout()
            plt.savefig(output_path, dpi=150, bbox_inches='tight', 
                       facecolor='black', edgecolor='black')
            plt.close()
        
        return mel_spec_db, time_frames, sr
        
    except Exception as e:
        print(f"Error generating spectrogram for {audio_path}: {str(e)}")
        return None, None, None

def detect_switch_noise(mel_spec_db, time_frames, start_time=5.0, end_time=7.0):
    """Detect switch noise in spectrogram using OpenCV"""
    try:
        # Focus on the 5-7 second interval
        start_idx = np.argmin(np.abs(time_frames - start_time))
        end_idx = np.argmin(np.abs(time_frames - end_time))
        
        if start_idx >= end_idx:
            return None, None
        
        # Extract region of interest
        roi = mel_spec_db[:, start_idx:end_idx]
        
        # Normalize to 0-255 range
        roi_normalized = cv2.normalize(roi, None, 0, 255, cv2.NORM_MINMAX, dtype=cv2.CV_8U)
        
        # Apply Gaussian blur to reduce noise
        blurred = cv2.GaussianBlur(roi_normalized, (5, 5), 0)
        
        # Apply threshold to highlight high-energy regions
        _, thresh = cv2.threshold(blurred, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        
        # Find vertical structures (switch noise appears as vertical bands)
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (1, 10))
        vertical_structure = cv2.morphologyEx(thresh, cv2.MORPH_OPEN, kernel)
        
        # Find contours
        contours, _ = cv2.findContours(vertical_structure, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        
        if not contours:
            return start_time, end_time
        
        # Find the largest contour (most likely switch noise)
        largest_contour = max(contours, key=cv2.contourArea)
        x, y, w, h = cv2.boundingRect(largest_contour)
        
        # Convert back to time domain
        detected_start = time_frames[start_idx + x]
        detected_end = time_frames[start_idx + x + w]
        
        # Ensure reasonable bounds
        detected_start = max(4.5, min(detected_start, 6.0))
        detected_end = max(detected_start + 0.5, min(detected_end, 7.5))
        
        return detected_start, detected_end
        
    except Exception as e:
        print(f"Error in switch noise detection: {str(e)}")
        return start_time, end_time

def calculate_weighted_average_interval(intervals):
    """Calculate weighted average of detected intervals"""
    if not intervals:
        return 5.5, 6.5
    
    # Simple average for now (can be enhanced with confidence weighting)
    starts = [interval[0] for interval in intervals if interval[0] is not None]
    ends = [interval[1] for interval in intervals if interval[1] is not None]
    
    if not starts or not ends:
        return 5.5, 6.5
    
    avg_start = np.mean(starts)
    avg_end = np.mean(ends)
    
    return round(avg_start, 2), round(avg_end, 2)

def crop_and_split_audio(audio_path, start_time, end_time, output_dir, filename):
    """Crop audio to remove switch noise and split into two halves"""
    try:
        # Load audio
        if audio_path.endswith('.mp3'):
            audio = AudioSegment.from_mp3(audio_path)
        else:
            audio = AudioSegment.from_wav(audio_path)
        
        # Convert times to milliseconds
        start_ms = int(start_time * 1000)
        end_ms = int(end_time * 1000)
        
        # Create cropped version (remove switch noise)
        before_switch = audio[:start_ms]
        after_switch = audio[end_ms:]
        cropped_audio = before_switch + after_switch
        
        # Split into two equal halves
        mid_point = len(cropped_audio) // 2
        clockwise = cropped_audio[:mid_point]
        anticlockwise = cropped_audio[mid_point:]
        
        # Create output directories
        cw_dir = os.path.join(output_dir, 'Clockwise')
        acw_dir = os.path.join(output_dir, 'Anticlockwise')
        os.makedirs(cw_dir, exist_ok=True)
        os.makedirs(acw_dir, exist_ok=True)
        
        # Save files
        base_name = os.path.splitext(filename)[0]
        cw_path = os.path.join(cw_dir, f"{base_name}_cw.wav")
        acw_path = os.path.join(acw_dir, f"{base_name}_acw.wav")
        
        clockwise.export(cw_path, format="wav")
        anticlockwise.export(acw_path, format="wav")
        
        return True
        
    except Exception as e:
        print(f"Error processing {audio_path}: {str(e)}")
        return False

@app.route('/')
def index():
    """Main page"""
    return render_template('index.html')

@app.route('/upload', methods=['POST'])
def upload_files():
    """Handle file uploads and initial processing"""
    global batch_data, spectrogram_cache
    
    if 'files' not in request.files:
        return jsonify({'error': 'No files provided'}), 400
    
    files = request.files.getlist('files')
    if not files or all(file.filename == '' for file in files):
        return jsonify({'error': 'No files selected'}), 400
    
    # Clear previous data
    batch_data = {}
    spectrogram_cache = {}
    
    # Clean up old files
    for folder in [app.config['UPLOAD_FOLDER'], app.config['SPECTROGRAM_FOLDER']]:
        for file in os.listdir(folder):
            os.remove(os.path.join(folder, file))
    
    results = []
    intervals = []
    
    for file in files:
        if file and allowed_file(file.filename):
            filename = secure_filename(file.filename)
            timestamp = datetime.now().strftime('%Y%m%d_%H%M%S_')
            unique_filename = timestamp + filename
            
            # Save uploaded file
            file_path = os.path.join(app.config['UPLOAD_FOLDER'], unique_filename)
            file.save(file_path)
            
            # Generate spectrogram
            spec_image_path = os.path.join(app.config['SPECTROGRAM_FOLDER'], f"{unique_filename}.png")
            mel_spec_db, time_frames, sr = generate_mel_spectrogram(file_path, spec_image_path)
            
            if mel_spec_db is not None:
                # Detect switch noise
                start_time, end_time = detect_switch_noise(mel_spec_db, time_frames)
                
                # Store data
                file_data = {
                    'filename': filename,
                    'unique_filename': unique_filename,
                    'file_path': file_path,
                    'spec_image_path': spec_image_path,
                    'detected_interval': (start_time, end_time),
                    'duration': len(time_frames) * (time_frames[1] - time_frames[0]) if len(time_frames) > 1 else 12.0
                }
                
                batch_data[unique_filename] = file_data
                spectrogram_cache[unique_filename] = {
                    'mel_spec_db': mel_spec_db.tolist(),
                    'time_frames': time_frames.tolist(),
                    'sr': sr
                }
                
                intervals.append((start_time, end_time))
                results.append({
                    'filename': filename,
                    'unique_filename': unique_filename,
                    'detected_start': round(start_time, 2),
                    'detected_end': round(end_time, 2),
                    'duration': round(file_data['duration'], 2)
                })
    
    if not results:
        return jsonify({'error': 'No valid audio files processed'}), 400
    
    # Calculate weighted average
    avg_start, avg_end = calculate_weighted_average_interval(intervals)
    
    return jsonify({
        'success': True,
        'files': results,
        'weighted_average': {
            'start': avg_start,
            'end': avg_end
        },
        'total_files': len(results)
    })

@app.route('/get_spectrogram/<unique_filename>')
def get_spectrogram(unique_filename):
    """Get spectrogram data for visualization"""
    if unique_filename not in spectrogram_cache:
        return jsonify({'error': 'Spectrogram not found'}), 404
    
    spec_data = spectrogram_cache[unique_filename]
    file_info = batch_data.get(unique_filename, {})
    
    return jsonify({
        'mel_spec_db': spec_data['mel_spec_db'],
        'time_frames': spec_data['time_frames'],
        'sr': spec_data['sr'],
        'filename': file_info.get('filename', ''),
        'detected_interval': file_info.get('detected_interval', [5.5, 6.5])
    })

@app.route('/get_file_list')
def get_file_list():
    """Get list of uploaded files"""
    files = []
    for unique_filename, data in batch_data.items():
        files.append({
            'unique_filename': unique_filename,
            'filename': data['filename'],
            'detected_interval': data['detected_interval']
        })
    return jsonify(files)

@app.route('/process_batch', methods=['POST'])
def process_batch():
    """Process entire batch with confirmed interval"""
    global batch_data
    
    data = request.get_json()
    if not data or 'start_time' not in data or 'end_time' not in data:
        return jsonify({'error': 'Invalid parameters'}), 400
    
    start_time = float(data['start_time'])
    end_time = float(data['end_time'])
    
    # Create output directory
    timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
    output_dir = os.path.join(app.config['OUTPUT_FOLDER'], f'batch_{timestamp}')
    os.makedirs(output_dir, exist_ok=True)
    
    processed_files = []
    failed_files = []
    
    for unique_filename, file_data in batch_data.items():
        success = crop_and_split_audio(
            file_data['file_path'],
            start_time,
            end_time,
            output_dir,
            file_data['filename']
        )
        
        if success:
            processed_files.append(file_data['filename'])
        else:
            failed_files.append(file_data['filename'])
    
    # Create ZIP file
    zip_filename = f'processed_audio_{timestamp}.zip'
    zip_path = os.path.join(app.config['OUTPUT_FOLDER'], zip_filename)
    
    with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zipf:
        for root, dirs, files in os.walk(output_dir):
            for file in files:
                file_path = os.path.join(root, file)
                arcname = os.path.relpath(file_path, output_dir)
                zipf.write(file_path, arcname)
    
    # Clean up temporary directory
    shutil.rmtree(output_dir)
    
    return jsonify({
        'success': True,
        'zip_filename': zip_filename,
        'processed_files': len(processed_files),
        'failed_files': len(failed_files),
        'download_url': url_for('download_zip', filename=zip_filename)
    })

@app.route('/download/<filename>')
def download_zip(filename):
    """Download processed ZIP file"""
    zip_path = os.path.join(app.config['OUTPUT_FOLDER'], filename)
    if not os.path.exists(zip_path):
        return jsonify({'error': 'File not found'}), 404
    
    return send_file(zip_path, as_attachment=True, download_name=filename)

if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=5000)
