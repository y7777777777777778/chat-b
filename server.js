
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

// **SQLiteデータベースの初期化とテーブル作成**
const dbPath = "./chat.db";
const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
    if (err) {
        console.error("Database connection error:", err.message);
        // データベース接続失敗は致命的エラーとしてアプリケーションを終了
        process.exit(1);
    } else {
        console.log("Connected to the SQLite database.");
        // usersテーブルの作成（存在しない場合のみ）
        db.run(`CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL
        )`, (err) => {
            if (err) {
                console.error("Error creating users table:", err.message);
                // テーブル作成失敗も致命的エラーとしてアプリケーションを終了
                process.exit(1);
            } else {
                console.log("Users table ensured.");
            }
        });
    }
});

// Knexの設定 (セッションストア用)
const knex = Knex({
    client: "sqlite3",
    connection: {
        filename: dbPath,
    },
    useNullAsDefault: true,
});

// セッションストアの設定
const sessionStore = new KnexSessionStore({
    tablename: "sessions",
    sidfieldname: "sid",
    knex: knex,
    createtable: true, // セッションテーブルが存在しない場合は自動作成
    clearInterval: 1000 * 60 * 60 // 1時間ごとに期限切れセッションをクリーンアップ
});

// **セッションミドルウェアの設定**
const sessionMiddleware = session({
    secret: process.env.SESSION_SECRET || "your_super_secret_key_here_please_change_me_and_make_it_long_and_random",
    resave: false,
    saveUninitialized: false,
    store: sessionStore,
    cookie: {
        maxAge: 1000 * 60 * 60 * 24, // 1日セッションを保持
        httpOnly: true, // クライアント側のJavaScriptからCookieにアクセスできないようにする
        secure: process.env.NODE_ENV === 'production', // 本番環境（Render）ではHTTPSなのでtrue
        sameSite: 'Lax' // CSRF対策
    }
});
app.use(sessionMiddleware); // Expressアプリケーションにセッションミドルウェアを適用

// **認証チェックミドルウェア**
function isAuthenticated(req, res, next) {
    // 常に認証なしでアクセスを許可するパス（ログイン/登録のPOSTリクエストを含む）
    const alwaysPublicPaths = [
        '/login',
        '/register'
    ];

    // GETリクエストでのみ認証なしでアクセスを許可するパス（HTMLファイル、認証状態チェック）
    const publicGetPaths = [
        '/', // ルートパス (index.htmlへ)
        '/index.html',
        '/register.html',
        '/chat.html', // chat.html自体へのアクセスは許可
        '/check-auth' // 認証状態チェックAPI
    ];

    // ログインと登録のPOSTリクエストは認証不要
    if (alwaysPublicPaths.includes(req.path) && req.method === 'POST') {
        return next();
    }

    // 公開されているHTMLファイルや認証チェックのGETリクエストは認証不要
    if (publicGetPaths.includes(req.path) && req.method === 'GET') {
        return next();
    }

    // アップロードされた静的ファイルも認証不要
    if (req.path.startsWith('/uploads/')) {
        return next();
    }

    // 上記以外の全てのリクエストは認証が必要
    if (req.session.isAuthenticated && req.session.userId) {
        next();
    } else {
        console.log(`Access denied for ${req.method} ${req.path}. Redirecting to /index.html`);
        // AJAXリクエストかどうかに応じてレスポンスを分岐
        if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
            res.status(401).json({ success: false, message: "認証が必要です。" });
        } else {
            // 通常のブラウザリクエストの場合はリダイレクト (リダイレクトフラグ付き)
            res.redirect('/index.html?redirected=true');
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

// ルートアクセス時に `index.html` を提供
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
                console.error("Registration DB error:", err.message);
                return res.status(500).json({ success: false, message: "登録中にエラーが発生しました。" });
            }
            res.json({ success: true, message: "登録が完了しました。" });
        });
    } catch (error) {
        console.error("Hashing or Registration general error:", error);
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
            console.error("Login DB query error:", err.message);
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

            // セッションを明示的に保存し、保存完了後にレスポンスを返す
            req.session.save((err) => {
                if (err) {
                    console.error("Session save error after login:", err);
                    return res.status(500).json({ success: false, message: "ログイン中にセッション保存エラーが発生しました。" });
                }
                res.json({ success: true, message: "ログイン成功！", username: user.username });
            });
        } else {
            res.status(401).json({ success: false, message: "ユーザー名またはパスワードが違います。" });
        }
    });
});

// ログアウトエンドポイント
app.post("/logout", (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            console.error("Logout session destroy error:", err);
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

    if (!username) {
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
    if (!req.session.username) {
        return res.status(401).json({ error: "認証されていません。" });
    }

    const messages = fs.existsSync(MESSAGE_FILE) ? JSON.parse(fs.readFileSync(MESSAGE_FILE, "utf-8")) : [];
    res.json(messages.filter(m => m.room === room));
});

// ファイルアップロードのAPIエンドポイント
app.post("/upload", (req, res) => {
    const username = req.session.username;
    const room = req.body.room;

    if (!username) {
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

// Socket.IOの認証ミドルウェア
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
        const { room } = data;
        
        if (!socket.username) {
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
