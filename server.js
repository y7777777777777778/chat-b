const fs = require("fs");
const path = require("path");
const express = require("express");
const fileUpload = require("express-fileupload");
const { Server } = require("socket.io");
const session = require("express-session");
const { v4: uuidv4 } = require("uuid");

const app = express();
const server = require("http").createServer(app);
const io = new Server(server);

// セッションミドルウェアの設定
app.use(
  session({
    secret: "your-secret-key-super-secret", // 任意の強力な文字列に変更してください
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false }, // RenderはHTTPSなのでtrueにするべきですが、開発中はfalseでも可
  })
);

app.use(express.json());
app.use(express.static("public"));
app.use(fileUpload());

const MESSAGE_FILE = "messages.json";
const PINNED_FILE = "pinnedMessages.json";
const UPLOAD_DIR = "public/uploads";
const USERS_FILE = "users.json"; // 登録ユーザー情報を保存するファイル

// アップロードフォルダが存在しない場合、作成
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// JSONファイルを読み込むヘルパー関数
function readJsonFile(filePath, defaultValue = []) {
  if (fs.existsSync(filePath)) {
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    } catch (e) {
      console.error(`Error reading ${filePath}:`, e);
      return defaultValue;
    }
  }
  return defaultValue;
}

// JSONファイルに書き込むヘルパー関数
function writeJsonFile(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// メッセージを保存
function saveMessage(data) {
  let messages = readJsonFile(MESSAGE_FILE);
  messages.push(data);
  writeJsonFile(MESSAGE_FILE, messages);
}

// ピン止めメッセージを保存
function savePinnedMessage(room, message) {
  let pinned = readJsonFile(PINNED_FILE, {});
  pinned[room] = message;
  writeJsonFile(PINNED_FILE, pinned);
}

// ユーザーIDとユーザー名のセッション管理
app.use((req, res, next) => {
  // セッションにuserIdがない場合は新しく生成する（ゲストユーザー用）
  if (!req.session.userId) {
    req.session.userId = uuidv4();
    console.log("New userId generated for session:", req.session.userId);
  }
  next();
});

// 認証チェックミドルウェア
function isAuthenticated(req, res, next) {
  if (req.session.authenticated === "true" || req.query.guest === "true") {
    // ログイン済みユーザーの場合、userIdがなければ設定
    if (req.session.authenticated === "true" && !req.session.userId) {
      const users = readJsonFile(USERS_FILE, []);
      const user = users.find(u => u.username === req.session.username);
      if (user) {
        req.session.userId = user.id; // 登録ユーザーのIDを使用
      } else {
        req.session.userId = uuidv4(); // 念のため新規割り当て
      }
    }
    // ゲストユーザーの場合、usernameがなければ設定
    if (req.query.guest === "true" && !req.session.username) {
      req.session.username = `ゲスト-${req.session.userId.substring(0, 4)}`;
    }
    next();
  } else {
    console.log("Not authenticated, redirecting to index.html");
    res.redirect("/index.html");
  }
}

// ルートアクセス時に `index.html` を提供
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// 各HTMLファイルのルーティング
app.get("/index.html", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/register.html", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "register.html"));
});

app.get("/chat.html", isAuthenticated, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "chat.html"));
});

// 認証状態とユーザー名、IDを返すAPI
app.get("/check-auth", (req, res) => {
  if (req.session.authenticated === "true" || req.query.guest === "true") {
    // ゲストログインの場合のユーザー名再設定
    if (req.query.guest === "true" && !req.session.username) {
        req.session.username = `ゲスト-${req.session.userId.substring(0, 4)}`;
    }
    res.json({
      authenticated: true,
      username: req.session.username,
      userId: req.session.userId,
    });
  } else {
    res.json({ authenticated: false });
  }
});

