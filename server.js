const fs = require("fs");
const path = require("path");
const express = require("express");
const fileUpload = require("express-fileupload");
const { Server } = require("socket.io");
const sqlite3 = require("sqlite3").verbose(); // SQLite3をインポート
const bcrypt = require("bcrypt"); // パスワードハッシュ化をインポート
const session = require("express-session"); // セッション管理をインポート
const Knex = require("knex"); // SQLクエリビルダをインポート
const KnexSessionStore = require("connect-session-knex")(session); // セッションストアをインポート

const app = express();
const server = require("http").createServer(app);
const io = new Server(server);

app.use(express.json()); // JSONボディをパース
app.use(express.static("public")); // publicフォルダを静的ファイルとして提供
app.use(fileUpload()); // ファイルアップロードミドルウェア

const MESSAGE_FILE = "messages.json";
const PINNED_FILE = "pinnedMessages.json";
const UPLOAD_DIR = "public/uploads";

// アップロードフォルダが存在しない場合、作成
if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// **SQLiteデータベースの初期化**
const db = new sqlite3.Database("./chat.db", (err) => {
    if (err) {
        console.error("Database connection error:", err.message);
    } else {
        console.log("Connected to the SQLite database.");
        // usersテーブルの作成（存在しない場合）
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
    tablename: "sessions", // セッションを保存するテーブル名
    sidfieldname: "sid", // セッションIDを保存するカラム名
    knex: knex,
    createtable: true, // テーブルが存在しない場合は作成
});

// セッションミドルウェアの設定
app.use(session({
    secret: process.env.SESSION_SECRET || "your_super_secret_key_here_please_change_me", // 秘密鍵。本番環境では環境変数から読み込むことを強く推奨
    resave: false, // セッションが変更されなくてもセッションストアに保存し直すか
    saveUninitialized: false, // 初期化されていない（変更されていない）セッションを保存するか
    store: sessionStore, // カスタムセッションストアを使用
    cookie: {
        maxAge: 1000 * 60 * 60 * 24, // 1日セッションを保持
        httpOnly: true, // クライアント側のJavaScriptからCookieにアクセスできないようにする
        secure: process.env.NODE_ENV === 'production' // HTTPSでのみCookieを送信（本番環境ではtrueにすべき）
    }
}));

// 認証チェックミドルウェア
// `isAuthenticated`関数がtrueを返した場合のみ、次のミドルウェアまたはルートハンドラに進む
function isAuthenticated(req, res, next) {
    // entry.html, index.html, register.html, 認証API自体は認証なしでアクセスを許可
    const publicPaths = ['/entry.html', '/index.html', '/register.html', '/login', '/register', '/check-auth'];
    if (publicPaths.includes(req.path) || req.path.startsWith('/uploads/')) {
        return next();
    }

    if (req.session.isAuthenticated && req.session.userId) {
        next(); // 認証済みであれば続行
    } else {
        // 未認証の場合、ログインページへリダイレクト
        res.redirect('/index.html');
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

// ルートアクセス時に `entry.html` を提供
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "entry.html"));
});

// ユーザー登録エンドポイント
app.post("/register", async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ success: false, message: "ユーザー名とパスワードは必須です。" });
    }

    try {
        const hashedPassword = await bcrypt.hash(password, 10); // パスワードをハッシュ化（ソルトラウンド10）

        db.run("INSERT INTO users (username, password) VALUES (?, ?)", [username, hashedPassword], function(err) {
            if (err) {
                // UNIQUE制約違反の場合（ユーザー名重複）
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

        const isMatch = await bcrypt.compare(password, user.password); // パスワードの比較
        if (isMatch) {
            // ログイン成功: セッションにユーザー情報を保存
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
    req.session.destroy((err) => { // セッションを破棄
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
    // isAuthenticatedミドルウェアで認証済みであることを前提
    const { message, room } = req.body;
    const username = req.session.username; // セッションからユーザー名を取得

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
    // isAuthenticatedミドルウェアで認証済みであることを前提
    const room = req.query.room;
    if (!room) {
        return res.status(400).json({ error: "roomパラメータが必要です。" });
    }

    const messages = fs.existsSync(MESSAGE_FILE) ? JSON.parse(fs.readFileSync(MESSAGE_FILE, "utf-8")) : [];
    res.json(messages.filter(m => m.room === room));
});

// ファイルアップロードのAPIエンドポイント
app.post("/upload", (req, res) => {
    // isAuthenticatedミドルウェアで認証済みであることを前提
    const username = req.session.username; // セッションからユーザー名を取得
    const room = req.body.room;

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

// Socket.IOの処理
io.on("connection", (socket) => {
    console.log("A user connected via Socket.IO");

    // Socket.IO接続時にHTTPセッション情報を利用するための設定（オプション）
    // 通常はHTTPリクエストで認証を完了し、そのセッション情報を利用する
    // あるいはSocket.IO独自の認証フローを構築する

    socket.on("joinRoom", (data) => {
        const { room, username } = data; // クライアントからユーザー名を渡してもらう
        
        // サーバー側のセッションから取得したユーザー名と、クライアントから渡されたユーザー名が一致するか確認する
        // より堅牢な実装では、Socket.IO接続時にもセッションIDを渡し、サーバー側でセッションを復元して認証状態を確認するべきです。
        // ここでは簡易的に、クライアントから正しいユーザー名が渡されたと仮定し、サーバー側のセッションがない場合はリダイレクトする。
        // `isAuthenticated`ミドルウェアがHTTPリクエストを処理するため、Socket.IO接続時は既に`/chat.html`にアクセスできているはず
        // そのため、ここでは基本的なルーム参加処理に集中します。

        // 未認証で直接Socket.IO接続しようとした場合などのFallback
        if (!username) {
             socket.emit("redirect", "/index.html"); // 未認証ならログインページへリダイレクト
             return;
        }

        socket.join(room);
        socket.username = username; // Socketオブジェクトにユーザー名を一時的に保存
        socket.currentRoom = room; // 現在のルームも保存

        console.log(`${username} joined room: ${room}`);

        const messages = fs.existsSync(MESSAGE_FILE) ? JSON.parse(fs.readFileSync(MESSAGE_FILE, "utf-8")) : [];
        socket.emit("messageHistory", messages.filter(m => m.room === room));

        const pinned = fs.existsSync(PINNED_FILE) ? JSON.parse(fs.readFileSync(PINNED_FILE, "utf-8")) : {};
        if (pinned[room]) socket.emit("updatePinnedMessage", { message: pinned[room] });
    });

    // ルームから離脱するイベントハンドラー
    socket.on("leaveRoom", (room) => {
        if (socket.currentRoom && socket.currentRoom === room) {
            socket.leave(room);
            console.log(`${socket.username || 'Unknown user'} left room: ${room}`);
            socket.currentRoom = null; // 現在のルームをリセット
        }
    });

    socket.on("pinMessage", (data) => {
        const { message, room } = data;
        // 認証されたユーザーのみピン留めできるようにする (Socket.IO接続時にユーザー名が設定されていることを前提)
        if (!socket.username) {
            console.warn("Unauthenticated user tried to pin message.");
            return;
        }
        savePinnedMessage(room, message);
        io.to(room).emit("updatePinnedMessage", { message });
    });

    socket.on("unpinMessage", (room) => {
        // 認証されたユーザーのみピン留め解除できるようにする
        if (!socket.username) {
            console.warn("Unauthenticated user tried to unpin message.");
            return;
        }
        savePinnedMessage(room, null); // nullを保存してピン留めを解除
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
