// src/index.js
import http from "node:http";
import fs3 from "node:fs";
import path3 from "node:path";

// src/config.js
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
var here = path.dirname(fileURLToPath(import.meta.url));
var root = fs.existsSync(path.join(here, "package.json")) ? here : path.resolve(here, "..");
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    if (process.env[m[1]] === void 0) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
loadDotEnv(process.env.ENV_FILE || path.join(root, ".env"));
var env = (k, d) => process.env[k] !== void 0 && process.env[k] !== "" ? process.env[k] : d;
var bool = (k, d) => ["1", "true", "yes"].includes(String(env(k, d)).toLowerCase());
var config = {
  env: env("NODE_ENV", "development"),
  port: Number(env("PORT", 8787)),
  host: env("HOST", "0.0.0.0"),
  dbPath: env("DB_PATH", path.join(root, "data", "onecolor.db")),
  publicUrl: env("PUBLIC_URL", "http://localhost:8787"),
  corsOrigins: env("CORS_ORIGINS", "*").split(",").map((s) => s.trim()).filter(Boolean),
  tokenTtlDays: Number(env("TOKEN_TTL_DAYS", 30)),
  requireEmailVerification: bool("REQUIRE_EMAIL_VERIFICATION", "false"),
  smtp: {
    host: env("SMTP_HOST", ""),
    port: Number(env("SMTP_PORT", 587)),
    secure: bool("SMTP_SECURE", "false"),
    user: env("SMTP_USER", ""),
    pass: env("SMTP_PASS", ""),
    from: env("MAIL_FROM", "ONE COLOR <no-reply@example.com>")
  },
  seasonLengthDays: Number(env("SEASON_LENGTH_DAYS", 56)),
  dailyTimezoneOffsetMin: Number(env("DAILY_TZ_OFFSET_MIN", 540)),
  // KST
  matchReadyTimeoutMs: Number(env("MATCH_READY_TIMEOUT_MS", 2e4)),
  countdownMs: Number(env("COUNTDOWN_MS", 3e3)),
  reconnectGraceMs: Number(env("RECONNECT_GRACE_MS", 15e3)),
  inviteTtlMs: Number(env("INVITE_TTL_MS", 3e4)),
  // Auth requests per IP per minute (per-e-mail limits are fixed at 10/min).
  authIpLimit: Number(env("AUTH_IP_LIMIT", 30)),
  apiIpLimit: Number(env("API_IP_LIMIT", 600)),
  // Behind a reverse proxy (Render, Caddy, Nginx) the socket address is the
  // proxy's; take the client address the proxy appended to X-Forwarded-For.
  trustProxy: bool("TRUST_PROXY", process.env.RENDER ? "true" : "false"),
  wsPerIp: Number(env("WS_PER_IP", 20)),
  wsPerUser: Number(env("WS_PER_USER", 5)),
  // Development-only: lets tests read mail tokens from the outbox endpoint.
  devOutbox: bool("DEV_OUTBOX", env("NODE_ENV", "development") !== "production" ? "true" : "false")
};
var isProduction = config.env === "production";

