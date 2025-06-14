const fs = require("fs");
const path = require("path");
const express = require("express");
const fileUpload = require("express-fileupload");
const { Server } = require("socket.io");
const session = require("express-session"); // express-sessionをインポート
const { v4: uuidv4 } = require("uuid");     // uuidをインポート

const app = express();
const server = require("http").createServer(app);
const io = new Server(server);

// セッションミドルウェアの設定
app.use(
  session({
    secret: "your-secret-key-super-secret", // 任意の強力な文字列に変更してください
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false }, // HTTPSを使用しない場合はfalseに設定 (RenderはHTTPSなのでtrueにするべきですが、今回はテスト用にfalseを維持)
  })
);

app.use(express.json());
app.use(express.static("public"));
app.use(fileUpload());

const MESSAGE_FILE = "messages.json";
const PINNED_FILE = "pinnedMessages.json";
const UPLOAD_DIR = "public/uploads";

// アップロードフォルダが存在しない場合、作成
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// メッセージを保存
function saveMessage(data) {
  let messages = fs.existsSync(MESSAGE_FILE)
    ? JSON.parse(fs.readFileSync(MESSAGE_FILE, "utf-8"))
    : [];
  messages.push(data);
  fs.writeFileSync(MESSAGE_FILE, JSON.stringify(messages, null, 2));
}

// ピン止めメッセージを保存
function savePinnedMessage(room, message) {
  let pinned = fs.existsSync(PINNED_FILE)
    ? JSON.parse(fs.readFileSync(PINNED_FILE, "utf-8"))
    : {};
  pinned[room] = message;
  fs.writeFileSync(PINNED_FILE, JSON.stringify(pinned, null, 2));
}

// ユーザーIDとユーザー名のセッション管理
app.use((req, res, next) => {
  // セッションにuserIdがない場合は新しく生成する（ゲストユーザー用）
  if (!req.session.userId) {
    req.session.userId = uuidv4();
    console.log("New userId generated for session:", req.session.userId);
  }
  // ゲストとしてアクセスし、かつセッションにusernameがない場合は仮で設定
  // chat.htmlでゲストログインする際にURLクエリパラメータ 'guest=true' を利用
  if (!req.session.username && req.query.guest === "true") {
    req.session.username = `ゲスト-${req.session.userId.substring(0, 4)}`; // 簡易的なゲスト名
    console.log("Guest username set:", req.session.username);
  }
  next();
});

// ルートアクセス時に `entry.html` を提供
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "entry.html"));
});

// 各HTMLファイルのルーティング
app.get("/index.html", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/register.html", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "register.html"));
});

app.get("/chat.html", (req, res) => {
  // 認証済みか、またはゲストユーザーとして入室可能かチェック
  // ゲストとしてアクセスする場合、URLに ?guest=true を含める
  if (req.session.authenticated === "true" || req.query.guest === "true") {
    res.sendFile(path.join(__dirname, "public", "chat.html"));
  } else {
    res.redirect("/entry.html"); // 認証されていなければentryページへリダイレクト
  }
});

// ログインAPI
app.post("/login", (req, res) => {
  const { username, password } = req.body;
  // ここでは簡略化のため、ユーザー名とパスワードをハードコード
  // 実際にはデータベースなどでユーザー認証を行う
  if (username === "user1" && password === "pass1") { // 例: ユーザー名「user1」、パスワード「pass1」
    req.session.authenticated = "true";
    req.session.username = username;
    // ログインユーザーにも新しいuserIdを割り当てるか、既存のものを利用（ここでは新しく割り当て）
    req.session.userId = uuidv4(); 
    console.log("User logged in:", username, "UserId:", req.session.userId);
    res.json({ success: true, username: username, userId: req.session.userId });
  } else {
    console.log("Login failed for username:", username);
    res.json({ success: false, message: "Invalid credentials" });
  }
});

