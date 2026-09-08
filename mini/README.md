# Mini

**Cho'ntagingizdagi AI. O'zingizga mini ilovalar yasang.**

Mini — telefon uchun yasalgan, juda sodda AI chat. Undan ilova so'raysiz — u
yozadi, brauzerda ishga tushirib tekshiradi, xatolarini o'zi tuzatadi va tayyor
ilovani telefoningiz ekraniga o'z nomi va belgisi bilan qo'shib beradi.

Server yo'q. Ro'yxatdan o'tish yo'q. Ma'lumotlaringiz shu qurilmadan chiqmaydi.
Siz o'zingizning API kalitingizni kiritasiz va so'rovlar to'g'ridan-to'g'ri
o'zingiz tanlagan provayderga ketadi.

```
mini/
  index.html          bitta sahifa — butun ilova
  app.css             dizayn (tungi/kunduzgi, safe-area, katta tugmalar)
  sw.js               offline + har bir mini ilova uchun manifest
  manifest.webmanifest
  js/
    store.js          localStorage: chatlar, ilovalar, sozlamalar
    llm.js            OpenAI-shaklidagi streaming klient
    agent.js          bir navbatning to'liq sikli
    tools.js          agentning 6 ta vositasi
    sandbox.js        mini ilova ishlaydigan izolyatsiya + o'z-o'zini test
    icons.js          belgi chizish + ekranga qo'shish
    md.js  i18n.js    markdown, uz/en/ru
    ui/               chat, drawer, sheetlar, ilovalar ekrani
```

---

## Ishga tushirish

Build yo'q, bog'liqlik yo'q. Shunchaki statik fayllarni bering:

```bash
cd mini
python3 -m http.server 8000        # yoki: npx serve .
```

`http://localhost:8000` ni oching. Ishlab chiqarish uchun ham xuddi shunday —
`mini/` papkasini har qanday statik hostingga qo'ying:

**nginx**
```nginx
server {
  listen 443 ssl;
  server_name mini.example.com;
  root /var/www/mini;
  location / { try_files $uri $uri/ /index.html; }
  location = /sw.js { add_header Cache-Control "no-cache"; }
}
```

**Caddy**
```
mini.example.com {
  root * /var/www/mini
  try_files {path} /index.html
  file_server
}
```

GitHub Pages, Netlify, Vercel, Cloudflare Pages — hammasi ishlaydi.
Yagona shart: **HTTPS**, aks holda service worker va «ekranga o'rnatish»
ishlamaydi (`localhost` bundan mustasno).

---

## Foydalanuvchi nima qiladi

1. Saytga kiradi → «Ilovani ekranga o'rnatish» chiqadi. iPhone'da
   *Ulashish → Bosh ekranga qo'shish*, Android'da bitta tugma.
2. Sozlamalarga o'z API kalitini qo'yadi (OpenRouter, Groq, OpenAI yoki
   `/chat/completions` gapiradigan istalgan manzil) va modelni tanlaydi.
3. Rol tanlaydi: Ilova yasovchi, Dizayner, Dasturchi, Matn, Suhbat — yoki
   o'zi yangi rol yaratadi.
4. «Kalkulyator yasab ber» deydi. Agent yozadi, tekshiradi, tuzatadi, saqlaydi.
5. Tayyor ilovani bosib ochadi yoki telefon ekraniga alohida belgi qilib
   qo'shadi.

---

## Agent qanday ishlaydi

Oltita vosita, boshqa hech narsa:

| Vosita | Vazifasi |
| --- | --- |
| `write_file` | fayl yozish |
| `edit_file` | faylning bir parchasini almashtirish |
| `read_file` | o'qish (yoki fayllar ro'yxati) |
| `run_check` | ilovani ishga tushirib xato, tugma va joylashuvni tekshirish |
| `screenshot` | ekran suratini olib, ko'rish |
| `publish_app` | foydalanuvchi ekraniga qo'shish |

`run_check` haqiqiy tekshiruv: ilova yashirin iframe'da ishga tushadi, JS
xatolari, `console.error`, yuklanmagan rasmlar yig'iladi, ko'rinadigan
tugmalar bosib ko'riladi, gorizontal scroll va ekrandan chiqib ketgan
elementlar sanaladi. Natija ~1 KB matn bo'lib qaytadi — agent shuni o'qib
tuzatadi.

`screenshot` esa sahifani SVG `foreignObject` orqali JPEG'ga aylantiradi va
modelga rasm sifatida qaytaradi. Kutubxona ham, tarmoq ham kerak emas.

### Token tejash

Bu ilova sizning pulingizga ishlaydi, shuning uchun tejamkorlik arxitekturaga
kiritilgan:

- **Vositalar natijasi qisqartiriladi** — `run_check` hisoboti 1600 belgigacha.
- **Navbat tugagach vositalar tarixi o'chiriladi.** Xotira — bu fayllarning
  o'zi; agentga kerak bo'lsa bitta faylni qayta o'qiydi.
- **System promptda loyihaning o'zi emas, ro'yxati turadi:**
  `index.html(2.1k) style.css(0.4k)`.
