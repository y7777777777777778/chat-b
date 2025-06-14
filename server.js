const fs = require("fs");
const path = require("path");
const express = require("express");
const fileUpload = require("express-fileupload");
const { Server } = require("socket.io");
const sqlite3 = require("sqlite3").verbose();
const bcrypt = require("bcrypt");
const session = require("express-session");
const Knex = require("knex");
const KnexSessionStore = require("connect-session-knex")(session);

const app = express();
const server = require("http").createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static("public"));
app.use(fileUpload());

const MESSAGE_FILE = "messages.json";
const PINNED_FILE = "pinnedMessages.json";
const UPLOAD_DIR = "public/uploads";

if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// **SQLiteデータベースの初期化**
const db = new sqlite3.Database("./chat.db", (err) => {
    if (err) {
        console.error("Database connection error:", err.message);
    } else {
        console.log("Connected to the SQLite database.");
        db.run(`CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL
        )`, (err) => {
            if (err) {
                console.error("Error creating users table:", err.message);
            } else {
                console.log("Users table ensured.");
            }
        });
    }
});

// Knexの設定
const knex = Knex({
    client: "sqlite3",
    connection: {
        filename: "./chat.db",
    },
    useNullAsDefault: true,
});

// セッションストアの設定
const sessionStore = new KnexSessionStore({
    tablename: "sessions",
    sidfieldname: "sid",
    knex: knex,
    createtable: true,
});

// **セッションミドルウェアの設定**
// これをインスタンス化して、ExpressとSocket.IOの両方で共有する
const sessionMiddleware = session({
    secret: process.env.SESSION_SECRET || "your_super_secret_key_here_please_change_me",
    resave: false,
    saveUninitialized: false,
    store: sessionStore,
    cookie: {
        maxAge: 1000 * 60 * 60 * 24,
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production'
    }
});
app.use(sessionMiddleware); // Expressアプリケーションにセッションミドルウェアを適用

// 認証チェックミドルウェア
function isAuthenticated(req, res, next) {
    // 認証なしでアクセスを許可するパスのリスト
    const publicPaths = [
        '/', // ルートパス (index.htmlへリダイレクト)
        '/index.html', // ログインページ
        '/register.html', // 新規登録ページ
        '/login',      // ログインAPI
        '/register',   // 登録API
        '/check-auth'  // 認証状態チェックAPI
    ];

    // 静的ファイルとして提供されるpublic/uploads内のファイルも認証なしでアクセス許可
    if (req.path.startsWith('/uploads/')) {
        return next();
    }
    
    // publicPathsにあるか、かつそれがGETリクエストの場合、認証なしで許可
    // chat.htmlもここに追加して、静的ファイル自体は誰でもアクセスできるようにする
    // ただし、チャットの機能（メッセージ送信など）は認証が必要
    if ((publicPaths.includes(req.path) || req.path === '/chat.html') && req.method === 'GET') {
        return next();
    }

    // それ以外のリクエスト（POST /send-message, POST /upload など）でセッション認証をチェック
    if (req.session.isAuthenticated && req.session.userId) {
        next(); // 認証済みであれば続行
    } else {
        // 未認証の場合、ログインページへリダイレクト
        console.log(`Access denied for ${req.path}. Redirecting to /index.html`);
        // HTTPリクエストの場合はリダイレクト
        if (req.headers['x-requested-with'] === 'XMLHttpRequest' || req.headers.accept && req.headers.accept.includes('application/json')) {
            // AJAXリクエストの場合はJSONでエラーを返す
            res.status(401).json({ success: false, message: "認証が必要です。" });
        } else {
            res.redirect('/index.html');
        }
    }
}
app.use(isAuthenticated); // 全てのリクエストに認証チェックを適用

// メッセージを保存
function saveMessage(data) {
    let messages = fs.existsSync(MESSAGE_FILE) ? JSON.parse(fs.readFileSync(MESSAGE_FILE, "utf-8")) : [];
    messages.push(data);
    fs.writeFileSync(MESSAGE_FILE, JSON.stringify(messages, null, 2));
}

// ピン止めメッセージを保存
function savePinnedMessage(room, message) {
    let pinned = fs.existsSync(PINNED_FILE) ? JSON.parse(fs.readFileSync(PINNED_FILE, "utf-8")) : {};
    pinned[room] = message;
    fs.writeFileSync(PINNED_FILE, JSON.stringify(pinned, null, 2));
}

// **ルートアクセス時に `index.html` を提供**
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ユーザー登録エンドポイント
app.post("/register", async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ success: false, message: "ユーザー名とパスワードは必須です。" });
    }

    try {
        const hashedPassword = await bcrypt.hash(password, 10);

        db.run("INSERT INTO users (username, password) VALUES (?, ?)", [username, hashedPassword], function(err) {
            if (err) {
                if (err.message.includes("UNIQUE constraint failed: users.username")) {
                    return res.status(409).json({ success: false, message: "このユーザー名は既に存在します。" });
                }
                console.error("Registration error:", err.message);
                return res.status(500).json({ success: false, message: "登録中にエラーが発生しました。" });
            }
            res.json({ success: true, message: "登録が完了しました。" });
        });
    } catch (error) {
        console.error("Hashing error:", error);
        res.status(500).json({ success: false, message: "サーバーエラーが発生しました。" });
    }
});

// ユーザーログインエンドポイント
app.post("/login", (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ success: false, message: "ユーザー名とパスワードは必須です。" });
    }

    db.get("SELECT * FROM users WHERE username = ?", [username], async (err, user) => {
        if (err) {
            console.error("Login error (DB query):", err.message);
            return res.status(500).json({ success: false, message: "サーバーエラーが発生しました。" });
        }
        if (!user) {
            return res.status(401).json({ success: false, message: "ユーザー名またはパスワードが違います。" });
        }

        const isMatch = await bcrypt.compare(password, user.password);
        if (isMatch) {
            req.session.userId = user.id;
            req.session.username = user.username;
            req.session.isAuthenticated = true;
            res.json({ success: true, message: "ログイン成功！", username: user.username });
        } else {
            res.status(401).json({ success: false, message: "ユーザー名またはパスワードが違います。" });
        }
    });
});

