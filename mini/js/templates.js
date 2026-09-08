/**
 * The shells for courses and books.
 *
 * A twenty-lesson course is far too much for a model to write as one file, and
 * asking it to re-invent a lesson player each time is both expensive and
 * unreliable. So the player is ours and the content is the model's: it writes
 * an outline and then one lesson body at a time, and these functions assemble
 * a finished, self-contained app around them.
 *
 * That split is what makes a course affordable. It also means every course
 * gets the same working progress tracking, the same quiz behaviour and the
 * same print stylesheet, however good the model was on the day.
 */

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
const escScript = s => String(s ?? '').replace(/<\/script/gi, '<\\/script');

/* ------------------------------------------------------------ shared css */

const BASE_CSS = accent => `
:root{
  --accent:${accent};
  --bg:#faf9f8; --card:#fff; --line:#e7e5e3; --text:#17161a; --muted:#6d6a72;
  --radius:16px; --measure:34rem;
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  --serif:Georgia,"Iowan Old Style","Times New Roman",serif;
}
@media (prefers-color-scheme:dark){
  :root{ --bg:#0e0e10; --card:#17171a; --line:#2a2a2f; --text:#f2f1f4; --muted:#95939c }
}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{margin:0;background:var(--bg);color:var(--text)}
body{font-family:var(--sans);font-size:17px;line-height:1.65;-webkit-font-smoothing:antialiased}
button{font:inherit;color:inherit;background:none;border:0;cursor:pointer}
a{color:var(--accent)}
img{max-width:100%;border-radius:12px;display:block}
.wrap{max-width:var(--measure);margin:0 auto;padding:0 20px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;
  padding:13px 20px;border-radius:999px;background:var(--accent);color:#fff;font-weight:600;
  min-height:44px}
.btn.ghost{background:var(--card);color:var(--text);border:1px solid var(--line)}
.btn:active{transform:scale(.98)}
.bar{height:6px;border-radius:99px;background:var(--line);overflow:hidden}
.bar i{display:block;height:100%;background:var(--accent);transition:width .35s ease}
`;

/* Interactive blocks a lesson or chapter may use. The model writes the markup;
   this stylesheet and the script below make it behave. */
const BLOCK_CSS = `
.key,.tip,.warn{border-radius:var(--radius);padding:14px 16px;margin:20px 0;
  background:var(--card);border:1px solid var(--line);border-left:3px solid var(--accent)}
.tip{border-left-color:#2f9e6b} .warn{border-left-color:#d98324}
.key b,.tip b,.warn b{display:block;margin-bottom:4px;font-size:14px;letter-spacing:.02em;
  text-transform:uppercase;color:var(--muted)}
blockquote{margin:22px 0;padding:4px 0 4px 18px;border-left:3px solid var(--line);
  color:var(--muted);font-style:italic}
table{width:100%;border-collapse:collapse;margin:20px 0;font-size:15.5px}
th,td{padding:9px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
th{font-size:13px;text-transform:uppercase;letter-spacing:.03em;color:var(--muted)}
pre{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px;
  overflow-x:auto;font-size:13.5px;line-height:1.55}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.88em}
:not(pre)>code{background:var(--card);border:1px solid var(--line);padding:1px 5px;border-radius:6px}

.q{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);
  padding:16px;margin:22px 0}
.q>p:first-child{margin-top:0;font-weight:600}
.q ul{list-style:none;margin:12px 0 0;padding:0;display:flex;flex-direction:column;gap:8px}
.q li{border:1px solid var(--line);border-radius:12px;padding:12px 14px;cursor:pointer;
  transition:background .12s,border-color .12s;min-height:44px;display:flex;align-items:center}
.q li:active{background:var(--bg)}
.q li.right{border-color:#2f9e6b;background:rgba(47,158,107,.10)}
.q li.wrong{border-color:#d9534f;background:rgba(217,83,79,.10)}
.q .why{margin:12px 0 0;font-size:15px;color:var(--muted);display:none}
.q.answered .why{display:block}
.q.answered li{cursor:default}

.fill{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);
  padding:16px;margin:22px 0}
.fill input{font:inherit;padding:9px 12px;border-radius:10px;border:1px solid var(--line);
  background:var(--bg);color:var(--text);min-width:8em;margin:0 4px}
.fill input.right{border-color:#2f9e6b}
.fill input.wrong{border-color:#d9534f}

.card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);
  padding:20px;margin:22px 0;text-align:center;cursor:pointer;min-height:110px;
  display:flex;align-items:center;justify-content:center}
.card .back{display:none;color:var(--muted)}
.card.flipped .front{display:none}
.card.flipped .back{display:block}
`;

