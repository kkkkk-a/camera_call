'use strict';

const express = require('express');
const http = require('http');
const socketIO = require('socket.io');

const app = express();
// publicフォルダを静的ファイル配信用に設定
app.use(express.static(__dirname + '/public'));
// ルートURLへのアクセスでindex.htmlを送信
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});


const server = http.createServer(app);
const io = socketIO(server);

// ルームごとの情報を管理するオブジェクト
const rooms = {};

io.on('connection', (socket) => {
    let currentRoom = null;

    socket.on('join room', (roomName, initialUsername) => {
        // --- 1. 入室前チェック ---
        // ロック状態をチェック
        if (rooms[roomName] && rooms[roomName].isLocked) {
            socket.emit('room locked');
            return;
        }

        const clientsInRoom = io.sockets.adapter.rooms.get(roomName);
        const numClients = clientsInRoom ? clientsInRoom.size : 0;

        // 人数制限のチェック (最大5人)
        if (numClients >= 5) {
            socket.emit('room full', roomName);
            return;
        }

        // --- 2. ルーム情報の初期化・更新 ---
        if (!rooms[roomName]) {
            rooms[roomName] = {
                users: new Map(), // Mapを使うことで、参加順の維持が容易になる
                isLocked: false,
                hostId: socket.id // 最初の参加者をホストにする
            };
        }
        // ユーザー情報をルームに登録
        rooms[roomName].users.set(socket.id, { username: initialUsername });

        // --- 3. ルームへの参加処理 ---
        socket.join(roomName);
        currentRoom = roomName;

        // 既存ユーザーの情報を整形して新しい参加者に送信
        const otherUsers = [];
        if (rooms[roomName]) {
            for (const [id, userData] of rooms[roomName].users.entries()) {
                if (id !== socket.id) {
                    otherUsers.push({ id, username: userData.username });
                }
            }
        }
        
        // 参加した本人に、既存のユーザーリスト、現在のロック状態、ホストIDを通知
        socket.emit('room joined', {
            otherUsers: otherUsers,
            isLocked: rooms[roomName].isLocked,
            hostId: rooms[roomName].hostId
        });
        
        // ルームの他のメンバーに、新しい参加者が来たことをユーザー名と共に通知
        socket.to(roomName).emit('user joined', {
            id: socket.id,
            username: initialUsername
        });
    });

    // WebRTCのシグナリングメッセージを特定の相手に転送
    socket.on('message', (message, toId) => {
        io.to(toId).emit('message', message, socket.id);
    });

    // ユーザー名変更イベントをルーム内の他メンバーに転送
    socket.on('change username', (newName) => {
        if (currentRoom && rooms[currentRoom] && rooms[currentRoom].users.has(socket.id)) {
            // サーバー側のユーザー情報を更新
            rooms[currentRoom].users.get(socket.id).username = newName;
            // 他のメンバーに通知
            socket.to(currentRoom).emit('username changed', {
                userId: socket.id,
                newName: newName
            });
        }
    });

    // ルームのロック状態切り替えイベント（ホストのみ実行可能）
    socket.on('toggle lock', () => {
        if (currentRoom && rooms[currentRoom] && rooms[currentRoom].hostId === socket.id) {
            rooms[currentRoom].isLocked = !rooms[currentRoom].isLocked;
            // ルーム全員にロック状態の変更を通知
            io.to(currentRoom).emit('lock state changed', rooms[currentRoom].isLocked);
        }
    });

    // チャットメッセージをルーム内の全員に転送
    socket.on('chat message', (msg) => {
        if (currentRoom && rooms[currentRoom] && rooms[currentRoom].users.has(socket.id)) {
            const senderName = rooms[currentRoom].users.get(socket.id).username;
            // 送信者本人にも送るため、io.to() を使用
            io.to(currentRoom).emit('chat message', {
                senderId: socket.id,
                senderName: senderName, // サーバー側で管理しているユーザー名を付与
                msg: msg
            });
        }
    });
    
    // クライアント切断時の処理
    socket.on('disconnect', () => {
        if (currentRoom && rooms[currentRoom]) {
            // ルームにいる他のユーザーに、誰かが退出したことを通知
            io.to(currentRoom).emit('user left', socket.id);
            
            const wasHost = rooms[currentRoom].hostId === socket.id;
            // ユーザーリストから削除
            rooms[currentRoom].users.delete(socket.id);

            // 誰もいなくなったらルーム情報をメモリから削除
            if (rooms[currentRoom].users.size === 0) {
                delete rooms[currentRoom];
            }
            // ホストが退出した場合、新しいホストを選出
            else if (wasHost) {
                // users (Map) の最初のユーザーを新しいホストにする
                const newHostId = rooms[currentRoom].users.keys().next().value;
                rooms[currentRoom].hostId = newHostId;
                // 全員に新しいホストを通知
                io.to(currentRoom).emit('new host', newHostId);
            }
        }
    });
});

const port = process.env.PORT || 8080;
server.listen(port, () => {
    console.log(`サーバーがポート ${port} で起動しました`);
});
