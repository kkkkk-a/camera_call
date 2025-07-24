'use strict';

// HTML要素の取得
const entryContainer = document.getElementById('entry-container');
const callContainer = document.getElementById('call-container');
const joinButton = document.getElementById('join-button');
const roomInput = document.getElementById('room-input');
const hangupButton = document.getElementById('hangup-button');
const roomNameDisplay = document.getElementById('room-name-display');
const mainVideoContainer = document.getElementById('main-video-container');
const thumbnailGrid = document.getElementById('thumbnail-grid');
const micButton = document.getElementById('mic-button');
const videoButton = document.getElementById('video-button');
const shareScreenButton = document.getElementById('share-screen-button');

const socket = io();
let localStream;
let currentRoom = null;
const peerConnections = {};

let recognition = null; // 音声認識オブジェクトをグローバルに
let recognitionActive = false; // 音声認識を続けるかのフラグ

const configuration = {
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
};

// --- 1. 入室処理 ---
joinButton.addEventListener('click', () => {
    const roomName = roomInput.value;
    if (roomName) {
        joinRoom(roomName);
    } else {
        alert('合言葉を入力してください。');
    }
});

async function joinRoom(roomName) {
    currentRoom = roomName;
    entryContainer.style.display = 'none';
    callContainer.style.display = 'block';
    roomNameDisplay.textContent = `ルーム: ${currentRoom}`;

    try {
        const constraints = {
            video: true,
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            }
        };
        localStream = await navigator.mediaDevices.getUserMedia(constraints);
        
        addVideoStream('local', '自分', localStream);
        setMainVideo(document.getElementById('wrapper-local'));
        
        startSpeechRecognition();

        socket.emit('join room', roomName);
    } catch (e) {
        console.error('メディアの取得に失敗:', e);
        alert('カメラまたはマイクへのアクセスを許可してください。');
        location.reload();
    }
}

// --- 2. Socket.IOイベントのハンドリング ---
socket.on('room joined', (data) => {
    console.log(`ルーム '${data.roomId}' に参加しました。`);
    data.otherUsers.forEach(userId => {
        if (!peerConnections[userId]) createPeerConnection(userId, true);
    });
});

socket.on('user joined', (userId) => {
    console.log(`新しいユーザーが参加しました: ${userId}`);
    if (!peerConnections[userId]) createPeerConnection(userId, false);
});

socket.on('user left', (userId) => {
    console.log(`ユーザーが退出しました: ${userId}`);
    if (peerConnections[userId]) {
        peerConnections[userId].pc.close();
        delete peerConnections[userId];
    }
    const remoteVideoWrapper = document.getElementById(`wrapper-${userId}`);
    if (remoteVideoWrapper) remoteVideoWrapper.remove();
});

socket.on('room full', (roomName) => {
    alert(`ルーム '${roomName}' は満室です。`);
    location.reload();
});

// ★★★ 接続ロジックを厳密化 ★★★
socket.on('message', async (message, fromId) => {
    const peer = peerConnections[fromId];
    // 接続オブジェクトが存在しないピアからのメッセージは無視する
    if (!peer) {
        console.warn(`不明なピアからのメッセージを無視しました: ${fromId}`);
        return;
    }

    try {
        if (message.type === 'offer') {
            await peer.pc.setRemoteDescription(new RTCSessionDescription(message));
            const answer = await peer.pc.createAnswer();
            await peer.pc.setLocalDescription(answer);
            socket.emit('message', answer, fromId);
            await processIceCandidateQueue(peer);
        } else if (message.type === 'answer') {
            await peer.pc.setRemoteDescription(new RTCSessionDescription(message));
            await processIceCandidateQueue(peer);
        } else if (message.type === 'candidate' && message.candidate) {
            if (peer.pc.remoteDescription) {
                await peer.pc.addIceCandidate(new RTCIceCandidate(message.candidate));
            } else {
                peer.iceCandidateQueue.push(message.candidate);
            }
        }
    } catch (e) {
        console.error(`メッセージ処理中にエラー (from: ${fromId}):`, e);
    }
});

socket.on('subtitle', (subtitle, fromId) => {
    showSubtitle(`wrapper-${fromId}`, subtitle);
});

// --- 3. WebRTCの処理 ---
function createPeerConnection(partnerId, isInitiator) {
    console.log(`PeerConnectionを作成します for ${partnerId} (Initiator: ${isInitiator})`);
    const pc = new RTCPeerConnection(configuration);
    peerConnections[partnerId] = { pc: pc, iceCandidateQueue: [] };
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

    if (isInitiator) {
        pc.createOffer()
            .then(offer => pc.setLocalDescription(offer))
            .then(() => socket.emit('message', pc.localDescription, partnerId))
            .catch(e => console.error(`Offer作成失敗 for ${partnerId}:`, e));
    }
    pc.onicecandidate = (event) => {
        if (event.candidate) socket.emit('message', { type: 'candidate', candidate: event.candidate }, partnerId);
    };
    pc.ontrack = (event) => {
        addVideoStream(partnerId, `User: ${partnerId.substring(0, 4)}`, event.streams[0]);
    };
    return pc;
}

async function processIceCandidateQueue(peer) {
    while (peer.iceCandidateQueue.length > 0) {
        const candidate = peer.iceCandidateQueue.shift();
        await peer.pc.addIceCandidate(new RTCIceCandidate(candidate));
    }
}

