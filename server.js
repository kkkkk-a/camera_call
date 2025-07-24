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

    // ★★★【重要】クライアントからルーム名のみ受け取る
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

        // ★★★【重要】サーバー側で参加者番号からユーザー名を生成
        const newUsername = `参加者${numClients + 1}`;

        if (!rooms[roomName]) {
            rooms[roomName] = {
                users: new Map(),
                isLocked: false,
                hostId: socket.id
            };
        }
        // 生成した名前でユーザー情報を登録
        rooms[roomName].users.set(socket.id, { username: newUsername });

        socket.join(roomName);
        currentRoom = roomName;

        const otherUsers = [];
        for (const [id, userData] of rooms[roomName].users.entries()) {
            if (id !== socket.id) {
                otherUsers.push({ id, username: userData.username });
            }
        }
        
        // ★★★【重要】参加した本人に、割り当てられた名前を通知
        socket.emit('room joined', {
            myName: newUsername, // 生成した自分の名前
            otherUsers: otherUsers,
            isLocked: rooms[roomName].isLocked,
            hostId: rooms[roomName].hostId
        });
        
        // 他のメンバーにも、生成された名前で新しい参加者を通知
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
    
    socket.on('disconnect', () => {
        if (currentRoom && rooms[currentRoom]) {
            io.to(currentRoom).emit('user left', socket.id);
            
            const wasHost = rooms[currentRoom].hostId === socket.id;
            rooms[currentRoom].users.delete(socket.id);

            if (rooms[currentRoom].users.size === 0) {
                delete rooms[currentRoom];
            } else if (wasHost) {
                const newHostId = rooms[currentRoom].users.keys().next().value;
                rooms[currentRoom].hostId = newHostId;
                io.to(currentRoom).emit('new host', newHostId);
            }
        }
    });
});

const port = process.env.PORT || 8080;
server.listen(port, () => {
    console.log(`サーバーがポート ${port} で起動しました`);
});
