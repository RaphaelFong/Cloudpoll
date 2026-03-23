const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// IN-MEMORY DATA STORE (replace with DynamoDB later)
// ============================================================
const sessions = {};

function generateCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// ============================================================
// REST API
// ============================================================

app.post('/api/sessions', (req, res) => {
  const { title, questions } = req.body;
  if (!title || !questions || questions.length === 0) {
    return res.status(400).json({ error: 'Title and at least one question required' });
  }
  const code = generateCode();
  sessions[code] = {
    code,
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
    participants: {},
    createdAt: Date.now(),
  };
  console.log(`[SESSION] Created "${title}" with code ${code} (${questions.length} questions)`);
  res.json({ code, session: sessions[code] });
});

app.get('/api/sessions/:code', (req, res) => {
  const session = sessions[req.params.code.toUpperCase()];
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const safe = {
    code: session.code,
    title: session.title,
    status: session.status,
    currentQ: session.currentQ,
    participantCount: Object.keys(session.participants).length,
    questions: session.questions.map(q => ({
      id: q.id, text: q.text, options: q.options, votes: q.votes,
    })),
  };
  res.json(safe);
});

app.get('/api/sessions', (req, res) => {
  const list = Object.values(sessions).map(s => ({
    code: s.code, title: s.title, status: s.status,
    participants: Object.keys(s.participants).length,
    questions: s.questions.length,
  }));
  res.json(list);
});

// ============================================================
// SOCKET.IO - REAL-TIME
// ============================================================
io.on('connection', (socket) => {
  console.log(`[SOCKET] Connected: ${socket.id}`);

  socket.on('join-session', ({ code, name }) => {
    const session = sessions[code.toUpperCase()];
    if (!session) return socket.emit('error-msg', { message: 'Session not found' });

    session.participants[socket.id] = { name, score: 0 };
    socket.join(code);
    socket.sessionCode = code;
    socket.playerName = name;

    console.log(`[JOIN] ${name} joined ${code} (${Object.keys(session.participants).length} players)`);

    io.to(code).emit('participants-updated', {
      participants: Object.values(session.participants),
      count: Object.keys(session.participants).length,
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
  });

  socket.on('presenter-join', ({ code }) => {
    const session = sessions[code.toUpperCase()];
    if (!session) return socket.emit('error-msg', { message: 'Session not found' });
    socket.join(code);
    socket.sessionCode = code;
    socket.isPresenter = true;
    console.log(`[PRESENTER] Joined room ${code}`);
  });

  socket.on('next-question', ({ code }) => {
    const session = sessions[code.toUpperCase()];
    if (!session) return;

    session.currentQ++;
    if (session.currentQ >= session.questions.length) {
      session.status = 'finished';
      const leaderboard = Object.values(session.participants)
        .sort((a, b) => b.score - a.score)
        .map((p, i) => ({ rank: i + 1, name: p.name, score: p.score }));
      io.to(code).emit('session-finished', { leaderboard });
      console.log(`[SESSION] ${code} finished`);
      return;
    }

    session.status = 'active';
    const q = session.questions[session.currentQ];
    q.votes = new Array(q.options.length).fill(0);

    io.to(code).emit('question-started', {
      questionIndex: session.currentQ,
      totalQuestions: session.questions.length,
      text: q.text, options: q.options,
    });
    console.log(`[QUESTION] ${code} -> Q${session.currentQ + 1}: ${q.text}`);
  });

  socket.on('submit-vote', ({ code, questionIndex, optionIndex }) => {
    const session = sessions[code.toUpperCase()];
    if (!session) return;
    if (session.currentQ !== questionIndex) return;

    const q = session.questions[questionIndex];
    if (optionIndex < 0 || optionIndex >= q.options.length) return;

    q.votes[optionIndex]++;

    const participant = session.participants[socket.id];
    if (participant && optionIndex === q.correctIndex) {
      participant.score += 100;
    }

    io.to(code).emit('votes-updated', {
      questionIndex, votes: q.votes,
      totalVotes: q.votes.reduce((a, b) => a + b, 0),
    });

    socket.emit('vote-result', {
      correct: optionIndex === q.correctIndex,
      correctIndex: q.correctIndex,
      score: participant ? participant.score : 0,
    });

    console.log(`[VOTE] ${socket.playerName || socket.id} voted option ${optionIndex} for Q${questionIndex + 1} in ${code}`);
  });

  socket.on('reveal-answer', ({ code }) => {
    const session = sessions[code.toUpperCase()];
    if (!session || session.currentQ < 0) return;
    const q = session.questions[session.currentQ];
    io.to(code).emit('answer-revealed', {
      questionIndex: session.currentQ,
      correctIndex: q.correctIndex,
      votes: q.votes,
    });
  });

  socket.on('disconnect', () => {
    if (socket.sessionCode) {
      const session = sessions[socket.sessionCode];
      if (session && session.participants[socket.id]) {
        const name = session.participants[socket.id].name;
        delete session.participants[socket.id];
        io.to(socket.sessionCode).emit('participants-updated', {
          participants: Object.values(session.participants),
          count: Object.keys(session.participants).length,
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
  console.log(`  Home:      http://localhost:${PORT}/`);
  console.log(`  Presenter: http://localhost:${PORT}/presenter`);
  console.log(`  Play:      http://localhost:${PORT}/play`);
  console.log(`========================================\n`);
});
