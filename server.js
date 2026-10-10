const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');

const db = require('./db');

const app = express();
const server = http.createServer(app);

const PORT =
    process.env.PORT || 3000;

const FRONTEND_URL =
    process.env.FRONTEND_URL;

const allowedOrigins = [
    'http://localhost:3000',
    'https://umutvq.onrender.com',
    'https://umutvq12.pages.dev'
];

const corsOptions = {
    origin: function (origin, callback) {

        if (!origin) {
            return callback(null, true);
        }

        if (
            allowedOrigins.includes(origin)
        ) {
            return callback(null, true);
        }

        return callback(
            new Error(
                'CORS policy: Origin not allowed'
            )
        );
    },

    methods: [
        'GET',
        'POST',
        'DELETE',
        'OPTIONS'
    ],

    credentials: true
};

const io = new Server(server, {
    cors: corsOptions
});

const uploadDir =
    path.join(
        __dirname,
        'public',
        'uploads'
    );

fs.mkdirSync(
    uploadDir,
    {
        recursive: true
    }
);


/* =========================================================
   EXPRESS / CORS
   ========================================================= */

app.use(
    cors(corsOptions)
);

app.use(
    express.json()
);

app.use(
    express.static(
        path.join(
            __dirname,
            'public'
        )
    )
);


/* =========================================================
   UPLOAD
   ========================================================= */

const storage =
    multer.diskStorage({

        destination:
            function (
                _req,
                _file,
                cb
            ) {

                cb(
                    null,
                    uploadDir
                );
            },

        filename:
            function (
                _req,
                file,
                cb
            ) {

                const safe =
                    path
                        .basename(
                            file.originalname
                        )
                        .replace(
                            /[^\w.\-() ]/g,
                            '_'
                        );

                cb(
                    null,
                    Date.now() +
                    '-' +
                    safe
                );
            }
    });


const upload =
    multer({

        storage: storage,

        limits: {
            fileSize:
                50 *
                1024 *
                1024
        },

        fileFilter:
            function (
                _req,
                file,
                cb
            ) {

                const ok =
                    /\.(mp3|mpeg|wav|ogg|m4a)$/i
                        .test(
                            file.originalname
                        );

                if (ok) {

                    cb(
                        null,
                        true
                    );

                } else {

                    cb(
                        new Error(
                            'Sadece ses dosyalarına izin veriliyor.'
                        )
                    );
                }
            }
    });


/* =========================================================
   STATE
   ========================================================= */

const onlineUsers =
    new Map();

const voiceUsers =
    new Set();

let currentTrack =
    null;

let djLive =
    false;


/* =========================================================
   DATABASE
   ========================================================= */

async function getPlaylist() {

    const result =
        await db.query(
            `
            SELECT
                id,
                title,
                url,
                created_at
            FROM playlist
            ORDER BY id ASC
            `
        );

    return result.rows;
}


async function ensureUserRoleColumn() {

    await db.query(
        `
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS
        role VARCHAR(20)
        NOT NULL
        DEFAULT 'Üye'
        `
    );

    await db.query(
        `
        UPDATE users
        SET role = 'Webmaster'
        WHERE LOWER(username) = 'webmaster'
        `
    );

    await db.query(
        `
        UPDATE users
        SET role = 'Admin'
        WHERE LOWER(username) = 'admin'
        `
    );
}


function safeUser(user) {

    return {

        id:
            user.id,

        username:
            user.username,

        email:
            user.email || '',

        displayName:
            user.display_name ||
            user.username,

        role:
            user.role ||
            'Üye'
    };
}


async function findUser(login) {

    const value =
        String(
            login || ''
        ).trim();

    if (!value) {

        return null;
    }

    const result =
        await db.query(
            `
            SELECT
                id,
                username,
                email,
                password_hash,
                display_name,
                is_active,
                role
            FROM users
            WHERE
                LOWER(username) =
                    LOWER($1)
                OR
                LOWER(email) =
                    LOWER($1)
            LIMIT 1
            `,
            [value]
        );

    return (
        result.rows[0] ||
        null
    );
}


/* =========================================================
   LOGIN
   ========================================================= */