- **Chat oynasi cheklangan** (sozlamalarda o'zgartiriladi, standart 24 xabar).
- Kod chatga nusxalanmaydi — u artifact kartasida turadi.

---

## Mini ilovalar qanday ishlaydi

Har bir ilova `sandbox="allow-scripts"` bo'lgan iframe ichida ishlaydi. Bu
uni **opaque origin**ga tushiradi: ilova asosiy sahifaga ham, sizning API
kalitingizga ham yeta olmaydi.

Buning narxi — iframe ichida `localStorage` ishlamaydi. Shuning uchun ilovaga
o'rnini bosuvchi qo'yiladi: sinxron, xotiradagi `Storage`, host tomonidan
to'ldiriladi va `postMessage` orqali qaytib saqlanadi. Ilova oddiygina
`localStorage.setItem(...)` yozadi va u haqiqatan saqlanadi —
`mini.appdata.<ilova-id>` kalitida, faqat o'sha ilovaga tegishli.

Ba'zi brauzerlarda (Safari) `localStorage` ni almashtirib bo'lmaydi, shuning
uchun `compose()` har bir skript ichidagi `localStorage` identifikatorini
`__miniLS` ga almashtiradi. Sahifa matnidagi «localStorage» so'ziga tegilmaydi.

### Kamera

Sandbox ichida `getUserMedia` ishlamaydi — bu origin bilan bog'liq cheklov.
Shuning uchun agent kamera kerak bo'lganda
`<input type="file" accept="image/*" capture="environment">` ishlatadi; u
sandboxda mukammal ishlaydi va iPhone'da to'g'ridan-to'g'ri kamerani ochadi.

Agar sizga haqiqatan `getUserMedia` kerak bo'lsa, ilova sozlamasida
«Kamera va mikrofon» ni yoqishingiz mumkin. **Diqqat:** bu iframe'ga
`allow-same-origin` beradi, ya'ni o'sha ilova sizning API kalitingizni o'qiy
oladi. Ilova ishonchli bo'lsagina yoqing — ilova buni ochiq ogohlantirish
bilan so'raydi.

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

- API kalit faqat `localStorage`da, faqat shu qurilmada. Hech qaerga
  yuborilmaydi — faqat siz ko'rsatgan API manziliga.
- Mini ilovalar opaque originda; kalitga ham, boshqa ilovalarning
  ma'lumotiga ham yeta olmaydi (yuqoridagi «Kamera» bandi bundan mustasno).
- Ilova ma'lumoti har biriga alohida `mini.appdata.<id>` ostida.
- Loyihada tashqi bog'liqlik yo'q — CDN ham, tracker ham, analitika ham.

---

## Sozlash

`js/i18n.js` — tillar (uz, en, ru). Yangi til qo'shish uchun jadvalga bitta
obyekt qo'shing.

`js/store.js` → `DEFAULT_ROLES` — tayyor rollar.

`js/agent.js` → `BUILDER_PROMPT` — agentning asosiy ko'rsatmasi.

`app.css` → `:root` — ranglar, radius, tap o'lchami. Bitta urg'u rangi
(`--accent`) butun ilovani boshqaradi.

Belgilarni qayta chizish uchun:

```bash
python3 scripts/gen-mini-icons.py
```

---

## Testlar

Eng nozik joylar — sandbox, service worker va orqaga tugmasi — faqat haqiqiy
brauzerda sinaladi. Shuning uchun testlar Chromium'ni haydaydi va pullik API
o'rniga `test/mock-provider.mjs` bilan gaplashadi:

```bash
npx playwright install chromium     # bir marta
node test/run.mjs
```

Nimalar tekshiriladi: agentning to'liq sikli (so'rov → fayl → tekshiruv →
ekrandagi ilova), yasalgan ilovaning haqiqatan ishlashi va ma'lumot saqlashi,
sandboxdagi CSS/JS/rasm birlashtirish va identifikator almashtirish, siniq
ilovadagi xatoni topish, ekran surati, suratning modelga qaytishi, har bir
ilova uchun o'rnatiladigan manifest, va orqaga tugmasining har qatlamni
navbat bilan yopishi.

---

## Litsenziya

MIT — [LICENSE](LICENSE).

---

<details>
<summary><b>English</b></summary>

Mini is a mobile-first AI chat that builds you small apps. Ask for a
calculator; the agent writes it, runs it in a hidden sandbox, reads back the
errors, fixes them, and pins the finished app to your phone's home screen with
its own name and icon.

No server, no accounts, no build step — static files and `localStorage`. You
bring your own API key (OpenRouter by default, or anything that speaks
`/chat/completions`) and pick any model.

Serve the `mini/` folder over HTTPS and it works: install prompt on Android,
Add to Home Screen on iOS, offline shell via service worker.

Generated apps run on an opaque origin, so they cannot read your API key. A
storage shim gives them a working `localStorage` bridged back to the host and
namespaced per app. Camera work uses `<input capture>`, which the sandbox
allows; real `getUserMedia` is an explicit, warned opt-in per app.

Token economy is a design constraint: tool output is clipped, a turn's tool
traffic is discarded once the turn ends, the system prompt carries a file
inventory rather than the files, and the request window is bounded.

MIT licensed.
</details>