// src/db.js
import { DatabaseSync } from "node:sqlite";
import fs2 from "node:fs";
import path2 from "node:path";
var SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE,
  password_hash TEXT,
  display_name TEXT NOT NULL,
  friend_code TEXT UNIQUE NOT NULL,
  email_verified INTEGER NOT NULL DEFAULT 0,
  icon TEXT NOT NULL DEFAULT 'icon_square',
  equipped TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  last_seen INTEGER,
  name_changed_at INTEGER,
  deleted_at INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  device TEXT,
  created_at INTEGER NOT NULL,
  last_used INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS email_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  purpose TEXT NOT NULL CHECK (purpose IN ('verify','reset')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE TABLE IF NOT EXISTS seasons (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  closed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS ratings (
  user_id INTEGER NOT NULL REFERENCES users(id),
  season_id INTEGER NOT NULL REFERENCES seasons(id),
  rating INTEGER NOT NULL DEFAULT 1000,
  peak INTEGER NOT NULL DEFAULT 1000,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  draws INTEGER NOT NULL DEFAULT 0,
  streak INTEGER NOT NULL DEFAULT 0,
  best_streak INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, season_id)
);
CREATE TABLE IF NOT EXISTS matches (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('ranked','friend')),
  season_id INTEGER,
  seed INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','active','finished','cancelled','aborted')),
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER,
  end_reason TEXT,
  result_applied INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS match_players (
  match_id TEXT NOT NULL REFERENCES matches(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  slot INTEGER NOT NULL,
  score INTEGER, max_combo INTEGER, correct INTEGER, wrong INTEGER,
  lives_left INTEGER, play_ms INTEGER,
  outcome TEXT CHECK (outcome IN ('win','loss','draw')),
  rating_before INTEGER, rating_after INTEGER,
  PRIMARY KEY (match_id, user_id)
);
CREATE INDEX IF NOT EXISTS match_players_user ON match_players(user_id);
CREATE TABLE IF NOT EXISTS run_tickets (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  mode TEXT NOT NULL,
  seed INTEGER NOT NULL,
  daily_date TEXT,
  issued_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  mode TEXT NOT NULL,
  seed INTEGER NOT NULL,
  score INTEGER NOT NULL,
  max_combo INTEGER NOT NULL,
  correct INTEGER NOT NULL,
  wrong INTEGER NOT NULL,
  rounds INTEGER NOT NULL,
  play_ms INTEGER NOT NULL,
  accuracy REAL NOT NULL,
  daily_date TEXT,
  daily_official INTEGER NOT NULL DEFAULT 0,
  season_id INTEGER,
  week TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_mode_score ON runs(mode, score DESC);
CREATE INDEX IF NOT EXISTS runs_user ON runs(user_id, mode);
CREATE TABLE IF NOT EXISTS local_records (
  user_id INTEGER NOT NULL REFERENCES users(id),
  mode TEXT NOT NULL,
  best_score INTEGER NOT NULL DEFAULT 0,
  best_combo INTEGER NOT NULL DEFAULT 0,
  plays INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, mode)
);
CREATE TABLE IF NOT EXISTS friendships (
  user_a INTEGER NOT NULL REFERENCES users(id),
  user_b INTEGER NOT NULL REFERENCES users(id),
  requester INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','accepted')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_a, user_b),
  CHECK (user_a < user_b)
);
CREATE TABLE IF NOT EXISTS achievements (
  user_id INTEGER NOT NULL REFERENCES users(id),
  achievement_id TEXT NOT NULL,
  unlocked_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, achievement_id)
);
CREATE TABLE IF NOT EXISTS inventory (
  user_id INTEGER NOT NULL REFERENCES users(id),
  item_id TEXT NOT NULL,
  source TEXT NOT NULL,
  acquired_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, item_id)
);
CREATE TABLE IF NOT EXISTS daily_streaks (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  last_date TEXT NOT NULL,
  streak INTEGER NOT NULL,
  best_streak INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS progress (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  played_modes TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL
);
`;
function openDb(file) {
  if (file !== ":memory:") fs2.mkdirSync(path2.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  const cols = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
  if (!cols.includes("username")) db.exec("ALTER TABLE users ADD COLUMN username TEXT");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS users_username ON users(username)");
  return db;
}
function tx(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// src/security.js
import crypto from "node:crypto";
var SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}
function verifyPassword(password, stored) {
  if (typeof stored !== "string") return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, "base64");
  const actual = crypto.scryptSync(
    password,
    Buffer.from(saltB64, "base64"),
    expected.length,
    { N: Number(N), r: Number(r), p: Number(p) }
  );
  return crypto.timingSafeEqual(actual, expected);
}
var DUMMY_HASH = hashPassword(crypto.randomBytes(12).toString("hex"));
var burnPasswordCheck = (password) => verifyPassword(password, DUMMY_HASH);
var newToken = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");
var sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
var newId = () => crypto.randomBytes(9).toString("base64url");
var CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function friendCode() {
  const bytes = crypto.randomBytes(8);
  let s = "";
  for (const b of bytes) s += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return s;
}
var randomSeed = () => crypto.randomBytes(4).readUInt32BE(0) || 1;
function clientIp(req, trustProxy) {
  if (trustProxy) {
    const xff = String(req.headers["x-forwarded-for"] || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (xff.length) return xff[xff.length - 1].slice(0, 64);
  }
  return req.socket?.remoteAddress || "?";
}
var SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()"
};
var RateLimiter = class {
  constructor(limit, windowMs) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.hits = /* @__PURE__ */ new Map();
  }
  allow(key, now2 = Date.now()) {
    const entry = this.hits.get(key);
    if (!entry || now2 - entry.start >= this.windowMs) {
      this.hits.set(key, { start: now2, count: 1 });
      if (this.hits.size > 5e4) this.sweep(now2);
      return true;
    }
    entry.count += 1;
    return entry.count <= this.limit;
  }
  sweep(now2 = Date.now()) {
    for (const [k, v] of this.hits) if (now2 - v.start >= this.windowMs) this.hits.delete(k);
  }
};
var EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
var validEmail = (e) => typeof e === "string" && e.length <= 254 && EMAIL_RE.test(e);
function passwordProblem(p) {
  if (typeof p !== "string") return "password_required";
  if (p.length < 8) return "password_too_short";
  if (p.length > 128) return "password_too_long";
  if (!/[A-Za-z]/.test(p) || !/[0-9]/.test(p)) return "password_needs_letter_and_digit";
  return null;
}
var normalizeUsername = (u) => typeof u === "string" ? u.trim().toLowerCase() : "";
function usernameProblem(u) {
  if (typeof u !== "string" || !u.trim()) return "username_required";
  const t = normalizeUsername(u);
  if (t.length < 3 || t.length > 16) return "username_length";
  if (!/^[a-z0-9_]+$/.test(t)) return "username_characters";
  return null;
}
function displayNameProblem(n) {
  if (typeof n !== "string") return "name_required";
  const t = n.trim();
  if ([...t].length < 2 || [...t].length > 16) return "name_length";
  if (/[\u0000-\u001f\u007f<>]/.test(t)) return "name_characters";
  return null;
}

// src/catalog.js
var SLOTS = ["shape", "glow", "trail", "icon", "victory", "theme", "badge"];
var ITEMS = {
  shape_square: { slot: "shape", name: "\uB124\uBAA8", unlock: "default" },
  shape_circle: { slot: "shape", name: "\uB3D9\uADF8\uB77C\uBBF8", unlock: "first_online_win" },
  shape_diamond: { slot: "shape", name: "\uB2E4\uC774\uC544", unlock: "all_modes" },
  shape_hex: { slot: "shape", name: "\uC721\uAC01", unlock: "wins_50" },
  glow_soft: { slot: "glow", name: "\uC740\uC740\uD55C \uBE5B", unlock: "default" },
  glow_pink: { slot: "glow", name: "\uB124\uC628 \uD551\uD06C", unlock: "first_play" },
  glow_cyan: { slot: "glow", name: "\uB124\uC628 \uC2DC\uC548", unlock: "wins_10" },
  glow_gold: { slot: "glow", name: "\uACE8\uB4DC", unlock: "wins_50" },
  trail_none: { slot: "trail", name: "\uC5C6\uC74C", unlock: "default" },
  trail_dots: { slot: "trail", name: "\uC810 \uC794\uC0C1", unlock: "combo_25" },
  trail_streak: { slot: "trail", name: "\uBE5B\uC904\uAE30", unlock: "win_streak_3" },
  icon_square: { slot: "icon", name: "\uAE30\uBCF8", unlock: "default" },
  icon_star: { slot: "icon", name: "\uBCC4", unlock: "first_play" },
  icon_bolt: { slot: "icon", name: "\uBC88\uAC1C", unlock: "friend_match_first" },
  icon_crown: { slot: "icon", name: "\uC655\uAD00", unlock: "season_top100" },
  win_burst: { slot: "victory", name: "\uD30C\uD3B8", unlock: "default" },
  win_rings: { slot: "victory", name: "\uB9C1", unlock: "first_win" },
  win_fireworks: { slot: "victory", name: "\uBD88\uAF43", unlock: "wins_10" },
  theme_neon: { slot: "theme", name: "\uB124\uC628", unlock: "default" },
  theme_light: { slot: "theme", name: "\uBC1D\uAC8C", unlock: "default" },
  theme_dark: { slot: "theme", name: "\uC5B4\uB461\uAC8C", unlock: "default" },
  theme_midnight: { slot: "theme", name: "\uBBF8\uB4DC\uB098\uC787", unlock: "daily_streak_7" },
  badge_none: { slot: "badge", name: "\uC5C6\uC74C", unlock: "default" },
  badge_first_match: { slot: "badge", name: "\uCCAB \uB300\uC804", unlock: "first_online_match" },
  badge_10wins: { slot: "badge", name: "10\uC2B9", unlock: "wins_10" },
  badge_daily7: { slot: "badge", name: "7\uC77C \uC5F0\uC18D", unlock: "daily_streak_7" },
  badge_season: { slot: "badge", name: "\uC2DC\uC98C TOP 100", unlock: "season_top100" }
};
var DEFAULT_EQUIPPED = {
  shape: "shape_square",
  glow: "glow_soft",
  trail: "trail_none",
  icon: "icon_square",
  victory: "win_burst",
  theme: "theme_neon",
  badge: "badge_none"
};
var ACHIEVEMENTS = {
  first_play: { name: "\uCCAB \uD50C\uB808\uC774", desc: "\uAC8C\uC784\uC744 \uCC98\uC74C \uD50C\uB808\uC774", verified: "client" },
  first_win: { name: "\uCCAB \uC2B9\uB9AC", desc: "\uC628\uB77C\uC778 \uB300\uC804(\uCE5C\uAD6C \uB300\uC804 \uD3EC\uD568) \uCCAB \uC2B9\uB9AC", verified: "server" },
  first_online_match: { name: "\uCCAB \uC628\uB77C\uC778 \uACBD\uAE30", desc: "\uC628\uB77C\uC778 \uB300\uC804\uC744 \uCC98\uC74C \uC644\uB8CC", verified: "server" },
  first_online_win: { name: "\uCCAB \uC628\uB77C\uC778 \uC2B9\uB9AC", desc: "\uB7AD\uD06C \uB300\uC804 \uCCAB \uC2B9\uB9AC", verified: "server" },
  wins_10: { name: "10\uC2B9", desc: "\uB7AD\uD06C \uB300\uC804 10\uC2B9", verified: "server" },
  wins_50: { name: "50\uC2B9", desc: "\uB7AD\uD06C \uB300\uC804 50\uC2B9", verified: "server" },
  win_streak_3: { name: "3\uC5F0\uC2B9", desc: "\uB7AD\uD06C \uB300\uC804 3\uC5F0\uC2B9", verified: "server" },
  combo_25: { name: "\uCF64\uBCF4 25", desc: "\uC11C\uBC84 \uAC80\uC99D \uAE30\uB85D\uC5D0\uC11C \uCD5C\uB300 \uCF64\uBCF4 25", verified: "server" },
  all_modes: { name: "\uBAA8\uB4E0 \uBAA8\uB4DC", desc: "\uC2F1\uAE00 \uBAA8\uB4DC\uB97C \uBAA8\uB450 \uD55C \uBC88\uC529 \uD50C\uB808\uC774", verified: "client" },
  daily_streak_3: { name: "3\uC77C \uC5F0\uC18D \uCC4C\uB9B0\uC9C0", desc: "\uC77C\uC77C \uCC4C\uB9B0\uC9C0 3\uC77C \uC5F0\uC18D \uCC38\uC5EC", verified: "server" },
  daily_streak_7: { name: "7\uC77C \uC5F0\uC18D \uCC4C\uB9B0\uC9C0", desc: "\uC77C\uC77C \uCC4C\uB9B0\uC9C0 7\uC77C \uC5F0\uC18D \uCC38\uC5EC", verified: "server" },
  friend_match_first: { name: "\uCE5C\uAD6C\uC640 \uCCAB \uB300\uC804", desc: "\uCE5C\uAD6C \uB300\uC804\uC744 \uCC98\uC74C \uC644\uB8CC", verified: "server" },
  season_top100: { name: "\uC2DC\uC98C TOP 100", desc: "\uC2DC\uC98C \uC885\uB8CC \uC2DC \uB808\uC774\uD305 100\uC704 \uC548", verified: "server" }
};
var SINGLE_MODES = [
  "classic",
  "time_attack",
  "one_life",
  "blitz",
  "sprint",
  "hardcore",
  "survival",
  "chaos",
  "endless",
  "memory",
  "rhythm",
  "duel_color",
  "dual_control",
  "stroop",
  "odd_one",
  "count",
  "reaction",
  "chain",
  "blind",
  "shape_only",
  "practice",
  "daily"
];
var rewardsFor = (achievementId) => Object.entries(ITEMS).filter(([, it]) => it.unlock === achievementId).map(([id]) => id);

// src/store.js
var DAY = 864e5;
var now = () => Date.now();
var Store = class {
  constructor(db, clock = now) {
    this.db = db;
    this.clock = clock;
  }
  q(sql) {
    return this.db.prepare(sql);
  }
  // --- users & sessions -----------------------------------------------------
  createUser({ username = null, email = null, password, displayName }) {
    const t = this.clock();
    return tx(this.db, () => {
      if (username && this.q("SELECT 1 FROM users WHERE username = ?").get(username)) {
        throw Object.assign(new Error("username_taken"), { status: 409 });
      }
      if (email && this.q("SELECT 1 FROM users WHERE email = ?").get(email)) {
        const err = new Error("email_taken");
        err.status = 409;
        throw err;
      }
      let code;
      do {
        code = friendCode();
      } while (this.q("SELECT 1 FROM users WHERE friend_code = ?").get(code));
      const info = this.q(`INSERT INTO users (username, email, password_hash, display_name, friend_code, equipped, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        username,
        email || null,
        hashPassword(password),
        displayName.trim(),
        code,
        JSON.stringify(DEFAULT_EQUIPPED),
        t
      );
      const id = Number(info.lastInsertRowid);
      for (const [itemId, item] of Object.entries(ITEMS)) {
        if (item.unlock === "default") this.grantItem(id, itemId, "default");
      }
      return id;
    });
  }
  userByUsername(username) {
    return this.q("SELECT * FROM users WHERE username = ? AND deleted_at IS NULL").get(username);
  }
  userByEmail(email) {
    return this.q("SELECT * FROM users WHERE email = ? AND deleted_at IS NULL").get(email);
  }
  userById(id) {
    return this.q("SELECT * FROM users WHERE id = ? AND deleted_at IS NULL").get(id);
  }
  userByFriendCode(code) {
    return this.q("SELECT * FROM users WHERE friend_code = ? AND deleted_at IS NULL").get(code);
  }
  // [login] is a login ID or, for older accounts, an e-mail address.
  checkLogin(login, password) {
    const key = String(login || "").trim().toLowerCase();
    const user = key.includes("@") ? this.userByEmail(key) : this.userByUsername(key);
    if (!user) {
      burnPasswordCheck(password);
      return null;
    }
    return verifyPassword(password, user.password_hash) ? user : null;
  }
  checkPassword(userId, password) {
    const user = this.userById(userId);
    return Boolean(user && user.password_hash && verifyPassword(password, user.password_hash));
  }
  createSession(userId, device = "") {
    const token = newToken();
    const t = this.clock();
    this.q(`INSERT INTO sessions (token_hash, user_id, device, created_at, last_used, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(
      sha256(token),
      userId,
      String(device).slice(0, 60),
      t,
      t,
      t + config.tokenTtlDays * DAY
    );
    return token;
  }
  // Sliding expiry: every use extends the session.
  userForToken(token) {
    if (typeof token !== "string" || token.length < 20 || token.length > 100) return null;
    const row = this.q("SELECT * FROM sessions WHERE token_hash = ?").get(sha256(token));
    const t = this.clock();
    if (!row || row.expires_at < t) {
      if (row) this.q("DELETE FROM sessions WHERE token_hash = ?").run(row.token_hash);
      return null;
    }
    const user = this.userById(row.user_id);
    if (!user) return null;
    if (t - row.last_used > 6e4) {
      this.q("UPDATE sessions SET last_used = ?, expires_at = ? WHERE token_hash = ?").run(t, t + config.tokenTtlDays * DAY, row.token_hash);
    }
    return user;
  }
  deleteSession(token) {
    this.q("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
  }
  deleteSessionsOf(userId) {
    this.q("DELETE FROM sessions WHERE user_id = ?").run(userId);
  }
  createEmailToken(userId, purpose, ttlMs) {
    const token = newToken(24);
    const t = this.clock();
    this.q(`UPDATE email_tokens SET used_at = ? WHERE user_id = ? AND purpose = ? AND used_at IS NULL`).run(t, userId, purpose);
    this.q(`INSERT INTO email_tokens (token_hash, user_id, purpose, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`).run(sha256(token), userId, purpose, t, t + ttlMs);
    return token;
  }
  // Returns the user id and marks the token used (single use), or null.
  consumeEmailToken(token, purpose) {
    if (typeof token !== "string" || token.length < 20 || token.length > 100) return null;
    return tx(this.db, () => {
      const row = this.q("SELECT * FROM email_tokens WHERE token_hash = ? AND purpose = ?").get(sha256(token), purpose);
      if (!row || row.used_at || row.expires_at < this.clock()) return null;
      this.q("UPDATE email_tokens SET used_at = ? WHERE token_hash = ?").run(this.clock(), row.token_hash);
      return row.user_id;
    });
  }
  setPassword(userId, password) {
    this.q("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(password), userId);
  }
  setEmailVerified(userId) {
    this.q("UPDATE users SET email_verified = 1 WHERE id = ?").run(userId);
  }
  setDisplayName(userId, name) {
    this.q("UPDATE users SET display_name = ?, name_changed_at = ? WHERE id = ?").run(name.trim(), this.clock(), userId);
  }
  touch(userId) {
    this.q("UPDATE users SET last_seen = ? WHERE id = ?").run(this.clock(), userId);
  }
  // Account deletion: personal data removed, competitive history kept anonymous.
  deleteUser(userId) {
    tx(this.db, () => {
      this.q("DELETE FROM sessions WHERE user_id = ?").run(userId);
      this.q("DELETE FROM email_tokens WHERE user_id = ?").run(userId);
      this.q("DELETE FROM friendships WHERE user_a = ? OR user_b = ?").run(userId, userId);
      this.q(`UPDATE users SET email = NULL, username = NULL, password_hash = NULL, display_name = '\uD0C8\uD1F4\uD55C \uC0AC\uC6A9\uC790',
        deleted_at = ? WHERE id = ?`).run(this.clock(), userId);
    });
  }
  // --- seasons & ratings ----------------------------------------------------
  currentSeason() {
    const t = this.clock();
    let s = this.q("SELECT * FROM seasons WHERE closed = 0 ORDER BY id DESC LIMIT 1").get();
    if (!s) {
      const id = (this.q("SELECT MAX(id) AS m FROM seasons").get().m || 0) + 1;
      this.q("INSERT INTO seasons (id, name, starts_at, ends_at) VALUES (?, ?, ?, ?)").run(id, `\uC2DC\uC98C ${id}`, t, t + config.seasonLengthDays * DAY);
      s = this.q("SELECT * FROM seasons WHERE id = ?").get(id);
    }
    return s;
  }
  // Closes the current season: top 100 get the season reward, a new season starts.
  rolloverSeason() {
    return tx(this.db, () => {
      const season = this.currentSeason();
      const top = this.q(`SELECT user_id FROM ratings WHERE season_id = ? AND (wins + losses + draws) > 0
        ORDER BY rating DESC, user_id LIMIT 100`).all(season.id);
      for (const row of top) this.unlockAchievement(row.user_id, "season_top100");
      this.q("UPDATE seasons SET closed = 1, ends_at = ? WHERE id = ?").run(this.clock(), season.id);
      const next = this.currentSeason();
      return { closed: season.id, rewarded: top.length, started: next.id };
    });
  }
  ratingRow(userId, seasonId = this.currentSeason().id) {
    let row = this.q("SELECT * FROM ratings WHERE user_id = ? AND season_id = ?").get(userId, seasonId);
    if (!row) {
      this.q("INSERT OR IGNORE INTO ratings (user_id, season_id) VALUES (?, ?)").run(userId, seasonId);
      row = this.q("SELECT * FROM ratings WHERE user_id = ? AND season_id = ?").get(userId, seasonId);
    }
    return row;
  }
  // --- matches --------------------------------------------------------------
  createMatch({ mode, kind, seed, playerIds }) {
    const id = newId();
    const season = this.currentSeason();
    tx(this.db, () => {
      this.q(`INSERT INTO matches (id, mode, kind, season_id, seed, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)`).run(id, mode, kind, season.id, seed ?? randomSeed(), this.clock());
      playerIds.forEach((uid, slot) => this.q("INSERT INTO match_players (match_id, user_id, slot) VALUES (?, ?, ?)").run(id, uid, slot));
    });
    return this.q("SELECT * FROM matches WHERE id = ?").get(id);
  }
  setMatchStatus(id, status, extra = {}) {
    this.q(`UPDATE matches SET status = ?, started_at = COALESCE(?, started_at), ended_at = COALESCE(?, ended_at),
      end_reason = COALESCE(?, end_reason) WHERE id = ?`).run(status, extra.startedAt ?? null, extra.endedAt ?? null, extra.reason ?? null, id);
  }
  // Applies the final result exactly once (guarded by result_applied in the
  // same transaction). Returns per-player rating changes, or null if already applied.
  applyMatchResult(matchId, results, reason) {
    return tx(this.db, () => {
      const match2 = this.q("SELECT * FROM matches WHERE id = ?").get(matchId);
      if (!match2 || match2.result_applied) return null;
      const ranked = match2.kind === "ranked";
      const out = {};
      const rows = results.map((r) => ({ ...r, rating: this.ratingRow(r.userId, match2.season_id) }));
      const changes = ranked && rows.length === 2 ? eloChanges(rows[0], rows[1]) : [0, 0];
      rows.forEach((r, i) => {
        const before = r.rating.rating;
        const after = before + changes[i];
        if (ranked) {
          const win = r.outcome === "win", loss = r.outcome === "loss";
          const streak = win ? r.rating.streak + 1 : 0;
          this.q(`UPDATE ratings SET rating = ?, peak = MAX(peak, ?), wins = wins + ?, losses = losses + ?, draws = draws + ?,
            streak = ?, best_streak = MAX(best_streak, ?) WHERE user_id = ? AND season_id = ?`).run(after, after, win ? 1 : 0, loss ? 1 : 0, r.outcome === "draw" ? 1 : 0, streak, streak, r.userId, match2.season_id);
        }
        this.q(`UPDATE match_players SET score = ?, max_combo = ?, correct = ?, wrong = ?, lives_left = ?, play_ms = ?,
          outcome = ?, rating_before = ?, rating_after = ? WHERE match_id = ? AND user_id = ?`).run(
          r.score,
          r.max_combo,
          r.correct,
          r.wrong,
          r.lives_left,
          r.play_ms,
          r.outcome,
          ranked ? before : null,
          ranked ? after : null,
          matchId,
          r.userId
        );
        out[r.userId] = { before, after: ranked ? after : before, change: ranked ? changes[i] : 0 };
      });
      this.q(`UPDATE matches SET status = 'finished', ended_at = ?, end_reason = ?, result_applied = 1 WHERE id = ?`).run(this.clock(), reason, matchId);
      for (const r of rows) out[r.userId].achievements = this.matchAchievements(r.userId, match2, r.outcome);
      return out;
    });
  }
  matchAchievements(userId, match2, outcome) {
    const unlocked = [];
    const grant = (id) => {
      if (this.unlockAchievement(userId, id)) unlocked.push(id);
    };
    grant("first_online_match");
    if (outcome === "win") grant("first_win");
    if (match2.kind === "friend") grant("friend_match_first");
    if (match2.kind === "ranked") {
      const r = this.ratingRow(userId, match2.season_id);
      const totalWins = this.q("SELECT SUM(wins) AS w FROM ratings WHERE user_id = ?").get(userId).w || 0;
      if (outcome === "win") grant("first_online_win");
      if (totalWins >= 10) grant("wins_10");
      if (totalWins >= 50) grant("wins_50");
      if (r.streak >= 3) grant("win_streak_3");
    }
    return unlocked;
  }
  recentMatches(userId, limit = 10) {
    return this.q(`SELECT m.id, m.mode, m.kind, m.ended_at, me.score, me.outcome, me.rating_before, me.rating_after,
        op.score AS opp_score, u.display_name AS opp_name, u.id AS opp_id
      FROM match_players me JOIN matches m ON m.id = me.match_id
      LEFT JOIN match_players op ON op.match_id = me.match_id AND op.user_id != me.user_id
      LEFT JOIN users u ON u.id = op.user_id
      WHERE me.user_id = ? AND m.status = 'finished' ORDER BY m.ended_at DESC LIMIT ?`).all(userId, limit);
  }
  // --- single-player runs ---------------------------------------------------
  issueRunTicket(userId, mode, seed, dailyDate = null) {
    const id = newId();
    this.q(`INSERT INTO run_tickets (id, user_id, mode, seed, daily_date, issued_at) VALUES (?, ?, ?, ?, ?, ?)`).run(id, userId, mode, seed, dailyDate, this.clock());
    return id;
  }
  takeRunTicket(id, userId) {
    return tx(this.db, () => {
      const row = this.q("SELECT * FROM run_tickets WHERE id = ? AND user_id = ?").get(id, userId);
      if (!row || row.used_at) return null;
      this.q("UPDATE run_tickets SET used_at = ? WHERE id = ?").run(this.clock(), id);
      return row;
    });
  }
  saveRun(userId, ticket, summary) {
    return tx(this.db, () => {
      let official = 0;
      if (ticket.daily_date) {
        const prior = this.q("SELECT 1 FROM runs WHERE user_id = ? AND daily_date = ? AND daily_official = 1").get(userId, ticket.daily_date);
        official = prior ? 0 : 1;
      }
      const t = this.clock();
      const info = this.q(`INSERT INTO runs (user_id, mode, seed, score, max_combo, correct, wrong, rounds, play_ms, accuracy,
        daily_date, daily_official, season_id, week, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        userId,
        ticket.mode,
        ticket.seed,
        summary.score,
        summary.max_combo,
        summary.correct,
        summary.wrong,
        summary.rounds,
        summary.play_ms,
        summary.accuracy,
        ticket.daily_date,
        official,
        this.currentSeason().id,
        isoWeek(t),
        t
      );
      const unlocked = [];
      if (summary.max_combo >= 25 && this.unlockAchievement(userId, "combo_25")) unlocked.push("combo_25");
      let streak = null;
      if (official) streak = this.bumpDailyStreak(userId, ticket.daily_date, unlocked);
      return { runId: Number(info.lastInsertRowid), official: Boolean(official), streak, achievements: unlocked };
    });
  }
  bestRuns(userId) {
    return this.q(`SELECT mode, MAX(score) AS best_score, MAX(max_combo) AS best_combo, COUNT(*) AS plays
      FROM runs WHERE user_id = ? GROUP BY mode`).all(userId);
  }
  // Guest data linked to an account: kept as unverified "local" records only.
  mergeLocalRecords(userId, records) {
    const t = this.clock();
    tx(this.db, () => {
      for (const [mode, r] of Object.entries(records)) {
        if (!SINGLE_MODES.includes(mode) || typeof r !== "object" || r === null) continue;
        const clamp = (v, max) => Math.max(0, Math.min(max, Math.trunc(Number(v) || 0)));
        this.q(`INSERT INTO local_records (user_id, mode, best_score, best_combo, plays, updated_at) VALUES (?,?,?,?,?,?)
          ON CONFLICT(user_id, mode) DO UPDATE SET best_score = MAX(best_score, excluded.best_score),
          best_combo = MAX(best_combo, excluded.best_combo), plays = MAX(plays, excluded.plays), updated_at = excluded.updated_at`).run(userId, mode, clamp(r.best_score, 1e5), clamp(r.best_combo, 1e5), clamp(r.plays, 1e6), t);
      }
    });
  }
  localRecords(userId) {
    return this.q("SELECT mode, best_score, best_combo, plays FROM local_records WHERE user_id = ?").all(userId);
  }
  // Client-reported single-player progress (cosmetic achievements only).
  reportProgress(userId, playedModes) {
    const modes = [...new Set((Array.isArray(playedModes) ? playedModes : []).filter((m) => SINGLE_MODES.includes(m)))];
    const row = this.q("SELECT played_modes FROM progress WHERE user_id = ?").get(userId);
    const merged = [.../* @__PURE__ */ new Set([...row ? JSON.parse(row.played_modes) : [], ...modes])];
    this.q(`INSERT INTO progress (user_id, played_modes, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET played_modes = excluded.played_modes, updated_at = excluded.updated_at`).run(userId, JSON.stringify(merged), this.clock());
    const unlocked = [];
    if (merged.length > 0 && this.unlockAchievement(userId, "first_play")) unlocked.push("first_play");
    if (SINGLE_MODES.every((m) => merged.includes(m)) && this.unlockAchievement(userId, "all_modes")) unlocked.push("all_modes");
    return { played_modes: merged, achievements: unlocked };
  }
  // --- daily ----------------------------------------------------------------
  bumpDailyStreak(userId, date, unlocked) {
    const row = this.q("SELECT * FROM daily_streaks WHERE user_id = ?").get(userId);
    let streak = 1;
    if (row) {
      if (row.last_date === date) return row.streak;
      streak = row.last_date === previousDate(date) ? row.streak + 1 : 1;
    }
    this.q(`INSERT INTO daily_streaks (user_id, last_date, streak, best_streak) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET last_date = excluded.last_date, streak = excluded.streak,
      best_streak = MAX(best_streak, excluded.streak)`).run(userId, date, streak, streak);
    if (streak >= 3 && this.unlockAchievement(userId, "daily_streak_3")) unlocked.push("daily_streak_3");
    if (streak >= 7 && this.unlockAchievement(userId, "daily_streak_7")) unlocked.push("daily_streak_7");
    return streak;
  }
  dailyStatus(userId, date) {
    const official = this.q(`SELECT score, max_combo, accuracy FROM runs WHERE user_id = ? AND daily_date = ? AND daily_official = 1`).get(userId, date);
    const s = this.q("SELECT * FROM daily_streaks WHERE user_id = ?").get(userId);
    const alive = s && (s.last_date === date || s.last_date === previousDate(date));
    return { official: official || null, streak: alive ? s.streak : 0, best_streak: s ? s.best_streak : 0 };
  }
  // --- achievements & inventory -------------------------------------------
  unlockAchievement(userId, id) {
    if (!ACHIEVEMENTS[id]) return false;
    const info = this.q("INSERT OR IGNORE INTO achievements (user_id, achievement_id, unlocked_at) VALUES (?, ?, ?)").run(userId, id, this.clock());
    if (info.changes === 0) return false;
    for (const item of rewardsFor(id)) this.grantItem(userId, item, `achievement:${id}`);
    return true;
  }
  grantItem(userId, itemId, source) {
    this.q("INSERT OR IGNORE INTO inventory (user_id, item_id, source, acquired_at) VALUES (?, ?, ?, ?)").run(userId, itemId, source, this.clock());
  }
  achievements(userId) {
    return this.q("SELECT achievement_id AS id, unlocked_at FROM achievements WHERE user_id = ?").all(userId);
  }
  inventory(userId) {
    return this.q("SELECT item_id AS id, source, acquired_at FROM inventory WHERE user_id = ?").all(userId).map((r) => r.id);
  }
  equip(userId, changes) {
    const user = this.userById(userId);
    const equipped = { ...DEFAULT_EQUIPPED, ...JSON.parse(user.equipped || "{}") };
    const owned = new Set(this.inventory(userId));
    for (const [slot, itemId] of Object.entries(changes)) {
      if (!SLOTS.includes(slot)) throw Object.assign(new Error("bad_slot"), { status: 400 });
      const item = ITEMS[itemId];
      if (!item || item.slot !== slot) throw Object.assign(new Error("bad_item"), { status: 400 });
      if (!owned.has(itemId)) throw Object.assign(new Error("item_locked"), { status: 403 });
      equipped[slot] = itemId;
    }
    this.q("UPDATE users SET equipped = ?, icon = ? WHERE id = ?").run(JSON.stringify(equipped), equipped.icon, userId);
    return equipped;
  }
  // --- friends --------------------------------------------------------------
  friendRow(a, b) {
    const [x, y] = a < b ? [a, b] : [b, a];
    return this.q("SELECT * FROM friendships WHERE user_a = ? AND user_b = ?").get(x, y);
  }
  requestFriend(fromId, toId) {
    if (fromId === toId) throw Object.assign(new Error("cannot_friend_self"), { status: 400 });
    const [x, y] = fromId < toId ? [fromId, toId] : [toId, fromId];
    const row = this.friendRow(fromId, toId);
    if (row) {
      if (row.status === "accepted") return "already_friends";
      if (row.requester === toId) {
        this.q("UPDATE friendships SET status = 'accepted' WHERE user_a = ? AND user_b = ?").run(x, y);
        return "accepted";
      }
      return "already_requested";
    }
    const count = this.q("SELECT COUNT(*) AS c FROM friendships WHERE (user_a = ? OR user_b = ?)").get(fromId, fromId).c;
    if (count >= 200) throw Object.assign(new Error("friend_limit"), { status: 400 });
    this.q("INSERT INTO friendships (user_a, user_b, requester, status, created_at) VALUES (?, ?, ?, 'pending', ?)").run(x, y, fromId, this.clock());
    return "requested";
  }
  respondFriend(userId, otherId, accept) {
    const row = this.friendRow(userId, otherId);
    if (!row || row.status !== "pending" || row.requester === userId) {
      throw Object.assign(new Error("no_pending_request"), { status: 404 });
    }
    if (accept) this.q("UPDATE friendships SET status = 'accepted' WHERE user_a = ? AND user_b = ?").run(row.user_a, row.user_b);
    else this.q("DELETE FROM friendships WHERE user_a = ? AND user_b = ?").run(row.user_a, row.user_b);
  }
  removeFriend(userId, otherId) {
    const row = this.friendRow(userId, otherId);
    if (!row) throw Object.assign(new Error("not_friends"), { status: 404 });
    this.q("DELETE FROM friendships WHERE user_a = ? AND user_b = ?").run(row.user_a, row.user_b);
  }
  areFriends(a, b) {
    const row = this.friendRow(a, b);
    return Boolean(row && row.status === "accepted");
  }
  friendList(userId) {
    return this.q(`SELECT f.status, f.requester, u.id, u.display_name, u.icon, u.last_seen
      FROM friendships f JOIN users u ON u.id = CASE WHEN f.user_a = ? THEN f.user_b ELSE f.user_a END
      WHERE (f.user_a = ? OR f.user_b = ?) AND u.deleted_at IS NULL ORDER BY u.display_name`).all(userId, userId, userId);
  }
  friendIds(userId) {
    return this.friendList(userId).filter((f) => f.status === "accepted").map((f) => f.id);
  }
  // --- leaderboards ---------------------------------------------------------
  leaderboard({ board, mode, period, scope, userId, limit = 100 }) {
    const season = this.currentSeason();
    const ids = scope === "friends" && userId ? [userId, ...this.friendIds(userId)] : null;
    const idFilter = ids ? `AND u.id IN (${ids.map(() => "?").join(",")})` : "";
    const idArgs = ids || [];
    let rows;
    if (board === "rating" || board === "winrate") {
      const order = board === "rating" ? "r.rating DESC, r.wins DESC" : "winrate DESC, games DESC";
      const minGames = board === "winrate" ? 10 : 1;
      rows = this.q(`SELECT u.id AS user_id, u.display_name AS name, u.icon, r.rating, r.wins, r.losses, r.draws,
          (r.wins + r.losses + r.draws) AS games, CAST(r.wins AS REAL) / MAX(1, r.wins + r.losses + r.draws) AS winrate
        FROM ratings r JOIN users u ON u.id = r.user_id
        WHERE r.season_id = ? AND u.deleted_at IS NULL AND (r.wins + r.losses + r.draws) >= ${minGames} ${idFilter}
        ORDER BY ${order}, u.id LIMIT 1000`).all(season.id, ...idArgs);
      rows.forEach((r) => {
        r.value = board === "rating" ? r.rating : Math.round(r.winrate * 1e3) / 10;
      });
    } else {
      let since = 0;
      if (period === "week") since = weekStart(this.clock());
      else if (period === "season") since = season.starts_at;
      rows = this.q(`SELECT u.id AS user_id, u.display_name AS name, u.icon, MAX(x.score) AS value, MAX(x.max_combo) AS combo
        FROM runs x JOIN users u ON u.id = x.user_id
        WHERE x.mode = ? AND x.created_at >= ? AND u.deleted_at IS NULL ${idFilter}
        GROUP BY u.id ORDER BY value DESC, MIN(x.created_at), u.id LIMIT 1000`).all(mode, since, ...idArgs);
    }
    rows.forEach((r, i) => {
      r.rank = i + 1;
    });
    const me = userId ? rows.find((r) => r.user_id === userId) || null : null;
    return { entries: rows.slice(0, limit), me, total: rows.length, season: { id: season.id, name: season.name } };
  }
};
function eloChanges(a, b, k = 32) {
  const ea = 1 / (1 + 10 ** ((b.rating.rating - a.rating.rating) / 400));
  const sa = a.outcome === "win" ? 1 : a.outcome === "draw" ? 0.5 : 0;
  const da = Math.round(k * (sa - ea));
  return [da, -da];
}
function dateKey(ms, offsetMin = config.dailyTimezoneOffsetMin) {
  return new Date(ms + offsetMin * 6e4).toISOString().slice(0, 10);
}
function previousDate(date) {
  const d = /* @__PURE__ */ new Date(`${date}T00:00:00Z`);
  return new Date(d.getTime() - DAY).toISOString().slice(0, 10);
}
function isoWeek(ms) {
  const d = new Date(ms);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d - firstThursday) / DAY - 3 + (firstThursday.getUTCDay() + 6) % 7) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
