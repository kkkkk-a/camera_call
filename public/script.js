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

    const socket = io();
    let localStream;
    let currentRoom = null;
    const peerConnections = {};
    let myUsername = '自分';
    let isHost = false; // ★改善点: 自分がホストかどうかのフラグ

    const configuration = {
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    };

    // --- 1. 入室処理 ---
    joinButton.addEventListener('click', () => {
        const roomName = roomInput.value.trim();
        if (!roomName) {
            alert('合言葉を入力してください。');
            return;
        }
        setupLocalMedia(roomName);
    });
    // Enterキーでも参加できるようにする
    roomInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            joinButton.click();
        }
    });

    async function setupLocalMedia(roomName) {
        try {
            const constraints = {
                video: true,
                audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
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
        
        // ★改善点: サーバーに自分の初期名を渡す
        socket.emit('join room', roomName, myUsername);
    }

    // --- 2. Socket.IOイベントのハンドリング ---
    socket.on('room joined', (data) => {
        // 既存のユーザー全員に対してPeerConnectionを作成
        data.otherUsers.forEach(user => {
            if (!peerConnections[user.id]) createPeerConnection(user.id, user.username, true);
        });
        // ★改善点: ホスト状態とロック状態を更新
        isHost = (socket.id === data.hostId);
        updateLockState(data.isLocked);
        updateHostControls();
    });

    socket.on('user joined', (user) => {
        // 新しく参加したユーザーに対してPeerConnectionを作成
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
                // メインビデオのユーザーが退出したら、自分のビデオをメインにする
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

    // ★改善点: ホスト変更の通知を受け取る
    socket.on('new host', (newHostId) => {
        isHost = (socket.id === newHostId);
        updateHostControls();
        const hostNameTag = document.querySelector(`#wrapper-${newHostId} h3`);
        const hostName = hostNameTag ? hostNameTag.textContent : '新しいホスト';
        appendChatMessage('システム', `${hostName}が新しいホストになりました。`, false, true);
    });

    socket.on('lock state changed', (locked) => {
        updateLockState(locked);
        const message = locked ? 'ルームがホストによってロックされました。' : 'ルームのロックが解除されました。';
        appendChatMessage('システム', message, false, true);
    });

    // ★改善点: チャットメッセージの受信処理を簡潔化
    socket.on('chat message', (data) => {
        const isMyMessage = data.senderId === socket.id;
        // 自分のメッセージは送信時に表示済みなので、他人からのメッセージのみ表示
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
        if (id === 'local') video.muted = true;

        const nameTag = document.createElement('h3');
        nameTag.textContent = name;
        if (id === 'local') {
            nameTag.title = 'クリックして名前を変更';
            nameTag.addEventListener('click', () => makeNameEditable(nameTag));
        }
        
        // ★改善点: ホストの表示
        if (isHost && id === socket.id) {
            nameTag.textContent += ' (ホスト)';
        }

        wrapper.appendChild(video);
        wrapper.appendChild(nameTag);
        thumbnailGrid.appendChild(wrapper);

        wrapper.addEventListener('click', (e) => {
            // 入力フィールドをクリックした場合はメインビデオにしない
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
    // ブラウザを閉じる/リロードする直前に切断処理
    window.addEventListener('beforeunload', () => {
        if(socket) socket.disconnect();
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
            
            // ビデオOFF時に画面共有中なら、共有も停止する
            if (!isVideoOn && isScreenSharing) {
                stopScreenShare(true); // ビデオOFFを維持したまま共有停止
            }
        }
    });

    // --- 7. 画面共有機能 ---
    let isScreenSharing = false;
    let screenStream = null;
    let cameraTrack = null;
    let wasVideoEnabledBeforeShare = true; // ★改善点: 共有開始前のビデオ状態を保存

    async function startScreenShare() {
        if (isScreenSharing || !localStream) return;
        try {
            screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
            
            wasVideoEnabledBeforeShare = isVideoOn; // ★改善点: 現在のビデオ状態を保存
            if (!wasVideoEnabledBeforeShare) {
                // ビデオがオフだったら、一時的にオンにしてトラックを取得
                localStream.getVideoTracks().forEach(track => track.enabled = true);
            }
            cameraTrack = localStream.getVideoTracks()[0];

            const screenTrack = screenStream.getVideoTracks()[0];
            // 全てのPeerConnectionのビデオトラックを画面共有に差し替え
            for (const peerId in peerConnections) {
                const sender = peerConnections[peerId].pc.getSenders().find(s => s.track && s.track.kind === 'video');
                if (sender) await sender.replaceTrack(screenTrack);
            }
            // 自分のビデオも画面共有に差し替え
            const localVideo = document.getElementById('video-local');
            localVideo.srcObject = new MediaStream([screenTrack]);

            isScreenSharing = true;
            shareScreenButton.textContent = '共有停止';
            shareScreenButton.classList.add('sharing');
            
            // 画面共有中はビデオONの状態としてUIを更新
            isVideoOn = true;
            videoButton.textContent = 'ビデオOFF';
            videoButton.classList.remove('off');

            // ユーザーがブラウザのUIで共有停止した場合のイベント
            screenTrack.onended = () => stopScreenShare();

        } catch (e) {
            console.error('画面共有の開始に失敗しました:', e);
            // ★改善点: 共有開始に失敗したら、ビデオの状態を元に戻す
            if (!wasVideoEnabledBeforeShare) {
                localStream.getVideoTracks().forEach(track => track.enabled = false);
            }
        }
    }
    
    async function stopScreenShare(keepVideoOff = false) {
        if (!isScreenSharing) return;

        // 全てのPeerConnectionのトラックをカメラに戻す
        if (cameraTrack) {
            for (const peerId in peerConnections) {
                const sender = peerConnections[peerId].pc.getSenders().find(s => s.track && s.track.kind === 'video');
                if (sender) await sender.replaceTrack(cameraTrack);
            }
        }
        
        // 画面共有ストリームを停止
        screenStream.getTracks().forEach(track => track.stop());
        
        // 自分のビデオをカメラストリームに戻す
        const localVideo = document.getElementById('video-local');
        localVideo.srcObject = localStream;
        
        isScreenSharing = false;
        screenStream = null;
        cameraTrack = null;
        shareScreenButton.textContent = '画面共有';
        shareScreenButton.classList.remove('sharing');

        // ★改善点: 共有開始前の状態、または引数に基づいてビデオの状態を復元
        isVideoOn = wasVideoEnabledBeforeShare && !keepVideoOff;
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

    // --- 8. ユーザー名編集機能 ---
    function makeNameEditable(nameTag) {
        nameTag.style.display = 'none';
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'username-input';
        input.value = myUsername; // グローバル変数から現在の名前を取得
        nameTag.parentElement.appendChild(input);
        input.focus();
        
        const updateName = () => {
            const newName = input.value.trim();
            if (newName && newName !== myUsername) {
                myUsername = newName;
                socket.emit('change username', newName);
            }
            // 表示を更新（ホスト表示も考慮）
            let displayName = isHost ? `${myUsername} (ホスト)` : myUsername;
            nameTag.textContent = displayName;
            
            nameTag.style.display = 'block';
            input.remove();
        };
        
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') updateName();
        });
        input.addEventListener('blur', updateName);
    }

    // --- 9. ロック機能とチャット機能 ---
    // ★改善点: ホスト用のUI制御
    function updateHostControls() {
        lockRoomButton.style.display = isHost ? 'block' : 'none';
        const localNameTag = document.querySelector('#wrapper-local h3');
        if (localNameTag) {
             localNameTag.textContent = isHost ? `${myUsername} (ホスト)` : myUsername;
        }
    }

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
        // UI上はホストしか押せないが、念の為チェック
        if (isHost) {
            socket.emit('toggle lock');
        }
    });

    function appendChatMessage(senderName, msg, isMyMessage = false, isSystemMessage = false) {
        const item = document.createElement('li');
        if (isMyMessage) item.className = 'my-message';
        if (isSystemMessage) item.className = 'system-message';

        // システムメッセージでなければ送信者名を表示
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
            appendChatMessage(myUsername, message, true); // 自分のメッセージとして即時表示
            socket.emit('chat message', message);
            chatInput.value = '';
        }
    });

});
