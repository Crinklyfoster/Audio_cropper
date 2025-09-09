// Audio Batch Cropper - Main JavaScript

class AudioCropperApp {
    constructor() {
        this.uploadedFiles = [];
        this.currentFileIndex = 0;
        this.weightedAverage = { start: 5.5, end: 6.5 };
        this.currentPlot = null;
        this.dragState = { isDragging: false, dragType: null };
        
        this.initializeEventListeners();
    }

    initializeEventListeners() {
        // File upload
        const fileInput = document.getElementById('file-input');
        const uploadArea = document.getElementById('upload-area');
        const uploadBtn = document.getElementById('upload-btn');

        fileInput.addEventListener('change', (e) => this.handleFileSelect(e));
        uploadBtn.addEventListener('click', () => this.uploadFiles());

        // Drag and drop
        uploadArea.addEventListener('dragover', (e) => this.handleDragOver(e));
        uploadArea.addEventListener('drop', (e) => this.handleDrop(e));
        uploadArea.addEventListener('dragenter', (e) => this.handleDragEnter(e));
        uploadArea.addEventListener('dragleave', (e) => this.handleDragLeave(e));

        // Processing controls
        document.getElementById('proceed-btn').addEventListener('click', () => this.showSpectrogramViewer());
        document.getElementById('apply-batch').addEventListener('click', () => this.processBatch());

        // Navigation
        document.getElementById('prev-file').addEventListener('click', () => this.navigateFile(-1));
        document.getElementById('next-file').addEventListener('click', () => this.navigateFile(1));
        document.getElementById('file-selector').addEventListener('change', (e) => this.selectFile(e.target.value));

        // Interval inputs
        document.getElementById('start-input').addEventListener('input', (e) => this.updateInterval('start', parseFloat(e.target.value)));
        document.getElementById('end-input').addEventListener('input', (e) => this.updateInterval('end', parseFloat(e.target.value)));

        // Restart
        document.getElementById('restart-btn').addEventListener('click', () => this.restart());
    }

    handleFileSelect(e) {
        const files = Array.from(e.target.files);
        this.displaySelectedFiles(files);
    }

    handleDragOver(e) {
        e.preventDefault();
        e.stopPropagation();
    }

    handleDragEnter(e) {
        e.preventDefault();
        e.stopPropagation();
        document.getElementById('upload-area').classList.add('dragover');
    }

    handleDragLeave(e) {
        e.preventDefault();
        e.stopPropagation();
        if (!e.currentTarget.contains(e.relatedTarget)) {
            document.getElementById('upload-area').classList.remove('dragover');
        }
    }

    handleDrop(e) {
        e.preventDefault();
        e.stopPropagation();
        document.getElementById('upload-area').classList.remove('dragover');
        
        const files = Array.from(e.dataTransfer.files);
        document.getElementById('file-input').files = e.dataTransfer.files;
        this.displaySelectedFiles(files);
    }

    displaySelectedFiles(files) {
        if (files.length === 0) return;

        const uploadText = document.querySelector('.upload-text span');
        uploadText.textContent = `${files.length} file(s) selected`;
        
        document.getElementById('upload-btn').style.display = 'block';
        this.uploadedFiles = files;
    }

