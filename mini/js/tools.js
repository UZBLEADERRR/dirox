/**
 * The agent's hands.
 *
 * Deliberately few and deliberately narrow. Every extra tool is schema text in
 * every request, and this app is meant to run on a phone against a model the
 * user pays for by the token. Six tools cover the whole loop: write, patch,
 * read, test, look, ship.
 */

import { runCheck, formatCheck } from './sandbox.js';
import { t } from './i18n.js';

export const TOOLS = [
  {
    type:'function',
    function:{
      name:'write_file',
      description:'Fayl yaratish yoki to\'liq almashtirish. Kichik o\'zgarish uchun edit_file ishlating.',
      parameters:{ type:'object', properties:{
        path:{ type:'string', description:'index.html, style.css, app.js' },
        content:{ type:'string' } }, required:['path','content'] }
    }
  },
  {
    type:'function',
    function:{
      name:'edit_file',
      description:'Faylning bir qismini almashtirish. find matni faylda aynan bir marta uchrashi kerak.',
      parameters:{ type:'object', properties:{
        path:{ type:'string' }, find:{ type:'string' }, replace:{ type:'string' } },
        required:['path','find','replace'] }
    }
  },
  {
    type:'function',
    function:{
      name:'read_file',
      description:'Fayl mazmunini o\'qish. path bo\'sh bo\'lsa fayllar ro\'yxati qaytadi.',
      parameters:{ type:'object', properties:{ path:{ type:'string' } } }
    }
  },
  {
    type:'function',
    function:{
      name:'delete_file',
      description:'Keraksiz faylni o\'chirish.',
      parameters:{ type:'object', properties:{ path:{ type:'string' } }, required:['path'] }
    }
  },
  {
    type:'function',
    function:{
      name:'run_check',
      description:'Ilovani brauzerda ishga tushirib tekshirish: xatolar, tugmalarni bosish, joylashuv. Har o\'zgarishdan keyin chaqiring.',
      parameters:{ type:'object', properties:{} }
    }
  },
  {
    type:'function',
    function:{
      name:'screenshot',
      description:'Ilovaning ekran suratini olib, ko\'rish. Faqat dizaynni ko\'zdan kechirish kerak bo\'lsa (token qimmat).',
      parameters:{ type:'object', properties:{} }
    }
  },
  {
    type:'function',
    function:{
      name:'publish_app',
      description:'Tayyor ilovani foydalanuvchi ekraniga qo\'shish. Ish tugagach bir marta chaqiring.',
      parameters:{ type:'object', properties:{
        name:{ type:'string', description:'Qisqa nom, 1-2 so\'z' },
        emoji:{ type:'string', description:'Bitta emoji belgi' },
        color:{ type:'string', description:'#RRGGBB fon rangi' } },
        required:['name','emoji'] }
    }
  },
];

const MAX_RESULT = 6000;   // a real file has to come back whole to be patched
const clip = s => (s.length > MAX_RESULT ? s.slice(0, MAX_RESULT) + `\n…(${s.length} belgidan qisqartirildi)` : s);

/**
 * @param ctx {{ project, onStep, onArtifact, publish }}
 * Returns { text } or { text, image } — image results are re-fed as vision parts.
 */
export async function runTool(name, args, ctx) {
  const p = ctx.project;
  p.files ||= {}; p.assets ||= [];

  switch (name) {

    case 'write_file': {
      const path = (args.path || 'index.html').replace(/^\.?\//, '');
      p.files[path] = String(args.content ?? '');
      ctx.onStep?.({ kind:'write', label:`${t('steps.write')}: ${path}`, ok:true });
      ctx.onArtifact?.();
      return { text:`OK ${path} (${p.files[path].length} belgi)` };
    }

    case 'edit_file': {
      const path = (args.path || '').replace(/^\.?\//, '');
      const src = p.files[path];
      if (src == null) return { text:`XATO: ${path} yo'q. Mavjud: ${Object.keys(p.files).join(', ') || '—'}` };
      const find = String(args.find ?? '');
      const n = find ? src.split(find).length - 1 : 0;
      if (n === 0) return { text:`XATO: "find" matni ${path} ichida topilmadi. read_file bilan tekshiring.` };
      if (n > 1)  return { text:`XATO: "find" ${n} marta uchradi. Kattaroq, noyob parcha bering.` };
      p.files[path] = src.replace(find, String(args.replace ?? ''));
      ctx.onStep?.({ kind:'edit', label:`${t('steps.edit')}: ${path}`, ok:true });
      ctx.onArtifact?.();
      return { text:`OK ${path} tuzatildi` };
    }

    case 'delete_file': {
      const path = (args.path || '').replace(/^\.?\//, '');
      if (path === 'index.html') return { text:'XATO: index.html o\'chirilmaydi.' };
      if (p.files[path] == null) return { text:`XATO: ${path} yo'q.` };
      delete p.files[path];
      ctx.onStep?.({ kind:'edit', label:`O'chirildi: ${path}`, ok:true });
      ctx.onArtifact?.();
      return { text:`OK ${path} o'chirildi` };
    }

    case 'read_file': {
      const path = (args.path || '').replace(/^\.?\//, '');
      if (!path) {
        const list = Object.entries(p.files).map(([k,v]) => `${k} (${v.length}b)`).join('\n') || '(bo\'sh)';
        const assets = p.assets.map(a => a.name).join(', ');
        ctx.onStep?.({ kind:'list', label:t('steps.list'), ok:true });
        return { text:`Fayllar:\n${list}${assets ? `\nRasmlar: ${assets}` : ''}` };
      }
      if (p.files[path] == null) return { text:`XATO: ${path} yo'q.` };
      ctx.onStep?.({ kind:'read', label:`${t('steps.read')}: ${path}`, ok:true });
      return { text: clip(p.files[path]) };
    }

    case 'run_check': {
      if (!p.files['index.html']) return { text:'XATO: avval index.html yozing.' };
      ctx.onStep?.({ kind:'check', label:t('steps.check'), running:true });
      const r = await runCheck(p, { interact:true });
      const bad = r.fatal || r.blank || (r.errors || []).length || (r.clickErrors || []).length;
      ctx.onStep?.({ kind:'check', label:t('steps.check'), ok:!bad, replace:true });
      return { text: formatCheck(r) };
    }

    case 'screenshot': {
      if (!p.files['index.html']) return { text:'XATO: avval index.html yozing.' };
      ctx.onStep?.({ kind:'shot', label:t('steps.shot'), running:true });
      const r = await runCheck(p, { interact:false, shot:true });
      ctx.onStep?.({ kind:'shot', label:t('steps.shot'), ok:!!r.shot, replace:true });
      if (!r.shot) return { text:`Surat olinmadi (${r.shotError || 'qo\'llab-quvvatlanmaydi'}). run_check ishlating.` };
      return { text:'Ekran surati:', image:r.shot };
    }

    case 'publish_app': {
      if (!p.files['index.html']) return { text:'XATO: avval index.html yozing.' };
      const app = ctx.publish({
        name: String(args.name || 'Mini ilova').slice(0, 24),
        emoji: (args.emoji || '📱').slice(0, 4),
        color: /^#[0-9a-f]{6}$/i.test(args.color || '') ? args.color : null,
      });
      ctx.onStep?.({ kind:'publish', label:`${t('steps.publish')}: ${app.name}`, ok:true });
      return { text:`OK "${app.name}" foydalanuvchi ekraniga qo'shildi. Endi qisqa javob bering.` };
    }

    default:
      return { text:`XATO: "${name}" degan vosita yo'q.` };
  }
}
