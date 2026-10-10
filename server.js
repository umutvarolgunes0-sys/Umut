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
const PORT = process.env.PORT || 3000;

const allowedOrigins = ['http://localhost:3000','https://umutvq.onrender.com','https://umutvq12.pages.dev','https://101dunyasi.com'];
const corsOptions = {
    origin: function(origin,cb){ if(!origin) return cb(null,true); return cb(null,true); },
    methods:['GET','POST','DELETE','PUT','OPTIONS'], credentials:true
};
const io = new Server(server,{ cors: corsOptions, maxHttpBufferSize: 1e7 });
const uploadDir = path.join(__dirname,'public','uploads');
fs.mkdirSync(uploadDir,{recursive:true});
app.use(cors(corsOptions));
app.use(express.json());
app.use(express.static(path.join(__dirname,'public')));

const storage = multer.diskStorage({
    destination:(_req,_file,cb)=>cb(null,uploadDir),
    filename:(_req,file,cb)=>{ const safe=path.basename(file.originalname).replace(/[^\w.\-() ]/g,'_'); cb(null,Date.now()+'-'+safe); }
});
const upload = multer({
    storage, limits:{fileSize:50*1024*1024},
    fileFilter:(_req,file,cb)=>{ const ok=/\.(mp3|mpeg|wav|ogg|m4a)$/i.test(file.originalname); if(ok) cb(null,true); else cb(new Error('Sadece ses dosyalarına izin veriliyor.')); }
});

// STATE
const onlineUsers = new Map();
const ghostUsers = new Map();
const voiceUsers = new Set();
let currentTrack = null;
let djLive = false;
let djLiveUserId = null;
let autoDJTimer = null;
let mutedUsers = new Map();
let rooms = new Map();
let chatFilterWords = [];
let currentRoomUsers = new Map();

