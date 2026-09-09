<p align="center">
  <img src="assets/mark.png" width="76" alt="Mini">
</p>

<h1 align="center">Mini</h1>

<p align="center"><b>O'zingizga ilova yasang. Bir bosishda telefon ekraningizga.</b></p>

---

Mini — telefon uchun yasalgan AI. Undan ilova so'raysiz — u yozadi, brauzerda
ishga tushirib tekshiradi, xatolarini o'zi tuzatadi va tayyor ilovani telefon
ekraningizga o'z nomi va belgisi bilan qo'yadi. Yoqqan ilovangizni **Market**ga
joylashingiz mumkin: uni AI ko'rib chiqadi, kategoriyaga ajratadi va har kim
bir bosishda o'rnatib oladi.

Ikkita ekran, bitta tugma bilan almashadi:

| **Chat** | **Market** |
| --- | --- |
| AI bilan ilova yasaysiz | Odamlar yasagan ilovalarni o'rnatasiz |

Kirish uchun ism, username va parol — boshqa hech narsa so'ralmaydi. Keyin
foydalanuvchi o'z API kalitini kiritadi va istagan modelini tanlaydi (yoki
server egasi qo'ygan **bepul modeldan** foydalanadi). Chat,
ilovalar va sozlamalar faqat o'sha telefonda — `localStorage`da — turadi;
serverda faqat akkaunt va market.

---

## Ishga tushirish

```bash
cd mini
npm start                 # http://localhost:8080 — ilova ham, market ham
```

Boshqa hech narsa kerak emas: bog'liqlik yo'q, build yo'q, ma'lumotlar bazasi
yo'q. Node 20+ yetarli.

### Serverga qo'yish

**Railway** uchun to'liq yo'riqnoma: [DEPLOY.md](DEPLOY.md) — servisga
`Root Directory = mini` qo'yasiz, `/data` volume ulaysiz va `MINI_DATA=/data`
deysiz. Boshqa hech narsa kerak emas.

Qo'lda:

```bash
MINI_DATA=/var/lib/mini PORT=8080 node server/server.js
```

Old tomonga nginx yoki Caddy qo'ying va HTTPS bering — servis ishchisi va
«ekranga o'rnatish» faqat HTTPS'da ishlaydi.

| O'zgaruvchi | Ma'nosi |
| --- | --- |
| `PORT` | port (8080) |
| `MINI_DATA` | ma'lumot papkasi (`mini/data`) |
| `MINI_MAX_PER_DAY` | bir qurilmadan kuniga nechta ilova (1) |
| `MINI_MAX_PER_IP` | bir IP dan kuniga nechta (20 — operator NAT uchun) |
| `MINI_INACTIVE_DAYS` | necha kun jimlikdan keyin akkaunt o'chadi (30) |
| `MINI_SECRET` | sessiya imzo kaliti (qo'yilmasa `MINI_DATA` ichida yasaladi) |
| `MINI_REGS_PER_HOUR` | bir IP dan soatiga nechta ro'yxatdan o'tish (10) |
| `MINI_FREE_KEY` / `MINI_FREE_MODEL` / `MINI_FREE_PER_DAY` | server egasi to'laydigan model |
| `MINI_MODERATE` | `1` bo'lsa ilovalar admin tasdig'ini kutadi |
| `MINI_ADMIN_TOKEN` | `/api/admin/*` ni yoqadi |

Marketsiz, faqat statik holda ham ishlatsa bo'ladi — `mini/` papkasini
GitHub Pages yoki istalgan statik hostingga qo'ying. U holda Market bo'limi
bo'sh turadi (yoki Sozlamalarda boshqa market serverini ko'rsatasiz).

---

## Serveringizga yuklama tushmaydi

Bu maxsus o'ylangan:

- **Butun katalog — bitta fayl.** `/api/market/index.json` yozuv bo'lgandagina
  qayta yig'iladi, xotirada gzip qilingan holda turadi va ETag bilan beriladi.
  Ko'rish — bu bitta shartli GET.
