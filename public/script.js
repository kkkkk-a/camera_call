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
const peerConnections = {}; // 複数のPeerConnectionを管理するオブジェクト

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
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
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

// 新しいユーザーがルームに参加した通知を受け取ったとき
socket.on('user joined', (userId) => {
    console.log(`新しいユーザーが参加しました: ${userId}`);
    // この時点では何もしない。新しいユーザー（Initiator）からのOfferを待つ。
});

// ユーザーがルームから退出したとき
socket.on('user left', (userId) => {
    console.log(`ユーザーが退出しました: ${userId}`);
    if (peerConnections[userId]) {
        peerConnections[userId].close();
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
    // 相手との接続オブジェクトがまだなければ作成する（Offerを受け取った側）
    if (!peerConnections[fromId]) {
        createPeerConnection(fromId, false);
    }

    const pc = peerConnections[fromId];
    
    try {
        if (message.type === 'offer') {
            if (pc.signalingState !== 'stable') {
                console.warn(`Offerを受け取りましたが、状態がstableではないため無視します。現在の状態: ${pc.signalingState}`);
                return;
            }
            await pc.setRemoteDescription(new RTCSessionDescription(message));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            socket.emit('message', answer, fromId);

        } else if (message.type === 'answer') {
            if (pc.signalingState !== 'have-local-offer') {
                console.warn(`Answerを受け取りましたが、状態がhave-local-offerではないため無視します。現在の状態: ${pc.signalingState}`);
                return;
            }
            await pc.setRemoteDescription(new RTCSessionDescription(message));

        } else if (message.type === 'candidate' && message.candidate) {
            await pc.addIceCandidate(new RTCIceCandidate(message.candidate));
        }
    } catch (e) {
        console.error(`メッセージ処理中にエラーが発生しました (from: ${fromId}):`, e);
    }
});

// --- 3. WebRTCの処理 ---

function createPeerConnection(partnerId, isInitiator) {
    console.log(`PeerConnectionを作成します for ${partnerId} (Initiator: ${isInitiator})`);
    const pc = new RTCPeerConnection(configuration);
    peerConnections[partnerId] = pc;

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
    // ページを閉じる・リロードする際にソケット接続を明示的に切断
    socket.disconnect();
});
