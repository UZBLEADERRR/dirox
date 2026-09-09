# Railway'ga qo'yish

Mini bitta Node jarayoni: ilovani ham, marketni ham o'zi beradi. Bog'liqlik
yo'q, ma'lumotlar bazasi yo'q. Railway'da 5 daqiqada ko'tariladi.

> Bu repozitoriyda ikkita alohida mahsulot bor: ildizda **DiroxCode**,
> `mini/` papkasida esa **Mini**. Shuning uchun eng muhim qadam — servisga
> **Root Directory = `mini`** deb ko'rsatish. Aks holda Railway noto'g'ri
> loyihani yig'adi.

---

## 1. Servis yaratish

Railway → **New Project** → **Deploy from GitHub repo** → `UZBLEADERRR/dirox`.

Yig'ilish boshlanadi; to'xtating yoki tugashini kuting — keyingi qadamdan
so'ng qayta yig'iladi.

## 2. Root Directory ni ko'rsatish

Servis → **Settings** → **Source** → **Root Directory**:

```
mini
```

Endi Railway `mini/nixpacks.toml` va `mini/railway.json` ni ko'radi:
`node server/server.js` bilan ishga tushadi, `/api/health` orqali tekshiradi.

## 3. Volume ulash — buni o'tkazib yubormang

Railway konteynerlari **vaqtinchalik**: har deployda disk tozalanadi. Volume
ulamasangiz market har yangilanishda bo'shab qoladi.

Servis → **Settings** → **Volumes** → **Add Volume**

| | |
| --- | --- |
| Mount path | `/data` |

## 4. O'zgaruvchilar

Servis → **Variables**:

| Nom | Qiymat | Izoh |
| --- | --- | --- |
| `MINI_DATA` | `/data` | **majburiy** — volume mount path bilan bir xil |
| `MINI_ADMIN_TOKEN` | uzun tasodifiy satr | `/api/admin/*` ni yoqadi |
| `MINI_ADMIN_USERS` | `sizning_username` | shu akkauntlarga ilova ichidagi admin panel ochiladi |
| `MINI_MODERATE` | `1` | ilovalar sizning tasdig'ingizni kutadi |
| `MINI_MAX_PER_DAY` | `1` | bir qurilmadan kuniga nechta ilova |
| `MINI_MAX_PER_IP` | `20` | bir IP dan kuniga nechta (operator NAT uchun) |
| `MINI_INACTIVE_DAYS` | `30` | necha kun jimlikdan keyin akkaunt o'chadi |
| `MINI_SECRET` | uzun tasodifiy satr | sessiya imzo kaliti — pastdagi izohni o'qing |
| `MINI_REGS_PER_HOUR` | `10` | bir IP dan soatiga nechta ro'yxatdan o'tish |
| `MINI_FREE_KEY` | API kalitingiz | bepul model yoqiladi (pastga qarang) |
| `MINI_FREE_MODEL` | `openai/gpt-4o-mini` | qaysi model |
| `MINI_FREE_BASE_URL` | `https://openrouter.ai/api/v1` | qaysi provayder |
| `MINI_FREE_PER_DAY` | `30` | bir userga kuniga nechta xabar |

`PORT` ni **qo'ymang** — Railway o'zi beradi, server o'zi o'qiydi.

Token yasash:

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

**`MINI_SECRET` haqida.** Qo'ymasangiz, server uni birinchi ishga tushganda
o'zi yasab, `/data/secret` fayliga yozadi — volume bo'lsa bu yetarli va
xavfsiz. Qo'lda qo'yishning yagona sababi: bir nechta nusxa (replica)
ishlatmoqchi bo'lsangiz, hammasida bir xil bo'lishi kerak. Kalit o'zgarsa —
hamma foydalanuvchi tizimdan chiqib ketadi (parollari saqlanib qoladi).

## 5. Domen

Servis → **Settings** → **Networking** → **Generate Domain**.

`https://...up.railway.app` chiqadi. HTTPS shart: usiz service worker ham,
«ekranga o'rnatish» ham ishlamaydi.

O'z domeningiz bo'lsa — **Custom Domain** ga qo'shing va DNS'da CNAME yozing.

## 6. Tekshirish

```bash
curl https://SIZNING-DOMEN/api/health
# {"ok":true,"apps":0,"moderate":false,"uptime":12}
```

Telefonda oching → ro'yxatdan o'ting (ism, username, parol) → API
kalitingizni kiriting → ilova yasang → **Marketga joylash**. Katalogni
ko'rish:

```bash
curl https://SIZNING-DOMEN/api/market/index.json
```

---

## Akkauntlar

Ro'yxatdan o'tish ochiq: ism, username, parol. Email so'ralmaydi, shuning
uchun parolni tiklash ham yo'q — bu foydalanuvchiga kirish ekranida
aytiladi.

**30 kun kirilmagan akkaunt avtomatik o'chiriladi.** Server buni har soatda
tekshiradi. Marketga joylangan ilovalar qoladi — ularni odamlar o'rnatgan.
Muddatni `MINI_INACTIVE_DAYS` bilan o'zgartirasiz.

---

## Bepul model (sizning hisobingizdan)

Kaliti yo'q odam ilovada hech narsa qila olmaydi. Shuning uchun **siz bitta
modelni server orqasiga qo'yishingiz mumkin** — kalit brauzerga hech qachon
chiqmaydi, so'rov `/api/ai/chat` orqali o'tadi va har bir userga kunlik
chegara qo'yiladi.

