const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const path = require("path");
const session = require("express-session");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs"); // パスワードのハッシュ化用
const { v4: uuidv4 } = require("uuid"); // ユニークなID生成用
const multer = require('multer'); // ファイルアップロード用

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// 環境変数からポート番号を取得、なければ3000を使用
const PORT = process.env.PORT || 3000;
// 環境変数からMongoDB接続URIを取得
const MONGODB_URI = process.env.MONGODB_URI;
// 環境変数からセッションシークレットを取得 (本番環境では必須)
const SESSION_SECRET = process.env.SESSION_SECRET || "fallback-secret-for-development-do-not-use-in-production";

// MongoDB接続
mongoose.connect(MONGODB_URI || "mongodb://localhost:27017/chat_app_db")
    .then(() => console.log("MongoDBに接続しました！"))
    .catch((err) => console.error("MongoDB接続エラー:", err));

// MongoDBスキーマとモデル
const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    online: { type: Boolean, default: false }, // オンライン状態を追加
    lastSeen: { type: Date, default: Date.now } // 最終オンライン時刻
});
const User = mongoose.model("User", userSchema);

const messageSchema = new mongoose.Schema({
    room: String, // 公開ルーム名
    dmTargetUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // DMの場合のターゲットユーザーID
    dmTargetUser: String, // DMの場合のターゲットユーザー名 (表示用)
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // メッセージ送信者のユーザーID
    user: String, // メッセージ送信者のユーザー名
    text: String, // テキストメッセージ
    file: String, // ファイルのURL (S3など)
    timestamp: { type: Date, default: Date.now },
    dm: { type: Boolean, default: false } // DMかどうか
});
const Message = mongoose.model("Message", messageSchema);

// セッション設定
const sessionMiddleware = session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false, // 未初期化のセッションを保存しない
    cookie: {
        secure: process.env.NODE_ENV === "production", // HTTPSでのみCookieを送信
        maxAge: 1000 * 60 * 60 * 24 * 7, // 7日間
        httpOnly: true, // JavaScriptからCookieにアクセスできないようにする
        sameSite: 'lax', // CSRF対策
    },
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(sessionMiddleware); // セッションミドルウェアをExpressに適用

// Socket.IOにセッションミドルウェアを適用
io.engine.use(sessionMiddleware);

// 静的ファイルの提供
app.use(express.static(path.join(__dirname, "public")));

// オンラインユーザー管理
let onlineUsers = new Map(); // Map<userId, { username: string, socketId: string }>

// 認証済みかチェックするミドルウェア
const isAuthenticated = (req, res, next) => {
    // セッションに認証情報があり、かつゲストユーザーでない場合
    if (req.session.authenticated && !req.session.isGuest) {
        next();
    } else {
        // ログに詳細を出す
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

        // セッションにユーザー情報を保存
        req.session.authenticated = true;
        req.session.username = user.username;
        req.session.userId = user._id; // MongoDBの_idを使用
        req.session.isGuest = false; // ゲストログインではないことを明示的に設定

        // データベースのオンライン状態を更新
        user.online = true;
        user.lastSeen = new Date();
        await user.save();

        console.log(`ユーザー ${user.username} がログインしました。`);
        res.json({ success: true, message: "ログイン成功", username: user.username, userId: user._id });
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
    // DBのオンライン状態を更新
    if (req.session.userId) {
        User.findByIdAndUpdate(req.session.userId, { online: false, lastSeen: new Date() })
            .then(() => console.log(`ユーザー ${req.session.username} のオンライン状態をオフラインに設定しました。`))
            .catch(err => console.error("ログアウト時のオンライン状態更新エラー:", err));
    }

    req.session.destroy((err) => {
        if (err) {
            console.error("セッション破棄エラー:", err);
            return res.status(500).json({ success: false, message: "ログアウトに失敗しました。", error: err.message });
        }
        res.json({ success: true, message: "ログアウトしました。" });
    });
});