// ユーザー名変更API
app.post("/change-username", (req, res) => {
  const { newUsername } = req.body;
  if (!newUsername || newUsername.trim() === "") {
    return res.status(400).json({ success: false, message: "新しいユーザー名を入力してください。" });
  }

  // セッションのユーザー名を更新
  const oldUsername = req.session.username;
  req.session.username = newUsername;
  console.log(`Username changed from ${oldUsername} to ${newUsername} for userId: ${req.session.userId}`);

  updateUserList(); // ユーザーリストを更新して、全クライアントに新しいユーザー名を通知

  res.json({ success: true, newUsername: newUsername });
});

// メッセージ送信API
app.post("/send-message", (req, res) => {
  const { message, room, dmTargetUser, dmTargetUserId } = req.body; 
  if (!message.trim()) {
    return res.status(400).json({ success: false, message: "メッセージは空にできません。" });
  }

  // 送信者のuserIdをセッションから取得
  const senderUserId = req.session.userId;
  // 送信者のusernameをセッションから取得
  const senderUsername = req.session.username; 

  if (!senderUsername || !senderUserId) {
      return res.status(401).json({ success: false, message: "ユーザー情報が取得できません。再ログインしてください。" });
  }

  const messageData = {
    user: senderUsername,
    text: message,
    room: room,
    timestamp: new Date().toISOString(),
    pinned: false,
    userId: senderUserId // 送信者のIDを追加
  };

  if (dmTargetUser && dmTargetUserId) {
    // DMの場合
    messageData.dm = true;
    messageData.dmTargetUser = dmTargetUser;
    messageData.dmTargetUserId = dmTargetUserId;

    // 送信者と受信者両方にDMを送信 (ソケットIDではなくユーザーIDのルームに送信)
    io.to(dmTargetUserId).emit("message", messageData);
    if (senderUserId !== dmTargetUserId) { // 自分自身へのDMでなければ
      io.to(senderUserId).emit("message", messageData);
    }
    console.log(`DM sent from ${senderUsername} (${senderUserId}) to ${dmTargetUser} (${dmTargetUserId})`);
  } else {
    // 通常のチャットの場合
    saveMessage(messageData);
    io.to(room).emit("message", messageData);
    console.log(`Message sent to room ${room} from ${senderUsername}: ${message}`);
  }

  res.json({ success: true });
});

