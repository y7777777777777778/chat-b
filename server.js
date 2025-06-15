const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const path = require("path");
const session = require("express-session");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const { v4: uuidv4 } = require("uuid");
const multer = require('multer');

const app = express();
const server = http.createServer(app);

// Socket.IOのCORS設定を強化 (Renderのようなホスティング環境では必須)
const io = socketIo(server, {
    cors: {
        origin: "*", // 本番環境では特定のオリジンに制限することを強く推奨します
        methods: ["GET", "POST"],
        credentials: true // クッキーやセッション情報を送受信するために必要
    }
});

// 環境変数からポート番号を取得、なければ8080を使用 (Renderは通常PORT環境変数を使用)
const PORT = process.env.PORT || 8080;
// 環境変数からMongoDB接続URIを取得 (必須)
const MONGODB_URI = process.env.MONGODB_URI;
// 環境変数からセッションシークレットを取得 (本番環境では必須)
const SESSION_SECRET = process.env.SESSION_SECRET;

// MongoDB接続
if (!MONGODB_URI) {
    console.error("エラー: MONGODB_URI 環境変数が設定されていません。MongoDBに接続できません。");
    // アプリケーションを終了するか、開発用のローカルDBにフォールバック
    // process.exit(1); // 本番環境ではこれを検討
}

mongoose.connect(MONGODB_URI || "mongodb://localhost:27017/chat_app_db") // MONGODB_URIがなければローカルにフォールバック
    .then(() => console.log("MongoDBに接続しました！"))
    .catch((err) => console.error("MongoDB接続エラー:", err));

// MongoDBスキーマとモデル
const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    online: { type: Boolean, default: false },
    lastSeen: { type: Date, default: Date.now }
});
const User = mongoose.model("User", userSchema);

const messageSchema = new mongoose.Schema({
    room: String,
    dmTargetUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    dmTargetUser: String,
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    user: String,
    text: String,
    file: String,
    timestamp: { type: Date, default: Date.now },
    dm: { type: Boolean, default: false }
});
const Message = mongoose.model("Message", messageSchema);

// セッション設定 (重要: Renderでは secure: true と sameSite: 'None' が推奨)
const sessionMiddleware = session({
    secret: SESSION_SECRET || "super-secret-fallback-key-for-dev", // 本番環境では環境変数必須
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: true, // RenderはHTTPSなので必ずtrueに設定
        maxAge: 1000 * 60 * 60 * 24 * 7, // 7日間
        httpOnly: true,
        sameSite: 'None', // クロスサイトCookieを許可するために'None'に設定 (Render環境ではこれが必要になることが多い)
    },
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(sessionMiddleware);

// Socket.IOにセッションミドルウェアを適用
io.engine.use(sessionMiddleware);

// 静的ファイルの提供
app.use(express.static(path.join(__dirname, "public")));

// オンラインユーザー管理
let onlineUsers = new Map(); // Map<userId, { username: string, socketId: string, isGuest: boolean }>

// 認証済みかチェックするミドルウェア (APIエンドポイント用)
const isAuthenticated = (req, res, next) => {
    if (req.session.authenticated && !req.session.isGuest) {
        next();
    } else {
        console.warn(`認証されていないアクセス試行: セッション認証済み=${req.session.authenticated}, ゲスト=${req.session.isGuest}, URL=${req.originalUrl}`);
        res.status(401).json({ success: false, message: "認証が必要です。" });
    }
};

// =======================================================================
// ルーティング
// =======================================================================

// ルートパス
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ログイン
app.post("/login", async (req, res) => {
    const { username, password } = req.body;

    try {
        const user = await User.findOne({ username });
        if (!user) {
            return res.status(401).json({ success: false, message: "ユーザー名またはパスワードが違います。" });
        }

        const passwordMatch = await bcrypt.compare(password, user.password);
        if (!passwordMatch) {
            return res.status(401).json({ success: false, message: "ユーザー名またはパスワードが違います。" });
        }

        req.session.authenticated = true;
        req.session.username = user.username;
        req.session.userId = user._id.toString(); // ObjectIdを文字列に変換
        req.session.isGuest = false;

        // DBのオンライン状態を更新
        user.online = true;
        user.lastSeen = new Date();
        await user.save();

        console.log(`ユーザー ${user.username} がログインしました。`);
        // セッション保存を待ってからレスポンスを返す
        req.session.save(err => {
            if (err) {
                console.error("ログイン時のセッション保存エラー:", err);
                return res.status(500).json({ success: false, message: "ログインに失敗しました。", error: err.message });
            }
            res.json({ success: true, message: "ログイン成功", username: user.username, userId: user._id.toString() });
        });
    } catch (error) {
        console.error("ログインエラー:", error);
        res.status(500).json({ success: false, message: "ログインに失敗しました。", error: error.message });
    }
});

// 新規登録
app.post("/register", async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ success: false, message: "ユーザー名とパスワードが必要です。" });
    }

    try {
        const existingUser = await User.findOne({ username });
        if (existingUser) {
            return res.status(409).json({ success: false, message: "このユーザー名は既に使用されています。" });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = new User({ username, password: hashedPassword });
        await newUser.save();

        console.log(`新しいユーザー ${newUser.username} が登録されました。`);
        res.status(201).json({ success: true, message: "ユーザー登録成功！" });
    } catch (error) {
        console.error("登録エラー:", error);
        res.status(500).json({ success: false, message: "ユーザー登録に失敗しました。", error: error.message });
    }
});