function weekStart(ms) {
  const d = new Date(ms);
  const day = (d.getUTCDay() + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day);
}
function dailySeed(date) {
  let h = 2166136261;
  for (const ch of `onecolor-daily-${date}`) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h || 1;
}

// src/mailer.js
var transport = null;
var transportError = null;
async function getTransport() {
  if (!config.smtp.host) return null;
  if (transport || transportError) return transport;
  try {
    const nodemailer = (await import("nodemailer")).default;
    transport = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : void 0
    });
  } catch (err) {
    transportError = err;
    console.error("[mail] nodemailer unavailable:", err.message);
  }
  return transport;
}
var outbox = [];
var mailConfigured = () => Boolean(config.smtp.host);
async function sendMail(to, subject, text) {
  const t = await getTransport();
  if (!t) {
    if (!isProduction && config.devOutbox) {
      outbox.push({ to, subject, text, at: Date.now() });
      if (outbox.length > 200) outbox.shift();
    }
    console.log(`[mail] NOT SENT (SMTP not configured): "${subject}" to ${to}`);
    return { delivered: false, reason: "smtp_not_configured" };
  }
  try {
    await t.sendMail({ from: config.smtp.from, to, subject, text });
    return { delivered: true };
  } catch (err) {
    console.error("[mail] send failed:", err.message);
    return { delivered: false, reason: "smtp_error" };
  }
}

// src/rules/modes.js
var BASE = {
  lives: 1,
  round_timer: true,
  total_ms: 0,
  wrong: "life",
  wrong_penalty_ms: 0,
  timeout: "life",
  combo: "perfect",
  difficulty: "score",
  score_offset: 0,
  chaos: false,
  mirror: false,
  practice: false,
  scoring: "normal",
  sprint_target: 0
};
var MODE_RULES = {
  classic: {},
  time_attack: { lives: 0, round_timer: false, total_ms: 6e4, wrong: "combo", wrong_penalty_ms: 2e3, combo: "streak" },
  one_life: { score_offset: 20 },
  mirror: { mirror: true, lives: 3 },
  survival: { lives: 3, difficulty: "time" },
  chaos: { lives: 3, chaos: true },
  endless: { lives: 0, wrong: "combo", timeout: "skip", combo: "streak" },
  blitz: { lives: 0, round_timer: false, total_ms: 3e4, wrong: "combo", combo: "streak", scoring: "combo_mult", score_offset: 10 },
  hardcore: { score_offset: 60 },
  sprint: { lives: 0, round_timer: false, wrong: "combo", wrong_penalty_ms: 2e3, combo: "streak", sprint_target: 30 },
  blind: { lives: 3 },
  shape_only: { lives: 3 },
  practice: { lives: 0, round_timer: false, wrong: "combo", practice: true, combo: "streak" },
  daily: { lives: 0, round_timer: false, total_ms: 6e4, wrong: "combo", wrong_penalty_ms: 2e3, combo: "streak", score_offset: 10 },
  score_race: { lives: 0, round_timer: false, total_ms: 6e4, wrong: "combo", combo: "streak" },
  combo_battle: { lives: 0, round_timer: false, total_ms: 6e4, wrong: "combo", combo: "streak" },
  survival_duel: { lives: 3, total_ms: 12e4, combo: "streak" },
  mirror_duel: { lives: 0, round_timer: false, total_ms: 6e4, wrong: "combo", combo: "streak", mirror: true },
  daily_duel: { lives: 0, round_timer: false, total_ms: 6e4, wrong: "combo", combo: "streak" }
};
var VERIFIED_SINGLE = [
  "classic",
  "time_attack",
  "one_life",
  "blitz",
  "sprint",
  "hardcore",
  "survival",
  "chaos",
  "endless",
  "memory",
  "rhythm",
  "duel_color",
  "dual_control",
  "stroop",
  "odd_one",
  "count",
  "reaction",
  "chain",
  "blind",
  "shape_only",
  "daily"
];
var ONLINE_MODES = ["score_race", "combo_battle", "survival_duel", "daily_duel"];
function rulesFor(mode) {
  if (!Object.hasOwn(MODE_RULES, mode)) return null;
  return { ...BASE, ...MODE_RULES[mode], id: mode };
}
var ChaosRule = { MATCH: 0, NEXT: 1, REVERSE: 2, FAST: 3 };
var CHAOS_PERIOD = 8;
var CHAOS_WARN_ROUNDS = 2;
var CYCLE_ORDER = [0, 1, 2, 3, 4, 5];

// src/rules/rng.js
var DEFAULT_STATE = 625341585;
var WARMUP = 8;
var OcRng = class {
  constructor(seed = 0) {
    this.state = DEFAULT_STATE;
    this.setSeed(seed);
  }
  setSeed(value) {
    this.seed = value >>> 0;
    this.state = this.seed !== 0 ? this.seed : DEFAULT_STATE;
    for (let i = 0; i < WARMUP; i++) this.nextU32();
  }
  nextU32() {
    let x = this.state;
    x = (x ^ x << 13) >>> 0;
    x = (x ^ x >>> 17) >>> 0;
    x = (x ^ x << 5) >>> 0;
    this.state = x;
    return x;
  }
  randf() {
    return this.nextU32() / 4294967296;
  }
  randiRange(from, to) {
    return from + this.nextU32() % (to - from + 1);
  }
};