// --- 4. DOM操作（ビデオと字幕） ---
function addVideoStream(id, name, stream) {
    if (document.getElementById(`wrapper-${id}`)) return;
    const wrapper = document.createElement('div');
    wrapper.className = 'video-wrapper';
    wrapper.id = `wrapper-${id}`;
    const video = document.createElement('video');
    video.id = `video-${id}`;
    video.srcObject = stream;
    video.autoplay = true;
    video.playsInline = true;
    if (id === 'local') video.muted = true;
    const nameTag = document.createElement('h3');
    nameTag.textContent = name;
    const subtitle = document.createElement('p');
    subtitle.className = 'subtitle';
    subtitle.id = `subtitle-${id}`;
    wrapper.appendChild(video);
    wrapper.appendChild(nameTag);
    wrapper.appendChild(subtitle);
    thumbnailGrid.appendChild(wrapper);
    wrapper.addEventListener('click', () => setMainVideo(wrapper));
}

function setMainVideo(targetWrapper) {
    const currentMain = mainVideoContainer.querySelector('.video-wrapper');
    if (currentMain) thumbnailGrid.appendChild(currentMain);
    mainVideoContainer.appendChild(targetWrapper);
}

let subtitleTimers = {};
function showSubtitle(wrapperId, text) {
    const subtitleElement = document.querySelector(`#${wrapperId} .subtitle`);
    if (subtitleElement) {
        subtitleElement.textContent = text;
        subtitleElement.classList.add('visible');
        if (subtitleTimers[wrapperId]) clearTimeout(subtitleTimers[wrapperId]);
        subtitleTimers[wrapperId] = setTimeout(() => {
            subtitleElement.classList.remove('visible');
        }, 3000);
    }
}

// --- 5. 字幕機能 (Web Speech API) ---
// ★★★ 音声認識ロジックを安定化 ★★★
function startSpeechRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
        console.warn('このブラウザはWeb Speech APIをサポートしていません。');
        return;
    }

    recognition = new SpeechRecognition();
    recognition.lang = 'ja-JP';
    recognition.interimResults = true;
    recognition.continuous = true;
    recognitionActive = true;

    recognition.onresult = (event) => {
        let transcript = '';
        for (let i = event.resultIndex; i < event.results.length; ++i) {
            transcript += event.results[i][0].transcript;
        }
        if (transcript) {
            showSubtitle('wrapper-local', transcript);
            socket.emit('subtitle', transcript);
        }
    };
    
    recognition.onend = () => {
        if (recognitionActive) {
            console.log('音声認識が終了したため、再開します。');
            recognition.start();
        } else {
            console.log('音声認識を意図的に停止しました。');
        }
    };

    recognition.onerror = (event) => {
        console.error('音声認識エラー:', event.error);
        if (event.error === 'no-speech' || event.error === 'aborted') {
            // これらはエラーではない場合が多いため、onendで自動再開させる
        } else if (event.error === 'not-allowed') {
            // マイクが許可されなかった場合は、認識を完全に停止
            recognitionActive = false;
        }
    };

    recognition.start();
    console.log('音声認識を開始しました。');
}

function stopSpeechRecognition() {
    if (recognition) {
        recognitionActive = false;
        recognition.stop();
    }
}

// --- 6. 退出処理 ---
hangupButton.addEventListener('click', () => {
    stopSpeechRecognition();
    location.reload();
});
window.addEventListener('beforeunload', () => {
    stopSpeechRecognition();
    socket.disconnect();
});

// --- 7. メディアコントロール機能 ---
let isMicOn = true;
let isVideoOn = true;

micButton.addEventListener('click', () => {
    if (localStream) {
        isMicOn = !isMicOn;
        localStream.getAudioTracks().forEach(track => track.enabled = isMicOn);
        micButton.textContent = isMicOn ? 'マイクOFF' : 'マイクON';
        micButton.classList.toggle('muted', !isMicOn);
    }
});

videoButton.addEventListener('click', () => {
    if (localStream) {
        isVideoOn = !isVideoOn;
        localStream.getVideoTracks().forEach(track => track.enabled = isVideoOn);
        videoButton.textContent = isVideoOn ? 'ビデオOFF' : 'ビデオON';
        videoButton.classList.toggle('off', !isVideoOn);
    }
});

// --- 8. 画面共有機能 ---
let isScreenSharing = false;
let screenStream = null;
let cameraTrack = null;

async function startScreenShare() {
    if (isScreenSharing) return;
    try {
        screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
        if (localStream && localStream.getVideoTracks().length > 0) {
            cameraTrack = localStream.getVideoTracks()[0];
        }
        const screenTrack = screenStream.getVideoTracks()[0];
        for (const peerId in peerConnections) {
            const sender = peerConnections[peerId].pc.getSenders().find(s => s.track && s.track.kind === 'video');
            if (sender) await sender.replaceTrack(screenTrack);
        }
        const localVideo = document.getElementById('video-local');
        localVideo.srcObject = screenStream;
        isScreenSharing = true;
        shareScreenButton.textContent = '共有停止';
        shareScreenButton.classList.add('sharing');
        screenTrack.onended = () => stopScreenShare();
    } catch (e) {
        console.error('画面共有の開始に失敗しました:', e);
    }
}

async function stopScreenShare() {
    if (!isScreenSharing || !cameraTrack) return;
    for (const peerId in peerConnections) {
        const sender = peerConnections[peerId].pc.getSenders().find(s => s.track && s.track.kind === 'video');
        if (sender) await sender.replaceTrack(cameraTrack);
    }
    screenStream.getTracks().forEach(track => track.stop());
    const localVideo = document.getElementById('video-local');
    localVideo.srcObject = localStream;
    isScreenSharing = false;
    screenStream = null;
    shareScreenButton.textContent = '画面共有';
    shareScreenButton.classList.remove('sharing');
}

shareScreenButton.addEventListener('click', () => {
    if (isScreenSharing) {
        stopScreenShare();
    } else {
        startScreenShare();
    }
});
