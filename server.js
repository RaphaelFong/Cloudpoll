const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, GetCommand, UpdateCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// CONFIG
// ============================================================
const JWT_SECRET = process.env.JWT_SECRET || 'cloudpoll-secret-key-change-in-production';
const JWT_EXPIRY = '24h';

// ============================================================
// DYNAMODB SETUP
// ============================================================
const dbClient = new DynamoDBClient({ region: 'us-east-1' });
const db = DynamoDBDocumentClient.from(dbClient);
const SESSIONS_TABLE = 'CloudPoll-Sessions';
const USERS_TABLE = 'CloudPoll-Users';

// In-memory participant tracking (socket connections are ephemeral)
const liveParticipants = {};

function generateCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// ============================================================
// AUTH HELPERS
// ============================================================

async function createUser(username, password) {
  // Check if user already exists
  const existing = await db.send(new GetCommand({
    TableName: USERS_TABLE,
    Key: { username },
  }));
  if (existing.Item) {
    return { error: 'Username already taken' };
  }

  const hashedPassword = await bcrypt.hash(password, 10);
  await db.send(new PutCommand({
    TableName: USERS_TABLE,
    Item: {
      username,
      password: hashedPassword,
      createdAt: Date.now(),
    },
  }));
  return { success: true };
}

async function loginUser(username, password) {
  const result = await db.send(new GetCommand({
    TableName: USERS_TABLE,
    Key: { username },
  }));
  if (!result.Item) {
    return { error: 'User not found' };
  }
  const valid = await bcrypt.compare(password, result.Item.password);
  if (!valid) {
    return { error: 'Invalid password' };
  }
  const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
  return { token, username };
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return null;
  }
}

// Middleware to protect API routes
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }
  const token = authHeader.split(' ')[1];
  const decoded = verifyToken(token);
  if (!decoded) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  req.user = decoded;
  next();
}

// ============================================================
// DYNAMODB SESSION HELPERS
// ============================================================

async function createSession(code, title, questions, createdBy) {
  const session = {
    sessionCode: code,
    title,
    questions: questions.map((q, i) => ({
      id: i,
      text: q.text,
      options: q.options,
      correctIndex: q.correctIndex,
      votes: new Array(q.options.length).fill(0),
    })),
    currentQ: -1,
    status: 'lobby',
    createdBy,
    createdAt: Date.now(),
  };
  await db.send(new PutCommand({ TableName: SESSIONS_TABLE, Item: session }));
  return session;
}

async function getSession(code) {
  const result = await db.send(new GetCommand({
    TableName: SESSIONS_TABLE,
    Key: { sessionCode: code },
  }));
  return result.Item || null;
}

async function updateSession(code, updates) {
  const keys = Object.keys(updates);
  const expression = 'SET ' + keys.map((k, i) => `#k${i} = :v${i}`).join(', ');
  const names = {};
  const values = {};
  keys.forEach((k, i) => {
    names[`#k${i}`] = k;
    values[`:v${i}`] = updates[k];
  });
  await db.send(new UpdateCommand({
    TableName: SESSIONS_TABLE,
    Key: { sessionCode: code },
    UpdateExpression: expression,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  }));
}

async function listSessions() {
  const result = await db.send(new ScanCommand({ TableName: SESSIONS_TABLE }));
  return result.Items || [];
}

// ============================================================
// AUTH API ROUTES
// ============================================================