- **Har bir ilova — o'zgarmas manzil.** Ilova `id`si mazmun xeshidan
  yasaladi, shuning uchun `Cache-Control: immutable`. Bir marta yuklangan
  ilova qayta so'ralmaydi.
- **AI tekshiruvi mijozda ketadi**, foydalanuvchining o'z kaliti bilan.
  Moderatsiya sizga bir tiyin ham turmaydi.
- **Sessiya holatsiz** — har so'rovda foydalanuvchi qidirilmaydi.
- **O'rnatish sanoqlari to'planib yoziladi**, har bosishda emas.
- **Model bilan gaplashish serverdan o'tmaydi** — brauzer to'g'ridan-to'g'ri
  OpenRouter bilan ishlaydi.

Amalda origin ko'radigan yagona haqiqiy ish — kuniga bir necha marta
sodir bo'ladigan «joylash». Oldiga CDN qo'ysangiz, qolgani nolga tushadi.

---

## Akkauntlar

Ism, username, parol. **Email so'ralmaydi** — demak, parolni tiklab bo'lmaydi
va bu foydalanuvchiga ochiq aytiladi. Buning evaziga: yig'iladigan shaxsiy
ma'lumot yo'q, pochta xizmati yo'q, tasdiqlash oqimi yo'q.

- Parollar **scrypt** bilan (har biriga alohida tuz), taqqoslash
  `timingSafeEqual` orqali.
- Sessiya **holatsiz**: token — `userId.vaqt.hmac`, faqat server kaliti bilan
  tekshiriladi. Marketni ko'rish hech qanday bazaga murojaat qilmaydi.
- 5 marta noto'g'ri paroldan keyin IP bo'yicha kechikish qo'yiladi. Ro'yxatdan
  o'tish alohida hisoblanadi (soatiga 10 ta bir manzildan) — aks holda bitta
  yangi akkaunt qolgan hammaning keyingi xatosini bloklab qo'yardi.
- Parol o'zgarsa, undan oldin berilgan barcha sessiyalar o'ladi.
- Mavjud bo'lmagan username uchun ham parol xeshlanadi: tez rad javob —
  username borligini bildiradigan oracle.
- Serverda saqlanadigan yagona faollik belgisi — `lastSeen`, kuniga bir marta
  yoziladi. 30 kunlik qoida uchun shuncha aniqlik yetarli.

**30 kun kirilmasa akkaunt o'chiriladi** (`MINI_INACTIVE_DAYS`). Har kirish
hisobni noldan boshlaydi; akkaunt oynasida necha kun qolgani ko'rinib turadi.

Marketga joylagan ilovalari **qoladi**. Ularni odamlar o'rnatgan va endi ular
marketning mazmuni — JSON'dagi bitta qatorni tozalash uchun boshqalarning bosh
ekranini buzish noto'g'ri bo'lardi.

Bir ilova — bosh ekrandagi mini ilova — **akkauntsiz ham ochiladi**: u
allaqachon o'rnatilgan va butunlay telefonda ishlaydi.

---

## Admin panel

Serveringizni boshqarish uchun curl shart emas — panel ilovaning ichida.

**Kirish:** Railway'da `MINI_ADMIN_USERS=sizning_username` qo'ying. Shundan
so'ng o'sha akkaunt bilan kirsangiz, **Sozlamalar → Admin panel** paydo
bo'ladi. Token bilan ovora bo'lmaysiz.

Hali qo'ymagan bo'lsangiz: `https://SIZNING-DOMEN/?admin=1` ni oching va
`MINI_ADMIN_TOKEN` ni bir marta kiriting — u shu qurilmada saqlanadi.

Panelda: akkauntlar/ilovalar/o'rnatishlar soni, **bepul modelni sozlash**
(provayder, kalit, model, kunlik chegara), **market navbati** (moderatsiya
yoqilgan bo'lsa tasdiqlash), **hamma ilovalar** (o'chirish), **akkauntlar**
ro'yxati va faolsizlarni darrov tozalash.

