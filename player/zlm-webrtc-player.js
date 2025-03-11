/**
 * ZLMediaKit WebRTC Player
 * A reusable component for playing WebRTC streams from ZLMediaKit
 */
class ZLMWebRTCPlayer {
    /**
     * Create a new WebRTC player
     * @param {Object} options - Configuration options
     * @param {HTMLVideoElement} options.videoElement - The video element to play the stream in
     * @param {HTMLElement} [options.logContainer] - Optional container for logs
     * @param {HTMLElement} [options.statsContainer] - Optional container for statistics
     * @param {Array} [options.iceServers] - Custom ICE servers configuration
     */
    constructor(options) {
        // Required options
        if (!options.videoElement) {
            throw new Error('Video element is required');
        }
        
        // Store options
        this.videoElement = options.videoElement;
        this.logContainer = options.logContainer || null;
        this.statsContainer = options.statsContainer || null;
        
        // Internal state
        this.peerConnection = null;
        this.statsInterval = null;
        this.stream = null;
        this.iceServers = options.iceServers || [{ urls: 'stun:stun.l.google.com:19302' }];
        
        // Bind methods to this
        this.play = this.play.bind(this);
        this.stop = this.stop.bind(this);
        this._connectToZLM = this._connectToZLM.bind(this);
        this._waitForIceGathering = this._waitForIceGathering.bind(this);
        this._startStatsMonitoring = this._startStatsMonitoring.bind(this);
        
        // Set up event callbacks (can be overridden by users)
        this.onConnected = () => {};
        this.onDisconnected = () => {};
        this.onError = (error) => { console.error('ZLM WebRTC Player error:', error); };
        this.onStats = (stats) => {};
    }
    
    /**
     * Log a message
     * @param {string} message - The message to log
     * @param {string} [type='info'] - Log level (info, error, success)
     * @private
     */
    _log(message, type = 'info') {
        console.log(`ZLM WebRTC Player: ${message}`);
        
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
     * @param {string} url - The WebRTC stream URL from ZLMediaKit
     * @returns {Promise} - Resolves when connected, rejects on error
     */
    async play(url) {
        if (!url) {
            throw new Error('Stream URL is required');
        }
        
        this._log('Starting stream...');
        this.stop();
        
        try {
            // Create peer connection
            this.peerConnection = new RTCPeerConnection({
                iceServers: this.iceServers
            });
            
            // Set up event listeners
            this.peerConnection.oniceconnectionstatechange = () => {
                this._log(`ICE Connection State: ${this.peerConnection.iceConnectionState}`);
                if (this.peerConnection.iceConnectionState === 'connected') {
                    this._startStatsMonitoring();
                    this.onConnected();
                } else if (['disconnected', 'failed', 'closed'].includes(this.peerConnection.iceConnectionState)) {
                    this.onDisconnected();
                }
            };
            
            this.peerConnection.onconnectionstatechange = () => {
                this._log(`Connection State: ${this.peerConnection.connectionState}`);
            };
            
            this.peerConnection.onicecandidate = event => {
                if (event.candidate) {
                    this._log(`New ICE candidate generated`);
                }
            };
            
            this.peerConnection.ontrack = event => {
                this._log('Received remote track', 'success');
                this.videoElement.srcObject = event.streams[0];
                this.stream = event.streams[0];
            };
            
            // Add transceivers for audio and video (both recvonly)
            this.peerConnection.addTransceiver('video', {direction: 'recvonly'});
            this.peerConnection.addTransceiver('audio', {direction: 'recvonly'});
            
            // Create offer with specific constraints
            const offer = await this.peerConnection.createOffer({
                offerToReceiveAudio: true,
                offerToReceiveVideo: true
            });
            
            // Set local description
            await this.peerConnection.setLocalDescription(offer);
            this._log('Local description set');
            
            // Connect to ZLMediaKit server
            await this._connectToZLM(url);
            
            return true;
            
        } catch (error) {
            this._log(`Error: ${error.message}`, 'error');
            this.onError(error);
            this.stop();
            throw error;
        }
    }
    
    /**
     * Stop playing the stream
     */
    stop() {
        if (this.statsInterval) {
            clearInterval(this.statsInterval);
            this.statsInterval = null;
        }
        
        if (this.peerConnection) {
            this.peerConnection.close();
            this.peerConnection = null;
            this._log('Connection closed');
        }
        
        if (this.videoElement.srcObject) {
            this.videoElement.srcObject.getTracks().forEach(track => {
                track.stop();
                this._log('Track stopped');
            });
            this.videoElement.srcObject = null;
        }
        
        this.stream = null;
        
        if (this.statsContainer) {
            this.statsContainer.innerHTML = '';
        }
    }
    
    /**
     * Connect to ZLMediaKit server
     * @param {string} url - The WebRTC stream URL
     * @private
     */
    async _connectToZLM(url) {
        try {
            this._log(`Connecting to ZLMediaKit server: ${url}`);
            
            // Wait for ICE gathering to complete
            await this._waitForIceGathering();
            
            // Get the complete SDP offer
            let offerSdp = this.peerConnection.localDescription.sdp;
            
            this._log(`Sending SDP offer (${offerSdp.length} bytes)`);
            
            // Send the raw SDP offer as text/plain (not JSON)
            // This matches ZLMediaKit's expected format
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'text/plain;charset=UTF-8',
                    'Origin': window.location.origin || 'https://webrtc-client.local',
                    'Accept': 'application/json, text/plain, */*',
                    'User-Agent': 'Mozilla/5.0 (compatible; WebRTCPlayer)'
                },
                body: offerSdp  // Send raw SDP without JSON wrapping
            });
            
