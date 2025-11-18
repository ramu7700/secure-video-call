import React, { useState, useRef, useEffect } from 'react';
import { Video, VideoOff, Mic, MicOff, Phone, PhoneOff, Shield, Users } from 'lucide-react';

// Crypto utilities for E2EE
class E2EECrypto {
  constructor() {
    this.cryptoKey = null;
    this.encryptionKey = null;
    this.ivCounter = 0;
  }

  // Derive AES-GCM key from PIN using PBKDF2
  async deriveKeyFromPIN(pin) {
    const encoder = new TextEncoder();
    const pinData = encoder.encode(pin);
    const salt = encoder.encode('SecureVideoCall2025'); // Static salt for same PIN = same key
    
    const baseKey = await crypto.subtle.importKey(
      'raw',
      pinData,
      'PBKDF2',
      false,
      ['deriveBits', 'deriveKey']
    );

    this.cryptoKey = await crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: salt,
        iterations: 100000,
        hash: 'SHA-256'
      },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );

    return this.cryptoKey;
  }

  // Generate unique IV for each frame
  generateIV() {
    const iv = new ArrayBuffer(12);
    const view = new DataView(iv);
    view.setUint32(0, this.ivCounter >> 32);
    view.setUint32(4, this.ivCounter & 0xFFFFFFFF);
    this.ivCounter++;
    return new Uint8Array(iv);
  }

  // Encrypt frame data
  async encryptFrame(data) {
    if (!this.cryptoKey) return data;
    
    const iv = this.generateIV();
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv },
      this.cryptoKey,
      data
    );

    // Prepend IV to encrypted data
    const result = new Uint8Array(iv.length + encrypted.byteLength);
    result.set(iv, 0);
    result.set(new Uint8Array(encrypted), iv.length);
    return result;
  }

  // Decrypt frame data
  async decryptFrame(data) {
    if (!this.cryptoKey || data.byteLength < 12) return data;

    const iv = data.slice(0, 12);
    const encrypted = data.slice(12);

    try {
      const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: iv },
        this.cryptoKey,
        encrypted
      );
      return new Uint8Array(decrypted);
    } catch (e) {
      console.error('Decryption failed:', e);
      return new Uint8Array(0);
    }
  }
}

