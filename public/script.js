'use strict';

// HTML要素の取得
const entryContainer = document.getElementById('entry-container');
const callContainer = document.getElementById('call-container');
const joinButton = document.getElementById('join-button');
const roomInput = document.getElementById('room-input');
const hangupButton = document.getElementById('hangup-button');
const roomNameDisplay = document.getElementById('room-name-display');
const mainVideoContainer = document.getElementById('main-video-container'); // ★追加
const thumbnailGrid = document.getElementById('thumbnail-grid'); // ★変更

const socket = io();
let localStream;
let currentRoom = null;
const peerConnections = {};

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
        
        // 自分のビデオをサムネイルに追加
        addVideoStream('local', '自分', localStream);
        setMainVideo(document.getElementById('wrapper-local')); // 最初は自分をメインに
        
        // ★字幕機能を開始
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
    data.otherUsers.forEach(userId => {
        if (!peerConnections[userId]) createPeerConnection(userId, true);
    });
});

socket.on('user joined', (userId) => {
    if (!peerConnections[userId]) createPeerConnection(userId, false);
});

socket.on('user left', (userId) => {
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

socket.on('message', async (message, fromId) => {
    const peer = peerConnections[fromId];
    if (!peer) return;
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
            if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(new RTCIceCandidate(message.candidate));
            else peer.iceCandidateQueue.push(message.candidate);
        }
    } catch (e) {
        console.error(`メッセージ処理中にエラー (from: ${fromId}):`, e);
    }
});

// ★★★ 字幕イベントの受信 ★★★
socket.on('subtitle', (subtitle, fromId) => {
    showSubtitle(`wrapper-${fromId}`, subtitle);
});

// --- 3. WebRTCの処理 ---
function createPeerConnection(partnerId, isInitiator) {
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

    // ★クリックでメイン画面に表示するイベントを追加
    wrapper.addEventListener('click', () => setMainVideo(wrapper));
}

// ★★★ 拡大表示のための関数 ★★★
function setMainVideo(targetWrapper) {
    const currentMain = mainVideoContainer.querySelector('.video-wrapper');
    if (currentMain) {
        // 現在メインのビデオをサムネイルに戻す
        thumbnailGrid.appendChild(currentMain);
    }
    // クリックされたビデオをメインに設定
    mainVideoContainer.appendChild(targetWrapper);
}

// ★★★ 字幕表示のための関数 ★★★
let subtitleTimers = {};
function showSubtitle(wrapperId, text) {
    const subtitleElement = document.querySelector(`#${wrapperId} .subtitle`);
    if (subtitleElement) {
        subtitleElement.textContent = text;
        subtitleElement.classList.add('visible');

        // 古いタイマーがあればクリア
        if (subtitleTimers[wrapperId]) {
            clearTimeout(subtitleTimers[wrapperId]);
        }
        // 3秒後に字幕を消すタイマーをセット
        subtitleTimers[wrapperId] = setTimeout(() => {
            subtitleElement.classList.remove('visible');
        }, 3000);
    }
}

// --- 5. 字幕機能 (Web Speech API) ---
function startSpeechRecognition() {
    // APIの存在チェックとプレフィックス対応
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
        console.warn('このブラウザはWeb Speech APIをサポートしていません。');
        return;
    }

    const recognition = new SpeechRecognition();
    recognition.lang = 'ja-JP';
    recognition.interimResults = true; // 認識の途中結果も取得
    recognition.continuous = true; // 継続的に認識

    recognition.onresult = (event) => {
        let interimTranscript = '';
        let finalTranscript = '';

        for (let i = event.resultIndex; i < event.results.length; ++i) {
            if (event.results[i].isFinal) {
                finalTranscript += event.results[i][0].transcript;
            } else {
                interimTranscript += event.results[i][0].transcript;
            }
        }
        
        const transcript = finalTranscript || interimTranscript;
        if (transcript) {
            // 自分の画面に字幕を表示
            showSubtitle('wrapper-local', transcript);
            // 他のメンバーに字幕を送信
            socket.emit('subtitle', transcript);
        }
    };
    
    recognition.onend = () => {
        console.log('音声認識が終了しました。1秒後に再開します。');
        setTimeout(() => recognition.start(), 1000); // 予期せぬ終了時に自動再開
    };

    recognition.onerror = (event) => {
        console.error('音声認識エラー:', event.error);
    };

    recognition.start();
    console.log('音声認識を開始しました。');
}

// --- 6. 退出処理 ---
hangupButton.addEventListener('click', () => location.reload());
window.addEventListener('beforeunload', () => socket.disconnect());