---

## Bepul model

Kaliti yo'q odam ilovani sinab ko'ra olmaydi — shuning uchun server egasi
bitta modelni server orqasiga qo'ya oladi. Kalit brauzerga chiqmaydi:
mijoz `/api/ai/chat` ga yozadi, server o'z kaliti bilan provayderga uzatadi
va javob oqimini qaytaradi. Har bir akkauntga kunlik xabar chegarasi
qo'yiladi (`perDay`). O'z kalitini qo'ygan user chegarasiz ishlaydi.

Sozlash: [DEPLOY.md](DEPLOY.md#bepul-model-sizning-hisobingizdan).

---

## Marketga qanday tushadi

1. Foydalanuvchi ilovani yasaydi va **Marketga joylash** ni bosadi (kirgan
   bo'lishi kerak).
2. **Ilova avval haqiqatan ishga tushiriladi**, so'ng AI o'sha ishga tushirish
   hisoboti asosida qaror qiladi: ishlaydimi, tugallanganmi, foydalimi. Kod
   qisqartirilgan bo'lsa ham bu ayb hisoblanmaydi — modelga shu aniq
   aytilgan. Axlat, namuna, spam yoki nomaqbul narsa rad etiladi.
3. **Kategoriyani AI belgilaydi.** Mavjudlaridan mosini tanlaydi, mos kelmasa
   yangisini yaratadi — «O'yinlar», «Asboblar», «Moliya» va hokazo.
4. Server o'z tekshiruvini o'tkazadi va saqlaydi.
5. Ilova market kartalarida paydo bo'ladi. Ustiga bosgan odam uni **shu
   yerda ishlatib ko'radi** — jonli nusxa kartochka ichida ochiladi — keyin
   **GET** ni bosib o'rnatadi. Kurslar va kitoblar ham xuddi shunday
   joylanadi va o'z belgisi bilan ko'rinadi.

**Kuniga bitta ilova.** Chegara akkaunt bo'yicha, IP esa faqat toshqinga
qarshi (`MINI_MAX_PER_IP`) — operator NAT'i orqasida bir necha shahar bitta
manzilda bo'lishi mumkin.

Serverning o'z tekshiruvi (AI aytganiga ishonmaydi):

- `index.html` bor va bo'sh emas
- 400 KB dan katta emas, 20 tadan ko'p fayl emas
- **tashqi skript, stil yoki tarmoq murojaati yo'q** — ilova mustaqil bo'lishi
  shart. Shu qoida o'rnatilgan ilovani internetsiz ishlashini ta'minlaydi,
  tekshiruvdan keyin mazmuni o'zgarib ketishiga yo'l qo'ymaydi va butun bir
  turdagi hujumni yopadi.
- takrorlangan ilova (bir xil mazmun) qabul qilinmaydi

`MINI_MODERATE=1` qo'ysangiz, hammasi sizning tasdig'ingizni kutadi:

```bash
curl -H "X-Admin-Token: $MINI_ADMIN_TOKEN" http://localhost:8080/api/admin/pending
curl -H "X-Admin-Token: $MINI_ADMIN_TOKEN" http://localhost:8080/api/admin/users
curl -X POST -H "X-Admin-Token: $MINI_ADMIN_TOKEN" "http://localhost:8080/api/admin/publish?id=<id>"
curl -X POST -H "X-Admin-Token: $MINI_ADMIN_TOKEN" "http://localhost:8080/api/admin/remove?id=<id>"
```

---

## Agent

Oltita vosita, boshqa hech narsa:

| Vosita | Vazifasi |
| --- | --- |
| `write_file` | fayl yozish |
| `edit_file` | faylning bir parchasini almashtirish |
| `read_file` | o'qish (yoki fayllar ro'yxati) |
| `delete_file` | keraksiz faylni o'chirish |
| `run_check` | ilovani ishga tushirib xato, tugma va joylashuvni tekshirish |
| `screenshot` | ekran suratini olib, ko'rish |
| `publish_app` | foydalanuvchi ekraniga qo'shish |

`run_check` haqiqiy tekshiruv: ilova yashirin iframe'da ishga tushadi, JS
xatolari, `console.error` va yuklanmagan rasmlar yig'iladi, ko'rinadigan
tugmalar bosib ko'riladi, gorizontal scroll va ekrandan chiqib ketgan
elementlar sanaladi. Natija ~1 KB matn bo'lib qaytadi.

`screenshot` sahifani SVG `foreignObject` orqali JPEG'ga aylantiradi va
modelga rasm sifatida qaytaradi — kutubxonasiz, tarmoqsiz.

Agentga «tugallanmagan narsa qoldirma» degan qoida qattiq qo'yilgan: TODO yo'q,
yarim ishlaydigan tugma yo'q, holat `localStorage`da saqlanadi, bo'sh va xato
holatlari o'ylangan, dizayn mobil uchun (44px tugmalar, safe-area, tungi va
kunduzgi rejim).

