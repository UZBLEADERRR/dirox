/**
 * A scripted, OpenAI-compatible provider.
 *
 * The agent loop is the part of this app most likely to break quietly, and it
 * cannot be exercised against a real model without spending money and getting
 * a different answer every run. So this server plays one fixed build: write a
 * calculator, check it, (optionally look at it), publish it, say a sentence.
 * Ask for a "surat" and the screenshot step is added, which is how the vision
 * round trip gets tested.
 */
import http from 'node:http';
import fs from 'node:fs';

const PORT = Number(process.env.MOCK_PORT || 8900);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
};

const APP_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Kalkulyator</title>
<style>body{font:16px system-ui;margin:0;padding:16px;background:#111;color:#fff}
#out{font-size:34px;text-align:right;padding:12px;min-height:44px}
button{width:100%;height:56px;border-radius:12px;border:0;background:#222;color:#fff;font-size:20px}
.g{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}</style></head>
<body><div id="out">0</div><div class="g" id="pad"></div>
<script>
var keys="789/456*123-0.=+".split(""),exp=localStorage.getItem("exp")||"";
var out=document.getElementById("out"),pad=document.getElementById("pad");
function draw(){out.textContent=exp||"0";localStorage.setItem("exp",exp)}
keys.forEach(function(k){var b=document.createElement("button");b.textContent=k;
b.onclick=function(){ if(k==="="){ try{exp=String(eval(exp))}catch(e){exp="xato"} } else exp+=k; draw(); };
pad.appendChild(b)});
draw();
<\/script></body></html>`;

function sse(res, chunks) {
  res.writeHead(200, { ...CORS, 'Content-Type':'text/event-stream', 'Cache-Control':'no-cache' });
  let i = 0;
  const tick = () => {
    if (i >= chunks.length) { res.write('data: [DONE]\n\n'); return res.end(); }
    res.write('data: ' + JSON.stringify(chunks[i++]) + '\n\n');
    setTimeout(tick, 8);
  };
  tick();
}

const textChunks = (s) => [...s].map(ch => ({ choices:[{ delta:{ content:ch } }] }));
const toolChunk = (name, args) => ({ choices:[{ delta:{ tool_calls:[
  { index:0, id:'call_' + name, type:'function', function:{ name, arguments: JSON.stringify(args) } } ] } }] });

http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }

  if (req.url.endsWith('/models')) {
    res.writeHead(200, { ...CORS, 'Content-Type':'application/json' });
    return res.end(JSON.stringify({ data:[
      { id:'mock/fast', name:'Mock Fast', context_length:128000,
        pricing:{ prompt:'0.0000005', completion:'0.0000015' },
        architecture:{ input_modalities:['text','image'] } },
      { id:'mock/free', name:'Mock Free', context_length:8000, pricing:{ prompt:'0', completion:'0' } },
    ] }));
  }

  let body = '';
  req.on('data', d => body += d);
  req.on('end', () => {
    let msgs = [];
    try { msgs = JSON.parse(body).messages || []; } catch {}
    // The store reviewer asks for strict JSON and nothing else.
    if (/moderator of an app store/.test(msgs[0]?.content || '')) {
      const asked = JSON.stringify(msgs).toLowerCase();
      const reject = /reject-me/.test(asked);
      return sse(res, textChunks(JSON.stringify(reject
        ? { ok:false, score:1, note:'Unfinished.' }
        : { ok:true, score:4, note:'Works and is useful.', summary:'A simple calculator.',
            category:'tools', categoryName:'Tools', categoryIcon:'🧰', tags:['math','tool'] })));
    }

    const done = msgs.filter(m => m.role === 'tool').length;
    const usage = { choices:[{ delta:{} }], usage:{ prompt_tokens:120, completion_tokens:40 } };
    const first = msgs.find(m => m.role === 'user');
    const firstText = typeof first?.content === 'string' ? first.content
      : (first?.content || []).map(p => p.text || '').join(' ');

    // Record what the client sends back, so tests can assert the round trip.
    const imgs = msgs.flatMap(m => Array.isArray(m.content)
      ? m.content.filter(p => p.type === 'image_url').map(p => p.image_url.url.slice(0, 24)) : []);
    const toolNames = [...new Set((msgs.flatMap(m => m.tool_calls || [])).map(c => c.function.name))];
    fs.writeFileSync(new URL('./last-request.json', import.meta.url),
      JSON.stringify({ done, imgs, toolNames, roles: msgs.map(m => m.role),
                       system: (msgs[0]?.content || '').slice(0, 400) }, null, 1));

    /* ---------------------------------------------------------- course */

    if (/course/i.test(firstText)) {
      const LESSONS = [
        ['intro', 'What the test looks like'],
        ['listening', 'Listening: maps and forms'],
        ['writing', 'Writing task 1 in four moves'],
      ];
      if (done === 0) return sse(res, [...textChunks('Building the course.'),
        toolChunk('course_outline', {
          title:'IELTS Band 7', subtitle:'From 6.0 to 7.0 in six weeks.',
          language:'en', accent:'#E8171F',
          modules:[{ title:'Foundations', lessons:[
            { id:'intro', title:LESSONS[0][1], minutes:8 },
            { id:'listening', title:LESSONS[1][1], minutes:14 }] },
            { title:'Writing', lessons:[{ id:'writing', title:LESSONS[2][1], minutes:20 }] }] }), usage]);

      if (done <= LESSONS.length) {
        const [id, title] = LESSONS[done - 1];
        return sse(res, [toolChunk('write_lesson', { id, html:
          `<p>By the end you will handle <b>${title}</b>.</p>` +
          '<div class="key"><b>Key idea</b><p>Answers follow the order of the recording.</p></div>' +
          '<h2>How it works</h2><p>Read the labels first, then listen once.</p>' +
          '<div class="q" data-a="1"><p>How many times do you hear it?</p>' +
          '<ul><li>Twice</li><li>Once</li><li>Three times</li></ul>' +
          '<p class="why">Once — which is why you read first.</p></div>' +
          '<div class="fill" data-a="once">You hear the recording ___.</div>' +
          '<h2>Recap</h2><p>Read, predict, listen once, write.</p>' }), usage]);
      }
      if (done === LESSONS.length + 1) return sse(res, [toolChunk('run_check', {}), usage]);
      if (done === LESSONS.length + 2) return sse(res, [toolChunk('publish_app',
        { name:'IELTS Band 7', emoji:'🎓', color:'#E8171F' }), usage]);
      return sse(res, [...textChunks('Your course is ready — three lessons to start with.'), usage]);
    }

    /* ------------------------------------------------------------ book */

    if (/book/i.test(firstText)) {
      const CH = [['origins', 'Where coffee comes from'], ['roast', 'The roast decides everything']];
      if (done === 0) return sse(res, [...textChunks('Writing the book.'),
        toolChunk('book_outline', { title:'The Bean', author:'Mini', subtitle:'A short history of coffee.',
          language:'en', accent:'#B00811',
          chapters:CH.map(([id, title]) => ({ id, title })) }), usage]);
      if (done <= CH.length) {
        const [, title] = CH[done - 1];
        return sse(res, [toolChunk('write_chapter', { id: CH[done - 1][0], html:
          `<p>The story of ${title.toLowerCase()} begins on a hillside.</p>` +
          '<h2>A closer look</h2><p>Ethiopian farmers picked the cherries by hand.</p>' +
          '<blockquote>Coffee is a language in itself.</blockquote>' +
          '<p>What follows is the part everyone gets wrong.</p>' }), usage]);
      }
      if (done === CH.length + 1) return sse(res, [toolChunk('set_cover',
        { svg:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 600">' +
              '<rect width="400" height="600" fill="#2b0407"/>' +
              '<text x="200" y="280" fill="#fff" font-size="42" text-anchor="middle">The Bean</text></svg>' }), usage]);
      if (done === CH.length + 2) return sse(res, [toolChunk('run_check', {}), usage]);
      if (done === CH.length + 3) return sse(res, [toolChunk('publish_app',
        { name:'The Bean', emoji:'📖', color:'#B00811' }), usage]);
      return sse(res, [...textChunks('The book is done — two chapters and a cover.'), usage]);
    }

    /* -------------------------------------------------- source reading */

    if (/from the document|uploaded/i.test(firstText)) {
      if (done === 0) return sse(res, [toolChunk('read_source', { part:1 }), usage]);
      return sse(res, [...textChunks('Read it.'), usage]);
    }

    /* ------------------------------------------------------------- app */

    const wantsShot = /screenshot|surat/i.test(firstText);
    if (done === 0) return sse(res, [...textChunks('Building a calculator.'), toolChunk('write_file',
      { path:'index.html', content: APP_HTML }), usage]);
    if (done === 1) return sse(res, [toolChunk('run_check', {}), usage]);
    if (wantsShot && done === 2) return sse(res, [toolChunk('screenshot', {}), usage]);
    if (done === (wantsShot ? 3 : 2)) return sse(res, [toolChunk('publish_app',
      { name:'Calculator', emoji:'🧮', color:'#22c55e' }), usage]);
    return sse(res, [...textChunks('Done — the calculator is on your screen.'), usage]);
  });
}).listen(PORT, () => console.log('mock provider on ' + PORT));