// ファイルアップロードAPI
app.post("/upload", (req, res) => {
  try {
    if (!req.files || Object.keys(req.files).length === 0) {
      return res.status(400).json({ error: "No files were uploaded!" });
    }

    const file = req.files.file;
    const filePath = `${UPLOAD_DIR}/${file.name}`;
    const room = req.body.room;
    const dmTargetUser = req.body.dmTargetUser;
    const dmTargetUserId = req.body.dmTargetUserId;

    // 送信者のuserIdをセッションから取得
    const senderUserId = req.session.userId;
    // 送信者のusernameをセッションから取得
    const senderUsername = req.session.username;

    if (!senderUsername || !senderUserId) {
        return res.status(401).json({ success: false, message: "ユーザー情報が取得できません。再ログインしてください。" });
    }

    file.mv(filePath, (err) => {
      if (err) {
        console.error("File upload error:", err);
        return res.status(500).json({ error: err.message });
      }

      const fileUrl = `/uploads/${file.name}`;
      const fileMessage = {
        user: senderUsername,
        file: fileUrl,
        room: room,
        timestamp: new Date().toISOString(),
        pinned: false,
        userId: senderUserId // 送信者のIDを追加
      };

      if (dmTargetUser && dmTargetUserId) {
        // DMの場合
        fileMessage.dm = true;
        fileMessage.dmTargetUser = dmTargetUser;
        fileMessage.dmTargetUserId = dmTargetUserId;

        io.to(dmTargetUserId).emit("message", fileMessage);
        if (senderUserId !== dmTargetUserId) {
          io.to(senderUserId).emit("message", fileMessage);
        }
        console.log(`DM file sent from ${senderUsername} (${senderUserId}) to ${dmTargetUser} (${dmTargetUserId})`);
      } else {
        // 通常のチャットの場合
        saveMessage(fileMessage);
        io.to(room).emit("message", fileMessage);
        console.log(`File sent to room ${room} from ${senderUsername}: ${fileUrl}`);
      }

      res.json({ success: true, fileUrl });
    });
  } catch (error) {
    console.error("Unexpected error in upload:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Socket.IOの処理
io.on("connection", (socket) => {
  console.log("新しいユーザーが接続しました:", socket.id);

  socket.on("joinRoom", (room, username, userId) => {
    // 以前参加していたルームから離脱（ルーム切り替え時など）
    if (socket.currentRoom && socket.currentRoom !== room) {
        socket.leave(socket.currentRoom);
        console.log(`${socket.username} (${socket.userId}) left room ${socket.currentRoom}`);
    }
    // 以前紐付いていたuserIdのルームから離脱（ユーザー名変更時など）
    // socket.userIdが以前のuserIdで、かつ現在のuserIdと異なる場合に離脱
    if (socket.userId && socket.userId !== userId) {
        socket.leave(socket.userId);
        console.log(`Socket ${socket.id} left old userId room ${socket.userId}`);
    }

    socket.join(room); // 一般チャットルームへの参加
    socket.join(userId); // 個別ユーザー宛のルームとしてuserIdを使用 (これによりDM送信が可能に)

    socket.username = username; // socketオブジェクトにユーザー名を保存
    socket.userId = userId;     // socketオブジェクトにユーザーIDを保存
    socket.currentRoom = room;  // 現在のルームをソケットに保存

    console.log(`${username} (${userId}) joined room ${room} and also joined private room ${userId}`);

    const messages = fs.existsSync(MESSAGE_FILE)
      ? JSON.parse(fs.readFileSync(MESSAGE_FILE, "utf-8"))
      : [];
    
    // 参加したルームのメッセージ履歴と、自分宛のDM履歴を送信
    const relevantMessages = messages.filter(m => 
        m.room === room || (m.dm && (m.userId === userId || m.dmTargetUserId === userId))
    );
    socket.emit("messageHistory", relevantMessages);

    const pinned = fs.existsSync(PINNED_FILE)
      ? JSON.parse(fs.readFileSync(PINNED_FILE, "utf-8"))
      : {};
    if (pinned[room])
      socket.emit("updatePinnedMessage", { message: pinned[room] });

    // 接続しているユーザーリストを更新して全員に送信
    updateUserList();
  });

  socket.on("pinMessage", (data) => {
    savePinnedMessage(data.room, data.message);
    io.to(data.room).emit("updatePinnedMessage", { message: data.message });
    console.log(`Message pinned in room ${data.room}`);
  });

  socket.on("unpinMessage", (room) => {
    let pinned = fs.existsSync(PINNED_FILE)
      ? JSON.parse(fs.readFileSync(PINNED_FILE, "utf-8"))
      : {};
    delete pinned[room];
    fs.writeFileSync(PINNED_FILE, JSON.stringify(pinned, null, 2));
    io.to(room).emit("updatePinnedMessage", { message: null });
    console.log(`Message unpinned in room ${room}`);
  });

  socket.on("disconnect", () => {
    console.log("ユーザーが切断しました:", socket.id, "Username:", socket.username, "UserId:", socket.userId);
    // 切断時に参加していたルームとユーザーIDのルームから離脱
    // socket.userIdが設定されている場合のみ離脱処理を行う
    if (socket.currentRoom) {
      socket.leave(socket.currentRoom);
    }
    if (socket.userId) {
      socket.leave(socket.userId);
    }
    updateUserList(); // ユーザーリストを更新
  });
});

// ユーザーリストを更新して全クライアントに送信する関数
function updateUserList() {
  const users = [];
  const uniqueUserIds = new Set(); // 重複排除のためSetを使用

  // 全ての接続されているソケットを走査
  for (let [id, socket] of io.of("/").sockets) {
    // socket.username と socket.userId が設定されているソケットのみを対象
    // そして、まだリストに追加されていないuserIdのみを追加
    if (socket.username && socket.userId && !uniqueUserIds.has(socket.userId)) {
      users.push({ username: socket.username, userId: socket.userId });
      uniqueUserIds.add(socket.userId);
    }
  }
  // 全クライアントに更新されたユーザーリストを送信
  io.emit("updateUserList", users);
  console.log("Updated user list:", users.map(u => `${u.username}(${u.userId ? u.userId.substring(0,4) : 'N/A'}...)`).join(", "));
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