### Har bir ish uchun alohida model

Bitta model hamma ishga to'g'ri kelmaydi. Shuning uchun:

- **Har bir rol o'z modelini** oladi — Dizaynerga kuchlisi, Dasturchiga
  boshqasi, backend uchun uchinchisi. Rol tahririda tanlanadi.
- **Parallel yozuvchilar** uchun alohida model (odatda arzonroq va tezrog'i).
- **Market tekshiruvi** uchun alohida model.

Tanlanmagan joyda asosiy model ishlatiladi. Bepul model rejimida modelni
server tanlaydi, shuning uchun bu tanlovlar o'shanda e'tiborga olinmaydi.

### Parallel yozuvchilar (sub-agentlar)

Yigirma darslik kursni bitta agent ketma-ket yozsa, yigirma marta borib
keladi va har safar oldingi o'n to'qqiztasining izini qayta o'qiydi — sekin
ham, qimmat ham.

Shuning uchun asosiy ish **fanout** qilinadi. Agent `write_lessons` ni bir
marta chaqiradi, ilova esa har bir dars uchun alohida, kichik so'rov
yuboradi: faqat kurs nomi, shu darsning o'rni, oldingi va keyingi darslar
sarlavhalari, ishlatsa bo'ladigan markup va (kitob yuklangan bo'lsa) o'sha
darsga tegishli parcha. Hech narsa to'planib bormaydi, bir nechtasi bir
vaqtda ketadi, har biri o'z qatorida jonli ko'rinadi.

Reja, tekshiruv va tuzatish asosiy agentda qoladi — sub-agentlar faqat bitta
matn yozadi, chunki darslar bir-biriga bog'liq emas va shu qism toza
parallellashadi.

Nechta bir vaqtda ishlashini Sozlamalardan o'zgartirasiz (standart 4).
Kitob boblari ham xuddi shunday — `write_chapters`.

### Token tejash

Bu ilova foydalanuvchining puliga ishlaydi, shuning uchun tejamkorlik
arxitekturada:

- **Vosita natijalari qisqartiriladi.**
- **Navbat tugagach vositalar tarixi o'chiriladi.** Xotira — fayllarning o'zi;
  kerak bo'lsa agent bitta faylni qayta o'qiydi.
- **System promptda loyihaning o'zi emas, ro'yxati turadi:**
  `index.html(2.1k) app.js(4.3k)`.