            if (!response.ok) {
                throw new Error(`Server returned ${response.status}: ${response.statusText}`);
            }
            
            const result = await response.json();
            this._log(`Received answer from server`);
            
            if (result.code !== 0) {
                throw new Error(`ZLMediaKit error: ${result.msg || 'Unknown error'}`);
            }
            
            const answerSdp = result.sdp || result.answer || result.data?.sdp;
            if (!answerSdp) {
                throw new Error('No SDP answer found in response');
            }
            
            await this.peerConnection.setRemoteDescription({
                type: 'answer',
                sdp: answerSdp
            });
            
            this._log('Remote description set successfully', 'success');
        } catch (error) {
            this._log(`Error in ZLMediaKit connection: ${error.message}`, 'error');
            throw error;
        }
    }
    
    /**
     * Wait for ICE gathering to complete
     * @returns {Promise} - Resolves when ICE gathering is complete
     * @private
     */
    _waitForIceGathering() {
        return new Promise(resolve => {
            if (this.peerConnection.iceGatheringState === 'complete') {
                resolve();
                return;
            }
            
            const checkState = () => {
                if (this.peerConnection.iceGatheringState === 'complete') {
                    this.peerConnection.removeEventListener('icegatheringstatechange', checkState);
                    resolve();
                }
            };
            
            this.peerConnection.addEventListener('icegatheringstatechange', checkState);
            
            // Add a timeout in case gathering takes too long
            setTimeout(() => {
                if (this.peerConnection.iceGatheringState !== 'complete') {
                    this._log('ICE gathering timed out, continuing with available candidates', 'info');
                    this.peerConnection.removeEventListener('icegatheringstatechange', checkState);
                    resolve();
                }
            }, 5000);
        });
    }
    
    /**
     * Start monitoring WebRTC stats
     * @private
     */
    async _startStatsMonitoring() {
        if (this.statsInterval) return;
        
        this.statsInterval = setInterval(async () => {
            if (!this.peerConnection) return;
            
            const stats = await this.peerConnection.getStats();
            let statsData = {};
            
            stats.forEach(report => {
                if (report.type === 'inbound-rtp' && report.kind === 'video') {
                    statsData = {
                        packetsReceived: report.packetsReceived,
                        packetsLost: report.packetsLost,
                        bytesReceived: report.bytesReceived,
                        framesDecoded: report.framesDecoded,
                        frameRate: report.framesPerSecond || 0,
                        jitter: report.jitter,
                        timestamp: report.timestamp
                    };
                    
                    // Update stats container if available
                    if (this.statsContainer) {
                        this.statsContainer.innerHTML = `
                            Packets Received: ${report.packetsReceived}<br>
                            Bytes Received: ${(report.bytesReceived / 1024 / 1024).toFixed(2)} MB<br>
                            Frame Rate: ${report.framesPerSecond || 0} fps<br>
                            Frames Decoded: ${report.framesDecoded}<br>
                        `;
                    }
                    
                    // Call the stats callback
                    this.onStats(statsData);
                }
            });
            
        }, 1000);
    }
}

// Export for module environments
if (typeof module !== 'undefined' && typeof module.exports !== 'undefined') {
    module.exports = ZLMWebRTCPlayer;
} else {
    window.ZLMWebRTCPlayer = ZLMWebRTCPlayer;
} 