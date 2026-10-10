const { Pool } = require('pg');
require('dotenv').config();

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL tanımlı değil. .env dosyanızı kontrol edin.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS playlist (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
)
  `);
}

async function seedUploads(uploadDir) {
  const files = fs.readdirSync(uploadDir).filter(f => /\.(mp3|mpeg|wav|ogg|m4a)$/i.test(f));
  for (const file of files) {
    const url = `/uploads/${encodeURIComponent(file)}`;
    await pool.query(
      `INSERT INTO playlist (title, url) VALUES ($1, $2)
       ON CONFLICT (url) DO NOTHING`,
      [file.replace(/^\d+-/, ''), url]
    );
  }
}

const fs = require('fs');

async function init() {
  try {
    await initDb();
    console.log('✅ Neon playlist tablosu hazır.');
  } catch (err) {
    console.error('❌ Neon veritabanı başlatma hatası:', err);
  }
}

init();

module.exports = {
  query: (text, params) => pool.query(text, params),
  initDb
};