- **Chat oynasi cheklangan** (standart 24 xabar, sozlamalarda o'zgaradi).
- **Sub-agent konteksti kichik** — har biri faqat o'z darsini ko'radi, butun
  suhbatni emas.
- Kod chatga nusxalanmaydi — artifact kartasida turadi.

---

## Kodni olib chiqish: ZIP, GitHub, APK

**ZIP.** Har qanday ilovaning menyusida «Download the code» bor. Ichida:
loyiha fayllari, rasmlar, `README.md` va `.github/workflows/android.yml`.
Arxiv brauzerning o'zida yig'iladi (`CompressionStream`) — hech qanday
kutubxonasiz.

**GitHub.** Sozlamalarga GitHub tokeningizni qo'ysangiz, agentda
`github_push` vositasi paydo bo'ladi: «buni github'ga qo'y» desangiz,
repozitoriyni yaratadi va butun loyihani **bitta commit** bilan yuboradi
(blob → tree → commit → ref). Token qurilmadan chiqmaydi; so'rovlar
to'g'ridan-to'g'ri `api.github.com` ga ketadi.

**APK.** Brauzerda APK kompilyatsiya qilib bo'lmaydi — buni ochiq aytamiz.
Shuning uchun ZIP ichidagi GitHub Actions ish oqimi buni **GitHub'da**
bajaradi: repozitoriyni push qilasiz, **Actions → Build APK** ni bosasiz,
tugagach artefaktdan APK ni yuklab olasiz. U hosted manzilni Trusted Web
Activity ichiga o'raydi — APK kichik bo'ladi va saytni yangilaganingizda
ilova ham yangilanadi.

---

## Mini ilovalar qanday ishlaydi

Har bir ilova `sandbox="allow-scripts"` bo'lgan iframe ichida ishlaydi. Bu uni
**opaque origin**ga tushiradi: ilova asosiy sahifaga ham, API kalitingizga ham
yeta olmaydi.

Buning narxi — iframe ichida `localStorage` ishlamaydi. Shuning uchun o'rnini
bosuvchi qo'yiladi: sinxron, xotiradagi `Storage`, host tomonidan to'ldiriladi
va `postMessage` orqali qaytib saqlanadi. Ilova oddiygina
`localStorage.setItem(...)` yozadi va u haqiqatan saqlanadi —
`mini.appdata.<ilova-id>` ostida, faqat o'sha ilovaga tegishli.

Safari'da `localStorage` ni almashtirib bo'lmaydi, shuning uchun `compose()`
har bir skript ichidagi `localStorage` identifikatorini `__miniLS` ga
almashtiradi. Sahifa matnidagi «localStorage» so'ziga tegilmaydi.

### Kamera

Sandbox ichida `getUserMedia` ishlamaydi — bu origin bilan bog'liq cheklov.
Agent kamera kerak bo'lganda
`<input type="file" accept="image/*" capture="environment">` ishlatadi; u
sandboxda mukammal ishlaydi va iPhone'da to'g'ridan-to'g'ri kamerani ochadi.

Haqiqiy `getUserMedia` kerak bo'lsa, o'z ilovangiz sozlamasida «Kamera va
mikrofon» ni yoqasiz. **Diqqat:** bu iframe'ga `allow-same-origin` beradi,
ya'ni o'sha ilova API kalitingizni o'qiy oladi — ilova buni ochiq ogohlantirish
bilan so'raydi. **Marketdan o'rnatilgan ilovalarga bu hech qachon berilmaydi.**

### Ekranga qo'shish

Chrome `data:` manifestdan ilova o'rnatmaydi, bizda esa manifest yasab
beradigan server yo'q. Yechim: sahifa manifest va PNG belgilarni Cache
Storage'ga o'z originimizdagi manzil ostida yozadi (`m/<id>.webmanifest`,
`i/<id>-192.png`), service worker esa ularni server kabi qaytaradi. iOS
manifestga qaramaydi — u `apple-touch-icon` va sarlavhani jonli sahifadan
oladi, shuning uchun ular ham almashtiriladi.

Natija: har bir mini ilova telefon ekranida o'z nomi, o'z belgisi va to'liq
ekranda ochiladi.

---

## Xavfsizlik

- API kalit faqat `localStorage`da, faqat shu qurilmada. Serverga hech qachon
  yuborilmaydi — faqat siz ko'rsatgan API manziliga.
- Mini ilovalar opaque originda; kalitga ham, boshqa ilovaning ma'lumotiga ham
  yeta olmaydi.
- Marketdagi ilovalar mustaqil bo'lishi shart — tashqi kod yuklay olmaydi.
- Loyihada tashqi bog'liqlik yo'q — CDN ham, tracker ham, analitika ham.

---

## Sozlash

| Fayl | Nima |
| --- | --- |
| `app.css` → `:root` | ranglar, radius, tap o'lchami |
| `js/i18n.js` | tillar (uz, en, ru) |
| `js/store.js` → `DEFAULT_ROLES` | tayyor rollar |
| `js/agent.js` → `APP_PROMPT` / `COURSE_PROMPT` / `BOOK_PROMPT` | agent ko'rsatmalari |
| `js/subagent.js` → `LESSON_SYSTEM` / `CHAPTER_SYSTEM` | sub-agent ko'rsatmalari |
| `js/market.js` → `REVIEW_PROMPT` | market moderatorining ko'rsatmasi |
| `server/auth.js` → `WEAK` | qabul qilinmaydigan oddiy parollar |
| `assets/brand/logo-source.png` | logo; keyin `npm run icons` |

---

## Testlar

Eng nozik joylar — sandbox, service worker, orqaga tugmasi va market —
faqat haqiqiy brauzerda sinaladi. Testlar Chromium'ni haydaydi, o'z serverini
ko'taradi va pullik API o'rniga `test/mock-provider.mjs` bilan gaplashadi:

```bash
npx playwright install chromium     # bir marta
npm test
```

Tekshiriladi: agentning to'liq sikli (so'rov → fayl → tekshiruv → ekrandagi
ilova), yasalgan ilovaning haqiqatan ishlashi va ma'lumot saqlashi, sandboxdagi
birlashtirish va identifikator almashtirish, siniq ilovadagi xatoni topish,
ekran surati, suratning modelga qaytishi, har bir ilova uchun o'rnatiladigan
manifest, orqaga tugmasi, akkauntlar (ro'yxatdan o'tish, noto'g'ri parol,
sessiyaning saqlanishi, faolsizlik qoidasi, token imzosi), va marketning
to'liq yo'li — AI tekshiruvi, joylash, kunlik chegara, boshqa
foydalanuvchining o'rnatishi, ulashilgan havola, server validatsiyasi.

