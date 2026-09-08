/**
 * The turn loop.
 *
 * Two economies shape this file. First, the request window: only the last few
 * turns are sent, and a turn's tool traffic is thrown away once the turn ends —
 * the project files are the memory, and the agent can re-read them for the cost
 * of the one file it actually needs. Second, the system prompt: it carries a
 * one-line inventory of the project instead of the project.
 */

import { stream, LLMError } from './llm.js';
import { TOOLS, runTool } from './tools.js';
import { currentLang } from './i18n.js';

const BUILDER_PROMPT = `Sen "Mini" ichidagi katta ilovalar yasaydigan muhandissan. Foydalanuvchi telefonida ishlaydigan to'liq, tugallangan mahsulot yasaysan — namuna emas.

MAHSULOT DARAJASI
- Hech qachon "TODO", "keyinroq", yarim ishlaydigan tugma yoki bo'sh ekran qoldirma. Aytilgan narsa oxirigacha ishlasin.
- Holat localStorage'da saqlansin: qayta ochilganda hamma narsa joyida turadi.
- Bo'sh holat, yuklanish, xato holati va tasdiqlash — barchasi o'ylangan bo'lsin.
- Ma'lumot o'chirishdan oldin so'ra. Bekor qilish imkoni bo'lsa yaxshi.
- Klaviatura ochilganda joylashuv buzilmasin; ro'yxatlar uzun bo'lsa ham tez ishlasin.

DIZAYN
- Mobil uchun: tugmalar >=44px, gorizantal scroll YO'Q, safe-area (env(safe-area-inset-*)) hisobga olinsin.
- Tipografikada aniq shkala (12/14/16/20/28), 4px tarmoqli bo'shliq, 12-20px radius, yumshoq soya.
- Bitta urg'u rangi + neytral shkala. prefers-color-scheme orqali tungi va kunduzgi rejim ikkalasi ham chiroyli.
- Bosishda javob (:active), yumshoq o'tishlar (120-200ms). Ortiqcha animatsiya yo'q.
- Ranglar kontrasti yetarli bo'lsin; matn hech qachon fon bilan qo'shilib ketmasin.

TEXNIKA
- Toza HTML/CSS/JS. Framework yo'q, build yo'q, tashqi kutubxona YO'Q — ilova mustaqil bo'lsin (marketga faqat shunday ilova o'tadi).
- Kod 300 qatordan oshsa fayllarga ajrat: index.html + style.css + app.js (kerak bo'lsa yana).
- Funksiyalar kichik va nomlangan bo'lsin. Global o'zgaruvchi kam. innerHTML ga foydalanuvchi matnini qo'yma — textContent ishlat.
- Kamera kerak bo'lsa <input type="file" accept="image/*" capture="environment"> ishlat (getUserMedia sandboxda ishlamaydi).
- Foydalanuvchi yuborgan rasmni ilovaga qo'yish uchun <img src="rasm1.png"> (nomlar quyida).
- Interfeys matni foydalanuvchi tilida bo'lsin.

ISH TARTIBI
1. Bir jumlada nima yasashingni ayt. Uzun reja yozma.
2. write_file bilan yoz. Katta ilovani bir necha faylga bo'l.
3. run_check bilan tekshir. Xato, ogohlantirish yoki bo'sh ekran bo'lsa — edit_file bilan tuzat va yana run_check. Toza bo'lguncha to'xtama.
4. Dizayn muhim bo'lsa screenshot bilan ko'rib chiq va tuzat.
5. publish_app bilan ekranga qo'sh.
6. Chatda 1-2 jumla: nima yasalgani va qanday ishlatish. Kodni chatga nusxalama.

Qisqa yoz. Ishni qil.`;

const langName = { uz:'o\'zbekcha', en:'English', ru:'русском' };

