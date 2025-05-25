
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
const UPLOAD_DIR = "public/uploads";

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

function saveMessage(data) {
  const messages = fs.existsSync(MESSAGE_FILE) ? JSON.parse(fs.readFileSync(MESSAGE_FILE)) : [];
  messages.push(data);
  fs.writeFileSync(MESSAGE_FILE, JSON.stringify(messages, null, 2));
}

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "chat.html"));
});

app.get("/messages", (req, res) => {
  const room = req.query.room;
  const messages = fs.existsSync(MESSAGE_FILE) ? JSON.parse(fs.readFileSync(MESSAGE_FILE)) : [];
  res.json(messages.filter(m => m.room === room));
});

app.post("/send-message", (req, res) => {
  const { message, username, room } = req.body;
  const newMsg = { user: username, text: message, room, timestamp: new Date().toISOString() };
  saveMessage(newMsg);
  io.to(room).emit("message", newMsg);
  res.json({ success: true });
});

app.post("/upload", (req, res) => {
  if (!req.files || !req.files.file) return res.status(400).json({ error: "No file!" });

  const file = req.files.file;
  const filePath = `${UPLOAD_DIR}/${file.name}`;
  file.mv(filePath, (err) => {
    if (err) return res.status(500).json({ error: err.message });

    const fileUrl = `/uploads/${file.name}`;
    const newMsg = { user: req.body.username, file: fileUrl, room: req.body.room, timestamp: new Date().toISOString() };
    saveMessage(newMsg);
    io.to(req.body.room).emit("message", newMsg);
    res.json({ success: true, fileUrl });
  });
});

// ユーザー管理
const users = {}; // socket.id => username

io.on("connection", (socket) => {
  socket.on("registerUser", (username) => {
    users[socket.id] = username;
    io.emit("userList", Object.values(users));
  });

  socket.on("requestUserList", () => {
    socket.emit("userList", Object.values(users));
  });

  socket.on("disconnect", () => {
    delete users[socket.id];
    io.emit("userList", Object.values(users));
  });

  socket.on("joinRoom", (room) => {
    socket.join(room);
  });
});

server.listen(3000, () => console.log("http://localhost:3000"));
