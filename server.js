
const fs = require("fs");
const express = require("express");

const app = express();
app.use(express.json());

const FILE_PATH = "messages.json";

// メッセージを保存する関数
function saveMessage(data) {
  let messages = [];

  // 既存のデータを読み込む（ファイルが存在する場合）
  if (fs.existsSync(FILE_PATH)) {
    messages = JSON.parse(fs.readFileSync(FILE_PATH, "utf-8"));
  }

  // 新しいデータ（メッセージ or ファイル）を追加
  messages.push(data);

  // JSONファイルに保存
  fs.writeFileSync(FILE_PATH, JSON.stringify(messages, null, 2));
}

// メッセージ送信API
app.post("/send-message", (req, res) => {
  const { message, file } = req.body;
  if (!message && !file) {
    return res.status(400).json({ error: "Message or file must be provided!" });
  }

  const newEntry = { timestamp: new Date().toISOString() };
  if (message) newEntry.text = message;
  if (file) newEntry.file = file;

  saveMessage(newEntry);
  res.status(200).json({ success: true, message: "Data saved!" });
});

// メッセージ取得API
app.get("/messages", (req, res) => {
  if (!fs.existsSync(FILE_PATH)) {
    return res.json([]);
  }

  const messages = JSON.parse(fs.readFileSync(FILE_PATH, "utf-8"));
  res.json(messages);
});

// サーバー起動
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
