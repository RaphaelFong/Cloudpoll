const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, GetCommand, UpdateCommand, ScanCommand, DeleteCommand } = require('@aws-sdk/lib-dynamodb');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// DYNAMODB SETUP
// ============================================================
const dbClient = new DynamoDBClient({ region: 'us-east-1' });
const db = DynamoDBDocumentClient.from(dbClient);
const TABLE_NAME = 'CloudPoll-Sessions';

// In-memory participant tracking (socket connections are ephemeral anyway)
const liveParticipants = {}; // sessionCode -> { socketId: { name, score } }

function generateCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// ============================================================
// DYNAMODB HELPERS
// ============================================================

async function createSession(code, title, questions) {
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
    createdAt: Date.now(),
  };
  await db.send(new PutCommand({ TableName: TABLE_NAME, Item: session }));
  return session;
}

async function getSession(code) {
  const result = await db.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { sessionCode: code },
  }));
  return result.Item || null;
}

async function updateSession(code, updates) {
  // Build update expression dynamically
  const keys = Object.keys(updates);
  const expression = 'SET ' + keys.map((k, i) => `#k${i} = :v${i}`).join(', ');
  const names = {};
  const values = {};
  keys.forEach((k, i) => {
    names[`#k${i}`] = k;
    values[`:v${i}`] = updates[k];
  });
  await db.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { sessionCode: code },
    UpdateExpression: expression,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  }));
}

async function listSessions() {
  const result = await db.send(new ScanCommand({ TableName: TABLE_NAME }));
  return result.Items || [];
}

// ============================================================
// REST API
// ============================================================

app.post('/api/sessions', async (req, res) => {
  try {
    const { title, questions } = req.body;
    if (!title || !questions || questions.length === 0) {
      return res.status(400).json({ error: 'Title and at least one question required' });
    }
    const code = generateCode();
    const session = await createSession(code, title, questions);
    liveParticipants[code] = {};
    console.log(`[SESSION] Created "${title}" with code ${code} (${questions.length} questions) -> DynamoDB`);
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

  socket.on('join-session', async ({ code, name }) => {
    try {
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

  socket.on('presenter-join', async ({ code }) => {
    try {
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

      // Reset votes for this question
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

      // Update votes in DynamoDB
      const questions = session.questions;
      questions[questionIndex].votes[optionIndex]++;
      await updateSession(upperCode, { questions });

      // Update participant score in memory
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
app.get('/presenter', (req, res) => res.sendFile(path.join(__dirname, 'public', 'presenter.html')));
app.get('/play', (req, res) => res.sendFile(path.join(__dirname, 'public', 'play.html')));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n========================================`);
  console.log(`  CloudPoll server running!`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  `);
  console.log(`  Using DynamoDB table: ${TABLE_NAME}`);
  console.log(`  Region: us-east-1`);
  console.log(`========================================\n`);
});