// 認証チェック
app.get("/check-auth", (req, res) => {
    // キャッシュを無効にするヘッダーを追加
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');

    if (req.session.authenticated) {
        console.log(`認証チェック: ユーザー ${req.session.username} は認証済みです。`);
        return res.json({
            authenticated: true,
            username: req.session.username,
            userId: req.session.userId,
            isGuest: req.session.isGuest || false // 念のためisGuestも送る
        });
    } else {
        // ゲストログインの場合の処理
        const isGuest = req.query.guest === 'true';
        if (isGuest) {
            // ゲストユーザーとしてセッションを確立 (認証はされないが、ユーザー情報を持つ)
            if (!req.session.username || !req.session.userId || !req.session.isGuest) {
                console.log("新規ゲストセッションを生成します。");
                req.session.username = `ゲスト-${Math.floor(Math.random() * 10000)}`;
                req.session.userId = `guest-${Date.now()}`;
                req.session.isGuest = true;
            }
            console.log(`認証チェック: ゲストユーザー ${req.session.username} (ID: ${req.session.userId}) です。`);
            return res.json({
                authenticated: false, // ゲストは"認証済み"ではない
                username: req.session.username,
                userId: req.session.userId,
                isGuest: true // 明示的にゲストであることを示す
            });
        } else {
            console.log("認証チェック: ユーザーは認証されていません。");
            return res.status(401).json({ authenticated: false, message: "認証が必要です。" });
        }
    }
});

// ユーザー名変更 (認証が必要)
app.post("/change-username", isAuthenticated, async (req, res) => {
    const { newUsername } = req.body;
    const userId = req.session.userId;

    if (!newUsername || newUsername.length < 3 || newUsername.length > 20) {
        return res.status(400).json({ success: false, message: "ユーザー名は3文字以上20文字以下にしてください。" });
    }

    try {
        const existingUser = await User.findOne({ username: newUsername });
        if (existingUser && existingUser._id.toString() !== userId.toString()) {
            return res.status(409).json({ success: false, message: "このユーザー名は既に使われています。" });
        }

        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ success: false, message: "ユーザーが見つかりません。" });
        }

        const oldUsername = user.username;
        user.username = newUsername;
        await user.save();

        // セッションのユーザー名も更新
        req.session.username = newUsername;

        // 全クライアントにユーザーリスト更新を通知
        const updatedUsers = await User.find({ online: true }, 'username _id').lean();
        io.emit('updateUserList', updatedUsers.map(u => ({ id: u._id.toString(), username: u.username, online: true })));

        // 全チャット履歴のユーザー名を更新 (これは重い処理なので注意)
        await Message.updateMany({ userId: userId }, { user: newUsername });

        io.emit("message", {
            user: "システム",
            text: `${oldUsername} さんが ${newUsername} にユーザー名を変更しました。`,
            timestamp: new Date().toISOString(),
            room: "システム通知", // 全員に通知するため、仮のルーム名
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
        // オンライン状態のユーザーのみ取得
        const users = await User.find({ online: true }, 'username _id').lean();
        res.json({ success: true, users: users.map(u => ({ id: u._id.toString(), username: u.username, online: true })) });
    } catch (error) {
        console.error("ユーザーリスト取得エラー:", error);
        res.status(500).json({ success: false, message: "ユーザーリストの取得に失敗しました。", error: error.message });
    }
});


// メッセージのアップロード先設定
const upload = multer({
    storage: multer.memoryStorage(), // メモリに一時保存
    limits: { fileSize: 10 * 1024 * 1024 } // 10MBまで
});

