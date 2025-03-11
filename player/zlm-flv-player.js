/**
 * ZLMediaKit HTTP-FLV/MPEG-TS Player
 * A reusable component for playing FLV and MPEG-TS streams from ZLMediaKit
 * Requires mpegts.js (https://github.com/xqq/mpegts.js)
 */
class ZLMStreamPlayer {
    /**
     * Create a new HTTP-FLV/MPEG-TS player
     * @param {Object} options - Configuration options
     * @param {HTMLVideoElement} options.videoElement - The video element to play the stream in
     * @param {HTMLElement} [options.logContainer] - Optional container for logs
     * @param {HTMLElement} [options.statsContainer] - Optional container for statistics
     * @param {Object} [options.mpegtsOptions] - Custom mpegts.js options
     * @param {string} [options.streamType='flv'] - Stream type: 'flv', 'mse', 'mpegts', or 'm2ts'
     */
    constructor(options) {
        // Check if mpegts.js is available
        if (typeof mpegts === 'undefined') {
            throw new Error('mpegts.js is required. Please include it in your page.');
        }
        
        // Check mpegts.js feature compatibility
        if (!mpegts.getFeatureList().mseLivePlayback) {
            throw new Error('Your browser does not support MSE live playback required by mpegts.js');
        }
        
        // Enable logging if available
        try {
            mpegts.enableLogs(true);
        } catch (e) {
            console.warn('Unable to enable mpegts.js logging:', e);
        }
        
        // Required options
        if (!options.videoElement) {
            throw new Error('Video element is required');
        }
        
        // Store options
        this.videoElement = options.videoElement;
        this.logContainer = options.logContainer || null;
        this.statsContainer = options.statsContainer || null;
        this.mpegtsOptions = options.mpegtsOptions || {};
        this.streamType = options.streamType || 'flv';
        
        // Internal state
        this.player = null;
        this.statsInterval = null;
        this.latencyStartTime = 0;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 3;
        
        // Bind methods to this
        this.play = this.play.bind(this);
        this.stop = this.stop.bind(this);
        this._startStatsMonitoring = this._startStatsMonitoring.bind(this);
        
        // Set up event callbacks (can be overridden by users)
        this.onConnected = () => {};
        this.onDisconnected = () => {};
        this.onError = (error) => { console.error('ZLM Stream Player error:', error); };
        this.onStats = (stats) => {};
    }
    
    /**
     * Log a message
     * @param {string} message - The message to log
     * @param {string} [type='info'] - Log level (info, error, success)
     * @private
     */
    _log(message, type = 'info') {
        console.log(`ZLM Stream Player: ${message}`);
        
        if (this.logContainer) {
            const logEntry = document.createElement('div');
            logEntry.className = `log-entry log-${type}`;
            logEntry.textContent = `${new Date().toLocaleTimeString()} - ${message}`;
            this.logContainer.appendChild(logEntry);
            this.logContainer.scrollTop = this.logContainer.scrollHeight;
        }
    }
    