    async uploadFiles() {
        if (this.uploadedFiles.length === 0) return;

        this.showSection('results-section');
        this.showLoading('loading');

        const formData = new FormData();
        this.uploadedFiles.forEach(file => {
            formData.append('files', file);
        });

        try {
            const response = await fetch('/upload', {
                method: 'POST',
                body: formData
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const result = await response.json();
            
            if (result.success) {
                this.displayResults(result);
            } else {
                throw new Error(result.error || 'Upload failed');
            }
        } catch (error) {
            console.error('Upload error:', error);
            this.showError(`Upload failed: ${error.message}`);
        }
    }

    displayResults(result) {
        this.hideLoading('loading');
        document.getElementById('results-content').style.display = 'block';

        // Update weighted average display
        this.weightedAverage = result.weighted_average;
        document.getElementById('avg-interval').textContent = 
            `${result.weighted_average.start}s - ${result.weighted_average.end}s`;

        // Populate results table
        const tbody = document.querySelector('#results-table tbody');
        tbody.innerHTML = '';

        result.files.forEach(file => {
            const row = tbody.insertRow();
            const intervalLength = (file.detected_end - file.detected_start).toFixed(2);
            
            row.innerHTML = `
                <td>${file.filename}</td>
                <td>${file.duration}s</td>
                <td>${file.detected_start}s</td>
                <td>${file.detected_end}s</td>
                <td>${intervalLength}s</td>
            `;
        });

        // Store file data
        this.processedFiles = result.files;
    }

    async showSpectrogramViewer() {
        this.showSection('viewer-section');
        
        // Get file list
        try {
            const response = await fetch('/get_file_list');
            const files = await response.json();
            
            // Populate file selector
            const selector = document.getElementById('file-selector');
            selector.innerHTML = '<option value="">Select file...</option>';
            files.forEach((file, index) => {
                selector.innerHTML += `<option value="${file.unique_filename}">${file.filename}</option>`;
            });

            this.fileList = files;
            
            // Set initial interval inputs
            document.getElementById('start-input').value = this.weightedAverage.start;
            document.getElementById('end-input').value = this.weightedAverage.end;
            
            // Load first file
            if (files.length > 0) {
                this.currentFileIndex = 0;
                await this.loadSpectrogram(files[0].unique_filename);
                selector.value = files[0].unique_filename;
            }
        } catch (error) {
            console.error('Error loading file list:', error);
            this.showError('Failed to load file list');
        }
    }

    async loadSpectrogram(uniqueFilename) {
        this.showLoading('spec-loading');
        
        try {
            const response = await fetch(`/get_spectrogram/${uniqueFilename}`);
            
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            const data = await response.json();
            this.currentSpectrogramData = data;
            
            await this.renderSpectrogram(data);
            this.hideLoading('spec-loading');
            
        } catch (error) {
            console.error('Error loading spectrogram:', error);
            this.hideLoading('spec-loading');
            this.showError(`Failed to load spectrogram: ${error.message}`);
        }
    }

    async renderSpectrogram(data) {
        const plotDiv = document.getElementById('spectrogram-plot');
        
        // Prepare data for plotting
        const melSpecDb = data.mel_spec_db;
        const timeFrames = data.time_frames;
        
        const plotData = [{
            z: melSpecDb,
            x: timeFrames,
            y: Array.from({length: melSpecDb.length}, (_, i) => i * (8000 / melSpecDb.length)),
            type: 'heatmap',
            colorscale: 'Viridis',
            showscale: true,
            colorbar: {
                title: 'Power (dB)',
                titlefont: { color: 'white' },
                tickfont: { color: 'white' }
            }
        }];

        const startTime = parseFloat(document.getElementById('start-input').value);
        const endTime = parseFloat(document.getElementById('end-input').value);

        // Add vertical lines for interval
        const shapes = [
            {
                type: 'line',
                x0: startTime,
                y0: 0,
                x1: startTime,
                y1: 8000,
                line: {
                    color: '#ff6b6b',
                    width: 3,
                    dash: 'dash'
                }
            },
            {
                type: 'line',
                x0: endTime,
                y0: 0,
                x1: endTime,
                y1: 8000,
                line: {
                    color: '#ff6b6b',
                    width: 3,
                    dash: 'dash'
                }
            }
        ];

        const layout = {
            title: {
                text: `Mel Spectrogram: ${data.filename}`,
                font: { color: 'white', size: 16 }
            },
            xaxis: {
                title: 'Time (s)',
                color: 'white',
                gridcolor: '#444444',
                zerolinecolor: '#666666'
            },
            yaxis: {
                title: 'Frequency (Hz)',
                color: 'white',
                gridcolor: '#444444',
                zerolinecolor: '#666666'
            },
            plot_bgcolor: '#2d2d2d',
            paper_bgcolor: '#1a1a1a',
            font: { color: 'white' },
            shapes: shapes,
            margin: { t: 60, r: 60, b: 60, l: 60 }
        };

        const config = {
            displayModeBar: true,
            displaylogo: false,
            modeBarButtonsToRemove: ['select2d', 'lasso2d', 'autoScale2d'],
            responsive: true
        };

        await Plotly.newPlot(plotDiv, plotData, layout, config);
        this.currentPlot = plotDiv;

        // Add click event for updating interval
        plotDiv.on('plotly_click', (eventData) => {
            const clickedTime = eventData.points[0].x;
            const startInput = document.getElementById('start-input');
            const endInput = document.getElementById('end-input');
            const currentStart = parseFloat(startInput.value);
            const currentEnd = parseFloat(endInput.value);

            // Determine which line to move based on proximity
            const distToStart = Math.abs(clickedTime - currentStart);
            const distToEnd = Math.abs(clickedTime - currentEnd);

            if (distToStart < distToEnd) {
                startInput.value = clickedTime.toFixed(2);
                this.updateInterval('start', clickedTime);
            } else {
                endInput.value = clickedTime.toFixed(2);
                this.updateInterval('end', clickedTime);
            }
        });
    }

    updateInterval(type, value) {
        if (isNaN(value) || !this.currentPlot) return;

        const startTime = type === 'start' ? value : parseFloat(document.getElementById('start-input').value);
        const endTime = type === 'end' ? value : parseFloat(document.getElementById('end-input').value);

        // Validate interval
        if (startTime >= endTime) {
            if (type === 'start') {
                document.getElementById('start-input').value = (endTime - 0.5).toFixed(2);
                return;
            } else {
                document.getElementById('end-input').value = (startTime + 0.5).toFixed(2);
                return;
            }
        }

        // Update plot shapes
        const update = {
            'shapes[0].x0': startTime,
            'shapes[0].x1': startTime,
            'shapes[1].x0': endTime,
            'shapes[1].x1': endTime
        };

        Plotly.relayout(this.currentPlot, update);
    }

    navigateFile(direction) {
        if (!this.fileList || this.fileList.length === 0) return;

        this.currentFileIndex += direction;
        
        if (this.currentFileIndex < 0) {
            this.currentFileIndex = this.fileList.length - 1;
        } else if (this.currentFileIndex >= this.fileList.length) {
            this.currentFileIndex = 0;
        }

        const file = this.fileList[this.currentFileIndex];
        document.getElementById('file-selector').value = file.unique_filename;
        this.loadSpectrogram(file.unique_filename);
    }

    selectFile(uniqueFilename) {
        if (!uniqueFilename || !this.fileList) return;
        
        const index = this.fileList.findIndex(f => f.unique_filename === uniqueFilename);
        if (index !== -1) {
            this.currentFileIndex = index;
            this.loadSpectrogram(uniqueFilename);
        }
    }

    async processBatch() {
        const startTime = parseFloat(document.getElementById('start-input').value);
        const endTime = parseFloat(document.getElementById('end-input').value);

        if (isNaN(startTime) || isNaN(endTime) || startTime >= endTime) {
            this.showError('Invalid interval values');
            return;
        }

        this.showSection('processing-section');
        this.showLoading('batch-loading');

        try {
            const response = await fetch('/process_batch', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    start_time: startTime,
                    end_time: endTime
                })
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const result = await response.json();
            
            if (result.success) {
                this.hideLoading('batch-loading');
                document.getElementById('processing-results').style.display = 'block';
                document.getElementById('processed-count').textContent = result.processed_files;
                document.getElementById('download-link').href = result.download_url;
                document.getElementById('download-link').download = result.zip_filename;
            } else {
                throw new Error(result.error || 'Processing failed');
            }
        } catch (error) {
            console.error('Processing error:', error);
            this.hideLoading('batch-loading');
            this.showError(`Processing failed: ${error.message}`);
        }
    }

    showSection(sectionId) {
        // Hide all sections
        const sections = ['upload-section', 'results-section', 'viewer-section', 'processing-section', 'error-section'];
        sections.forEach(id => {
            const element = document.getElementById(id);
            if (element) element.style.display = 'none';
        });

        // Show requested section
        const targetSection = document.getElementById(sectionId);
        if (targetSection) {
            targetSection.style.display = 'block';
        }
    }

    showLoading(loadingId) {
        const loading = document.getElementById(loadingId);
        if (loading) loading.style.display = 'flex';
    }

    hideLoading(loadingId) {
        const loading = document.getElementById(loadingId);
        if (loading) loading.style.display = 'none';
    }

    showError(message) {
        document.getElementById('error-message').textContent = message;
        this.showSection('error-section');
    }

    restart() {
        // Reset all data
        this.uploadedFiles = [];
        this.currentFileIndex = 0;
        this.weightedAverage = { start: 5.5, end: 6.5 };
        this.currentPlot = null;
        this.fileList = [];
        this.processedFiles = [];

        // Reset UI
        document.getElementById('file-input').value = '';
        document.getElementById('upload-btn').style.display = 'none';
        document.querySelector('.upload-text span').textContent = 'Click to select files or drag & drop';
        
        // Clear tables
        document.querySelector('#results-table tbody').innerHTML = '';
        document.getElementById('file-selector').innerHTML = '<option value="">Select file...</option>';
        
        // Clear plot
        const plotDiv = document.getElementById('spectrogram-plot');
        if (plotDiv && this.currentPlot) {
            Plotly.purge(plotDiv);
        }

        // Show upload section
        this.showSection('upload-section');
    }
}

// Initialize app when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    new AudioCropperApp();
});