// ログインAPI
app.post("/login", (req, res) => {
  const { username, password } = req.body;
  const users = readJsonFile(USERS_FILE, []);
  const user = users.find(u => u.username === username && u.password === password);

  if (user) {
    req.session.authenticated = "true";
    req.session.username = user.username;
    req.session.userId = user.id; // 登録ユーザーの固有IDをセッションに保存
    console.log("User logged in:", username, "UserId:", req.session.userId);
    res.json({ success: true, username: user.username, userId: user.id });
  } else {
    console.log("Login failed for username:", username);
    res.json({ success: false, message: "ユーザー名またはパスワードが違います。" });
  }
});

// 登録API
app.post("/register", (req, res) => {
    const { username, password } = req.body;
    let users = readJsonFile(USERS_FILE, []);

    if (users.some(u => u.username === username)) {
        return res.json({ success: false, message: "このユーザー名は既に存在します。" });
    }

    const newUser = {
        id: uuidv4(), // 新しいユーザーにUUIDを割り当てる
        username,
        password
    };
    users.push(newUser);
    writeJsonFile(USERS_FILE, users);
    console.log("New user registered:", newUser.username, "UserId:", newUser.id);
    res.json({ success: true, message: "登録が完了しました！" });
});

// ユーザー名変更API
app.post("/change-username", isAuthenticated, (req, res) => {
  const { newUsername } = req.body;
  if (!newUsername || newUsername.trim() === "") {
    return res.status(400).json({ success: false, message: "新しいユーザー名を入力してください。" });
  }

  const oldUsername = req.session.username;
  const userId = req.session.userId;

  // 登録ユーザーの場合、users.jsonも更新
  let users = readJsonFile(USERS_FILE, []);
  const userIndex = users.findIndex(u => u.id === userId); // IDでユーザーを検索

  if (userIndex !== -1) { // 登録ユーザーの場合
      if (users.some(u => u.username === newUsername && u.id !== userId)) {
          return res.status(400).json({ success: false, message: "そのユーザー名は既に使用されています。" });
      }
      users[userIndex].username = newUsername;
      writeJsonFile(USERS_FILE, users);
  }
  
  // セッションのユーザー名を更新
  req.session.username = newUsername;

  // 過去のメッセージのユーザー名も更新（任意だが、整合性のため）
  let messages = readJsonFile(MESSAGE_FILE);
  messages = messages.map(msg => {
      if (msg.userId === userId) { // userIdでメッセージをフィルタリング
          msg.user = newUsername;
      }
      return msg;
  });
  writeJsonFile(MESSAGE_FILE, messages);

  console.log(`Username changed from ${oldUsername} to ${newUsername} for userId: ${userId}`);
  
  // Socket.IOでユーザーリストを更新して全クライアントに通知
  io.emit("updateUserList", getAllConnectedUsers());

  res.json({ success: true, newUsername: newUsername });
});


// ログアウトAPI
app.post("/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error("Session destroy error:", err);
      return res.status(500).json({ success: false, message: "ログアウトに失敗しました。" });
    }
    res.json({ success: true });
  });
});

// ユーザーリスト取得API (DM用)
app.get("/users", isAuthenticated, (req, res) => {
    const users = readJsonFile(USERS_FILE, []);
    const currentUserId = req.session.userId;

    // ログイン中のユーザー（自分自身）を除くリストを返す
    // ゲストユーザーは登録ユーザーリストには含まれないため、このフィルタリングは登録ユーザーのみに適用
    const availableUsers = users.filter(user => user.id !== currentUserId);
    
    // 実際にオンラインのユーザー情報も付加する（socket.ioのソケット情報から）
    const connectedUsers = getAllConnectedUsers();
    const finalUserList = availableUsers.map(user => {
        const isOnline = connectedUsers.some(cu => cu.userId === user.id);
        return {
            id: user.id,
            username: user.username,
            online: isOnline // オンライン状態を追加
        };
    });

    res.json({ success: true, users: finalUserList });
});