const BLOCK_JS = `
(function(){
  document.addEventListener('click', function(e){
    var li = e.target.closest('.q li');
    if (li) {
      var q = li.closest('.q');
      if (q.classList.contains('answered')) return;
      var want = Number(q.dataset.a);
      var items = [].slice.call(q.querySelectorAll('li'));
      items.forEach(function(el, i){ if (i === want) el.classList.add('right'); });
      if (items.indexOf(li) !== want) li.classList.add('wrong');
      q.classList.add('answered');
      if (window.__progress) window.__progress.answered(q);
      return;
    }
    var card = e.target.closest('.card');
    if (card) card.classList.toggle('flipped');
  });
  document.addEventListener('input', function(e){
    var input = e.target;
    if (!input.matches('.fill input')) return;
    var want = (input.closest('.fill').dataset.a || '').trim().toLowerCase();
    var got = input.value.trim().toLowerCase();
    input.classList.toggle('right', !!got && got === want);
    input.classList.toggle('wrong', !!got && got !== want && got.length >= want.length);
  });
})();
`;

/** Turns `<div class="fill" data-a="went">I ___ home.</div>` into a real input. */
const FILL_JS = `
(function(){
  [].forEach.call(document.querySelectorAll('.fill'), function(el){
    if (el.dataset.ready) return;
    el.dataset.ready = '1';
    el.innerHTML = el.innerHTML.replace(/_{2,}/, '<input type="text" autocapitalize="off" autocomplete="off">');
  });
})();
`;

/* ---------------------------------------------------------------- course */

/**
 * @param course {{title, subtitle, accent, modules:[{title, lessons:[{id,title,minutes}]}]}}
 * @param lessons {Object<string,string>} lesson id -> HTML body
 */