// ファイルアップロードエンドポイント (認証が必要)
app.post('/upload', isAuthenticated, upload.single('file'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ success: false, error: 'ファイルがアップロードされませんでした。' });
    }

    // ここでS3などの外部ストレージにアップロードするロジックを実装
    // 今回は簡易的にBase64エンコードして返す例 (本番環境では非推奨)
    const base64Data = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
    const fileUrl = base64Data; // S3にアップロードした場合は、そのURLをここに設定

    const { room, dmTargetUser, dmTargetUserId } = req.body;
    const isDm = !!dmTargetUserId;

    if (!isDm && !room) {
        return res.status(400).json({ success: false, error: 'ルームまたはDMターゲットが指定されていません。' });
    }

    try {
        const newMessage = new Message({
            room: room,
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
        // DMの場合は特定のユーザーに、公開ルームの場合はそのルームの参加者に
        if (isDm) {
            // DM相手と自分自身に送る
            io.to(onlineUsers.get(req.session.userId)?.socketId).emit('message', newMessage);
            if (onlineUsers.has(dmTargetUserId)) {
                io.to(onlineUsers.get(dmTargetUserId)?.socketId).emit('message', newMessage);
            }
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
const pinnedMessages = {}; // { roomName: { message: {}, user: string, timestamp: Date } }

io.on("connection", async (socket) => {
    const session = socket.request.session;
    let currentRoom = null; // 現在のルーム
    let currentDmTargetUserId = null; // 現在のDM相手のID
    let isGuest = false;

    // セッション情報が不完全な場合（再接続時など）の処理
    if (!session || (!session.authenticated && !session.isGuest)) {
        console.warn("Socket.IO接続時にセッション情報が不完全です。ゲストとして処理を試みます。");
        // ゲストとして強制的にセッションを生成
        session.username = `ゲスト-${Math.floor(Math.random() * 10000)}`;
        session.userId = `guest-${Date.now()}`;
        session.isGuest = true;
        await new Promise((resolve, reject) => session.save(err => err ? reject(err) : resolve()));
    }

    // 接続ユーザーをオンラインユーザーリストに追加
    if (session.userId && session.username) {
        onlineUsers.set(session.userId.toString(), {
            username: session.username,
            socketId: socket.id,
            isGuest: session.isGuest || false // ゲスト情報をMapに追加
        });
        console.log(`${session.username} (ID: ${session.userId}) が接続しました。`);

        // データベースのオンライン状態を更新 (登録ユーザーの場合のみ)
        if (!session.isGuest && !session.username.startsWith('ゲスト-')) {
            try {
                await User.findByIdAndUpdate(session.userId, { online: true, lastSeen: new Date() });
                console.log(`DB: ${session.username} のオンライン状態をtrueに設定。`);
            } catch (error) {
                console.error("DBオンライン状態更新エラー:", error);
            }
        }
        // 全クライアントにオンラインユーザーリストを更新して通知
        emitOnlineUsers();
    } else {
        console.warn("Socket.IO接続時にセッション情報（userId/username）が不足しています。");
    }

    // ルーム参加イベント
    socket.on("joinRoom", async (roomName, roomType, dmTargetId) => {
        // 既存のルームから離脱
        if (currentRoom) {
            socket.leave(currentRoom);
            console.log(`${session.username} がルーム "${currentRoom}" から退出しました。`);
        }
        if (currentDmTargetUserId) {
            // DMルームから退出する処理があればここに追加
        }

        // 新しいルームに参加
        if (roomType === 'public') {
            currentRoom = roomName;
            currentDmTargetUserId = null;
            socket.join(currentRoom);
            console.log(`${session.username} が公開ルーム "${currentRoom}" に参加しました。`);
            // 履歴をロード
            const messages = await Message.find({ room: currentRoom, dm: false }).sort({ timestamp: 1 }).limit(100);
            socket.emit("messageHistory", messages);
            // ピン留めメッセージを送信
            if (pinnedMessages[currentRoom]) {
                socket.emit("updatePinnedMessage", { message: pinnedMessages[currentRoom] });
            } else {
                socket.emit("updatePinnedMessage", { message: null }); // ピン留めなしを通知
            }
        } else if (roomType === 'dm' && dmTargetId) {
            // DMの場合は、参加するルーム名を特定の形式で生成（例: ユーザーIDのペアをソートして結合）
            const dmRoomName = [session.userId.toString(), dmTargetId].sort().join('-');
            currentRoom = dmRoomName; // 内部的にはルームとして扱う
            currentDmTargetUserId = dmTargetId;
            socket.join(currentRoom);
            console.log(`${session.username} が ${dmTargetId} とのDMルーム "${currentRoom}" に参加しました。`);
            // DM履歴をロード
            const messages = await Message.find({
                dm: true,
                $or: [
                    { userId: session.userId, dmTargetUserId: dmTargetId },
                    { userId: dmTargetId, dmTargetUserId: session.userId }
                ]
            }).sort({ timestamp: 1 }).limit(100);
            socket.emit("messageHistory", messages);
            // DMではピン留めメッセージはサポートしない
            socket.emit("updatePinnedMessage", { message: null });
        } else {
            console.warn("不明なルーム参加リクエスト:", roomName, roomType, dmTargetId);
        }
    });

    // メッセージ受信イベント (send-message HTTP POST エンドポイントを使うため、Socket.IOでの直接送信は不要)
    // socket.on("message", async (msg) => { ... });

    // ピン留めメッセージ
    socket.on("pinMessage", async (data) => {
        if (!session.authenticated) { // 認証済みユーザーのみ
            socket.emit('error', 'ピン留めするにはログインが必要です。');
            return;
        }
        if (data.room && data.message) {
            pinnedMessages[data.room] = data.message;
            io.to(data.room).emit("updatePinnedMessage", { message: data.message });
            console.log(`ルーム "${data.room}" にメッセージをピン留めしました: ${data.message.text}`);
        }
    });

    // ピン留め解除
    socket.on("unpinMessage", async (room) => {
        if (!session.authenticated) { // 認証済みユーザーのみ
            socket.emit('error', 'ピン留めを解除するにはログインが必要です。');
            return;
        }
        if (pinnedMessages[room]) {
            delete pinnedMessages[room];
            io.to(room).emit("updatePinnedMessage", { message: null });
            console.log(`ルーム "${room}" のピン留めを解除しました。`);
        }
    });

    // 切断イベント
    socket.on("disconnect", async () => {
        if (session.userId && onlineUsers.has(session.userId.toString())) {
            onlineUsers.delete(session.userId.toString());
            console.log(`${session.username} (ID: ${session.userId}) が切断しました。`);

            // データベースのオンライン状態を更新 (登録ユーザーの場合のみ)
            if (!session.isGuest && !session.username.startsWith('ゲスト-')) {
                try {
                    await User.findByIdAndUpdate(session.userId, { online: false, lastSeen: new Date() });
                    console.log(`DB: ${session.username} のオンライン状態をfalseに設定。`);
                } catch (error) {
                    console.error("DBオンライン状態更新エラー (切断時):", error);
                }
            }
            // 全クライアントにオンラインユーザーリストを更新して通知
            emitOnlineUsers();
        }
    });
});

// オンラインユーザーリストを全クライアントに送信する関数
async function emitOnlineUsers() {
    try {
        // データベースからオンラインユーザーを取得し、オンライン状態のMapと結合
        const registeredOnlineUsers = await User.find({ online: true }, 'username _id').lean();
        const guestOnlineUsers = Array.from(onlineUsers.values())
            .filter(user => user.isGuest)
            .map(user => ({ id: user.socketId, username: user.username, online: true })); // ゲストはsocketIdをIDとして扱う

        // 登録ユーザーとゲストユーザーを結合
        const combinedUsers = [
            ...registeredOnlineUsers.map(u => ({ id: u._id.toString(), username: u.username, online: true })),
            ...guestOnlineUsers
        ];

        // 重複を除去 (同じユーザーが複数タブで接続している場合など)
        const uniqueUsersMap = new Map();
        combinedUsers.forEach(user => {
            uniqueUsersMap.set(user.username, user); // ユーザー名をキーにして重複除去
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
    if (!SESSION_SECRET || SESSION_SECRET === "fallback-secret-for-development-do-not-use-in-production") {
        console.error("重大な警告: SESSION_SECRET 環境変数が設定されていないか、デフォルト値が使用されています。本番環境では絶対に避け、強固な秘密鍵を設定してください。");
    }
});
