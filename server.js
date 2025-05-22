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

const MESSAGE_FILE = "messages.json";
const PINNED_FILE = "pinnedMessages.json";
const UPLOAD_DIR = "public/uploads";

// **アップロードフォルダが存在しない場合、作成**
if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// **メッセージを保存**
function saveMessage(data) {
    let messages = fs.existsSync(MESSAGE_FILE) ? JSON.parse(fs.readFileSync(MESSAGE_FILE, "utf-8")) : [];
    messages.push(data);
    fs.writeFileSync(MESSAGE_FILE, JSON.stringify(messages, null, 2));
}

// **ピン止めメッセージを保存**
function savePinnedMessage(room, message) {
    let pinned = fs.existsSync(PINNED_FILE) ? JSON.parse(fs.readFileSync(PINNED_FILE, "utf-8")) : {};
    pinned[room] = message;
    fs.writeFileSync(PINNED_FILE, JSON.stringify(pinned, null, 2));
}

// **ルートアクセス時に `chat.html` を提供**
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "chat.html"));
});

// **メッセージ送信API**
app.post("/send-message", (req, res) => {
    const { message, username, room } = req.body;
    if (!message) return res.status(400).json({ error: "Message cannot be empty!" });

    const newMessage = { user: username, text: message, room, timestamp: new Date().toISOString(), pinned: false };
    saveMessage(newMessage);
    io.to(room).emit("message", newMessage);

    res.status(200).json({ success: true });
});

// **ピン止めAPI**
app.post("/pin-message", (req, res) => {
    const { message, room } = req.body;
    if (!message) return res.status(400).json({ error: "Pinned message cannot be empty!" });

    savePinnedMessage(room, message);
    io.to(room).emit("updatePinnedMessage", { message });

    res.status(200).json({ success: true });
});

// **メッセージ取得API**
app.get("/messages", (req, res) => {
    const { room } = req.query;
    if (!fs.existsSync(MESSAGE_FILE)) return res.json([]);
    const messages = JSON.parse(fs.readFileSync(MESSAGE_FILE, "utf-8"));
    res.json(messages.filter(m => m.room === room));
});

// **ピン止めメッセージ取得API**
app.get("/pinned-messages", (req, res) => {
    if (!fs.existsSync(PINNED_FILE)) return res.json({});
    res.json(JSON.parse(fs.readFileSync(PINNED_FILE, "utf-8")));
});

// **ファイルアップロードAPI**
app.post("/upload", (req, res) => {
    try {
        if (!req.files || !req.files.file) {
            return res.status(400).json({ error: "No file uploaded!" });
        }

        const file = req.files.file;
        const filePath = `${UPLOAD_DIR}/${file.name}`;

        file.mv(filePath, (err) => {
            if (err) {
                console.error("File upload error:", err);
                return res.status(500).json({ error: err.message });
            }

            const fileUrl = `/uploads/${file.name}`;
            const fileMessage = { user: req.body.username, file: fileUrl, room: req.body.room, timestamp: new Date().toISOString(), pinned: false };
            saveMessage(fileMessage);
            io.to(req.body.room).emit("message", fileMessage);

            res.json({ success: true, fileUrl });
        });
    } catch (error) {
        console.error("Unexpected error in upload:", error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// **Socket.IOの処理**
io.on("connection", (socket) => {
    socket.on("joinRoom", (room) => {
        socket.join(room);
        const messages = fs.existsSync(MESSAGE_FILE) ? JSON.parse(fs.readFileSync(MESSAGE_FILE, "utf-8")) : [];
        socket.emit("messageHistory", messages.filter(m => m.room === room));

        const pinned = fs.existsSync(PINNED_FILE) ? JSON.parse(fs.readFileSync(PINNED_FILE, "utf-8")) : {};
        if (pinned[room]) socket.emit("updatePinnedMessage", { message: pinned[room] });
    });
});

// **サーバー起動**
const PORT = 3000;
server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
