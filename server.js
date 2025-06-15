// server.js の完全なコード例

// 必要なモジュールのインポート
const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const mongoose = require("mongoose");
const path = require("path");
const session = require("express-session");
const MongoStore = require("connect-mongo"); // 追加: MongoDBをセッションストアとして使用するため

// 環境変数の設定 (Renderで設定したものを使用)
const PORT = process.env.PORT || 3000; // RenderはPORT環境変数でポートを指定
const MONGODB_URI = process.env.MONGODB_URI;
const SESSION_SECRET = process.env.SESSION_SECRET; // Renderに設定済み

// 環境変数が設定されているか確認 (開発時に役立つ)
if (!MONGODB_URI) {
    console.error("エラー: MONGODB_URI 環境変数が設定されていません。MongoDBに接続できません。");
    // 本番環境ではexitすることが多いが、開発用にフォールバックを続ける
    // process.exit(1);
}
if (!SESSION_SECRET) {
    console.warn("警告: SESSION_SECRET 環境変数が設定されていません。デフォルトのシークレットを使用します。");
    console.warn("本番環境ではセキュアなSESSION_SECRETを設定してください。");
}

// Expressアプリケーションの初期化
const app = express();
const server = http.createServer(app);

// Socket.IOの初期化
// corsオプションは、クライアントが異なるオリジンから接続する場合に必要
const io = socketIo(server, {
    cors: {
        origin: "*", // 許可するオリジンを本番環境では具体的に指定することを推奨 (例: "https://your-frontend-domain.com")
        methods: ["GET", "POST"],
        credentials: true, // セッションCookieの送信を許可
    },
});

// MongoDBへの接続
mongoose.connect(MONGODB_URI)
    .then(() => console.log("MongoDBに接続しました！"))
    .catch((err) => console.error("MongoDB接続エラー:", err));

// Mongooseスキーマとモデルの定義
// (あなたのチャットアプリのUserモデルやMessageモデルなどがここに来ます)
// 例:
const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    isOnline: { type: Boolean, default: false },
    lastSeen: { type: Date, default: Date.now },
    isGuest: { type: Boolean, default: false }
});
const User = mongoose.model('User', userSchema);

const messageSchema = new mongoose.Schema({
    sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    content: { type: String, required: true },
    timestamp: { type: Date, default: Date.now }
});
const Message = mongoose.model('Message', messageSchema);

// セッション設定 (重要: Renderでは secure: true と sameSite: 'None' が推奨)
const sessionMiddleware = session({
    secret: SESSION_SECRET || "super-secret-fallback-key-for-dev", // 環境変数が設定されていなければフォールバック
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({ // connect-mongo を使用してMongoDBをセッションストアに
        mongoUrl: MONGODB_URI, // MongoDB接続URI
        ttl: 1000 * 60 * 60 * 24 * 7, // セッションの有効期限 (7日間)
        autoRemove: 'interval', // 期限切れセッションの自動削除を有効に
        autoRemoveInterval: 10 // 10分ごとに期限切れセッションをクリーンアップ
    }),
    cookie: {
        secure: true, // RenderはHTTPSなので必ずtrueに設定
        maxAge: 1000 * 60 * 60 * 24 * 7, // 7日間
        httpOnly: true, // クライアントサイドJavaScriptからのアクセスを防ぐ
        sameSite: 'None', // クロスサイトCookieを許可するために'None'に設定 (Render環境で必要)
    },
});

// Expressミドルウェア
app.use(express.json()); // JSON形式のリクエストボディを解析
app.use(express.urlencoded({ extended: true })); // URLエンコードされたリクエストボディを解析
app.use(sessionMiddleware); // セッションミドルウェアを使用

// 静的ファイルの提供 (Reactアプリのビルドされたファイルなど)
// 本番環境では、クライアント側のビルドディレクトリを指定します。
// 例: app.use(express.static(path.join(__dirname, 'client', 'build')));
// GitHubリポジトリの構造が分からないため、ここではコメントアウトしています。
// 必要に応じてパスを修正してください。
// app.use(express.static(path.join(__dirname, 'public'))); // もしpublicフォルダがある場合