// メッセージ送信API
app.post("/send-message", isAuthenticated, (req, res) => {
  const { message, room, dmTargetUser, dmTargetUserId } = req.body;
  const senderUserId = req.session.userId;
  const senderUsername = req.session.username;

  if (!message.trim()) {
    return res.status(400).json({ success: false, message: "メッセージは空にできません。" });
  }
  if (!senderUsername || !senderUserId) {
    return res.status(401).json({ success: false, message: "ユーザー情報が取得できません。再ログインしてください。" });
  }

  const messageData = {
    user: senderUsername,
    text: message,
    timestamp: new Date().toISOString(),
    pinned: false,
    userId: senderUserId // 送信者のIDを追加
  };

  if (dmTargetUser && dmTargetUserId) {
    // DMの場合
    messageData.dm = true;
    messageData.dmTargetUser = dmTargetUser;
    messageData.dmTargetUserId = dmTargetUserId;
    messageData.room = null; // DMなのでroomはnull

    saveMessage(messageData); // DMも保存

    // 送信者と受信者両方にDMを送信
    io.to(senderUserId).emit("message", messageData); // 送信者自身
    if (senderUserId !== dmTargetUserId) { // 自分自身へのDMでなければ
      io.to(dmTargetUserId).emit("message", messageData); // 受信者
    }
    console.log(`DM sent from ${senderUsername} (${senderUserId}) to ${dmTargetUser} (${dmTargetUserId})`);
  } else {
    // 通常のチャットの場合
    if (!room) {
        return res.status(400).json({ success: false, message: "ルーム情報が必要です。" });
    }
    messageData.room = room;
    saveMessage(messageData);
    io.to(room).emit("message", messageData);
    console.log(`Message sent to room ${room} from ${senderUsername}: ${message}`);
  }

  res.json({ success: true });
});

