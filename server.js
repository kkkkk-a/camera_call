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

    socket.on('join room', (roomName) => {
        const clientsInRoom = io.sockets.adapter.rooms.get(roomName);
        const numClients = clientsInRoom ? clientsInRoom.size : 0;

        if (rooms[roomName] && rooms[roomName].isLocked) {
            socket.emit('room locked');
            return;
        }
        if (numClients >= 5) {
            socket.emit('room full', roomName);
            return;
        }

        const newUsername = `参加者${numClients + 1}`;

        if (!rooms[roomName]) {
            rooms[roomName] = {
                users: new Map(),
                isLocked: false,
                hostId: socket.id
            };
        }
        rooms[roomName].users.set(socket.id, { username: newUsername });

        socket.join(roomName);
        currentRoom = roomName;

        const otherUsers = [];
        for (const [id, userData] of rooms[roomName].users.entries()) {
            if (id !== socket.id) {
                otherUsers.push({ id, username: userData.username });
            }
        }
        
        socket.emit('room joined', {
            myName: newUsername,
            otherUsers: otherUsers,
            isLocked: rooms[roomName].isLocked,
            hostId: rooms[roomName].hostId
        });
        
        socket.to(roomName).emit('user joined', {
            id: socket.id,
            username: newUsername
        });
    });

    socket.on('message', (message, toId) => {
        io.to(toId).emit('message', message, socket.id);
    });

    socket.on('change username', (newName) => {
        if (currentRoom && rooms[currentRoom] && rooms[currentRoom].users.has(socket.id)) {
            rooms[currentRoom].users.get(socket.id).username = newName;
            socket.to(currentRoom).emit('username changed', {
                userId: socket.id,
                newName: newName
            });
        }
    });

    socket.on('toggle lock', () => {
        if (currentRoom && rooms[currentRoom] && rooms[currentRoom].hostId === socket.id) {
            rooms[currentRoom].isLocked = !rooms[currentRoom].isLocked;
            io.to(currentRoom).emit('lock state changed', rooms[currentRoom].isLocked);
        }
    });

    socket.on('chat message', (msg) => {
        if (currentRoom && rooms[currentRoom] && rooms[currentRoom].users.has(socket.id)) {
            const senderName = rooms[currentRoom].users.get(socket.id).username;
            io.to(currentRoom).emit('chat message', {
                senderId: socket.id,
                senderName: senderName,
                msg: msg
            });
        }
    });
    
    // ★★★★★ ホスト退出処理のロジックを修正 ★★★★★
    socket.on('disconnect', () => {
        if (currentRoom && rooms[currentRoom]) {
            const wasHost = rooms[currentRoom].hostId === socket.id;
            
            // ルームにいる他のユーザーに、誰かが退出したことを通知
            io.to(currentRoom).emit('user left', socket.id);
            
            // ユーザーリストから削除
            rooms[currentRoom].users.delete(socket.id);

            // ホストが退出した場合
            if (wasHost) {
                // ルーム内の残りの全員にルーム終了を通知
                socket.to(currentRoom).emit('room closed', 'ホストが退出したため、ルームは終了しました。');
                // ルーム情報をメモリから削除
                delete rooms[currentRoom];
            } 
            // 参加者が誰もいなくなった場合
            else if (rooms[currentRoom] && rooms[currentRoom].users.size === 0) {
                // ルーム情報をメモリから削除
                delete rooms[currentRoom];
            }
        }
    });
});

const port = process.env.PORT || 8080;
server.listen(port, () => {
    console.log(`サーバーがポート ${port} で起動しました`);
});
