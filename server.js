'use strict';

const express = require('express');
const http = require('http');
const socketIO = require('socket.io');

const app = express();
app.use(express.static('public'));

const server = http.createServer(app);
const io = socketIO(server);

// ルームごとの情報を管理するオブジェクト
const roomInfo = {};

io.on('connection', (socket) => {
    console.log(`クライアントが接続: ${socket.id}`);

    let currentRoom = null;

    // ユーザーからのルーム参加リクエスト
    socket.on('join room', (roomName) => {
        const clientsInRoom = io.sockets.adapter.rooms.get(roomName);
        const numClients = clientsInRoom ? clientsInRoom.size : 0;

        if (numClients >= 10) {
            socket.emit('room full', roomName);
            return;
        }

        // 新しいユーザーが入室したことを、そのルームにいる他の全員に通知
        socket.to(roomName).emit('user joined', socket.id);

        socket.join(roomName);
        currentRoom = roomName;

        // 新しく参加したユーザーに、既にルームにいるユーザーのリストを送る
        const otherUsers = [];
        if (clientsInRoom) {
            clientsInRoom.forEach(id => otherUsers.push(id));
        }
        socket.emit('room joined', { roomId: roomName, otherUsers: otherUsers });

        console.log(`クライアント ${socket.id} がルーム '${roomName}' に参加しました。現在の人数: ${numClients + 1}`);
    });

    // シグナリングメッセージの転送
    socket.on('message', (message, toId) => {
        console.log(`メッセージを ${socket.id} から ${toId} へ転送します`);
        // メッセージを特定の相手にだけ送る
        io.to(toId).emit('message', message, socket.id);
    });
        socket.on('subtitle', (subtitleData) => {
        if (currentRoom) {
            // 自分以外のルームメンバーに字幕データを転送
            socket.to(currentRoom).emit('subtitle', subtitleData, socket.id);
        }
    });

    // ユーザーが切断したときの処理
    socket.on('disconnect', () => {
        console.log(`クライアントが切断: ${socket.id}`);
        if (currentRoom) {
            // ルームにいる他のユーザーに、誰かが退出したことを通知
            socket.to(currentRoom).emit('user left', socket.id);
        }
    });
});

const port = process.env.PORT || 8080;
server.listen(port, () => {
    console.log(`サーバーがポート ${port} で起動しました`);
});