O'zgaruvchilar bilan yoki ishlab turgan serverda admin orqali:

```bash
TOKEN=...; HOST=https://SIZNING-DOMEN

curl -X POST -H "X-Admin-Token: $TOKEN" -H 'Content-Type: application/json' \
  -d '{"baseUrl":"https://openrouter.ai/api/v1","key":"sk-or-...",
       "model":"google/gemini-2.0-flash-001","label":"Free model","perDay":30}' \
  $HOST/api/admin/config

curl -H "X-Admin-Token: $TOKEN" $HOST/api/admin/config     # holatni ko'rish
curl -X POST -H "X-Admin-Token: $TOKEN" -H 'Content-Type: application/json' \
  -d '{"clear":true}' $HOST/api/admin/config               # o'chirish
```

Yoqilgach: kaliti yo'q har bir yangi user avtomatik shu modelga tushadi va
Sozlamalarda «bugun nechta xabar qoldi» ni ko'rib turadi. Kalitini qo'ygan
user chegarasiz ishlaydi.

**Xarajatni nazorat qilish:** `perDay` (kuniga xabar) × faol userlar soni.
Arzon modelni tanlang — `perDay: 20` va gemini-flash bilan bir user kuniga
bir tiyinlik chiqadi. `/api/config` kalitni hech qachon qaytarmaydi.

---

## Admin panelga kirish

Eng qulayi: `MINI_ADMIN_USERS` ga o'z username'ingizni qo'ying (vergul bilan
bir nechta ham bo'ladi). Shundan keyin o'sha akkaunt bilan kirsangiz,
**Sozlamalar → Admin panel** paydo bo'ladi va token kerak emas.

Token bilan: `https://SIZNING-DOMEN/?admin=1` → `MINI_ADMIN_TOKEN` ni
kiriting. Qurilmada saqlanadi, keyingi safar to'g'ridan-to'g'ri ochiladi.

Panelda hammasi bor: statistika, bepul modelni sozlash, market navbati,
ilovalarni o'chirish, akkauntlar.

---

## Moderatsiya

Boshida `MINI_MODERATE=1` qo'yib turish xavfsizroq: AI o'tkazgan ilova ham
sizning tasdig'ingizni kutadi.

```bash
TOKEN=...; HOST=https://SIZNING-DOMEN

curl -H "X-Admin-Token: $TOKEN" $HOST/api/admin/pending
curl -H "X-Admin-Token: $TOKEN" $HOST/api/admin/users
curl -X POST -H "X-Admin-Token: $TOKEN" $HOST/api/admin/sweep    # faolsizlarni darrov o'chirish
curl -X POST -H "X-Admin-Token: $TOKEN" "$HOST/api/admin/publish?id=<id>"
curl -X POST -H "X-Admin-Token: $TOKEN" "$HOST/api/admin/remove?id=<id>"
```

`remove` ilova faylini ham o'chiradi.

---

## Nusxa olish

Hamma narsa `/data` ichidagi oddiy JSON fayllarda:

```
/data/users.json       akkauntlar (parollar scrypt bilan xeshlangan)
/data/secret           sessiya imzo kaliti
/data/apps.json        katalog
/data/apps/<id>.json   ilovalarning o'zi
/data/installs.json    o'rnatish sanoqlari
/data/limits.json      IP bo'yicha kunlik hisob
```

`users.json` va `secret` — eng muhim ikkitasi. `secret` yo'qolsa hamma qayta
kirishi kerak bo'ladi; `users.json` yo'qolsa akkauntlar yo'qoladi.

Railway CLI orqali:

```bash
railway link                       # servisni tanlang
railway run tar czf - -C /data . > mini-backup-$(date +%F).tar.gz
```

Qaytarish — o'sha arxivni `/data` ga yoyish.

---

## Yuklama va narx

Origin ko'radigan yagona haqiqiy ish — «joylash», ya'ni kuniga bir necha
marta. Qolgani keshlanadi:

- katalog — bitta gzip'langan fayl, ETag bilan, 120 soniya `max-age`
- ilova to'plamlari — mazmun-xeshli manzilda, `immutable`
- model bilan gaplashish serverdan umuman o'tmaydi

Xotira ~60 MB atrofida. Cloudflare'ni old tomonga qo'ysangiz origin deyarli
uxlab yotadi.

---

## Ikkinchi servis sifatida

DiroxCode va Mini bir loyihada, ikki servis bo'lib tura oladi:

| Servis | Root Directory | Start |
| --- | --- | --- |
| diroxcode | *(bo'sh)* | `npm start` |
| mini | `mini` | `node server/server.js` |

Har biriga alohida domen beriladi.

---

## Railway'siz

Har qanday Node 20+ serverda ishlaydi:

```bash
git clone https://github.com/UZBLEADERRR/dirox
cd dirox/mini
MINI_DATA=/var/lib/mini PORT=8080 node server/server.js
```

Oldiga nginx yoki Caddy qo'ying:

```
mini.example.com {
  reverse_proxy 127.0.0.1:8080
}
```

Marketsiz, faqat statik holda ham bo'ladi — `mini/` papkasini GitHub Pages
yoki Netlify'ga qo'ying; u holda Market bo'limi bo'sh turadi yoki
Sozlamalarda boshqa market serverini ko'rsatasiz.