app.post(
    '/api/login',
    async function (
        req,
        res
    ) {

        try {

            const username =
                String(
                    req.body &&
                    (
                        req.body.username ||
                        req.body.login ||
                        ''
                    )
                ).trim();

            const password =
                String(
                    req.body &&
                    req.body.password ||
                    ''
                );

            if (
                !username ||
                !password
            ) {

                return res
                    .status(400)
                    .json({
                        error:
                            'Kullanıcı adı/e-posta ve şifre zorunludur.'
                    });
            }

            const user =
                await findUser(
                    username
                );

            if (!user) {

                return res
                    .status(401)
                    .json({
                        error:
                            'Kullanıcı adı veya şifre hatalı.'
                    });
            }

            if (
                !user.is_active
            ) {

                return res
                    .status(403)
                    .json({
                        error:
                            'Bu kullanıcı hesabı aktif değil.'
                    });
            }

            if (
                !user.password_hash
            ) {

                return res
                    .status(401)
                    .json({
                        error:
                            'Bu hesabın şifre bilgisi bulunamadı.'
                    });
            }

            const passwordMatches =
                await bcrypt.compare(
                    password,
                    user.password_hash
                );

            if (!passwordMatches) {

                return res
                    .status(401)
                    .json({
                        error:
                            'Kullanıcı adı veya şifre hatalı.'
                    });
            }

            await db.query(
                `
                UPDATE users
                SET
                    last_login_at =
                        CURRENT_TIMESTAMP,
                    updated_at =
                        CURRENT_TIMESTAMP
                WHERE id = $1
                `,
                [user.id]
            );

            return res.json({

                success:
                    true,

                user:
                    safeUser(user)
            });

        } catch (err) {

            console.error(
                'Login hatası:',
                err
            );

            return res
                .status(500)
                .json({
                    error:
                        'Giriş sırasında bir hata oluştu.'
                });
        }
    }
);


/* =========================================================
   REGISTER
   ========================================================= */

app.post(
    '/api/register',
    async function (
        req,
        res
    ) {

        try {

            const username =
                String(
                    req.body &&
                    req.body.username ||
                    ''
                ).trim();

            const email =
                String(
                    req.body &&
                    req.body.email ||
                    ''
                ).trim();

            const password =
                String(
                    req.body &&
                    req.body.password ||
                    ''
                );

            const displayName =
                String(
                    req.body &&
                    req.body.displayName ||
                    username
                ).trim();

            if (
                !username ||
                !email ||
                !password
            ) {

                return res
                    .status(400)
                    .json({
                        error:
                            'Kullanıcı adı, e-posta ve şifre zorunludur.'
                    });
            }

            if (
                username.length < 3
            ) {

                return res
                    .status(400)
                    .json({
                        error:
                            'Kullanıcı adı en az 3 karakter olmalıdır.'
                    });
            }

            if (
                password.length < 6
            ) {

                return res
                    .status(400)
                    .json({
                        error:
                            'Şifre en az 6 karakter olmalıdır.'
                    });
            }

            const existing =
                await db.query(
                    `
                    SELECT id
                    FROM users
                    WHERE
                        LOWER(username) =
                            LOWER($1)
                        OR
                        LOWER(email) =
                            LOWER($2)
                    LIMIT 1
                    `,
                    [
                        username,
                        email
                    ]
                );

            if (
                existing.rows.length >
                0
            ) {

                return res
                    .status(409)
                    .json({
                        error:
                            'Bu kullanıcı adı veya e-posta zaten kayıtlı.'
                    });
            }

            const passwordHash =
                await bcrypt.hash(
                    password,
                    12
                );

            const result =
                await db.query(
                    `
                    INSERT INTO users
                    (
                        username,
                        email,
                        password_hash,
                        display_name,
                        is_active,
                        role
                    )
                    VALUES
                    (
                        $1,
                        $2,
                        $3,
                        $4,
                        TRUE,
                        'Üye'
                    )
                    RETURNING
                        id,
                        username,
                        email,
                        display_name,
                        is_active,
                        role
                    `,
                    [
                        username,
                        email,
                        passwordHash,
                        displayName
                    ]
                );

            return res
                .status(201)
                .json({

                    success:
                        true,

                    user:
                        safeUser(
                            result.rows[0]
                        )
                });

        } catch (err) {

            console.error(
                'Register hatası:',
                err
            );

            return res
                .status(500)
                .json({
                    error:
                        'Kayıt sırasında bir hata oluştu.'
                });
        }
    }
);


/* =========================================================
   USER INFO
   ========================================================= */