    /**
     * Start playing a stream
     * @param {string} url - The HTTP-FLV or MPEG-TS stream URL from ZLMediaKit
     * @param {string} [type] - Override the stream type (flv, mse, mpegts, m2ts)
     * @returns {Promise} - Resolves when connected, rejects on error
     */
    async play(url, type) {
        if (!url) {
            throw new Error('Stream URL is required');
        }
        
        // Allow overriding the stream type for this specific play action
        const streamType = type || this.streamType;
        
        this._log(`Starting ${streamType.toUpperCase()} stream...`);
        this.stop();
        
        try {
            // Record start time for latency calculation
            this.latencyStartTime = Date.now();
            
            // Create player with detailed configuration
            this.player = mpegts.createPlayer({
                type: streamType,
                url: url,
                isLive: true,
                cors: true,
                withCredentials: false,
                headers: {
                    'Origin': window.location.origin,
                    'Referer': window.location.href
                },
                ...this.mpegtsOptions
            }, {
                enableWorker: true,
                enableStashBuffer: false,
                stashInitialSize: 128,  // Reduce initial buffer size for lower latency
                autoCleanupSourceBuffer: true,
                lazyLoadMaxDuration: 3,
                seekType: 'range',
                reuseRedirectedURL: true,
                // MPEG-TS specific options
                accurateSeek: false,
                fixAudioTimestampGap: false,
                liveBufferLatencyChasing: true, // Enable latency chasing for live streams
                liveBufferLatencyMaxLatency: 2.0, // Target latency in seconds
                liveBufferLatencyMinRemain: 0.1, // Minimum buffer in seconds
                liveBufferLatencySmoothCoefficient: 0.8 // Smooth playback rate changes
            });
            
            this._log(`Created ${streamType.toUpperCase()} player for URL: ${url}`);
            
            // Attach media element
            this.player.attachMediaElement(this.videoElement);
            this._log('Attached media element');
            
            // Setup event listeners
            this._setupEventListeners();
            
            // Load and play
            this.player.load();
            this._log(`${streamType.toUpperCase()} stream loaded, attempting to play...`);
            
            // Set a timeout to detect if the stream gets stuck
            const playTimeout = setTimeout(() => {
                if (this.videoElement.readyState <= 1) {  // HAVE_NOTHING or HAVE_METADATA
                    this._log('Stream appears to be stuck, checking network', 'error');
                    // Let's manually check if the stream URL is accessible
                    fetch(url, { method: 'HEAD' })
                        .then(response => {
                            if (response.ok) {
                                this._log(`Stream URL is accessible (${response.status}), but playback is stuck`, 'info');
                            } else {
                                this._log(`Stream URL returned ${response.status}, stream may not exist`, 'error');
                            }
                        })
                        .catch(err => {
                            this._log(`Network error accessing stream: ${err.message}`, 'error');
                        });
                }
            }, 5000);
            
            await this.videoElement.play();
            clearTimeout(playTimeout);
            
            this._log(`${streamType.toUpperCase()} stream started`, 'success');
            this._startStatsMonitoring();
            this.onConnected();
            
            return true;
        } catch (error) {
            this._log(`Error: ${error.message}`, 'error');
            this.onError(error);
            this.stop();
            throw error;
        }
    }
    
    /**
     * Setup event listeners for the player
     * @private
     */
    _setupEventListeners() {
        if (!this.player) return;
        
        // Monitor all mpegts.js events for debugging
        const events = mpegts.Events;
        for (const eventName in events) {
            if (Object.prototype.hasOwnProperty.call(events, eventName)) {
                const event = events[eventName];
                this.player.on(event, (...args) => {
                    if (event === events.STATISTICS_INFO) return; // Too verbose
                    
                    if (args.length > 0) {
                        this._log(`Event: ${eventName} - ${JSON.stringify(args)}`, 
                            event === events.ERROR ? 'error' : 'info');
                    } else {
                        this._log(`Event: ${eventName}`, 'info');
                    }
                });
            }
        }
        
        // Handle error events
        this.player.on(mpegts.Events.ERROR, (errorType, errorDetail) => {
            this._log(`Player error: ${errorType} - ${errorDetail}`, 'error');
            
            // Additional details for network errors
            if (errorType === mpegts.ErrorTypes.NETWORK_ERROR) {
                if (errorDetail === mpegts.ErrorDetails.NETWORK_EXCEPTION) {
                    this._log('Network exception - Check if CORS is enabled on server', 'error');
                } else if (errorDetail === mpegts.ErrorDetails.NETWORK_STATUS_CODE_INVALID) {
                    this._log('Invalid HTTP status - Stream might not exist', 'error');
                }
            }
            
            this.onError(new Error(`${errorType}: ${errorDetail}`));
            
            // Attempt reconnection for network errors
            if (errorType === mpegts.ErrorTypes.NETWORK_ERROR && 
                this.reconnectAttempts < this.maxReconnectAttempts) {
                this.reconnectAttempts++;
                this._log(`Attempting reconnection ${this.reconnectAttempts}/${this.maxReconnectAttempts}...`, 'info');
                
                // Recreate the player
                const url = this.player._config.url;
                const type = this.player._config.type;
                setTimeout(() => {
                    this.stop();
                    this.play(url, type).catch(e => {
                        this._log(`Reconnection failed: ${e.message}`, 'error');
                    });
                }, 2000);
            }
        });
        
        // Listen for video events
        this.videoElement.addEventListener('canplay', () => {
            const setupTime = Date.now() - this.latencyStartTime;
            this._log(`Video can play (setup took ${setupTime}ms)`, 'success');
        });
        
        this.videoElement.addEventListener('playing', () => {
            this._log('Video is playing', 'success');
            this.reconnectAttempts = 0; // Reset on successful playback
        });
        
        this.videoElement.addEventListener('waiting', () => {
            this._log('Video buffering...', 'info');
        });
        
        this.videoElement.addEventListener('stalled', () => {
            this._log('Video download stalled', 'error');
        });
        
        this.videoElement.addEventListener('error', (e) => {
            const errorCode = this.videoElement.error ? this.videoElement.error.code : 'unknown';
            this._log(`Video element error: ${errorCode}`, 'error');
        });
    }
    
