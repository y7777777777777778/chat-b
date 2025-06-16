// server.js の最終版コード

// 必要なモジュールのインポート
const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const mongoose = require("mongoose");
const path = require("path");
const session = require("express-session");
const MongoStore = require("connect-mongo");
const { v4: uuidv4 } = require('uuid');

// 環境変数の設定 (Renderで設定したものを使用)
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const SESSION_SECRET = process.env.SESSION_SECRET;

// 環境変数が設定されているか確認 (開発時に役立つ)
if (!MONGODB_URI) {
    console.error("エラー: MONGODB_URI 環境変数が設定されていません。MongoDBに接続できません。");
    process.exit(1); // 本番環境では起動を停止
}
if (!SESSION_SECRET) {
    console.warn("警告: SESSION_SECRET 環境変数が設定されていません。デフォルトのシークレットを使用します。");
    console.warn("本番環境ではセキュアなSESSION_SECRETを設定してください。");
    // 本番環境では process.exit(1); を追加することも検討
}

// Expressアプリケーションの初期化
const app = express();
const server = http.createServer(app);

// Renderのようなプロキシ/ロードバランサーの背後で動作する場合に必要
// これにより、secure: true のCookieが正しく機能するようになります。
app.set('trust proxy', 1);

// Socket.IOの初期化
// corsオプションは、クライアントが異なるオリジンから接続する場合に必要
const io = socketIo(server, {
    cors: {
        origin: "*", // 許可するオリジンを本番環境では具体的に指定することを推奨 (例: "https://your-frontend-domain.com")
        methods: ["GET", "POST"],
        credentials: true, // セッションCookieの送信を許可するためにtrueに設定
    },
});

// MongoDBへの接続
mongoose.connect(MONGODB_URI)
    .then(() => console.log("MongoDBに接続しました！"))
    .catch((err) => console.error("MongoDB接続エラー:", err));

// Mongooseスキーマとモデルの定義
const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true }, // 本番環境ではパスワードのハッシュ化が必須
    isOnline: { type: Boolean, default: false },
    lastSeen: { type: Date, default: Date.now },
    isGuest: { type: Boolean, default: false }
});
const User = mongoose.model('User', userSchema);

const messageSchema = new mongoose.Schema({
    sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    content: { type: String, required: true },
    timestamp: { type: Date, default: Date.now },
    room: { type: String, default: 'general' } // ★追加: ルームIDフィールド
});
const Message = mongoose.model('Message', messageSchema);

// セッション設定 (重要: Renderでは secure: true と sameSite: 'None' が推奨)
const sessionMiddleware = session({
    secret: SESSION_SECRET || "super-secret-fallback-key-for-dev", // 環境変数が設定されていなければフォールバック
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({
        mongoUrl: MONGODB_URI,
        ttl: 1000 * 60 * 60 * 24 * 7, // セッションの有効期限 (7日間)
        autoRemove: 'interval',
        autoRemoveInterval: 10
    }),
    cookie: {
        secure: true, // RenderはHTTPSなので必ずtrueに設定
        maxAge: 1000 * 60 * 60 * 24 * 7, // 7日間
        httpOnly: true,
        sameSite: 'None', // クロスサイトCookieを許可するために'None'に設定 (Render環境で必要)
    },
});

// Expressミドルウェア
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(sessionMiddleware);

// =========================================================
// APIルートの定義 - 静的ファイルの提供よりも前に配置すること！
// =========================================================