---

## Litsenziya

MIT — [LICENSE](LICENSE).

---

<details>
<summary><b>English</b></summary>

Accounts are a name, a username and a password — no email, so no reset, said
plainly rather than pretended away. Passwords are scrypt-hashed; sessions are
stateless HMAC tokens, so browsing costs no lookup. An account unused for 30
days is deleted; apps it published stay in the market, because other people
installed them. A mini app already on the home screen opens without signing in.

Mini is a mobile-first AI that builds you small apps. Ask for a calculator; the
agent writes it, runs it in a hidden sandbox, reads back its own errors, fixes
them, and pins the finished app to your phone's home screen with its own name
and icon. Publish it to the **Market** and the AI reviews it, files it under a
category (inventing one if none fits), and anyone can install it in one tap —
one publish per person per day.

No accounts, no build step, no database. Bring your own API key, pick any
model; chats and apps live in `localStorage` on your phone.

The server is deliberately tiny. The whole catalogue is one gzipped JSON blob
rebuilt on write and served with an ETag; each app bundle is addressed by a
content hash and cached forever; review runs on the submitter's own model;
install counts are batched. Model traffic never touches the origin at all.

Market apps must be self-contained — no external scripts, styles or network
calls — which keeps them working offline and stops a reviewed app from
changing under its users.

```bash
cd mini && npm start        # app + market on :8080
npm test                    # 83 checks in a real Chromium
```

MIT licensed.
</details>
