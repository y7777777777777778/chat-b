const fs = require("fs");
const path = require("path");
const express = require("express");
const fileUpload = require("express-fileupload");

const app = express();
app.use(express.json());
app.use(express.static("public"));
app.use(fileUpload());

const FILE_PATH = "messages.json";

// メッセージを保存する関数
function saveMessage(data) {
    let messages = [];
    if (fs.existsSync(FILE_PATH)) {
        messages = JSON.parse(fs.readFileSync(FILE_PATH, "utf-8"));
    }
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

    saveMessage({ user: username, text: message, room, timestamp: new Date().toISOString() });
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
        saveMessage({ user: req.body.username, file: fileUrl, room: req.body.room, timestamp: new Date().toISOString() });
        res.json({ success: true, fileUrl });
    });
});

// メッセージ取得API
app.get("/messages", (req, res) => {
    if (!fs.existsSync(FILE_PATH)) return res.json([]);
    const messages = JSON.parse(fs.readFileSync(FILE_PATH, "utf-8"));
    res.json(messages);
});

// サーバー起動
const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