app.get(
    '/api/user/:username',
    async function (
        req,
        res
    ) {

        try {

            const user =
                await findUser(
                    req.params.username
                );

            if (!user) {

                return res
                    .status(404)
                    .json({
                        error:
                            'Kullanıcı bulunamadı.'
                    });
            }

            if (
                !user.is_active
            ) {

                return res
                    .status(403)
                    .json({
                        error:
                            'Kullanıcı aktif değil.'
                    });
            }

            return res.json({

                success:
                    true,

                user:
                    safeUser(user)
            });

        } catch (err) {

            console.error(
                'Kullanıcı bilgisi hatası:',
                err
            );

            return res
                .status(500)
                .json({
                    error:
                        'Kullanıcı bilgisi alınamadı.'
                });
        }
    }
);


/* =========================================================
   HEALTH
   ========================================================= */

app.get(
    '/api/health',
    function (
        _req,
        res
    ) {

        res.json({

            ok:
                true,

            online:
                onlineUsers.size,

            djLive:
                djLive
        });
    }
);


/* =========================================================
   PLAYLIST
   ========================================================= */

app.get(
    '/api/playlist',
    async function (
        _req,
        res
    ) {

        try {

            const playlist =
                await getPlaylist();

            return res.json(
                playlist
            );

        } catch (err) {

            console.error(
                'Playlist hatası:',
                err
            );

            return res
                .status(500)
                .json({
                    error:
                        'Playlist alınamadı.'
                });
        }
    }
);


/* =========================================================
   MUSIC UPLOAD
   ========================================================= */

app.post(
    '/api/upload',
    upload.array(
        'music',
        20
    ),
    async function (
        req,
        res
    ) {

        if (
            !req.files ||
            req.files.length === 0
        ) {

            return res
                .status(400)
                .json({
                    error:
                        'Dosya yüklenmedi.'
                });
        }

        try {

            for (
                const file
                of req.files
            ) {

                const url =
                    '/uploads/' +
                    encodeURIComponent(
                        file.filename
                    );

                await db.query(
                    `
                    INSERT INTO playlist
                    (
                        title,
                        url
                    )
                    VALUES
                    (
                        $1,
                        $2
                    )
                    ON CONFLICT (url)
                    DO NOTHING
                    `,
                    [
                        file.originalname,
                        url
                    ]
                );
            }

            const playlist =
                await getPlaylist();

            io.emit(
                'update_playlist',
                playlist
            );

            if (
                !currentTrack &&
                playlist.length > 0
            ) {

                currentTrack =
                    playlist[0];

                io.emit(
                    'play_track',
                    currentTrack
                );
            }

            return res.json({

                success:
                    true,

                playlist:
                    playlist
            });

        } catch (err) {

            console.error(
                'Upload/DB hatası:',
                err
            );

            return res
                .status(500)
                .json({
                    error:
                        'Müzik kaydedilemedi.'
                });
        }
    }
);


/* =========================================================
   DELETE MUSIC
   ========================================================= */

app.delete(
    '/api/playlist/:id',
    async function (
        req,
        res
    ) {

        try {

            const id =
                Number(
                    req.params.id
                );

            const result =
                await db.query(
                    `
                    SELECT url
                    FROM playlist
                    WHERE id = $1
                    `,
                    [id]
                );

            if (
                result.rows.length === 0
            ) {

                return res
                    .status(404)
                    .json({
                        error:
                            'Parça bulunamadı.'
                    });
            }

            const url =
                result.rows[0].url;

            await db.query(
                `
                DELETE FROM playlist
                WHERE id = $1
                `,
                [id]
            );

            if (
                url.startsWith(
                    '/uploads/'
                )
            ) {

                const fileName =
                    decodeURIComponent(
                        url.slice(
                            '/uploads/'.length
                        )
                    );

                const filePath =
                    path.join(
                        uploadDir,
                        path.basename(
                            fileName
                        )
                    );

                if (
                    fs.existsSync(
                        filePath
                    )
                ) {

                    fs.unlinkSync(
                        filePath
                    );
                }
            }

            const playlist =
                await getPlaylist();

            if (
                currentTrack &&
                currentTrack.id === id
            ) {

                currentTrack =
                    playlist.length > 0
                        ? playlist[0]
                        : null;
            }

            io.emit(
                'update_playlist',
                playlist
            );

            io.emit(
                'play_track',
                currentTrack
            );

            return res.json({

                success:
                    true,

                playlist:
                    playlist
            });

        } catch (err) {

            console.error(
                'Silme hatası:',
                err
            );

            return res
                .status(500)
                .json({
                    error:
                        'Parça silinemedi.'
                });
        }
    }
);