// ログアウト
app.post("/logout", (req, res) => {
    if (req.session.userId && !req.session.isGuest) {
        User.findByIdAndUpdate(req.session.userId, { online: false, lastSeen: new Date() })
            .then(() => console.log(`ユーザー ${req.session.username} のオンライン状態をオフラインに設定しました。`))
            .catch(err => console.error("ログアウト時のオンライン状態更新エラー:", err));
    }

    req.session.destroy((err) => {
        if (err) {
            console.error("セッション破棄エラー:", err);
            return res.status(500).json({ success: false, message: "ログアウトに失敗しました。", error: err.message });
        }
        // セッションが破棄された後、Cookieもクリア (クライアント側でリダイレクトされるため不要かも)
        res.clearCookie('connect.sid');
        res.json({ success: true, message: "ログアウトしました。" });
    });
});

// 認証チェック (HTMLページからの初回アクセスやリロード時)
app.get("/check-auth", (req, res) => {
    // キャッシュを無効にするヘッダーを強く指定
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');

    if (req.session.authenticated) {
        console.log(`認証チェック: ユーザー ${req.session.username} (ID: ${req.session.userId}) は認証済みです。`);
        return res.json({
            authenticated: true,
            username: req.session.username,
            userId: req.session.userId,
            isGuest: false // 認証済みユーザーはゲストではない
        });
    } else {
        // ゲストログインの場合の処理
        const isGuestRequest = req.query.guest === 'true';

        if (isGuestRequest) {
            if (!req.session.isGuest || !req.session.username || !req.session.userId) {
                // 新しいゲストセッションを生成
                console.log("新規ゲストセッションを生成します。");
                req.session.username = `ゲスト-${Math.floor(Math.random() * 10000)}`;
                req.session.userId = `guest-${uuidv4()}`; // UUIDを使用
                req.session.isGuest = true;
                req.session.authenticated = false; // ゲストは認証済みではない
            }
            console.log(`認証チェック: ゲストユーザー ${req.session.username} (ID: ${req.session.userId}) です。`);
            // セッション保存を待ってからレスポンスを返す
            req.session.save(err => {
                if (err) {
                    console.error("ゲストセッション保存エラー:", err);
                    return res.status(500).json({ authenticated: false, message: "セッションエラー" });
                }
                res.json({
                    authenticated: false,
                    username: req.session.username,
                    userId: req.session.userId,
                    isGuest: true
                });
            });
        } else {
            console.log("認証チェック: ユーザーは認証されていません (ゲスト要求なし)。");
            return res.status(401).json({ authenticated: false, message: "認証が必要です。" });
        }
    }
});


