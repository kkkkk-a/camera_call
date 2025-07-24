'use strict';

const express = require('express');
const http = require('http');
const socketIO = require('socket.io');

const app = express();
app.use(express.static('public'));

const server = http.createServer(app);
const io = socketIO(server);

// ★★★ ルーム情報を管理するオブジェクト ★★★
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

        if (numClients >= 10) {
            socket.emit('room full', roomName);
            return;
        }

        // 最初の参加者がルーム情報を作成
        if (!rooms[roomName]) {
            rooms[roomName] = { isLocked: false };
        }

        socket.to(roomName).emit('user joined', socket.id);
        socket.join(roomName);
        currentRoom = roomName;

        const otherUsers = [];
        if (clientsInRoom) {
            clientsInRoom.forEach(id => otherUsers.push(id));
        }
        // ★★★ 参加時に現在のロック状態も通知 ★★★
        socket.emit('room joined', {
            roomId: roomName,
            otherUsers: otherUsers,
            isLocked: rooms[roomName].isLocked
        });
    });

    socket.on('message', (message, toId) => {
        io.to(toId).emit('message', message, socket.id);
    });

    socket.on('change username', (newName) => {
        if (currentRoom) {
            socket.to(currentRoom).emit('username changed', {
                userId: socket.id,
                newName: newName
            });
        }
    });

    // ★★★ ここからが追加箇所 ★★★

    // ルームのロック切り替えイベント
    socket.on('toggle lock', () => {
        if (currentRoom && rooms[currentRoom]) {
            rooms[currentRoom].isLocked = !rooms[currentRoom].isLocked;
            // ルーム全員にロック状態の変更を通知
            io.to(currentRoom).emit('lock state changed', rooms[currentRoom].isLocked);
        }
    });

    // チャットメッセージイベント
    socket.on('chat message', (msg) => {
        if (currentRoom) {
            // ルーム全員にメッセージを送信（送信者本人にも送る）
            io.to(currentRoom).emit('chat message', {
                senderId: socket.id,
                msg: msg
            });
        }
    });
    
    // ★★★ ここまでが追加箇所 ★★★

    socket.on('disconnect', () => {
        if (currentRoom) {
            io.to(currentRoom).emit('user left', socket.id);
            const clientsInRoom = io.sockets.adapter.rooms.get(currentRoom);
            // 誰もいなくなったらルーム情報を削除
            if (!clientsInRoom || clientsInRoom.size === 0) {
                delete rooms[currentRoom];
            }
        }
    });
});

const port = process.env.PORT || 8080;
server.listen(port, () => {
    // console.log(`サーバーがポート ${port} で起動しました`);
});