/* =========================================================
   SOCKET.IO
   ========================================================= */

io.on(
    'connection',
    async function (
        socket
    ) {

        try {

            const playlist =
                await getPlaylist();

            socket.emit(
                'radio_state',
                {
                    playlist:
                        playlist,

                    currentTrack:
                        currentTrack,

                    djLive:
                        djLive,

                    onlineUsers:
                        Array.from(
                            onlineUsers.values()
                        )
                }
            );

        } catch (err) {

            console.error(
                'İlk durum gönderilemedi:',
                err
            );
        }


       
        /* USER JOIN */

        socket.on(
            'user_join',
            async function (
                data
            ) {

                try {

                    const username =
                        data &&
                        data.username
                            ? data.username
                            : '';

                    const user =
                        await findUser(
                            username
                        );

                    if (
                        !user ||
                        !user.is_active
                    ) {

                        return;
                    }

                    const safe =
                        safeUser(
                            user
                        );

                    onlineUsers.set(
                        socket.id,
                        {
                            id:
                                socket.id,

                            userId:
                                safe.id,

                            username:
                                safe.username,

                            displayName:
                                safe.displayName,

                            role:
                                safe.role
                        }
                    );

                    io.emit(
                        'online_users',
                        Array.from(
                            onlineUsers.values()
                        )
                    );

                    io.emit(
                        'chat_message',
                        {
                            username: 'SİSTEM',

                            message:
                                safe.role === 'Webmaster' ||
                                safe.role === 'Admin'
                                    ? `Site yetkilisi ${safe.username} sisteme bağlandı.`
                                    : `${safe.username} sisteme bağlandı.`,

                            system: true,

                            created_at:
                                new Date().toISOString()
                        }
                    );

                } catch (err) {

                    console.error(
                        'Kullanıcı bağlantı hatası:',
                        err
                    );
                }
            }
        );


        /* CHAT MESSAGE */

        socket.on(
            'chat_message',
            async function (
                data
            ) {

                console.log(
                    'CHAT GELDİ:',
                    socket.id,
                    data
                );

                try {

                    const user =
                        onlineUsers.get(
                            socket.id
                        );

                    if (!user) {
                        return;
                    }

                    const message =
                        String(
                            data &&
                            data.message ||
                            ''
                        ).trim();

                    if (!message) {
                        return;
                    }

                    if (
                        message.length > 1000
                    ) {
                        return;
                    }

                    const result =
                        await db.query(`
                            INSERT INTO chat_messages
                            (
                                user_id,
                                username,
                                message
                            )
                            VALUES
                            (
                                $1,
                                $2,
                                $3
                            )
                            RETURNING
                                id,
                                user_id,
                                username,
                                message,
                                created_at
                        `, [
                            user.userId,
                            user.username,
                            message
                        ]);

                    const chatMessage =
                        result.rows[0];

                    io.emit(
                        'chat_message',
                        chatMessage
                    );

                } catch (err) {

                    console.error(
                        'Chat mesajı hatası:',
                        err
                    );
                }
            }
        );

        /* VOICE JOIN */

        socket.on(
            'voice_join',
            function () {

                if (
                    !onlineUsers.has(
                        socket.id
                    )
                ) {

                    return;
                }

                for (
                    const peerId
                    of voiceUsers
                ) {

                    io.to(
                        peerId
                    ).emit(
                        'voice_peer_joined',
                        {
                            peerId:
                                socket.id,

                            user:
                                onlineUsers.get(
                                    socket.id
                                )
                        }
                    );
                }

                voiceUsers.add(
                    socket.id
                );
            }
        );


        /* VOICE LEAVE */

        socket.on(
            'voice_leave',
            function () {

                if (
                    !voiceUsers.has(
                        socket.id
                    )
                ) {

                    return;
                }

                voiceUsers.delete(
                    socket.id
                );

                socket.broadcast.emit(
                    'voice_peer_left',
                    socket.id
                );
            }
        );


        /* WEBRTC OFFER */

        socket.on(
            'voice_offer',
            function (
                data
            ) {

                if (
                    !data ||
                    !data.target
                ) {

                    return;
                }

                io.to(
                    data.target
                ).emit(
                    'voice_offer',
                    {
                        from:
                            socket.id,

                        offer:
                            data.offer
                    }
                );
            }
        );


        /* WEBRTC ANSWER */

        socket.on(
            'voice_answer',
            function (
                data
            ) {

                if (
                    !data ||
                    !data.target
                ) {

                    return;
                }

                io.to(
                    data.target
                ).emit(
                    'voice_answer',
                    {
                        from:
                            socket.id,

                        answer:
                            data.answer
                    }
                );
            }
        );


        /* WEBRTC ICE */

        socket.on(
            'voice_ice',
            function (
                data
            ) {

                if (
                    !data ||
                    !data.target
                ) {

                    return;
                }

                io.to(
                    data.target
                ).emit(
                    'voice_ice',
                    {
                        from:
                            socket.id,

                        candidate:
                            data.candidate
                    }
                );
            }
        );


        /* DJ MICROPHONE REQUEST */

        socket.on(
            'dj_mic_request',
            function (data) {

                const user =
                    onlineUsers.get(socket.id);

                if (!user) {
                    return;
                }

                if (
                    ![
                        'DJ',
                        'Webmaster',
                        'Admin'
                    ].includes(user.role)
                ) {
                    return;
                }

                const targets =
                    data &&
                    Array.isArray(data.targets)
                        ? data.targets
                        : [];

                for (const targetId of targets) {

                    if (
                        targetId === socket.id ||
                        !onlineUsers.has(targetId)
                    ) {
                        continue;
                    }

                    io.to(targetId).emit(
                        'dj_mic_request',
                        {
                            from: socket.id,
                            djUsername: user.username
                        }
                    );
                }
            }
        );

        /* DJ LIVE */

        socket.on(
            'set_dj_live',
            function (
                live
            ) {

                const user =
                    onlineUsers.get(
                        socket.id
                    );

                if (!user) {

                    return;
                }

                if (
                    ![
                        'DJ',
                        'Webmaster',
                        'Admin'
                    ].includes(
                        user.role
                    )
                ) {

                    return;
                }

                djLive =
                    Boolean(live);

                io.emit(
                    'dj_live_changed',
                    djLive
                );
            }
        );


        /* CHANGE TRACK */

        socket.on(
            'change_track',
            function (
                track
            ) {

                const user =
                    onlineUsers.get(
                        socket.id
                    );

                if (!user) {

                    return;
                }

                if (
                    ![
                        'DJ',
                        'Webmaster',
                        'Admin'
                    ].includes(
                        user.role
                    )
                ) {

                    return;
                }

                currentTrack =
                    track ||
                    null;

                io.emit(
                    'play_track',
                    currentTrack
                );
            }
        );


        /* TRACK ENDED */

        socket.on(
            'track_ended',
            async function () {

                try {

                    const playlist =
                        await getPlaylist();

                    if (
                        playlist.length === 0
                    ) {

                        return;
                    }

                    const currentId =
                        currentTrack
                            ? currentTrack.id
                            : null;

                    const index =
                        playlist.findIndex(
                            function (
                                track
                            ) {

                                return (
                                    track.id ===
                                    currentId
                                );
                            }
                        );

                    currentTrack =
                        playlist[
                            (
                                index + 1
                            ) %
                            playlist.length
                        ];

                    io.emit(
                        'play_track',
                        currentTrack
                    );

                } catch (err) {

                    console.error(
                        'Sonraki parça seçilemedi:',
                        err
                    );
                }
            }
        );


        /* DISCONNECT */

        socket.on(
            'disconnect',
            function () {

                onlineUsers.delete(
                    socket.id
                );

                if (
                    voiceUsers.delete(
                        socket.id
                    )
                ) {

                    socket.broadcast.emit(
                        'voice_peer_left',
                        socket.id
                    );
                }

                io.emit(
                    'online_users',
                    Array.from(
                        onlineUsers.values()
                    )
                );
            }
        );
    }
);


/* =========================================================
   START
   ========================================================= */

(async function () {

    try {

        await db.initDb();

        await ensureUserRoleColumn();

        const playlist =
            await getPlaylist();

        currentTrack =
            playlist.length > 0
                ? playlist[0]
                : null;

        server.listen(
            PORT,
            function () {

                console.log(
                    '🚀 Radyo sunucusu: http://localhost:' +
                    PORT
                );
            }
        );

    } catch (err) {

        console.error(
            'Sunucu başlatılamadı:',
            err
        );

        process.exit(1);
    }

})();