// ユーザー名変更
app.post("/change-username", isAuthenticated, async (req, res) => {
    const { newUsername } = req.body;
    const userId = req.session.userId;

    if (!newUsername || newUsername.length < 3 || newUsername.length > 20) {
        return res.status(400).json({ success: false, message: "ユーザー名は3文字以上20文字以下にしてください。" });
    }

    try {
        const existingUser = await User.findOne({ username: newUsername });
        if (existingUser && existingUser._id.toString() !== userId.toString()) {
            return res.status(409).json({ success: false, message: "このユーザー名は既に使用されています。" });
        }

        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ success: false, message: "ユーザーが見つかりません。" });
        }

        const oldUsername = user.username;
        user.username = newUsername;
        await user.save();

        req.session.username = newUsername; // セッションのユーザー名も更新

        // 全クライアントにオンラインユーザーリストを更新して通知
        emitOnlineUsers();

        // 過去のメッセージのユーザー名を更新 (注意: 負荷が高い可能性あり)
        await Message.updateMany({ userId: userId }, { user: newUsername });

        io.emit("message", {
            user: "システム",
            text: `${oldUsername} さんが ${newUsername} にユーザー名を変更しました。`,
            timestamp: new Date().toISOString(),
            room: "システム通知",
        });

        console.log(`ユーザー ${oldUsername} が ${newUsername} にユーザー名を変更しました。`);
        res.json({ success: true, message: "ユーザー名が変更されました。" });

    } catch (error) {
        console.error("ユーザー名変更エラー:", error);
        res.status(500).json({ success: false, message: "ユーザー名変更に失敗しました。", error: error.message });
    }
});

// オンラインユーザーリストの取得（認証が必要）
app.get("/users", isAuthenticated, async (req, res) => {
    try {
        const users = await User.find({ online: true }, 'username _id').lean();
        res.json({ success: true, users: users.map(u => ({ id: u._id.toString(), username: u.username, online: true })) });
    } catch (error) {
        console.error("ユーザーリスト取得エラー:", error);
        res.status(500).json({ success: false, message: "ユーザーリストの取得に失敗しました。", error: error.message });
    }
});

// メッセージのアップロード先設定
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

// ファイルアップロードエンドポイント (認証が必要)
app.post('/upload', isAuthenticated, upload.single('file'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ success: false, error: 'ファイルがアップロードされませんでした。' });
    }

    // Base64エンコードして返す (本番環境ではS3などの外部ストレージを使用)
    const base64Data = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
    const fileUrl = base64Data;

    const { room, dmTargetUser, dmTargetUserId } = req.body;
    const isDm = !!dmTargetUserId;

    if (!isDm && !room) {
        return res.status(400).json({ success: false, error: 'ルームまたはDMターゲットが指定されていません。' });
    }

    try {
        const newMessage = new Message({
            room: isDm ? undefined : room, // DMの場合はroomは設定しない
            userId: req.session.userId,
            user: req.session.username,
            file: fileUrl,
            dm: isDm,
            dmTargetUserId: isDm ? dmTargetUserId : undefined,
            dmTargetUser: isDm ? dmTargetUser : undefined,
            timestamp: new Date(),
        });
        await newMessage.save();

        // クライアントにメッセージを送信
        if (isDm) {
            // DM相手と自分自身に送る
            const senderSocketId = onlineUsers.get(req.session.userId)?.socketId;
            const receiverSocketId = onlineUsers.get(dmTargetUserId)?.socketId;

            if (senderSocketId) io.to(senderSocketId).emit('message', newMessage);
            if (receiverSocketId && receiverSocketId !== senderSocketId) io.to(receiverSocketId).emit('message', newMessage);

        } else {
            io.to(room).emit('message', newMessage);
        }

        res.json({ success: true, message: 'ファイルが正常にアップロードされ、送信されました。', fileUrl });

    } catch (error) {
        console.error('ファイルアップロードメッセージ保存エラー:', error);
        res.status(500).json({ success: false, error: 'メッセージの保存中にエラーが発生しました。', details: error.message });
    }
});


// =======================================================================
// Socket.IO
// =======================================================================