// src/rules/difficulty.js
var LEVELS = [
  { min_score: 0, base_time: 3, colors: 4, distance_weights: [0.5, 0.5], change_time: 0.4 },
  { min_score: 10, base_time: 2.6, colors: 4, distance_weights: [0.4, 0.6], change_time: 0.36 },
  { min_score: 20, base_time: 2.3, colors: 5, distance_weights: [0.3, 0.45, 0.25], change_time: 0.33 },
  { min_score: 40, base_time: 2, colors: 5, distance_weights: [0.25, 0.4, 0.35], change_time: 0.3 },
  { min_score: 60, base_time: 1.8, colors: 6, distance_weights: [0.2, 0.35, 0.3, 0.15], change_time: 0.28 },
  { min_score: 100, base_time: 1.6, colors: 6, distance_weights: [0.2, 0.3, 0.3, 0.2], change_time: 0.26 }
];
var LATE_GAME_STEP_SCORE = 25;
var LATE_GAME_TIME_STEP = 0.03;
var MIN_BASE_TIME = 1.35;
var MIN_ROUND_TIME = 1.2;
var PERFECT_PERCENT = 55;
var TILE_COUNT = 3;
function levelIndex(score) {
  let index = 0;
  for (let i = 0; i < LEVELS.length; i++) if (score >= LEVELS[i].min_score) index = i;
  return index;
}
var levelNumber = (score) => levelIndex(score) + 1;
var levelData = (score) => LEVELS[levelIndex(score)];
function baseTime(score) {
  const index = levelIndex(score);
  let t = LEVELS[index].base_time;
  if (index === LEVELS.length - 1) {
    const extraSteps = Math.trunc((score - LEVELS[index].min_score) / LATE_GAME_STEP_SCORE);
    t -= extraSteps * LATE_GAME_TIME_STEP;
  }
  return Math.max(MIN_BASE_TIME, t);
}
function roundTime(score, requiredChanges) {
  return Math.max(MIN_ROUND_TIME, baseTime(score) + Math.max(0, requiredChanges) * levelData(score).change_time);
}
var roundTimeMs = (score, requiredChanges) => Math.round(roundTime(score, requiredChanges) * 1e3);
var colorCount = (score) => levelData(score).colors;
function pickDistance(score, rng) {
  const weights = levelData(score).distance_weights;
  let total = 0;
  for (const w of weights) total += w;
  let roll = rng.randf() * total;
  for (let i = 0; i < weights.length; i++) {
    roll -= weights[i];
    if (roll < 0) return i;
  }
  return weights.length - 1;
}

// src/rules/roundgen.js
function shuffle(items, rng) {
  for (let i = items.length - 1; i > 0; i--) {
    const j = rng.randiRange(0, i);
    const tmp = items[i];
    items[i] = items[j];
    items[j] = tmp;
  }
}
var sameArray = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
function generate(sequence, currentStep, distance, tileCount, rng, previous = []) {
  const n = sequence.length;
  distance = Math.min(Math.max(distance, 0), n - tileCount);
  const target = sequence[(currentStep + distance) % n];
  const pool = [];
  for (let k = distance + 1; k < n; k++) pool.push(sequence[(currentStep + k) % n]);
  shuffle(pool, rng);
  const tiles = [target, ...pool.slice(0, tileCount - 1)];
  for (let attempt = 0; attempt < 4; attempt++) {
    shuffle(tiles, rng);
    if (!sameArray(tiles, previous)) break;
  }
  return tiles;
}
function changesNeeded(sequence, currentStep, tiles) {
  const n = sequence.length;
  for (let k = 0; k < n; k++) if (tiles.includes(sequence[(currentStep + k) % n])) return k;
  return -1;
}

// src/rules/score.js
function comboBonus(c) {
  if (c <= 0) return 0;
  if (c % 50 === 0) return 5;
  if (c % 25 === 0) return 3;
  if (c % 10 === 0) return 2;
  if (c % 5 === 0) return 1;
  return 0;
}
var ScoreManager = class {
  constructor() {
    this.reset();
  }
  reset() {
    this.score = 0;
    this.combo = 0;
    this.maxCombo = 0;
    this.correct = 0;
    this.perfect = 0;
    this.finalized = false;
  }
  registerCorrect(perfect, multiplier = 1) {
    if (this.finalized) return null;
    this.correct += 1;
    if (perfect) {
      this.combo += 1;
      this.perfect += 1;
    } else {
      this.combo = 0;
    }
    this.maxCombo = Math.max(this.maxCombo, this.combo);
    const bonus = perfect ? comboBonus(this.combo) : 0;
    this.score += (1 + bonus) * multiplier;
    return { gained: (1 + bonus) * multiplier, bonus, combo: this.combo, score: this.score };
  }
  registerMiss(penalty = 0) {
    if (this.finalized) return;
    this.combo = 0;
    this.score = Math.max(0, this.score - penalty);
  }
};

// src/rules/session.js
var EndReason = { NONE: 0, WRONG_TILE: 1, TIMEOUT: 2, TIME_UP: 3, QUIT: 4 };
var InputCode = { CHANGE_COLOR: 0, SELECT_TILE: 1, QUIT: 2 };
var Result = { IGNORED: 0, CORRECT: 1, WRONG: 2 };
var SPRINT_BUDGET_MS = 18e4;
var SURVIVAL_MS_PER_LEVEL_POINT = 1250;
var GameSession = class {
  constructor(mode, { onEvent } = {}) {
    this.rules = rulesFor(mode);
    if (!this.rules) throw new Error(`unknown mode ${mode}`);
    this.mode = mode;
    this.score = new ScoreManager();
    this.rng = new OcRng();
    this.onEvent = onEvent || (() => {
    });
    this.running = false;
  }
  start(seed) {
    this.score.reset();
    this.rng.setSeed(seed);
    this.seed = this.rng.seed;
    const offset = this.rules.score_offset;
    this.sequence = CYCLE_ORDER.slice(0, colorCount(offset));
    this.playerStep = 0;
    this.tiles = [];
    this.answerTiles = [];
    this.roundNumber = 0;
    this.level = levelNumber(offset);
    this.lives = this.rules.lives;
    this.wrongCount = 0;
    this.penaltyMs = 0;
    this.playMs = 0;
    this.roundElapsedMs = 0;
    this.limitMs = 0;
    this.runLeftMs = this.rules.total_ms;
    this.endReason = EndReason.NONE;
    this.chaosRule = ChaosRule.MATCH;
    this.nextChaosRule = -1;
    this.chaosChangeRound = CHAOS_PERIOD + 1;
    this.inputs = 0;
    this.running = true;
    this.nextRound();
  }
  currentColor() {
    return this.sequence[this.playerStep];
  }
  cycle() {
    if (this.rules.chaos && this.chaosRule === ChaosRule.REVERSE) return [...this.sequence].reverse();
    return this.sequence;
  }
  goalOffset() {
    return this.rules.chaos && this.chaosRule === ChaosRule.NEXT ? 1 : 0;
  }
  goalColor() {
    const c = this.cycle();
    return c[(c.indexOf(this.currentColor()) + this.goalOffset()) % c.length];
  }
  referenceIndex(i) {
    return this.rules.mirror ? this.tiles.length - 1 - i : i;
  }
  changeColor() {
    if (!this.running) return false;
    this.inputs++;
    const c = this.cycle();
    const next = c[(c.indexOf(this.currentColor()) + 1) % c.length];
    this.playerStep = this.sequence.indexOf(next);
    this.changesThisRound += 1;
    this.onEvent({ type: "color", step: this.playerStep, color: this.currentColor() });
    return true;
  }
  selectTile(index) {
    if (!this.running || !Number.isInteger(index) || index < 0 || index >= this.tiles.length) return Result.IGNORED;
    this.inputs++;
    if (this.tiles[this.referenceIndex(index)] === this.goalColor()) {
      let perfect = true;
      if (this.rules.combo === "perfect") {
        perfect = this.changesThisRound === this.requiredChanges && (this.limitMs === 0 || this.roundElapsedMs * 100 <= this.limitMs * PERFECT_PERCENT);
      }
      let multiplier = this.rules.chaos && this.chaosRule === ChaosRule.FAST ? 2 : 1;
      if (this.rules.scoring === "combo_mult") multiplier = 1 + Math.trunc(this.score.combo / 5);
      const info = this.score.registerCorrect(perfect, multiplier);
      this.onEvent({ type: "answer", correct: true, tile: index, score: this.score.score, combo: this.score.combo, gained: info.gained });
      if (this.rules.sprint_target > 0 && this.score.correct >= this.rules.sprint_target) {
        this.end(EndReason.TIME_UP);
        return Result.CORRECT;
      }
      this.nextRound();
      return Result.CORRECT;
    }
    this.onWrong(index);
    return Result.WRONG;
  }
  quit() {
    if (this.running) this.end(EndReason.QUIT);
  }
  advance(ms) {
    const hasTotal = this.rules.total_ms > 0;
    while (this.running && ms > 0) {
      let step = ms;
      if (this.limitMs > 0) step = Math.min(step, this.limitMs - this.roundElapsedMs);
      if (hasTotal) step = Math.min(step, this.runLeftMs);
      step = Math.max(step, 0);
      this.playMs += step;
      this.roundElapsedMs += step;
      ms -= step;
      if (hasTotal) {
        this.runLeftMs -= step;
        if (this.runLeftMs <= 0) {
          this.runLeftMs = 0;
          this.end(EndReason.TIME_UP);
          break;
        }
      }
      if (this.limitMs > 0 && this.roundElapsedMs >= this.limitMs) this.onTimeout();
      else if (step === 0) break;
    }
  }
  advanceTo(ms) {
    this.advance(ms - this.playMs);
  }
  matchingTileIndex() {
    const goal = this.goalColor();
    for (let i = 0; i < this.tiles.length; i++) if (this.tiles[this.referenceIndex(i)] === goal) return i;
    return -1;
  }
  difficultyScore() {
    if (this.rules.difficulty === "time") return this.rules.score_offset + Math.trunc(this.playMs / SURVIVAL_MS_PER_LEVEL_POINT);
    return this.rules.score_offset + this.score.score;
  }
  onWrong(index) {
    this.wrongCount += 1;
    if (this.rules.practice) {
      this.score.registerMiss(0);
      this.onEvent({ type: "answer", correct: false, tile: index, score: this.score.score, combo: 0 });
      return;
    }
    if (this.rules.wrong === "life" && this.rules.lives > 0) {
      this.onEvent({ type: "answer", correct: false, tile: index, score: this.score.score, combo: 0 });
      this.loseLife(EndReason.WRONG_TILE);
      return;
    }
    this.score.registerMiss(this.mode === "endless" ? 1 : 0);
    if (this.rules.wrong_penalty_ms > 0 && this.rules.total_ms > 0) {
      this.runLeftMs = Math.max(0, this.runLeftMs - this.rules.wrong_penalty_ms);
    }
    if (this.rules.sprint_target > 0) this.penaltyMs += this.rules.wrong_penalty_ms;
    this.onEvent({ type: "answer", correct: false, tile: index, score: this.score.score, combo: 0 });
    if (this.rules.total_ms > 0 && this.runLeftMs <= 0) this.end(EndReason.TIME_UP);
  }
  onTimeout() {
    if (this.rules.timeout === "skip" || this.rules.lives <= 0) {
      const overflow = this.roundElapsedMs - this.limitMs;
      this.score.registerMiss(this.mode === "endless" ? 1 : 0);
      this.onEvent({ type: "timeout", score: this.score.score, combo: 0 });
      this.nextRound();
      this.roundElapsedMs = overflow;
      return;
    }
    this.onEvent({ type: "timeout", score: this.score.score, combo: 0 });
    this.loseLife(EndReason.TIMEOUT);
  }
  loseLife(reason) {
    const overflow = reason === EndReason.TIMEOUT ? Math.max(0, this.roundElapsedMs - this.limitMs) : 0;
    this.lives -= 1;
    this.score.registerMiss(0);
    if (this.lives <= 0) {
      this.end(reason);
      return;
    }
    this.onEvent({ type: "life", lives: this.lives });
    this.nextRound();
    this.roundElapsedMs = overflow;
  }
  checkProgression() {
    const difficulty = this.difficultyScore();
    this.level = levelNumber(difficulty);
    const wanted = colorCount(difficulty);
    while (this.sequence.length < wanted && this.sequence.length < CYCLE_ORDER.length) {
      this.sequence.push(CYCLE_ORDER[this.sequence.length]);
    }
  }
  updateChaos() {
    if (!this.rules.chaos) return;
    if (this.roundNumber === this.chaosChangeRound - CHAOS_WARN_ROUNDS) {
      const options = [ChaosRule.MATCH, ChaosRule.NEXT, ChaosRule.REVERSE, ChaosRule.FAST].filter((r) => r !== this.chaosRule);
      this.nextChaosRule = options[this.rng.randiRange(0, options.length - 1)];
    }
    if (this.roundNumber === this.chaosChangeRound && this.nextChaosRule >= 0) {
      this.chaosRule = this.nextChaosRule;
      this.nextChaosRule = -1;
      this.chaosChangeRound += CHAOS_PERIOD;
    }
  }
  nextRound() {
    this.roundNumber += 1;
    if (this.roundNumber > 1) this.checkProgression();
    this.updateChaos();
    const difficulty = this.difficultyScore();
    const c = this.cycle();
    const startStep = c.indexOf(this.currentColor()) + this.goalOffset();
    const distance = pickDistance(difficulty, this.rng);
    this.tiles = generate(c, startStep, distance, TILE_COUNT, this.rng, this.tiles);
    this.requiredChanges = changesNeeded(c, startStep, this.tiles);
    if (this.rules.mirror) {
      this.answerTiles = [...this.tiles];
      shuffle(this.answerTiles, this.rng);
    }
    this.changesThisRound = 0;
    this.roundElapsedMs = 0;
    if (this.rules.round_timer) {
      this.limitMs = roundTimeMs(difficulty, this.requiredChanges);
      if (this.rules.chaos && this.chaosRule === ChaosRule.FAST) this.limitMs = Math.trunc(this.limitMs * 6 / 10);
    } else {
      this.limitMs = 0;
    }
    this.onEvent({
      type: "round",
      round: this.roundNumber,
      tiles: [...this.tiles],
      answer_tiles: [...this.answerTiles],
      sequence: [...this.sequence],
      step: this.playerStep,
      limit_ms: this.limitMs,
      lives: this.lives,
      score: this.score.score,
      combo: this.score.combo
    });
  }
  end(reason) {
    if (!this.running) return;
    this.running = false;
    this.endReason = reason;
    if (this.rules.sprint_target > 0) {
      const finished = this.score.correct >= this.rules.sprint_target;
      this.score.score = finished ? Math.max(0, Math.trunc((SPRINT_BUDGET_MS - this.playMs - this.penaltyMs) / 10)) : 0;
    }
    this.score.finalized = true;
    this.onEvent({ type: "end", reason, score: this.score.score, max_combo: this.score.maxCombo, play_ms: this.playMs });
  }
  summary() {
    const attempts = this.score.correct + this.wrongCount;
    return {
      mode: this.mode,
      score: this.score.score,
      max_combo: this.score.maxCombo,
      correct: this.score.correct,
      wrong: this.wrongCount,
      rounds: this.roundNumber,
      play_ms: this.playMs,
      lives_left: Math.max(0, this.lives),
      reason: this.endReason,
      accuracy: attempts > 0 ? this.score.correct / attempts : 0,
      running: this.running
    };
  }
};
function replay(mode, seed, inputs, endMs = null) {
  const s = new GameSession(mode);
  s.start(seed);
  let last = 0;
  for (const entry of inputs) {
    if (!Array.isArray(entry) || entry.length !== 3) throw new Error("bad input entry");
    const [ms, code, arg] = entry;
    if (!Number.isInteger(ms) || ms < last) throw new Error("input times must be non-decreasing integers");
    last = ms;
    s.advanceTo(ms);
    if (!s.running) break;
    if (code === InputCode.CHANGE_COLOR) s.changeColor();
    else if (code === InputCode.SELECT_TILE) s.selectTile(arg);
    else if (code === InputCode.QUIT) {
      s.quit();
      break;
    } else throw new Error("bad input code");
  }
  if (s.running && endMs !== null) s.advanceTo(endMs);
  return s.summary();
}

