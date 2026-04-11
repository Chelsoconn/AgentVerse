const express = require('express');
const session = require('express-session');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const path = require('path');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const Anthropic = require('@anthropic-ai/sdk');
const { pool, init, withUser } = require('./db');

const anthropic = new Anthropic();
const MAX_ITERATIONS = 3;

// Hard block list — obvious red-flag terms that get an instant rejection
const BLOCKED_TERMS = [
  'kill', 'murder', 'suicide', 'gun ', 'shoot person', 'shoot people', 'shoot a person',
  'shoot kid', 'shoot child', 'blood', 'gore', 'rape', 'sex', 'porn', 'nude', 'naked',
  'drug', 'cocaine', 'heroin', 'meth', 'weed', 'beer', 'alcohol', 'vodka', 'whiskey',
  'nazi', 'racist', 'slur', 'gambling', 'betting', 'casino',
];

function checkPromptSafety(prompt) {
  const lower = prompt.toLowerCase();
  for (const term of BLOCKED_TERMS) {
    if (lower.includes(term)) return { ok: false, reason: term };
  }
  return { ok: true };
}

const GAME_SYSTEM_PROMPT = `You are a SAFE, kid-friendly game generator for an educational app for children ages 8-12. Your only job is to make tiny, wholesome HTML games.

ABSOLUTE SAFETY RULES (NEVER BREAK THESE):
- ONLY make games. If the user asks for anything that isn't a small, simple game (a website, a chat, an essay, an image, etc.), politely refuse by outputting a tiny HTML page that says "Oh no! I can only make small games. Try asking for a game like 'a clicker game with cats'!"
- NEVER include realistic weapons (guns, knives, bombs, swords used to hurt people). Robot battles, laser blasters with cartoon robots, water balloons, snowballs, and bubble shooters are OK. NO depictions of harming humans, animals, or anything realistic.
- NEVER include blood, gore, scary horror imagery, jump scares, drugs, alcohol, gambling, romance, or any adult themes.
- NEVER include real-world violence, hate speech, slurs, politics, or anything a parent would find inappropriate for an 8-12 year old.
- If the user's request is borderline, ALWAYS make a wholesome, friendly version. (Example: "shooting game" → silly bubble-popper or robot-vs-robot laser game with cartoon explosions.)
- If the user request is clearly inappropriate, output ONLY this HTML:
<!DOCTYPE html><html><head><style>body{font-family:sans-serif;background:#fff3e0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center;padding:20px}div{max-width:400px}h1{color:#e65100}p{color:#5d4037}</style></head><body><div><h1>Oh no! 🙈</h1><p>I can only make fun, kid-friendly games. Try asking for something like:</p><p><strong>"a snake game with crocodiles"</strong> or <strong>"a clicker game with cats"</strong>!</p></div></body></html>

GAME RULES:
- Games must be SMALL and SIMPLE — single screen, one core mechanic, under 300 lines of code total
- Output ONLY a complete HTML document starting with <!DOCTYPE html> and ending with </html>
- NO markdown code fences (no \`\`\`html)
- NO external resources: no <script src="...">, no <link rel="stylesheet">, no images from URLs, no fetch/XMLHttpRequest
- ALL CSS inline in <style>, ALL JS inline in <script>
- Use bright colors, gradients, and emoji characters for visuals
- Make it instantly playable on load
- Center the game on the screen and make it look polished
- Support both keyboard and mouse/touch controls where it makes sense

INSTRUCTIONS REQUIREMENT (CRITICAL):
The very first line of your output MUST be an HTML comment containing kid-friendly directions, in this exact format:
<!--INSTRUCTIONS: Goal: <one sentence about what to do>. Controls: <how to play, e.g. "Use arrow keys to move, spacebar to jump">. Win: <how to win or score>.-->
Then on the next line, start <!DOCTYPE html>. The instructions comment is REQUIRED on every response. Keep it under 250 characters. Use simple words a kid can read.

Output the instructions comment + HTML document and NOTHING ELSE — no explanations, no preamble.`;

const app = express();
const PORT = process.env.PORT || 3001;
const isProd = process.env.NODE_ENV === 'production';

// Heroku puts the app behind a TLS-terminating proxy. We must trust it so
// secure cookies and req.protocol work correctly.
if (isProd) app.set('trust proxy', 1);

app.use(cors({ origin: (o, cb) => cb(null, true), credentials: true }));
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'kids-ai-lab-2026-dev-only',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 86400000,
    secure: isProd,
    sameSite: isProd ? 'lax' : undefined,
  },
}));

function auth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  next();
}

// Helper: run a query against the public pool (no RLS user context)
async function pq(text, params) { return (await pool.query(text, params)).rows; }
async function pq1(text, params) { return (await pool.query(text, params)).rows[0]; }