// ログアウトエンドポイント
app.post("/logout", (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            console.error("Logout error:", err);
            return res.status(500).json({ success: false, message: "ログアウト中にエラーが発生しました。" });
        }
        res.json({ success: true, message: "ログアウトしました。" });
    });
});

// 現在の認証状態とユーザー名を取得するエンドポイント
app.get("/check-auth", (req, res) => {
    if (req.session.isAuthenticated && req.session.username) {
        res.json({ authenticated: true, username: req.session.username });
    } else {
        res.json({ authenticated: false });
    }
});

// メッセージ送信のAPIエンドポイント
app.post("/send-message", (req, res) => {
    const { message, room } = req.body;
    const username = req.session.username;

    if (!username) { // ここでもセッションからのユーザー名取得を確認
        return res.status(401).json({ error: "認証されていません。" });
    }
    if (!message.trim()) {
        return res.status(400).json({ error: "メッセージは空にできません。" });
    }

    const chatMessage = { user: username, text: message, room, timestamp: new Date().toISOString() };
    saveMessage(chatMessage);
    io.to(room).emit("message", chatMessage);
    res.json({ success: true });
});

// メッセージ履歴の取得APIエンドポイント
app.get("/messages", (req, res) => {
    const room = req.query.room;
    if (!room) {
        return res.status(400).json({ error: "roomパラメータが必要です。" });
    }
    // このエンドポイントは認証ミドルウェアで保護されているため、req.session.usernameは利用可能
    if (!req.session.username) { //念の為の認証チェック
        return res.status(401).json({ error: "認証されていません。" });
    }

    const messages = fs.existsSync(MESSAGE_FILE) ? JSON.parse(fs.readFileSync(MESSAGE_FILE, "utf-8")) : [];
    res.json(messages.filter(m => m.room === room));
});

// ファイルアップロードのAPIエンドポイント
app.post("/upload", (req, res) => {
    const username = req.session.username;
    const room = req.body.room;

    if (!username) { // ここでもセッションからのユーザー名取得を確認
        return res.status(401).json({ error: "認証されていません。" });
    }

    if (!req.files || Object.keys(req.files).length === 0) {
        return res.status(400).json({ error: "No files were uploaded!" });
    }

    const file = req.files.file;
    const filePath = `${UPLOAD_DIR}/${file.name}`;

    file.mv(filePath, (err) => {
        if (err) {
            console.error("File upload error:", err);
            return res.status(500).json({ error: err.message });
        }

        const fileUrl = `/uploads/${file.name}`;
        const fileMessage = { user: username, file: fileUrl, room: room, timestamp: new Date().toISOString(), pinned: false };
        saveMessage(fileMessage);
        io.to(room).emit("message", fileMessage);

        res.json({ success: true, fileUrl });
    });
});

// **Socket.IOの認証ミドルウェア**
// ここで上記で作成した sessionMiddleware インスタンスをSocket.IOに適用
io.use((socket, next) => {
    sessionMiddleware(socket.request, {}, next);
});

// Socket.IOの処理
io.on("connection", (socket) => {
    console.log("A user connected via Socket.IO");

    const session = socket.request.session;
    if (session && session.isAuthenticated && session.username) {
        socket.username = session.username;
        console.log(`Socket connected for user: ${socket.username}`);
    } else {
        console.warn("Unauthenticated Socket.IO connection attempt. Disconnecting.");
        socket.emit("redirect", "/index.html");
        socket.disconnect(true);
        return;
    }

    socket.on("joinRoom", (data) => {
        const { room } = data; // クライアントからroomのみ受け取る（usernameはセッションから取得済み）
        
        if (!socket.username) { // Socket.IO接続時に認証されていない場合
             console.warn("User tried to join room without authentication via Socket.");
             socket.emit("redirect", "/index.html");
             socket.disconnect(true);
             return;
        }

        socket.join(room);
        socket.currentRoom = room;

        console.log(`${socket.username} joined room: ${room}`);

        const messages = fs.existsSync(MESSAGE_FILE) ? JSON.parse(fs.readFileSync(MESSAGE_FILE, "utf-8")) : [];
        socket.emit("messageHistory", messages.filter(m => m.room === room));

        const pinned = fs.existsSync(PINNED_FILE) ? JSON.parse(fs.readFileSync(PINNED_FILE, "utf-8")) : {};
        if (pinned[room]) socket.emit("updatePinnedMessage", { message: pinned[room] });
    });

    socket.on("leaveRoom", (room) => {
        if (socket.currentRoom && socket.currentRoom === room) {
            socket.leave(room);
            console.log(`${socket.username || 'Unknown user'} left room: ${room}`);
            socket.currentRoom = null;
        }
    });

    socket.on("pinMessage", (data) => {
        const { message, room } = data;
        if (!socket.username) {
            console.warn("Unauthenticated user tried to pin message via Socket.");
            return;
        }
        savePinnedMessage(room, message);
        io.to(room).emit("updatePinnedMessage", { message });
    });

    socket.on("unpinMessage", (room) => {
        if (!socket.username) {
            console.warn("Unauthenticated user tried to unpin message via Socket.");
            return;
        }
        savePinnedMessage(room, null);
        io.to(room).emit("updatePinnedMessage", { message: null });
    });

    socket.on("disconnect", () => {
        console.log("A user disconnected.");
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