// src/rules/special.js
var idiv = (a, b) => Math.trunc(a / b);
var ModeSession = class {
  constructor(mode) {
    this.mode = mode;
    this.score = new ScoreManager();
    this.rng = new OcRng();
    this.running = false;
    this.maxLives = 3;
  }
  start(seed) {
    this.score.reset();
    this.rng.setSeed(seed);
    this.seed = this.rng.seed;
    this.running = true;
    this.lives = this.maxLives;
    this.wrongCount = 0;
    this.roundNumber = 0;
    this.playMs = 0;
    this.endReason = EndReason.NONE;
    this.begin();
  }
  begin() {
  }
  step() {
  }
  apply() {
    return Result.IGNORED;
  }
  extraSummary() {
  }
  advance(ms) {
    while (this.running && ms > 0) {
      const step = Math.min(ms, 10);
      this.playMs += step;
      ms -= step;
      this.step(step);
    }
  }
  advanceTo(ms) {
    this.advance(ms - this.playMs);
  }
  input(code, arg) {
    if (!this.running) return Result.IGNORED;
    return this.apply(code, arg);
  }
  loseLife(reason) {
    this.wrongCount += 1;
    this.score.registerMiss(0);
    this.lives -= 1;
    if (this.lives <= 0) this.end(reason);
  }
  end(reason) {
    if (!this.running) return;
    this.running = false;
    this.endReason = reason;
    this.score.finalized = true;
  }
  distinct(n, pool, mustHave = -1) {
    const colors = CYCLE_ORDER.slice(0, pool);
    shuffle(colors, this.rng);
    const out = colors.slice(0, n);
    if (mustHave >= 0 && !out.includes(mustHave)) out[this.rng.randiRange(0, n - 1)] = mustHave;
    return out;
  }
  summary() {
    const attempts = this.score.correct + this.wrongCount;
    const s = {
      mode: this.mode,
      score: this.score.score,
      max_combo: this.score.maxCombo,
      correct: this.score.correct,
      wrong: this.wrongCount,
      rounds: this.roundNumber,
      play_ms: this.playMs,
      lives_left: Math.max(0, this.lives),
      reason: this.endReason,
      accuracy: attempts > 0 ? this.score.correct / attempts : 0,
      running: this.running
    };
    this.extraSummary(s);
    return s;
  }
};
var TimedRounds = class extends ModeSession {
  begin() {
    this.nextRound();
  }
  step(ms) {
    this.roundMs += ms;
    if (this.roundMs >= this.limitMs) {
      this.loseLife(EndReason.TIMEOUT);
      if (this.running) this.nextRound();
    }
  }
  wrong() {
    this.loseLife(EndReason.WRONG_TILE);
    if (this.running) this.nextRound();
    return Result.WRONG;
  }
};
var MPhase = { SHOW: 0, INPUT: 1, PAUSE: 2 };
var MemorySession = class extends ModeSession {
  begin() {
    this.sequence = [];
    this.newRound(true);
  }
  padSize() {
    return this.roundNumber < 6 ? 4 : this.roundNumber < 10 ? 5 : 6;
  }
  showMs() {
    return Math.max(320, 650 - 25 * (this.roundNumber - 1));
  }
  apply(code, color) {
    if (this.phase !== MPhase.INPUT || !this.pad.includes(color)) return Result.IGNORED;
    if (color === this.sequence[this.cursor]) {
      this.cursor += 1;
      this.inputMs = 0;
      if (this.cursor >= this.sequence.length) {
        this.score.registerCorrect(true, this.sequence.length);
        this.pauseThen(true);
      }
      return Result.CORRECT;
    }
    this.loseLife(EndReason.WRONG_TILE);
    if (this.running) this.pauseThen(false);
    return Result.WRONG;
  }
  step(ms) {
    this.phaseMs += ms;
    if (this.phase === MPhase.SHOW) {
      const slot = this.showMs() + 180;
      const index = idiv(this.phaseMs, slot);
      if (index >= this.sequence.length) {
        this.phase = MPhase.INPUT;
        this.shown = -1;
        this.cursor = 0;
        this.inputMs = 0;
        return;
      }
      const color = this.phaseMs % slot < this.showMs() ? this.sequence[index] : -1;
      if (color !== this.shown || index !== this.cursor) {
        this.shown = color;
        this.cursor = index;
      }
    } else if (this.phase === MPhase.INPUT) {
      this.inputMs += ms;
      if (this.inputMs >= 4e3) {
        this.loseLife(EndReason.TIMEOUT);
        if (this.running) this.pauseThen(false);
      }
    } else if (this.phaseMs >= 700) {
      this.newRound(this.advanceAfterPause);
    }
  }
  pauseThen(adv) {
    this.phase = MPhase.PAUSE;
    this.phaseMs = 0;
    this.advanceAfterPause = adv;
    this.shown = -1;
  }
  newRound(grow) {
    if (grow) {
      this.roundNumber += 1;
      this.pad = CYCLE_ORDER.slice(0, this.padSize());
      const length = 3 + this.roundNumber - 1;
      while (this.sequence.length < length) this.sequence.push(this.pad[this.rng.randiRange(0, this.pad.length - 1)]);
    }
    this.phase = MPhase.SHOW;
    this.phaseMs = 0;
    this.cursor = 0;
    this.shown = -1;
  }
  extraSummary(s) {
    s.best_length = this.sequence.length - (this.endReason === EndReason.QUIT ? 0 : 1);
  }
};
var BEATS = 64;
var RhythmSession = class extends ModeSession {
  begin() {
    this.maxLives = 0;
    this.lives = 0;
    this.beatTimes = [];
    this.colors = [];
    this.beatTiles = [];
    let t = 1600;
    let prev = -1;
    for (let k = 0; k < BEATS; k++) {
      const bpm = 96 + idiv(48 * k, BEATS - 1);
      this.beatTimes.push(t);
      t += idiv(6e4, bpm);
      let color = CYCLE_ORDER[this.rng.randiRange(0, 3)];
      if (color === prev) color = CYCLE_ORDER[(CYCLE_ORDER.indexOf(color) + 1) % 4];
      prev = color;
      this.colors.push(color);
      this.beatTiles.push(this.distinct(3, 4, color));
    }
    this.beat = 0;
    this.roundNumber = 0;
    this.perfectCount = 0;
    this.goodCount = 0;
    this.missCount = 0;
  }
  apply(code, tile) {
    if (this.beat >= BEATS) return Result.IGNORED;
    const error = this.playMs - this.beatTimes[this.beat];
    if (error < -260) {
      this.judge("miss");
      return Result.WRONG;
    }
    const tiles = this.beatTiles[this.beat];
    if (!Number.isInteger(tile) || tile < 0 || tile >= tiles.length || tiles[tile] !== this.colors[this.beat]) {
      this.judge("miss");
      return Result.WRONG;
    }
    const a = Math.abs(error);
    this.judge(a <= 70 ? "perfect" : a <= 150 ? "good" : "miss");
    return a <= 150 ? Result.CORRECT : Result.WRONG;
  }
  step() {
    if (this.beat < BEATS && this.playMs > this.beatTimes[this.beat] + 150) this.judge("miss");
  }
  judge(kind) {
    if (kind === "perfect") {
      this.perfectCount += 1;
      this.score.registerCorrect(true, 3);
    } else if (kind === "good") {
      this.goodCount += 1;
      this.score.registerCorrect(false, 1);
    } else {
      this.missCount += 1;
      this.wrongCount += 1;
      this.score.registerMiss(0);
    }
    this.beat += 1;
    this.roundNumber = this.beat;
    if (this.beat >= BEATS) this.end(EndReason.TIME_UP);
  }
  extraSummary(s) {
    s.perfect_hits = this.perfectCount;
    s.good_hits = this.goodCount;
    s.misses = this.missCount;
    if (this.beat >= BEATS) s.accuracy = (this.perfectCount + this.goodCount) / BEATS;
  }
};
var DuelColorSession = class extends TimedRounds {
  goal() {
    return this.active === 0 ? this.colorA : this.colorB;
  }
  apply(code, arg) {
    if (code === 0) {
      [this.colorA, this.colorB] = [this.colorB, this.colorA];
      this.active = 1 - this.active;
      return Result.CORRECT;
    }
    if (!Number.isInteger(arg) || arg < 0 || arg >= this.tiles.length) return Result.IGNORED;
    if (this.tiles[arg] === this.goal()) {
      this.score.registerCorrect(this.roundMs * 100 <= this.limitMs * PERFECT_PERCENT);
      this.nextRound();
      return Result.CORRECT;
    }
    return this.wrong();
  }
  nextRound() {
    this.roundNumber += 1;
    const sc = this.score.score;
    const pool = sc < 15 ? 4 : sc < 35 ? 5 : 6;
    const pair = this.distinct(2, pool);
    this.colorA = pair[0];
    this.colorB = pair[1];
    this.active = this.rng.randiRange(0, 1);
    let other = this.colorA;
    const palette = CYCLE_ORDER.slice(0, pool);
    while (other === this.colorA || other === this.colorB) other = palette[this.rng.randiRange(0, palette.length - 1)];
    this.tiles = [this.colorA, this.colorB, other];
    shuffle(this.tiles, this.rng);
    this.limitMs = Math.max(1100, 2600 - 60 * sc);
    this.roundMs = 0;
  }
};
var DualControlSession = class extends TimedRounds {
  apply(code, arg) {
    if (!Number.isInteger(arg) || arg < 0 || arg > 3) return Result.IGNORED;
    const side = idiv(arg, 2);
    const index = arg % 2;
    if (this.solved[side]) return Result.IGNORED;
    if (this.sideTiles[side][index] === this.colors[side]) {
      this.solved[side] = true;
      const both = this.solved[0] && this.solved[1];
      this.score.registerCorrect(!both || this.roundMs * 100 <= this.limitMs * 70);
      if (both) this.nextRound();
      return Result.CORRECT;
    }
    return this.wrong();
  }
  nextRound() {
    this.roundNumber += 1;
    const pool = this.score.score < 20 ? 4 : 6;
    this.colors = [-1, -1];
    this.sideTiles = [[], []];
    this.solved = [false, false];
    for (let side = 0; side < 2; side++) {
      const pair = this.distinct(2, pool);
      this.colors[side] = pair[this.rng.randiRange(0, 1)];
      this.sideTiles[side] = pair;
    }
    this.limitMs = Math.max(1400, 3200 - 50 * idiv(this.score.score, 2));
    this.roundMs = 0;
  }
};
var StroopSession = class extends TimedRounds {
  goal() {
    return this.rule === 0 ? this.word : this.ink;
  }
  apply(code, arg) {
    if (!Number.isInteger(arg) || arg < 0 || arg >= this.tiles.length) return Result.IGNORED;
    if (this.tiles[arg] === this.goal()) {
      this.score.registerCorrect(this.roundMs * 100 <= this.limitMs * PERFECT_PERCENT);
      this.nextRound();
      return Result.CORRECT;
    }
    return this.wrong();
  }
  nextRound() {
    this.roundNumber += 1;
    const sc = this.score.score;
    const pool = sc < 15 ? 4 : sc < 35 ? 5 : 6;
    const pair = this.distinct(2, pool);
    this.word = pair[0];
    this.ink = pair[1];
    this.rule = this.rng.randiRange(0, 1);
    const palette = CYCLE_ORDER.slice(0, pool);
    let other = this.word;
    while (other === this.word || other === this.ink) other = palette[this.rng.randiRange(0, palette.length - 1)];
    this.tiles = [this.word, this.ink, other];
    shuffle(this.tiles, this.rng);
    this.limitMs = Math.max(1100, 2600 - 50 * sc);
    this.roundMs = 0;
  }
};
var OddOneSession = class extends TimedRounds {
  apply(code, arg) {
    if (!Number.isInteger(arg) || arg < 0 || arg >= this.tiles.length) return Result.IGNORED;
    if (arg === this.oddIndex) {
      this.score.registerCorrect(this.roundMs * 100 <= this.limitMs * PERFECT_PERCENT);
      this.nextRound();
      return Result.CORRECT;
    }
    return this.wrong();
  }
  nextRound() {
    this.roundNumber += 1;
    const pool = this.score.score < 20 ? 4 : 6;
    const pair = this.distinct(2, pool);
    this.oddIndex = this.rng.randiRange(0, 3);
    this.tiles = [0, 1, 2, 3].map((i) => i === this.oddIndex ? pair[1] : pair[0]);
    this.limitMs = Math.max(750, 2200 - 40 * this.score.score);
    this.roundMs = 0;
  }
};
var CPhase = { SHOW: 0, INPUT: 1 };
var CountSession = class extends ModeSession {
  begin() {
    this.nextRound();
  }
  showMs() {
    return Math.max(800, 1800 - 40 * (this.roundNumber - 1));
  }
  apply(code, arg) {
    if (this.phase !== CPhase.INPUT || !Number.isInteger(arg) || arg < 0 || arg >= this.tiles.length) return Result.IGNORED;
    if (this.tiles[arg] === this.answer) {
      this.score.registerCorrect(this.phaseMs * 100 <= 4e3 * 40);
      this.nextRound();
      return Result.CORRECT;
    }
    this.loseLife(EndReason.WRONG_TILE);
    if (this.running) this.nextRound();
    return Result.WRONG;
  }
  step(ms) {
    this.phaseMs += ms;
    if (this.phase === CPhase.SHOW && this.phaseMs >= this.showMs()) {
      this.phase = CPhase.INPUT;
      this.phaseMs = 0;
    } else if (this.phase === CPhase.INPUT && this.phaseMs >= 4e3) {
      this.loseLife(EndReason.TIMEOUT);
      if (this.running) this.nextRound();
    }
  }
  nextRound() {
    this.roundNumber += 1;
    const pool = this.score.score < 10 ? 4 : 6;
    this.tiles = this.distinct(3, pool);
    const total = Math.min(5 + idiv(this.roundNumber, 2), 13);
    const counts = [0, 0, 0];
    const winner = this.rng.randiRange(0, 2);
    for (let i = 0; i < total; i++) counts[this.rng.randiRange(0, 2)] += 1;
    counts[winner] = Math.max(...counts) + 1;
    this.answer = this.tiles[winner];
    this.dots = [];
    for (let slot = 0; slot < 3; slot++) {
      for (let i = 0; i < counts[slot]; i++) {
        this.dots.push([this.tiles[slot], this.rng.randiRange(40, 960), this.rng.randiRange(40, 960)]);
      }
    }
    shuffle(this.dots, this.rng);
    this.phase = CPhase.SHOW;
    this.phaseMs = 0;
  }
};
var RPhase = { WAIT: 0, GO: 1, PAUSE: 2 };
var ReactionSession = class extends ModeSession {
  begin() {
    this.maxLives = 0;
    this.lives = 0;
    this.bestRt = -1;
    this.rtTotal = 0;
    this.hits = 0;
    this.nextRound();
  }
  apply(code, arg) {
    if (this.phase === RPhase.PAUSE) return Result.IGNORED;
    if (this.phase === RPhase.WAIT) {
      this.miss();
      return Result.WRONG;
    }
    if (!Number.isInteger(arg) || arg < 0 || arg >= this.tiles.length) return Result.IGNORED;
    if (this.tiles[arg] !== this.color) {
      this.miss();
      return Result.WRONG;
    }
    const rt = this.phaseMs;
    this.bestRt = this.bestRt < 0 ? rt : Math.min(this.bestRt, rt);
    this.rtTotal += rt;
    this.hits += 1;
    this.score.registerCorrect(rt <= 400, Math.max(5, idiv(1500 - rt, 10)));
    this.pause();
    return Result.CORRECT;
  }
  miss() {
    this.wrongCount += 1;
    this.score.registerMiss(0);
    this.pause();
  }
  pause() {
    this.phase = RPhase.PAUSE;
    this.phaseMs = 0;
  }
  step(ms) {
    this.phaseMs += ms;
    if (this.phase === RPhase.WAIT) {
      if (this.phaseMs >= this.waitMs) {
        this.phase = RPhase.GO;
        this.phaseMs = 0;
      }
    } else if (this.phase === RPhase.GO) {
      if (this.phaseMs >= 1500) this.miss();
    } else if (this.phaseMs >= 600) {
      if (this.roundNumber >= 12) this.end(EndReason.TIME_UP);
      else this.nextRound();
    }
  }
  nextRound() {
    this.roundNumber += 1;
    this.color = CYCLE_ORDER[this.rng.randiRange(0, 3)];
    this.tiles = this.distinct(3, 4, this.color);
    this.waitMs = this.rng.randiRange(700, 2500);
    this.phase = RPhase.WAIT;
    this.phaseMs = 0;
  }
  extraSummary(s) {
    s.best_rt = this.bestRt;
    s.avg_rt = this.hits > 0 ? idiv(this.rtTotal, this.hits) : -1;
  }
};
var ChainSession = class extends TimedRounds {
  apply(code, arg) {
    if (!Number.isInteger(arg) || arg < 0 || arg >= 6 || this.cleared[arg]) return Result.IGNORED;
    if (this.tiles[arg] === this.color) {
      this.cleared[arg] = true;
      this.remaining -= 1;
      this.score.registerCorrect(this.remaining > 0 || this.roundMs * 100 <= this.limitMs * 60);
      if (this.remaining <= 0) this.nextRound();
      return Result.CORRECT;
    }
    return this.wrong();
  }
  nextRound() {
    this.roundNumber += 1;
    const pool = this.score.score < 25 ? 4 : 6;
    const palette = CYCLE_ORDER.slice(0, pool);
    this.color = palette[this.rng.randiRange(0, palette.length - 1)];
    const want = Math.min(2 + this.rng.randiRange(0, 1) + idiv(this.score.score, 30), 4);
    this.tiles = [];
    for (let i = 0; i < 6; i++) {
      let c = this.color;
      if (i >= want) while (c === this.color) c = palette[this.rng.randiRange(0, palette.length - 1)];
      this.tiles.push(c);
    }
    shuffle(this.tiles, this.rng);
    this.cleared = [false, false, false, false, false, false];
    this.remaining = want;
    this.limitMs = Math.max(1700, 4200 - 50 * idiv(this.score.score, 2));
    this.roundMs = 0;
  }
};
var SPECIAL_ENGINES = {
  memory: MemorySession,
  rhythm: RhythmSession,
  duel_color: DuelColorSession,
  dual_control: DualControlSession,
  stroop: StroopSession,
  odd_one: OddOneSession,
  count: CountSession,
  reaction: ReactionSession,
  chain: ChainSession
};
function isSpecial(mode) {
  return Object.hasOwn(SPECIAL_ENGINES, mode);
}
function replaySpecial(mode, seed, inputs, endMs = null) {
  const s = new SPECIAL_ENGINES[mode](mode);
  s.start(seed);
  let last = 0;
  for (const entry of inputs) {
    if (!Array.isArray(entry) || entry.length !== 3) throw new Error("bad input entry");
    const [ms, code, arg] = entry;
    if (!Number.isInteger(ms) || ms < last || !Number.isInteger(code) || !Number.isInteger(arg)) throw new Error("bad input");
    if (code !== 0 && code !== 1) throw new Error("bad input code");
    last = ms;
    s.advanceTo(ms);
    if (!s.running) break;
    s.input(code, arg);
  }
  if (s.running && endMs !== null) s.advanceTo(endMs);
  return s.summary();
}