async function getPlaylist(){ const r=await db.query(`SELECT id,title,url,created_at FROM playlist ORDER BY id ASC`); return r.rows; }
async function getRooms(){ const r=await db.query(`SELECT r.*, u.username as manager_name FROM rooms r LEFT JOIN users u ON r.manager_id=u.id ORDER BY r.id ASC`); return r.rows; }
async function getBans(){ const r=await db.query(`SELECT b.*, u1.username as banned_username, u2.username as banned_by_name FROM bans b LEFT JOIN users u1 ON b.user_id=u1.id LEFT JOIN users u2 ON b.banned_by=u2.id WHERE b.is_active=TRUE ORDER BY b.created_at DESC LIMIT 100`); return r.rows; }
async function getFilterWords(){ const r=await db.query(`SELECT word FROM chat_filter_words`); return r.rows.map(x=>x.word.toLowerCase()); }
async function loadInitialData(){
    try{
        const roomList=await getRooms();
        roomList.forEach(r=>{ rooms.set(r.id,r); if(!currentRoomUsers.has(r.id)) currentRoomUsers.set(r.id,new Set()); });
        chatFilterWords=await getFilterWords();
        console.log(`📦 ${rooms.size} oda, ${chatFilterWords.length} filtre kelimesi yüklendi`);
    }catch(e){ console.error('Initial data load hatası',e); }
}
async function ensureUserRoleColumn(){
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(20) DEFAULT 'Üye'`);
    await db.query(`UPDATE users SET role='Webmaster' WHERE LOWER(username)='webmaster'`);
}
function safeUser(user){
    return {
        id:user.id, username:user.username, email:user.email||'', displayName:user.display_name||user.username,
        role:user.role||'Üye', ban_count:user.ban_count||0, last_ip:user.last_ip||'',
        nick_color:user.nick_color||null, nick_effect:user.nick_effect||null, is_gold:user.is_gold||false,
        hat_type:user.hat_type||getHatByRole(user.role), is_ghost:user.is_ghost||false
    };
}
function getHatByRole(role){
    switch(role){ case 'Webmaster': return 'crown'; case 'Admin': return 'shield'; case 'Site Yetkilisi': return 'star'; case 'Moderator': return 'mod'; case 'DJ': return 'headphone'; case 'VIP': return 'diamond'; default: return null; }
}
async function findUser(login){
    const v=String(login||'').trim(); if(!v) return null;
    const r=await db.query(`SELECT * FROM users WHERE LOWER(username)=LOWER($1) OR LOWER(email)=LOWER($1) LIMIT 1`,[v]); return r.rows[0]||null;
}
async function isIpBanned(ip){
    if(!ip) return null;
    const r=await db.query(`SELECT * FROM bans WHERE ip=$1 AND is_active=TRUE AND (expires_at IS NULL OR expires_at > NOW()) LIMIT 1`,[ip]);
    return r.rows[0]||null;
}
async function logUserIp(userId, ip, username_used, userAgent){
    try{
        await db.query(`
            INSERT INTO user_ips (user_id, ip, username_used, user_agent, login_count, last_seen)
            VALUES ($1,$2,$3,$4,1,NOW())
            ON CONFLICT (user_id, ip, username_used) 
            DO UPDATE SET login_count = user_ips.login_count + 1, last_seen = NOW(), user_agent=$4
        `,[userId, ip, username_used, userAgent]);
        await db.query(`UPDATE users SET last_ip=$2, updated_at=NOW() WHERE id=$1`,[userId, ip]);
    }catch(e){ console.error('IP log hatası',e); }
}
function containsFilteredWord(text){
    const lower=text.toLowerCase();
    for(const w of chatFilterWords){ if(lower.includes(w)) return w; }
    return null;
}
async function playNextTrack(){
    try{
        const playlist=await getPlaylist(); if(playlist.length===0){ currentTrack=null; io.emit('play_track',null); return; }
        if(djLive) return;
        const currentId=currentTrack?currentTrack.id:null;
        const idx=playlist.findIndex(t=>t.id===currentId);
        currentTrack=playlist[(idx+1)%playlist.length];
        io.emit('play_track',currentTrack);
        if(autoDJTimer) clearTimeout(autoDJTimer);
        autoDJTimer=setTimeout(()=>playNextTrack(), 5*60*1000);
    }catch(e){ console.error('Auto DJ hatası',e); }
}

app.post('/api/login', async(req,res)=>{
    try{
        const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || req.socket.remoteAddress;
        const banned = await isIpBanned(ip);
        if(banned){ return res.status(403).json({error:`IP Banlısınız: ${banned.reason || 'Sebep belirtilmedi'} - Bitiş: ${banned.expires_at||'Süresiz'}`}); }
        const username=String(req.body&&(req.body.username||req.body.login||'')).trim();
        const password=String(req.body&&req.body.password||'');
        if(!username||!password) return res.status(400).json({error:'Kullanıcı adı/e-posta ve şifre zorunludur.'});
        const user=await findUser(username);
        if(!user) return res.status(401).json({error:'Kullanıcı adı veya şifre hatalı.'});
        if(!user.is_active) return res.status(403).json({error:'Hesap aktif değil.'});
        if(!user.password_hash) return res.status(401).json({error:'Şifre bilgisi bulunamadı.'});
        const ok=await bcrypt.compare(password,user.password_hash);
        if(!ok) return res.status(401).json({error:'Kullanıcı adı veya şifre hatalı.'});
        await db.query(`UPDATE users SET last_login_at=NOW(), updated_at=NOW(), last_ip=$2 WHERE id=$1`,[user.id, ip]);
        await logUserIp(user.id, ip, user.username, req.headers['user-agent']||'');
        return res.json({success:true, user:safeUser(user)});
    }catch(e){ console.error('Login hatası',e); return res.status(500).json({error:'Giriş hatası'}); }
});

app.post('/api/register', async(req,res)=>{
    try{
        const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || '';
        const banned=await isIpBanned(ip); if(banned) return res.status(403).json({error:'IP banlı olduğunuz için kayıt olamazsınız.'});
        const username=String(req.body.username||'').trim(); const email=String(req.body.email||'').trim();
        const password=String(req.body.password||''); const displayName=String(req.body.displayName||username).trim();
        if(!username||!email||!password) return res.status(400).json({error:'Tüm alanlar zorunlu'});
        if(username.length<3) return res.status(400).json({error:'Nick en az 3 karakter'});
        if(password.length<6) return res.status(400).json({error:'Şifre en az 6 karakter'});
        const ex=await db.query(`SELECT id FROM users WHERE LOWER(username)=LOWER($1) OR LOWER(email)=LOWER($2) LIMIT 1`,[username,email]);
        if(ex.rows.length>0) return res.status(409).json({error:'Kullanıcı adı veya e-posta zaten var'});
        const hash=await bcrypt.hash(password,12);
        const r=await db.query(`INSERT INTO users (username,email,password_hash,display_name,is_active,role) VALUES ($1,$2,$3,$4,TRUE,'Üye') RETURNING *`,[username,email,hash,displayName]);
        return res.status(201).json({success:true, user:safeUser(r.rows[0])});
    }catch(e){ console.error('Register hatası',e); return res.status(500).json({error:'Kayıt hatası'}); }
});

app.get('/api/user/:username', async(req,res)=>{
    try{
        const user=await findUser(req.params.username); if(!user) return res.status(404).json({error:'Bulunamadı'});
        if(!user.is_active) return res.status(403).json({error:'Aktif değil'});
        const ips=await db.query(`SELECT ip, username_used, login_count, first_seen, last_seen FROM user_ips WHERE user_id=$1 ORDER BY last_seen DESC LIMIT 20`,[user.id]);
        const bans=await db.query(`SELECT * FROM bans WHERE user_id=$1 ORDER BY created_at DESC`,[user.id]);
        return res.json({success:true, user:safeUser(user), ipHistory:ips.rows, banHistory:bans.rows, banCount:bans.rows.length});
    }catch(e){ console.error(e); return res.status(500).json({error:'Bilgi alınamadı'}); }
});

app.get('/api/health', (req,res)=>{ res.json({ok:true, online:onlineUsers.size+ghostUsers.size, ghost:ghostUsers.size, djLive, rooms:rooms.size}); });
app.get('/api/playlist', async(req,res)=>{ try{ const p=await getPlaylist(); res.json(p); }catch(e){ res.status(500).json({error:'Playlist alınamadı'}); } });
app.get('/api/rooms', async(req,res)=>{ try{ const r=await getRooms(); res.json(r); }catch(e){ res.status(500).json({error:'Odalar alınamadı'}); } });
app.get('/api/bans', async(req,res)=>{ try{ const b=await getBans(); res.json(b); }catch(e){ res.status(500).json({error:'Banlar alınamadı'}); } });
app.get('/api/filter-words', async(req,res)=>{ try{ const w=await db.query(`SELECT * FROM chat_filter_words ORDER BY word ASC`); res.json(w.rows); }catch(e){ res.status(500).json({error:'Filtre alınamadı'}); } });

app.post('/api/rooms', async(req,res)=>{
    try{
        const {name, description, user_limit, is_private, password, manager_id, salon_type} = req.body;
        if(!name) return res.status(400).json({error:'Oda adı zorunlu'});
        let hash=null; if(password){ hash=await bcrypt.hash(password,10); }
        const r=await db.query(`INSERT INTO rooms (name, description, user_limit, is_private, password_hash, manager_id, salon_type, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$1) RETURNING *`,[name.trim(), description||'', user_limit||50, Boolean(is_private), hash, manager_id||null, salon_type||'genel']);
        rooms.set(r.rows[0].id, r.rows[0]); currentRoomUsers.set(r.rows[0].id, new Set());
        io.emit('rooms_updated', await getRooms());
        return res.json({success:true, room:r.rows[0]});
    }catch(e){ if(e.code==='23505') return res.status(409).json({error:'Bu oda adı zaten var'}); console.error(e); return res.status(500).json({error:'Oda oluşturulamadı'}); }
});
app.put('/api/rooms/:id', async(req,res)=>{
    try{
        const id=Number(req.params.id);
        const {name, description, user_limit, is_private, password, manager_id} = req.body;
        let hashUpdate=''; let params=[name, description, user_limit, Boolean(is_private), manager_id, id];
        if(password){ const h=await bcrypt.hash(password,10); hashUpdate=', password_hash=$7'; params.splice(5,0,h); }
        await db.query(`UPDATE rooms SET name=$1, description=$2, user_limit=$3, is_private=$4, manager_id=$5 ${hashUpdate} WHERE id=$6`, params);
        const updated=await db.query(`SELECT * FROM rooms WHERE id=$1`,[id]);
        if(updated.rows[0]) rooms.set(id, updated.rows[0]);
        io.emit('rooms_updated', await getRooms());
        return res.json({success:true, room:updated.rows[0]});
    }catch(e){ console.error(e); return res.status(500).json({error:'Oda güncellenemedi'}); }
});
app.delete('/api/rooms/:id', async(req,res)=>{
    try{
        const id=Number(req.params.id); if(id<=3) return res.status(400).json({error:'Varsayılan odalar silinemez'});
        await db.query(`DELETE FROM rooms WHERE id=$1`,[id]);
        rooms.delete(id); currentRoomUsers.delete(id);
        io.emit('rooms_updated', await getRooms());
        return res.json({success:true});
    }catch(e){ console.error(e); return res.status(500).json({error:'Oda silinemedi'}); }
});

app.post('/api/upload', upload.array('music',20), async(req,res)=>{
    if(!req.files||req.files.length===0) return res.status(400).json({error:'Dosya yok'});
    try{
        for(const file of req.files){
            const url='/uploads/'+encodeURIComponent(file.filename);
            await db.query(`INSERT INTO playlist (title,url) VALUES ($1,$2) ON CONFLICT (url) DO NOTHING`,[file.originalname, url]);
        }
        const playlist=await getPlaylist(); io.emit('update_playlist',playlist);
        if(!currentTrack && playlist.length>0 && !djLive){ currentTrack=playlist[0]; io.emit('play_track',currentTrack); }
        return res.json({success:true, playlist});
    }catch(e){ console.error(e); return res.status(500).json({error:'Kaydedilemedi'}); }
});
app.delete('/api/playlist/:id', async(req,res)=>{
    try{
        const id=Number(req.params.id);
        const r=await db.query(`SELECT url FROM playlist WHERE id=$1`,[id]); if(r.rows.length===0) return res.status(404).json({error:'Bulunamadı'});
        const url=r.rows[0].url; await db.query(`DELETE FROM playlist WHERE id=$1`,[id]);
        if(url.startsWith('/uploads/')){ const fn=decodeURIComponent(url.slice('/uploads/'.length)); const fp=path.join(uploadDir,path.basename(fn)); if(fs.existsSync(fp)) fs.unlinkSync(fp); }
        const playlist=await getPlaylist(); if(currentTrack&&currentTrack.id===id){ currentTrack=playlist.length>0?playlist[0]:null; }
        io.emit('update_playlist',playlist); if(!djLive) io.emit('play_track',currentTrack);
        return res.json({success:true, playlist});
    }catch(e){ console.error(e); return res.status(500).json({error:'Silinemedi'}); }
});

app.post('/api/filter-words', async(req,res)=>{
    try{
        const {word}=req.body; if(!word) return res.status(400).json({error:'Kelime zorunlu'});
        await db.query(`INSERT INTO chat_filter_words (word) VALUES ($1) ON CONFLICT (word) DO NOTHING`,[word.toLowerCase().trim()]);
        chatFilterWords=await getFilterWords(); io.emit('filter_updated', chatFilterWords);
        return res.json({success:true, words:chatFilterWords});
    }catch(e){ console.error(e); return res.status(500).json({error:'Eklenemedi'}); }
});
app.delete('/api/filter-words/:id', async(req,res)=>{
    try{ await db.query(`DELETE FROM chat_filter_words WHERE id=$1`,[req.params.id]); chatFilterWords=await getFilterWords(); io.emit('filter_updated', chatFilterWords); return res.json({success:true}); }
    catch(e){ return res.status(500).json({error:'Silinemedi'}); }
});

app.post('/api/announcements', async(req,res)=>{
    try{
        const {message, type, room_id, expires_at}=req.body; if(!message) return res.status(400).json({error:'Mesaj zorunlu'});
        const r=await db.query(`INSERT INTO announcements (message, type, room_id, expires_at) VALUES ($1,$2,$3,$4) RETURNING *`,[message, type||'marquee', room_id||null, expires_at||null]);
        io.emit('new_announcement', r.rows[0]);
        if(type==='marquee'){ io.emit('marquee_update', message); }
        if(type==='popup'){ io.emit('popup_announcement', r.rows[0]); }
        return res.json({success:true, announcement:r.rows[0]});
    }catch(e){ console.error(e); return res.status(500).json({error:'Duyuru gönderilemedi'}); }
});

app.post('/api/ban-ip', async(req,res)=>{
    try{
        const {ip, reason, user_id, expires_at, ban_type} = req.body;
        if(!ip) return res.status(400).json({error:'IP zorunlu'});
        await db.query(`INSERT INTO bans (ip, reason, user_id, banned_by, expires_at, ban_type) VALUES ($1,$2,$3,$4,$5,$6)`,[ip, reason||'Sebep yok', user_id||null, null, expires_at||null, ban_type||'ip']);
        if(user_id){ await db.query(`UPDATE users SET ban_count = ban_count + 1 WHERE id=$1`,[user_id]); }
        io.emit('ip_banned', {ip, reason});
        return res.json({success:true});
    }catch(e){ console.error(e); return res.status(500).json({error:'Ban atılamadı'}); }
});
app.delete('/api/bans/:id', async(req,res)=>{
    try{ await db.query(`UPDATE bans SET is_active=FALSE WHERE id=$1`,[req.params.id]); io.emit('bans_updated', await getBans()); return res.json({success:true}); }
    catch(e){ return res.status(500).json({error:'Ban kaldırılamadı'}); }
});

// SOCKET.IO
io.on('connection', async(socket)=>{
    const ip = socket.handshake.headers['x-forwarded-for']?.split(',')[0]?.trim() || socket.handshake.address;
    const banned = await isIpBanned(ip);
    if(banned){
        socket.emit('banned', {reason: banned.reason, expires_at: banned.expires_at});
        setTimeout(()=>socket.disconnect(true), 1000);
        return;
    }

    try{
        const playlist=await getPlaylist(); const roomList=await getRooms();
        socket.emit('radio_state',{ playlist, currentTrack, djLive, djLiveUserId, onlineUsers:Array.from(onlineUsers.values()), rooms:roomList, filterWords:chatFilterWords });
    }catch(e){ console.error('İlk durum hatası',e); }

    socket.on('user_join', async(data)=>{
        try{
            const username=data&&data.username?data.username:''; const user=await findUser(username); if(!user||!user.is_active) return;
            const safe=safeUser(user);
            if(data.isGhost && safe.role==='Webmaster'){
                ghostUsers.set(socket.id,{ id:socket.id, userId:safe.id, username:safe.username, displayName:safe.displayName, role:safe.role, isGhost:true, nick_color:safe.nick_color, is_gold:safe.is_gold, hat_type:safe.hat_type });
                socket.emit('ghost_activated', true);
                socket.emit('online_users', Array.from(onlineUsers.values()));
                socket.emit('rooms_list', await getRooms());
                return;
            }
            onlineUsers.set(socket.id,{ id:socket.id, userId:safe.id, username:safe.username, displayName:safe.displayName, role:safe.role, nick_color:safe.nick_color, nick_effect:safe.nick_effect, is_gold:safe.is_gold, hat_type:safe.hat_type, currentRoom:1, last_ip:ip });
            if(!currentRoomUsers.has(1)) currentRoomUsers.set(1,new Set()); currentRoomUsers.get(1).add(socket.id);
            await logUserIp(safe.id, ip, safe.username, socket.handshake.headers['user-agent']||'');
            io.emit('online_users', Array.from(onlineUsers.values()));
            io.emit('chat_message',{ username:'SİSTEM', message: safe.role==='Webmaster'||safe.role==='Admin'?`Site yetkilisi ${safe.username} bağlandı.`:`${safe.username} bağlandı.`, system:true, created_at:new Date().toISOString() });
        }catch(e){ console.error('Join hatası',e); }
    });

    socket.on('chat_message', async(data)=>{
        try{
            const user=onlineUsers.get(socket.id)||ghostUsers.get(socket.id); if(!user) return;
            const muteEnd=mutedUsers.get(user.userId); if(muteEnd&&Date.now()<muteEnd){ socket.emit('chat_message',{username:'SİSTEM', message:`Susturuldunuz, ${Math.ceil((muteEnd-Date.now())/1000)} sn kaldı.`, system:true, created_at:new Date().toISOString()}); return; }
            let message=String(data&&data.message||'').trim(); if(!message) return; if(message.length>1000) return;
            const bad=containsFilteredWord(message);
            if(bad){
                socket.emit('chat_message',{username:'SİSTEM', message:`Mesajınız filtreye takıldı: "${bad}"`, system:true, created_at:new Date().toISOString()});
                return;
            }
            const result=await db.query(`INSERT INTO chat_messages (user_id,username,message) VALUES ($1,$2,$3) RETURNING id,user_id,username,message,created_at`,[user.userId, user.username, message]);
            const chatMessage=result.rows[0];
            const roomId=user.currentRoom||1;
            const roomSockets=currentRoomUsers.get(roomId)||new Set();
            if(roomSockets.size>0){
                for(const sid of roomSockets){ io.to(sid).emit('chat_message', chatMessage); }
                for(const gsid of ghostUsers.keys()){ io.to(gsid).emit('chat_message', chatMessage); }
            }else{
                io.emit('chat_message', chatMessage);
            }
        }catch(e){ console.error('Chat hatası',e); }
    });

    socket.on('private_message', (data)=>{
        const fromUser=onlineUsers.get(socket.id)||ghostUsers.get(socket.id); if(!fromUser) return;
        const toSocketId=data&&data.to; const msg=String(data&&data.message||'').trim(); if(!toSocketId||!msg) return;
        const toUser=onlineUsers.get(toSocketId)||ghostUsers.get(toSocketId); if(!toUser) return;
        const payload={ from:socket.id, fromUsername:fromUser.username, fromDisplayName:fromUser.displayName, to:toSocketId, message:msg, created_at:new Date().toISOString(), private:true, hat_type:fromUser.hat_type, is_gold:fromUser.is_gold, nick_color:fromUser.nick_color };
        io.to(toSocketId).emit('private_message', payload); socket.emit('private_message', payload);
    });

    socket.on('get_profile_request', async(data)=>{
        try{
            const username=data&&data.username; if(!username) return;
            const user=await findUser(username); if(!user) return;
            const ips=await db.query(`SELECT ip, username_used, login_count, first_seen, last_seen FROM user_ips WHERE user_id=$1 ORDER BY last_seen DESC LIMIT 20`,[user.id]);
            const bans=await db.query(`SELECT * FROM bans WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20`,[user.id]);
            const safe=safeUser(user);
            socket.emit('profile_info', { user:safe, ipHistory:ips.rows, banHistory:bans.rows, banCount:bans.rows.length });
        }catch(e){ console.error(e); }
    });

    socket.on('join_room', async(data)=>{
        try{
            const user=onlineUsers.get(socket.id); if(!user) return;
            const roomId=Number(data&&data.roomId); const password=data&&data.password||'';
            const room=rooms.get(roomId); if(!room) { socket.emit('room_error','Oda bulunamadı'); return; }
            if(room.is_private && room.password_hash){
                if(!password){ socket.emit('room_password_required', roomId); return; }
                const ok=await bcrypt.compare(password, room.password_hash); if(!ok){ socket.emit('room_error','Şifre hatalı'); return; }
            }
            const roomUsers=currentRoomUsers.get(roomId)||new Set();
            if(roomUsers.size >= room.user_limit){ socket.emit('room_error','Oda dolu'); return; }
            const oldRoomId=user.currentRoom||1;
            if(currentRoomUsers.has(oldRoomId)) currentRoomUsers.get(oldRoomId).delete(socket.id);
            user.currentRoom=roomId; onlineUsers.set(socket.id,user);
            if(!currentRoomUsers.has(roomId)) currentRoomUsers.set(roomId,new Set());
            currentRoomUsers.get(roomId).add(socket.id);
            socket.emit('room_joined', room);
            io.emit('online_users', Array.from(onlineUsers.values()));
            io.emit('room_users_updated', {roomId, count:currentRoomUsers.get(roomId).size});
        }catch(e){ console.error('Oda join hatası',e); }
    });

    socket.on('admin_action', async(data)=>{
        const fromUser=onlineUsers.get(socket.id)||ghostUsers.get(socket.id); if(!fromUser) return;
        if(!['Webmaster','Admin','Site Yetkilisi','Moderator'].includes(fromUser.role)) return;
        const targetId=data&&data.targetId; const action=data&&data.action; if(!targetId||!action) return;
        const targetUser=onlineUsers.get(targetId)||ghostUsers.get(targetId); if(!targetUser) return;
        if(targetId===socket.id) return;
        if(targetUser.role==='Webmaster' && fromUser.role!=='Webmaster') return;

        switch(action){
            case 'kick':
                io.to(targetId).emit('kicked',{reason:data.reason||'Atıldınız'}); 
                setTimeout(()=>{ io.sockets.sockets.get(targetId)?.disconnect(); },500);
                io.emit('chat_message',{username:'SİSTEM', message:`${targetUser.username} atıldı (${fromUser.username})`, system:true, created_at:new Date().toISOString()});
                break;
            case 'mute':
                const dur=Number(data.duration)||300; mutedUsers.set(targetUser.userId, Date.now()+dur*1000);
                io.emit('user_muted',{userId:targetUser.userId, username:targetUser.username, duration:dur});
                io.emit('chat_message',{username:'SİSTEM', message:`${targetUser.username} ${dur} sn susturuldu.`, system:true, created_at:new Date().toISOString()});
                break;
            case 'unmute': mutedUsers.delete(targetUser.userId); io.emit('user_unmuted',{userId:targetUser.userId}); break;
            case 'make_dj': case 'make_admin': case 'make_vip': case 'make_gold': case 'remove_gold':
                try{
                    let newRole='Üye'; let isGold=false; let nickColor=null;
                    if(action==='make_dj') newRole='DJ';
                    if(action==='make_admin') newRole='Admin';
                    if(action==='make_vip') newRole='VIP';
                    if(action==='make_gold'){ isGold=true; nickColor='#FFD700'; }
                    if(action==='make_gold' || action==='remove_gold'){
                        await db.query(`UPDATE users SET is_gold=$1, nick_color=$2 WHERE id=$3`,[isGold, nickColor, targetUser.userId]);
                    }else{
                        await db.query(`UPDATE users SET role=$1 WHERE id=$2`,[newRole, targetUser.userId]);
                        targetUser.role=newRole;
                    }
                    io.emit('online_users', Array.from(onlineUsers.values()));
                    io.emit('chat_message',{username:'SİSTEM', message:`${targetUser.username} ${newRole} ${isGold?'Gold üye':''} yapıldı.`, system:true, created_at:new Date().toISOString()});
                }catch(e){ console.error(e); } break;
            case 'ip_ban':
                try{
                    const ipToBan=data.ip || targetUser.last_ip || ip;
                    await db.query(`INSERT INTO bans (ip, reason, user_id, banned_by, ban_type) VALUES ($1,$2,$3,$4,'ip')`,[ipToBan, data.reason||'IP Ban', targetUser.userId, fromUser.userId]);
                    await db.query(`UPDATE users SET ban_count=ban_count+1 WHERE id=$1`,[targetUser.userId]);
                    io.emit('ip_banned',{ip:ipToBan, username:targetUser.username});
                }catch(e){ console.error(e); } break;
            case 'move_room':
                try{
                    const roomId=Number(data.roomId); const room=rooms.get(roomId); if(!room) return;
                    const oldRoom=targetUser.currentRoom||1;
                    if(currentRoomUsers.has(oldRoom)) currentRoomUsers.get(oldRoom).delete(targetId);
                    targetUser.currentRoom=roomId;
                    if(onlineUsers.has(targetId)) onlineUsers.set(targetId, targetUser); else ghostUsers.set(targetId, targetUser);
                    if(!currentRoomUsers.has(roomId)) currentRoomUsers.set(roomId,new Set());
                    currentRoomUsers.get(roomId).add(targetId);
                    io.to(targetId).emit('room_joined', room);
                    io.emit('online_users', Array.from(onlineUsers.values()));
                    io.emit('chat_message',{username:'SİSTEM', message:`${targetUser.username} ${room.name} odasına alındı.`, system:true, created_at:new Date().toISOString()});
                }catch(e){ console.error(e); } break;
        }
    });

    socket.on('ghost_toggle', async()=>{
        const user=onlineUsers.get(socket.id); if(!user) return; if(user.role!=='Webmaster') return;
        ghostUsers.set(socket.id,{...user, isGhost:true}); onlineUsers.delete(socket.id);
        if(currentRoomUsers.has(user.currentRoom||1)) currentRoomUsers.get(user.currentRoom||1).delete(socket.id);
        socket.emit('ghost_activated', true);
        io.emit('online_users', Array.from(onlineUsers.values()));
    });
    socket.on('ghost_disable', async()=>{
        const user=ghostUsers.get(socket.id); if(!user) return;
        onlineUsers.set(socket.id,{...user, isGhost:false, currentRoom:1});
        ghostUsers.delete(socket.id);
        if(!currentRoomUsers.has(1)) currentRoomUsers.set(1,new Set()); currentRoomUsers.get(1).add(socket.id);
        socket.emit('ghost_activated', false);
        io.emit('online_users', Array.from(onlineUsers.values()));
    });

    socket.on('voice_join', ()=>{ if(!onlineUsers.has(socket.id)&&!ghostUsers.has(socket.id)) return; for(const pid of voiceUsers){ io.to(pid).emit('voice_peer_joined',{peerId:socket.id, user:onlineUsers.get(socket.id)||ghostUsers.get(socket.id)}); } voiceUsers.add(socket.id); });
    socket.on('voice_leave', ()=>{ if(!voiceUsers.has(socket.id)) return; voiceUsers.delete(socket.id); socket.broadcast.emit('voice_peer_left', socket.id); });
    socket.on('voice_offer', (data)=>{ if(!data||!data.target) return; io.to(data.target).emit('voice_offer',{from:socket.id, offer:data.offer}); });
    socket.on('voice_answer', (data)=>{ if(!data||!data.target) return; io.to(data.target).emit('voice_answer',{from:socket.id, answer:data.answer}); });
    socket.on('voice_ice', (data)=>{ if(!data||!data.target) return; io.to(data.target).emit('voice_ice',{from:socket.id, candidate:data.candidate}); });
    socket.on('dj_talking', (isTalking)=>{ const u=onlineUsers.get(socket.id)||ghostUsers.get(socket.id); if(!u) return; if(!['DJ','Webmaster','Admin'].includes(u.role)) return; if(!djLive) return; socket.broadcast.emit('dj_talking',{djId:socket.id, talking:Boolean(isTalking)}); });
    socket.on('set_dj_live', (live)=>{
        const user=onlineUsers.get(socket.id)||ghostUsers.get(socket.id); if(!user) return; if(!['DJ','Webmaster','Admin'].includes(user.role)) return;
        djLive=Boolean(live); djLiveUserId=djLive?socket.id:null;
        if(djLive){ if(autoDJTimer){ clearTimeout(autoDJTimer); autoDJTimer=null; } io.emit('play_track',null); } else { if(currentTrack) io.emit('play_track',currentTrack); else playNextTrack(); }
        io.emit('dj_live_changed',{live:djLive, djId:djLiveUserId, djUsername:user.username});
    });
    socket.on('dj_live_play_track', (track)=>{
        const user=onlineUsers.get(socket.id)||ghostUsers.get(socket.id); if(!user) return; if(!['DJ','Webmaster','Admin'].includes(user.role)) return; if(!djLive) return; if(socket.id!==djLiveUserId && user.role!=='Webmaster') return;
        currentTrack=track||null; io.emit('play_track',currentTrack);
    });
    socket.on('change_track', (track)=>{
        const user=onlineUsers.get(socket.id)||ghostUsers.get(socket.id); if(!user) return; if(!['DJ','Webmaster','Admin'].includes(user.role)) return; if(djLive && user.role!=='Webmaster') return;
        currentTrack=track||null; io.emit('play_track',currentTrack);
        if(autoDJTimer){ clearTimeout(autoDJTimer); autoDJTimer=setTimeout(()=>playNextTrack(),5*60*1000); }
    });
    socket.on('track_ended', async()=>{ if(djLive) return; await playNextTrack(); });
    socket.on('disconnect', ()=>{
        const user=onlineUsers.get(socket.id)||ghostUsers.get(socket.id);
        onlineUsers.delete(socket.id); ghostUsers.delete(socket.id);
        if(voiceUsers.delete(socket.id)){ socket.broadcast.emit('voice_peer_left', socket.id); }
        for(const set of currentRoomUsers.values()){ set.delete(socket.id); }
        if(djLive && socket.id===djLiveUserId){ djLive=false; djLiveUserId=null; io.emit('dj_live_changed',{live:false, djId:null}); playNextTrack(); }
        io.emit('online_users', Array.from(onlineUsers.values()));
        if(user && !user.isGhost){ io.emit('chat_message',{username:'SİSTEM', message:`${user.username} ayrıldı.`, system:true, created_at:new Date().toISOString()}); }
    });
});

(async()=>{
    try{
        await db.initDb(); await ensureUserRoleColumn(); await loadInitialData();
        const playlist=await getPlaylist(); currentTrack=playlist.length>0?playlist[0]:null;
        if(playlist.length>0){ autoDJTimer=setTimeout(()=>playNextTrack(),5*60*1000); }
        server.listen(PORT, ()=>{ console.log(`🚀 Full Radyo + Yetki + Oda Sistemi: http://localhost:${PORT}`); });
    }catch(e){ console.error('Sunucu başlatılamadı',e); process.exit(1); }
})();
