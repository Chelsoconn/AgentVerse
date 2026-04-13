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
      kind TEXT NOT NULL CHECK(kind IN ('background','bonus_game','cosmetic','game_pass'))
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

    -- Universes (group of worlds, capped with a Game Studio)
    CREATE TABLE IF NOT EXISTS universes (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      description TEXT NOT NULL,
      icon TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    -- Categories (worlds inside a universe)
    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      description TEXT NOT NULL,
      icon TEXT NOT NULL,
      universe_id INTEGER REFERENCES universes(id),
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
      activity_type TEXT NOT NULL CHECK(activity_type IN ('video','match','sort','truefalse','codebuilder','fillinblank','codechallenge','minigame','promptpractice')),
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      video_url TEXT,
      game_kind TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS activity_prompt_tasks (
      id SERIAL PRIMARY KEY,
      activity_id INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
      task_description TEXT NOT NULL,
      hint TEXT NOT NULL DEFAULT '',
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
      difficulty TEXT NOT NULL DEFAULT 'easy' CHECK(difficulty IN ('easy','medium','hard')),
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
      game_credits INTEGER NOT NULL DEFAULT 1,
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
    // Categories get universe_id
    await pool.query("ALTER TABLE categories ADD COLUMN IF NOT EXISTS universe_id INTEGER REFERENCES universes(id)");
    // Allow promptpractice activity type on existing DBs
    await pool.query("ALTER TABLE activities DROP CONSTRAINT IF EXISTS activities_activity_type_check");
    await pool.query("ALTER TABLE activities ADD CONSTRAINT activities_activity_type_check CHECK(activity_type IN ('video','match','sort','truefalse','codebuilder','fillinblank','codechallenge','minigame','promptpractice'))");
    // Code challenges get difficulty
    await pool.query("ALTER TABLE activity_code_challenges ADD COLUMN IF NOT EXISTS difficulty TEXT NOT NULL DEFAULT 'easy'");
    await pool.query("ALTER TABLE activity_code_challenges DROP CONSTRAINT IF EXISTS activity_code_challenges_difficulty_check");
    await pool.query("ALTER TABLE activity_code_challenges ADD CONSTRAINT activity_code_challenges_difficulty_check CHECK(difficulty IN ('easy','medium','hard'))");
    // game_pass kind for shop_items
    await pool.query("ALTER TABLE shop_items DROP CONSTRAINT IF EXISTS shop_items_kind_check");
    await pool.query("ALTER TABLE shop_items ADD CONSTRAINT shop_items_kind_check CHECK(kind IN ('background','bonus_game','cosmetic','game_pass'))");
    // game_credits column on user_xp
    await pool.query("ALTER TABLE user_xp ADD COLUMN IF NOT EXISTS game_credits INTEGER NOT NULL DEFAULT 1");
  } catch (e) { console.warn('Migrations:', e.message); }

  // ---------- MIGRATION: ADD COMPUTER BASICS UNIVERSE ----------
  try {
    const hasCS = (await pool.query("SELECT id FROM universes WHERE name = 'Computer Basics'")).rows[0];
    if (!hasCS) {
      console.log('Adding Computer Basics universe...');
      await pool.query("SELECT set_config('app.is_admin', 'true', false)");
      // Shift existing universes to make room at position 2
      await pool.query("UPDATE universes SET sort_order = sort_order + 1 WHERE sort_order >= 2");
      const csUni = (await pool.query(
        "INSERT INTO universes (name, description, icon, sort_order) VALUES ('Computer Basics', 'Learn how computers work from the ground up!', '🖥️', 2) RETURNING id"
      )).rows[0].id;

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const mkCat = async (n,d,i,s) => (await client.query('INSERT INTO categories (name,description,icon,universe_id,sort_order) VALUES ($1,$2,$3,$4,$5) RETURNING id', [n,d,i,csUni,s])).rows[0].id;
        const mkLes = async (c,t,co,s) => (await client.query('INSERT INTO lessons (category_id,title,content,sort_order) VALUES ($1,$2,$3,$4) RETURNING id', [c,t,co,s])).rows[0].id;
        const mkQz = async (l,q,s) => (await client.query('INSERT INTO quizzes (lesson_id,question,sort_order) VALUES ($1,$2,$3) RETURNING id', [l,q,s])).rows[0].id;
        const mkCh = async (q,t,c,s) => client.query('INSERT INTO quiz_choices (quiz_id,choice_text,is_correct,sort_order) VALUES ($1,$2,$3,$4)', [q,t,!!c,s]);
        const mkAct = async (l,t,ti,d,s) => (await client.query('INSERT INTO activities (lesson_id,activity_type,title,description,sort_order) VALUES ($1,$2,$3,$4,$5) RETURNING id', [l,t,ti,d,s])).rows[0].id;
        const mkTF = async (a,stmt,istrue,expl,s) => client.query('INSERT INTO activity_truefalse_items (activity_id,statement,is_true,explanation,sort_order) VALUES ($1,$2,$3,$4,$5)', [a,stmt,!!istrue,expl,s]);
        const mkMatch = async (a,term,def,s) => client.query('INSERT INTO activity_match_pairs (activity_id,term,definition,sort_order) VALUES ($1,$2,$3,$4)', [a,term,def,s]);
        const mkSort = async (a,content,pos) => client.query('INSERT INTO activity_sort_items (activity_id,content,correct_position) VALUES ($1,$2,$3)', [a,content,pos]);
        const mkMini = async (l,kind,ti,d,s) => client.query("INSERT INTO activities (lesson_id,activity_type,title,description,game_kind,sort_order) VALUES ($1,'minigame',$2,$3,$4,$5)", [l,ti,d,kind,s]);
        let a, l, q;

        // ===== WORLD 1: WHAT IS A COMPUTER? =====
        const w1 = await mkCat('What is a Computer?', 'Discover what computers are and how they work!', '🖥️', 1);

        l = await mkLes(w1, 'Computers Are Everywhere', 'A computer is any machine that follows instructions to do a job. They come in all shapes and sizes!\n\nPhones, tablets, game consoles, smart TVs — all computers! Even some refrigerators have tiny computers inside.', 1);
        a = await mkAct(l, 'truefalse', 'Computer or Not?', 'Is it a computer? Tap TRUE or FALSE!', 1);
        await mkTF(a,'A smartphone is a computer',1,'Yes! Phones are powerful computers.',1);
        await mkTF(a,'A wooden chair is a computer',0,'Nope! A chair has no processor.',2);
        await mkTF(a,'A Nintendo Switch is a computer',1,'Yes! Game consoles are computers.',3);
        await mkTF(a,'A paper book is a computer',0,'No! Books don\'t run programs.',4);
        await mkTF(a,'A Tesla car has a computer inside',1,'Yes! Modern cars have computers.',5);
        q = await mkQz(l, 'Which is NOT a computer?', 1);
        await mkCh(q,'A smartphone',0,1);
        await mkCh(q,'A wooden spoon',1,2);
        await mkCh(q,'A game console',0,3);

        l = await mkLes(w1, 'Parts of a Computer', 'Every computer has key parts:\n\n🧠 CPU — the brain, does all the thinking\n💾 Memory (RAM) — remembers things while working\n💿 Storage — saves stuff permanently\n🖥️ Screen — shows you what\'s happening\n⌨️ Keyboard/Mouse — how YOU talk to it', 2);
        a = await mkAct(l, 'match', 'Match the Part!', 'What does each part do?', 1);
        await mkMatch(a,'CPU','The brain — does the thinking',1);
        await mkMatch(a,'RAM','Short-term memory',2);
        await mkMatch(a,'Hard Drive','Saves files permanently',3);
        await mkMatch(a,'Screen','Shows you what\'s happening',4);
        await mkMatch(a,'Keyboard','How you type to the computer',5);
        q = await mkQz(l, 'What is the CPU?', 1);
        await mkCh(q,'The screen',0,1);
        await mkCh(q,'The brain of the computer',1,2);
        await mkCh(q,'The power button',0,3);

        l = await mkLes(w1, 'Input and Output', 'Input = what goes INTO the computer (typing, clicking, talking)\nOutput = what comes OUT (screen, sound, printing)\n\nYou give input → the computer processes it → you get output!', 3);
        a = await mkAct(l, 'truefalse', 'Input or Output?', 'INPUT or OUTPUT? TRUE = input, FALSE = output', 1);
        await mkTF(a,'Typing on a keyboard is INPUT',1,'Yes! You are putting data IN.',1);
        await mkTF(a,'Text on the screen is INPUT',0,'That\'s OUTPUT — data coming OUT.',2);
        await mkTF(a,'Clicking a mouse is INPUT',1,'Yes! You are telling the computer what to do.',3);
        await mkTF(a,'Sound from speakers is INPUT',0,'That\'s OUTPUT — sound coming OUT.',4);
        await mkTF(a,'Speaking into a mic is INPUT',1,'Correct! Your voice goes IN.',5);
        q = await mkQz(l, 'Typing on a keyboard is...', 1);
        await mkCh(q,'Output',0,1);
        await mkCh(q,'Input',1,2);
        await mkCh(q,'Neither',0,3);

        await mkMini(w1,'catch_ai','🎁 Bonus: Catch the Computer!','Tap things that are computers!',4);

        // ===== WORLD 2: HOW COMPUTERS THINK =====
        const w2 = await mkCat('How Computers Think', 'Learn the secret language of computers!', '🧠', 2);

        l = await mkLes(w2, 'Binary: Zeros and Ones', 'Computers only understand TWO things: 0 and 1. That\'s it!\n\n0 = off, 1 = on. Like a light switch.\n\nEvery picture, song, game, and message is secretly made of millions of 0s and 1s!', 1);
        a = await mkAct(l, 'truefalse', 'Binary Facts!', 'Test your binary knowledge!', 1);
        await mkTF(a,'Computers use 0s and 1s',1,'Yes! That\'s called binary.',1);
        await mkTF(a,'Computers understand English directly',0,'Nope! Everything gets converted to binary first.',2);
        await mkTF(a,'A photo is made of 0s and 1s',1,'Yes! Every digital file is binary.',3);
        await mkTF(a,'Binary has 10 different digits',0,'Only 2: zero and one!',4);
        await mkTF(a,'0 means off and 1 means on',1,'Correct! Like a light switch.',5);
        q = await mkQz(l, 'How many digits does binary use?', 1);
        await mkCh(q,'10',0,1);
        await mkCh(q,'2',1,2);
        await mkCh(q,'26',0,3);

        l = await mkLes(w2, 'Following Instructions Exactly', 'Computers follow instructions EXACTLY. No guessing!\n\nIf you say "jump 3 times" a computer jumps EXACTLY 3 times. Not 2, not 4.\n\nThis is why the ORDER of instructions matters — just like steps in a recipe.', 2);
        a = await mkAct(l, 'sort', 'Get Dressed (Computer Style)!', 'A computer puts on clothes step by step. What order?', 1);
        await mkSort(a,'Put on underwear',1);
        await mkSort(a,'Put on pants',2);
        await mkSort(a,'Put on socks',3);
        await mkSort(a,'Put on shoes',4);
        await mkSort(a,'Put on jacket',5);
        q = await mkQz(l, 'Why does order matter for computers?', 1);
        await mkCh(q,'It doesn\'t matter',0,1);
        await mkCh(q,'They follow steps exactly in order',1,2);
        await mkCh(q,'They\'re lazy',0,3);

        l = await mkLes(w2, 'Processing: Think Fast!', 'The CPU does billions of calculations every second!\n\nIt follows a cycle:\n1. FETCH the instruction\n2. DECODE what it means\n3. EXECUTE (do it!)\n4. Repeat billions of times per second', 3);
        a = await mkAct(l, 'sort', 'CPU Cycle!', 'Put the CPU steps in order!', 1);
        await mkSort(a,'Fetch the instruction',1);
        await mkSort(a,'Decode what it means',2);
        await mkSort(a,'Execute (do it!)',3);
        await mkSort(a,'Store the result',4);
        q = await mkQz(l, 'How many calculations can a CPU do per second?', 1);
        await mkCh(q,'About 10',0,1);
        await mkCh(q,'Billions!',1,2);
        await mkCh(q,'One',0,3);

        await mkMini(w2,'bug_squash','🎁 Bonus: Bug Squash!','Squash computer bugs!',4);

        // ===== WORLD 3: THE INTERNET =====
        const w3 = await mkCat('The Internet', 'How computers talk to each other around the world!', '🌐', 3);

        l = await mkLes(w3, 'What is the Internet?', 'The internet is a giant network of computers all connected together!\n\nLike a web of roads connecting every city. Data travels along these "roads" in tiny packets — like digital mail.', 1);
        a = await mkAct(l, 'truefalse', 'Internet Facts!', 'How well do you know the internet?', 1);
        await mkTF(a,'The internet connects computers worldwide',1,'Yes! Billions of them.',1);
        await mkTF(a,'The internet is stored in one big computer',0,'It\'s spread across millions of computers!',2);
        await mkTF(a,'Data travels in small packets',1,'Correct! Like digital mail.',3);
        await mkTF(a,'You need a wire to use the internet',0,'WiFi lets you connect wirelessly!',4);
        await mkTF(a,'The internet and the web are the same thing',0,'The web is just ONE part of the internet.',5);
        q = await mkQz(l, 'What is the internet?', 1);
        await mkCh(q,'One big computer',0,1);
        await mkCh(q,'A network of connected computers',1,2);
        await mkCh(q,'A type of phone',0,3);

        l = await mkLes(w3, 'Websites and Browsers', 'A website is a page (or collection of pages) on the internet.\n\nA browser (like Chrome, Safari, Firefox) is the app you use to VISIT websites.\n\nWhen you type a URL, your browser asks a faraway computer to send you the page!', 2);
        a = await mkAct(l, 'match', 'Web Vocab!', 'Match each term!', 1);
        await mkMatch(a,'Browser','App you use to visit websites',1);
        await mkMatch(a,'URL','The address of a website',2);
        await mkMatch(a,'Server','A computer that stores websites',3);
        await mkMatch(a,'Download','Getting a file FROM the internet',4);
        await mkMatch(a,'Upload','Sending a file TO the internet',5);
        q = await mkQz(l, 'What is a browser?', 1);
        await mkCh(q,'A type of computer',0,1);
        await mkCh(q,'An app to visit websites',1,2);
        await mkCh(q,'A search engine',0,3);

        l = await mkLes(w3, 'Staying Safe Online', 'The internet is awesome but you need to stay safe!\n\n🔒 Never share passwords\n🚫 Don\'t share personal info (address, phone, school)\n🤔 If something feels weird, tell an adult\n✅ Use strong passwords (mix letters, numbers, symbols)', 3);
        a = await mkAct(l, 'truefalse', 'Safety Check!', 'Safe or not safe?', 1);
        await mkTF(a,'Sharing your password with a friend is okay',0,'Never share passwords — even with friends!',1);
        await mkTF(a,'You should tell an adult if something online feels wrong',1,'Yes! Always tell a trusted adult.',2);
        await mkTF(a,'Using the same password for everything is fine',0,'Use different passwords for different sites!',3);
        await mkTF(a,'It\'s okay to share your home address online',0,'Never share personal info online!',4);
        await mkTF(a,'Strong passwords mix letters, numbers, and symbols',1,'Correct! Like "Cr0c$Rul3!"',5);
        q = await mkQz(l, 'What should you do if something online feels wrong?', 1);
        await mkCh(q,'Ignore it',0,1);
        await mkCh(q,'Tell a trusted adult',1,2);
        await mkCh(q,'Share it with friends',0,3);

        await mkMini(w3,'train_ai','🎁 Bonus: Data Sorter!','Sort things into the right groups!',4);

        // ===== WORLD 4: ALGORITHMS =====
        const w4 = await mkCat('Algorithms', 'Step-by-step instructions that solve problems!', '📝', 4);

        l = await mkLes(w4, 'What is an Algorithm?', 'An algorithm is just a set of step-by-step instructions to solve a problem.\n\nA recipe is an algorithm! A morning routine is an algorithm!\n\nComputers use algorithms for EVERYTHING — searching, sorting, playing games.', 1);
        a = await mkAct(l, 'sort', 'Make a PB&J!', 'Put the sandwich-making algorithm in order!', 1);
        await mkSort(a,'Get two slices of bread',1);
        await mkSort(a,'Spread peanut butter on one',2);
        await mkSort(a,'Spread jelly on the other',3);
        await mkSort(a,'Press them together',4);
        await mkSort(a,'Cut in half',5);
        q = await mkQz(l, 'What is an algorithm?', 1);
        await mkCh(q,'A type of computer',0,1);
        await mkCh(q,'Step-by-step instructions',1,2);
        await mkCh(q,'A math formula',0,3);

        l = await mkLes(w4, 'Sorting Things', 'Sorting means putting things in order — smallest to biggest, A to Z, newest to oldest.\n\nComputers sort things ALL the time. Your playlist, your contacts, search results — all sorted by algorithms!', 2);
        a = await mkAct(l, 'sort', 'Sort These Numbers!', 'Put them from smallest to biggest!', 1);
        await mkSort(a,'3',1);
        await mkSort(a,'7',2);
        await mkSort(a,'15',3);
        await mkSort(a,'42',4);
        await mkSort(a,'99',5);
        a = await mkAct(l, 'truefalse', 'Sorting Facts!', 'True or false?', 2);
        await mkTF(a,'Computers can sort millions of items in seconds',1,'Yes! Sorting algorithms are super fast.',1);
        await mkTF(a,'There is only one way to sort things',0,'There are many sorting algorithms!',2);
        await mkTF(a,'Your music playlist uses sorting',1,'Correct! Songs are sorted by name, artist, etc.',3);
        q = await mkQz(l, 'What does sorting mean?', 1);
        await mkCh(q,'Deleting things',0,1);
        await mkCh(q,'Putting things in order',1,2);
        await mkCh(q,'Making things bigger',0,3);

        l = await mkLes(w4, 'Searching: Finding Things', 'Searching = finding a specific thing in a collection.\n\nWhen you search on Google, an algorithm looks through BILLIONS of pages to find what you want — in less than a second!\n\nTwo ways to search:\n📖 Linear: check one by one\n📚 Binary: split in half each time (much faster!)', 3);
        a = await mkAct(l, 'match', 'Search Match!', 'Match the search type!', 1);
        await mkMatch(a,'Linear Search','Check items one by one',1);
        await mkMatch(a,'Binary Search','Split in half each time',2);
        await mkMatch(a,'Google Search','Searches billions of pages',3);
        await mkMatch(a,'Ctrl+F','Finds text in a document',4);
        q = await mkQz(l, 'Which search is faster for sorted data?', 1);
        await mkCh(q,'Linear (one by one)',0,1);
        await mkCh(q,'Binary (split in half)',1,2);
        await mkCh(q,'Random',0,3);

        await mkMini(w4,'pick_tool','🎁 Bonus: Pick the Algorithm!','Choose the right approach!',4);

        // ===== WORLD 5: DATA & FILES =====
        const w5 = await mkCat('Data & Files', 'Everything on a computer is data!', '📊', 5);

        l = await mkLes(w5, 'What is Data?', 'Data is just information! Numbers, words, pictures, sounds — all data.\n\nComputers store data as files. A photo is a file. A song is a file. Even this lesson is data!', 1);
        a = await mkAct(l, 'match', 'Types of Data!', 'Match the data type!', 1);
        await mkMatch(a,'📸 Photo','Image data',1);
        await mkMatch(a,'🎵 Song','Audio data',2);
        await mkMatch(a,'📝 Essay','Text data',3);
        await mkMatch(a,'🎬 Movie','Video data',4);
        await mkMatch(a,'📊 Spreadsheet','Number data',5);
        q = await mkQz(l, 'What is data?', 1);
        await mkCh(q,'Only numbers',0,1);
        await mkCh(q,'Any kind of information',1,2);
        await mkCh(q,'Only text',0,3);

        l = await mkLes(w5, 'Files and Folders', 'Files are like papers — each one holds information.\nFolders organize your files — like a filing cabinet!\n\nGood organization = finding things fast.\nHomework/Math/worksheet1.pdf is much better than putting everything on the desktop!', 2);
        a = await mkAct(l, 'sort', 'Organize It!', 'Put these file actions in the right order!', 1);
        await mkSort(a,'Create a new folder',1);
        await mkSort(a,'Give it a clear name',2);
        await mkSort(a,'Move related files into it',3);
        await mkSort(a,'Save your work',4);
        q = await mkQz(l, 'Why use folders?', 1);
        await mkCh(q,'To make files bigger',0,1);
        await mkCh(q,'To organize and find things easily',1,2);
        await mkCh(q,'Folders aren\'t useful',0,3);

        l = await mkLes(w5, 'Bits, Bytes, and Beyond', 'The smallest piece of data = 1 bit (a single 0 or 1).\n8 bits = 1 byte (enough for one letter!)\n\n1,000 bytes = 1 kilobyte (KB) — a short email\n1,000 KB = 1 megabyte (MB) — a photo\n1,000 MB = 1 gigabyte (GB) — a movie\n1,000 GB = 1 terabyte (TB) — a whole library!', 3);
        a = await mkAct(l, 'sort', 'Smallest to Biggest!', 'Put these data sizes in order!', 1);
        await mkSort(a,'Bit (1 or 0)',1);
        await mkSort(a,'Byte (one letter)',2);
        await mkSort(a,'Kilobyte (short email)',3);
        await mkSort(a,'Megabyte (a photo)',4);
        await mkSort(a,'Gigabyte (a movie)',5);
        q = await mkQz(l, 'How many bits make a byte?', 1);
        await mkCh(q,'2',0,1);
        await mkCh(q,'8',1,2);
        await mkCh(q,'100',0,3);

        await mkMini(w5,'train_ai','🎁 Bonus: Data Detective!','Sort the data into categories!',4);

        // ===== WORLD 6: PROBLEM SOLVING =====
        const w6 = await mkCat('Problem Solving', 'Think like a computer scientist!', '🧩', 6);

        l = await mkLes(w6, 'Break It Down', 'Big problems are scary. Small problems are easy!\n\nDecomposition = breaking a big problem into small pieces.\n\n"Build a game" is hard. But:\n1. Draw the character ✅\n2. Make it move ✅\n3. Add a score ✅\nEach small step is doable!', 1);
        a = await mkAct(l, 'sort', 'Plan a Birthday Party!', 'Break this big task into ordered steps!', 1);
        await mkSort(a,'Pick a date',1);
        await mkSort(a,'Make a guest list',2);
        await mkSort(a,'Send invitations',3);
        await mkSort(a,'Buy food and decorations',4);
        await mkSort(a,'Set up and have fun!',5);
        q = await mkQz(l, 'What is decomposition?', 1);
        await mkCh(q,'Making things rot',0,1);
        await mkCh(q,'Breaking big problems into small steps',1,2);
        await mkCh(q,'Composing music',0,3);

        l = await mkLes(w6, 'Finding Bugs', 'A bug = something that\'s wrong in a program or plan.\nDebugging = finding and fixing the bug!\n\nDebugging tips:\n🔍 Read the error message carefully\n🤔 What SHOULD happen vs what DID happen?\n🧪 Test one small thing at a time', 2);
        a = await mkAct(l, 'truefalse', 'Debugging Facts!', 'True or false?', 1);
        await mkTF(a,'A bug is an error in code',1,'Yes! Bugs make programs do unexpected things.',1);
        await mkTF(a,'The best programmers never make bugs',0,'Everyone makes bugs! Fixing them is the skill.',2);
        await mkTF(a,'Reading error messages helps find bugs',1,'Correct! Error messages are clues.',3);
        await mkTF(a,'If code doesn\'t work, you should give up',0,'Never! Debug step by step.',4);
        await mkTF(a,'Testing one thing at a time helps',1,'Yes! Isolate the problem.',5);
        q = await mkQz(l, 'What is debugging?', 1);
        await mkCh(q,'Adding bugs',0,1);
        await mkCh(q,'Finding and fixing errors',1,2);
        await mkCh(q,'Deleting everything',0,3);

        l = await mkLes(w6, 'Patterns Everywhere', 'A pattern = something that repeats in a predictable way.\n\nComputer scientists LOVE patterns because:\n🔁 Patterns let you write less code (use loops!)\n🔮 Patterns let you predict what comes next\n🧠 Recognizing patterns = thinking smart', 3);
        a = await mkAct(l, 'match', 'Spot the Pattern!', 'Match each pattern to its type!', 1);
        await mkMatch(a,'1, 2, 3, 4, 5...','Counting up by 1',1);
        await mkMatch(a,'2, 4, 6, 8...','Counting up by 2',2);
        await mkMatch(a,'Mon, Tue, Wed...','Days of the week',3);
        await mkMatch(a,'🔴🔵🔴🔵...','Alternating colors',4);
        q = await mkQz(l, 'Why are patterns useful in coding?', 1);
        await mkCh(q,'They look pretty',0,1);
        await mkCh(q,'They let you write less code and predict things',1,2);
        await mkCh(q,'They aren\'t useful',0,3);

        await mkMini(w6,'bug_squash','🎁 Bonus: Bug Hunt!','Find and squash all the bugs!',4);

        await client.query('COMMIT');
        console.log('✓ Created Computer Basics universe with 6 worlds');
      } catch (e) {
        await client.query('ROLLBACK');
        console.warn('CS101 seed failed:', e.message);
      } finally {
        client.release();
      }
    }
  } catch (e) { console.warn('CS101 check:', e.message); }

  // ---------- MIGRATION: RESTRUCTURE PYTHON INTO DEEP WORLDS ----------
  try {
    const oldPython = (await pool.query("SELECT id FROM categories WHERE name = 'Python Coding'")).rows[0];
    if (oldPython) {
      console.log('Restructuring Python into deep worlds...');
      // Set admin flag so RLS lets us clean user data
      await pool.query("SELECT set_config('app.is_admin', 'true', false)");
      const uni2 = (await pool.query("SELECT id FROM universes WHERE sort_order = 2")).rows[0].id;
      // Create Universe 3 for AI+Coding if it doesn't exist
      let uni3 = (await pool.query("SELECT id FROM universes WHERE sort_order = 3")).rows[0];
      if (!uni3) {
        uni3 = (await pool.query(
          "INSERT INTO universes (name, description, icon, sort_order) VALUES ('AI + Coding', 'Combine AI with your coding skills!', '🚀', 3) RETURNING id"
        )).rows[0];
      }
      // Move AI + Coding category to Universe 3
      await pool.query("UPDATE categories SET universe_id = $1 WHERE name = 'AI + Coding'", [uni3.id]);
      // Rename Universe 2
      await pool.query("UPDATE universes SET name = 'Python Basics', description = 'Master Python one step at a time!', icon = '🐍' WHERE id = $1", [uni2]);

      // Delete old Python Coding category and all its content
      // Must clean user data first due to FK constraints
      const oldLessons = (await pool.query("SELECT id FROM lessons WHERE category_id = $1", [oldPython.id])).rows;
      const oldLessonIds = oldLessons.map(l => l.id);
      if (oldLessonIds.length > 0) {
        // Clean user progress/answers referencing these lessons
        const oldQuizIds = (await pool.query("SELECT id FROM quizzes WHERE lesson_id = ANY($1::int[])", [oldLessonIds])).rows.map(q => q.id);
        if (oldQuizIds.length > 0) {
          await pool.query("DELETE FROM user_quiz_answers WHERE quiz_id = ANY($1::int[])", [oldQuizIds]);
          await pool.query("DELETE FROM quiz_choices WHERE quiz_id = ANY($1::int[])", [oldQuizIds]);
          await pool.query("DELETE FROM quizzes WHERE id = ANY($1::int[])", [oldQuizIds]);
        }
        const oldActIds = (await pool.query("SELECT id FROM activities WHERE lesson_id = ANY($1::int[])", [oldLessonIds])).rows.map(a => a.id);
        if (oldActIds.length > 0) {
          await pool.query("DELETE FROM user_activity_scores WHERE activity_id = ANY($1::int[])", [oldActIds]);
          await pool.query("DELETE FROM activity_code_challenges WHERE activity_id = ANY($1::int[])", [oldActIds]);
          await pool.query("DELETE FROM activity_match_pairs WHERE activity_id = ANY($1::int[])", [oldActIds]);
          await pool.query("DELETE FROM activity_sort_items WHERE activity_id = ANY($1::int[])", [oldActIds]);
          await pool.query("DELETE FROM activity_truefalse_items WHERE activity_id = ANY($1::int[])", [oldActIds]);
          const oldBlankIds = (await pool.query("SELECT id FROM activity_blanks WHERE activity_id = ANY($1::int[])", [oldActIds])).rows.map(b => b.id);
          if (oldBlankIds.length > 0) await pool.query("DELETE FROM activity_blank_options WHERE blank_id = ANY($1::int[])", [oldBlankIds]);
          await pool.query("DELETE FROM activity_blanks WHERE activity_id = ANY($1::int[])", [oldActIds]);
          await pool.query("DELETE FROM activities WHERE id = ANY($1::int[])", [oldActIds]);
        }
        await pool.query("DELETE FROM user_lesson_progress WHERE lesson_id = ANY($1::int[])", [oldLessonIds]);
        await pool.query("DELETE FROM lessons WHERE id = ANY($1::int[])", [oldLessonIds]);
      }
      await pool.query("DELETE FROM categories WHERE id = $1", [oldPython.id]);

      // Create 4 new Python worlds
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Helpers
        const mkCat = async (n,d,i,s) => (await client.query('INSERT INTO categories (name,description,icon,universe_id,sort_order) VALUES ($1,$2,$3,$4,$5) RETURNING id', [n,d,i,uni2,s])).rows[0].id;
        const mkLes = async (c,t,co,s) => (await client.query('INSERT INTO lessons (category_id,title,content,sort_order) VALUES ($1,$2,$3,$4) RETURNING id', [c,t,co,s])).rows[0].id;
        const mkQz = async (l,q,s) => (await client.query('INSERT INTO quizzes (lesson_id,question,sort_order) VALUES ($1,$2,$3) RETURNING id', [l,q,s])).rows[0].id;
        const mkCh = async (q,t,c,s) => client.query('INSERT INTO quiz_choices (quiz_id,choice_text,is_correct,sort_order) VALUES ($1,$2,$3,$4)', [q,t,!!c,s]);
        const mkAct = async (l,t,ti,d,s) => (await client.query('INSERT INTO activities (lesson_id,activity_type,title,description,sort_order) VALUES ($1,$2,$3,$4,$5) RETURNING id', [l,t,ti,d,s])).rows[0].id;
        const mkCode = async (a,inst,starter,exp,hint,diff,s) => client.query('INSERT INTO activity_code_challenges (activity_id,instructions,starter_code,expected_output,hint,difficulty,sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7)', [a,inst,starter,exp,hint,diff,s]);
        const mkTF = async (a,stmt,istrue,expl,s) => client.query('INSERT INTO activity_truefalse_items (activity_id,statement,is_true,explanation,sort_order) VALUES ($1,$2,$3,$4,$5)', [a,stmt,!!istrue,expl,s]);
        const mkMatch = async (a,term,def,s) => client.query('INSERT INTO activity_match_pairs (activity_id,term,definition,sort_order) VALUES ($1,$2,$3,$4)', [a,term,def,s]);
        const mkSort = async (a,content,pos) => client.query('INSERT INTO activity_sort_items (activity_id,content,correct_position) VALUES ($1,$2,$3)', [a,content,pos]);
        const mkMini = async (l,kind,ti,d,s) => client.query("INSERT INTO activities (lesson_id,activity_type,title,description,game_kind,sort_order) VALUES ($1,'minigame',$2,$3,$4,$5)", [l,ti,d,kind,s]);

        // ===== WORLD 1: HELLO PYTHON =====
        const w1 = await mkCat('Hello Python!', 'Learn to make Python talk with print()', '👋', 1);

        let l = await mkLes(w1, 'Meet Python', 'Python is a coding language that even beginners can learn! It reads almost like English.\n\nThe first thing to learn: print() — it makes Python show text on the screen.', 1);
        let a = await mkAct(l, 'match', 'Python Vocab!', 'Match each word to what it means', 1);
        await mkMatch(a,'print()','Shows text on the screen',1);
        await mkMatch(a,'Python','A coding language',2);
        await mkMatch(a,'code','Instructions for a computer',3);
        await mkMatch(a,'string','Text inside quotes',4);
        let q = await mkQz(l, 'What does print() do?', 1);
        await mkCh(q,'Shows text on screen',1,1);
        await mkCh(q,'Prints paper',0,2);
        await mkCh(q,'Deletes code',0,3);

        l = await mkLes(w1, 'Your First print()', 'Time to write code! print("Hello!") makes Python say Hello!\n\nAnything inside the quotes is what Python will show.', 2);
        a = await mkAct(l, 'codechallenge', 'Say Hello!', 'Make Python speak!', 1);
        await mkCode(a,'EASY: Replace <TYPE HERE> with "Hello!"','print(<TYPE HERE>)\n','Hello!\n','Type "Hello!" with the quotes','easy',1);
        await mkCode(a,'MEDIUM: Write a print statement that says Hello!','# Write your print below:\n<TYPE HERE>\n','Hello!\n','It looks like: print("Hello!")','medium',2);
        await mkCode(a,'HARD: Make Python say Hello! any way you want','','Hello!\n','Use print() with "Hello!" inside','hard',3);
        q = await mkQz(l, 'Which shows text in Python?', 1);
        await mkCh(q,'say("hi")',0,1);
        await mkCh(q,'print("hi")',1,2);
        await mkCh(q,'show("hi")',0,3);

        l = await mkLes(w1, 'Print More Things!', 'You can print anything! Numbers, words, even emoji descriptions.\n\nTry printing multiple lines — each print() goes on a new line.', 3);
        a = await mkAct(l, 'codechallenge', 'Print Party!', 'Print multiple things!', 1);
        await mkCode(a,'EASY: Replace <TYPE HERE> with a number','print(<TYPE HERE>)\n','42\n','Just type 42','easy',1);
        await mkCode(a,'MEDIUM: Print "I love coding" on one line','# Print the sentence below:\n<TYPE HERE>\n','I love coding\n','Use print("I love coding")','medium',2);
        await mkCode(a,'HARD: Print these 3 lines: Hello / I am learning / Python is fun','','Hello\nI am learning\nPython is fun\n','Use three separate print() statements','hard',3);
        q = await mkQz(l, 'How many lines does print("A")\\nprint("B") show?', 1);
        await mkCh(q,'1 line',0,1);
        await mkCh(q,'2 lines',1,2);
        await mkCh(q,'3 lines',0,3);

        await mkMini(w1,'bug_squash','🎁 Bonus: Bug Squash!','Squash bugs as fast as you can!',4);

        // ===== WORLD 2: VARIABLES =====
        const w2 = await mkCat('Variables', 'Store and use information with named boxes!', '📦', 2);

        l = await mkLes(w2, 'What is a Variable?', 'A variable is like a labeled box. You put info in, and use the label to find it later!\n\nname = "Alex" puts "Alex" in a box called name.', 1);
        a = await mkAct(l, 'truefalse', 'Variable True or False!', 'Test your variable knowledge!', 1);
        await mkTF(a,'A variable stores information',1,'Yes! Variables hold data.',1);
        await mkTF(a,'Variable names can have spaces',0,'Nope! Use underscores like my_name.',2);
        await mkTF(a,'You can change a variable later',1,'Yes! Just assign a new value.',3);
        await mkTF(a,'name = "Jo" stores the number 10',0,'It stores the text "Jo"!',4);
        q = await mkQz(l, 'What is a variable?', 1);
        await mkCh(q,'A box that stores info',1,1);
        await mkCh(q,'A math equation',0,2);
        await mkCh(q,'A type of computer',0,3);

        l = await mkLes(w2, 'Text Variables', 'Text in Python is called a "string". Always put strings in quotes!\n\nname = "Alex"\nprint(name) shows Alex', 2);
        a = await mkAct(l, 'codechallenge', 'String Practice!', 'Create text variables!', 1);
        await mkCode(a,'EASY: Set name to "Alex"','name = <TYPE HERE>\nprint(name)\n','Alex\n','Type "Alex" with quotes','easy',1);
        await mkCode(a,'MEDIUM: Create a variable called food that stores "pizza" and print it','<TYPE HERE>\nprint(food)\n','pizza\n','Write: food = "pizza"','medium',2);
        await mkCode(a,'HARD: Create two variables (first and last name) and print them together','','Alex Smith\n','Use + to combine: print(first + " " + last)','hard',3);
        q = await mkQz(l, 'Text in Python is called a...', 1);
        await mkCh(q,'number',0,1);
        await mkCh(q,'string',1,2);
        await mkCh(q,'variable',0,3);

        l = await mkLes(w2, 'Number Variables', 'Variables can hold numbers too! No quotes needed for numbers.\n\nage = 10\nscore = 0\nYou can do math with number variables!', 3);
        a = await mkAct(l, 'codechallenge', 'Number Crunch!', 'Work with number variables!', 1);
        await mkCode(a,'EASY: Set score to 100','score = <TYPE HERE>\nprint("Score:", score)\n','Score: 100\n','Just type 100','easy',1);
        await mkCode(a,'MEDIUM: Create age = 10 and print it','<TYPE HERE>\nprint("Age:", age)\n','Age: 10\n','Write: age = 10','medium',2);
        await mkCode(a,'HARD: Create two number variables and print their sum','','15\n','Try: a = 10, b = 5, print(a + b)','hard',3);
        q = await mkQz(l, 'Do numbers need quotes?', 1);
        await mkCh(q,'Yes always',0,1);
        await mkCh(q,'No, only text needs quotes',1,2);
        await mkCh(q,'Only big numbers',0,3);

        l = await mkLes(w2, 'Changing Variables', 'You can change a variable anytime by assigning a new value!\n\ncolor = "red"\ncolor = "blue"  # now color is blue\nThe old value is replaced.', 4);
        a = await mkAct(l, 'codechallenge', 'Change It Up!', 'Practice changing variables!', 1);
        await mkCode(a,'EASY: Change animal to "cat"','animal = "dog"\nanimal = <TYPE HERE>\nprint(animal)\n','cat\n','Type "cat" with quotes','easy',1);
        await mkCode(a,'MEDIUM: Set x to 5 then change it to 10 and print it','x = 5\n<TYPE HERE>\nprint(x)\n','10\n','Write: x = 10','medium',2);
        await mkCode(a,'HARD: Create a variable, change it 3 times, print the final value as "blue"','','blue\n','The last assignment wins!','hard',3);
        q = await mkQz(l, 'What happens when you change a variable?', 1);
        await mkCh(q,'It keeps both values',0,1);
        await mkCh(q,'The old value is replaced',1,2);
        await mkCh(q,'It creates a new variable',0,3);

        await mkMini(w2,'train_ai','🎁 Bonus: Train the AI!','Sort things into the right categories!',5);

        // ===== WORLD 3: LOOPS =====
        const w3 = await mkCat('Loops', 'Make Python repeat things for you!', '🔄', 3);

        l = await mkLes(w3, 'What is a Loop?', 'A loop repeats code. Instead of writing print("Hi") 100 times, use a loop!\n\nfor i in range(3): makes the next line happen 3 times.', 1);
        a = await mkAct(l, 'sort', 'Loop Steps!', 'Put the loop code in the right order!', 1);
        await mkSort(a,'for i in range(3):',1);
        await mkSort(a,'    print("Hello!")',2);
        await mkSort(a,'print("Done!")',3);
        a = await mkAct(l, 'truefalse', 'Loop Facts!', 'True or false about loops?', 2);
        await mkTF(a,'A loop repeats code',1,'Yes! That is exactly what loops do.',1);
        await mkTF(a,'Loops make code longer',0,'They make it SHORTER!',2);
        await mkTF(a,'range(5) means repeat 5 times',1,'Correct!',3);
        await mkTF(a,'You can only loop once',0,'You can loop any number of times!',4);
        q = await mkQz(l, 'What does a loop do?', 1);
        await mkCh(q,'Repeats code',1,1);
        await mkCh(q,'Deletes code',0,2);
        await mkCh(q,'Saves a file',0,3);

        l = await mkLes(w3, 'For Loops', 'for i in range(N): repeats N times.\n\nrange(3) = 0, 1, 2 (three numbers)\nrange(1, 5) = 1, 2, 3, 4 (starts at 1, stops before 5)', 2);
        a = await mkAct(l, 'codechallenge', 'Loop It!', 'Make Python repeat!', 1);
        await mkCode(a,'EASY: Make it print Hi! exactly 3 times','for i in range(<TYPE HERE>):\n    print("Hi!")\n','Hi!\nHi!\nHi!\n','Type 3','easy',1);
        await mkCode(a,'MEDIUM: Write a loop that prints "Go!" 4 times','<TYPE HERE>:\n    print("Go!")\n','Go!\nGo!\nGo!\nGo!\n','Write: for i in range(4)','medium',2);
        await mkCode(a,'HARD: Print the numbers 1, 2, 3, 4, 5 (one per line)','','1\n2\n3\n4\n5\n','Try: for i in range(1, 6): print(i)','hard',3);
        q = await mkQz(l, 'What does range(4) give you?', 1);
        await mkCh(q,'1, 2, 3, 4',0,1);
        await mkCh(q,'0, 1, 2, 3',1,2);
        await mkCh(q,'4, 4, 4, 4',0,3);

        l = await mkLes(w3, 'Loop Patterns', 'Loops can build patterns! Try printing shapes with loops.\n\nYou can use string multiplication: "* " * 3 gives "* * * "', 3);
        a = await mkAct(l, 'codechallenge', 'Pattern Maker!', 'Use loops to make patterns!', 1);
        await mkCode(a,'EASY: Make it print *** (three stars)','print("*" * <TYPE HERE>)\n','***\n','Type 3','easy',1);
        await mkCode(a,'MEDIUM: Use a loop to print 3 rows of ***','<TYPE HERE>:\n    print("***")\n','***\n***\n***\n','Write: for i in range(3)','medium',2);
        await mkCode(a,'HARD: Print a triangle: *, **, *** (each on its own line)','','*\n**\n***\n','Try: for i in range(1, 4): print("*" * i)','hard',3);
        q = await mkQz(l, 'What does "*" * 3 give you?', 1);
        await mkCh(q,'3',0,1);
        await mkCh(q,'***',1,2);
        await mkCh(q,'* 3',0,3);

        await mkMini(w3,'catch_ai','🎁 Bonus: Catch the AI!','Tap AI things before they fall!',4);

        // ===== WORLD 4: IF/ELSE =====
        const w4 = await mkCat('If / Else', 'Teach Python to make decisions!', '🔀', 4);

        l = await mkLes(w4, 'Making Choices', 'Computers can decide! if checks a condition.\n\nif age >= 10: means "only do this when age is 10 or more."\n\nThe code underneath only runs if the condition is True.', 1);
        a = await mkAct(l, 'match', 'Condition Match!', 'Match the condition to what it checks!', 1);
        await mkMatch(a,'age >= 10','Age is 10 or more',1);
        await mkMatch(a,'score == 100','Score is exactly 100',2);
        await mkMatch(a,'name == "Jo"','Name is Jo',3);
        await mkMatch(a,'x < 5','x is less than 5',4);
        q = await mkQz(l, 'What does if do?', 1);
        await mkCh(q,'Runs code only when a condition is true',1,1);
        await mkCh(q,'Deletes a variable',0,2);
        await mkCh(q,'Creates a loop',0,3);

        l = await mkLes(w4, 'If and Else', 'else runs when the if condition is False.\n\nif sunny: go outside\nelse: stay inside\n\nOne path always runs!', 2);
        a = await mkAct(l, 'codechallenge', 'Choose a Path!', 'Make Python decide!', 1);
        await mkCode(a,'EASY: Set weather to "sunny" so it prints Go outside!','weather = <TYPE HERE>\nif weather == "sunny":\n    print("Go outside!")\nelse:\n    print("Stay inside!")\n','Go outside!\n','Type "sunny" with quotes','easy',1);
        await mkCode(a,'MEDIUM: Write the if line that checks if score >= 100','score = 200\n<TYPE HERE>:\n    print("You win!")\nelse:\n    print("Try again!")\n','You win!\n','Write: if score >= 100','medium',2);
        await mkCode(a,'HARD: Write code that prints "Even" if a number is even, "Odd" otherwise','','Even\n','Try: n = 4, if n % 2 == 0: print("Even") else: print("Odd")','hard',3);
        q = await mkQz(l, 'When does else run?', 1);
        await mkCh(q,'When if is True',0,1);
        await mkCh(q,'When if is False',1,2);
        await mkCh(q,'Always',0,3);

        l = await mkLes(w4, 'Elif: More Choices', 'elif means "else if" — it checks another condition.\n\nif temp > 30: hot\nelif temp > 20: warm\nelse: cold\n\nPython checks each one in order and runs the first that is True.', 3);
        a = await mkAct(l, 'codechallenge', 'Multiple Paths!', 'Use elif for more choices!', 1);
        await mkCode(a,'EASY: Set temp to 25 so it prints Nice day!','temp = <TYPE HERE>\nif temp > 30:\n    print("Too hot!")\nelif temp > 15:\n    print("Nice day!")\nelse:\n    print("Too cold!")\n','Nice day!\n','Any number 16-30 works','easy',1);
        await mkCode(a,'MEDIUM: Write the elif line that checks if grade >= 70','grade = 80\nif grade >= 90:\n    print("A")\n<TYPE HERE>:\n    print("B")\nelse:\n    print("C")\n','B\n','Write: elif grade >= 70','medium',2);
        await mkCode(a,'HARD: Write code that prints "big" for numbers >= 100, "medium" for >= 50, "small" otherwise. Use number = 75.','','medium\n','Use if/elif/else with the number 75','hard',3);
        q = await mkQz(l, 'What does elif mean?', 1);
        await mkCh(q,'else if — another condition to check',1,1);
        await mkCh(q,'elephant if',0,2);
        await mkCh(q,'end loop',0,3);

        await mkMini(w4,'pick_tool','🎁 Bonus: Pick the Tool!','Help the agent pick the right tool!',4);

        await client.query('COMMIT');
        console.log('✓ Created 4 deep Python worlds');
      } catch (e) {
        await client.query('ROLLBACK');
        console.warn('Python restructure failed:', e.message);
      } finally {
        client.release();
      }
    }
  } catch (e) { console.warn('Python restructure check:', e.message); }

  // ---------- MIGRATION: REDESIGN CODE CHALLENGES INTO 3 DIFFICULTY LEVELS ----------
  try {
    const usesNewFormat = (await pool.query("SELECT COUNT(*)::int AS c FROM activity_code_challenges WHERE starter_code LIKE '%TYPE HERE%'")).rows[0].c > 0;
    if (!usesNewFormat) {
      // Define 3-level versions keyed by activity title (matches what's in the seed below)
      const CODE_LEVELS = {
        'Make Python Say Hello!': [
          { difficulty: 'easy', instructions: 'EASY: Replace <TYPE HERE> with the word Hello! (keep the quotes)', starter: 'print(<TYPE HERE>)\n', hint: 'Type "Hello!" between the parentheses (with the quotes!)' },
          { difficulty: 'medium', instructions: 'MEDIUM: Write the line that prints Hello! Use print()', starter: '# Print Hello! below using print()\n<TYPE HERE>\n', hint: 'It looks like: print("Hello!")' },
          { difficulty: 'hard', instructions: 'HARD: Write code that prints exactly: Hello!', starter: '', hint: 'Use the print() function with the text Hello! in quotes' },
        ],
        'Create Variables!': [
          { difficulty: 'easy', instructions: 'EASY: Replace <TYPE HERE> with "blue" (with quotes!) so it prints My favorite color is blue', starter: 'color = <TYPE HERE>\nprint("My favorite color is " + color)\n', hint: 'Type "blue" — including the quotes' },
          { difficulty: 'medium', instructions: 'MEDIUM: Write the variable assignment that stores "blue" in color', starter: '<TYPE HERE>\nprint("My favorite color is " + color)\n', hint: 'It looks like: color = "blue"' },
          { difficulty: 'hard', instructions: 'HARD: Write code that prints exactly: My favorite color is blue', starter: '', hint: 'Use a variable called color and the + symbol to join words' },
        ],
        'Build Loops!': [
          { difficulty: 'easy', instructions: 'EASY: Replace <TYPE HERE> with the number 3 so Hi! prints three times', starter: 'for i in range(<TYPE HERE>):\n    print("Hi!")\n', hint: 'Just type 3' },
          { difficulty: 'medium', instructions: 'MEDIUM: Write the for line so it loops 3 times', starter: '<TYPE HERE>:\n    print("Hi!")\n', hint: 'It looks like: for i in range(3)' },
          { difficulty: 'hard', instructions: 'HARD: Write code that prints Hi! three times', starter: '', hint: 'A for loop with range(3) will repeat 3 times' },
        ],
        'Code Decisions!': [
          { difficulty: 'easy', instructions: 'EASY: Replace <TYPE HERE> with a number 100 or higher so it prints You win!', starter: 'score = <TYPE HERE>\nif score >= 100:\n    print("You win!")\nelse:\n    print("Keep trying!")\n', hint: 'Try 100 or 200' },
          { difficulty: 'medium', instructions: 'MEDIUM: Write the if line that checks if score is 100 or more', starter: 'score = 200\n<TYPE HERE>:\n    print("You win!")\nelse:\n    print("Keep trying!")\n', hint: 'It looks like: if score >= 100' },
          { difficulty: 'hard', instructions: 'HARD: Write code that prints You win!', starter: '', hint: 'You can just print it directly, or use a variable + if statement' },
        ],
        'Train a Mini AI!': [
          { difficulty: 'easy', instructions: 'EASY: Set number to 50 or higher so the AI says BIG!', starter: 'number = <TYPE HERE>\nif number >= 50:\n    print("AI says: BIG number!")\nelse:\n    print("AI says: small number")\n', hint: 'Try 50, 100, or 999' },
          { difficulty: 'medium', instructions: 'MEDIUM: Write the if line that checks if number is 50 or more', starter: 'number = 75\n<TYPE HERE>:\n    print("AI says: BIG number!")\nelse:\n    print("AI says: small number")\n', hint: 'It looks like: if number >= 50' },
          { difficulty: 'hard', instructions: 'HARD: Write code that prints exactly: AI says: BIG number!', starter: '', hint: 'Just use print() with the message' },
        ],
        'Code a Prompt Builder!': [
          { difficulty: 'easy', instructions: 'EASY: Set topic to a word like "space" so the prompt builds correctly', starter: 'topic = <TYPE HERE>\nprompt = "Tell me 3 fun facts about " + topic\nprint(prompt)\n', hint: 'Try "space" or "robots" (with quotes)' },
          { difficulty: 'medium', instructions: 'MEDIUM: Write the variable line that stores "robots" in topic', starter: '<TYPE HERE>\nprompt = "Tell me 3 fun facts about " + topic\nprint(prompt)\n', hint: 'It looks like: topic = "robots"' },
          { difficulty: 'hard', instructions: 'HARD: Write code that prints exactly: Tell me 3 fun facts about robots', starter: '', hint: 'You can just print the whole sentence directly!' },
        ],
      };
      const codeActs = (await pool.query("SELECT id, title FROM activities WHERE activity_type = 'codechallenge'")).rows;
      for (const ca of codeActs) {
        const levels = CODE_LEVELS[ca.title];
        if (!levels) continue;
        // Wipe old challenges (and any user scores tied to this activity will become orphaned, which is OK)
        await pool.query('DELETE FROM activity_code_challenges WHERE activity_id = $1', [ca.id]);
        for (let i = 0; i < levels.length; i++) {
          const lv = levels[i];
          // Expected output is the same for all levels of an activity
          const expected = ({
            'Make Python Say Hello!': 'Hello!\n',
            'Create Variables!': 'My favorite color is blue\n',
            'Build Loops!': 'Hi!\nHi!\nHi!\n',
            'Code Decisions!': 'You win!\n',
            'Train a Mini AI!': 'AI says: BIG number!\n',
            'Code a Prompt Builder!': 'Tell me 3 fun facts about robots\n',
          })[ca.title] || '';
          await pool.query(
            'INSERT INTO activity_code_challenges (activity_id, instructions, starter_code, expected_output, hint, difficulty, sort_order) VALUES ($1, $2, $3, $4, $5, $6, $7)',
            [ca.id, lv.instructions, lv.starter, expected, lv.hint, lv.difficulty, i + 1]
          );
        }
      }
      console.log('✓ Migrated code challenges to 3-level format');
    }
  } catch (e) { console.warn('Code challenge migration:', e.message); }

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
      try { await pool.query(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`); } catch {}
      // User policy: can only see/touch their own rows
      await pool.query(`DROP POLICY IF EXISTS ${t}_isolation ON ${t}`);
      await pool.query(`
        CREATE POLICY ${t}_isolation ON ${t}
          USING (user_id = NULLIF(current_setting('app.user_id', true), '')::int)
          WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::int)
      `);
      // Admin policy: if app.is_admin is set, bypass
      await pool.query(`DROP POLICY IF EXISTS ${t}_admin ON ${t}`);
      await pool.query(`
        CREATE POLICY ${t}_admin ON ${t}
          USING (current_setting('app.is_admin', true) = 'true')
          WITH CHECK (current_setting('app.is_admin', true) = 'true')
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

  // Seed shop items (idempotent — adds new items, updates prices)
  const items = [
    ['custom_bg',     'Custom Background', 'Describe a background and Claude paints it just for you!', '🎨', 40, 'background'],
    ['bonus_game',    'Memory Match Game',    'Unlock a brand new memory match mini-game forever!',       '🧠', 10, 'bonus_game'],
    ['extra_game',    'Extra Game Pass',      'Unlock the power to make ANOTHER game in Game Studio!',    '🎮', 40, 'game_pass'],
    ['crown',         'Royal Crown',          'A shiny crown next to your name in the header.',           '👑',  5, 'cosmetic'],
    ['sparkles',      'Sparkle Trail',        'Sparkles ✨ follow your mouse cursor everywhere.',          '✨', 10, 'cosmetic'],
    ['rainbow',       'Rainbow Logo',         'Your header glows with rainbow colors.',                   '🌈', 15, 'cosmetic'],
  ];
  for (const [code, name, desc, icon, cost, kind] of items) {
    await pool.query(
      `INSERT INTO shop_items (code,name,description,icon,cost,kind) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, icon = EXCLUDED.icon, cost = EXCLUDED.cost, kind = EXCLUDED.kind`,
      [code, name, desc, icon, cost, kind]
    );
  }

  // Seed universes (idempotent)
  const uniCount = (await pool.query('SELECT COUNT(*)::int AS c FROM universes')).rows[0].c;
  if (uniCount === 0) {
    await pool.query("INSERT INTO universes (name, description, icon, sort_order) VALUES ('AI Basics', 'Learn what AI is, how agents work, and how to talk to them!', '🤖', 1)");
    await pool.query("INSERT INTO universes (name, description, icon, sort_order) VALUES ('Coding Powers', 'Write real Python code and combine it with AI!', '🐍', 2)");
  }
  const uni1Id = (await pool.query("SELECT id FROM universes WHERE sort_order = 1")).rows[0].id;
  const uni2Id = (await pool.query("SELECT id FROM universes WHERE sort_order = 2")).rows[0].id;

  // Migrate: assign existing categories to universes if they haven't been yet
  await pool.query(`UPDATE categories SET universe_id = $1 WHERE name IN ('What is AI?', 'AI Agents', 'Prompting') AND universe_id IS NULL`, [uni1Id]);
  await pool.query(`UPDATE categories SET universe_id = $1 WHERE name IN ('Python Coding', 'AI + Coding') AND universe_id IS NULL`, [uni2Id]);

  // Add the Prompting world if it doesn't exist
  const hasPrompting = (await pool.query("SELECT id FROM categories WHERE name = 'Prompting'")).rows[0];
  if (!hasPrompting) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const c = (await client.query(
        "INSERT INTO categories (name, description, icon, universe_id, sort_order) VALUES ('Prompting', 'Learn how to talk to AI so it gives you the best answers!', '💬', $1, 3) RETURNING id",
        [uni1Id]
      )).rows[0].id;

      // Lesson 1: What is a prompt?
      const l1 = (await client.query(
        "INSERT INTO lessons (category_id, title, content, sort_order) VALUES ($1, 'What is a Prompt?', $2, 1) RETURNING id",
        [c, "A prompt is just what you TYPE or SAY to an AI. Better prompts = better answers!\n\nThink of it like ordering a pizza. If you just say 'pizza' — you might get plain cheese. But if you say 'large pepperoni pizza with extra cheese', you get exactly what you want!\n\nAI is the same. The more specific you are, the better the answer you get."]
      )).rows[0].id;

      const l1a1 = (await client.query(
        "INSERT INTO activities (lesson_id, activity_type, title, description, sort_order) VALUES ($1, 'match', 'Match It Up!', 'Match each prompt with what kind it is!', 1) RETURNING id",
        [l1]
      )).rows[0].id;
      const matchPairs = [
        ['"tell me stuff"', '👎 Too vague'],
        ['"3 fun facts about dolphins"', '👍 Specific'],
        ['"make a cat image"', '👎 Missing details'],
        ['"funny orange cat wearing a hat"', '👍 Detailed'],
      ];
      for (let i = 0; i < matchPairs.length; i++) {
        await client.query('INSERT INTO activity_match_pairs (activity_id, term, definition, sort_order) VALUES ($1, $2, $3, $4)', [l1a1, matchPairs[i][0], matchPairs[i][1], i + 1]);
      }

      const q1 = (await client.query("INSERT INTO quizzes (lesson_id, question, sort_order) VALUES ($1, 'What is a prompt?', 1) RETURNING id", [l1])).rows[0].id;
      await client.query("INSERT INTO quiz_choices (quiz_id, choice_text, is_correct, sort_order) VALUES ($1, 'Something you say or type to an AI', true, 1)", [q1]);
      await client.query("INSERT INTO quiz_choices (quiz_id, choice_text, is_correct, sort_order) VALUES ($1, 'A secret code', false, 2)", [q1]);
      await client.query("INSERT INTO quiz_choices (quiz_id, choice_text, is_correct, sort_order) VALUES ($1, 'A type of sandwich', false, 3)", [q1]);

      // Lesson 2: Good vs Bad Prompts
      const l2 = (await client.query(
        "INSERT INTO lessons (category_id, title, content, sort_order) VALUES ($1, 'Good vs Bad Prompts', $2, 2) RETURNING id",
        [c, "Good prompts have these superpowers:\n\n⭐ SPECIFIC — say exactly what you want\n⭐ CLEAR — use simple words\n⭐ HAS DETAILS — colors, numbers, topics\n⭐ TELLS WHO — 'for a 10-year-old', 'in simple words'\n\nBad prompts are vague, confusing, or missing info. The AI will guess, and you might not like the guess!"]
      )).rows[0].id;

      const l2a1 = (await client.query(
        "INSERT INTO activities (lesson_id, activity_type, title, description, sort_order) VALUES ($1, 'truefalse', 'Prompt True or False!', 'Are these prompt facts TRUE or FALSE?', 1) RETURNING id",
        [l2]
      )).rows[0].id;
      const tfItems = [
        ['Specific prompts give better answers', true, 'Yes! The more details, the better.'],
        ['"Do stuff" is a great prompt', false, 'Nope! Too vague. What kind of stuff?'],
        ['Telling AI who the answer is for helps', true, "Yes! 'Explain like I'm 8' works great."],
        ['You should NEVER use details', false, 'Wrong! Details are the secret sauce.'],
        ['Good prompts use clear words', true, 'Yes! Simple and clear is best.'],
      ];
      for (let i = 0; i < tfItems.length; i++) {
        await client.query('INSERT INTO activity_truefalse_items (activity_id, statement, is_true, explanation, sort_order) VALUES ($1, $2, $3, $4, $5)', [l2a1, tfItems[i][0], tfItems[i][1], tfItems[i][2], i + 1]);
      }

      const l2a2 = (await client.query(
        "INSERT INTO activities (lesson_id, activity_type, title, description, sort_order) VALUES ($1, 'sort', 'Build a Great Prompt!', 'Put these parts in the right order to make an awesome prompt!', 2) RETURNING id",
        [l2]
      )).rows[0].id;
      const sortItems = [
        ['Tell me', 1],
        ['5 fun facts', 2],
        ['about space', 3],
        ['for a 10-year-old', 4],
        ['in simple words', 5],
      ];
      for (const [content, pos] of sortItems) {
        await client.query('INSERT INTO activity_sort_items (activity_id, content, correct_position) VALUES ($1, $2, $3)', [l2a2, content, pos]);
      }

      const q2 = (await client.query("INSERT INTO quizzes (lesson_id, question, sort_order) VALUES ($1, 'Which is the BEST prompt?', 1) RETURNING id", [l2])).rows[0].id;
      await client.query("INSERT INTO quiz_choices (quiz_id, choice_text, is_correct, sort_order) VALUES ($1, 'Tell me things', false, 1)", [q2]);
      await client.query("INSERT INTO quiz_choices (quiz_id, choice_text, is_correct, sort_order) VALUES ($1, 'Write 3 facts about dogs for a kid', true, 2)", [q2]);
      await client.query("INSERT INTO quiz_choices (quiz_id, choice_text, is_correct, sort_order) VALUES ($1, 'Dogs', false, 3)", [q2]);

      // Lesson 3: Practice Prompting
      const l3 = (await client.query(
        "INSERT INTO lessons (category_id, title, content, sort_order) VALUES ($1, 'Your Turn: Practice!', $2, 3) RETURNING id",
        [c, "Time to try it yourself! You'll be given a task and you write the prompt. Claude will read it and give you kind feedback.\n\nRemember:\n⭐ Be specific\n⭐ Add details\n⭐ Say who it's for\n\nThis is important — in the next world you'll be building your own game with prompts!"]
      )).rows[0].id;

      const l3a1 = (await client.query(
        "INSERT INTO activities (lesson_id, activity_type, title, description, sort_order) VALUES ($1, 'promptpractice', 'Prompt Practice!', 'Write the best prompt you can! Claude will give you feedback.', 1) RETURNING id",
        [l3]
      )).rows[0].id;
      const practiceTasks = [
        ['Write a prompt to get 3 cool facts about octopuses for a kid.', 'Try including "3 facts", "octopuses", and who it\'s for!'],
        ['Write a prompt to get help inventing a funny name for a pet dragon.', 'Try saying the pet type, and maybe what kind of name (funny, royal, silly)!'],
        ['Write a prompt to help you describe a magical island for a story.', 'Include what kind of details you want (colors, creatures, weather)!'],
      ];
      for (let i = 0; i < practiceTasks.length; i++) {
        await client.query('INSERT INTO activity_prompt_tasks (activity_id, task_description, hint, sort_order) VALUES ($1, $2, $3, $4)', [l3a1, practiceTasks[i][0], practiceTasks[i][1], i + 1]);
      }

      const q3 = (await client.query("INSERT INTO quizzes (lesson_id, question, sort_order) VALUES ($1, 'What makes a prompt great?', 1) RETURNING id", [l3])).rows[0].id;
      await client.query("INSERT INTO quiz_choices (quiz_id, choice_text, is_correct, sort_order) VALUES ($1, 'Being specific and detailed', true, 1)", [q3]);
      await client.query("INSERT INTO quiz_choices (quiz_id, choice_text, is_correct, sort_order) VALUES ($1, 'Being vague and short', false, 2)", [q3]);
      await client.query("INSERT INTO quiz_choices (quiz_id, choice_text, is_correct, sort_order) VALUES ($1, 'Yelling at the AI', false, 3)", [q3]);

      await client.query('COMMIT');
      console.log('✓ Seeded Prompting world');
    } catch (e) {
      await client.query('ROLLBACK');
      console.warn('Prompting seed failed:', e.message);
    } finally {
      client.release();
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