function projectLine(project) {
  const files = Object.entries(project.files || {});
  if (!files.length) return 'Loyiha bo\'sh.';
  const list = files.map(([k, v]) => `${k}(${Math.round(v.length / 100) / 10}k)`).join(' ');
  const assets = (project.assets || []).map(a => a.name).join(', ');
  return `Joriy loyiha fayllari: ${list}${assets ? ` | rasmlar: ${assets}` : ''}`;
}

function systemPrompt(role, chat) {
  const parts = [];
  if (role.tools) parts.push(BUILDER_PROMPT);
  if (role.prompt) parts.push(role.prompt);
  if (!parts.length) parts.push('Sen foydali yordamchisan. Qisqa javob ber.');
  parts.push(`Javob tili: ${langName[currentLang()] || 'o\'zbekcha'} (foydalanuvchi boshqa tilda yozsa — o'sha tilda).`);
  if (role.tools) parts.push(projectLine(chat.project));
  return parts.join('\n\n');
}

/** Persisted history -> request messages. Images ride along only on user turns. */
function history(chat, limit) {
  const msgs = chat.messages.filter(m => m.role === 'user' || (m.role === 'assistant' && m.content));
  return msgs.slice(-limit).map(m => {
    if (m.role === 'user' && m.images?.length) {
      return { role:'user', content:[
        ...(m.content ? [{ type:'text', text:m.content }] : []),
        ...m.images.map(url => ({ type:'image_url', image_url:{ url } })),
      ]};
    }
    return { role:m.role, content:m.content };
  });
}

export class Agent {
  constructor(deps) { Object.assign(this, deps); }   // {settings, onDelta, onStep, onArtifact, publish, onUsage}

  stop() { this.controller?.abort(); }

  /**
   * Runs one user turn to completion: text, tool calls, retries, tool calls
   * again, until the model answers without asking for a tool.
   */
  async run(chat, role) {
    const s = this.settings;
    this.project = chat.project;
    this.controller = new AbortController();
    const signal = this.controller.signal;

    const base = [
      { role:'system', content: systemPrompt(role, chat) },
      ...history(chat, s.historyLimit || 24),
    ];
    const scratch = [];                 // this turn's tool traffic; discarded after
    const useTools = !!role.tools;
    let finalText = '';

    let spoke = false;
    for (let step = 0; step < (s.maxSteps || 14); step++) {
      let text = '', calls = null;
      if (spoke) this.onDelta?.('\n\n');

      for await (const ev of stream({
        settings: s, messages: [...base, ...scratch],
        tools: useTools ? TOOLS : null, signal,
      })) {
        if (ev.t === 'text')  { text += ev.v; spoke = true; this.onDelta?.(ev.v); }
        if (ev.t === 'tools')  calls = ev.v;
        if (ev.t === 'usage')  this.onUsage?.(ev.v);
      }

      if (!calls?.length) { finalText = text || finalText; break; }
      if (step === (s.maxSteps || 26) - 1) {
        this.onStep?.({ kind:'limit', label:'Qadam chegarasi — «davom et» deb yozing', ok:false });
      }

      scratch.push({ role:'assistant', content: text || null, tool_calls: calls });

      const images = [];
      for (const c of calls) {
        let args = {};
        try { args = JSON.parse(c.function.arguments || '{}'); }
        catch { scratch.push({ role:'tool', tool_call_id:c.id,
          content:'XATO: argumentlar JSON emas. Qayta yuboring.' }); continue; }

        let out;
        try { out = await runTool(c.function.name, args, this); }
        catch (e) { out = { text:`XATO: ${e.message}` }; }

        scratch.push({ role:'tool', tool_call_id:c.id, content: out.text });
        if (out.image) images.push(out.image);
      }
      if (images.length) {
        scratch.push({ role:'user', content: images.map(url => ({ type:'image_url', image_url:{ url } })) });
      }
      // Never trimmed mid-turn: every tool result must stay paired with its
      // call or the next request is rejected. maxSteps is the real bound.
      if (signal.aborted) break;
    }

    return finalText.trim();
  }
}

export { LLMError };