export function buildCourse(course, lessons) {
  const accent = /^#[0-9a-f]{6}$/i.test(course.accent || '') ? course.accent : '#E8171F';
  const modules = course.modules || [];
  const flat = modules.flatMap((m, mi) => (m.lessons || []).map(l => ({ ...l, module: m.title, mi })));
  const total = flat.length;

  const toc = modules.map((m, mi) => `
    <section class="mod">
      <h3>${esc(m.title)}</h3>
      <ol>${(m.lessons || []).map(l => `
        <li><button class="lesson-link" data-id="${esc(l.id)}">
          <span class="tick" data-tick="${esc(l.id)}"></span>
          <span class="ln">${esc(l.title)}</span>
          ${l.minutes ? `<span class="mins">${esc(l.minutes)}m</span>` : ''}
        </button></li>`).join('')}</ol>
    </section>`).join('');

  const bodies = flat.map(l => `
    <template data-lesson="${esc(l.id)}">${escScript(lessons[l.id] || '<p>—</p>')}</template>`).join('');

  // Printing must work with scripts stripped, so the print copy is written out
  // here rather than assembled on demand.
  const printBody = flat.map((l, i) => `
    <article><h1>${esc(l.title)}</h1>
    <p class="crumb">${esc(l.module || '')} · ${i + 1} / ${total}</p>
    ${lessons[l.id] || ''}</article>`).join('');

  return `<!doctype html>
<html lang="${esc(course.language || 'en')}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(course.title)}</title>
<style>
${BASE_CSS(accent)}
${BLOCK_CSS}
header.top{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:10px;
  padding:calc(env(safe-area-inset-top,0px) + 10px) 16px 10px;
  background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:blur(14px);
  border-bottom:1px solid transparent}
header.top.edge{border-bottom-color:var(--line)}
header.top .t{flex:1;min-width:0;font-weight:600;font-size:15px;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap}
.icon{width:40px;height:40px;border-radius:12px;display:grid;place-items:center;flex:none}
.icon svg{width:22px;height:22px;fill:none;stroke:currentColor;stroke-width:1.9;
  stroke-linecap:round;stroke-linejoin:round}
main{padding:0 0 100px}

.hero{padding:34px 20px 26px;text-align:center}
.hero h1{margin:0 0 8px;font-size:30px;line-height:1.2;letter-spacing:-.02em}
.hero p{margin:0 auto 22px;color:var(--muted);max-width:30rem}
.hero .bar{max-width:22rem;margin:0 auto 10px}
.hero .pc{color:var(--muted);font-size:13.5px}

.mod{margin:26px 0}
.mod h3{margin:0 0 10px;font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.mod ol{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.lesson-link{display:flex;align-items:center;gap:12px;width:100%;text-align:left;
  padding:13px 14px;border-radius:14px;background:var(--card);border:1px solid var(--line);
  min-height:52px}
.lesson-link:active{transform:scale(.995)}
.lesson-link .ln{flex:1;min-width:0}
.lesson-link .mins{color:var(--muted);font-size:13px;flex:none}
.tick{width:22px;height:22px;border-radius:50%;border:2px solid var(--line);flex:none;
  display:grid;place-items:center;font-size:12px;color:#fff}
.tick.on{background:var(--accent);border-color:var(--accent)}
.tick.on::after{content:"✓"}

article{padding:8px 0 30px}
article h1{font-size:26px;line-height:1.25;margin:0 0 6px;letter-spacing:-.02em}
article .crumb{color:var(--muted);font-size:13.5px;margin-bottom:22px}
article h2{font-size:20px;margin:30px 0 10px;letter-spacing:-.01em}
article h3{font-size:17px;margin:24px 0 8px}
article p{margin:0 0 16px}
article ul,article ol{margin:0 0 16px;padding-left:1.3em}
article li{margin:6px 0}
article li::marker{color:var(--accent)}

.nav{display:flex;gap:10px;padding:24px 0 0}
.nav .btn{flex:1}
.done-bar{position:fixed;left:0;right:0;bottom:0;padding:12px 20px calc(env(safe-area-inset-bottom,0px) + 14px);
  background:linear-gradient(to top,var(--bg) 70%,transparent);display:flex;gap:10px}
.done-bar .btn{flex:1}
[hidden]{display:none!important}

@media print{
  header.top,.done-bar,.nav,.icon,#home,#reader{display:none!important}
  body{background:#fff;color:#000;font-size:11pt}
  .print-all{display:block!important}
  .print-all article{page-break-after:always;padding:0 0 20pt}
  .q li.right{background:none}
  @page{margin:18mm 16mm}
}
.print-all{display:none}
</style>
</head>
<body>

<header class="top" id="top">
  <button class="icon" id="back" hidden aria-label="Back">
    <svg viewBox="0 0 24 24"><path d="M15 19l-7-7 7-7"/></svg>
  </button>
  <div class="t" id="crumb">${esc(course.title)}</div>
  <button class="icon" id="print" aria-label="Print">
    <svg viewBox="0 0 24 24"><path d="M7 9V3h10v6M7 19H5a2 2 0 01-2-2v-4a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2h-2M7 15h10v6H7z"/></svg>
  </button>
</header>

<main>
  <section id="home">
    <div class="hero">
      <h1>${esc(course.title)}</h1>
      ${course.subtitle ? `<p>${esc(course.subtitle)}</p>` : ''}
      <div class="bar"><i id="hbar" style="width:0"></i></div>
      <div class="pc" id="hpc"></div>
      <div style="margin-top:20px"><button class="btn" id="continue">Start</button></div>
    </div>
    <div class="wrap">${toc}</div>
  </section>

  <section id="reader" hidden><div class="wrap"><article id="body"></article>
    <div class="wrap nav" style="padding-left:0;padding-right:0">
      <button class="btn ghost" id="prev">Previous</button>
      <button class="btn" id="next">Next</button>
    </div></div>
  </section>

  <div class="print-all" id="printall">
    <h1>${esc(course.title)}</h1>
    ${course.subtitle ? `<p>${esc(course.subtitle)}</p>` : ''}
    ${printBody}
  </div>
</main>

${bodies}

<script>
${BLOCK_JS}
var COURSE = ${escScript(JSON.stringify({ title: course.title, flat: flat.map(l => ({ id:l.id, title:l.title, module:l.module })) }))};
var KEY = 'course:' + COURSE.title;
var done = {};
try { done = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) {}

var $ = function(s){ return document.querySelector(s); };
var current = -1;

function save(){ try { localStorage.setItem(KEY, JSON.stringify(done)); } catch (e) {} }

function refresh(){
  var n = 0;
  COURSE.flat.forEach(function(l){
    var el = document.querySelector('[data-tick="' + l.id + '"]');
    if (done[l.id]) { n++; if (el) el.classList.add('on'); }
    else if (el) el.classList.remove('on');
  });
  var pct = COURSE.flat.length ? Math.round(n / COURSE.flat.length * 100) : 0;
  $('#hbar').style.width = pct + '%';
  $('#hpc').textContent = n + ' of ' + COURSE.flat.length + ' lessons · ' + pct + '%';
  var nextIdx = COURSE.flat.findIndex(function(l){ return !done[l.id]; });
  $('#continue').textContent = n === 0 ? 'Start' : (nextIdx < 0 ? 'Review' : 'Continue');
}

function open(i){
  if (i < 0 || i >= COURSE.flat.length) return;
  current = i;
  var l = COURSE.flat[i];
  var tpl = document.querySelector('[data-lesson="' + l.id + '"]');
  $('#body').innerHTML = '<h1>' + l.title.replace(/&/g,'&amp;').replace(/</g,'&lt;') + '</h1>' +
    '<div class="crumb">' + (l.module || '').replace(/</g,'&lt;') + ' · ' + (i + 1) + ' / ' + COURSE.flat.length + '</div>' +
    (tpl ? tpl.innerHTML : '');
  ${'$'}('#home').hidden = true; ${'$'}('#reader').hidden = false;
  ${'$'}('#back').hidden = false; ${'$'}('#crumb').textContent = l.title;
  ${'$'}('#prev').disabled = i === 0;
  ${'$'}('#next').textContent = i === COURSE.flat.length - 1 ? 'Finish' : 'Next';
  window.scrollTo(0, 0);
  ${FILL_JS}
}

function home(){
  current = -1;
  $('#reader').hidden = true; $('#home').hidden = false;
  $('#back').hidden = true; $('#crumb').textContent = COURSE.title;
  refresh(); window.scrollTo(0, 0);
}

document.addEventListener('click', function(e){
  var link = e.target.closest('.lesson-link');
  if (link) {
    var idx = COURSE.flat.findIndex(function(l){ return l.id === link.dataset.id; });
    open(idx);
  }
});
$('#back').onclick = home;
$('#prev').onclick = function(){ open(current - 1); };
$('#next').onclick = function(){
  done[COURSE.flat[current].id] = 1; save();
  if (current === COURSE.flat.length - 1) home(); else open(current + 1);
};
$('#continue').onclick = function(){
  var i = COURSE.flat.findIndex(function(l){ return !done[l.id]; });
  open(i < 0 ? 0 : i);
};
$('#print').onclick = function(){ window.print(); };
addEventListener('scroll', function(){ $('#top').classList.toggle('edge', scrollY > 4); }, { passive:true });

refresh();
<\/script>
</body>
</html>`;
}

