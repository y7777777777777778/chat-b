const fs = require("fs");
const express = require("express");
const multer = require("multer");

const app = express();
app.use(express.json());
app.use(express.static("uploads"));

const upload = multer({ dest: "uploads/" });

const FILE_PATH = "messages.json";

function saveMessage(data) {
    let messages = [];
    if (fs.existsSync(FILE_PATH)) {
        messages = JSON.parse(fs.readFileSync(FILE_PATH, "utf-8"));
    }
    messages.push(data);
    fs.writeFileSync(FILE_PATH, JSON.stringify(messages, null, 2));
}

app.post("/send-message", (req, res) => {
    const { message, username, room } = req.body;
    if (!message) return res.status(400).json({ error: "Message cannot be empty!" });

    saveMessage({ user: username, text: message, room });
    res.status(200).json({ success: true });
});

app.post("/upload", upload.single("file"), (req, res) => {
    if (!req.file) return res.status(400).json({ error: "File upload failed!" });

    const fileUrl = `/uploads/${req.file.filename}`;
    saveMessage({ user: req.body.username, file: fileUrl, room: req.body.room });
    res.status(200).json({ success: true, fileUrl });
});

app.get("/messages", (req, res) => {
    if (!fs.existsSync(FILE_PATH)) return res.json([]);
    const messages = JSON.parse(fs.readFileSync(FILE_PATH, "utf-8"));
    res.json(messages);
});

app.listen(3000, () => {
    console.log("Server is running on http://localhost:3000");
});
