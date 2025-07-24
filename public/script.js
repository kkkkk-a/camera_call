'use strict';

// ★★★ ブラウザがHTMLの準備を終えてから、すべてのコードを実行する ★★★
window.addEventListener('DOMContentLoaded', () => {

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
    const lockRoomButton = document.getElementById('lock-room-button');
    const chatForm = document.getElementById('chat-form');
    const chatInput = document.getElementById('chat-input');
    const chatMessages = document.getElementById('chat-messages');

    const socket = io();
    let localStream;
    let currentRoom = null;
    const peerConnections = {};
    let isRoomLocked = false;
    let myUsername = '自分';

    const configuration = {
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    };

    // --- 1. 入室処理 ---
    joinButton.addEventListener('click', () => {
        const roomName = roomInput.value;
        if (!roomName) {
            alert('合言葉を入力してください。');
            return;
        }
        setupLocalMedia(roomName);
    });

    async function setupLocalMedia(roomName) {
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
            joinRoom(roomName);
        } catch (e) {
            console.error('メディアの取得に失敗:', e);
            alert('カメラまたはマイクへのアクセスに失敗しました。ブラウザの許可設定や、他のアプリがデバイスを使用していないか確認してください。');
        }
    }

    function joinRoom(roomName) {
        currentRoom = roomName;
        entryContainer.style.display = 'none';
        callContainer.style.display = 'block';
        roomNameDisplay.textContent = `ルーム: ${currentRoom}`;

        addVideoStream('local', myUsername, localStream);
        setMainVideo(document.getElementById('wrapper-local'));
        
        socket.emit('join room', roomName);
    }


    // --- 2. Socket.IOイベントのハンドリング ---
    socket.on('room joined', (data) => {
        data.otherUsers.forEach(userId => {
            if (!peerConnections[userId]) createPeerConnection(userId, true);
        });
        isRoomLocked = data.isLocked;
        updateLockState(isRoomLocked);
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
        if (remoteVideoWrapper) {
            const isMain = remoteVideoWrapper.parentElement.id === 'main-video-container';
            remoteVideoWrapper.remove();
            if (isMain) {
                const nextMain = thumbnailGrid.querySelector('.video-wrapper');
                if (nextMain) setMainVideo(nextMain);
            }
        }
    });

    socket.on('room full', (roomName) => {
        alert(`ルーム '${roomName}' は満室です。`);
        location.reload();
    });

    socket.on('room locked', () => {
        alert('このルームはロックされています。');
        location.reload();
    });

    socket.on('lock state changed', (locked) => {
        isRoomLocked = locked;
        updateLockState(isRoomLocked);
    });

    socket.on('chat message', (data) => {
        const { senderId, msg } = data;
        const nameTag = document.querySelector(`#wrapper-${senderId} h3`);
        const senderName = nameTag ? nameTag.textContent : `User: ${senderId.substring(0, 4)}`;
        appendChatMessage(senderName, msg);
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
                if (peer.pc.remoteDescription) {
                    await peer.pc.addIceCandidate(new RTCIceCandidate(message.candidate));
                } else {
                    peer.iceCandidateQueue.push(message.candidate);
                }
            }
        } catch (e) {
            // console.error(`メッセージ処理中にエラー (from: ${fromId}):`, e);
        }
    });

    socket.on('username changed', (data) => {
        const nameTag = document.querySelector(`#wrapper-${data.userId} h3`);
        if (nameTag) {
            nameTag.textContent = data.newName;
        }
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

    // --- 4. DOM操作（ビデオ） ---
    function addVideoStream(id, name, stream) {
        if (document.getElementById(`wrapper-${id}`)) return;
        const wrapper = document.createElement('div');
        wrapper.className = 'video-wrapper';
        wrapper.id = `wrapper-${id}`;
        const video = document.createElement('video');
        video.id = `video-${id}`;
        if (stream) {
            video.srcObject = stream;
        }
        video.autoplay = true;
        video.playsInline = true;
        if (id === 'local') video.muted = true;
        const nameTag = document.createElement('h3');
        nameTag.textContent = name;
        wrapper.appendChild(video);
        wrapper.appendChild(nameTag);
        thumbnailGrid.appendChild(wrapper);
        if (id === 'local') {
            nameTag.title = 'クリックして編集';
            nameTag.addEventListener('click', () => makeNameEditable(nameTag));
        }
        wrapper.addEventListener('click', (e) => {
            if (e.target.tagName !== 'INPUT') {
                setMainVideo(wrapper);
            }
        });
    }

    function setMainVideo(targetWrapper) {
        const currentMain = mainVideoContainer.querySelector('.video-wrapper');
        if (currentMain && currentMain.id !== targetWrapper.id) {
            thumbnailGrid.appendChild(currentMain);
        }
        mainVideoContainer.appendChild(targetWrapper);
    }

    // --- 5. 退出処理 ---
    hangupButton.addEventListener('click', () => {
        location.reload();
    });
    window.addEventListener('beforeunload', () => {
        socket.disconnect();
    });

    // --- 6. メディアコントロール機能 ---
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
            if (!isVideoOn && isScreenSharing) {
                stopScreenShare(true);
            }
        }
    });

    // --- 7. 画面共有機能 ---
    let isScreenSharing = false;
    let screenStream = null;
    let cameraTrack = null;
    async function startScreenShare() {
        if (isScreenSharing || !localStream) return;
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
            isVideoOn = true;
            videoButton.textContent = 'ビデオOFF';
            videoButton.classList.remove('off');
            screenTrack.onended = () => stopScreenShare();
        } catch (e) {
            // console.error('画面共有の開始に失敗しました:', e);
        }
    }
    async function stopScreenShare(keepVideoOff = false) {
        if (!isScreenSharing) return;
        if (cameraTrack) {
            for (const peerId in peerConnections) {
                const sender = peerConnections[peerId].pc.getSenders().find(s => s.track && s.track.kind === 'video');
                if (sender) await sender.replaceTrack(cameraTrack);
            }
        }
        screenStream.getTracks().forEach(track => track.stop());
        const localVideo = document.getElementById('video-local');
        localVideo.srcObject = localStream;
        isScreenSharing = false;
        screenStream = null;
        shareScreenButton.textContent = '画面共有';
        shareScreenButton.classList.remove('sharing');
        if (keepVideoOff) {
            isVideoOn = false;
            if(localStream) localStream.getVideoTracks().forEach(track => track.enabled = false);
            videoButton.textContent = 'ビデオON';
            videoButton.classList.add('off');
        }
    }
    shareScreenButton.addEventListener('click', () => {
        if (isScreenSharing) {
            stopScreenShare();
        } else {
            startScreenShare();
        }
    });

    // --- 8. ユーザー名編集機能 ---
    function makeNameEditable(nameTag) {
        nameTag.style.display = 'none';
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'username-input';
        input.value = nameTag.textContent;
        nameTag.parentElement.appendChild(input);
        input.focus();
        const updateName = () => {
            const newName = input.value.trim();
            if (newName && newName !== nameTag.textContent) {
                nameTag.textContent = newName;
                myUsername = newName;
                socket.emit('change username', newName);
            }
            nameTag.style.display = 'block';
            input.remove();
        };
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') updateName();
        });
        input.addEventListener('blur', updateName);
    }

    // --- 9. ロック機能とチャット機能 ---
    function updateLockState(locked) {
        if (locked) {
            lockRoomButton.textContent = '🔒 解除';
            lockRoomButton.classList.add('locked');
        } else {
            lockRoomButton.textContent = '🔒 ロック';
            lockRoomButton.classList.remove('locked');
        }
    }
    lockRoomButton.addEventListener('click', () => {
        socket.emit('toggle lock');
    });

    function appendChatMessage(senderName, msg, isMyMessage = false) {
        const item = document.createElement('li');
        if (isMyMessage) item.className = 'my-message';
        const nameSpan = document.createElement('span');
        nameSpan.className = 'sender-name';
        nameSpan.textContent = `${senderName}: `;
        item.appendChild(nameSpan);
        item.append(msg);
        chatMessages.appendChild(item);
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    chatForm.addEventListener('submit', (e) => {
        e.preventDefault();
        if (chatInput.value) {
            appendChatMessage(myUsername, chatInput.value, true);
            socket.emit('chat message', chatInput.value);
            chatInput.value = '';
        }
    });

}); // ★★★ DOMContentLoaded イベントリスナーの閉じカッコ ★★★
