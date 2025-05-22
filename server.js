
const fs = require("fs");
const path = require("path");
const express = require("express");
const fileUpload = require("express-fileupload");
const { Server } = require("socket.io");

const app = express();
const server = require("http").createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static("public"));
app.use(fileUpload());

const FILE_PATH = "messages.json";
let pinnedMessages = {};

// メッセージを保存する関数
function saveMessage(data) {
    let messages = fs.existsSync(FILE_PATH) ? JSON.parse(fs.readFileSync(FILE_PATH, "utf-8")) : [];
    messages.push(data);
    fs.writeFileSync(FILE_PATH, JSON.stringify(messages, null, 2));
}

// ルートアクセス時に `chat.html` を提供
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "chat.html"));
});

// メッセージ送信API
app.post("/send-message", (req, res) => {
    const { message, username, room } = req.body;
    if (!message) return res.status(400).json({ error: "Message cannot be empty!" });

    const newMessage = { user: username, text: message, room, timestamp: new Date().toISOString() };
    saveMessage(newMessage);
    io.to(room).emit("message", newMessage);

    res.status(200).json({ success: true });
});

// ファイルアップロードAPI
app.post("/upload", (req, res) => {
    if (!req.files || !req.files.file) {
        return res.status(400).json({ error: "No file uploaded!" });
    }

    const file = req.files.file;
    const filePath = `public/uploads/${file.name}`;

    file.mv(filePath, (err) => {
        if (err) return res.status(500).json({ error: err.message });

        const fileUrl = `/uploads/${file.name}`;
        const fileMessage = { user: req.body.username, file: fileUrl, room: req.body.room, timestamp: new Date().toISOString() };
        saveMessage(fileMessage);
        io.to(req.body.room).emit("message", fileMessage);

        res.json({ success: true, fileUrl });
    });
});

// メッセージ取得API
app.get("/messages", (req, res) => {
    if (!fs.existsSync(FILE_PATH)) return res.json([]);
    const messages = JSON.parse(fs.readFileSync(FILE_PATH, "utf-8"));
    res.json(messages);
});

// Socket.IOの接続処理
io.on("connection", (socket) => {
    socket.on("joinRoom", (room) => {
        socket.join(room);
        socket.emit("messageHistory", JSON.parse(fs.readFileSync(FILE_PATH, "utf-8")).filter(m => m.room === room));
        if (pinnedMessages[room]) socket.emit("updatePinnedMessage", { message: pinnedMessages[room] });
    });

    socket.on("pinMessage", (data) => {
        pinnedMessages[data.room] = data.message;
        io.to(data.room).emit("updatePinnedMessage", { message: data.message });
    });
});

// サーバー起動
const PORT = 3000;
server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
