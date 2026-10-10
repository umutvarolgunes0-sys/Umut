const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function initDb() {
    // Users tablosu - var olanı koru, eksikleri ekle
    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            username VARCHAR(100) UNIQUE NOT NULL,
            email VARCHAR(255) UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            display_name VARCHAR(100),
            is_active BOOLEAN DEFAULT TRUE,
            role VARCHAR(20) DEFAULT 'Üye',
            ban_count INT DEFAULT 0,
            last_ip VARCHAR(45),
            is_ghost BOOLEAN DEFAULT FALSE,
            nick_color VARCHAR(20) DEFAULT NULL,
            nick_effect VARCHAR(20) DEFAULT NULL,
            is_gold BOOLEAN DEFAULT FALSE,
            hat_type VARCHAR(20) DEFAULT NULL,
            created_at TIMESTAMP DEFAULT NOW(),
            last_login_at TIMESTAMP,
            updated_at TIMESTAMP DEFAULT NOW()
        );
    `);

    // Eski tablolara kolon ekle (migration)
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ban_count INT DEFAULT 0`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_ip VARCHAR(45)`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_ghost BOOLEAN DEFAULT FALSE`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS nick_color VARCHAR(20) DEFAULT NULL`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS nick_effect VARCHAR(20) DEFAULT NULL`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_gold BOOLEAN DEFAULT FALSE`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS hat_type VARCHAR(20) DEFAULT NULL`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(20) DEFAULT 'Üye'`);

    // Playlist
    await pool.query(`
        CREATE TABLE IF NOT EXISTS playlist (
            id SERIAL PRIMARY KEY,
            title VARCHAR(255) NOT NULL,
            url TEXT UNIQUE NOT NULL,
            created_at TIMESTAMP DEFAULT NOW()
        );
    `);

    // Chat messages
    await pool.query(`
        CREATE TABLE IF NOT EXISTS chat_messages (
            id SERIAL PRIMARY KEY,
            user_id INT REFERENCES users(id),
            username VARCHAR(100),
            message TEXT,
            created_at TIMESTAMP DEFAULT NOW()
        );
    `);

    // YENİ: Bans - IP + Nick ban
    await pool.query(`
        CREATE TABLE IF NOT EXISTS bans (
            id SERIAL PRIMARY KEY,
            user_id INT REFERENCES users(id),
            ip VARCHAR(45),
            username_banned VARCHAR(100),
            reason TEXT,
            banned_by INT REFERENCES users(id),
            ban_type VARCHAR(20) DEFAULT 'full',
            created_at TIMESTAMP DEFAULT NOW(),
            expires_at TIMESTAMP,
            is_active BOOLEAN DEFAULT TRUE
        );
    `);

    // YENİ: User IPs - hangi nicklerle giriş yapmış
    await pool.query(`
        CREATE TABLE IF NOT EXISTS user_ips (
            id SERIAL PRIMARY KEY,
            user_id INT REFERENCES users(id),
            ip VARCHAR(45) NOT NULL,
            username_used VARCHAR(100) NOT NULL,
            user_agent TEXT,
            login_count INT DEFAULT 1,
            first_seen TIMESTAMP DEFAULT NOW(),
            last_seen TIMESTAMP DEFAULT NOW(),
            UNIQUE(user_id, ip, username_used)
        );
    `);

    // YENİ: Rooms - Oda sistemi
    await pool.query(`
        CREATE TABLE IF NOT EXISTS rooms (
            id SERIAL PRIMARY KEY,
            name VARCHAR(100) UNIQUE NOT NULL,
            description TEXT,
            manager_id INT REFERENCES users(id),
            user_limit INT DEFAULT 50,
            is_private BOOLEAN DEFAULT FALSE,
            password_hash TEXT,
            salon_type VARCHAR(50) DEFAULT 'genel',
            created_by INT REFERENCES users(id),
            created_at TIMESTAMP DEFAULT NOW()
        );
    `);

    // YENİ: Announcements
    await pool.query(`
        CREATE TABLE IF NOT EXISTS announcements (
            id SERIAL PRIMARY KEY,
            message TEXT NOT NULL,
            type VARCHAR(20) DEFAULT 'marquee',
            room_id INT REFERENCES rooms(id),
            created_by INT REFERENCES users(id),
            created_at TIMESTAMP DEFAULT NOW(),
            expires_at TIMESTAMP
        );
    `);

    // YENİ: Chat filter
    await pool.query(`
        CREATE TABLE IF NOT EXISTS chat_filter_words (
            id SERIAL PRIMARY KEY,
            word VARCHAR(100) UNIQUE NOT NULL,
            added_by INT REFERENCES users(id),
            created_at TIMESTAMP DEFAULT NOW()
        );
    `);

    // Varsayılan odalar
    await pool.query(`
        INSERT INTO rooms (name, description, user_limit, salon_type)
        VALUES 
            ('Genel Salon', 'Herkesin sohbet edebileceği genel salon', 100, 'genel'),
            ('VIP Salon', 'Sadece VIP ve yetkililerin girebildiği salon', 50, 'vip'),
            ('DJ Odası', 'DJ yayın odası', 30, 'dj')
        ON CONFLICT (name) DO NOTHING
    `);

    // Varsayılan filtre kelimeleri
    await pool.query(`
        INSERT INTO chat_filter_words (word)
        VALUES ('küfür1'), ('küfür2')
        ON CONFLICT (word) DO NOTHING
    `);

    console.log('✅ DB hazır - Tüm tablolar kontrol edildi');
}

module.exports = {
    query: (text, params) => pool.query(text, params),
    initDb,
    pool
};