// ルームごとのピン留めメッセージ
const pinnedMessages = {};

io.on("connection", async (socket) => {
    const session = socket.request.session;
    let currentRoom = null;
    let currentDmTargetUserId = null;

    // セッション情報が存在しない、または認証済みでもゲストでもない場合は再認証を要求
    if (!session || (!session.authenticated && !session.isGuest)) {
        console.warn("Socket.IO接続時にセッション情報が不完全です。再認証を試みます。");
        socket.emit('reauthenticate'); // クライアントに再認証を要求
        socket.disconnect(true); // 強制切断
        return;
    }

    // 接続ユーザーをオンラインユーザーリストに追加
    if (session.userId && session.username) {
        onlineUsers.set(session.userId.toString(), {
            username: session.username,
            socketId: socket.id,
            isGuest: session.isGuest || false
        });
        console.log(`Socket.IO接続: ${session.username} (ID: ${session.userId}, ゲスト: ${session.isGuest})`);

        // データベースのオンライン状態を更新 (登録ユーザーの場合のみ)
        if (!session.isGuest) { // ゲストではない場合のみDBを更新
            try {
                await User.findByIdAndUpdate(session.userId, { online: true, lastSeen: new Date() });
            } catch (error) {
                console.error("DBオンライン状態更新エラー (Socket.IO接続時):", error);
            }
        }
        emitOnlineUsers(); // 全クライアントにオンラインユーザーリストを更新して通知
    } else {
        console.warn("Socket.IO接続時にセッション情報（userId/username）が不足しています。");
        socket.emit('reauthenticate');
        socket.disconnect(true);
    }

    // ルーム参加イベント
    socket.on("joinRoom", async (roomName, roomType, dmTargetId) => {
        // 既存のルームから離脱
        if (currentRoom) {
            socket.leave(currentRoom);
            console.log(`${session.username} がルーム "${currentRoom}" から退出しました。`);
        }

        // 新しいルームに参加
        if (roomType === 'public') {
            currentRoom = roomName;
            currentDmTargetUserId = null;
            socket.join(currentRoom);
            console.log(`${session.username} が公開ルーム "${currentRoom}" に参加しました。`);
            const messages = await Message.find({ room: currentRoom, dm: false }).sort({ timestamp: 1 }).limit(100);
            socket.emit("messageHistory", messages);
            if (pinnedMessages[currentRoom]) {
                socket.emit("updatePinnedMessage", { message: pinnedMessages[currentRoom] });
            } else {
                socket.emit("updatePinnedMessage", { message: null });
            }
        } else if (roomType === 'dm' && dmTargetId) {
            // DMの場合は、参加するルーム名を特定の形式で生成
            const dmRoomName = [session.userId.toString(), dmTargetId].sort().join('-');
            currentRoom = dmRoomName;
            currentDmTargetUserId = dmTargetId;
            socket.join(currentRoom);
            console.log(`${session.username} が ${dmTargetId} とのDMルーム "${currentRoom}" に参加しました。`);
            const messages = await Message.find({
                dm: true,
                $or: [
                    { userId: session.userId, dmTargetUserId: dmTargetId },
                    { userId: dmTargetId, dmTargetUserId: session.userId }
                ]
            }).sort({ timestamp: 1 }).limit(100);
            socket.emit("messageHistory", messages);
            socket.emit("updatePinnedMessage", { message: null }); // DMではピン留めなし
        } else {
            console.warn("不明なルーム参加リクエスト:", roomName, roomType, dmTargetId);
        }
    });

    socket.on("sendMessage", async (msg) => {
        const { text, room, dmTargetUser, dmTargetUserId } = msg;
        const isDm = !!dmTargetUserId;

        if (!session.userId || !session.username) {
            console.warn("セッション情報なしでメッセージ送信を試行しました。");
            socket.emit('error', 'メッセージを送信するにはログインが必要です。');
            return;
        }

        try {
            const newMessage = new Message({
                room: isDm ? undefined : room,
                userId: session.userId,
                user: session.username,
                text: text,
                dm: isDm,
                dmTargetUserId: isDm ? dmTargetUserId : undefined,
                dmTargetUser: isDm ? dmTargetUser : undefined,
                timestamp: new Date(),
            });
            await newMessage.save();

            if (isDm) {
                const senderSocketId = onlineUsers.get(session.userId)?.socketId;
                const receiverSocketId = onlineUsers.get(dmTargetUserId)?.socketId;

                if (senderSocketId) io.to(senderSocketId).emit('message', newMessage);
                if (receiverSocketId && receiverSocketId !== senderSocketId) io.to(receiverSocketId).emit('message', newMessage);

            } else {
                io.to(room).emit('message', newMessage);
            }
        } catch (error) {
            console.error("メッセージ保存エラー:", error);
            socket.emit("error", "メッセージの保存中にエラーが発生しました。");
        }
    });

    socket.on("pinMessage", async (data) => {
        if (!session.authenticated) {
            socket.emit('error', 'ピン留めするにはログインが必要です。');
            return;
        }
        if (data.room && data.message) {
            pinnedMessages[data.room] = data.message;
            io.to(data.room).emit("updatePinnedMessage", { message: data.message });
            console.log(`ルーム "${data.room}" にメッセージをピン留めしました: ${data.message.text}`);
        }
    });

    socket.on("unpinMessage", async (room) => {
        if (!session.authenticated) {
            socket.emit('error', 'ピン留めを解除するにはログインが必要です。');
            return;
        }
        if (pinnedMessages[room]) {
            delete pinnedMessages[room];
            io.to(room).emit("updatePinnedMessage", { message: null });
            console.log(`ルーム "${room}" のピン留めを解除しました。`);
        }
    });

    socket.on("disconnect", async () => {
        if (session.userId && onlineUsers.has(session.userId.toString())) {
            onlineUsers.delete(session.userId.toString());
            console.log(`${session.username} (ID: ${session.userId}) が切断しました。`);

            if (!session.isGuest) { // ゲストではない場合のみDBを更新
                try {
                    await User.findByIdAndUpdate(session.userId, { online: false, lastSeen: new Date() });
                } catch (error) {
                    console.error("DBオンライン状態更新エラー (切断時):", error);
                }
            }
            emitOnlineUsers(); // 全クライアントにオンラインユーザーリストを更新して通知
        }
    });
});

