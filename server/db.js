require('dotenv').config();
const { Pool } = require('pg');

const isProd = process.env.NODE_ENV === 'production';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://chelseaoconnor@localhost:5432/learning_app',
  // Heroku Postgres requires SSL but uses a self-signed cert
  ssl: isProd ? { rejectUnauthorized: false } : false,
});

/**
 * Run an async function in a transaction with the given user_id set
 * as a session variable. Postgres Row Level Security policies on
 * user_* tables read this variable to enforce that a user can only
 * see/modify their own rows.
 */
// Set at startup based on whether the connecting role bypasses RLS.
// Local Postgres typically uses your superuser; Heroku gives a normal role.
let needsRoleSwitch = false;

async function withUser(userId, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (needsRoleSwitch) {
      await client.query('SET LOCAL ROLE learning_app_user');
    }
    await client.query(`SELECT set_config('app.user_id', $1, true)`, [String(userId)]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

// Admin context — bypasses RLS via an admin policy keyed on app.is_admin
async function withAdmin(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (needsRoleSwitch) {
      await client.query('SET LOCAL ROLE learning_app_user');
    }
    await client.query(`SELECT set_config('app.is_admin', 'true', true)`);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

async function init() {
  // ---------- DETECT WHETHER WE'RE A SUPERUSER (LOCAL DEV) OR NOT (HEROKU) ----------
  try {
    const me = (await pool.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user')).rows[0];
    if (me && (me.rolsuper || me.rolbypassrls)) {
      needsRoleSwitch = true;
      // Create the non-superuser role we'll switch to per request
      await pool.query(`DO $$ BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'learning_app_user') THEN
          CREATE ROLE learning_app_user NOLOGIN NOSUPERUSER NOBYPASSRLS;
        END IF;
      END $$;`);
      console.log('✓ Superuser detected — will SET LOCAL ROLE per request');
    } else {
      console.log('✓ Non-superuser connection — RLS applies natively');
    }
  } catch (e) {
    console.warn('Could not detect role status:', e.message);
  }

  // ---------- SCHEMA ----------
  await pool.query(`
    -- Themes (normalized: each theme is its own row)
    CREATE TABLE IF NOT EXISTS themes (
      id SERIAL PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      display_name TEXT NOT NULL,
      header_label TEXT NOT NULL,
      traveler_emoji TEXT NOT NULL,
      world_emoji TEXT NOT NULL,
      journey_title TEXT NOT NULL,
      bg_color TEXT NOT NULL,
      accent_color TEXT NOT NULL,
      text_color TEXT NOT NULL
    );

    -- Theme decorations (one row per emoji, no JSON arrays)
    CREATE TABLE IF NOT EXISTS theme_decorations (
      id SERIAL PRIMARY KEY,
      theme_id INTEGER NOT NULL REFERENCES themes(id) ON DELETE CASCADE,
      emoji TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    -- Levels (XP thresholds)
    CREATE TABLE IF NOT EXISTS levels (
      level_number INTEGER PRIMARY KEY,
      xp_required INTEGER NOT NULL,
      title TEXT NOT NULL
    );

    -- Achievements
    CREATE TABLE IF NOT EXISTS achievements (
      id SERIAL PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      icon TEXT NOT NULL,
      xp_reward INTEGER NOT NULL DEFAULT 0
    );

    -- Users (theme is now a foreign key)
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      theme_id INTEGER REFERENCES themes(id),
      age INTEGER,
      active_background TEXT NOT NULL DEFAULT '',
      active_background_emojis TEXT NOT NULL DEFAULT '',
      active_background_animation TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','denied')),
      is_admin BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );

    -- Feature requests from users
    CREATE TABLE IF NOT EXISTS feature_requests (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','seen','done','rejected')),
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );

    -- Shop catalog
    CREATE TABLE IF NOT EXISTS shop_items (
      id SERIAL PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      icon TEXT NOT NULL,
      cost INTEGER NOT NULL CHECK(cost > 0),
      kind TEXT NOT NULL CHECK(kind IN ('background','bonus_game','cosmetic'))
    );

    -- Things users have purchased
    CREATE TABLE IF NOT EXISTS user_purchases (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      item_id INTEGER NOT NULL REFERENCES shop_items(id),
      payload TEXT NOT NULL DEFAULT '',
      decoration_emojis TEXT NOT NULL DEFAULT '',
      animation_style TEXT NOT NULL DEFAULT 'drift',
      name TEXT NOT NULL DEFAULT '',
      purchased_at TIMESTAMP NOT NULL DEFAULT NOW()
    );

    -- Categories (worlds)
    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      description TEXT NOT NULL,
      icon TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    -- Lessons
    CREATE TABLE IF NOT EXISTS lessons (
      id SERIAL PRIMARY KEY,
      category_id INTEGER NOT NULL REFERENCES categories(id),
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    -- Quizzes
    CREATE TABLE IF NOT EXISTS quizzes (
      id SERIAL PRIMARY KEY,
      lesson_id INTEGER NOT NULL REFERENCES lessons(id),
      question TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS quiz_choices (
      id SERIAL PRIMARY KEY,
      quiz_id INTEGER NOT NULL REFERENCES quizzes(id),
      choice_text TEXT NOT NULL,
      is_correct BOOLEAN NOT NULL DEFAULT false,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    -- Activities (parent table; concrete data per type lives in child tables)
    CREATE TABLE IF NOT EXISTS activities (
      id SERIAL PRIMARY KEY,
      lesson_id INTEGER NOT NULL REFERENCES lessons(id),
      activity_type TEXT NOT NULL CHECK(activity_type IN ('video','match','sort','truefalse','codebuilder','fillinblank','codechallenge','minigame')),
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      video_url TEXT,
      game_kind TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS activity_match_pairs (
      id SERIAL PRIMARY KEY,
      activity_id INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
      term TEXT NOT NULL,
      definition TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS activity_sort_items (
      id SERIAL PRIMARY KEY,
      activity_id INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      correct_position INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS activity_truefalse_items (
      id SERIAL PRIMARY KEY,
      activity_id INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
      statement TEXT NOT NULL,
      is_true BOOLEAN NOT NULL,
      explanation TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS activity_blanks (
      id SERIAL PRIMARY KEY,
      activity_id INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
      sentence_before TEXT NOT NULL,
      sentence_after TEXT NOT NULL DEFAULT '',
      correct_answer TEXT NOT NULL,
      hint TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS activity_blank_options (
      id SERIAL PRIMARY KEY,
      blank_id INTEGER NOT NULL REFERENCES activity_blanks(id) ON DELETE CASCADE,
      option_text TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS activity_code_challenges (
      id SERIAL PRIMARY KEY,
      activity_id INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
      instructions TEXT NOT NULL,
      starter_code TEXT NOT NULL,
      expected_output TEXT NOT NULL,
      hint TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    -- User progress tables (RLS-protected)
    CREATE TABLE IF NOT EXISTS user_lesson_progress (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      lesson_id INTEGER NOT NULL REFERENCES lessons(id),
      completed BOOLEAN NOT NULL DEFAULT false,
      completed_at TIMESTAMP,
      UNIQUE(user_id, lesson_id)
    );
    CREATE TABLE IF NOT EXISTS user_quiz_answers (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      quiz_id INTEGER NOT NULL REFERENCES quizzes(id),
      selected_choice_id INTEGER NOT NULL REFERENCES quiz_choices(id),
      is_correct BOOLEAN NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 1,
      tokens_awarded INTEGER NOT NULL DEFAULT 0,
      answered_at TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, quiz_id)
    );
    CREATE TABLE IF NOT EXISTS user_activity_scores (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      activity_id INTEGER NOT NULL REFERENCES activities(id),
      score INTEGER NOT NULL DEFAULT 0,
      max_score INTEGER NOT NULL DEFAULT 0,
      completed_at TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, activity_id)
    );
    CREATE TABLE IF NOT EXISTS user_xp (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      xp INTEGER NOT NULL DEFAULT 0,
      level INTEGER NOT NULL DEFAULT 1,
      streak INTEGER NOT NULL DEFAULT 0,
      tokens INTEGER NOT NULL DEFAULT 0,
      UNIQUE(user_id)
    );
    CREATE TABLE IF NOT EXISTS user_achievements (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      achievement_id INTEGER NOT NULL REFERENCES achievements(id),
      earned_at TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, achievement_id)
    );
    CREATE TABLE IF NOT EXISTS user_game_sessions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      title TEXT NOT NULL DEFAULT 'My Game',
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS user_game_iterations (
      id SERIAL PRIMARY KEY,
      session_id INTEGER NOT NULL REFERENCES user_game_sessions(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id),
      iteration_number INTEGER NOT NULL,
      prompt TEXT NOT NULL,
      html_response TEXT NOT NULL,
      instructions TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE(session_id, iteration_number)
    );
  `);

  // ---------- MIGRATIONS for columns added after initial deploy ----------
  try {
    // Add columns if missing, then set defaults for new columns
    const hadStatus = (await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='users' AND column_name='status'")).rows.length > 0;
    if (!hadStatus) {
      await pool.query("ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'approved'");
      // All existing users are approved (backwards compat); new column default is pending moving forward
      await pool.query("ALTER TABLE users ALTER COLUMN status SET DEFAULT 'pending'");
    }
    await pool.query("ALTER TABLE users DROP CONSTRAINT IF EXISTS users_status_check");
    await pool.query("ALTER TABLE users ADD CONSTRAINT users_status_check CHECK(status IN ('pending','approved','denied'))");
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false");
    await pool.query("ALTER TABLE users DROP CONSTRAINT IF EXISTS users_age_check");
  } catch (e) { console.warn('User migrations:', e.message); }

  // ---------- SEED ADMIN USER ----------
  try {
    const bcrypt = require('bcryptjs');
    const existingAdmin = (await pool.query("SELECT id FROM users WHERE username = 'chelsea'")).rows[0];
    if (!existingAdmin) {
      const hash = bcrypt.hashSync('Ck57320!', 10);
      await pool.query(
        "INSERT INTO users (username, password_hash, display_name, age, status, is_admin) VALUES ('chelsea', $1, 'Chelsea', 30, 'approved', true)",
        [hash]
      );
      console.log('✓ Seeded admin user: chelsea');
    } else {
      // Ensure existing chelsea user has admin + approved
      await pool.query("UPDATE users SET is_admin = true, status = 'approved' WHERE username = 'chelsea'");
    }
  } catch (e) { console.warn('Admin seed:', e.message); }

  // ---------- GRANT TABLE ACCESS TO learning_app_user (only if we created it) ----------
  if (needsRoleSwitch) {
    try {
      await pool.query('GRANT USAGE ON SCHEMA public TO learning_app_user');
      await pool.query('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO learning_app_user');
      await pool.query('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO learning_app_user');
      await pool.query('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO learning_app_user');
      await pool.query('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO learning_app_user');
    } catch (e) {
      console.warn('Grant failed:', e.message);
    }
  }

  // ---------- ROW LEVEL SECURITY ----------
  // Enable RLS on user-data tables. FORCE makes it apply even to the
  // database owner (the connecting user). Policies check that user_id
  // matches the session-local app.user_id we set in withUser().
  const rlsTables = [
    'user_lesson_progress',
    'user_quiz_answers',
    'user_activity_scores',
    'user_xp',
    'user_achievements',
    'user_game_sessions',
    'user_game_iterations',
    'user_purchases',
  ];
  for (const t of rlsTables) {
    try {
      await pool.query(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
      // FORCE only matters if the connecting role is the table owner; harmless otherwise
      try { await pool.query(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`); } catch {}
      await pool.query(`DROP POLICY IF EXISTS ${t}_isolation ON ${t}`);
      await pool.query(`
        CREATE POLICY ${t}_isolation ON ${t}
          USING (user_id = NULLIF(current_setting('app.user_id', true), '')::int)
          WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::int)
      `);
    } catch (e) {
      console.warn(`RLS setup failed for ${t}:`, e.message);
    }
  }

  // Users table: each user can only see their own row, admins see all
  try {
    await pool.query(`ALTER TABLE users ENABLE ROW LEVEL SECURITY`);
    try { await pool.query(`ALTER TABLE users FORCE ROW LEVEL SECURITY`); } catch {}
    await pool.query(`DROP POLICY IF EXISTS users_self ON users`);
    await pool.query(`
      CREATE POLICY users_self ON users
        USING (id = NULLIF(current_setting('app.user_id', true), '')::int OR NULLIF(current_setting('app.user_id', true), '') IS NULL)
        WITH CHECK (id = NULLIF(current_setting('app.user_id', true), '')::int OR NULLIF(current_setting('app.user_id', true), '') IS NULL)
    `);
    await pool.query(`DROP POLICY IF EXISTS users_admin ON users`);
    await pool.query(`
      CREATE POLICY users_admin ON users
        USING (current_setting('app.is_admin', true) = 'true')
        WITH CHECK (current_setting('app.is_admin', true) = 'true')
    `);
  } catch (e) { console.warn('Users RLS setup failed:', e.message); }

  // Feature requests: users see their own, admins see all
  try {
    await pool.query(`ALTER TABLE feature_requests ENABLE ROW LEVEL SECURITY`);
    try { await pool.query(`ALTER TABLE feature_requests FORCE ROW LEVEL SECURITY`); } catch {}
    await pool.query(`DROP POLICY IF EXISTS feature_requests_self ON feature_requests`);
    await pool.query(`
      CREATE POLICY feature_requests_self ON feature_requests
        USING (user_id = NULLIF(current_setting('app.user_id', true), '')::int)
        WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::int)
    `);
    await pool.query(`DROP POLICY IF EXISTS feature_requests_admin ON feature_requests`);
    await pool.query(`
      CREATE POLICY feature_requests_admin ON feature_requests
        USING (current_setting('app.is_admin', true) = 'true')
        WITH CHECK (current_setting('app.is_admin', true) = 'true')
    `);
  } catch (e) { console.warn('Feature requests RLS setup failed:', e.message); }

  // ---------- SEED ----------
  const { rows: catRows } = await pool.query('SELECT COUNT(*)::int AS c FROM categories');
  const { rows: themeRows } = await pool.query('SELECT COUNT(*)::int AS c FROM themes');

  // Seed themes if needed
  if (themeRows[0].c === 0) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const t1 = (await c.query(
        `INSERT INTO themes (code,display_name,header_label,traveler_emoji,world_emoji,journey_title,bg_color,accent_color,text_color)
         VALUES ('crocodile','Crocodile','🐊 Croc Academy','🛶','🐊','Sail the Amazon!','#0a1f0e','#4caf50','#e8f5e9') RETURNING id`
      )).rows[0].id;
      const t2 = (await c.query(
        `INSERT INTO themes (code,display_name,header_label,traveler_emoji,world_emoji,journey_title,bg_color,accent_color,text_color)
         VALUES ('greek','Greek Mythology','⚡ Olympus Academy','☁️','⚡','Climb Olympus!','#080820','#ffd54f','#e8eaf6') RETURNING id`
      )).rows[0].id;
      const decoCroc = ['🐊','🌴','🦜','🐍','🌿','🐊','🪵','🌴','🐸','🦎','🦋','🌺'];
      const decoGreek = ['⚡','🏛️','🌩️','🏺','👑','⚡','🦉','🌟','🌙','🔱','🏛️','✨'];
      for (let i = 0; i < decoCroc.length; i++) await c.query('INSERT INTO theme_decorations (theme_id,emoji,sort_order) VALUES ($1,$2,$3)', [t1, decoCroc[i], i]);
      for (let i = 0; i < decoGreek.length; i++) await c.query('INSERT INTO theme_decorations (theme_id,emoji,sort_order) VALUES ($1,$2,$3)', [t2, decoGreek[i], i]);
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }

  // Seed levels if needed
  const { rows: lvlRows } = await pool.query('SELECT COUNT(*)::int AS c FROM levels');
  if (lvlRows[0].c === 0) {
    const titles = ['Newbie','Explorer','Apprentice','Coder','Hacker','Wizard','Master','Sage','Legend','Hero'];
    for (let i = 0; i < titles.length; i++) {
      await pool.query('INSERT INTO levels (level_number,xp_required,title) VALUES ($1,$2,$3)', [i + 1, i * 100, titles[i]]);
    }
  }

  // Seed achievements
  const { rows: achRows } = await pool.query('SELECT COUNT(*)::int AS c FROM achievements');
  if (achRows[0].c === 0) {
    const achs = [
      ['first_lesson', 'First Steps', 'Complete your first lesson', '👣', 50],
      ['streak_3', 'On Fire', 'Get a 3-answer streak', '🔥', 25],
      ['python_pro', 'Python Pro', 'Complete a code challenge', '🐍', 30],
      ['perfectionist', 'Perfectionist', 'Get 100% on a quiz', '⭐', 40],
      ['world_explorer', 'World Explorer', 'Finish a whole world', '🏆', 100],
    ];
    for (const [code, title, desc, icon, xp] of achs) {
      await pool.query('INSERT INTO achievements (code,title,description,icon,xp_reward) VALUES ($1,$2,$3,$4,$5)', [code, title, desc, icon, xp]);
    }
  }

  // Seed shop items
  const { rows: shopRows } = await pool.query('SELECT COUNT(*)::int AS c FROM shop_items');
  if (shopRows[0].c === 0) {
    const items = [
      ['custom_bg',   'Custom AI Background', 'Describe a background and Claude paints it just for you!', '🎨', 40, 'background'],
      ['bonus_game',  'Memory Match Game',    'Unlock a brand new memory match mini-game forever!',       '🧠', 50, 'bonus_game'],
      ['crown',       'Royal Crown',          'A shiny crown next to your name in the header.',           '👑',  5, 'cosmetic'],
      ['sparkles',    'Sparkle Trail',        'Sparkles ✨ follow your mouse cursor everywhere.',          '✨', 10, 'cosmetic'],
      ['rainbow',     'Rainbow Logo',         'Your header glows with rainbow colors.',                   '🌈', 15, 'cosmetic'],
    ];
    for (const [code, name, desc, icon, cost, kind] of items) {
      await pool.query('INSERT INTO shop_items (code,name,description,icon,cost,kind) VALUES ($1,$2,$3,$4,$5,$6)', [code, name, desc, icon, cost, kind]);
    }
  }

  // Seed lesson content
  if (catRows[0].c > 0) return;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const cat = async (n,d,i,s) => (await client.query('INSERT INTO categories (name,description,icon,sort_order) VALUES ($1,$2,$3,$4) RETURNING id', [n,d,i,s])).rows[0].id;
    const les = async (c,t,co,s) => (await client.query('INSERT INTO lessons (category_id,title,content,sort_order) VALUES ($1,$2,$3,$4) RETURNING id', [c,t,co,s])).rows[0].id;
    const qz = async (l,q,s) => (await client.query('INSERT INTO quizzes (lesson_id,question,sort_order) VALUES ($1,$2,$3) RETURNING id', [l,q,s])).rows[0].id;
    const ch = async (q,t,c,s) => client.query('INSERT INTO quiz_choices (quiz_id,choice_text,is_correct,sort_order) VALUES ($1,$2,$3,$4)', [q,t,!!c,s]);
    const act = async (l,t,ti,d,v,s) => (await client.query('INSERT INTO activities (lesson_id,activity_type,title,description,video_url,sort_order) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [l,t,ti,d,v,s])).rows[0].id;
    const minigame = async (l,kind,ti,d,s) => (await client.query('INSERT INTO activities (lesson_id,activity_type,title,description,game_kind,sort_order) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [l,'minigame',ti,d,kind,s])).rows[0].id;
    const mat = async (a,t,d,s) => client.query('INSERT INTO activity_match_pairs (activity_id,term,definition,sort_order) VALUES ($1,$2,$3,$4)', [a,t,d,s]);
    const srt = async (a,c,p) => client.query('INSERT INTO activity_sort_items (activity_id,content,correct_position) VALUES ($1,$2,$3)', [a,c,p]);
    const tf = async (a,s,t,e,o) => client.query('INSERT INTO activity_truefalse_items (activity_id,statement,is_true,explanation,sort_order) VALUES ($1,$2,$3,$4,$5)', [a,s,!!t,e,o]);
    const blk = async (a,b,af,c,h,s,opts) => {
      const id = (await client.query('INSERT INTO activity_blanks (activity_id,sentence_before,sentence_after,correct_answer,hint,sort_order) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [a,b,af,c,h,s])).rows[0].id;
      for (let i = 0; i < opts.length; i++) {
        await client.query('INSERT INTO activity_blank_options (blank_id,option_text,sort_order) VALUES ($1,$2,$3)', [id, opts[i], i]);
      }
    };
    const code = async (a,i,s,e,h,o) => client.query('INSERT INTO activity_code_challenges (activity_id,instructions,starter_code,expected_output,hint,sort_order) VALUES ($1,$2,$3,$4,$5,$6)', [a,i,s,e,h,o]);

    // ===== CAT 1 =====
    const c1 = await cat('What is AI?','Games & videos about AI!','🤖',1);
    const l1 = await les(c1,'Meet AI!','AI means teaching computers to learn from examples — like how you learn at school, but with math and data!',1);
    await act(l1,'video','What is AI?','Watch this short video!','https://www.youtube.com/embed/pBViQsPo3PY',1);
    let a = await act(l1,'match','Match AI Terms!','Tap a term, then tap its match. Go fast!',null,2);
    await mat(a,'AI','Teaching computers to learn',1);
    await mat(a,'Data','Info that AI learns from',2);
    await mat(a,'Pattern','Something that repeats',3);
    await mat(a,'Training','Giving AI examples',4);
    a = await act(l1,'truefalse','True or False!','Tap TRUE or FALSE for each one!',null,3);
    await tf(a,'AI can learn from examples',1,'Yes! AI learns from lots of data.',1);
    await tf(a,'AI has a real brain',0,'Nope! AI uses math, not a brain.',2);
    await tf(a,'Siri uses AI',1,'Yes! Voice assistants use AI.',3);
    await tf(a,'AI can only count numbers',0,'AI can do way more — images, text, games!',4);
    await tf(a,'AI needs data to learn',1,'Correct! No data = no learning.',5);
    let q = await qz(l1,'What does AI stand for?',1);
    await ch(q,'Artificial Intelligence',1,1);
    await ch(q,'Automatic Internet',0,2);
    await ch(q,'Animal Instructor',0,3);

    const l2 = await les(c1,'AI is Everywhere!','You use AI every day — YouTube, face unlock, spell check, game characters. AI is all around you!',2);
    await act(l2,'video','AI Around You','How AI is in your daily life!','https://www.youtube.com/embed/pBViQsPo3PY',1);
    a = await act(l2,'match','Where is the AI?','Match the app to how it uses AI',null,2);
    await mat(a,'YouTube','Suggests videos you like',1);
    await mat(a,'Phone Camera','Finds faces in photos',2);
    await mat(a,'Siri','Understands your voice',3);
    await mat(a,'Autocorrect','Fixes spelling mistakes',4);
    await mat(a,'Video Games','Controls enemy characters',5);
    a = await act(l2,'fillinblank','Fill the Gaps!','Tap the right word!',null,3);
    await blk(a,'YouTube uses','to suggest videos.','AI','Two letters!',1, ['AI','magic','wires','ghosts']);
    await blk(a,'AI learns from lots of','and examples.','data','Starts with D',2, ['toys','data','candy','dreams']);
    await blk(a,'Your phone uses AI to unlock with your','','face','You see it in the mirror!',3, ['feet','face','elbow','ear']);
    q = await qz(l2,'Which uses AI?',1);
    await ch(q,'A wooden chair',0,1);
    await ch(q,'YouTube recommendations',1,2);
    await ch(q,'A paper book',0,3);

    // BONUS LESSON for CAT 1 — Catch the AI minigame
    const lb1 = await les(c1,'🎁 Bonus Game: Catch the AI!','Time to play! Tap things that use AI before they fall away.',3);
    await minigame(lb1,'catch_ai','Catch the AI!','Tap AI things to catch them. Avoid the non-AI stuff!',1);

    // ===== CAT 2 =====
    const c2 = await cat('AI Agents','Discover AI agents!','🕵️',2);
    const l3 = await les(c2,'Meet the Agents!','Regular AI just answers. An Agent can plan, use tools, and do whole tasks by itself!',1);
    await act(l3,'video','AI Agents Explained','What makes agents special?','https://www.youtube.com/embed/wazHMMaiDEA',1);
    a = await act(l3,'sort','How Agents Work','Put the steps in order!',null,2);
    await srt(a,'You give the agent a task',1);
    await srt(a,'Agent breaks it into steps',2);
    await srt(a,'Agent picks the right tools',3);
    await srt(a,'Agent does each step',4);
    await srt(a,'Task complete!',5);
    a = await act(l3,'truefalse','Agent True or False!','Tap TRUE or FALSE for each one!',null,3);
    await tf(a,'Agents can plan steps by themselves',1,'Yes! That is their superpower.',1);
    await tf(a,'Agents can only chat',0,'Nope! They can DO things.',2);
    await tf(a,'Agents can use tools like a browser',1,'Correct! They pick the right tool.',3);
    await tf(a,'You must do every step for an agent',0,'Wrong! Agents figure it out.',4);
    await tf(a,'Agents can fix their own mistakes',1,'Yes! They retry when something fails.',5);
    q = await qz(l3,'What makes an Agent special?',1);
    await ch(q,'It can only chat',0,1);
    await ch(q,'It plans and does tasks on its own',1,2);
    await ch(q,'It only works on Tuesdays',0,3);

    const l4 = await les(c2,'Agent Toolbox!','Agents use tools — browser, calculator, code editor, calendar. They pick which tool and when!',2);
    a = await act(l4,'match','Match the Tool!','Which tool does what?',null,1);
    await mat(a,'Web Browser','Search the internet',1);
    await mat(a,'Calculator','Solve math problems',2);
    await mat(a,'Code Editor','Write programs',3);
    await mat(a,'Calendar','Schedule reminders',4);
    await mat(a,'Translator','Change languages',5);
    a = await act(l4,'sort','Agent Does Homework!','How would an agent help with a book report?',null,2);
    await srt(a,'Read the assignment',1);
    await srt(a,'Search for info about the book',2);
    await srt(a,'Organize main ideas',3);
    await srt(a,'Write a draft',4);
    await srt(a,'Check for spelling',5);
    q = await qz(l4,'Why do agents use tools?',1);
    await ch(q,'To look cool',0,1);
    await ch(q,'To do more types of tasks',1,2);
    await ch(q,'They have no choice',0,3);

    // BONUS LESSON for CAT 2 — Pick the Tool minigame
    const lb2 = await les(c2,'🎁 Bonus Game: Tool Time!','Help the agent pick the right tool for each task. Quick — go fast!',3);
    await minigame(lb2,'pick_tool','Pick the Tool!','Tap the right tool the agent needs!',1);

    // ===== CAT 3 =====
    const c3 = await cat('Python Coding','Write real Python code!','🐍',3);
    const l5 = await les(c3,'Say Hello, Python!','Python is a coding language! Use print() to make the computer talk. Try it!',1);
    await act(l5,'video','Python for Beginners','Learn the basics of Python!','https://www.youtube.com/embed/UJqogFfQsAs',1);
    a = await act(l5,'codechallenge','Make Python Say Hello!','Write code in the editor and press Run!',null,2);
    await code(a,'Make the computer print "Hello!" by typing Hello! inside the quotes.','print("___")\n','Hello!\n','Type Hello! between the quotes',1);
    await code(a,'Make Python print your name! Replace ___ with your name.','name = "___"\nprint("My name is " + name)\n','','"" can hold any text — type your name!',2);
    await code(a,'Make Python say how old you are! Put a number in the blank.','age = ___\nprint("I am " + str(age) + " years old")\n','','Type a number like 10',3);
    a = await act(l5,'truefalse','Python True or False!','Test your Python knowledge!',null,3);
    await tf(a,'print() shows text on screen',1,'Yes! print() displays output.',1);
    await tf(a,'Python uses curly brackets everywhere',0,'Python uses indentation (spaces), not brackets!',2);
    await tf(a,'You need quotes around text in Python',1,'Yes! Text (strings) need quotes.',3);
    await tf(a,'Python is named after a snake',0,'It is named after Monty Python comedy show!',4);
    q = await qz(l5,'How do you show text in Python?',1);
    await ch(q,'say("hello")',0,1);
    await ch(q,'print("hello")',1,2);
    await ch(q,'show("hello")',0,3);

    const l6 = await les(c3,'Variables: Named Boxes!','A variable stores info with a name. Like a labeled box! myAge = 10 means "put 10 in the myAge box."',2);
    a = await act(l6,'codechallenge','Create Variables!','Fill in the blanks to create variables!',null,1);
    await code(a,'Create a variable called "color" that stores "blue". Replace the blank!','color = "___"\nprint("My favorite color is " + color)\n','My favorite color is blue\n','Type: blue',1);
    await code(a,'Create a variable for your score! Set it to 100.','score = ___\nprint("Score:", score)\n','Score: 100\n','Type the number 100',2);
    await code(a,'Change the animal to "cat"!','animal = "dog"\nanimal = "___"\nprint("I have a " + animal)\n','I have a cat\n','You can change a variable by setting it again!',3);
    a = await act(l6,'match','Variable Match!','Match the variable to its value',null,2);
    await mat(a,'age = 10','Stores number 10',1);
    await mat(a,'name = "Jo"','Stores text Jo',2);
    await mat(a,'score = 0','Starts at zero',3);
    await mat(a,'happy = True','Stores yes/no',4);
    q = await qz(l6,'What is a variable?',1);
    await ch(q,'A math equation',0,1);
    await ch(q,'A named box that stores info',1,2);
    await ch(q,'A type of computer',0,3);

    const l7 = await les(c3,'Loops: Repeat!','Loops repeat code. Instead of writing print() 100 times, just loop it!',3);
    await act(l7,'video','Python Loops','See how loops work!','https://www.youtube.com/embed/UJqogFfQsAs',1);
    a = await act(l7,'codechallenge','Build Loops!','Make Python repeat things!',null,2);
    await code(a,'Make Python print "Hi!" exactly 3 times. Change the number!','for i in range(___):\n    print("Hi!")\n','Hi!\nHi!\nHi!\n','Put the number 3 in range()',1);
    await code(a,'Print the numbers 1 to 5! Change the number in range.','for i in range(1, ___):\n    print(i)\n','1\n2\n3\n4\n5\n','range(1, 6) gives 1,2,3,4,5',2);
    await code(a,'Make a loop that counts to 3 and says "Go!"','for i in range(1, ___):\n    print(i)\nprint("Go!")\n','1\n2\n3\nGo!\n','range(1, 4) counts 1, 2, 3',3);
    a = await act(l7,'sort','Build a Loop!','Put the code in the right order!',null,3);
    await srt(a,'for i in range(3):',1);
    await srt(a,'    print("Hello!")',2);
    await srt(a,'print("Done!")',3);
    q = await qz(l7,'What does a loop do?',1);
    await ch(q,'Repeats instructions',1,1);
    await ch(q,'Deletes code',0,2);
    await ch(q,'Makes the computer faster',0,3);

    const l8 = await les(c3,'If This, Then That!','Computers can make decisions! if age >= 10: means "only do this if age is 10 or more."',4);
    a = await act(l8,'codechallenge','Code Decisions!','Make Python choose!',null,1);
    await code(a,'Set the weather to "sunny" so it prints "Wear sunglasses!"','weather = "___"\nif weather == "sunny":\n    print("Wear sunglasses!")\nelse:\n    print("Bring an umbrella!")\n','Wear sunglasses!\n','Type: sunny',1);
    await code(a,'Set the score high enough to win! You need 100 or more.','score = ___\nif score >= 100:\n    print("You win!")\nelse:\n    print("Keep trying!")\n','You win!\n','Any number 100 or higher works!',2);
    await code(a,'Set temperature to make it print "Perfect day!"','temp = ___\nif temp > 30:\n    print("Too hot!")\nelif temp < 10:\n    print("Too cold!")\nelse:\n    print("Perfect day!")\n','Perfect day!\n','Pick a number between 10 and 30',3);
    a = await act(l8,'truefalse','If/Else True or False!','Tap TRUE or FALSE for each one!',null,2);
    await tf(a,'if checks whether something is true',1,'Yes! if runs code only when the condition is true.',1);
    await tf(a,'else runs when if is true',0,'Nope! else runs when if is FALSE.',2);
    await tf(a,'You can have if without else',1,'Correct! else is optional.',3);
    await tf(a,'== checks if two things are equal',1,'Yes! = sets a value, == checks equality.',4);
    await tf(a,'elif means "else if"',1,'Correct! It checks another condition.',5);
    q = await qz(l8,'What does "if" do in code?',1);
    await ch(q,'Deletes a variable',0,1);
    await ch(q,'Makes a decision based on a condition',1,2);
    await ch(q,'Creates a loop',0,3);

    // BONUS LESSON for CAT 3 — Bug Squash minigame
    const lb3 = await les(c3,'🎁 Bonus Game: Bug Squash!','Bugs in the code! Tap them as fast as you can to squash them!',5);
    await minigame(lb3,'bug_squash','Bug Squash!','Tap bugs to squash them. Get as many as you can in 30 seconds!',1);

    // ===== CAT 4 =====
    const c4 = await cat('AI + Coding','Put it all together!','🚀',4);
    const l9 = await les(c4,'How AI Learns','AI is trained with code + data. Show it examples, it finds patterns. Like a puppy learning tricks!',1);
    await act(l9,'video','How AI Learns','See how AI gets trained!','https://www.youtube.com/embed/zXxuxJvRddU',1);
    a = await act(l9,'sort','Train an AI!','Put the training steps in order',null,2);
    await srt(a,'Collect lots of data',1);
    await srt(a,'Write code to read the data',2);
    await srt(a,'AI finds patterns',3);
    await srt(a,'Test if AI learned right',4);
    await srt(a,'Fix mistakes, try again',5);
    a = await act(l9,'codechallenge','Train a Mini AI!','Use Python to make a simple AI decision!',null,3);
    await code(a,'This code teaches a "mini AI" to detect if a number is big or small. Set the number to 50 to see what happens!','number = ___\nif number >= 50:\n    print("AI says: BIG number!")\nelse:\n    print("AI says: small number")\n','AI says: BIG number!\n','Type 50 or any number >= 50',1);
    await code(a,'Make the AI greet someone! Set the name variable.','name = "___"\ngreeting = "Hello, " + name + "! I am an AI."\nprint(greeting)\n','','Type any name!',2);
    a = await act(l9,'match','AI + Code Vocab!','Match the terms!',null,4);
    await mat(a,'Training','Teaching AI with examples',1);
    await mat(a,'Dataset','Big collection of data',2);
    await mat(a,'Model','The trained AI',3);
    await mat(a,'Prediction','AI guessing an answer',4);
    q = await qz(l9,'What is training an AI?',1);
    await ch(q,'Teaching it with data',1,1);
    await ch(q,'Taking it for a walk',0,2);
    await ch(q,'Giving it a test',0,3);

    const l10 = await les(c4,'Talk to AI Like a Pro!','A "prompt" is what you tell AI. Better prompts = better answers! Be specific!',2);
    a = await act(l10,'sort','Build a Great Prompt!','Arrange the parts of a great prompt!',null,1);
    await srt(a,'Tell me',1);
    await srt(a,'3 fun facts',2);
    await srt(a,'about dolphins',3);
    await srt(a,'for a 10-year-old',4);
    await srt(a,'in simple words',5);
    a = await act(l10,'codechallenge','Code a Prompt Builder!','Use Python to build prompts!',null,2);
    await code(a,'Fill in the topic to build a prompt!','topic = "___"\nprompt = "Tell me 3 fun facts about " + topic\nprint(prompt)\n','','Type any topic like "space" or "dogs"',1);
    await code(a,'Make the prompt ask for a specific number of facts!','num = ___\ntopic = "robots"\nprompt = "Tell me " + str(num) + " facts about " + topic\nprint(prompt)\n','','Any number works!',2);
    a = await act(l10,'truefalse','Prompt Pro!','Are you a prompt master?',null,3);
    await tf(a,'"Tell me stuff" is a good prompt',0,'Too vague! Be specific.',1);
    await tf(a,'Being specific gets better answers',1,'Yes! Details help AI.',2);
    await tf(a,'You can ask AI to explain simply',1,'Correct!',3);
    await tf(a,'There is only one right prompt',0,'Many prompts can work!',4);
    q = await qz(l10,'What is prompt engineering?',1);
    await ch(q,'Building bridges',0,1);
    await ch(q,'Writing good AI instructions',1,2);
    await ch(q,'Programming robots',0,3);

    // BONUS LESSON for CAT 4 — Train the AI minigame
    const lb4 = await les(c4,'🎁 Bonus Game: Train the AI!','Help train an AI by sorting things into the right categories!',3);
    await minigame(lb4,'train_ai','Train the AI!','Tap each thing into the right group to teach the AI!',1);

    await client.query('COMMIT');
    console.log('✓ Database schema + seed complete');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { pool, init, withUser, withAdmin };
