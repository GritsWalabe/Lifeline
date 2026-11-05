// Lifeline server: accounts, timeline storage, photos, share links and the Claude review of Facebook posts.
import express from "express";
import pg from "pg";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import net from "node:net";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const PHOTO_DIR = path.join(DATA_DIR, "photos");
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-haiku-5-5";
const REVIEW_DAILY_LIMIT = +(process.env.REVIEW_DAILY_LIMIT || 50); // batches of up to 60 posts per person per day
const SESSION_DAYS = 60;

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set. On Railway, add a Postgres database to the project and reference its DATABASE_URL.");
  process.exit(1);
}
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "1" ? { rejectUnauthorized: false } : undefined,
  max: 10,
});
const q = (text, params) => pool.query(text, params);

async function migrate() {
  await q(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      pass TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      ai_day DATE,
      ai_count INT NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
    CREATE TABLE IF NOT EXISTS tlines (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      doc JSONB NOT NULL,
      version INT NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      share_token TEXT UNIQUE,
      share_on BOOLEAN NOT NULL DEFAULT false
    );
    CREATE INDEX IF NOT EXISTS tlines_user ON tlines(user_id);
    CREATE TABLE IF NOT EXISTS photos (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      mime TEXT NOT NULL,
      bytes INT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, id)
    );
  `);
  // Earlier versions kept one timeline per account in "timelines". Copy each into the new table once,
  // then keep the old table as a backup under a new name.
  const old = await q(`SELECT to_regclass('public.timelines') AS t`);
  if (old.rows[0].t) {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(`
        INSERT INTO tlines(id,user_id,doc,version,created_at,updated_at,share_token,share_on)
        SELECT 't' || substr(md5(user_id || clock_timestamp()::text || random()::text), 1, 18),
               user_id, doc, version, updated_at, updated_at, share_token, share_on
        FROM timelines o WHERE NOT EXISTS (SELECT 1 FROM tlines n WHERE n.user_id = o.user_id)`);
      await c.query(`ALTER TABLE timelines RENAME TO timelines_v1_backup`);
      await c.query("COMMIT");
      console.log("Moved single timelines into the multi-timeline table.");
    } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
  }
  // Share links: several per timeline (one per person or group), each with its own visit log
  await q(`
    CREATE TABLE IF NOT EXISTS share_links (
      token TEXT PRIMARY KEY,
      timeline_id TEXT NOT NULL REFERENCES tlines(id) ON DELETE CASCADE,
      label TEXT NOT NULL DEFAULT '',
      active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS share_links_tl ON share_links(timeline_id);
    CREATE TABLE IF NOT EXISTS visits (
      id BIGSERIAL PRIMARY KEY,
      token TEXT NOT NULL REFERENCES share_links(token) ON DELETE CASCADE,
      vid TEXT NOT NULL,
      first_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      device TEXT NOT NULL DEFAULT '',
      views INT NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS visits_token ON visits(token, vid, last_at DESC);
  `);
  // Earlier single share links become a link named "Everyone" (once; the old column is then cleared)
  const c2 = await pool.connect();
  try {
    await c2.query("BEGIN");
    await c2.query(`INSERT INTO share_links(token,timeline_id,label,active)
      SELECT share_token, id, 'Everyone', share_on FROM tlines WHERE share_token IS NOT NULL ON CONFLICT (token) DO NOTHING`);
    await c2.query(`UPDATE tlines SET share_token=NULL, share_on=false WHERE share_token IS NOT NULL`);
    await c2.query("COMMIT");
  } catch (e) { await c2.query("ROLLBACK"); throw e; } finally { c2.release(); }
}

/* ---------- Helpers ---------- */
const rid = (n = 16) => crypto.randomBytes(n).toString("base64url");
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHOTO_ID_RE = /^p[a-z0-9]{8,40}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{10,64}$/;
const TL_RE = /^t[a-z0-9]{8,40}$/;
const MAX_TIMELINES = +(process.env.MAX_TIMELINES || 50);
const newTimelineId = () => "t" + crypto.randomBytes(10).toString("hex");
function cleanColorNames(m) {
  const out = {};
  if (m && typeof m === "object") for (const [k, v] of Object.entries(m).slice(0, 60)) {
    if (/^#[0-9A-Fa-f]{6}$/.test(k) && typeof v === "string" && v.trim()) out[k.toUpperCase()] = v.trim().slice(0, 60);
  }
  return out;
}
function cleanDoc(doc) {
  return { name: String(doc?.name || "").slice(0, 200), entries: Array.isArray(doc?.entries) ? doc.entries : [], eras: Array.isArray(doc?.eras) ? doc.eras : [], colorNames: cleanColorNames(doc?.colorNames) };
}
const photoIdsOf = (doc) => (doc?.entries || []).flatMap((e) => (Array.isArray(e.photos) ? e.photos : [])).filter((p) => PHOTO_ID_RE.test(p));

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}
function checkPassword(pw, stored) {
  const [kind, saltHex, hashHex] = String(stored).split("$");
  if (kind !== "scrypt") return false;
  const hash = crypto.scryptSync(pw, Buffer.from(saltHex, "hex"), 64);
  const want = Buffer.from(hashHex, "hex");
  return want.length === hash.length && crypto.timingSafeEqual(hash, want);
}
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || "").split(";").forEach((p) => {
    const i = p.indexOf("=");
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function setSessionCookie(req, res, token, maxAgeSec) {
  const secure = req.secure ? "; Secure" : "";
  res.setHeader("Set-Cookie", `ll_sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`);
}
async function startSession(req, res, userId) {
  const token = rid(32);
  await q(`INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '${SESSION_DAYS} days')`, [sha(token), userId]);
  setSessionCookie(req, res, token, SESSION_DAYS * 86400);
}
function userDir(userId) { return path.join(PHOTO_DIR, userId.replace(/[^A-Za-z0-9_-]/g, "")); }

// Simple in-memory limiter for sign-in attempts
const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  const h = (hits.get(key) || []).filter((t) => now - t < windowMs);
  h.push(now); hits.set(key, h);
  return h.length > max;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some((t) => now - t < 3600e3)) hits.delete(k); }, 600e3).unref();

/* ---------- App ---------- */
const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("X-Frame-Options", "DENY");
  next();
});

// Every request that changes data must carry this header. Other sites can't add it without permission,
// which keeps them from acting on a signed-in person's behalf.
app.use("/api", (req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD" && req.get("X-Lifeline") !== "1") return res.status(403).json({ error: "Missing request header." });
  next();
});

// Who is signed in
app.use(async (req, res, next) => {
  req.user = null;
  const t = parseCookies(req).ll_sid;
  if (t && t.length < 100) {
    try {
      const r = await q(`SELECT u.id, u.email FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now()`, [sha(t)]);
      if (r.rows[0]) req.user = r.rows[0];
    } catch (e) { return next(e); }
  }
  next();
});
const needUser = (req, res, next) => (req.user ? next() : res.status(401).json({ error: "Please sign in." }));

app.get("/healthz", (req, res) => res.send("ok"));

/* ---------- Accounts ---------- */
app.get("/api/me", (req, res) => {
  res.json({ user: req.user ? { id: req.user.id, email: req.user.email } : null, ai: !!ANTHROPIC_API_KEY });
});

app.post("/api/signup", express.json({ limit: "10kb" }), async (req, res) => {
  if (limited("auth:" + req.ip, 20, 15 * 60e3)) return res.status(429).json({ error: "Too many attempts. Wait a few minutes and try again." });
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  if (!EMAIL_RE.test(email) || email.length > 200) return res.status(400).json({ error: "Enter a valid email address." });
  if (password.length < 8) return res.status(400).json({ error: "Use a password of at least 8 characters." });
  if (password.length > 200) return res.status(400).json({ error: "That password is too long." });
  const id = "u" + rid(12).replace(/[^A-Za-z0-9]/g, "").toLowerCase().slice(0, 14) + crypto.randomInt(1e6);
  try {
    await q(`INSERT INTO users(id,email,pass) VALUES($1,$2,$3)`, [id, email, hashPassword(password)]);
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "An account with that email already exists. Sign in instead." });
    throw e;
  }
  await startSession(req, res, id);
  res.json({ user: { id, email } });
});

app.post("/api/login", express.json({ limit: "10kb" }), async (req, res) => {
  if (limited("auth:" + req.ip, 20, 15 * 60e3)) return res.status(429).json({ error: "Too many attempts. Wait a few minutes and try again." });
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  const r = await q(`SELECT id, email, pass FROM users WHERE email=$1`, [email]);
  const u = r.rows[0];
  if (!u || !checkPassword(password, u.pass)) return res.status(401).json({ error: "That email and password don't match." });
  await startSession(req, res, u.id);
  res.json({ user: { id: u.id, email: u.email } });
});

app.post("/api/logout", async (req, res) => {
  const t = parseCookies(req).ll_sid;
  if (t) await q(`DELETE FROM sessions WHERE token_hash=$1`, [sha(t)]);
  setSessionCookie(req, res, "", 0);
  res.json({ ok: true });
});

app.post("/api/password", needUser, express.json({ limit: "10kb" }), async (req, res) => {
  const { current, next: nextPw } = req.body || {};
  const r = await q(`SELECT pass FROM users WHERE id=$1`, [req.user.id]);
  if (!checkPassword(String(current || ""), r.rows[0].pass)) return res.status(401).json({ error: "Your current password isn't right." });
  if (String(nextPw || "").length < 8) return res.status(400).json({ error: "Use a new password of at least 8 characters." });
  await q(`UPDATE users SET pass=$1 WHERE id=$2`, [hashPassword(String(nextPw)), req.user.id]);
  await q(`DELETE FROM sessions WHERE user_id=$1`, [req.user.id]);
  await startSession(req, res, req.user.id);
  res.json({ ok: true });
});

app.delete("/api/account", needUser, express.json({ limit: "10kb" }), async (req, res) => {
  const r = await q(`SELECT pass FROM users WHERE id=$1`, [req.user.id]);
  if (!checkPassword(String(req.body?.password || ""), r.rows[0].pass)) return res.status(401).json({ error: "That password isn't right." });
  await q(`DELETE FROM users WHERE id=$1`, [req.user.id]); // sessions, timeline and photo records go with it
  await fsp.rm(userDir(req.user.id), { recursive: true, force: true });
  setSessionCookie(req, res, "", 0);
  res.json({ ok: true });
});

/* ---------- Timelines (an account can have many) ---------- */
async function ownTimeline(req, res) {
  const id = req.params.id;
  if (!TL_RE.test(id)) { res.status(404).json({ error: "That timeline doesn't exist." }); return null; }
  const r = await q(`SELECT id, doc, version, share_token, share_on FROM tlines WHERE id=$1 AND user_id=$2`, [id, req.user.id]);
  if (!r.rows[0]) { res.status(404).json({ error: "That timeline doesn't exist or was deleted." }); return null; }
  return r.rows[0];
}

app.get("/api/timelines", needUser, async (req, res) => {
  const r = await q(
    `SELECT id, doc->>'name' AS name, jsonb_array_length(COALESCE(doc->'entries','[]'::jsonb)) AS count,
            EXISTS (SELECT 1 FROM share_links l WHERE l.timeline_id=tlines.id AND l.active) AS share_on, updated_at, created_at
     FROM tlines WHERE user_id=$1 ORDER BY created_at`, [req.user.id]);
  res.json({ timelines: r.rows.map((t) => ({ id: t.id, name: t.name || "", count: t.count, shared: t.share_on, updated: t.updated_at })) });
});

app.post("/api/timelines", needUser, express.json({ limit: "25mb" }), async (req, res) => {
  const n = await q(`SELECT count(*)::int AS n FROM tlines WHERE user_id=$1`, [req.user.id]);
  if (n.rows[0].n >= MAX_TIMELINES) return res.status(400).json({ error: `You can have up to ${MAX_TIMELINES} timelines. Delete one you no longer need first.` });
  const id = newTimelineId();
  await q(`INSERT INTO tlines(id,user_id,doc) VALUES($1,$2,$3)`, [id, req.user.id, cleanDoc(req.body?.doc)]);
  res.json({ id, version: 1 });
});

app.get("/api/timelines/:id", needUser, async (req, res) => {
  const t = await ownTimeline(req, res); if (!t) return;
  res.json({ id: t.id, doc: t.doc, version: t.version, share: { on: t.share_on, token: t.share_on ? t.share_token : null } });
});

// Saves a whole timeline. "version" must match what the page last loaded, so an older copy open
// on another device can't silently overwrite newer changes.
app.put("/api/timelines/:id", needUser, express.json({ limit: "25mb" }), async (req, res) => {
  if (!TL_RE.test(req.params.id)) return res.status(404).json({ error: "That timeline doesn't exist." });
  const { doc, version } = req.body || {};
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.entries)) return res.status(400).json({ error: "Timeline data is missing." });
  const r = await q(
    `UPDATE tlines SET doc=$3, version=version+1, updated_at=now() WHERE id=$1 AND user_id=$2 AND version=$4 RETURNING version`,
    [req.params.id, req.user.id, cleanDoc(doc), +version || 0]);
  if (r.rows[0]) return res.json({ version: r.rows[0].version });
  const cur = await q(`SELECT doc, version FROM tlines WHERE id=$1 AND user_id=$2`, [req.params.id, req.user.id]);
  if (!cur.rows[0]) return res.status(404).json({ error: "That timeline was deleted." });
  res.status(409).json({ error: "This timeline was changed on another device.", doc: cur.rows[0].doc, version: cur.rows[0].version });
});

app.delete("/api/timelines/:id", needUser, async (req, res) => {
  const t = await ownTimeline(req, res); if (!t) return;
  await q(`DELETE FROM tlines WHERE id=$1 AND user_id=$2`, [t.id, req.user.id]);
  // Remove this timeline's photos unless another of the person's timelines still uses them
  const others = await q(`SELECT doc FROM tlines WHERE user_id=$1`, [req.user.id]);
  const keep = new Set(others.rows.flatMap((r) => photoIdsOf(r.doc)));
  for (const pid of photoIdsOf(t.doc)) {
    if (keep.has(pid)) continue;
    await q(`DELETE FROM photos WHERE user_id=$1 AND id=$2`, [req.user.id, pid]);
    await fsp.rm(path.join(userDir(req.user.id), pid), { force: true });
  }
  res.json({ ok: true });
});

// Moves events (with their photos) from one of the person's timelines to another, in one step
app.post("/api/timelines/:id/move", needUser, express.json({ limit: "100kb" }), async (req, res) => {
  const from = req.params.id, to = String(req.body?.to || "");
  const ids = new Set((Array.isArray(req.body?.ids) ? req.body.ids : []).map(String));
  if (!TL_RE.test(from) || !TL_RE.test(to) || from === to || !ids.size) return res.status(400).json({ error: "Choose a different timeline to move to." });
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const r = await c.query(`SELECT id, doc FROM tlines WHERE user_id=$1 AND id = ANY($2) ORDER BY id FOR UPDATE`, [req.user.id, [from, to]]);
    const src = r.rows.find((x) => x.id === from), dst = r.rows.find((x) => x.id === to);
    if (!src || !dst) { await c.query("ROLLBACK"); return res.status(404).json({ error: "One of those timelines no longer exists." }); }
    const moving = src.doc.entries.filter((e) => ids.has(String(e.id)));
    if (!moving.length) { await c.query("ROLLBACK"); return res.status(400).json({ error: "Those events are no longer on this timeline." }); }
    const taken = new Set(dst.doc.entries.map((e) => String(e.id)));
    moving.forEach((e) => { if (taken.has(String(e.id))) e.id = crypto.randomBytes(5).toString("hex"); });
    const srcDoc = { ...src.doc, entries: src.doc.entries.filter((e) => !ids.has(String(e.id))) };
    const dstDoc = { ...dst.doc, entries: [...dst.doc.entries, ...moving] };
    const a = await c.query(`UPDATE tlines SET doc=$2, version=version+1, updated_at=now() WHERE id=$1 RETURNING version`, [from, srcDoc]);
    await c.query(`UPDATE tlines SET doc=$2, version=version+1, updated_at=now() WHERE id=$1`, [to, dstDoc]);
    await c.query("COMMIT");
    res.json({ moved: moving.length, version: a.rows[0].version, doc: srcDoc });
  } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
});

/* ---------- Photos ---------- */
app.put("/api/photos/:id", needUser, express.raw({ type: ["image/*"], limit: "15mb" }), async (req, res) => {
  const id = req.params.id;
  if (!PHOTO_ID_RE.test(id)) return res.status(400).json({ error: "Bad photo id." });
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: "Send the photo as an image." });
  const mime = String(req.get("content-type") || "").split(";")[0];
  if (!/^image\/(jpeg|png|gif|webp)$/.test(mime)) return res.status(415).json({ error: "Photos must be JPEG, PNG, GIF or WebP." });
  const dir = userDir(req.user.id);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, id), req.body);
  await q(`INSERT INTO photos(user_id,id,mime,bytes) VALUES($1,$2,$3,$4) ON CONFLICT (user_id,id) DO UPDATE SET mime=$3, bytes=$4`, [req.user.id, id, mime, req.body.length]);
  res.json({ ok: true });
});

async function sendPhoto(res, userId, id) {
  if (!PHOTO_ID_RE.test(id)) return res.status(404).end();
  const r = await q(`SELECT mime FROM photos WHERE user_id=$1 AND id=$2`, [userId, id]);
  if (!r.rows[0]) return res.status(404).end();
  const file = path.join(userDir(userId), id);
  if (!fs.existsSync(file)) return res.status(404).end();
  res.setHeader("Content-Type", r.rows[0].mime);
  res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
  fs.createReadStream(file).pipe(res);
}
app.get("/api/photos/:id", needUser, (req, res, next) => sendPhoto(res, req.user.id, req.params.id).catch(next));
app.delete("/api/photos/:id", needUser, async (req, res) => {
  const id = req.params.id;
  if (!PHOTO_ID_RE.test(id)) return res.status(400).json({ error: "Bad photo id." });
  await q(`DELETE FROM photos WHERE user_id=$1 AND id=$2`, [req.user.id, id]);
  await fsp.rm(path.join(userDir(req.user.id), id), { force: true });
  res.json({ ok: true });
});

/* ---------- Sharing: named links per timeline, and who opened them ---------- */
const LABEL_MAX = 60;
async function linksFor(timelineId) {
  const r = await q(`
    SELECT l.token, l.label, l.active, l.created_at,
           COUNT(v.id)::int AS views, COUNT(DISTINCT v.vid)::int AS people, MAX(v.last_at) AS last
    FROM share_links l LEFT JOIN visits v ON v.token = l.token
    WHERE l.timeline_id=$1 GROUP BY l.token ORDER BY l.created_at`, [timelineId]);
  return r.rows.map((x) => ({ token: x.token, label: x.label, active: x.active, created: x.created_at, views: x.views, people: x.people, last: x.last }));
}
app.get("/api/timelines/:id/links", needUser, async (req, res) => {
  const t = await ownTimeline(req, res); if (!t) return;
  res.json({ links: await linksFor(t.id) });
});
app.post("/api/timelines/:id/links", needUser, express.json({ limit: "10kb" }), async (req, res) => {
  const t = await ownTimeline(req, res); if (!t) return;
  const label = String(req.body?.label || "").trim().slice(0, LABEL_MAX) || "Everyone";
  const n = await q(`SELECT count(*)::int AS n FROM share_links WHERE timeline_id=$1`, [t.id]);
  if (n.rows[0].n >= 100) return res.status(400).json({ error: "This timeline already has 100 links. Delete some you no longer use." });
  const token = rid(12);
  await q(`INSERT INTO share_links(token,timeline_id,label) VALUES($1,$2,$3)`, [token, t.id, label]);
  res.json({ links: await linksFor(t.id), token });
});
app.patch("/api/timelines/:id/links/:token", needUser, express.json({ limit: "10kb" }), async (req, res) => {
  const t = await ownTimeline(req, res); if (!t) return;
  const sets = [], vals = [req.params.token, t.id];
  if (typeof req.body?.active === "boolean") { vals.push(req.body.active); sets.push(`active=$${vals.length}`); }
  if (typeof req.body?.label === "string") { vals.push(req.body.label.trim().slice(0, LABEL_MAX) || "Everyone"); sets.push(`label=$${vals.length}`); }
  if (sets.length) await q(`UPDATE share_links SET ${sets.join(",")} WHERE token=$1 AND timeline_id=$2`, vals);
  res.json({ links: await linksFor(t.id) });
});
app.delete("/api/timelines/:id/links/:token", needUser, async (req, res) => {
  const t = await ownTimeline(req, res); if (!t) return;
  await q(`DELETE FROM share_links WHERE token=$1 AND timeline_id=$2`, [req.params.token, t.id]);
  res.json({ links: await linksFor(t.id) });
});
app.get("/api/timelines/:id/visits", needUser, async (req, res) => {
  const t = await ownTimeline(req, res); if (!t) return;
  const r = await q(`
    SELECT v.first_at, v.last_at, v.device, v.views, l.label, l.token,
           (SELECT count(*) FROM visits p WHERE p.token=v.token AND p.vid=v.vid AND p.first_at < v.first_at)::int AS earlier
    FROM visits v JOIN share_links l ON l.token=v.token
    WHERE l.timeline_id=$1 ORDER BY v.last_at DESC LIMIT 200`, [t.id]);
  res.json({ visits: r.rows.map((x) => ({ label: x.label, token: x.token, first: x.first_at, last: x.last_at, device: x.device, views: x.views, returning: x.earlier > 0, visitNo: x.earlier + 1 })) });
});

// A rough, privacy-light description of the device: no IP addresses are stored
function describeDevice(ua) {
  ua = String(ua || "");
  const dev = /iPad/.test(ua) ? "iPad" : /iPhone/.test(ua) ? "iPhone" : /Android/.test(ua) ? (/Mobile/.test(ua) ? "Android phone" : "Android tablet")
    : /CrOS/.test(ua) ? "Chromebook" : /Windows/.test(ua) ? "Windows computer" : /Macintosh|Mac OS X/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux computer" : "Unknown device";
  const br = /Edg\//.test(ua) ? "Edge" : /SamsungBrowser/.test(ua) ? "Samsung Internet" : /FBAN|FBAV|FB_IAB/.test(ua) ? "Facebook app" : /Instagram/.test(ua) ? "Instagram app"
    : /Firefox|FxiOS/.test(ua) ? "Firefox" : /CriOS|Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "";
  return br ? `${dev} · ${br}` : dev;
}
const BOT_RE = /bot|crawl|spider|slurp|facebookexternalhit|embedly|preview|headless/i;
async function recordVisit(req, res, link) {
  if (BOT_RE.test(req.get("user-agent") || "")) return;
  if (req.user && req.user.id === link.user_id) return; // the owner looking at their own link doesn't count
  let vid = parseCookies(req).ll_vid;
  if (!vid || !/^[A-Za-z0-9_-]{16,64}$/.test(vid)) {
    vid = rid(18);
    const secure = req.secure ? "; Secure" : "";
    res.append("Set-Cookie", `ll_vid=${vid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${2 * 365 * 86400}${secure}`);
  }
  const vh = sha("v:" + vid);
  // Opening again within 30 minutes counts as the same visit
  const u = await q(`UPDATE visits SET last_at=now(), views=views+1 WHERE id = (
      SELECT id FROM visits WHERE token=$1 AND vid=$2 AND last_at > now() - interval '30 minutes' ORDER BY last_at DESC LIMIT 1) RETURNING id`, [link.token, vh]);
  if (!u.rows[0]) await q(`INSERT INTO visits(token,vid,device) VALUES($1,$2,$3)`, [link.token, vh, describeDevice(req.get("user-agent"))]);
}

async function sharedTimeline(token) {
  if (!TOKEN_RE.test(token)) return null;
  const r = await q(`SELECT l.token, t.user_id, t.doc FROM share_links l JOIN tlines t ON t.id=l.timeline_id WHERE l.token=$1 AND l.active=true`, [token]);
  return r.rows[0] || null;
}
app.get("/api/shared/:token", async (req, res) => {
  const t = await sharedTimeline(req.params.token);
  if (!t) return res.status(404).json({ error: "This share link isn't active. Ask the owner for a new one." });
  try { await recordVisit(req, res, t); } catch (e) { console.error("visit log", e.message); }
  const entries = (t.doc.entries || []).map(({ fbts, imp, ...e }) => e); // strip fields only the owner needs
  res.setHeader("Cache-Control", "no-store");
  res.json({ doc: { name: t.doc.name, entries, eras: t.doc.eras || [], colorNames: t.doc.colorNames || {} } });
});
app.get("/api/shared/:token/photos/:id", async (req, res) => {
  const t = await sharedTimeline(req.params.token);
  // Only photos that belong to events on this shared timeline
  if (!t || !photoIdsOf(t.doc).includes(req.params.id)) return res.status(404).end();
  await sendPhoto(res, t.user_id, req.params.id);
});

/* ---------- Fetch a photo from a link (for spreadsheet imports) ---------- */
// Only public internet addresses: never the server itself or Railway's private network
// Separate lists: Node treats IPv4 as IPv6-mapped when one list mixes both, which would block everything
const blocked4 = new net.BlockList(), blocked6 = new net.BlockList();
[["0.0.0.0",8],["10.0.0.0",8],["100.64.0.0",10],["127.0.0.0",8],["169.254.0.0",16],["172.16.0.0",12],["192.0.0.0",24],
 ["192.168.0.0",16],["198.18.0.0",15],["224.0.0.0",4],["240.0.0.0",4]].forEach(([a,p]) => blocked4.addSubnet(a, p, "ipv4"));
[["::",96],["::ffff:0:0",96],["fc00::",7],["fe80::",10],["ff00::",8],["64:ff9b::",96],["2001:db8::",32]].forEach(([a,p]) => blocked6.addSubnet(a, p, "ipv6"));
function isPublicIp(addr, family) {
  if (family === 6) return !blocked6.check(addr, "ipv6"); // ::/96 and ::ffff:0:0/96 cover loopback and every IPv4-mapped form
  return !blocked4.check(addr, "ipv4");
}
function safeLookup(host, opts, cb) {
  dns.lookup(host, { all: true }, (err, addrs) => {
    if (err) return cb(err);
    const ok = addrs.filter((a) => isPublicIp(a.address, a.family));
    if (!ok.length) return cb(Object.assign(new Error("That link points to a private address."), { code: "EBLOCKED" }));
    if (opts && opts.all) return cb(null, ok);
    cb(null, ok[0].address, ok[0].family);
  });
}
// Turn common share links into direct downloads
function directLink(u) {
  let m;
  if ((m = u.match(/drive\.google\.com\/file\/d\/([\w-]+)/)) || (m = u.match(/drive\.google\.com\/(?:open|uc)\?(?:.*&)?id=([\w-]+)/)))
    return `https://drive.google.com/uc?export=download&id=${m[1]}`;
  if (/^https:\/\/(www\.)?dropbox\.com\//.test(u)) return u.replace(/([?&])dl=0/, "$1raw=1").replace(/^(?!.*[?&]raw=1)(.*)$/, (x) => x + (x.includes("?") ? "&" : "?") + "raw=1");
  return u;
}
function getOnce(url, maxBytes) {
  return new Promise((resolve, reject) => {
    let u; try { u = new URL(url); } catch { return reject(new Error("That isn't a web link.")); }
    if (!/^https?:$/.test(u.protocol)) return reject(new Error("Only http and https links can be imported."));
    if (u.port && !["80", "443"].includes(u.port)) return reject(new Error("That link uses an unusual port."));
    // Links written as a raw IP address skip the name lookup, so check them here too
    const host = u.hostname.replace(/^\[|\]$/g, ""), fam = net.isIP(host);
    if (fam && !isPublicIp(host, fam)) return reject(Object.assign(new Error("That link points to a private address."), { code: "EBLOCKED" }));
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.get(u, { lookup: safeLookup, timeout: 20000, headers: { "User-Agent": "Mozilla/5.0 (Lifeline photo import)", Accept: "image/*,text/html;q=0.8,*/*;q=0.5" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); return resolve({ redirect: new URL(res.headers.location, u).href }); }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(res.statusCode === 403 || res.statusCode === 401 ? "The site wouldn't share that image. It may be private or need a sign-in." : res.statusCode === 404 ? "Nothing was found at that link." : `The site answered with an error (${res.statusCode}).`)); }
      const type = String(res.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
      const chunks = []; let size = 0;
      res.on("data", (c) => { size += c.length; if (size > maxBytes) { req.destroy(); reject(new Error("That image is larger than 15 MB.")); } else chunks.push(c); });
      res.on("end", () => resolve({ type, body: Buffer.concat(chunks), finalUrl: u.href }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("The site took too long to respond.")));
    req.on("error", (e) => reject(e.code === "EBLOCKED" ? e : new Error(e.message && /ENOTFOUND|EAI_AGAIN/.test(e.message) ? "That website couldn't be found." : e.message || "Couldn't reach that link.")));
  });
}
const IMG_TYPES = /^image\/(jpeg|jpg|png|gif|webp|bmp|avif)$/;
function sniff(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf.slice(0, 8).toString("hex") === "89504e470d0a1a0a") return "image/png";
  if (buf.slice(0, 4).toString() === "GIF8") return "image/gif";
  if (buf.slice(0, 4).toString() === "RIFF" && buf.slice(8, 12).toString() === "WEBP") return "image/webp";
  return null;
}
async function fetchImage(link) {
  let url = directLink(String(link).trim()), followedPage = false;
  for (let hop = 0; hop < 6; hop++) {
    const r = await getOnce(url, 15 * 1024 * 1024);
    if (r.redirect) { url = r.redirect; continue; }
    const type = IMG_TYPES.test(r.type) ? r.type : sniff(r.body);
    if (type) return { type: type === "image/jpg" ? "image/jpeg" : type, body: r.body };
    // A web page: use the picture it advertises for previews (og:image), once
    if (!followedPage && /html/.test(r.type)) {
      const html = r.body.slice(0, 600000).toString("utf8");
      const m = html.match(/<meta[^>]+(?:property|name)=["'](?:og:image(?::secure_url)?|twitter:image)["'][^>]*content=["']([^"']+)["']/i)
             || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:og:image|twitter:image)["']/i);
      if (m) { followedPage = true; url = new URL(m[1].replace(/&amp;/g, "&"), r.finalUrl).href; continue; }
      throw new Error("That link opens a web page, not a picture. Use a direct link to the image.");
    }
    throw new Error("That link doesn't lead to a picture.");
  }
  throw new Error("That link redirected too many times.");
}
app.post("/api/fetch-image", needUser, express.json({ limit: "10kb" }), async (req, res) => {
  if (limited("img:" + req.user.id, 600, 60 * 60e3)) return res.status(429).json({ error: "Too many photo downloads at once. Wait a while and try again." });
  const link = String(req.body?.url || "");
  if (!link || link.length > 4000) return res.status(400).json({ error: "No link given." });
  try {
    const img = await fetchImage(link);
    res.setHeader("Content-Type", img.type);
    res.setHeader("Cache-Control", "no-store");
    res.end(img.body);
  } catch (e) {
    res.status(422).json({ error: e.message || "Couldn't download that picture." });
  }
});

/* ---------- Claude review of Facebook posts ---------- */
const REVIEW_PROMPT = `You are helping someone build a timeline of their own life from their old Facebook and Instagram posts.
For each post below, decide whether it records a real event or milestone in the poster's life that belongs on a personal life timeline.

KEEP posts about things that actually happened to the poster or their close family and friends, for example: births, weddings, engagements, anniversaries, graduations, first days, new jobs, promotions, retirements, moves and new homes, trips and vacations, concerts, games, shows or festivals they attended (especially with family), reunions, achievements and awards, races or sports milestones, a new pet, a first car, a serious illness or recovery, the death of a loved one, a holiday or birthday with specific detail about what they did.
SKIP posts that are not events: opinions, jokes, memes, quotes, song or movie or sports commentary not tied to attending something, shared news or links, political posts, generic greetings ("happy Friday"), contests, sales or ads, vague moods, profile picture changes with no story.
Example: "This is my favorite rock song of all time" -> skip. "Saw Foo Fighters tonight with my son, his first concert!" -> keep, title "Took my son to his first concert: Foo Fighters".

Return ONLY a JSON array with one object per post, in the same order, each:
{"id": <the post's id>, "keep": true|false, "score": 0-10 (how significant this is for the person's life story), "title": "short timeline title, past tense, under 60 characters, written as the event", "category": one of "milestone","family","education","work","home","travel","other", "reason": "under 12 words"}

Posts:
`;
app.post("/api/review", needUser, express.json({ limit: "200kb" }), async (req, res) => {
  if (!ANTHROPIC_API_KEY) return res.status(503).json({ code: "not_configured", error: "Claude review isn't set up on this site." });
  const posts = Array.isArray(req.body?.posts) ? req.body.posts.slice(0, 60) : [];
  if (!posts.length) return res.status(400).json({ error: "No posts to review." });
  // Daily allowance per person, so one large import can't run up an unexpected bill
  const used = await q(
    `UPDATE users SET ai_count = CASE WHEN ai_day = CURRENT_DATE THEN ai_count + 1 ELSE 1 END, ai_day = CURRENT_DATE
     WHERE id=$1 RETURNING ai_count`, [req.user.id]);
  if (used.rows[0].ai_count > REVIEW_DAILY_LIMIT) {
    return res.status(429).json({ code: "daily_limit", error: "You've reached today's limit for Claude reviews." });
  }
  const lines = posts.map((p, i) => JSON.stringify({
    id: i + 1,
    date: String(p.date || "").slice(0, 10),
    text: String(p.text || "").slice(0, 500),
    photos: p.photos ? Math.min(+p.photos || 0, 50) : undefined,
    place: p.place ? String(p.place).slice(0, 100) : undefined,
    facebook_label: p.label ? String(p.label).slice(0, 200) : undefined,
  })).join("\n");
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 8000, messages: [{ role: "user", content: REVIEW_PROMPT + lines }] }),
      signal: AbortSignal.timeout(120e3),
    });
    if (r.status === 429 || r.status === 529) return res.status(503).json({ code: "busy", error: "Claude is busy right now. Try again in a few minutes." });
    if (!r.ok) { console.error("Claude API error", r.status, (await r.text()).slice(0, 500)); return res.status(502).json({ code: "upstream", error: "Claude couldn't review this batch." }); }
    const data = await r.json();
    const text = (data.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
    const m = text.match(/\[[\s\S]*\]/);
    let results = [];
    try { results = m ? JSON.parse(m[0]) : []; } catch { results = []; }
    res.json({ results: Array.isArray(results) ? results : [] });
  } catch (e) {
    console.error("Claude request failed", e.message);
    res.status(502).json({ code: "upstream", error: "Claude couldn't review this batch." });
  }
});

/* ---------- Pages ---------- */
const sendPage = (file) => (req, res) => {
  res.setHeader("Cache-Control", "no-cache");
  res.sendFile(path.join(__dirname, "public", file));
};
app.get("/", sendPage("index.html"));
app.get("/s/:token", sendPage("index.html"));
app.get("/privacy", sendPage("privacy.html"));
app.use(express.static(path.join(__dirname, "public"), { index: false, maxAge: "1h" }));

app.use((err, req, res, next) => {
  if (err.type === "entity.too.large") return res.status(413).json({ error: "That's too large to save in one go." });
  console.error(err);
  res.status(500).json({ error: "Something went wrong on the server. Try again." });
});

await fsp.mkdir(PHOTO_DIR, { recursive: true });
await migrate();
app.listen(PORT, () => console.log(`Lifeline running on port ${PORT}. Photos are stored in ${PHOTO_DIR}.`));