// 認証チェックルート
app.get("/check-auth", async (req, res) => {
    console.log("認証チェック:", req.session.userId ? `ユーザーID: ${req.session.userId}` : "ユーザー認証されていません");

    // 既存のユーザーセッションもゲストセッションもない場合
    if (!req.session.userId && !req.session.guestId) {
        // 新しいゲストセッションを生成
        const guestId = `guest-${uuidv4()}`;
        const guestUsername = `ゲスト-${Math.floor(Math.random() * 9000) + 1000}`;
        
        try {
            const guestUser = new User({
                username: guestUsername,
                password: 'guest-password',
                isGuest: true,
                isOnline: false // ここはfalseのまま
            });
            await guestUser.save();
            req.session.guestId = guestUser._id;
            req.session.username = guestUsername;
            console.log(`新規ゲストセッションを生成します。ユーザー名: ${guestUsername} (ID: ${guestUser._id})`);
            return res.status(200).json({
                isAuthenticated: true,
                isGuest: true,
                username: guestUsername,
                userId: guestUser._id,
                message: "ゲストとして認証されました。"
            });
        } catch (error) {
            console.error("ゲストユーザー生成エラー:", error);
            return res.status(500).json({ isAuthenticated: false, message: "ゲストユーザー生成に失敗しました。" });
        }
    } else if (req.session.userId) {
        // 既存の登録ユーザーセッション
        try {
            const user = await User.findById(req.session.userId);
            if (user) {
                // user.isOnline = true; // Socket.IO接続時に更新
                // await user.save();
                console.log(`認証チェック: 登録ユーザー ${user.username} (ID: ${user._id}) です。`);
                return res.status(200).json({ isAuthenticated: true, isGuest: false, username: user.username, userId: user._id });
            } else {
                req.session.destroy(() => {
                    console.log("認証チェック: セッションのユーザーが見つかりません。");
                    res.status(401).json({ isAuthenticated: false, message: "ユーザーが見つかりません。再認証してください。" });
                });
            }
        } catch (error) {
            console.error("認証チェックエラー:", error);
            res.status(500).json({ isAuthenticated: false, message: "サーバーエラーで認証チェックに失敗しました。" });
        }
    } else if (req.session.guestId) {
        // 既存のゲストセッション
        try {
            const guestUser = await User.findById(req.session.guestId);
            if (guestUser && guestUser.isGuest) {
                // guestUser.isOnline = true; // Socket.IO接続時に更新
                // await guestUser.save();
                console.log(`認証チェック: ゲストユーザー ${guestUser.username} (ID: ${guestUser._id}) です。`);
                return res.status(200).json({ isAuthenticated: true, isGuest: true, username: guestUser.username, userId: guestUser._id });
            } else {
                 req.session.destroy(() => {
                    console.log("認証チェック: ゲストセッションのユーザーが見つかりません。");
                    res.status(401).json({ isAuthenticated: false, message: "ゲストユーザーが見つかりません。再認証してください。" });
                });
            }
        } catch (error) {
            console.error("ゲスト認証チェックエラー:", error);
            res.status(500).json({ isAuthenticated: false, message: "サーバーエラーでゲスト認証チェックに失敗しました。" });
        }
    } else {
        console.log("認証チェック: ユーザーは認証されていません (ゲスト要求なし)。");
        res.status(401).json({ isAuthenticated: false, message: "認証されていません。ログインしてください。" });
    }
});

// ログインルート (例)
app.post("/login", async (req, res) => {
    const { username, password } = req.body;
    try {
        const user = await User.findOne({ username });
        if (!user || user.password !== password) {
            return res.status(401).json({ message: "ユーザー名またはパスワードが間違っています。" });
        }
        req.session.userId = user._id;
        req.session.username = user.username;
        // user.isOnline = true; // Socket.IO接続時に更新
        // await user.save();
        res.status(200).json({ message: "ログイン成功！", username: user.username, userId: user._id });
    } catch (error) {
        console.error("ログインエラー:", error);
        res.status(500).json({ message: "ログイン中にエラーが発生しました。" });
    }
});