// オンラインユーザーリストを全クライアントに送信する関数
async function emitOnlineUsers() {
    try {
        const registeredOnlineUsers = await User.find({ online: true }, 'username _id').lean();
        const guestOnlineUsers = Array.from(onlineUsers.values())
            .filter(user => user.isGuest)
            .map(user => ({ id: user.userId, username: user.username, online: true })); // ゲストのIDはセッションのuserId (UUID)

        const combinedUsers = [
            ...registeredOnlineUsers.map(u => ({ id: u._id.toString(), username: u.username, online: true })),
            ...guestOnlineUsers
        ];

        const uniqueUsersMap = new Map();
        combinedUsers.forEach(user => {
            uniqueUsersMap.set(user.id, user); // ユーザーIDをキーにして重複除去
        });
        const finalUsers = Array.from(uniqueUsersMap.values());

        io.emit("updateUserList", finalUsers);
        console.log("オンラインユーザーリストを更新して送信しました:", finalUsers.map(u => u.username));
    } catch (error) {
        console.error("オンラインユーザーリスト送信エラー:", error);
    }
}


// サーバー起動
server.listen(PORT, () => {
    console.log(`サーバーがポート ${PORT} で起動しました`);
    console.log(`環境: ${process.env.NODE_ENV || 'development'}`);
    if (!MONGODB_URI) {
        console.warn("警告: MONGODB_URI 環境変数が設定されていません。ローカルDBに接続します。");
    }
    if (!SESSION_SECRET || SESSION_SECRET === "super-secret-fallback-key-for-dev") {
        console.error("重大な警告: SESSION_SECRET 環境変数が設定されていないか、デフォルト値が使用されています。本番環境では絶対に避け、強固な秘密鍵を設定してください。");
    }
});