// src/api.js
var VERIFY_TTL = 24 * 3600 * 1e3;
var RESET_TTL = 3600 * 1e3;
var MAX_BODY = 256 * 1024;
var HttpError = class extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
  }
};
function createApi({ store, hub }) {
  const ipLimiter = new RateLimiter(config.authIpLimit, 6e4);
  const authLimiter = new RateLimiter(10, 6e4);
  const mailLimiter = new RateLimiter(3, 10 * 6e4);
  const generalLimiter = new RateLimiter(config.apiIpLimit, 6e4);
  const LOCK_FAILS = 10;
  const LOCK_MS = 15 * 6e4;
  const loginFails = /* @__PURE__ */ new Map();
  const lockedOut = (login, now2 = Date.now()) => {
    const f = loginFails.get(login);
    if (!f) return false;
    if (now2 - f.since > LOCK_MS) {
      loginFails.delete(login);
      return false;
    }
    return f.count >= LOCK_FAILS;
  };
  const noteFail = (login, now2 = Date.now()) => {
    const f = loginFails.get(login);
    if (!f || now2 - f.since > LOCK_MS) loginFails.set(login, { count: 1, since: now2 });
    else f.count += 1;
    if (loginFails.size > 5e4) {
      for (const [k, v] of loginFails) if (now2 - v.since > LOCK_MS) loginFails.delete(k);
    }
  };
  const routes = [];
  const route = (method, path4, handler, opts = {}) => routes.push({ method, path: path4, handler, ...opts });
  const authed = (req) => {
    const h = req.headers.authorization || "";
    const token = h.startsWith("Bearer ") ? h.slice(7) : "";
    const user = store.userForToken(token);
    if (!user) throw new HttpError(401, "unauthorized");
    req.token = token;
    return user;
  };
  const publicUser = (u) => ({
    id: u.id,
    display_name: u.display_name,
    icon: u.icon,
    equipped: { ...DEFAULT_EQUIPPED, ...JSON.parse(u.equipped || "{}") }
  });
  function profileOf(user, { self }) {
    const season = store.currentSeason();
    const r = store.ratingRow(user.id, season.id);
    const totals = store.q(`SELECT SUM(wins) w, SUM(losses) l, SUM(draws) d, MAX(peak) p FROM ratings WHERE user_id = ?`).get(user.id);
    const games = (totals.w || 0) + (totals.l || 0) + (totals.d || 0);
    const p = {
      ...publicUser(user),
      created_at: user.created_at,
      online: hub.isOnline(user.id),
      season: { id: season.id, name: season.name, rating: r.rating, peak: r.peak, wins: r.wins, losses: r.losses, draws: r.draws, streak: r.streak },
      totals: {
        wins: totals.w || 0,
        losses: totals.l || 0,
        draws: totals.d || 0,
        games,
        win_rate: games ? Math.round((totals.w || 0) / games * 1e3) / 10 : 0,
        peak_rating: Math.max(totals.p || 1e3, 1e3)
      },
      verified_records: store.bestRuns(user.id),
      recent_matches: store.recentMatches(user.id),
      achievements: store.achievements(user.id)
    };
    if (self) {
      p.username = user.username;
      p.email = user.email;
      p.email_verified = Boolean(user.email_verified);
      p.friend_code = user.friend_code;
      p.inventory = store.inventory(user.id);
      p.local_records = store.localRecords(user.id);
      p.mail_configured = mailConfigured();
    }
    return p;
  }
  async function sendVerification(user) {
    const token = store.createEmailToken(user.id, "verify", VERIFY_TTL);
    const link = `${config.publicUrl}/verify-email?token=${encodeURIComponent(token)}`;
    return sendMail(user.email, "[ONE COLOR] \uC774\uBA54\uC77C \uC778\uC99D", `\uC544\uB798 \uB9C1\uD06C\uB97C \uC5F4\uC5B4 \uC774\uBA54\uC77C\uC744 \uC778\uC99D\uD558\uC138\uC694 (24\uC2DC\uAC04 \uC720\uD6A8):
${link}
`);
  }
  route("GET", "/api/health", () => ({
    ok: true,
    time: Date.now(),
    mail_configured: mailConfigured(),
    online_modes: ONLINE_MODES,
    verified_modes: VERIFIED_SINGLE,
    require_email_verification: config.requireEmailVerification
  }));
  route("GET", "/api/catalog", () => ({ items: ITEMS, achievements: ACHIEVEMENTS, default_equipped: DEFAULT_EQUIPPED }));
  route("POST", "/api/auth/register", async (req, body) => {
    if (!ipLimiter.allow(`reg:${req.ip}`)) throw new HttpError(429, "too_many_requests");
    const up = usernameProblem(body.username);
    if (up) throw new HttpError(400, up);
    const username = normalizeUsername(body.username);
    const email = String(body.email || "").trim().toLowerCase();
    if (email && !validEmail(email)) throw new HttpError(400, "invalid_email");
    const pp = passwordProblem(body.password);
    if (pp) throw new HttpError(400, pp);
    if (body.password !== body.password_confirm) throw new HttpError(400, "password_mismatch");
    const displayName = String(body.display_name || "").trim() || username;
    const np = displayNameProblem(displayName);
    if (np) throw new HttpError(400, np);
    if (body.accept_terms !== true) throw new HttpError(400, "terms_not_accepted");
    const id = store.createUser({ username, email: email || null, password: body.password, displayName });
    const user = store.userById(id);
    if (body.guest_records) store.mergeLocalRecords(id, body.guest_records);
    const mail = email ? await sendVerification(user) : null;
    const token = store.createSession(id, body.device);
    return { status: 201, body: { token, user: profileOf(user, { self: true }), verification_mail: mail } };
  });
  route("POST", "/api/auth/login", (req, body) => {
    const login = String(body.login || body.username || body.email || "").trim().toLowerCase();
    if (lockedOut(login)) throw new HttpError(429, "account_locked_temporarily");
    if (!ipLimiter.allow(`login:${req.ip}`) || !authLimiter.allow(`login:${login}`)) throw new HttpError(429, "too_many_requests");
    const user = store.checkLogin(login, String(body.password || ""));
    if (!user) {
      noteFail(login);
      throw new HttpError(401, "invalid_credentials");
    }
    loginFails.delete(login);
    const token = store.createSession(user.id, body.device);
    return { token, user: profileOf(user, { self: true }) };
  });
  route("POST", "/api/auth/logout", (req) => {
    authed(req);
    store.deleteSession(req.token);
    return { ok: true };
  });
  route("POST", "/api/auth/verify-email", (req, body) => {
    const userId = store.consumeEmailToken(body.token, "verify");
    if (!userId) throw new HttpError(400, "invalid_or_expired_token");
    store.setEmailVerified(userId);
    return { ok: true };
  });
  route("POST", "/api/auth/resend-verification", async (req) => {
    const user = authed(req);
    if (user.email_verified) return { ok: true, already_verified: true };
    if (!user.email) throw new HttpError(400, "no_email");
    if (!mailLimiter.allow(`verify:${user.id}`)) throw new HttpError(429, "too_many_requests");
    return { ok: true, verification_mail: await sendVerification(user) };
  });
  route("POST", "/api/auth/password-reset/request", async (req, body) => {
    const email = String(body.email || "").trim().toLowerCase();
    if (!mailLimiter.allow(`reset:${req.ip}`) || !mailLimiter.allow(`reset:${email}`)) throw new HttpError(429, "too_many_requests");
    const user = validEmail(email) ? store.userByEmail(email) : null;
    let mail = { delivered: mailConfigured(), reason: mailConfigured() ? void 0 : "smtp_not_configured" };
    if (user) {
      const token = store.createEmailToken(user.id, "reset", RESET_TTL);
      const link = `${config.publicUrl}/reset-password?token=${encodeURIComponent(token)}`;
      mail = await sendMail(
        user.email,
        "[ONE COLOR] \uBE44\uBC00\uBC88\uD638 \uC7AC\uC124\uC815",
        `\uC544\uB798 \uB9C1\uD06C\uC5D0\uC11C \uC0C8 \uBE44\uBC00\uBC88\uD638\uB97C \uC124\uC815\uD558\uC138\uC694 (1\uC2DC\uAC04 \uC720\uD6A8, \uD55C \uBC88\uB9CC \uC0AC\uC6A9 \uAC00\uB2A5):
${link}
`
      );
    }
    return { ok: true, mail_configured: mailConfigured(), delivered: user ? mail.delivered : mailConfigured() };
  });
  route("POST", "/api/auth/password-reset/confirm", (req, body) => {
    const pp = passwordProblem(body.password);
    if (pp) throw new HttpError(400, pp);
    if (body.password !== body.password_confirm) throw new HttpError(400, "password_mismatch");
    const userId = store.consumeEmailToken(body.token, "reset");
    if (!userId) throw new HttpError(400, "invalid_or_expired_token");
    store.setPassword(userId, body.password);
    store.deleteSessionsOf(userId);
    return { ok: true };
  });
  if (!isProduction && config.devOutbox) {
    route("GET", "/api/dev/outbox", () => ({ outbox }));
  }
  route("GET", "/api/me", (req) => profileOf(authed(req), { self: true }));
  route("PATCH", "/api/me", (req, body) => {
    const user = authed(req);
    if (body.display_name !== void 0) {
      const np = displayNameProblem(body.display_name);
      if (np) throw new HttpError(400, np);
      if (user.name_changed_at && Date.now() - user.name_changed_at < 6e4) throw new HttpError(429, "name_change_too_soon");
      store.setDisplayName(user.id, body.display_name);
    }
    if (body.equipped !== void 0) {
      if (typeof body.equipped !== "object" || body.equipped === null) throw new HttpError(400, "bad_equipped");
      store.equip(user.id, body.equipped);
    }
    return profileOf(store.userById(user.id), { self: true });
  });
  route("DELETE", "/api/me", (req, body) => {
    const user = authed(req);
    if (body.confirm !== "DELETE") throw new HttpError(400, "confirmation_required");
    if (!store.checkPassword(user.id, String(body.password || ""))) throw new HttpError(401, "invalid_credentials");
    hub.disconnectUser(user.id);
    store.deleteUser(user.id);
    return { ok: true };
  });
  route("POST", "/api/me/link-guest", (req, body) => {
    const user = authed(req);
    store.mergeLocalRecords(user.id, body.records || {});
    const progress = store.reportProgress(user.id, body.played_modes || []);
    return { ok: true, local_records: store.localRecords(user.id), achievements: progress.achievements };
  });
  route("POST", "/api/me/progress", (req, body) => {
    const user = authed(req);
    return store.reportProgress(user.id, body.played_modes || []);
  });
  route("GET", "/api/users/:id", (req, body, params) => {
    authed(req);
    const user = store.userById(Number(params.id));
    if (!user) throw new HttpError(404, "not_found");
    return profileOf(user, { self: false });
  });
  route("GET", "/api/friends", (req) => {
    const user = authed(req);
    const list = store.friendList(user.id).map((f) => ({
      id: f.id,
      display_name: f.display_name,
      icon: f.icon,
      last_seen: f.last_seen,
      status: f.status === "accepted" ? "friend" : f.requester === user.id ? "outgoing" : "incoming",
      online: f.status === "accepted" ? hub.isOnline(f.id) : false,
      in_match: f.status === "accepted" ? hub.isInMatch(f.id) : false
    }));
    return { friend_code: user.friend_code, friends: list };
  });
  route("POST", "/api/friends/request", (req, body) => {
    const user = authed(req);
    const code = String(body.code || "").trim().toUpperCase();
    const other = store.userByFriendCode(code);
    if (!other) throw new HttpError(404, "friend_code_not_found");
    const result = store.requestFriend(user.id, other.id);
    hub.notify(other.id, { t: "friend_update" });
    return { result, user: publicUser(other) };
  });
  route("POST", "/api/friends/respond", (req, body) => {
    const user = authed(req);
    store.respondFriend(user.id, Number(body.user_id), body.accept === true);
    hub.notify(Number(body.user_id), { t: "friend_update" });
    return { ok: true };
  });
  route("DELETE", "/api/friends/:id", (req, body, params) => {
    const user = authed(req);
    store.removeFriend(user.id, Number(params.id));
    hub.notify(Number(params.id), { t: "friend_update" });
    return { ok: true };
  });
  route("GET", "/api/leaderboard", (req, body, params, query) => {
    const user = authed(req);
    const board = ["rating", "winrate", "mode"].includes(query.get("board")) ? query.get("board") : "rating";
    const mode = query.get("mode") || "classic";
    if (board === "mode" && !VERIFIED_SINGLE.includes(mode)) throw new HttpError(400, "mode_not_ranked");
    const period = ["all", "week", "season"].includes(query.get("period")) ? query.get("period") : "all";
    const scope = query.get("scope") === "friends" ? "friends" : "global";
    return {
      board,
      mode,
      period,
      scope,
      generated_at: Date.now(),
      ...store.leaderboard({ board, mode, period, scope, userId: user.id, limit: 100 })
    };
  });
  route("GET", "/api/daily", (req) => {
    const user = authed(req);
    const date = dateKey(Date.now());
    return { date, seed: dailySeed(date), mode: "daily", server_time: Date.now(), ...store.dailyStatus(user.id, date) };
  });
  route("POST", "/api/runs/start", (req, body) => {
    const user = authed(req);
    const mode = String(body.mode || "");
    if (!VERIFIED_SINGLE.includes(mode)) throw new HttpError(400, "mode_not_verifiable");
    let seed = randomSeed();
    let dailyDate = null;
    if (mode === "daily") {
      dailyDate = dateKey(Date.now());
      seed = dailySeed(dailyDate);
    }
    const ticket = store.issueRunTicket(user.id, mode, seed, dailyDate);
    return { ticket, seed, mode, daily_date: dailyDate, issued_at: Date.now() };
  });
  route("POST", "/api/runs/submit", (req, body) => {
    const user = authed(req);
    const ticket = store.takeRunTicket(String(body.ticket || ""), user.id);
    if (!ticket) throw new HttpError(400, "invalid_or_used_ticket");
    const inputs = body.inputs;
    if (!Array.isArray(inputs) || inputs.length > 2e4) throw new HttpError(400, "bad_inputs");
    const endMs = Number.isInteger(body.end_ms) ? body.end_ms : null;
    let summary;
    try {
      summary = (isSpecial(ticket.mode) ? replaySpecial : replay)(ticket.mode, ticket.seed, inputs, endMs);
    } catch (err) {
      throw new HttpError(400, "bad_inputs");
    }
    if (summary.running) throw new HttpError(400, "run_not_finished");
    const wall = Date.now() - ticket.issued_at;
    if (summary.play_ms > wall + 2e3) throw new HttpError(400, "implausible_timing");
    const tooFast = inputs.filter((e, i) => i > 0 && e[1] === 1 && e[0] - inputs[i - 1][0] < 40).length;
    if (inputs.length > 50 && tooFast > inputs.length * 0.5) throw new HttpError(400, "implausible_inputs");
    const claimed = body.claimed || {};
    const saved = store.saveRun(user.id, ticket, summary);
    return {
      verified: true,
      score: summary.score,
      max_combo: summary.max_combo,
      accuracy: summary.accuracy,
      play_ms: summary.play_ms,
      claimed_matches: claimed.score === summary.score,
      ...saved
    };
  });
  route("GET", "/verify-email", (req, body, params, query) => {
    const userId = store.consumeEmailToken(query.get("token"), "verify");
    if (userId) store.setEmailVerified(userId);
    return { html: page(userId ? "\uC774\uBA54\uC77C \uC778\uC99D\uC774 \uC644\uB8CC\uB418\uC5C8\uC2B5\uB2C8\uB2E4. \uAC8C\uC784\uC73C\uB85C \uB3CC\uC544\uAC00\uC138\uC694." : "\uB9C1\uD06C\uAC00 \uB9CC\uB8CC\uB418\uC5C8\uAC70\uB098 \uC774\uBBF8 \uC0AC\uC6A9\uB418\uC5C8\uC2B5\uB2C8\uB2E4.") };
  });
  route("GET", "/reset-password", (req, body, params, query) => ({ html: resetPage(query.get("token") || "") }));
  return async function handle(req, res) {
    req.ip = clientIp(req, config.trustProxy);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    if (isProduction) res.setHeader("strict-transport-security", "max-age=31536000; includeSubDomains");
    let url;
    try {
      url = new URL(req.url, "http://local");
    } catch {
      return send(res, 400, { error: "bad_request" });
    }
    setCors(req, res);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (!generalLimiter.allow(`all:${req.ip}`)) return send(res, 429, { error: "too_many_requests" });
    for (const r of routes) {
      if (r.method !== req.method) continue;
      let params;
      try {
        params = match(r.path, url.pathname);
      } catch {
        return send(res, 400, { error: "bad_request" });
      }
      if (!params) continue;
      try {
        const body = ["POST", "PATCH", "DELETE"].includes(req.method) ? await readJson(req) : {};
        const out = await r.handler(req, body, params, url.searchParams);
        if (out && out.html) {
          res.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
          });
          res.end(out.html);
          return;
        }
        if (out && out.status && out.body) return send(res, out.status, out.body);
        return send(res, 200, out);
      } catch (err) {
        const status = err.status || 500;
        if (status === 500) console.error(err);
        return send(res, status, { error: status === 500 ? "server_error" : err.message });
      }
    }
    send(res, 404, { error: "not_found" });
  };
}
function match(pattern, path4) {
  const a = pattern.split("/"), b = path4.split("/");
  if (a.length !== b.length) return null;
  const params = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith(":")) params[a[i].slice(1)] = decodeURIComponent(b[i]);
    else if (a[i] !== b[i]) return null;
  }
  return params;
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, "body_too_large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        resolve(v && typeof v === "object" ? v : {});
      } catch {
        reject(new HttpError(400, "bad_json"));
      }
    });
    req.on("error", reject);
  });
}
function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}
function setCors(req, res) {
  const origin = req.headers.origin;
  const allowed = config.corsOrigins.includes("*") ? "*" : config.corsOrigins.includes(origin) ? origin : "";
  if (allowed) res.setHeader("access-control-allow-origin", allowed);
  res.setHeader("access-control-allow-headers", "authorization, content-type");
  res.setHeader("access-control-allow-methods", "GET, POST, PATCH, DELETE, OPTIONS");
}
var esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
var STYLE = "body{background:#050505;color:#F5F5F5;font-family:sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}main{max-width:360px;padding:24px;border:1px solid #242424}h1{font-size:20px}input,button{width:100%;box-sizing:border-box;padding:12px;margin:6px 0;background:#242424;color:#F5F5F5;border:1px solid #444}button{background:#F5F5F5;color:#050505;font-weight:bold}p{color:#777}";
var page = (msg) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>ONE COLOR</title><style>${STYLE}</style><main><h1>ONE COLOR</h1><p>${esc(msg)}</p></main>`;
var resetPage = (token) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>ONE COLOR</title><style>${STYLE}</style>
<main><h1>\uC0C8 \uBE44\uBC00\uBC88\uD638 \uC124\uC815</h1><p>\uC601\uBB38\uACFC \uC22B\uC790\uB97C \uD3EC\uD568\uD574 8\uC790 \uC774\uC0C1</p>
<input id="p" type="password" placeholder="\uC0C8 \uBE44\uBC00\uBC88\uD638"><input id="c" type="password" placeholder="\uBE44\uBC00\uBC88\uD638 \uD655\uC778">
<button id="b">\uBCC0\uACBD</button><p id="m"></p></main>
<script>document.getElementById('b').onclick=async()=>{const r=await fetch('/api/auth/password-reset/confirm',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:${JSON.stringify(token).replace(/</g, "\\u003c")},password:p.value,password_confirm:c.value})});const j=await r.json();m.textContent=r.ok?'\uBCC0\uACBD\uB418\uC5C8\uC2B5\uB2C8\uB2E4. \uAC8C\uC784\uC5D0\uC11C \uC0C8 \uBE44\uBC00\uBC88\uD638\uB85C \uB85C\uADF8\uC778\uD558\uC138\uC694.':'\uC2E4\uD328: '+j.error;};</script>`;

