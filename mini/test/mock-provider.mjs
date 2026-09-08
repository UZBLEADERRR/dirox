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
    const done = msgs.filter(m => m.role === 'tool').length;
    const usage = { choices:[{ delta:{} }], usage:{ prompt_tokens:120, completion_tokens:40 } };
    const first = msgs.find(m => m.role === 'user');
    const firstText = typeof first?.content === 'string' ? first.content
      : (first?.content || []).map(p => p.text || '').join(' ');
    const wantsShot = /surat/i.test(firstText);

    // Record what the client sends back after a screenshot, so the test can
    // assert the image actually made the round trip.
    const imgs = msgs.flatMap(m => Array.isArray(m.content)
      ? m.content.filter(p => p.type === 'image_url').map(p => p.image_url.url.slice(0, 24)) : []);
    fs.writeFileSync(new URL('./last-request.json', import.meta.url),
      JSON.stringify({ done, imgs, roles: msgs.map(m => m.role) }, null, 1));

    if (done === 0) return sse(res, [...textChunks('Kalkulyator yasayapman.'), toolChunk('write_file',
      { path:'index.html', content: APP_HTML }), usage]);
    if (done === 1) return sse(res, [toolChunk('run_check', {}), usage]);
    if (wantsShot && done === 2) return sse(res, [toolChunk('screenshot', {}), usage]);
    if (done === (wantsShot ? 3 : 2)) return sse(res, [toolChunk('publish_app',
      { name:'Kalkulyator', emoji:'🧮', color:'#22c55e' }), usage]);
    return sse(res, [...textChunks('Tayyor! Kalkulyator ekraningizga qo\'shildi.'), usage]);
  });
}).listen(PORT, () => console.log('mock provider on ' + PORT));
