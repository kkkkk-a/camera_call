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
    }
}

// --- 2. Socket.IOイベントのハンドリング ---

// ルームへの参加が完了したとき（サーバーから既存ユーザーのリストが送られてくる）
socket.on('room joined', (data) => {
    console.log(`ルーム '${data.roomId}' に参加しました。`);
    console.log('他のユーザー:', data.otherUsers);

    // 既にルームにいる他の全ユーザーに接続を開始
    data.otherUsers.forEach(userId => {
        createPeerConnection(userId, true); // 自分から接続を開始するので initiator = true
    });
});

// 新しいユーザーがルームに参加したとき
socket.on('user joined', (userId) => {
    console.log(`新しいユーザーが参加しました: ${userId}`);
    // 新しく参加してきたユーザーへの接続を準備（相手からオファーが来るのを待つ）
    createPeerConnection(userId, false);
});

// ユーザーがルームから退出したとき
socket.on('user left', (userId) => {
    console.log(`ユーザーが退出しました: ${userId}`);
    if (peerConnections[userId]) {
        peerConnections[userId].close();
        delete peerConnections[userId];
    }
    const remoteVideo = document.getElementById(`video-${userId}`);
    if (remoteVideo) {
        remoteVideo.parentElement.remove();
    }
});

// ルームが満室だったとき
socket.on('room full', (roomName) => {
    alert(`ルーム '${roomName}' は満室です（最大10人）。`);
    location.reload(); // ページをリロードして最初の画面に戻す
});

// シグナリングメッセージを受信したとき
socket.on('message', (message, fromId) => {
    const pc = peerConnections[fromId];
    if (!pc) return;

    if (message.type === 'offer') {
        pc.setRemoteDescription(new RTCSessionDescription(message))
            .then(() => pc.createAnswer())
            .then(answer => {
                pc.setLocalDescription(answer);
                socket.emit('message', answer, fromId);
            })
            .catch(e => console.error(e));
    } else if (message.type === 'answer') {
        pc.setRemoteDescription(new RTCSessionDescription(message));
    } else if (message.type === 'candidate') {
        pc.addIceCandidate(new RTCIceCandidate(message.candidate));
    }
});

// --- 3. WebRTCの処理 ---

// PeerConnectionの作成（相手ごと）
function createPeerConnection(partnerId, isInitiator) {
    const pc = new RTCPeerConnection(configuration);
    peerConnections[partnerId] = pc;

    // 自分のメディアストリームを接続に追加
    localStream.getTracks().forEach(track => {
        pc.addTrack(track, localStream);
    });

    // (発信者側のみ) オファーを作成
    if (isInitiator) {
        pc.createOffer()
            .then(offer => {
                pc.setLocalDescription(offer);
                socket.emit('message', offer, partnerId);
            })
            .catch(e => console.error(e));
    }

    // ICE候補が見つかったときの処理
    pc.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('message', { type: 'candidate', candidate: event.candidate }, partnerId);
        }
    };

    // 相手の映像ストリームを受信したときの処理
    pc.ontrack = (event) => {
        addRemoteVideoStream(partnerId, event.streams[0]);
    };

    return pc;
}

// 相手のビデオ要素をDOMに追加
function addRemoteVideoStream(userId, stream) {
    if (document.getElementById(`video-${userId}`)) return;

    const videoWrapper = document.createElement('div');
    videoWrapper.className = 'video-wrapper';
    
    const remoteVideo = document.createElement('video');
    remoteVideo.id = `video-${userId}`;
    remoteVideo.srcObject = stream;
    remoteVideo.autoplay = true;
    remoteVideo.playsInline = true;

    const nameTag = document.createElement('h3');
    nameTag.textContent = `User: ${userId.substring(0, 4)}`; // IDを短く表示

    videoWrapper.appendChild(remoteVideo);
    videoWrapper.appendChild(nameTag);
    videoGrid.appendChild(videoWrapper);
}

// --- 4. 退出処理 ---
hangupButton.addEventListener('click', () => {
    // 全ての接続を閉じる
    for (const userId in peerConnections) {
        peerConnections[userId].close();
    }
    // 自分のメディアを停止
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
    }
    // サーバーに退出を通知する必要はない（disconnectイベントで処理される）
    location.reload(); // ページをリロードして最初の画面に戻す
});