// 登録ルート (例)
app.post("/register", async (req, res) => {
    const { username, password } = req.body;
    try {
        const existingUser = await User.findOne({ username });
        if (existingUser) {
            return res.status(409).json({ message: "そのユーザー名はすでに使用されています。" });
        }
        const newUser = new User({ username, password, isOnline: false, isGuest: false });
        await newUser.save();
        res.status(201).json({ message: "登録成功！" });
    } catch (error) {
        console.error("登録エラー:", error);
        res.status(500).json({ message: "登録中にエラーが発生しました。" });
    }
});

// ログアウトルート
app.post("/logout", async (req, res) => {
    if (req.session.userId) {
        try {
            const user = await User.findById(req.session.userId);
            if (user) {
                user.isOnline = false;
                user.lastSeen = Date.now();
                await user.save();
            }
        } catch (error) {
            console.error("ログアウト時のユーザー状態更新エラー:", error);
        }
    }
    req.session.destroy((err) => {
        if (err) {
            console.error("セッション破棄エラー:", err);
            return res.status(500).json({ message: "ログアウト中にエラーが発生しました。" });
        }
        res.clearCookie('connect.sid');
        res.status(200).json({ message: "ログアウト成功！" });
    });
});

// ★追加: 過去のメッセージ取得ルート
app.get("/messages", async (req, res) => {
    const { roomId } = req.query; // クエリパラメータからroomIdを取得
    const query = roomId ? { room: roomId } : {}; // roomIdがあればroomでフィルタリング

    try {
        const messages = await Message.find(query) // フィルタリングを適用
            .populate('sender', 'username') // sender IDからusernameを取得
            .sort({ timestamp: 1 }) // 古いものから新しいものへソート
            .limit(50); // 例: 最新50件のみ取得
        res.status(200).json(messages);
    } catch (error) {
        console.error("過去メッセージ取得エラー:", error);
        res.status(500).json({ message: "過去のメッセージの取得に失敗しました。" });
    }
});


// =========================================================
// 静的ファイルの提供とSPAのためのフォールバックルート
// APIルートの後に配置すること！
// =========================================================
app.use(express.static(path.join(__dirname, 'public')));

// SPA (Single Page Application) のためのフォールバックルート
// 上記の静的ファイルやAPIルート以外のすべてのGETリクエストを、
// 'public' フォルダ内の 'index.html' にルーティングします。
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
// =========================================================


// Socket.IO接続ハンドリング
// ExpressセッションミドルウェアをSocket.IOでも共有
io.use((socket, next) => {
    sessionMiddleware(socket.request, socket.request.res || {}, next);
});