// ================== AUTH ==================
app.post('/api/register', async (req, res) => {
  try {
    const { username, password, displayName, age, theme } = req.body;
    if (!username || !password || !displayName || !age) return res.status(400).json({ error: 'All fields required' });
    const count = (await pq1('SELECT COUNT(*)::int AS c FROM users')).c;
    if (count >= 10) return res.status(400).json({ error: 'Max 10 users reached' });
    if (await pq1('SELECT id FROM users WHERE username = $1', [username])) return res.status(400).json({ error: 'Username taken' });
    const themeRow = await pq1('SELECT id FROM themes WHERE code = $1', [theme || 'crocodile']);
    if (!themeRow) return res.status(400).json({ error: 'Invalid theme' });
    const hash = bcrypt.hashSync(password, 10);
    const u = await pq1(
      'INSERT INTO users (username,password_hash,display_name,age,theme_id) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [username, hash, displayName, age, themeRow.id]
    );
    // Init XP row (uses RLS context)
    await withUser(u.id, c => c.query('INSERT INTO user_xp (user_id,xp,level,streak) VALUES ($1,0,1,0)', [u.id]));
    req.session.userId = u.id;
    res.json({ id: u.id, displayName, theme: theme || 'crocodile' });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const u = await pq1('SELECT u.*, t.code AS theme_code FROM users u LEFT JOIN themes t ON t.id = u.theme_id WHERE username = $1', [username]);
    if (!u || !bcrypt.compareSync(password, u.password_hash)) return res.status(401).json({ error: 'Wrong username or password' });
    req.session.userId = u.id;
    // Ensure XP row exists
    const exists = await withUser(u.id, async c => (await c.query('SELECT id FROM user_xp WHERE user_id = $1', [u.id])).rows[0]);
    if (!exists) await withUser(u.id, c => c.query('INSERT INTO user_xp (user_id,xp,level,streak) VALUES ($1,0,1,0)', [u.id]));
    res.json({ id: u.id, displayName: u.display_name, theme: u.theme_code });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/logout', (req, res) => { req.session.destroy(); res.json({ ok: true }); });

app.get('/api/me', auth, async (req, res) => {
  try {
    const data = await withUser(req.session.userId, async c => {
      const u = (await c.query(
        'SELECT u.id, u.username, u.display_name, u.age, u.active_background, u.active_background_emojis, u.active_background_animation, t.code AS theme FROM users u LEFT JOIN themes t ON t.id = u.theme_id WHERE u.id = $1',
        [req.session.userId]
      )).rows[0];
      if (!u) return null;
      const xp = (await c.query('SELECT xp, level, streak, tokens FROM user_xp WHERE user_id = $1', [req.session.userId])).rows[0] || { xp: 0, level: 1, streak: 0, tokens: 0 };
      return { ...u, ...xp };
    });
    if (!data) return res.status(401).json({ error: 'Not found' });
    res.json(data);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.put('/api/me/theme', auth, async (req, res) => {
  try {
    const { theme } = req.body;
    const t = await pq1('SELECT id FROM themes WHERE code = $1', [theme]);
    if (!t) return res.status(400).json({ error: 'Invalid theme' });
    await withUser(req.session.userId, c => c.query('UPDATE users SET theme_id = $1 WHERE id = $2', [t.id, req.session.userId]));
    res.json({ theme });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// ================== THEMES (public) ==================
app.get('/api/themes', auth, async (req, res) => {
  try {
    const themes = await pq('SELECT * FROM themes ORDER BY id');
    for (const t of themes) {
      t.decorations = (await pq('SELECT emoji FROM theme_decorations WHERE theme_id = $1 ORDER BY sort_order', [t.id])).map(r => r.emoji);
    }
    res.json(themes);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// ================== CONTENT ==================
app.get('/api/categories', auth, async (req, res) => {
  try {
    const result = await withUser(req.session.userId, async c => {
      const cats = (await c.query('SELECT * FROM categories ORDER BY sort_order')).rows;
      let prevComplete = true;
      for (const cat of cats) {
        const lessons = (await c.query('SELECT id FROM lessons WHERE category_id = $1', [cat.id])).rows;
        const lessonIds = lessons.map(l => l.id);
        const completedCount = lessonIds.length === 0 ? 0 :
          (await c.query('SELECT COUNT(*)::int AS c FROM user_lesson_progress WHERE lesson_id = ANY($1::int[]) AND completed = true', [lessonIds])).rows[0].c;
        cat.totalLessons = lessons.length;
        cat.completedLessons = completedCount;
        cat.isComplete = lessons.length > 0 && completedCount === lessons.length;
        cat.isUnlocked = prevComplete;
        prevComplete = cat.isComplete;
      }
      return cats;
    });
    res.json(result);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/categories/:id/lessons', auth, async (req, res) => {
  try {
    const result = await withUser(req.session.userId, async c => {
      const lessons = (await c.query('SELECT * FROM lessons WHERE category_id = $1 ORDER BY sort_order', [req.params.id])).rows;
      for (const l of lessons) {
        const p = (await c.query('SELECT completed FROM user_lesson_progress WHERE lesson_id = $1', [l.id])).rows[0];
        l.completed = p ? p.completed : false;
      }
      return lessons;
    });
    res.json(result);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// ================== ACTIVITIES ==================
app.get('/api/lessons/:id/activities', auth, async (req, res) => {
  try {
    const result = await withUser(req.session.userId, async c => {
      const acts = (await c.query('SELECT * FROM activities WHERE lesson_id = $1 ORDER BY sort_order', [req.params.id])).rows;
      for (const a of acts) {
        a.userScore = (await c.query('SELECT score, max_score FROM user_activity_scores WHERE activity_id = $1', [a.id])).rows[0] || null;
        if (a.activity_type === 'match') a.pairs = (await c.query('SELECT * FROM activity_match_pairs WHERE activity_id = $1 ORDER BY sort_order', [a.id])).rows;
        else if (a.activity_type === 'sort' || a.activity_type === 'codebuilder') a.items = (await c.query('SELECT * FROM activity_sort_items WHERE activity_id = $1 ORDER BY correct_position', [a.id])).rows;
        else if (a.activity_type === 'truefalse') a.items = (await c.query('SELECT * FROM activity_truefalse_items WHERE activity_id = $1 ORDER BY sort_order', [a.id])).rows;
        else if (a.activity_type === 'fillinblank') {
          a.blanks = (await c.query('SELECT * FROM activity_blanks WHERE activity_id = $1 ORDER BY sort_order', [a.id])).rows;
          for (const b of a.blanks) {
            b.options = (await c.query('SELECT option_text FROM activity_blank_options WHERE blank_id = $1 ORDER BY sort_order', [b.id])).rows.map(r => r.option_text);
          }
        }
        else if (a.activity_type === 'codechallenge') a.challenges = (await c.query('SELECT * FROM activity_code_challenges WHERE activity_id = $1 ORDER BY sort_order', [a.id])).rows;
      }
      return acts;
    });
    res.json(result);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/activities/:id/score', auth, async (req, res) => {
  try {
    const { score, maxScore } = req.body;
    const uid = req.session.userId;
    const result = await withUser(uid, async c => {
      const ex = (await c.query('SELECT id, score FROM user_activity_scores WHERE activity_id = $1', [req.params.id])).rows[0];
      const previousScore = ex ? ex.score : 0;
      const delta = Math.max(0, score - previousScore);

      if (ex) {
        if (score > ex.score) await c.query('UPDATE user_activity_scores SET score = $1, max_score = $2, completed_at = NOW() WHERE id = $3', [score, maxScore, ex.id]);
      } else {
        await c.query('INSERT INTO user_activity_scores (user_id, activity_id, score, max_score) VALUES ($1, $2, $3, $4)', [uid, req.params.id, score, maxScore]);
      }

      const xpGain = delta * 10;
      const xr = (await c.query('SELECT id, xp, streak FROM user_xp')).rows[0];
      const isPerfect = score === maxScore;
      const newStreak = isPerfect ? (xr ? xr.streak : 0) + 1 : 0;
      const totalXp = (xr ? xr.xp : 0) + xpGain;
      const newLevel = Math.floor(totalXp / 100) + 1;
      if (xr) await c.query('UPDATE user_xp SET xp = $1, level = $2, streak = $3 WHERE id = $4', [totalXp, newLevel, newStreak, xr.id]);
      else await c.query('INSERT INTO user_xp (user_id, xp, level, streak) VALUES ($1, $2, $3, $4)', [uid, totalXp, newLevel, newStreak]);

      // Auto-complete the lesson if it has no quizzes and all non-video activities have a score
      const act = (await c.query('SELECT lesson_id FROM activities WHERE id = $1', [req.params.id])).rows[0];
      let lessonCompleted = false;
      if (act) {
        const quizCount = (await c.query('SELECT COUNT(*)::int AS c FROM quizzes WHERE lesson_id = $1', [act.lesson_id])).rows[0].c;
        if (quizCount === 0) {
          const totalActs = (await c.query("SELECT COUNT(*)::int AS c FROM activities WHERE lesson_id = $1 AND activity_type != 'video'", [act.lesson_id])).rows[0].c;
          const doneActs = (await c.query("SELECT COUNT(*)::int AS c FROM user_activity_scores s JOIN activities a ON a.id = s.activity_id WHERE a.lesson_id = $1 AND a.activity_type != 'video'", [act.lesson_id])).rows[0].c;
          if (doneActs >= totalActs && totalActs > 0) {
            const p = (await c.query('SELECT id FROM user_lesson_progress WHERE lesson_id = $1', [act.lesson_id])).rows[0];
            if (p) await c.query('UPDATE user_lesson_progress SET completed = true, completed_at = NOW() WHERE id = $1', [p.id]);
            else await c.query('INSERT INTO user_lesson_progress (user_id, lesson_id, completed, completed_at) VALUES ($1, $2, true, NOW())', [uid, act.lesson_id]);
            lessonCompleted = true;
          }
        }
      }

      return { xpGained: xpGain, streak: newStreak, lessonCompleted };
    });
    res.json(result);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// ================== PYTHON RUNNER ==================
app.post('/api/run-python', auth, (req, res) => {
  const { code } = req.body;
  if (!code || code.length > 2000) return res.status(400).json({ error: 'Code too long or empty' });
  const blocked = ['import os','import sys','import subprocess','open(','__import__','eval(','exec(','import shutil','import socket'];
  const lower = code.toLowerCase();
  for (const b of blocked) {
    if (lower.includes(b)) return res.json({ output: '', error: 'For safety, ' + b + ' is not allowed. Stick to print, variables, loops, and if/else!' });
  }
  const tmpFile = path.join(os.tmpdir(), 'kidscode_' + req.session.userId + '_' + Date.now() + '.py');
  fs.writeFileSync(tmpFile, code);
  execFile('python3', [tmpFile], { timeout: 5000, maxBuffer: 10240 }, (err, stdout, stderr) => {
    fs.unlink(tmpFile, () => {});
    if (err) {
      if (err.killed) return res.json({ output: '', error: 'Code took too long! Make sure your loop ends.' });
      const errMsg = stderr || err.message;
      const lastLine = errMsg.split('\n').filter(l => l.trim()).pop() || 'Something went wrong';
      return res.json({ output: stdout || '', error: '🐛 Bug found: ' + lastLine });
    }
    res.json({ output: stdout, error: '' });
  });
});

// ================== QUIZZES ==================
app.get('/api/lessons/:id/quizzes', auth, async (req, res) => {
  try {
    const result = await withUser(req.session.userId, async c => {
      const qs = (await c.query('SELECT * FROM quizzes WHERE lesson_id = $1 ORDER BY sort_order', [req.params.id])).rows;
      for (const q of qs) {
        q.choices = (await c.query('SELECT id, choice_text, sort_order FROM quiz_choices WHERE quiz_id = $1 ORDER BY sort_order', [q.id])).rows;
        q.userAnswer = (await c.query('SELECT selected_choice_id, is_correct FROM user_quiz_answers WHERE quiz_id = $1', [q.id])).rows[0] || null;
      }
      return qs;
    });
    res.json(result);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/quizzes/:id/answer', auth, async (req, res) => {
  try {
    const uid = req.session.userId;
    const result = await withUser(uid, async c => {
      const quiz = (await c.query('SELECT * FROM quizzes WHERE id = $1', [req.params.id])).rows[0];
      if (!quiz) return { error: 'Not found' };
      const choice = (await c.query('SELECT * FROM quiz_choices WHERE id = $1 AND quiz_id = $2', [req.body.choiceId, quiz.id])).rows[0];
      if (!choice) return { error: 'Invalid' };

      const ex = (await c.query('SELECT id, is_correct, attempts, tokens_awarded FROM user_quiz_answers WHERE quiz_id = $1', [quiz.id])).rows[0];
      const wasAlreadyCorrect = ex && ex.is_correct;
      const newAttempts = ex ? ex.attempts + 1 : 1;

      // Token reward schedule: 1st try=5, 2nd=3, 3rd=2, 4th=1, 5th+=0
      const tokenSchedule = [5, 3, 2, 1, 0];
      let tokensEarned = 0;
      if (choice.is_correct && !wasAlreadyCorrect) {
        tokensEarned = newAttempts <= tokenSchedule.length ? tokenSchedule[newAttempts - 1] : 0;
      }

      if (ex) {
        await c.query(
          'UPDATE user_quiz_answers SET selected_choice_id = $1, is_correct = $2, attempts = $3, tokens_awarded = tokens_awarded + $4, answered_at = NOW() WHERE id = $5',
          [choice.id, choice.is_correct, newAttempts, tokensEarned, ex.id]
        );
      } else {
        await c.query(
          'INSERT INTO user_quiz_answers (user_id, quiz_id, selected_choice_id, is_correct, attempts, tokens_awarded) VALUES ($1, $2, $3, $4, $5, $6)',
          [uid, quiz.id, choice.id, choice.is_correct, 1, tokensEarned]
        );
      }

      // Update tokens, XP, streak in user_xp
      if (choice.is_correct && !wasAlreadyCorrect) {
        const xr = (await c.query('SELECT id, xp, streak, tokens FROM user_xp')).rows[0];
        if (xr) {
          const nx = xr.xp + 15;
          const ns = xr.streak + 1;
          const nt = xr.tokens + tokensEarned;
          await c.query('UPDATE user_xp SET xp = $1, level = $2, streak = $3, tokens = $4 WHERE id = $5', [nx, Math.floor(nx / 100) + 1, ns, nt, xr.id]);
        }
      } else if (!choice.is_correct) {
        await c.query('UPDATE user_xp SET streak = 0 WHERE user_id = $1', [uid]);
      }

      const allQ = (await c.query('SELECT id FROM quizzes WHERE lesson_id = $1', [quiz.lesson_id])).rows;
      const correctCount = (await c.query(
        'SELECT COUNT(*)::int AS c FROM user_quiz_answers WHERE quiz_id = ANY($1::int[]) AND is_correct = true',
        [allQ.map(q => q.id)]
      )).rows[0].c;

      const lessonCompleted = correctCount === allQ.length;
      if (lessonCompleted) {
        const p = (await c.query('SELECT id FROM user_lesson_progress WHERE lesson_id = $1', [quiz.lesson_id])).rows[0];
        if (p) await c.query('UPDATE user_lesson_progress SET completed = true, completed_at = NOW() WHERE id = $1', [p.id]);
        else await c.query('INSERT INTO user_lesson_progress (user_id, lesson_id, completed, completed_at) VALUES ($1, $2, true, NOW())', [uid, quiz.lesson_id]);
      }
      return { correct: choice.is_correct, lessonCompleted, tokensEarned, attempts: newAttempts };
    });
    if (result.error) return res.status(400).json(result);
    res.json(result);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// ================== PROGRESS ==================
app.get('/api/progress', auth, async (req, res) => {
  try {
    const data = await withUser(req.session.userId, async c => {
      const totalLessons = (await c.query('SELECT COUNT(*)::int AS c FROM lessons')).rows[0].c;
      const completedLessons = (await c.query('SELECT COUNT(*)::int AS c FROM user_lesson_progress WHERE completed = true')).rows[0].c;
      const totalQuizzes = (await c.query('SELECT COUNT(*)::int AS c FROM quizzes')).rows[0].c;
      const correctQuizzes = (await c.query('SELECT COUNT(*)::int AS c FROM user_quiz_answers WHERE is_correct = true')).rows[0].c;
      // Only count game-type activities (not videos) the kid has actually played
      const totalActivities = (await c.query("SELECT COUNT(*)::int AS c FROM activities WHERE activity_type NOT IN ('video')")).rows[0].c;
      // "Played" = there's a score row for it (at least attempted to completion of the game flow)
      const playedRows = (await c.query(`
        SELECT s.score, s.max_score
        FROM user_activity_scores s
        JOIN activities a ON a.id = s.activity_id
        WHERE a.activity_type NOT IN ('video')
      `)).rows;
      const completedActivities = playedRows.length;
      const perfectActivities = playedRows.filter(r => r.score === r.max_score).length;
      const xp = (await c.query('SELECT xp, level, streak, tokens FROM user_xp')).rows[0] || { xp: 0, level: 1, streak: 0, tokens: 0 };
      const achievements = (await c.query('SELECT a.* FROM user_achievements ua JOIN achievements a ON a.id = ua.achievement_id ORDER BY ua.earned_at DESC')).rows;
      return { totalLessons, completedLessons, totalQuizzes, correctQuizzes, totalActivities, completedActivities, perfectActivities, ...xp, achievements };
    });
    res.json(data);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// ================== GAME STUDIO ==================
async function isFullyComplete(uid) {
  return await withUser(uid, async c => {
    const total = (await c.query('SELECT COUNT(*)::int AS c FROM lessons')).rows[0].c;
    const done = (await c.query('SELECT COUNT(*)::int AS c FROM user_lesson_progress WHERE completed = true')).rows[0].c;
    return total > 0 && done >= total;
  });
}

app.get('/api/game-studio/status', auth, async (req, res) => {
  try {
    const unlocked = await isFullyComplete(req.session.userId);
    const sessions = unlocked ? await withUser(req.session.userId, async c =>
      (await c.query('SELECT s.id, s.title, s.created_at, COUNT(i.id)::int AS iteration_count FROM user_game_sessions s LEFT JOIN user_game_iterations i ON i.session_id = s.id GROUP BY s.id ORDER BY s.created_at DESC')).rows
    ) : [];
    res.json({ unlocked, sessions });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/game-studio/start', auth, async (req, res) => {
  try {
    if (!await isFullyComplete(req.session.userId)) return res.status(403).json({ error: 'Finish all worlds first!' });
    const { title } = req.body;
    const session = await withUser(req.session.userId, async c =>
      (await c.query('INSERT INTO user_game_sessions (user_id, title) VALUES ($1, $2) RETURNING id, title, created_at', [req.session.userId, title || 'My Game'])).rows[0]
    );
    res.json(session);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/game-studio/session/:id', auth, async (req, res) => {
  try {
    const result = await withUser(req.session.userId, async c => {
      const s = (await c.query('SELECT * FROM user_game_sessions WHERE id = $1', [req.params.id])).rows[0];
      if (!s) return null;
      const iterations = (await c.query('SELECT * FROM user_game_iterations WHERE session_id = $1 ORDER BY iteration_number', [req.params.id])).rows;
      return { ...s, iterations };
    });
    if (!result) return res.status(404).json({ error: 'Session not found' });
    res.json(result);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/game-studio/iterate', auth, async (req, res) => {
  try {
    const { sessionId, prompt } = req.body;
    if (!sessionId || !prompt || prompt.length > 500) return res.status(400).json({ error: 'Invalid prompt' });
    if (!await isFullyComplete(req.session.userId)) return res.status(403).json({ error: 'Locked' });

    // Server-side safety check
    const safety = checkPromptSafety(prompt);
    if (!safety.ok) {
      return res.status(400).json({ error: "Oh no! 🙈 That's not something I can make. Let's stick to fun, friendly games like a snake game, a clicker, or a maze!" });
    }

    // Load session + previous iterations (RLS-checked)
    const ctx = await withUser(req.session.userId, async c => {
      const s = (await c.query('SELECT * FROM user_game_sessions WHERE id = $1', [sessionId])).rows[0];
      if (!s) return null;
      const iterations = (await c.query('SELECT iteration_number, prompt, html_response FROM user_game_iterations WHERE session_id = $1 ORDER BY iteration_number', [sessionId])).rows;
      return { session: s, iterations };
    });
    if (!ctx) return res.status(404).json({ error: 'Session not found' });
    if (ctx.iterations.length >= MAX_ITERATIONS) return res.status(400).json({ error: `You've used all ${MAX_ITERATIONS} refinements!` });

    // Build conversation history for Claude
    const messages = [];
    for (const it of ctx.iterations) {
      messages.push({ role: 'user', content: it.prompt });
      messages.push({ role: 'assistant', content: it.html_response });
    }
    messages.push({ role: 'user', content: prompt });

    const response = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 16000,
      system: GAME_SYSTEM_PROMPT,
      messages,
    });

    let html = '';
    for (const block of response.content) {
      if (block.type === 'text') html += block.text;
    }
    html = html.replace(/^```html\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

    // Extract instructions comment (first <!--INSTRUCTIONS: ... -->)
    let instructions = '';
    const match = html.match(/<!--\s*INSTRUCTIONS:\s*([\s\S]*?)\s*-->/i);
    if (match) {
      instructions = match[1].trim();
      // Remove the comment from the html so it's not redundant inside the iframe
      html = html.replace(match[0], '').trim();
    }

    const nextNumber = ctx.iterations.length + 1;
    const saved = await withUser(req.session.userId, async c =>
      (await c.query(
        'INSERT INTO user_game_iterations (session_id, user_id, iteration_number, prompt, html_response, instructions) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
        [sessionId, req.session.userId, nextNumber, prompt, html, instructions]
      )).rows[0]
    );

    res.json({ iteration: saved, remaining: MAX_ITERATIONS - nextNumber });
  } catch (e) {
    console.error(e);
    if (e instanceof Anthropic.APIError) return res.status(500).json({ error: 'Claude error: ' + e.message });
    res.status(500).json({ error: 'Server error' });
  }
});

// ================== SHOP ==================
const BG_SYSTEM_PROMPT = `You generate themed backgrounds for a kid-friendly app. A child types a single word or short phrase, and you turn it into a colorful background scene with matching emojis.

BE GENEROUS in interpretation. If the kid says ANY noun (a sport, hobby, animal, place, food, weather, color, season, vehicle, character type, activity, etc.), create a background scene that matches. Examples of how to interpret:
- "football" → a green football field with sky
- "pizza" → warm reds, oranges, and creams like a pizza shop
- "horse" → a sunny meadow with hills
- "ice cream" → pastel pink/blue/cream colors
- "ninja" → dark indigo and red, mysterious
- "minecraft" → blocky greens, browns, blues
- "cat" → cozy pinks and warm yellows
- "blue" → blue gradient with clouds

OUTPUT FORMAT (EXACTLY three lines):
Line 1: a single CSS background value (a gradient)
Line 2: EMOJIS:<emoji><space><emoji>... (8 to 12 themed emojis that match)
Line 3: ANIMATION:<style>  (one of: drift, twinkle, bounce, sway, rain, swirl, float)

ANIMATION GUIDE — pick the one that best matches the scene:
- drift: clouds, fog, slow-moving things
- twinkle: stars, sparkles, lights, magic
- bounce: candy, balls, bouncy/playful things
- sway: flowers, trees, plants, jungle, leaves
- rain: rain, snow, falling petals/leaves
- swirl: space, galaxies, magical swirls
- float: balloons, bubbles, underwater

STRICT RULES:
1. Line 1 = only a CSS gradient. Examples:
   linear-gradient(135deg, #ff6b6b 0%, #ffd93d 50%, #6bcf7f 100%)
   radial-gradient(circle at top, #ff7e5f, #feb47b)
2. NO markdown, NO explanation, NO "background:" prefix, NO quotes.
3. Use bright, fun, kid-appropriate colors with 3-5 color stops.
4. Line 2 starts with "EMOJIS:" and lists 8-12 kid-friendly emojis matching the scene.
5. Line 3 starts with "ANIMATION:" and is exactly one of the words above.
6. ONLY output INVALID if the request is genuinely INAPPROPRIATE for kids ages 8-12: violence, weapons, blood, drugs, alcohol, romance, explicit content, hate speech, scary horror, or self-harm. ALMOST EVERYTHING ELSE should be turned into a fun background.

EXAMPLES:

Input: "sunset over the ocean"
Output:
linear-gradient(180deg, #ff7e5f 0%, #feb47b 40%, #2c5364 100%)
EMOJIS:🌅 🌊 🐠 ☀️ 🌺 🏖️ 🦀 🐚 🌴 🐬
ANIMATION:float

Input: "football"
Output:
linear-gradient(180deg, #87ceeb 0%, #87ceeb 50%, #4caf50 50%, #2e7d32 100%)
EMOJIS:🏈 🥅 🏆 ⚡ 🎽 🥇 ☀️ 🌳 📣 🎯
ANIMATION:bounce

Input: "pizza"
Output:
linear-gradient(135deg, #ffe0b2 0%, #ff9800 40%, #d84315 80%, #bf360c 100%)
EMOJIS:🍕 🧀 🍅 🌿 🔥 🍴 🍞 🥗 🌽 🌶️
ANIMATION:bounce

Input: "outer space"
Output:
radial-gradient(ellipse at center, #1e3c72 0%, #2a5298 50%, #000428 100%)
EMOJIS:🚀 🪐 ⭐ 🌙 👽 🛸 ☄️ 🌌 ✨ 🌠
ANIMATION:twinkle

Input: "magical forest"
Output:
linear-gradient(180deg, #134e5e 0%, #71b280 100%)
EMOJIS:🌳 🍄 🦋 🧚 🌿 🦌 🦉 🐿️ 🌺 🍂
ANIMATION:sway

Input: "candy land"
Output:
linear-gradient(135deg, #ff9a9e 0%, #fecfef 50%, #fad0c4 100%)
EMOJIS:🍭 🍬 🧁 🍩 🍫 🍦 🎂 🍰 🍪 🌈
ANIMATION:bounce

Input: "snowy mountain"
Output:
linear-gradient(180deg, #c4d8e8 0%, #6a8caf 50%, #2c3e50 100%)
EMOJIS:❄️ ⛄ 🏔️ 🌨️ 🎿 🦌 🌲 ☃️ 🏂 ⛷️
ANIMATION:rain

Input: "guns"
Output:
INVALID

Input: "scary monster"
Output:
INVALID

Output the three lines or the single word INVALID. Nothing else.`;

const SHOP_BLOCKED_TERMS = [
  'kill','gun ','blood','gore','rape','sex','porn','nude','drug','cocaine','meth','beer','alcohol','vodka','whiskey','nazi','slur','suicide','murder','weapon','knife','bomb','scary','horror','monster',
];

function checkBackgroundPromptSafety(prompt) {
  if (!prompt || prompt.length < 2 || prompt.length > 200) return { ok: false, reason: 'length' };
  const lower = prompt.toLowerCase();
  for (const term of SHOP_BLOCKED_TERMS) {
    if (lower.includes(term)) return { ok: false, reason: term };
  }
  return { ok: true };
}

function isValidCssBackground(s) {
  if (!s || s.length > 600) return false;
  // Block common CSS injection vectors
  const lower = s.toLowerCase();
  if (lower.includes('javascript:') || lower.includes('expression(') || lower.includes('url(') || lower.includes('script') || lower.includes('@import') || lower.includes('}')) return false;
  // Must look like a gradient or color
  return /^(linear-gradient|radial-gradient|conic-gradient|#[0-9a-f]{3,8}|rgb|hsl)/i.test(s.trim());
}

app.get('/api/shop', auth, async (req, res) => {
  try {
    const items = await pq('SELECT * FROM shop_items ORDER BY cost ASC');
    const owned = await withUser(req.session.userId, async c =>
      (await c.query('SELECT item_id FROM user_purchases')).rows.map(r => r.item_id)
    );
    const ownedSet = new Set(owned);
    res.json(items.map(it => ({ ...it, owned: ownedSet.has(it.id) })));
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/shop/inventory', auth, async (req, res) => {
  try {
    const data = await withUser(req.session.userId, async c => {
      const purchases = (await c.query(`
        SELECT p.id, p.item_id, p.payload, p.decoration_emojis, p.name AS purchase_name, p.purchased_at,
               s.code, s.name AS item_name, s.icon, s.kind
        FROM user_purchases p JOIN shop_items s ON s.id = p.item_id
        ORDER BY p.purchased_at DESC
      `)).rows;
      const u = (await c.query('SELECT active_background, active_background_emojis FROM users WHERE id = $1', [req.session.userId])).rows[0];
      return { purchases, activeBackground: u ? u.active_background : '', activeBackgroundEmojis: u ? u.active_background_emojis : '' };
    });
    res.json(data);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/shop/buy', auth, async (req, res) => {
  try {
    const { itemId, prompt } = req.body;
    if (!itemId) return res.status(400).json({ error: 'Missing item' });

    const item = await pq1('SELECT * FROM shop_items WHERE id = $1', [itemId]);
    if (!item) return res.status(404).json({ error: 'Item not found' });

    let payload = '';
    let decorationEmojis = '';
    let purchaseName = '';
    let animationStyle = 'drift';
    const VALID_ANIMATIONS = ['drift','twinkle','bounce','sway','rain','swirl','float'];

    // Extract every emoji from a string (covers most pictographic ranges)
    function extractEmojis(s) {
      if (!s) return [];
      const matches = s.match(/\p{Extended_Pictographic}(\u200d\p{Extended_Pictographic})*\uFE0F?/gu) || [];
      return matches;
    }

    // Handle background generation BEFORE the transaction
    if (item.kind === 'background') {
      if (!prompt) return res.status(400).json({ error: 'Background description required' });
      const safety = checkBackgroundPromptSafety(prompt);
      if (!safety.ok) {
        return res.status(400).json({ error: "Oh no! 🙈 That's not a background I can make. Try describing colors or a scene like 'sunset over the ocean' or 'magical forest'!" });
      }
      purchaseName = prompt.trim().slice(0, 50);
      try {
        const response = await anthropic.messages.create({
          model: 'claude-opus-4-6',
          max_tokens: 400,
          system: BG_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: prompt }],
        });
        let raw = '';
        for (const block of response.content) if (block.type === 'text') raw += block.text;
        raw = raw.trim();
        console.log('[bg gen] prompt:', prompt, '\nraw:', raw);

        if (raw === 'INVALID' || raw.toUpperCase() === 'INVALID') {
          return res.status(400).json({ error: "Oh no! 🙈 I can only make backgrounds. Try 'sunset over the ocean' or 'magical forest'!" });
        }

        // Parse: split by lines, find CSS and emoji line
        const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
        // CSS = the first line that starts with a gradient or color function
        let css = lines.find(l => /^(linear-gradient|radial-gradient|conic-gradient|#|rgb|hsl)/i.test(l)) || lines[0] || '';
        css = css.replace(/^["'`]|["'`]$/g, '').replace(/^background:\s*/i, '').replace(/;$/, '').trim();

        // Try to find an EMOJIS: line first
        let emojiText = '';
        const emojiLine = lines.find(l => l.toUpperCase().startsWith('EMOJIS:'));
        if (emojiLine) {
          emojiText = emojiLine.replace(/^emojis:\s*/i, '').trim();
        }
        // Find the ANIMATION line
        const animLine = lines.find(l => l.toUpperCase().startsWith('ANIMATION:'));
        if (animLine) {
          const cand = animLine.replace(/^animation:\s*/i, '').trim().toLowerCase();
          if (VALID_ANIMATIONS.includes(cand)) animationStyle = cand;
        }
        // Extract emojis from anywhere in the response if needed
        let emojiArr = extractEmojis(emojiText);
        if (emojiArr.length < 4) {
          // Try the whole raw response
          const allEmojis = extractEmojis(raw);
          if (allEmojis.length >= 4) emojiArr = allEmojis;
        }

        // Final fallback so the user always gets some emojis
        if (emojiArr.length < 4) {
          const defaultEmojis = ['✨','🎨','🌈','⭐','💫','🌟','🪄','💎','🎀','🎉'];
          emojiArr = defaultEmojis;
        }

        if (!isValidCssBackground(css)) {
          return res.status(400).json({ error: "Oh no! 🙈 I can only make backgrounds. Try 'sunset over the ocean' or 'magical forest'!" });
        }
        payload = css;
        decorationEmojis = emojiArr.slice(0, 12).join(' ');
      } catch (e) {
        console.error(e);
        return res.status(500).json({ error: 'Could not generate background. Try again!' });
      }
    }

    // Now do the atomic purchase: check tokens, deduct, insert
    const result = await withUser(req.session.userId, async c => {
      // Lock the user_xp row
      const xr = (await c.query('SELECT id, tokens FROM user_xp FOR UPDATE')).rows[0];
      if (!xr) return { error: 'No wallet' };
      if (xr.tokens < item.cost) return { error: `You need ${item.cost - xr.tokens} more tokens!` };

      // Cosmetics & bonus_game can only be bought once
      if (item.kind !== 'background') {
        const owned = (await c.query('SELECT id FROM user_purchases WHERE item_id = $1', [item.id])).rows[0];
        if (owned) return { error: 'You already own this!' };
      }

      // Deduct tokens
      await c.query('UPDATE user_xp SET tokens = tokens - $1 WHERE id = $2', [item.cost, xr.id]);

      // Record purchase
      const purchase = (await c.query(
        'INSERT INTO user_purchases (user_id, item_id, payload, decoration_emojis, animation_style, name) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, payload, decoration_emojis, animation_style, name',
        [req.session.userId, item.id, payload, decorationEmojis, animationStyle, purchaseName]
      )).rows[0];

      // For backgrounds, set as active
      if (item.kind === 'background') {
        await c.query('UPDATE users SET active_background = $1, active_background_emojis = $2, active_background_animation = $3 WHERE id = $4', [payload, decorationEmojis, animationStyle, req.session.userId]);
      }

      const newTokens = xr.tokens - item.cost;
      return { purchase, newTokens, item };
    });

    if (result.error) return res.status(400).json(result);
    res.json(result);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/shop/use-background', auth, async (req, res) => {
  try {
    const { purchaseId } = req.body;
    const result = await withUser(req.session.userId, async c => {
      const p = (await c.query('SELECT p.* FROM user_purchases p JOIN shop_items s ON s.id = p.item_id WHERE p.id = $1 AND s.kind = $2', [purchaseId, 'background'])).rows[0];
      if (!p) return { error: 'Background not found' };
      await c.query('UPDATE users SET active_background = $1, active_background_emojis = $2, active_background_animation = $3 WHERE id = $4', [p.payload, p.decoration_emojis, p.animation_style, req.session.userId]);
      return { activeBackground: p.payload, activeBackgroundEmojis: p.decoration_emojis, activeBackgroundAnimation: p.animation_style };
    });
    if (result.error) return res.status(404).json(result);
    res.json(result);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// Reset to a built-in theme — clears any custom background
app.post('/api/shop/use-theme', auth, async (req, res) => {
  try {
    const { themeCode } = req.body;
    const t = await pq1('SELECT id FROM themes WHERE code = $1', [themeCode]);
    if (!t) return res.status(400).json({ error: 'Invalid theme' });
    await withUser(req.session.userId, c => c.query(
      'UPDATE users SET theme_id = $1, active_background = $2, active_background_emojis = $3, active_background_animation = $4 WHERE id = $5',
      [t.id, '', '', '', req.session.userId]
    ));
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// ================== STATIC ==================
app.use(express.static(path.join(__dirname, '..', 'client', 'dist')));
app.get('/{*splat}', (req, res) => res.sendFile(path.join(__dirname, '..', 'client', 'dist', 'index.html')));

init().then(() => {
  app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
}).catch(err => {
  console.error('Failed to init database:', err);
  process.exit(1);
});
