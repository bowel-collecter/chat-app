const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
  maxHttpBufferSize: 1e8,
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(express.json());

// Create 'uploads' folder safely
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}
app.use('/uploads', express.static(uploadDir));

// Serve static assets from public/ if it exists, otherwise root
const publicDir = path.join(__dirname, 'public');
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
}
app.use(express.static(__dirname));

// Multer Storage Configuration (Up to 200MB)
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const sanitizedName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, `${uniqueSuffix}-${sanitizedName}`);
  }
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 200 * 1024 * 1024 }
});

app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  res.json({ 
    success: true, 
    fileUrl: `/uploads/${req.file.filename}`, 
    filename: req.file.originalname 
  });
});

// Initialize SQLite Database
const db = new sqlite3.Database('./chat.db', (err) => {
  if (err) console.error('[DB Error]:', err.message);
  else console.log('[DB]: Connected to SQLite database.');
});

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, password TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS friendships (username TEXT, friend TEXT, UNIQUE(username, friend))`);
  db.run(`CREATE TABLE IF NOT EXISTS groups (group_name TEXT, username TEXT, UNIQUE(group_name, username))`);
  db.run(`CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, sender TEXT, recipient TEXT, is_group BOOLEAN, content TEXT, file_url TEXT, filename TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)`);
});

// Authentication
app.post('/api/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });
    
    const cleanUser = username.trim();
    const hashedPassword = await bcrypt.hash(password, 10);
    
    db.run(`INSERT INTO users (username, password) VALUES (?, ?)`, [cleanUser, hashedPassword], function(err) {
      if (err) return res.status(400).json({ error: 'Username already exists.' });
      res.json({ success: true });
    });
  } catch (e) {
    res.status(500).json({ error: 'Internal server error.' });
  }
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Fields cannot be empty.' });

  db.get(`SELECT * FROM users WHERE username = ?`, [username.trim()], async (err, user) => {
    if (err || !user) return res.status(400).json({ error: 'User does not exist.' });
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: 'Invalid password.' });
    res.json({ success: true, username: user.username });
  });
});

// User Lists & Metadata
app.get('/api/user-data/:username', (req, res) => {
  const username = req.params.username;
  db.all(`SELECT friend FROM friendships WHERE username = ?`, [username], (err, friendRows) => {
    db.all(`SELECT DISTINCT group_name FROM groups WHERE username = ?`, [username], (err2, groupRows) => {
      res.json({
        friends: friendRows ? friendRows.map(f => f.friend) : [],
        groups: groupRows ? groupRows.map(g => g.group_name) : []
      });
    });
  });
});

// Chat History
app.get('/api/messages', (req, res) => {
  const { user1, user2, isGroup } = req.query;
  if (isGroup === 'true') {
    db.all(`SELECT * FROM messages WHERE recipient = ? AND is_group = 1 ORDER BY id ASC`, [user2], (err, rows) => {
      res.json(rows || []);
    });
  } else {
    db.all(
      `SELECT * FROM messages WHERE is_group = 0 AND ((sender = ? AND recipient = ?) OR (sender = ? AND recipient = ?)) ORDER BY id ASC`,
      [user1, user2, user2, user1],
      (err, rows) => {
        res.json(rows || []);
      }
    );
  }
});

// Friend & Group Relationships
app.post('/api/add-friend', (req, res) => {
  const { username, friend } = req.body;
  if (!username || !friend) return res.status(400).json({ error: 'Missing parameters.' });
  if (username === friend) return res.status(400).json({ error: 'You cannot add yourself.' });

  db.get(`SELECT * FROM users WHERE username = ?`, [friend], (err, row) => {
    if (err || !row) return res.status(404).json({ error: 'Target user does not exist.' });

    db.run(`INSERT OR IGNORE INTO friendships (username, friend) VALUES (?, ?)`, [username, friend], (err3) => {
      if (err3) return res.status(400).json({ error: 'Could not add friend.' });
      res.json({ success: true });
    });
  });
});

app.post('/api/join-group', (req, res) => {
  const { username, groupName } = req.body;
  if (!username || !groupName) return res.status(400).json({ error: 'Missing group or user.' });

  db.run(`INSERT OR IGNORE INTO groups (group_name, username) VALUES (?, ?)`, [groupName.trim(), username], (err) => {
    if (err) return res.status(500).json({ error: 'Database error.' });
    res.json({ success: true });
  });
});

// Direct HTML fallback
app.get('*', (req, res) => {
  const indexPath = fs.existsSync(path.join(publicDir, 'index.html')) 
    ? path.join(publicDir, 'index.html') 
    : path.join(__dirname, 'index.html');
  res.sendFile(indexPath);
});

// Socket.io Real-Time Messaging & WebRTC Signaling
const activeUsers = {};

io.on('connection', (socket) => {
  socket.on('join_app', (username) => {
    activeUsers[username] = socket.id;
    socket.username = username;
  });

  socket.on('send_message', (data) => {
    db.run(
      `INSERT INTO messages (sender, recipient, is_group, content, file_url, filename) VALUES (?, ?, ?, ?, ?, ?)`,
      [data.sender, data.recipient, data.is_group ? 1 : 0, data.content, data.file_url, data.filename],
      (err) => {
        if (err) console.error('[Message Save Error]:', err.message);
      }
    );

    if (data.is_group) {
      io.to(data.recipient).emit('receive_message', data);
    } else {
      const recipientSocketId = activeUsers[data.recipient];
      if (recipientSocketId) io.to(recipientSocketId).emit('receive_message', data);
      socket.emit('receive_message', data);
    }
  });

  // WebRTC Signaling
  socket.on('call_user', (data) => {
    const recipientSocketId = activeUsers[data.userToCall];
    if (recipientSocketId) {
      io.to(recipientSocketId).emit('incoming_call', {
        signal: data.signalData,
        from: data.from,
        isGroup: data.isGroup
      });
    }
  });

  socket.on('answer_call', (data) => {
    const recipientSocketId = activeUsers[data.to];
    if (recipientSocketId) {
      io.to(recipientSocketId).emit('call_accepted', data.signal);
    }
  });

  socket.on('ice_candidate', (data) => {
    const recipientSocketId = activeUsers[data.to];
    if (recipientSocketId) {
      io.to(recipientSocketId).emit('ice_candidate', {
        candidate: data.candidate,
        from: data.from
      });
    }
  });

  socket.on('end_call_signal', (data) => {
    const recipientSocketId = activeUsers[data.to];
    if (recipientSocketId) {
      io.to(recipientSocketId).emit('call_ended');
    }
  });

  socket.on('join_group_room', (groupName) => socket.join(groupName));

  socket.on('disconnect', () => {
    if (socket.username && activeUsers[socket.username] === socket.id) {
      delete activeUsers[socket.username];
    }
  });
});

// Guard against unhandled process crashes
process.on('uncaughtException', (err) => {
  console.error('[Uncaught Exception]:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('[Unhandled Rejection]:', reason);
});

// Bind server to Host & Dynamic Port
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`land ki baatein running on http://0.0.0.0:${PORT}`);
});