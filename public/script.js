'use strict';

// HTML要素の取得
const entryContainer = document.getElementById('entry-container');
const callContainer = document.getElementById('call-container');
const joinButton = document.getElementById('join-button');
const roomInput = document.getElementById('room-input');
const hangupButton = document.getElementById('hangup-button');
const localVideo = document.getElementById('local-video');
const videoGrid = document.getElementById('video-grid');
const roomNameDisplay = document.getElementById('room-name-display');

const socket = io();
let localStream;
let currentRoom = null;
const peerConnections = {}; // 相手ごとの接続情報（PCとICE候補キュー）を管理

// STUNサーバーの設定
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
        localVideo.srcObject = localStream;
        socket.emit('join room', roomName);
    } catch (e) {
        console.error('メディアの取得に失敗:', e);
        alert('カメラまたはマイクへのアクセスを許可してください。');
        location.reload();
    }
}

// --- 2. Socket.IOイベントのハンドリング ---

// ルームへの参加が完了したとき（サーバーから既存ユーザーのリストが送られてくる）
socket.on('room joined', (data) => {
    console.log(`ルーム '${data.roomId}' に参加しました。`);
    console.log('他のユーザー:', data.otherUsers);
    
    // 既にルームにいる他の全ユーザーに対して、自分から接続を開始（Offerを送る）
    data.otherUsers.forEach(userId => {
        if (!peerConnections[userId]) {
            createPeerConnection(userId, true);
        }
    });
});

// ★★★ ここが重要な変更点 ★★★
// 新しいユーザーがルームに参加した通知を受け取ったとき（既存ユーザー側の処理）
socket.on('user joined', (userId) => {
    console.log(`新しいユーザーが参加しました: ${userId}`);
    // 新しいユーザーとの接続オブジェクトを「受け身」の状態で事前に作成しておく。
    // これにより、相手からのOfferメッセージを確実に待つことができる。
    if (!peerConnections[userId]) {
        createPeerConnection(userId, false);
    }
});

// ユーザーがルームから退出したとき
socket.on('user left', (userId) => {
    console.log(`ユーザーが退出しました: ${userId}`);
    if (peerConnections[userId]) {
        peerConnections[userId].pc.close();
        delete peerConnections[userId];
    }
    const remoteVideoWrapper = document.getElementById(`wrapper-${userId}`);
    if (remoteVideoWrapper) {
        remoteVideoWrapper.remove();
    }
});

// ルームが満室だったとき
socket.on('room full', (roomName) => {
    alert(`ルーム '${roomName}' は満室です（最大10人）。`);
    location.reload();
});

// シグナリングメッセージを受信したとき
socket.on('message', async (message, fromId) => {
    // ★★★ ここのロジックを簡潔化 ★★★
    // この時点でpeerConnections[fromId]は必ず存在するはず
    const peer = peerConnections[fromId];
    if (!peer) {
        console.error(`不明なピアからのメッセージです: ${fromId}`);
        return;
    }
    
    try {
        if (message.type === 'offer') {
            if (peer.pc.signalingState !== 'stable') {
                console.warn(`Offerを受け取りましたが、状態がstableではないため無視します。現在の状態: ${peer.pc.signalingState}`);
                return;
            }
            await peer.pc.setRemoteDescription(new RTCSessionDescription(message));
            const answer = await peer.pc.createAnswer();
            await peer.pc.setLocalDescription(answer);
            socket.emit('message', answer, fromId);
            await processIceCandidateQueue(peer);

        } else if (message.type === 'answer') {
            if (peer.pc.signalingState !== 'have-local-offer') {
                console.warn(`Answerを受け取りましたが、状態がhave-local-offerではないため無視します。現在の状態: ${peer.pc.signalingState}`);
                return;
            }
            await peer.pc.setRemoteDescription(new RTCSessionDescription(message));
            await processIceCandidateQueue(peer);

        } else if (message.type === 'candidate' && message.candidate) {
            if (peer.pc.remoteDescription) {
                await peer.pc.addIceCandidate(new RTCIceCandidate(message.candidate));
            } else {
                console.log('ICE候補を待機リストに追加します');
                peer.iceCandidateQueue.push(message.candidate);
            }
        }
    } catch (e) {
        console.error(`メッセージ処理中にエラーが発生しました (from: ${fromId}):`, e);
    }
});


// --- 3. WebRTCの処理 ---

function createPeerConnection(partnerId, isInitiator) {
    console.log(`PeerConnectionを作成します for ${partnerId} (Initiator: ${isInitiator})`);
    const pc = new RTCPeerConnection(configuration);

    peerConnections[partnerId] = {
        pc: pc,
        iceCandidateQueue: []
    };

    localStream.getTracks().forEach(track => {
        pc.addTrack(track, localStream);
    });

    if (isInitiator) {
        pc.createOffer()
            .then(offer => pc.setLocalDescription(offer))
            .then(() => {
                socket.emit('message', pc.localDescription, partnerId);
            })
            .catch(e => console.error(`Offerの作成に失敗しました for ${partnerId}:`, e));
    }

    pc.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('message', { type: 'candidate', candidate: event.candidate }, partnerId);
        }
    };

    pc.ontrack = (event) => {
        addRemoteVideoStream(partnerId, event.streams[0]);
    };

    pc.onconnectionstatechange = () => {
        console.log(`Connection state for ${partnerId}: ${pc.connectionState}`);
    };

    return pc;
}

async function processIceCandidateQueue(peer) {
    while (peer.iceCandidateQueue.length > 0) {
        const candidate = peer.iceCandidateQueue.shift();
        console.log('待機リストからICE候補を処理します:', candidate);
        await peer.pc.addIceCandidate(new RTCIceCandidate(candidate));
    }
}

function addRemoteVideoStream(userId, stream) {
    if (document.getElementById(`video-${userId}`)) return;

    const videoWrapper = document.createElement('div');
    videoWrapper.className = 'video-wrapper';
    videoWrapper.id = `wrapper-${userId}`;
    
    const remoteVideo = document.createElement('video');
    remoteVideo.id = `video-${userId}`;
    remoteVideo.srcObject = stream;
    remoteVideo.autoplay = true;
    remoteVideo.playsInline = true;

    const nameTag = document.createElement('h3');
    nameTag.textContent = `User: ${userId.substring(0, 4)}`;

    videoWrapper.appendChild(remoteVideo);
    videoWrapper.appendChild(nameTag);
    videoGrid.appendChild(videoWrapper);
}

// --- 4. 退出処理 ---
hangupButton.addEventListener('click', () => {
    location.reload();
});

window.addEventListener('beforeunload', () => {
    socket.disconnect();
});