io.on("connection", async (socket) => {
    const session = socket.request.session;
    console.log("Socket.IO接続試行:", socket.id);

    if (session && (session.userId || session.guestId)) {
        let user;
        try {
            if (session.userId) {
                user = await User.findById(session.userId);
            } else if (session.guestId) {
                user = await User.findById(session.guestId);
            }

            if (user) {
                user.isOnline = true;
                await user.save();
                console.log(`Socket.IO接続: ${user.username} (ID: ${user._id}) がオンラインになりました。`);
                socket.userId = user._id; // SocketにユーザーIDを紐付け
                socket.username = user.username; // Socketにユーザー名を紐付け
                socket.isGuest = user.isGuest; // Socketにゲストフラグを紐付け
                
                // ★追加: 接続時にデフォルトルームに参加させる (クライアント側でもjoinRoomを呼ぶ)
                socket.currentRoom = 'general'; // デフォルトの部屋IDを設定
                socket.join(socket.currentRoom);
                console.log(`ユーザー ${socket.username} がデフォルト部屋 ${socket.currentRoom} に参加しました。`);
                socket.emit('roomJoined', socket.currentRoom); // クライアントに通知

                updateOnlineUsers(); // オンラインユーザーリストを更新してクライアントに送信
            } else {
                console.warn("Socket.IO接続時にセッションのユーザーが見つかりません。セッションをクリアします。");
                session.destroy((err) => {
                    if (err) console.error("Socket.IOセッション破棄エラー:", err);
                    socket.disconnect(true);
                });
            }
        } catch (error) {
            console.error("Socket.IO接続時のDBエラー:", error);
            socket.disconnect(true);
        }
    } else {
        console.warn("Socket.IO接続時にセッション情報が不完全です。再認証を試みます。");
        socket.emit("reauthenticate");
        socket.disconnect(true);
    }

    // ★追加: 部屋参加イベントハンドラ
    socket.on("joinRoom", async (roomId) => {
        if (!socket.userId) {
            console.warn("未認証ユーザーが部屋参加を試みました。");
            socket.emit("reauthenticate");
            return;
        }

        if (socket.currentRoom && socket.currentRoom !== roomId) {
            socket.leave(socket.currentRoom);
            console.log(`ユーザー ${socket.username} が部屋 ${socket.currentRoom} を離脱しました。`);
        }
        
        socket.join(roomId);
        socket.currentRoom = roomId;
        console.log(`ユーザー ${socket.username} が部屋 ${roomId} に参加しました。`);
        socket.emit('roomJoined', roomId); // クライアントに確認を返す
    });


    socket.on("chat message", async (msg) => {
        // msg は { roomId: string, content: string } の形式で来ると想定
        if (socket.userId && msg.roomId && msg.content) {
            try {
                // Socketが現在参加している部屋と、送られてきたメッセージの部屋IDが一致するか確認
                if (socket.currentRoom !== msg.roomId) {
                    console.warn(`不正な部屋IDでのメッセージ送信試行: ${socket.username} は部屋 ${socket.currentRoom} にいるが、部屋 ${msg.roomId} へ送信しようとしました。`);
                    return; // 送信を拒否
                }

                const newMessage = new Message({
                    sender: socket.userId,
                    content: msg.content,
                    room: msg.roomId, // ルームIDを保存
                });
                await newMessage.save();

                // 特定の部屋にのみメッセージを送信
                io.to(msg.roomId).emit("chat message", { 
                    username: socket.username, 
                    content: msg.content, 
                    timestamp: newMessage.timestamp,
                    senderId: socket.userId // 自分のメッセージかどうかを判断するためにsenderIdも送信
                });
            } catch (error) {
                console.error("メッセージ保存エラー:", error);
            }
        } else {
            console.warn("未認証ユーザーまたは無効なメッセージ形式からのメッセージ試行:", msg);
        }
    });

    socket.on("disconnect", async () => {
        console.log(`ユーザー ${socket.username || '不明'} (ID: ${socket.userId || '不明'}) が切断しました。`);
        if (socket.userId) {
            try {
                const user = await User.findById(socket.userId);
                if (user) {
                    // 他のソケットがまだ接続している可能性があるので、isOnlineを直接falseにしない
                    // ユーザーに紐づく全てのソケットが切断された場合のみisOnlineをfalseにするのが理想だが、
                    // 現状はシンプルに切断時にfalseにする。
                    user.isOnline = false;
                    user.lastSeen = Date.now();
                    await user.save();
                    updateOnlineUsers(); // オンラインユーザーリストを更新
                }
            } catch (error) {
                console.error("切断時のユーザー状態更新エラー:", error);
            }
        }
    });
});

// オンラインユーザーリストを更新して全クライアントに送信する関数
async function updateOnlineUsers() {
    try {
        const onlineUsers = await User.find({ isOnline: true }).select('username _id');
        io.emit('online users', onlineUsers);
        console.log("オンラインユーザーを更新しました:", onlineUsers.map(u => u.username));
    } catch (error) {
        console.error("オンラインユーザー取得エラー:", error);
    }
}


// サーバーの起動
server.listen(PORT, () => {
    console.log(`サーバーがポート ${PORT} で起動しました`);
    console.log(`環境: ${process.env.NODE_ENV || 'development'}`);
    // サーバー起動時に一度オンラインユーザーを更新
    updateOnlineUsers();
});

// エラーハンドリング (オプション)
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    process.exit(1);
});