// src/realtime.js
import { WebSocketServer } from "ws";
var LAG_TOLERANCE_MS = 800;
var TICK_MS = 100;
var MATCHMAKING_MS = 500;
var AUTH_TIMEOUT_MS = 5e3;
function createHub({ store, server, clock = Date.now }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  const conns = /* @__PURE__ */ new Map();
  const queue = /* @__PURE__ */ new Map();
  const matches = /* @__PURE__ */ new Map();
  const userMatch = /* @__PURE__ */ new Map();
  const invites = /* @__PURE__ */ new Map();
  let inviteCounter = 0;
  let closing = false;
  const ipConns = /* @__PURE__ */ new Map();
  server.on("upgrade", (req, socket, head) => {
    let pathname = "";
    try {
      pathname = new URL(req.url, "http://x").pathname;
    } catch {
    }
    if (pathname !== "/ws") {
      socket.destroy();
      return;
    }
    const origin = req.headers.origin;
    if (origin && !config.corsOrigins.includes("*") && !config.corsOrigins.includes(origin)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    const ip = clientIp(req, config.trustProxy);
    if ((ipConns.get(ip) || 0) >= config.wsPerIp) {
      socket.write("HTTP/1.1 429 Too Many Requests\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req, ip));
  });
  wss.on("connection", (ws, req, ip = "?") => {
    ipConns.set(ip, (ipConns.get(ip) || 0) + 1);
    ws.on("close", () => {
      const n = (ipConns.get(ip) || 1) - 1;
      if (n <= 0) ipConns.delete(ip);
      else ipConns.set(ip, n);
    });
    const conn = { ws, userId: null, alive: true, limiter: new RateLimiter(40, 1e3) };
    const authTimer = setTimeout(() => {
      if (!conn.userId) ws.close(4001, "auth timeout");
    }, AUTH_TIMEOUT_MS);
    ws.on("pong", () => {
      conn.alive = true;
    });
    ws.on("message", (data) => {
      if (!conn.limiter.allow("m")) {
        send2(conn, { t: "error", code: "rate_limited" });
        return;
      }
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        send2(conn, { t: "error", code: "bad_json" });
        return;
      }
      if (!msg || typeof msg.t !== "string") {
        send2(conn, { t: "error", code: "bad_message" });
        return;
      }
      try {
        handle(conn, msg);
      } catch (err) {
        console.error("[ws]", err);
        send2(conn, { t: "error", code: "server_error" });
      }
    });
    ws.on("close", () => {
      clearTimeout(authTimer);
      onClose(conn);
    });
    send2(conn, { t: "hello", server_time: clock() });
  });
  const heartbeat = setInterval(() => {
    for (const set of conns.values()) for (const c of set) {
      if (!c.alive) {
        c.ws.terminate();
        continue;
      }
      c.alive = false;
      try {
        c.ws.ping();
      } catch {
      }
    }
  }, 15e3);
  const ticker = setInterval(tickMatches, TICK_MS);
  const matcher = setInterval(runMatchmaking, MATCHMAKING_MS);
  function send2(conn, msg) {
    if (conn.ws.readyState === 1) conn.ws.send(JSON.stringify(msg));
  }
  function sendUser(userId, msg) {
    for (const c of conns.get(userId) || []) send2(c, msg);
  }
  const isOnline = (id) => (conns.get(id)?.size || 0) > 0;
  function notifyFriendsPresence(userId, online) {
    for (const fid of store.friendIds(userId)) sendUser(fid, { t: "presence", user_id: userId, online });
  }
  function handle(conn, msg) {
    if (msg.t === "ping") {
      send2(conn, { t: "pong", server_time: clock(), echo: Number.isFinite(msg.echo) ? msg.echo : 0 });
      return;
    }
    if (msg.t === "auth") return onAuth(conn, msg);
    if (!conn.userId) {
      send2(conn, { t: "error", code: "unauthorized" });
      return;
    }
    const uid = conn.userId;
    switch (msg.t) {
      case "queue":
        return onQueue(uid, msg);
      case "cancel":
        return onCancel(uid);
      case "ready":
        return onReady(uid, msg);
      case "input":
        return onInput(uid, msg);
      case "invite":
        return onInvite(uid, msg);
      case "invite_reply":
        return onInviteReply(uid, msg);
      case "leave_match":
        return onLeave(uid, msg);
      default:
        send2(conn, { t: "error", code: "unknown_type" });
    }
  }
  function onAuth(conn, msg) {
    if (typeof msg.token !== "string" || msg.token.length > 200) {
      send2(conn, { t: "auth_failed" });
      conn.ws.close(4003, "bad token");
      return;
    }
    const user = store.userForToken(msg.token);
    if (!user) {
      send2(conn, { t: "auth_failed" });
      conn.ws.close(4003, "bad token");
      return;
    }
    if (conn.userId && conn.userId !== user.id) {
      send2(conn, { t: "auth_failed" });
      conn.ws.close(4003, "account switch");
      return;
    }
    if (config.requireEmailVerification && !user.email_verified) {
      send2(conn, { t: "auth_failed", reason: "email_not_verified" });
      conn.ws.close(4004, "unverified");
      return;
    }
    const already = conns.get(user.id);
    if (already && !already.has(conn) && already.size >= config.wsPerUser) {
      send2(conn, { t: "auth_failed", reason: "too_many_connections" });
      conn.ws.close(4005, "too many connections");
      return;
    }
    const wasOnline = isOnline(user.id);
    conn.userId = user.id;
    if (!conns.has(user.id)) conns.set(user.id, /* @__PURE__ */ new Set());
    conns.get(user.id).add(conn);
    store.touch(user.id);
    send2(conn, { t: "authed", user_id: user.id, server_time: clock() });
    if (!wasOnline) notifyFriendsPresence(user.id, true);
    const matchId = userMatch.get(user.id);
    if (matchId && matches.has(matchId)) resume(user.id, matches.get(matchId));
  }
  function onClose(conn) {
    if (!conn.userId || closing) return;
    const set = conns.get(conn.userId);
    set?.delete(conn);
    if (set && set.size === 0) {
      conns.delete(conn.userId);
      store.touch(conn.userId);
      queue.delete(conn.userId);
      notifyFriendsPresence(conn.userId, false);
      const matchId = userMatch.get(conn.userId);
      if (matchId && matches.has(matchId)) playerDisconnected(conn.userId, matches.get(matchId));
    }
  }
  function onQueue(uid, msg) {
    const mode = String(msg.mode || "");
    if (!ONLINE_MODES.includes(mode)) {
      sendUser(uid, { t: "error", code: "mode_unavailable" });
      return;
    }
    if (userMatch.has(uid)) {
      sendUser(uid, { t: "error", code: "already_in_match" });
      return;
    }
    const rating = store.ratingRow(uid).rating;
    queue.set(uid, { userId: uid, mode, rating, joinedAt: clock() });
    sendUser(uid, { t: "queue_state", state: "QUEUEING", mode });
  }
  function onCancel(uid) {
    if (queue.delete(uid)) {
      sendUser(uid, { t: "queue_state", state: "CANCELLED" });
      return;
    }
    sendUser(uid, { t: "queue_state", state: userMatch.has(uid) ? "MATCH_FOUND" : "IDLE" });
  }
  const ratingWindow = (entry, t) => Math.min(600, 100 + 50 * Math.floor((t - entry.joinedAt) / 5e3));
  function runMatchmaking() {
    const t = clock();
    const waiting = [...queue.values()].sort((a, b) => a.joinedAt - b.joinedAt);
    const taken = /* @__PURE__ */ new Set();
    for (const a of waiting) {
      if (taken.has(a.userId)) continue;
      let best = null;
      for (const b of waiting) {
        if (b.userId === a.userId || taken.has(b.userId) || b.mode !== a.mode) continue;
        const diff = Math.abs(a.rating - b.rating);
        if (diff > ratingWindow(a, t) || diff > ratingWindow(b, t)) continue;
        if (!best || diff < Math.abs(a.rating - best.rating)) best = b;
      }
      if (best) {
        taken.add(a.userId);
        taken.add(best.userId);
        queue.delete(a.userId);
        queue.delete(best.userId);
        createMatch(a.mode, "ranked", [a.userId, best.userId]);
      }
    }
  }
  function createMatch(mode, kind, userIds) {
    const seed = mode === "daily_duel" ? dailySeed(dateKey(clock())) : randomSeed();
    const row = store.createMatch({ mode, kind, seed, playerIds: userIds });
    const match2 = {
      id: row.id,
      mode,
      kind,
      seed,
      state: "MATCH_FOUND",
      createdAt: clock(),
      startAt: 0,
      endedAt: 0,
      players: userIds.map((uid, slot) => {
        const u = store.userById(uid);
        return {
          userId: uid,
          slot,
          name: u.display_name,
          icon: u.icon,
          equipped: { ...DEFAULT_EQUIPPED, ...JSON.parse(u.equipped || "{}") },
          rating: store.ratingRow(uid).rating,
          ready: false,
          connected: isOnline(uid),
          disconnectedAt: 0,
          session: null,
          seq: 0,
          lastInputSeq: 0,
          inputs: [],
          last: {}
        };
      })
    };
    matches.set(match2.id, match2);
    for (const p of match2.players) userMatch.set(p.userId, match2.id);
    for (const p of match2.players) {
      const opp = match2.players[1 - p.slot];
      sendUser(p.userId, {
        t: "match_found",
        match: match2.id,
        mode,
        kind,
        seed,
        slot: p.slot,
        opponent: { id: opp.userId, name: opp.name, icon: opp.icon, rating: opp.rating, equipped: opp.equipped },
        you: { rating: p.rating },
        ready_timeout_ms: config.matchReadyTimeoutMs
      });
    }
    match2.readyTimer = setTimeout(() => readyTimeout(match2), config.matchReadyTimeoutMs);
    return match2;
  }
  function onReady(uid, msg) {
    const match2 = matches.get(msg.match);
    if (!match2 || userMatch.get(uid) !== match2.id || match2.state !== "MATCH_FOUND") return;
    const p = match2.players.find((x) => x.userId === uid);
    p.ready = true;
    for (const q of match2.players) sendUser(q.userId, { t: "ready_state", match: match2.id, user_id: uid });
    if (match2.players.every((x) => x.ready)) {
      clearTimeout(match2.readyTimer);
      match2.state = "COUNTDOWN";
      match2.startAt = clock() + config.countdownMs;
      for (const q of match2.players) sendUser(q.userId, { t: "countdown", match: match2.id, start_at: match2.startAt, server_time: clock() });
      match2.startTimer = setTimeout(() => startMatch(match2), config.countdownMs);
    }
  }
  function readyTimeout(match2) {
    if (match2.state !== "MATCH_FOUND") return;
    cancelMatch(match2, "not_ready", (p) => p.ready);
  }
  function cancelMatch(match2, reason, requeue = () => false) {
    match2.state = "CANCELLED";
    clearTimeout(match2.readyTimer);
    clearTimeout(match2.startTimer);
    store.setMatchStatus(match2.id, "cancelled", { endedAt: clock(), reason });
    for (const p of match2.players) {
      userMatch.delete(p.userId);
      const back = requeue(p) && isOnline(p.userId) && match2.kind === "ranked";
      sendUser(p.userId, { t: "match_cancelled", match: match2.id, reason, requeued: back });
      if (back) onQueue(p.userId, { mode: match2.mode });
    }
    matches.delete(match2.id);
  }
  function startMatch(match2) {
    if (match2.state !== "COUNTDOWN") return;
    if (!match2.players.every((p) => isOnline(p.userId))) {
      cancelMatch(match2, "opponent_left", (p) => isOnline(p.userId));
      return;
    }
    match2.state = "PLAYING";
    store.setMatchStatus(match2.id, "active", { startedAt: match2.startAt });
    for (const p of match2.players) sendUser(p.userId, { t: "start", match: match2.id, start_at: match2.startAt, server_time: clock() });
    for (const p of match2.players) {
      p.session = new GameSession(match2.mode, { onEvent: (e) => relay(match2, p, e) });
      p.session.start(match2.seed);
    }
  }
  function relay(match2, p, e) {
    p.seq += 1;
    if (e.type === "round") p.last.round = e;
    p.last.score = e.score ?? p.last.score;
    p.last.combo = e.combo ?? p.last.combo;
    if (e.type === "color") p.last.step = e.step;
    const opp = match2.players[1 - p.slot];
    sendUser(p.userId, { t: "ev", match: match2.id, who: "you", seq: p.seq, input_seq: p.lastInputSeq, e });
    sendUser(opp.userId, { t: "ev", match: match2.id, who: "opp", seq: p.seq, e });
  }
  function elapsed(match2) {
    return clock() - match2.startAt;
  }
  function onInput(uid, msg) {
    const match2 = matches.get(msg.match);
    if (!match2 || userMatch.get(uid) !== match2.id) {
      sendUser(uid, { t: "input_rejected", reason: "not_in_match", seq: msg.seq });
      return;
    }
    if (match2.state !== "PLAYING") {
      sendUser(uid, { t: "input_rejected", reason: "match_not_running", seq: msg.seq });
      return;
    }
    const p = match2.players.find((x) => x.userId === uid);
    if (!Number.isInteger(msg.seq) || msg.seq <= p.lastInputSeq) return;
    if (!p.session.running) {
      sendUser(uid, { t: "input_rejected", reason: "session_over", seq: msg.seq });
      return;
    }
    if (![InputCode.CHANGE_COLOR, InputCode.SELECT_TILE].includes(msg.code)) {
      sendUser(uid, { t: "input_rejected", reason: "bad_code", seq: msg.seq });
      return;
    }
    const now2 = elapsed(match2);
    const claimed = Number.isInteger(msg.ms) ? msg.ms : now2;
    const ms = Math.max(p.session.playMs, now2 - LAG_TOLERANCE_MS, Math.min(claimed, now2 + 50));
    p.lastInputSeq = msg.seq;
    p.session.advanceTo(ms);
    if (!p.session.running) {
      checkEnd(match2);
      return;
    }
    p.inputs.push([p.session.playMs, msg.code, msg.code === InputCode.SELECT_TILE ? msg.arg : 0]);
    if (msg.code === InputCode.CHANGE_COLOR) p.session.changeColor();
    else p.session.selectTile(msg.arg);
    checkEnd(match2);
  }
  function tickMatches() {
    for (const match2 of matches.values()) {
      if (match2.state !== "PLAYING") continue;
      const target = elapsed(match2) - LAG_TOLERANCE_MS;
      for (const p of match2.players) if (p.session.running && target > p.session.playMs) p.session.advanceTo(target);
      const gone = match2.players.filter((p) => !isOnline(p.userId) && p.disconnectedAt && clock() - p.disconnectedAt > config.reconnectGraceMs);
      if (gone.length === 2) {
        abortMatch(match2, "both_disconnected");
        continue;
      }
      if (gone.length === 1) {
        finishMatch(match2, "forfeit", gone[0].userId);
        continue;
      }
      checkEnd(match2);
    }
  }
  function checkEnd(match2) {
    if (match2.state !== "PLAYING") return;
    const running = match2.players.filter((p) => p.session.running);
    if (match2.mode === "survival_duel" && running.length === 1) {
      const survivor = running[0];
      const fallen = match2.players.find((p) => p !== survivor);
      if (survivor.session.playMs < fallen.session.playMs) survivor.session.advanceTo(fallen.session.playMs);
      if (survivor.session.running) {
        survivor.session.end(3);
        finishMatch(match2, "survivor", null, survivor.userId);
      } else {
        finishMatch(match2, "time_up");
      }
      return;
    }
    if (running.length === 0) finishMatch(match2, "time_up");
  }
  function outcomes(match2, forfeitUserId, winnerUserId) {
    const [a, b] = match2.players.map((p) => p.session.summary());
    if (forfeitUserId) return match2.players.map((p) => p.userId === forfeitUserId ? "loss" : "win");
    if (winnerUserId) return match2.players.map((p) => p.userId === winnerUserId ? "win" : "loss");
    let cmp;
    if (match2.mode === "combo_battle") cmp = a.max_combo - b.max_combo || a.score - b.score;
    else if (match2.mode === "survival_duel") cmp = a.play_ms - b.play_ms || a.score - b.score;
    else cmp = a.score - b.score;
    if (cmp > 0) return ["win", "loss"];
    if (cmp < 0) return ["loss", "win"];
    return ["draw", "draw"];
  }
  function finishMatch(match2, reason, forfeitUserId = null, winnerUserId = null) {
    if (match2.state !== "PLAYING") return;
    match2.state = "RESULT";
    for (const p of match2.players) if (p.session.running) p.session.end(3);
    const result = outcomes(match2, forfeitUserId, winnerUserId);
    const rows = match2.players.map((p, i) => ({ userId: p.userId, outcome: result[i], ...p.session.summary() }));
    const applied = store.applyMatchResult(match2.id, rows, reason) || {};
    for (const p of match2.players) {
      const opp = match2.players[1 - p.slot];
      const mine = rows[p.slot], theirs = rows[opp.slot];
      sendUser(p.userId, {
        t: "result",
        match: match2.id,
        mode: match2.mode,
        kind: match2.kind,
        reason,
        outcome: mine.outcome,
        you: pick(mine),
        opponent: { ...pick(theirs), name: opp.name },
        rating: applied[p.userId] ? { before: applied[p.userId].before, after: applied[p.userId].after, change: applied[p.userId].change } : null,
        achievements: applied[p.userId]?.achievements || []
      });
      userMatch.delete(p.userId);
    }
    matches.delete(match2.id);
  }
  const pick = (s) => ({ score: s.score, max_combo: s.max_combo, correct: s.correct, wrong: s.wrong, play_ms: s.play_ms, lives_left: s.lives_left });
  function abortMatch(match2, reason) {
    match2.state = "CANCELLED";
    store.setMatchStatus(match2.id, "aborted", { endedAt: clock(), reason });
    for (const p of match2.players) {
      userMatch.delete(p.userId);
      sendUser(p.userId, { t: "match_cancelled", match: match2.id, reason, requeued: false });
    }
    matches.delete(match2.id);
  }
  function onLeave(uid, msg) {
    const match2 = matches.get(msg.match);
    if (!match2 || userMatch.get(uid) !== match2.id) return;
    if (match2.state === "PLAYING") finishMatch(match2, "forfeit", uid);
    else cancelMatch(match2, "opponent_left", (p) => p.userId !== uid);
  }
  function playerDisconnected(uid, match2) {
    const p = match2.players.find((x) => x.userId === uid);
    if (match2.state === "MATCH_FOUND" || match2.state === "COUNTDOWN") {
      cancelMatch(match2, "opponent_left", (q) => q.userId !== uid);
      return;
    }
    if (match2.state !== "PLAYING") return;
    p.disconnectedAt = clock();
    const opp = match2.players[1 - p.slot];
    sendUser(opp.userId, { t: "opp_connection", match: match2.id, connected: false, grace_ms: config.reconnectGraceMs });
  }
  function resume(uid, match2) {
    const p = match2.players.find((x) => x.userId === uid);
    p.disconnectedAt = 0;
    const opp = match2.players[1 - p.slot];
    sendUser(opp.userId, { t: "opp_connection", match: match2.id, connected: true });
    sendUser(uid, {
      t: "resume",
      match: match2.id,
      mode: match2.mode,
      kind: match2.kind,
      seed: match2.seed,
      state: match2.state,
      start_at: match2.startAt,
      server_time: clock(),
      slot: p.slot,
      opponent: { id: opp.userId, name: opp.name, icon: opp.icon, rating: opp.rating, equipped: opp.equipped },
      you: p.session ? { inputs: p.inputs, input_seq: p.lastInputSeq, seq: p.seq, summary: p.session.summary() } : null,
      opponent_state: opp.session ? {
        seq: opp.seq,
        round: opp.last.round || null,
        score: opp.last.score || 0,
        combo: opp.last.combo || 0,
        step: opp.last.step ?? null,
        summary: opp.session.summary()
      } : null
    });
  }
  function onInvite(uid, msg) {
    const friendId = Number(msg.friend_id);
    const mode = ONLINE_MODES.includes(msg.mode) ? msg.mode : "score_race";
    if (!store.areFriends(uid, friendId)) {
      sendUser(uid, { t: "invite_result", status: "not_friends" });
      return;
    }
    if (!isOnline(friendId)) {
      sendUser(uid, { t: "invite_result", status: "friend_offline" });
      return;
    }
    if (userMatch.has(friendId) || queue.has(friendId)) {
      sendUser(uid, { t: "invite_result", status: "friend_busy" });
      return;
    }
    if (userMatch.has(uid)) {
      sendUser(uid, { t: "invite_result", status: "you_are_busy" });
      return;
    }
    const id = `inv${++inviteCounter}`;
    const invite = { id, from: uid, to: friendId, mode, expires: clock() + config.inviteTtlMs };
    invites.set(id, invite);
    invite.timer = setTimeout(() => {
      if (invites.delete(id)) sendUser(uid, { t: "invite_result", invite_id: id, status: "expired" });
    }, config.inviteTtlMs);
    const from = store.userById(uid);
    sendUser(friendId, { t: "invite_received", invite_id: id, mode, from: { id: uid, name: from.display_name, icon: from.icon } });
    sendUser(uid, { t: "invite_result", invite_id: id, status: "sent" });
  }
  function onInviteReply(uid, msg) {
    const invite = invites.get(msg.invite_id);
    if (!invite || invite.to !== uid) {
      sendUser(uid, { t: "error", code: "invite_not_found" });
      return;
    }
    invites.delete(invite.id);
    clearTimeout(invite.timer);
    if (msg.accept !== true) {
      sendUser(invite.from, { t: "invite_result", invite_id: invite.id, status: "declined" });
      return;
    }
    if (!isOnline(invite.from) || userMatch.has(invite.from) || userMatch.has(uid)) {
      sendUser(uid, { t: "invite_result", invite_id: invite.id, status: "unavailable" });
      return;
    }
    queue.delete(uid);
    queue.delete(invite.from);
    sendUser(invite.from, { t: "invite_result", invite_id: invite.id, status: "accepted" });
    createMatch(invite.mode, "friend", [invite.from, uid]);
  }
  return {
    isOnline,
    isInMatch: (id) => userMatch.has(id),
    notify: sendUser,
    disconnectUser(userId) {
      for (const c of conns.get(userId) || []) c.ws.close(4005, "account deleted");
    },
    stats: () => ({ online: conns.size, queue: queue.size, matches: matches.size }),
    close() {
      closing = true;
      clearInterval(heartbeat);
      clearInterval(ticker);
      clearInterval(matcher);
      for (const m of matches.values()) {
        clearTimeout(m.readyTimer);
        clearTimeout(m.startTimer);
      }
      for (const inv of invites.values()) clearTimeout(inv.timer);
      for (const set of conns.values()) for (const c of set) c.ws.terminate();
      wss.close();
    }
  };
}

// src/index.js
var MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".wasm": "application/wasm",
  ".pck": "application/octet-stream",
  ".png": "image/png",
  ".json": "application/json",
  ".txt": "text/plain",
  ".md": "text/plain"
};
function startServer(overrides = {}) {
  Object.assign(config, overrides);
  const db = openDb(config.dbPath);
  const store = new Store(db);
  store.currentSeason();
  const server = http.createServer();
  const hub = createHub({ store, server });
  const api = createApi({ store, hub });
  const webDir = process.env.WEB_DIR ? path3.resolve(process.env.WEB_DIR) : null;
  server.on("request", (req, res) => {
    const url = new URL(req.url, "http://x");
    if (webDir && req.method === "GET" && !url.pathname.startsWith("/api/") && !["/verify-email", "/reset-password"].includes(url.pathname)) {
      const file = path3.join(webDir, url.pathname === "/" ? "index.html" : path3.normalize(url.pathname));
      if (file.startsWith(webDir) && fs3.existsSync(file) && fs3.statSync(file).isFile()) {
        res.writeHead(200, { "content-type": MIME[path3.extname(file)] || "application/octet-stream" });
        fs3.createReadStream(file).pipe(res);
        return;
      }
    }
    api(req, res);
  });
  const seasonTimer = setInterval(() => {
    const s = store.currentSeason();
    if (s.ends_at < Date.now()) console.log("[season] rollover", store.rolloverSeason());
  }, 3600 * 1e3);
  return new Promise((resolve) => {
    server.listen(config.port, config.host, () => {
      const port = server.address().port;
      console.log(`[onecolor] listening on ${config.host}:${port} (db ${config.dbPath}, mail ${mailConfigured() ? "SMTP" : "NOT configured"})`);
      resolve({
        server,
        store,
        hub,
        port,
        close: () => new Promise((r) => {
          clearInterval(seasonTimer);
          hub.close();
          server.close(() => {
            db.close();
            r();
          });
        })
      });
    });
  });
}
if (import.meta.url === `file://${process.argv[1]}`) {
  startServer();
}
export {
  startServer
};
