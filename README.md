# 101dunyasi Okey & Radyo

Bu sürümde şu parçalar birbirine bağlandı:

- Neon PostgreSQL playlist tablosu
- Kalıcı MP3 yükleme (`/api/upload`)
- Sayfa yenilense bile playlistin Neon'dan geri gelmesi
- Socket.IO ile gerçek çevrim içi kullanıcı listesi
- WebRTC tabanlı sesli sohbet
- DJ için Bas-Konuş
- DJ canlı değilken otomatik Oto-DJ / yüklenmiş MP3 yedek akışı
- Şarkı bitince sunucudan sıradaki parçaya geçiş
- MP3 silme API'si

## Kurulum

1. Node.js 18+ kurulu olmalı.
2. `.env.example` dosyasını `.env` olarak kopyalayın.
3. Neon bağlantı bilginizi `.env` içindeki `DATABASE_URL` alanına yazın.
4. `npm install`
5. `npm start`
6. Tarayıcıdan `http://localhost:3000` açın.

## Sesli sohbet

Yerel geliştirmede `http://localhost:3000` üzerinde mikrofon kullanılabilir. Canlı internette mikrofon erişimi için **HTTPS** gerekir (localhost istisnadır).

WebRTC şu anda mesh yapıdadır; küçük/orta sayıdaki sesli sohbet odaları için uygundur. Çok büyük odalarda SFU (ör. LiveKit/mediasoup/Janus) tercih edilmelidir.

## Oto-DJ davranışı

Sunucuda DJ canlı modu kapalıyken Oto-DJ devrededir. Yüklenmiş MP3'ler Neon playlistinden alınır. Kullanıcı siteye girdiğinde tarayıcı ilk uygun parçayı oynatır; parça bitince sunucu sıradaki parçayı bildirir.

Not: Sunucu tek başına bir tarayıcı olmadan hoparlörden ses çıkaramaz. "Kimse online değilken müzik çalsın" ifadesi bu nedenle **bir sonraki kullanıcı geldiğinde Oto-DJ'nin otomatik hazır olması** şeklinde uygulanmıştır. Gerçek 7/24 yayın akışı isteniyorsa ayrıca Icecast/SHOUTcast veya sürekli çalışan bir yayın worker'ı gerekir.

## Güvenlik

Eski ZIP içinde gerçek Neon `DATABASE_URL` bilgisi bulunuyordu. Bu sürümde `.env` pakete dahil edilmedi. Eski bağlantı bilgisini artık kullanmayın; Neon'dan şifreyi/credential'ı döndürmeniz (rotate) tavsiye edilir.
