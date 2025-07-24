'use strict';

const express = require('express');
const http = require('http');
const socketIO = require('socket.io');

const app = express();
app.use(express.static('public'));

const server = http.createServer(app);
const io = socketIO(server);

io.on('connection', (socket) => {
    // console.log(`クライアントが接続: ${socket.id}`);

    let currentRoom = null;

    socket.on('join room', (roomName) => {
        const clientsInRoom = io.sockets.adapter.rooms.get(roomName);
        const numClients = clientsInRoom ? clientsInRoom.size : 0;

        if (numClients >= 10) {
            socket.emit('room full', roomName);
            return;
        }

        socket.to(roomName).emit('user joined', socket.id);
        socket.join(roomName);
        currentRoom = roomName;

        const otherUsers = [];
        if (clientsInRoom) {
            clientsInRoom.forEach(id => otherUsers.push(id));
        }
        socket.emit('room joined', { roomId: roomName, otherUsers: otherUsers });
    });

    socket.on('message', (message, toId) => {
        io.to(toId).emit('message', message, socket.id);
    });
    
    // ★★★ 字幕イベントのハンドラを削除 ★★★

    socket.on('disconnect', () => {
        if (currentRoom) {
            io.to(currentRoom).emit('user left', socket.id);
        }
    });
});

const port = process.env.PORT || 8080;
server.listen(port, () => {
    // console.log(`サーバーがポート ${port} で起動しました`);
});