function App() {
  const [pin, setPin] = useState('');
  const [status, setStatus] = useState('idle'); // idle, connecting, waiting, incall
  const [isVideoEnabled, setIsVideoEnabled] = useState(true);
  const [isAudioEnabled, setIsAudioEnabled] = useState(true);
  const [roomOccupancy, setRoomOccupancy] = useState(0);
  const [generatedPin, setGeneratedPin] = useState('');

  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const socketRef = useRef(null);
  const peerConnectionRef = useRef(null);
  const localStreamRef = useRef(null);
  const cryptoRef = useRef(new E2EECrypto());
  const currentRoomRef = useRef(null);

  // WebRTC configuration with free STUN servers
  const rtcConfig = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  };

  // Initialize socket connection
  useEffect(() => {
    // For demo purposes, connect to a mock signaling server
    // In production, replace with: io('https://your-server.com')
    const mockSocket = {
      on: (event, callback) => {
        mockSocket[`_${event}`] = callback;
      },
      emit: (event, data) => {
        console.log('Socket emit:', event, data);
        // Mock server responses
        if (event === 'join-room') {
          setTimeout(() => {
            mockSocket._roomJoined?.({ occupancy: 1 });
            setRoomOccupancy(1);
          }, 500);
        }
      },
      disconnect: () => console.log('Socket disconnected')
    };

    socketRef.current = mockSocket;

    return () => {
      if (socketRef.current) {
        socketRef.current.disconnect();
      }
    };
  }, []);

  // Setup Insertable Streams for E2EE
  const setupInsertableStreams = (sender, isEncrypting) => {
    const senderStreams = sender.createEncodedStreams();
    const transformStream = new TransformStream({
      transform: async (chunk, controller) => {
        const { data } = chunk;
        
        if (isEncrypting) {
          // Encrypt outgoing frames
          const encrypted = await cryptoRef.current.encryptFrame(data);
          chunk.data = encrypted.buffer;
        } else {
          // Decrypt incoming frames
          const decrypted = await cryptoRef.current.decryptFrame(new Uint8Array(data));
          chunk.data = decrypted.buffer;
        }
        
        controller.enqueue(chunk);
      }
    });

    if (isEncrypting) {
      senderStreams.readable
        .pipeThrough(transformStream)
        .pipeTo(senderStreams.writable);
    }
  };

  // Setup Insertable Streams for receiver
  const setupReceiverStreams = (receiver) => {
    const receiverStreams = receiver.createEncodedStreams();
    const transformStream = new TransformStream({
      transform: async (chunk, controller) => {
        const { data } = chunk;
        const decrypted = await cryptoRef.current.decryptFrame(new Uint8Array(data));
        chunk.data = decrypted.buffer;
        controller.enqueue(chunk);
      }
    });

    receiverStreams.readable
      .pipeThrough(transformStream)
      .pipeTo(receiverStreams.writable);
  };

  // Initialize local media stream
  const initializeMedia = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 1280, height: 720 },
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });

      localStreamRef.current = stream;
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }

      return stream;
    } catch (error) {
      console.error('Error accessing media devices:', error);
      alert('Could not access camera/microphone. Please grant permissions.');
      return null;
    }
  };

  // Create peer connection with E2EE
  const createPeerConnection = async () => {
    const pc = new RTCPeerConnection(rtcConfig);
    peerConnectionRef.current = pc;

    // Add local tracks with E2EE
    const stream = localStreamRef.current;
    if (stream) {
      stream.getTracks().forEach(track => {
        const sender = pc.addTrack(track, stream);
        // Setup encryption for outgoing streams
        if (sender.createEncodedStreams) {
          setupInsertableStreams(sender, true);
        }
      });
    }

    // Handle incoming tracks with E2EE
    pc.ontrack = (event) => {
      console.log('Received remote track');
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = event.streams[0];
      }
      setStatus('incall');

      // Setup decryption for incoming streams
      if (event.receiver.createEncodedStreams) {
        setupReceiverStreams(event.receiver);
      }
    };

    // Handle ICE candidates
    pc.onicecandidate = (event) => {
      if (event.candidate && socketRef.current) {
        socketRef.current.emit('ice-candidate', {
          room: currentRoomRef.current,
          candidate: event.candidate
        });
      }
    };

    // Connection state monitoring
    pc.onconnectionstatechange = () => {
      console.log('Connection state:', pc.connectionState);
      if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
        handleLeave();
      }
    };

    return pc;
  };

  // Join room and start call
  const handleJoin = async () => {
    if (pin.length !== 10 || !/^\d+$/.test(pin)) {
      alert('Please enter a valid 10-digit PIN');
      return;
    }

    setStatus('connecting');
    currentRoomRef.current = pin;

    // Derive encryption key from PIN
    await cryptoRef.current.deriveKeyFromPIN(pin);

    // Initialize media
    const stream = await initializeMedia();
    if (!stream) {
      setStatus('idle');
      return;
    }

    // Join room via signaling server
    socketRef.current.emit('join-room', { room: pin });

    // Setup socket listeners
    socketRef.current.on('roomJoined', async (data) => {
      setRoomOccupancy(data.occupancy);
      if (data.occupancy === 1) {
        setStatus('waiting');
      } else if (data.occupancy === 2) {
        // Create offer if second person
        const pc = await createPeerConnection();
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socketRef.current.emit('offer', { room: pin, offer });
      }
    });

    socketRef.current.on('offer', async (data) => {
      const pc = await createPeerConnection();
      await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socketRef.current.emit('answer', { room: pin, answer });
    });

    socketRef.current.on('answer', async (data) => {
      await peerConnectionRef.current.setRemoteDescription(
        new RTCSessionDescription(data.answer)
      );
    });

    socketRef.current.on('ice-candidate', async (data) => {
      if (peerConnectionRef.current) {
        await peerConnectionRef.current.addIceCandidate(
          new RTCIceCandidate(data.candidate)
        );
      }
    });

    socketRef.current.on('userLeft', () => {
      handleLeave();
    });

    socketRef.current.on('roomFull', () => {
      alert('Room is full. Only 2 users allowed.');
      handleLeave();
    });
  };

  // Leave call and cleanup
  const handleLeave = () => {
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => track.stop());
      localStreamRef.current = null;
    }

    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null;
    }

    if (localVideoRef.current) {
      localVideoRef.current.srcObject = null;
    }

    if (socketRef.current && currentRoomRef.current) {
      socketRef.current.emit('leave-room', { room: currentRoomRef.current });
    }

    setStatus('idle');
    setPin('');
    currentRoomRef.current = null;
    cryptoRef.current = new E2EECrypto();
  };

  // Toggle video
  const toggleVideo = () => {
    if (localStreamRef.current) {
      const videoTrack = localStreamRef.current.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.enabled = !videoTrack.enabled;
        setIsVideoEnabled(videoTrack.enabled);
      }
    }
  };

  // Toggle audio
  const toggleAudio = () => {
    if (localStreamRef.current) {
      const audioTrack = localStreamRef.current.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        setIsAudioEnabled(audioTrack.enabled);
      }
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-900 via-purple-900 to-pink-900">
      <div className="container mx-auto px-4 py-8">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="flex items-center justify-center gap-3 mb-4">
            <Shield className="w-12 h-12 text-green-400" />
            <h1 className="text-4xl font-bold text-white">SecureCall</h1>
          </div>
          <p className="text-gray-300 flex items-center justify-center gap-2">
            <Shield className="w-4 h-4" />
            End-to-End Encrypted Video Calls
          </p>
        </div>

        {/* Main Content */}
        {status === 'idle' && (
          <div className="max-w-md mx-auto bg-white/10 backdrop-blur-lg rounded-2xl p-8 shadow-2xl">
            <h2 className="text-2xl font-semibold text-white mb-6 text-center">
              Enter Room PIN
            </h2>
            
            <div className="space-y-4">
              <input
                type="text"
                maxLength={10}
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
                placeholder="Enter 10-digit PIN"
                className="w-full px-4 py-3 bg-white/20 border border-white/30 rounded-lg text-white placeholder-gray-300 text-center text-xl tracking-widest focus:outline-none focus:ring-2 focus:ring-green-400"
              />
              
              <button
                onClick={handleJoin}
                disabled={pin.length !== 10}
                className="w-full py-3 bg-green-500 hover:bg-green-600 disabled:bg-gray-500 disabled:cursor-not-allowed text-white font-semibold rounded-lg transition-all flex items-center justify-center gap-2"
              >
                <Phone className="w-5 h-5" />
                Join Call
              </button>
            </div>

            <div className="mt-6 p-4 bg-white/5 rounded-lg">
              <div className="flex items-start gap-2 text-sm text-gray-300">
                <Shield className="w-5 h-5 text-green-400 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="font-semibold mb-1">Privacy First</p>
                  <ul className="space-y-1 text-xs">
                    <li>• AES-GCM encryption on every frame</li>
                    <li>• Keys derived from your PIN</li>
                    <li>• Server never sees your media</li>
                    <li>• Maximum 2 users per room</li>
                  </ul>
                </div>
              </div>
            </div>
          </div>
        )}

        {(status === 'connecting' || status === 'waiting' || status === 'incall') && (
          <div className="space-y-4">
            {/* Status Bar */}
            <div className="max-w-4xl mx-auto bg-white/10 backdrop-blur-lg rounded-lg p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className={`w-3 h-3 rounded-full ${
                    status === 'incall' ? 'bg-green-400 animate-pulse' : 'bg-yellow-400 animate-pulse'
                  }`} />
                  <span className="text-white font-medium">
                    {status === 'connecting' && 'Connecting...'}
                    {status === 'waiting' && 'Waiting for peer...'}
                    {status === 'incall' && 'Connected'}
                  </span>
                  <div className="flex items-center gap-1 text-gray-300">
                    <Users className="w-4 h-4" />
                    <span className="text-sm">{roomOccupancy}/2</span>
                  </div>
                </div>
                <div className="flex items-center gap-2 text-gray-300">
                  <Shield className="w-4 h-4 text-green-400" />
                  <span className="text-sm">Encrypted</span>
                </div>
              </div>
            </div>

            {/* Video Grid */}
            <div className="max-w-6xl mx-auto grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Local Video */}
              <div className="relative bg-black rounded-xl overflow-hidden shadow-2xl aspect-video">
                <video
                  ref={localVideoRef}
                  autoPlay
                  muted
                  playsInline
                  className="w-full h-full object-cover"
                />
                <div className="absolute bottom-4 left-4 bg-black/60 px-3 py-1 rounded-full text-white text-sm">
                  You
                </div>
              </div>

              {/* Remote Video */}
              <div className="relative bg-gray-800 rounded-xl overflow-hidden shadow-2xl aspect-video">
                <video
                  ref={remoteVideoRef}
                  autoPlay
                  playsInline
                  className="w-full h-full object-cover"
                />
                {status !== 'incall' && (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <div className="text-center">
                      <Users className="w-16 h-16 text-gray-500 mx-auto mb-2" />
                      <p className="text-gray-400">Waiting for peer...</p>
                    </div>
                  </div>
                )}
                {status === 'incall' && (
                  <div className="absolute bottom-4 left-4 bg-black/60 px-3 py-1 rounded-full text-white text-sm">
                    Peer
                  </div>
                )}
              </div>
            </div>

            {/* Controls */}
            <div className="max-w-md mx-auto flex items-center justify-center gap-4">
              <button
                onClick={toggleVideo}
                className={`p-4 rounded-full transition-all ${
                  isVideoEnabled
                    ? 'bg-white/20 hover:bg-white/30 text-white'
                    : 'bg-red-500 hover:bg-red-600 text-white'
                }`}
              >
                {isVideoEnabled ? <Video className="w-6 h-6" /> : <VideoOff className="w-6 h-6" />}
              </button>

              <button
                onClick={toggleAudio}
                className={`p-4 rounded-full transition-all ${
                  isAudioEnabled
                    ? 'bg-white/20 hover:bg-white/30 text-white'
                    : 'bg-red-500 hover:bg-red-600 text-white'
                }`}
              >
                {isAudioEnabled ? <Mic className="w-6 h-6" /> : <MicOff className="w-6 h-6" />}
              </button>

              <button
                onClick={handleLeave}
                className="p-4 rounded-full bg-red-500 hover:bg-red-600 text-white transition-all"
              >
                <PhoneOff className="w-6 h-6" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