// ファイルアップロードAPI
app.post("/upload", isAuthenticated, (req, res) => {
  try {
    if (!req.files || Object.keys(req.files).length === 0) {
      return res.status(400).json({ error: "No files were uploaded!" });
    }

    const file = req.files.file;
    const uniqueFileName = `${Date.now()}-${file.name}`; // ファイル名重複対策
    const filePath = `${UPLOAD_DIR}/${uniqueFileName}`;
    const room = req.body.room; // 公開チャットの場合
    const dmTargetUser = req.body.dmTargetUser;
    const dmTargetUserId = req.body.dmTargetUserId;

    const senderUserId = req.session.userId;
    const senderUsername = req.session.username;

    if (!senderUsername || !senderUserId) {
        return res.status(401).json({ success: false, message: "ユーザー情報が取得できません。再ログインしてください。" });
    }

    file.mv(filePath, (err) => {
      if (err) {
        console.error("File upload error:", err);
        return res.status(500).json({ error: err.message });
      }

      const fileUrl = `/uploads/${uniqueFileName}`; // ユニークなファイル名を使用
      const fileMessage = {
        user: senderUsername,
        file: fileUrl,
        timestamp: new Date().toISOString(),
        pinned: false,
        userId: senderUserId // 送信者のIDを追加
      };

      if (dmTargetUser && dmTargetUserId) {
        // DMの場合
        fileMessage.dm = true;
        fileMessage.dmTargetUser = dmTargetUser;
        fileMessage.dmTargetUserId = dmTargetUserId;
        fileMessage.room = null; // DMなのでroomはnull

        saveMessage(fileMessage);

        io.to(senderUserId).emit("message", fileMessage);
        if (senderUserId !== dmTargetUserId) {
          io.to(dmTargetUserId).emit("message", fileMessage);
        }
        console.log(`DM file sent from ${senderUsername} (${senderUserId}) to ${dmTargetUser} (${dmTargetUserId})`);
      } else {
        // 通常のチャットの場合
        if (!room) {
            return res.status(400).json({ success: false, message: "ルーム情報が必要です。" });
        }
        fileMessage.room = room;
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

  // セッション情報をソケットに紐付ける
  const session = socket.request.session;
  socket.username = session.username;
  socket.userId = session.userId; // ログインユーザーまたはゲストのuserId

  // 接続時に自身のuserIdをルームとして参加させる（DM受信のため）
  if (socket.userId) {
    socket.join(socket.userId);
    console.log(`${socket.username} (${socket.userId}) joined private room: ${socket.userId}`);
  }

  // ユーザーリストを更新して全員に送信
  updateUserList();

  socket.on("joinRoom", (room, roomType, dmTargetUserId = null) => {
    // 以前参加していたルームから離脱
    if (socket.currentRoom) {
      socket.leave(socket.currentRoom);
      console.log(`${socket.username} (${socket.userId}) left room ${socket.currentRoom}`);
    }

    let messages = readJsonFile(MESSAGE_FILE);
    let relevantMessages = [];

    if (roomType === 'public') {
      socket.join(room); // 公開チャットルームへの参加
      socket.currentRoom = room;
      socket.currentRoomType = roomType;

      relevantMessages = messages.filter(m => m.room === room && !m.dm); // 公開メッセージのみ

      console.log(`${socket.username} (${socket.userId}) joined public room: ${room}`);

    } else if (roomType === 'dm' && dmTargetUserId) {
      // DMの場合、送信者と受信者の両方のIDをルーム名として利用
      // 小さいID_大きいID の形式で一貫したルーム名を生成
      const dmRoomName = [socket.userId, dmTargetUserId].sort().join('_');
      socket.join(dmRoomName);
      socket.currentRoom = dmRoomName;
      socket.currentRoomType = roomType;
      socket.currentDmTargetId = dmTargetUserId; // DM相手のIDをソケットに保存

      relevantMessages = messages.filter(m =>
        m.dm &&
        ((m.userId === socket.userId && m.dmTargetUserId === dmTargetUserId) ||
         (m.userId === dmTargetUserId && m.dmTargetUserId === socket.userId))
      );

      console.log(`${socket.username} (${socket.userId}) joined DM room with ${dmTargetUserId}: ${dmRoomName}`);
    } else {
        console.warn("Invalid joinRoom request:", room, roomType, dmTargetUserId);
        return;
    }

    socket.emit("messageHistory", relevantMessages);

    const pinned = readJsonFile(PINNED_FILE, {});
    // DMルームにはピン留めメッセージがない前提
    if (roomType === 'public' && pinned[room]) {
      socket.emit("updatePinnedMessage", { message: pinned[room] });
    } else {
      socket.emit("updatePinnedMessage", { message: null }); // DMではピン留めなし
    }
  });


  socket.on("pinMessage", (data) => {
    if (socket.currentRoomType !== 'public') {
        console.log("DMではピン留めできません。");
        return;
    }
    savePinnedMessage(data.room, data.message);
    io.to(data.room).emit("updatePinnedMessage", { message: data.message });
    console.log(`Message pinned in room ${data.room}`);
  });

  socket.on("unpinMessage", (room) => {
    if (socket.currentRoomType !== 'public') {
        console.log("DMではピン留め解除できません。");
        return;
    }
    savePinnedMessage(room, null); // nullを保存することで解除
    io.to(room).emit("updatePinnedMessage", { message: null });
    console.log(`Message unpinned in room ${room}`);
  });

  socket.on("disconnect", () => {
    console.log("ユーザーが切断しました:", socket.id, "Username:", socket.username, "UserId:", socket.userId);
    // ユーザーリストを更新
    updateUserList();
  });
});

// 接続中の全ユーザーリストを返す関数
function getAllConnectedUsers() {
    const connectedUsers = [];
    const uniqueUserIds = new Set(); // 重複を防ぐためのSet

    io.of("/").sockets.forEach(socket => {
        if (socket.username && socket.userId && !uniqueUserIds.has(socket.userId)) {
            connectedUsers.push({
                username: socket.username,
                userId: socket.userId
            });
            uniqueUserIds.add(socket.userId);
        }
    });
    return connectedUsers;
}

// ユーザーリストを更新して全クライアントに送信する関数
function updateUserList() {
  const usersOnline = getAllConnectedUsers();
  io.emit("updateUserList", usersOnline);
  console.log("Updated online user list:", usersOnline.map(u => `${u.username}(${u.userId ? u.userId.substring(0,4) : 'N/A'})`).join(", "));
}


const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