// ルート定義
// 認証チェックルート
app.get("/check-auth", async (req, res) => {
    console.log("認証チェック:", req.session.userId ? `ユーザーID: ${req.session.userId}` : "ユーザー認証されていません");

    // ゲストセッションが存在しないか、既存のユーザーセッションがない場合
    if (!req.session.userId && !req.session.guestId) {
        // 新しいゲストセッションを生成
        const guestId = `guest-${require('uuid').v4()}`; // uuidライブラリが必要
        const guestUsername = `ゲスト-${Math.floor(Math.random() * 9000) + 1000}`;
        
        try {
            const guestUser = new User({
                username: guestUsername,
                password: 'guest-password', // ゲストユーザーのパスワードはダミーでOK
                isGuest: true,
                isOnline: true // ログイン時にtrueにする
            });
            await guestUser.save();
            req.session.guestId = guestUser._id; // _id をセッションに保存
            req.session.username = guestUsername; // ユーザー名をセッションに保存
            console.log(`新規ゲストセッションを生成します。ユーザー名: ${guestUsername} (ID: ${guestUser._id})`);
            return res.status(200).json({
                isAuthenticated: true,
                isGuest: true,
                username: guestUsername,
                userId: guestUser._id, // ここで_idも返すべき
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
                user.isOnline = true; // ログイン時にtrueにする
                await user.save();
                console.log(`認証チェック: 登録ユーザー ${user.username} (ID: ${user._id}) です。`);
                return res.status(200).json({ isAuthenticated: true, isGuest: false, username: user.username, userId: user._id });
            } else {
                // ユーザーが見つからない場合はセッションをクリアして再認証を促す
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
                guestUser.isOnline = true; // ログイン時にtrueにする
                await guestUser.save();
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
        // ゲスト要求なしで認証されていない場合
        console.log("認証チェック: ユーザーは認証されていません (ゲスト要求なし)。");
        res.status(401).json({ isAuthenticated: false, message: "認証されていません。ログインしてください。" });
    }
});

// ログインルート (例)
app.post("/login", async (req, res) => {
    const { username, password } = req.body;
    try {
        const user = await User.findOne({ username });
        if (!user || user.password !== password) { // 実際はパスワードのハッシュ化と比較が必要
            return res.status(401).json({ message: "ユーザー名またはパスワードが間違っています。" });
        }
        req.session.userId = user._id;
        req.session.username = user.username;
        user.isOnline = true;
        await user.save();
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
        const newUser = new User({ username, password, isOnline: false, isGuest: false }); // isOnline は登録時はfalse
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
        res.clearCookie('connect.sid'); // セッションCookieを削除 (セッション名が 'connect.sid' の場合)
        res.status(200).json({ message: "ログアウト成功！" });
    });
});


// Socket.IO接続ハンドリング
io.use((socket, next) => {
    // ExpressセッションミドルウェアをSocket.IOでも共有
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
                // オンラインユーザーリストを更新してクライアントに送信
                updateOnlineUsers();
            } else {
                console.warn("Socket.IO接続時にセッションのユーザーが見つかりません。セッションをクリアします。");
                session.destroy((err) => {
                    if (err) console.error("Socket.IOセッション破棄エラー:", err);
                    socket.disconnect(true); // セッションがないので切断
                });
            }
        } catch (error) {
            console.error("Socket.IO接続時のDBエラー:", error);
            socket.disconnect(true); // エラー発生時も切断
        }
    } else {
        console.warn("Socket.IO接続時にセッション情報が不完全です。再認証を試みます。");
        socket.emit("reauthenticate"); // クライアントに再認証を促すイベントを送信
        socket.disconnect(true); // セッションがないので切断
    }

    socket.on("chat message", async (msg) => {
        if (socket.userId) { // 認証済みユーザーのみメッセージ送信を許可
            try {
                const newMessage = new Message({
                    sender: socket.userId,
                    content: msg,
                });
                await newMessage.save();
                // io.emitはすべての接続クライアントにイベントを送信
                io.emit("chat message", { username: socket.username, content: msg, timestamp: newMessage.timestamp });
            } catch (error) {
                console.error("メッセージ保存エラー:", error);
            }
        } else {
            console.warn("未認証ユーザーからのメッセージ試行:", msg);
        }
    });

    socket.on("disconnect", async () => {
        console.log(`ユーザー ${socket.username || '不明'} (ID: ${socket.userId || '不明'}) が切断しました。`);
        if (socket.userId) {
            try {
                const user = await User.findById(socket.userId);
                if (user) {
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
    // アプリケーションをクラッシュさせるか、ロギングのみにするかは要件による
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    // アプリケーションを適切にシャットダウンすることを検討
    process.exit(1);
});