'use strict';

const express = require('express');
const http = require('http');
const socketIO = require('socket.io');

const app = express();
app.use(express.static('public'));

const server = http.createServer(app);
const io = socketIO(server);

// ルームごとの情報を管理するオブジェクト
const rooms = {};

io.on('connection', (socket) => {
    let currentRoom = null;

    socket.on('join room', (roomName) => {
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

        // 最初の参加者がルーム情報を作成
        if (!rooms[roomName]) {
            rooms[roomName] = { isLocked: false };
        }

        // ルームに参加する前に、他のメンバーに新しい参加者が来ることを通知
        socket.to(roomName).emit('user joined', socket.id);

        // 実際にルームに参加
        socket.join(roomName);
        currentRoom = roomName;

        const otherUsers = [];
        if (clientsInRoom) {
            clientsInRoom.forEach(id => otherUsers.push(id));
        }
        
        // 参加した本人に、既存のユーザーリストと現在のロック状態を通知
        socket.emit('room joined', {
            roomId: roomName,
            otherUsers: otherUsers,
            isLocked: rooms[roomName].isLocked
        });
    });

    // WebRTCのシグナリングメッセージを特定の相手に転送
    socket.on('message', (message, toId) => {
        io.to(toId).emit('message', message, socket.id);
    });

    // ユーザー名変更イベントをルーム内の他メンバーに転送
    socket.on('change username', (newName) => {
        if (currentRoom) {
            socket.to(currentRoom).emit('username changed', {
                userId: socket.id,
                newName: newName
            });
        }
    });

    // ルームのロック状態切り替えイベント
    socket.on('toggle lock', () => {
        if (currentRoom && rooms[currentRoom]) {
            rooms[currentRoom].isLocked = !rooms[currentRoom].isLocked;
            // ルーム全員にロック状態の変更を通知
            io.to(currentRoom).emit('lock state changed', rooms[currentRoom].isLocked);
        }
    });

    // チャットメッセージをルーム内の全員に転送
    socket.on('chat message', (msg) => {
        if (currentRoom) {
            // 送信者本人にも送るため、io.to() を使用
            io.to(currentRoom).emit('chat message', {
                senderId: socket.id,
                msg: msg
            });
        }
    });
    
    // クライアント切断時の処理
    socket.on('disconnect', () => {
        if (currentRoom) {
            // ルームにいる他のユーザーに、誰かが退出したことを通知
            io.to(currentRoom).emit('user left', socket.id);
            
            // Socket.IO v3/v4 での非同期なルーム情報取得
            const clientsInRoom = io.sockets.adapter.rooms.get(currentRoom);
            const numClients = clientsInRoom ? clientsInRoom.size : 0;

            // 誰もいなくなったらルーム情報をメモリから削除
            if (numClients === 0) {
                delete rooms[currentRoom];
            }
        }
    });
});

const port = process.env.PORT || 8080;
server.listen(port, () => {
    // ログはRender側で確認するため、ローカルでの表示は任意
    // console.log(`サーバーがポート ${port} で起動しました`);
});
