'use strict';

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
    const switchCameraButton = document.getElementById('switch-camera-button');


    const socket = io();
    let localStream;
    let currentRoom = null;
    const peerConnections = {};
    let myUsername = '';
    let isHost = false;
    let videoDevices = [];
    let currentVideoDeviceIndex = 0;

    const configuration = {
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    };

    // ★★★★★ ここからが今回の修正箇所 ★★★★★

    // --- 0. 初期UI設定 ---
    // ページ読み込み時に、デバイスに応じて不要なボタンを非表示にする
    function setupInitialUI() {
        // navigator.mediaDevices.getDisplayMedia がサポートされていない、
        // またはユーザーエージェントがモバイルである場合、画面共有ボタンを非表示にする
        if (!navigator.mediaDevices.getDisplayMedia || /iPhone|iPad|iPod|Android/i.test(navigator.userAgent)) {
            shareScreenButton.style.display = 'none';
        }
    }
    // ページが読み込まれたら即座に実行
    setupInitialUI();
    
    // ★★★★★ ここまでが今回の修正箇所 ★★★★★


    // --- 1. 入室処理 ---
    joinButton.addEventListener('click', () => {
        const roomName = roomInput.value.trim();
        if (!roomName) {
            alert('合言葉を入力してください。');
            return;
        }
        setupLocalMedia(roomName);
    });
    roomInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            joinButton.click();
        }
    });

    async function setupLocalMedia(roomName) {
        try {
            // 利用可能なカメラデバイスを検出
            await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
            const devices = await navigator.mediaDevices.enumerateDevices();
            videoDevices = devices.filter(device => device.kind === 'videoinput');
            
            if (videoDevices.length > 1) {
                switchCameraButton.style.display = 'block';
            }

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

        addVideoStream('local', '接続中...', localStream);
        setMainVideo(document.getElementById('wrapper-local'));
        
        socket.emit('join room', roomName);
    }

    // --- 2. Socket.IOイベントのハンドリング ---
    socket.on('room joined', (data) => {
        myUsername = data.myName;
        data.otherUsers.forEach(user => {
            if (!peerConnections[user.id]) createPeerConnection(user.id, user.username, true);
        });
        isHost = (socket.id === data.hostId);
        updateLockState(data.isLocked);
        updateHostControls();
    });
    socket.on('user joined', (user) => {
        if (!peerConnections[user.id]) createPeerConnection(user.id, user.username, false);
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
                const localVideoWrapper = document.getElementById('wrapper-local');
                if (localVideoWrapper) setMainVideo(localVideoWrapper);
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
    socket.on('room closed', (message) => {
        alert(message);
        location.reload();
    });
    socket.on('lock state changed', (locked) => {
        updateLockState(locked);
        const message = locked ? 'ルームがホストによってロックされました。' : 'ルームのロックが解除されました。';
        appendChatMessage('システム', message, false, true);
    });
    socket.on('chat message', (data) => {
        const isMyMessage = data.senderId === socket.id;
        if (!isMyMessage) {
            appendChatMessage(data.senderName, data.msg);
        }
    });
    socket.on('message', async (message, fromId) => {
        if (!peerConnections[fromId]) return;
        const peer = peerConnections[fromId];
        try {
            if (message.type === 'offer') {
                await peer.pc.setRemoteDescription(new RTCSessionDescription(message));
                const answer = await peer.pc.createAnswer();
                await peer.pc.setLocalDescription(answer);
                socket.emit('message', answer, fromId);
            } else if (message.type === 'answer') {
                await peer.pc.setRemoteDescription(new RTCSessionDescription(message));
            } else if (message.type === 'candidate') {
                await peer.pc.addIceCandidate(new RTCIceCandidate(message.candidate));
            }
        } catch (e) {
            console.error(`シグナリングメッセージの処理中にエラー (from: ${fromId}):`, e);
        }
    });
    socket.on('username changed', (data) => {
        const nameTag = document.querySelector(`#wrapper-${data.userId} h3`);
        if (nameTag) {
            nameTag.textContent = data.newName;
        }
    });

    // --- 3. WebRTCの処理 ---
    function createPeerConnection(partnerId, partnerName, isInitiator) {
        const pc = new RTCPeerConnection(configuration);
        peerConnections[partnerId] = { pc: pc };
        localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
        pc.onicecandidate = (event) => {
            if (event.candidate) {
                socket.emit('message', { type: 'candidate', candidate: event.candidate }, partnerId);
            }
        };
        pc.ontrack = (event) => {
            addVideoStream(partnerId, partnerName, event.streams[0]);
        };
        if (isInitiator) {
            pc.createOffer()
                .then(offer => pc.setLocalDescription(offer))
                .then(() => {
                    socket.emit('message', pc.localDescription, partnerId);
                })
                .catch(e => console.error(`Offer作成失敗 for ${partnerId}:`, e));
        }
    }

    // --- 4. DOM操作（ビデオ） ---
    function addVideoStream(id, name, stream) {
        if (document.getElementById(`wrapper-${id}`)) return;
        const wrapper = document.createElement('div');
        wrapper.className = 'video-wrapper';
        wrapper.id = `wrapper-${id}`;
        const video = document.createElement('video');
        video.srcObject = stream;
        video.autoplay = true;
        video.playsInline = true;
        if (id === 'local') {
            video.muted = true;
        }
        const nameTag = document.createElement('h3');
        nameTag.textContent = name;
        if (id === 'local') {
            nameTag.title = 'クリックして名前を変更';
            nameTag.addEventListener('click', (e) => {
                e.stopPropagation();
                makeNameEditable(nameTag);
            });
        }
        wrapper.appendChild(video);
        wrapper.appendChild(nameTag);
        thumbnailGrid.appendChild(wrapper);
        wrapper.addEventListener('click', (e) => {
            if (e.target.tagName !== 'INPUT') {
                setMainVideo(wrapper);
            }
        });
        video.addEventListener('loadedmetadata', () => {
            try {
                video.play();
            } catch (error) {
                console.warn("ビデオの自動再生に失敗しました。ユーザー操作が必要です。", error);
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
        const hasMessages = document.querySelector('#chat-messages li');
        if (hasMessages && confirm('チャット履歴をテキストファイルとして保存しますか？')) {
            saveChatHistory();
        }
        location.reload();
    });
    window.addEventListener('beforeunload', () => {
        if(socket) socket.disconnect();
    });
    function saveChatHistory() {
        const messages = document.querySelectorAll('#chat-messages li');
        if (messages.length === 0) return;
        const timestamp = new Date();
        const header = `ルーム「${currentRoom}」のチャット履歴 (${timestamp.toLocaleString()})\n========================================\n\n`;
        const chatLines = Array.from(messages).map(li => {
            if (li.classList.contains('system-message')) {
                return `--- ${li.textContent} ---`;
            }
            const senderSpan = li.querySelector('.sender-name');
            const senderName = senderSpan ? senderSpan.textContent.trim() : '';
            let messageText = '';
            li.childNodes.forEach(node => {
                if (node.nodeType === Node.TEXT_NODE) {
                    messageText += node.textContent;
                }
            });
            return `${senderName} ${messageText.trim()}`;
        });
        const fileContent = header + chatLines.join('\n');
        const blob = new Blob([fileContent], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const dateString = timestamp.toISOString().slice(0, 10);
        a.download = `chat-log-${currentRoom}-${dateString}.txt`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    // --- 6. メディアコントロール機能 ---
    let isMicOn = true;
    let isVideoOn = true;
    micButton.addEventListener('click', () => {
        if (localStream) {
            isMicOn = !isMicOn;
            localStream.getAudioTracks().forEach(track => track.enabled = isMicOn);
            micButton.textContent = isMicOn ? 'ミュート' : 'ミュート解除';
            micButton.classList.toggle('muted', !isMicOn);
        }
    });
    videoButton.addEventListener('click', () => {
        if (localStream) {
            isVideoOn = !isVideoOn;
            localStream.getVideoTracks().forEach(track => track.enabled = isVideoOn);
            videoButton.textContent = isVideoOn ? 'ビデオ停止' : 'ビデオ開始';
            videoButton.classList.toggle('off', !isVideoOn);
            if (!isVideoOn && isScreenSharing) {
                stopScreenShare();
            }
        }
    });
    switchCameraButton.addEventListener('click', switchCamera);

    // --- 7. 画面共有機能 ---
    let isScreenSharing = false;
    let screenStream = null;
    let cameraTrack = null;
    let wasVideoEnabledBeforeShare = true;
    async function startScreenShare() {
        if (isScreenSharing || !localStream) return;
        try {
            screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
            const screenTrack = screenStream.getVideoTracks()[0];
            wasVideoEnabledBeforeShare = isVideoOn;
            cameraTrack = localStream.getVideoTracks()[0];
            for (const peerId in peerConnections) {
                const sender = peerConnections[peerId].pc.getSenders().find(s => s.track && s.track.kind === 'video');
                if (sender) {
                    await sender.replaceTrack(screenTrack);
                }
            }
            localStream.removeTrack(cameraTrack);
            localStream.addTrack(screenTrack);
            document.getElementById('wrapper-local').classList.add('screen-sharing');
            isScreenSharing = true;
            shareScreenButton.textContent = '共有停止';
            shareScreenButton.classList.add('sharing');
            isVideoOn = true;
            videoButton.textContent = 'ビデオOFF';
            videoButton.classList.remove('off');
            screenTrack.onended = () => {
                if (isScreenSharing) {
                    stopScreenShare();
                }
            };
        } catch (e) {
            console.error('画面共有の開始に失敗しました:', e);
        }
    }
    async function stopScreenShare() {
        if (!isScreenSharing) return;
        const screenTrack = localStream.getVideoTracks()[0];
        for (const peerId in peerConnections) {
            const sender = peerConnections[peerId].pc.getSenders().find(s => s.track && s.track.kind === 'video');
            if (sender) {
                await sender.replaceTrack(cameraTrack);
            }
        }
        localStream.removeTrack(screenTrack);
        localStream.addTrack(cameraTrack);
        screenTrack.stop();
        document.getElementById('wrapper-local').classList.remove('screen-sharing');
        isScreenSharing = false;
        screenStream = null;
        cameraTrack = null;
        shareScreenButton.textContent = '画面共有';
        shareScreenButton.classList.remove('sharing');
        isVideoOn = wasVideoEnabledBeforeShare;
        localStream.getVideoTracks().forEach(track => track.enabled = isVideoOn);
        videoButton.textContent = isVideoOn ? 'ビデオOFF' : 'ビデオON';
        videoButton.classList.toggle('off', !isVideoOn);
    }
    shareScreenButton.addEventListener('click', () => {
        if (isScreenSharing) {
            stopScreenShare();
        } else {
            startScreenShare();
        }
    });

    // --- 8. カメラ切り替え機能 ---
    async function switchCamera() {
        if (videoDevices.length < 2) {
            alert('切り替え可能なカメラがありません。');
            return;
        }
        if (isScreenSharing) {
            alert('画面共有中はカメラを切り替えられません。');
            return;
        }
        try {
            currentVideoDeviceIndex = (currentVideoDeviceIndex + 1) % videoDevices.length;
            const nextDevice = videoDevices[currentVideoDeviceIndex];
            const newStream = await navigator.mediaDevices.getUserMedia({
                video: { deviceId: { exact: nextDevice.deviceId } },
                audio: false
            });
            const newVideoTrack = newStream.getVideoTracks()[0];
            const oldVideoTrack = localStream.getVideoTracks()[0];
            oldVideoTrack.stop();
            localStream.removeTrack(oldVideoTrack);
            localStream.addTrack(newVideoTrack);
            for (const peerId in peerConnections) {
                const sender = peerConnections[peerId].pc.getSenders().find(s => s.track && s.track.kind === 'video');
                if (sender) {
                    await sender.replaceTrack(newVideoTrack);
                }
            }
        } catch(e) {
            console.error('カメラの切り替えに失敗しました:', e);
            alert('カメラの切り替えに失敗しました。');
            currentVideoDeviceIndex = (currentVideoDeviceIndex - 1 + videoDevices.length) % videoDevices.length;
        }
    }

    // --- 9. ユーザー名編集機能 ---
    function makeNameEditable(nameTag) {
        nameTag.style.display = 'none';
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'username-input';
        input.value = myUsername;
        nameTag.parentElement.appendChild(input);
        input.focus();
        const updateName = () => {
            const newName = input.value.trim();
            if (newName && newName !== myUsername) {
                myUsername = newName;
                socket.emit('change username', newName);
            }
            let displayName = isHost ? `${myUsername} (ホスト)` : myUsername;
            nameTag.textContent = displayName;
            nameTag.style.display = 'block';
            if(input.parentElement) {
                input.remove();
            }
        };
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                updateName();
            }
        });
        input.addEventListener('blur', updateName);
    }

    // --- 10. UI制御とチャット機能 ---
    function updateHostControls() {
        lockRoomButton.style.display = isHost ? 'block' : 'none';
        const localNameTag = document.querySelector('#wrapper-local h3');
        if (localNameTag) {
             localNameTag.textContent = isHost ? `${myUsername} (ホスト)` : myUsername;
        }
    }
    function updateLockState(locked) {
        if (locked) {
            lockRoomButton.textContent = '🔒 制限を解除';
            lockRoomButton.classList.add('locked');
        } else {
            lockRoomButton.textContent = '🔒 参加を制限';
            lockRoomButton.classList.remove('locked');
        }
    }
    lockRoomButton.addEventListener('click', () => {
        if (isHost) {
            socket.emit('toggle lock');
        }
    });
    function appendChatMessage(senderName, msg, isMyMessage = false, isSystemMessage = false) {
        const item = document.createElement('li');
        if (isMyMessage) item.className = 'my-message';
        if (isSystemMessage) item.className = 'system-message';
        if (!isSystemMessage) {
            const nameSpan = document.createElement('span');
            nameSpan.className = 'sender-name';
            nameSpan.textContent = `${senderName}: `;
            item.appendChild(nameSpan);
        }
        item.append(msg);
        chatMessages.appendChild(item);
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }
    chatForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const message = chatInput.value.trim();
        if (message) {
            appendChatMessage(myUsername, message, true);
            socket.emit('chat message', message);
            chatInput.value = '';
        }
    });
});