app.post('/api/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    if (username.length < 3) {
      return res.status(400).json({ error: 'Username must be at least 3 characters' });
    }
    if (password.length < 4) {
      return res.status(400).json({ error: 'Password must be at least 4 characters' });
    }
    const result = await createUser(username.toLowerCase(), password);
    if (result.error) {
      return res.status(400).json({ error: result.error });
    }
    // Auto-login after registration
    const loginResult = await loginUser(username.toLowerCase(), password);
    console.log(`[AUTH] New user registered: ${username}`);
    res.json(loginResult);
  } catch (err) {
    console.error('[ERROR] Register:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    const result = await loginUser(username.toLowerCase(), password);
    if (result.error) {
      return res.status(401).json({ error: result.error });
    }
    console.log(`[AUTH] User logged in: ${username}`);
    res.json(result);
  } catch (err) {
    console.error('[ERROR] Login:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Check if token is valid
app.get('/api/me', requireAuth, (req, res) => {
  res.json({ username: req.user.username });
});

// ============================================================
// SESSION API ROUTES (protected)
// ============================================================

app.post('/api/sessions', requireAuth, async (req, res) => {
  try {
    const { title, questions } = req.body;
    if (!title || !questions || questions.length === 0) {
      return res.status(400).json({ error: 'Title and at least one question required' });
    }
    const code = generateCode();
    const session = await createSession(code, title, questions, req.user.username);
    liveParticipants[code] = {};
    console.log(`[SESSION] Created "${title}" by ${req.user.username} with code ${code} (${questions.length} questions) -> DynamoDB`);
    res.json({ code, session });
  } catch (err) {
    console.error('[ERROR] Create session:', err);
    res.status(500).json({ error: 'Failed to create session' });
  }
});

app.get('/api/sessions/:code', async (req, res) => {
  try {
    const session = await getSession(req.params.code.toUpperCase());
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const participants = liveParticipants[session.sessionCode] || {};
    const safe = {
      code: session.sessionCode,
      title: session.title,
      status: session.status,
      currentQ: session.currentQ,
      participantCount: Object.keys(participants).length,
      questions: session.questions.map(q => ({
        id: q.id, text: q.text, options: q.options, votes: q.votes,
      })),
    };
    res.json(safe);
  } catch (err) {
    console.error('[ERROR] Get session:', err);
    res.status(500).json({ error: 'Failed to get session' });
  }
});

app.get('/api/sessions', async (req, res) => {
  try {
    const sessions = await listSessions();
    const list = sessions.map(s => ({
      code: s.sessionCode, title: s.title, status: s.status,
      participants: Object.keys(liveParticipants[s.sessionCode] || {}).length,
      questions: s.questions.length,
    }));
    res.json(list);
  } catch (err) {
    console.error('[ERROR] List sessions:', err);
    res.status(500).json({ error: 'Failed to list sessions' });
  }
});

// ============================================================
// SOCKET.IO - REAL-TIME
// ============================================================
io.on('connection', (socket) => {
  console.log(`[SOCKET] Connected: ${socket.id}`);

  // Authenticate socket connection
  socket.on('authenticate', ({ token }) => {
    const decoded = verifyToken(token);
    if (decoded) {
      socket.username = decoded.username;
      socket.emit('authenticated', { username: decoded.username });
    } else {
      socket.emit('error-msg', { message: 'Invalid token' });
    }
  });

  socket.on('join-session', async ({ code, name, token }) => {
    try {
      // Verify token
      if (token) {
        const decoded = verifyToken(token);
        if (!decoded) return socket.emit('error-msg', { message: 'Invalid token. Please log in again.' });
        name = decoded.username; // Use the logged-in username
      } else {
        return socket.emit('error-msg', { message: 'Please log in first' });
      }

      const upperCode = code.toUpperCase();
      const session = await getSession(upperCode);
      if (!session) return socket.emit('error-msg', { message: 'Session not found' });

      if (!liveParticipants[upperCode]) liveParticipants[upperCode] = {};
      liveParticipants[upperCode][socket.id] = { name, score: 0 };
      socket.join(upperCode);
      socket.sessionCode = upperCode;
      socket.playerName = name;

      const participants = liveParticipants[upperCode];
      console.log(`[JOIN] ${name} joined ${upperCode} (${Object.keys(participants).length} players)`);

      io.to(upperCode).emit('participants-updated', {
        participants: Object.values(participants),
        count: Object.keys(participants).length,
      });

      if (session.status === 'active' && session.currentQ >= 0) {
        const q = session.questions[session.currentQ];
        socket.emit('question-started', {
          questionIndex: session.currentQ,
          totalQuestions: session.questions.length,
          text: q.text, options: q.options,
        });
      }

      socket.emit('joined-session', { title: session.title, status: session.status });
    } catch (err) {
      console.error('[ERROR] join-session:', err);
      socket.emit('error-msg', { message: 'Server error' });
    }
  });

  socket.on('presenter-join', async ({ code, token }) => {
    try {
      if (token) {
        const decoded = verifyToken(token);
        if (!decoded) return socket.emit('error-msg', { message: 'Invalid token' });
      }
      const upperCode = code.toUpperCase();
      const session = await getSession(upperCode);
      if (!session) return socket.emit('error-msg', { message: 'Session not found' });
      socket.join(upperCode);
      socket.sessionCode = upperCode;
      socket.isPresenter = true;
      if (!liveParticipants[upperCode]) liveParticipants[upperCode] = {};
      console.log(`[PRESENTER] Joined room ${upperCode}`);
    } catch (err) {
      console.error('[ERROR] presenter-join:', err);
    }
  });

  socket.on('next-question', async ({ code }) => {
    try {
      const upperCode = code.toUpperCase();
      const session = await getSession(upperCode);
      if (!session) return;

      const nextQ = session.currentQ + 1;
      if (nextQ >= session.questions.length) {
        await updateSession(upperCode, { status: 'finished', currentQ: nextQ });
        const participants = liveParticipants[upperCode] || {};
        const leaderboard = Object.values(participants)
          .sort((a, b) => b.score - a.score)
          .map((p, i) => ({ rank: i + 1, name: p.name, score: p.score }));
        io.to(upperCode).emit('session-finished', { leaderboard });
        console.log(`[SESSION] ${upperCode} finished`);
        return;
      }

      const questions = session.questions;
      questions[nextQ].votes = new Array(questions[nextQ].options.length).fill(0);

      await updateSession(upperCode, {
        status: 'active',
        currentQ: nextQ,
        questions: questions,
      });

      const q = questions[nextQ];
      io.to(upperCode).emit('question-started', {
        questionIndex: nextQ,
        totalQuestions: questions.length,
        text: q.text, options: q.options,
      });
      console.log(`[QUESTION] ${upperCode} -> Q${nextQ + 1}: ${q.text}`);
    } catch (err) {
      console.error('[ERROR] next-question:', err);
    }
  });

  socket.on('submit-vote', async ({ code, questionIndex, optionIndex }) => {
    try {
      const upperCode = code.toUpperCase();
      const session = await getSession(upperCode);
      if (!session) return;
      if (session.currentQ !== questionIndex) return;

      const q = session.questions[questionIndex];
      if (optionIndex < 0 || optionIndex >= q.options.length) return;

      const questions = session.questions;
      questions[questionIndex].votes[optionIndex]++;
      await updateSession(upperCode, { questions });

      const participants = liveParticipants[upperCode] || {};
      const participant = participants[socket.id];
      if (participant && optionIndex === q.correctIndex) {
        participant.score += 100;
      }

      io.to(upperCode).emit('votes-updated', {
        questionIndex,
        votes: questions[questionIndex].votes,
        totalVotes: questions[questionIndex].votes.reduce((a, b) => a + b, 0),
      });

      socket.emit('vote-result', {
        correct: optionIndex === q.correctIndex,
        correctIndex: q.correctIndex,
        score: participant ? participant.score : 0,
      });

      console.log(`[VOTE] ${socket.playerName || socket.id} voted option ${optionIndex} for Q${questionIndex + 1} in ${upperCode}`);
    } catch (err) {
      console.error('[ERROR] submit-vote:', err);
    }
  });

  socket.on('reveal-answer', async ({ code }) => {
    try {
      const upperCode = code.toUpperCase();
      const session = await getSession(upperCode);
      if (!session || session.currentQ < 0) return;
      const q = session.questions[session.currentQ];
      io.to(upperCode).emit('answer-revealed', {
        questionIndex: session.currentQ,
        correctIndex: q.correctIndex,
        votes: q.votes,
      });
    } catch (err) {
      console.error('[ERROR] reveal-answer:', err);
    }
  });

  socket.on('disconnect', () => {
    if (socket.sessionCode) {
      const participants = liveParticipants[socket.sessionCode];
      if (participants && participants[socket.id]) {
        const name = participants[socket.id].name;
        delete participants[socket.id];
        io.to(socket.sessionCode).emit('participants-updated', {
          participants: Object.values(participants),
          count: Object.keys(participants).length,
        });
        console.log(`[LEFT] ${name} left ${socket.sessionCode}`);
      }
    }
  });
});

// ============================================================
// SERVE PAGES
// ============================================================
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/register', (req, res) => res.sendFile(path.join(__dirname, 'public', 'register.html')));
app.get('/presenter', (req, res) => res.sendFile(path.join(__dirname, 'public', 'presenter.html')));
app.get('/play', (req, res) => res.sendFile(path.join(__dirname, 'public', 'play.html')));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n========================================`);
  console.log(`  CloudPoll server running!`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  `);
  console.log(`  Using DynamoDB tables:`);
  console.log(`    Sessions: ${SESSIONS_TABLE}`);
  console.log(`    Users:    ${USERS_TABLE}`);
  console.log(`  Region: us-east-1`);
  console.log(`  Auth: JWT (${JWT_EXPIRY} expiry)`);
  console.log(`========================================\n`);
});