/* ------------------------------------------------------------------ book */

/**
 * @param book {{title, author, subtitle, accent, coverSvg, chapters:[{id,title}]}}
 * @param chapters {Object<string,string>} chapter id -> HTML body
 */
export function buildBook(book, chapters) {
  const accent = /^#[0-9a-f]{6}$/i.test(book.accent || '') ? book.accent : '#B00811';
  const list = book.chapters || [];

  const cover = book.coverSvg
    ? `<div class="cover-art">${book.coverSvg}</div>`
    : `<div class="cover-art fallback"><div><b>${esc(book.title)}</b><i>${esc(book.author || '')}</i></div></div>`;

  const toc = list.map((c, i) => `
    <li><button class="ch-link" data-id="${esc(c.id)}">
      <span class="n">${i + 1}</span><span class="ct">${esc(c.title)}</span>
    </button></li>`).join('');

  const bodies = list.map(c => `
    <template data-ch="${esc(c.id)}">${escScript(chapters[c.id] || '<p>—</p>')}</template>`).join('');

  const printBody = list.map((c, i) => `
    <section class="pchap"><h1><span>Chapter ${i + 1}</span>${esc(c.title)}</h1>
    ${chapters[c.id] || ''}</section>`).join('');

  return `<!doctype html>
<html lang="${esc(book.language || 'en')}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(book.title)}</title>
<style>
${BASE_CSS(accent)}
${BLOCK_CSS}
body{font-family:var(--serif);font-size:var(--fs,18px);line-height:1.72}
header.top{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:8px;
  padding:calc(env(safe-area-inset-top,0px) + 10px) 14px 10px;font-family:var(--sans);
  background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:blur(14px);
  border-bottom:1px solid transparent}
header.top.edge{border-bottom-color:var(--line)}
header.top .t{flex:1;min-width:0;font-weight:600;font-size:14.5px;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap}
.icon{width:40px;height:40px;border-radius:12px;display:grid;place-items:center;flex:none}
.icon svg{width:21px;height:21px;fill:none;stroke:currentColor;stroke-width:1.9;
  stroke-linecap:round;stroke-linejoin:round}

.cover{padding:26px 20px 34px;text-align:center;font-family:var(--sans)}
.cover-art{max-width:280px;margin:0 auto 24px;aspect-ratio:2/3;border-radius:10px;overflow:hidden;
  box-shadow:0 18px 44px rgba(0,0,0,.30)}
.cover-art svg{width:100%;height:100%;display:block}
.cover-art.fallback{background:linear-gradient(150deg,var(--accent),#2b0407);color:#fff;
  display:grid;place-items:center;padding:26px}
.cover-art.fallback b{display:block;font-size:24px;line-height:1.2;font-weight:700}
.cover-art.fallback i{display:block;margin-top:12px;font-style:normal;opacity:.8;font-size:14px}
.cover h1{margin:0 0 4px;font-size:27px;letter-spacing:-.02em;font-family:var(--serif)}
.cover .by{color:var(--muted);font-size:15px}
.cover .sub{color:var(--muted);margin:14px auto 0;max-width:28rem;font-size:15.5px}

.toc{font-family:var(--sans)}
.toc h3{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:0 0 10px}
.toc ol{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px}
.ch-link{display:flex;gap:14px;width:100%;text-align:left;padding:13px 6px;border-radius:12px;
  align-items:baseline;min-height:48px}
.ch-link:active{background:var(--card)}
.ch-link .n{color:var(--accent);font-variant-numeric:tabular-nums;font-weight:600;min-width:1.6em}
.ch-link .ct{flex:1}

article{padding:10px 0 40px}
article h1{font-size:27px;line-height:1.24;margin:0 0 26px;letter-spacing:-.02em}
article h1 span{display:block;font-family:var(--sans);font-size:12.5px;letter-spacing:.09em;
  text-transform:uppercase;color:var(--accent);margin-bottom:8px}
article h2{font-size:20px;margin:32px 0 10px}
article p{margin:0 0 18px}
article p:first-of-type::first-letter{float:left;font-size:3.1em;line-height:.86;
  padding:.05em .09em 0 0;color:var(--accent);font-weight:700}
article ul,article ol{margin:0 0 18px;padding-left:1.3em}
.nav{display:flex;gap:10px;padding:10px 0 0;font-family:var(--sans)}
.nav .btn{flex:1}
.sizer{display:flex;gap:6px;font-family:var(--sans)}
[hidden]{display:none!important}

@media print{
  header.top,.nav,.icon,.sizer,#home,#reader{display:none!important}
  .print-book{display:block!important}
  body{background:#fff;color:#000;font-size:11.5pt;line-height:1.55}
  .pcover{page-break-after:always;text-align:center;padding-top:28vh}
  .pcover h1{font-size:30pt;margin:0 0 10pt}
  .pcover .by{font-size:13pt;color:#444}
  .ptoc{page-break-after:always}
  .pchap{page-break-before:always}
  .pchap h1{font-size:20pt;margin:0 0 18pt}
  .pchap h1 span{display:block;font-size:9pt;letter-spacing:.1em;text-transform:uppercase;color:#666}
  p:first-of-type::first-letter{float:none;font-size:inherit;padding:0;color:inherit;font-weight:inherit}
  a{color:#000;text-decoration:none}
  @page{margin:22mm 20mm;size:A5}
}
.print-book{display:none}
</style>
</head>
<body>

<header class="top" id="top">
  <button class="icon" id="back" hidden aria-label="Back">
    <svg viewBox="0 0 24 24"><path d="M15 19l-7-7 7-7"/></svg>
  </button>
  <div class="t" id="crumb">${esc(book.title)}</div>
  <div class="sizer">
    <button class="icon" id="smaller" aria-label="Smaller text">A−</button>
    <button class="icon" id="bigger" aria-label="Larger text">A+</button>
    <button class="icon" id="print" aria-label="Print">
      <svg viewBox="0 0 24 24"><path d="M7 9V3h10v6M7 19H5a2 2 0 01-2-2v-4a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2h-2M7 15h10v6H7z"/></svg>
    </button>
  </div>
</header>

<main>
  <section id="home">
    <div class="cover">
      ${cover}
      <h1>${esc(book.title)}</h1>
      <div class="by">${esc(book.author || '')}</div>
      ${book.subtitle ? `<div class="sub">${esc(book.subtitle)}</div>` : ''}
    </div>
    <div class="wrap toc"><h3>Contents</h3><ol>${toc}</ol></div>
  </section>

  <section id="reader" hidden>
    <div class="wrap"><article id="body"></article>
      <div class="nav"><button class="btn ghost" id="prev">Previous</button>
      <button class="btn" id="next">Next</button></div>
    </div>
  </section>

  <div class="print-book" id="printbook">
    <div class="pcover"><h1>${esc(book.title)}</h1><div class="by">${esc(book.author || '')}</div></div>
    <div class="ptoc"><h2>Contents</h2><ol>${list.map(c => `<li>${esc(c.title)}</li>`).join('')}</ol></div>
    ${printBody}
  </div>
</main>

${bodies}

<script>
${BLOCK_JS}
var BOOK = ${escScript(JSON.stringify({ title: book.title, chapters: list.map(c => ({ id:c.id, title:c.title })) }))};
var KEY = 'book:' + BOOK.title;
var $ = function(s){ return document.querySelector(s); };
var current = -1, fs = 18;
try { fs = Number(localStorage.getItem(KEY + ':fs')) || 18; } catch (e) {}
document.documentElement.style.setProperty('--fs', fs + 'px');

function open(i){
  if (i < 0 || i >= BOOK.chapters.length) return;
  current = i;
  var c = BOOK.chapters[i];
  var tpl = document.querySelector('[data-ch="' + c.id + '"]');
  $('#body').innerHTML = '<h1><span>Chapter ' + (i + 1) + '</span>' +
    c.title.replace(/&/g,'&amp;').replace(/</g,'&lt;') + '</h1>' + (tpl ? tpl.innerHTML : '');
  $('#home').hidden = true; $('#reader').hidden = false;
  $('#back').hidden = false; $('#crumb').textContent = c.title;
  $('#prev').disabled = i === 0;
  $('#next').disabled = i === BOOK.chapters.length - 1;
  try { localStorage.setItem(KEY, String(i)); } catch (e) {}
  window.scrollTo(0, 0);
  ${FILL_JS}
}
function home(){
  current = -1;
  $('#reader').hidden = true; $('#home').hidden = false;
  $('#back').hidden = true; $('#crumb').textContent = BOOK.title;
  window.scrollTo(0, 0);
}
document.addEventListener('click', function(e){
  var link = e.target.closest('.ch-link');
  if (link) open(BOOK.chapters.findIndex(function(c){ return c.id === link.dataset.id; }));
});
$('#back').onclick = home;
$('#prev').onclick = function(){ open(current - 1); };
$('#next').onclick = function(){ open(current + 1); };
$('#print').onclick = function(){ window.print(); };
function setSize(d){
  fs = Math.max(14, Math.min(26, fs + d));
  document.documentElement.style.setProperty('--fs', fs + 'px');
  try { localStorage.setItem(KEY + ':fs', String(fs)); } catch (e) {}
}
$('#bigger').onclick = function(){ setSize(1); };
$('#smaller').onclick = function(){ setSize(-1); };
addEventListener('scroll', function(){ $('#top').classList.toggle('edge', scrollY > 4); }, { passive:true });
<\/script>
</body>
</html>`;
}