    /**
     * Stop playing the stream
     */
    stop() {
        if (this.statsInterval) {
            clearInterval(this.statsInterval);
            this.statsInterval = null;
        }
        
        if (this.player) {
            this.player.pause();
            this.player.unload();
            this.player.detachMediaElement();
            this.player.destroy();
            this.player = null;
            this._log('Player destroyed');
        }
        
        this.videoElement.src = '';
        
        if (this.statsContainer) {
            this.statsContainer.innerHTML = '';
        }
        
        this.onDisconnected();
    }
    
    /**
     * Start monitoring playback stats
     * @private
     */
    _startStatsMonitoring() {
        if (this.statsInterval) return;
        
        this.statsInterval = setInterval(() => {
            if (!this.player) return;
            
            const stats = this.player.statisticsInfo || {};
            const currentTime = this.videoElement.currentTime;
            
            // Calculate estimated latency
            // This is an approximation and may not be precisely accurate
            const timestamp = new Date();
            const videoTimestamp = new Date(timestamp - (currentTime * 1000));
            const estimatedLatency = Math.round((timestamp - videoTimestamp) / 1000);
            
            const statsData = {
                currentSpeed: stats.speed || 0,
                decodedFrames: stats.decodedFrames || 0,
                droppedFrames: stats.droppedFrames || 0,
                totalBytes: stats.totalBytes || 0,
                estimatedLatency: estimatedLatency
            };
            
            // Update stats container if available
            if (this.statsContainer) {
                this.statsContainer.innerHTML = `
                    Current Speed: ${Math.round((statsData.currentSpeed || 0) * 8 / 1024)} kbps<br>
                    Decoded Frames: ${statsData.decodedFrames || 0}<br>
                    Dropped Frames: ${statsData.droppedFrames || 0}<br>
                    Total Received: ${((statsData.totalBytes || 0) / 1024 / 1024).toFixed(2)} MB<br>
                    Est. Latency: ${statsData.estimatedLatency}s<br>
                    Buffer: ${this.videoElement.buffered.length ? this.videoElement.buffered.end(0) - this.videoElement.currentTime : 0}s<br>
                `;
            }
            
            // Call the stats callback
            this.onStats(statsData);
            
        }, 1000);
    }
}

// Export for module environments
if (typeof module !== 'undefined' && typeof module.exports !== 'undefined') {
    module.exports = ZLMStreamPlayer;
} else {
    window.ZLMStreamPlayer = ZLMStreamPlayer;
    // Keep the old name for backward compatibility
    window.ZLMFLVPlayer = ZLMStreamPlayer;
} 