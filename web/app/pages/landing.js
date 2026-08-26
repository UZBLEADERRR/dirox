/**
 * Landing page.
 *
 * Everything shown here is either real product surface or plainly labelled as
 * an example. Plans are read from the API so pricing is never a hardcoded lie.
 */

import { h, icon, frag } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { wordmark, mark } from '../components/brand.js';
import { formatCents } from '../lib/format.js';

const STEPS = [
  ['01', 'Connect a project', 'Link a GitHub repository or start from scratch. DiroxCode indexes it once, incrementally after that.'],
  ['02', 'Describe the task', 'Plain language. "Add Google sign-in." "Find why the API returns 500." No prompt engineering.'],
  ['03', 'DiroxCode builds', 'It plans, retrieves only the files that matter, and edits with the cheapest model that can do the job.'],
  ['04', 'DiroxCode verifies', 'Tests run. Failures get fixed. Changes get reviewed before you ever see them.'],
  ['05', 'Ship', 'Review the diff, restore a checkpoint, or open a pull request.']
];

const FEATURES = [
  ['sparkle', 'Autonomous engineering', 'Plans, edits across files, installs dependencies when authorised, runs tests, and fixes what it broke — without being told each step.'],
  ['layers', 'Deep codebase understanding', 'Symbol index, import graph and hierarchical summaries. It knows where the auth module is before it reads a single line.'],
  ['chart', 'Token-efficient by design', 'Retrieval is ranked and deduplicated against a per-task budget. Whole repositories are never pasted into a prompt.'],
  ['git', 'Multi-model routing', 'A trivial edit does not need a frontier model. Tasks are classified and routed, escalating only after a measured failure.'],
  ['terminal', 'Sandboxed execution', 'Commands run against an allowlist inside an isolated workspace with CPU, memory and time limits.'],
  ['shield', 'Repository content is data', 'A README cannot instruct the agent. System policy, user intent and repository text are strictly separated.'],
  ['file', 'Checkpoints and rollback', 'Every significant change is checkpointed. A bad result is one click from undone.'],
  ['search', 'Debugging that reproduces', 'Give it a stack trace or a failing test. It locates the cause, fixes it, and proves the fix by running the test.'],
  ['check', 'Review before you read', 'Findings ranked critical to info, with the option to fix everything critical in one instruction.']
];

const FAQ = [
  ['How does DiroxCode keep AI costs low?',
   'Three mechanisms working together. Retrieval sends only ranked, deduplicated code rather than whole files. A router classifies each task and picks the cheapest capable model, escalating only after a measured failure. And every task runs against a token budget the agent can see, so it compresses context and stops retrying when the budget runs short.'],
  ['Does it send my entire repository to a model?',
   'No. The repository is indexed locally into files, symbols and an import graph. For a given task, hybrid retrieval — exact, keyword, symbol and dependency relevance — selects a small ranked set, and only that reaches the model.'],
  ['Can it run commands on my code?',
   'Only inside an isolated workspace, only commands on the configured allowlist, and with CPU, memory, output and time limits. Destructive commands require your explicit approval according to the trust level you set.'],
  ['Which AI providers are supported?',
   'The model layer is provider-independent: OpenAI, Anthropic, Google, OpenRouter, xAI, DeepSeek, Moonshot and any OpenAI-compatible endpoint. Models, prices and routing rules are configured server-side and can change without redeploying.'],
  ['What happens if the AI makes a bad change?',
   'Checkpoints are created before significant edits. You can compare, restore or roll back. Nothing is pushed to your repository without your approval.'],
  ['Where is my code stored?',
   'Project metadata and the search index live in your Postgres database. Working copies live in an ephemeral sandbox workspace. Provider credentials are encrypted and never reach the browser.']
];

function header() {
  const element = h('header.site-header',
    h('div.site-header__inner',
      wordmark(),
      h('nav.site-nav',
        h('a.site-nav__link', { href: '/#how', 'data-secondary': 'true' }, 'How it works'),
        h('a.site-nav__link', { href: '/#features', 'data-secondary': 'true' }, 'Features'),
        h('a.site-nav__link', { href: '/pricing' }, 'Pricing'),
        h('a.site-nav__link', { href: '/login' }, 'Sign in'),
        h('a.btn.btn--primary.btn--sm', { href: '/signup' }, 'Start building')
      )
    )
  );

  const onScroll = () => { element.dataset.scrolled = String(window.scrollY > 8); };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
  return element;
}

/** A faithful still of the real activity timeline, labelled as an example. */
function productPreview() {
  const activity = [
    ['Analysed project', 'Next.js 15 · TypeScript · 214 files indexed', 'done'],
    ['Retrieved context', '6 files, 9.1K tokens — 3% of the repository', 'done'],
    ['Planned changes', '4 files affected · budget $0.10', 'done'],
    ['Edited', 'auth/providers.ts, login/page.tsx, middleware.ts', 'done'],
    ['Ran tests', '32 passed, 0 failed', 'done'],
    ['Reviewed', 'No critical findings', 'active']
  ];

  return h('section.preview',
    h('div.preview__frame',
      h('div.preview__bar',
        h('span.preview__dot'), h('span.preview__dot'), h('span.preview__dot'),
        h('span.preview__path', 'diroxcode.app/app/projects/storefront/chat')
      ),
      h('div.preview__body',
        h('div.preview__stream',
          h('div.preview__prompt', 'Add authentication with Google and GitHub.'),
          h('ol.activity',
            activity.map(([title, detail, status]) => h('li.activity__row', { 'data-status': status },
              h('span.activity__dot'),
              h('div.activity__body',
                h('div.activity__title', title),
                h('div.activity__detail', detail)
              )
            ))
          )
        ),
        h('div.preview__side',
          h('div.eyebrow', { style: { marginBottom: 'var(--s-3)' } }, 'This task'),
          h('dl.meta-list',
            metaRow('Model', 'Dirox Auto'),
            metaRow('Tokens', '8.2K'),
            metaRow('Cost', '$0.014'),
            metaRow('Duration', '18s'),
            metaRow('Checkpoint', 'created')
          )
        )
      )
    ),
    h('p.hero__note', { style: { textAlign: 'center', marginTop: 'var(--s-4)' } },
      'An example run. Your own activity stream looks exactly like this.')
  );
}

function metaRow(label, value) {
  return h('div.meta-row', h('dt.meta-row__label', label), h('dd.meta-row__value', value));
}

async function pricingSection() {
  const section = h('section.section-block.section-block--alt', { id: 'pricing' },
    h('div.section-block__inner',
      h('p.eyebrow', 'Pricing'),
      h('h2.section-title', { style: { marginTop: 'var(--s-4)' } }, 'Pay for engineering, not for tokens you did not need.'),
      h('p.section-lede', 'Every plan includes the full agent. Higher plans raise the limits and unlock the strongest routing tiers.')
    )
  );

  const inner = section.firstChild;
  const holder = h('div.plans');
  inner.appendChild(holder);

  try {
    const { plans } = await api.get('/billing/plans');
    for (const plan of plans) {
      holder.appendChild(h('div.plan', { 'data-featured': String(plan.code === 'pro') },
        h('div.plan__name', plan.name),
        h('div.plan__price',
          plan.code === 'enterprise' ? 'Custom' : formatCents(plan.priceMonthlyCents),
          plan.code === 'enterprise' ? null : h('small', ' / month')
        ),
        h('p.plan__desc', plan.description),
        h('ul.plan__list', planLines(plan).map(line => h('li', icon('check', { size: 13 }), h('span', line)))),
        h('a.btn', {
          href: plan.code === 'enterprise' ? '/contact' : '/signup',
          class: plan.code === 'pro' ? 'btn--primary' : ''
        }, plan.code === 'enterprise' ? 'Talk to us' : 'Start with ' + plan.name)
      ));
    }
  } catch {
    holder.replaceWith(h('div.empty',
      h('p.empty__body', 'Pricing could not be loaded right now. Please try again shortly.')
    ));
  }

  return section;
}

function planLines(plan) {
  const lines = [];
  lines.push(plan.maxProjects === null ? 'Unlimited projects' : `${plan.maxProjects} projects`);
  lines.push(plan.maxTasksPerDay === null ? 'Unlimited tasks per day' : `${plan.maxTasksPerDay} tasks per day`);
  lines.push(`${plan.maxConcurrentAgents} concurrent ${plan.maxConcurrentAgents === 1 ? 'agent' : 'agents'}`);
  if (plan.includedCreditsCents) lines.push(`${formatCents(plan.includedCreditsCents)} of AI credit included`);
  const tierLabel = { level4: 'all routing tiers', level3: 'advanced models', level2: 'standard models' };
  const top = ['level4', 'level3', 'level2'].find(tier => plan.allowedModelTiers?.includes(tier));
  if (top) lines.push(`Access to ${tierLabel[top]}`);
  for (const [key, label] of [['code_review', 'AI code review'], ['autopilot', 'Autopilot mode'], ['background_agent', 'Background agents'], ['api_access', 'API access'], ['sso', 'SSO']]) {
    if (plan.features?.[key]) lines.push(label);
  }
  return lines.slice(0, 7);
}

function faqSection() {
  return h('section.section-block', { id: 'faq' },
    h('div.section-block__inner',
      h('p.eyebrow', 'Questions'),
      h('h2.section-title', { style: { marginTop: 'var(--s-4)' } }, 'What people ask before they trust an agent with their codebase.'),
      h('div.faq', FAQ.map(([question, answer]) => {
        const body = h('div.faq__a', { hidden: true }, answer);
        const button = h('button.faq__q', {
          'aria-expanded': 'false',
          onClick: () => {
            const open = button.getAttribute('aria-expanded') === 'true';
            button.setAttribute('aria-expanded', String(!open));
            body.hidden = open;
          }
        }, h('span', question), icon('chevronDown', { size: 16 }));
        return h('div.faq__item', button, body);
      }))
    )
  );
}

function securitySection() {
  const points = [
    ['Tenant isolation', 'Row Level Security in Postgres, enforced on every table that holds project or usage data. Organization ids from the client are always re-verified.'],
    ['Secrets stay server-side', 'Provider keys, GitHub tokens and billing secrets never reach the browser. Keys at rest are encrypted with AES-256-GCM.'],
    ['Prompt-injection defence', 'Repository files, tool output and web content are treated as data. They cannot change system policy or widen the agent\'s permissions.'],
    ['Approval boundaries', 'Deleting files, installing dependencies, pushing to Git and touching production all require explicit approval unless you raise the trust level yourself.'],
    ['Audit trail', 'Sign-ins, model changes, Git operations, billing changes and admin actions are recorded and searchable.'],
    ['Your data is yours', 'Export everything as JSON. Delete your account and the cascade removes it.']
  ];

  return h('section.section-block', { id: 'security' },
    h('div.section-block__inner',
      h('p.eyebrow', 'Security'),
      h('h2.section-title', { style: { marginTop: 'var(--s-4)' } }, 'An agent with write access needs real boundaries.'),
      h('div.features', points.map(([title, text]) => h('div.feature',
        h('div.feature__icon', icon('shield', { size: 18 })),
        h('div.feature__title', title),
        h('p.feature__text', text)
      )))
    )
  );
}

function footer() {
  const columns = [
    ['Product', [['How it works', '/#how'], ['Features', '/#features'], ['Pricing', '/pricing'], ['Security', '/security']]],
    ['Start', [['Create account', '/signup'], ['Sign in', '/login']]],
    ['Resources', [['FAQ', '/#faq'], ['Status', '/api/health']]]
  ];

  return h('footer.site-footer',
    h('div.site-footer__inner',
      h('div',
        h('div.brand', mark({ size: 22 }), h('span.brand__name', 'Dirox', h('em', 'Code'))),
        h('p', { style: { marginTop: 'var(--s-4)', maxWidth: '30ch', color: 'var(--text-muted)', fontSize: 'var(--fs-sm)' } },
          'Your AI software engineer. Understands the codebase, does the work, proves it works.')
      ),
      columns.map(([title, links]) => h('div.footer-col',
        h('div.footer-col__title', title),
        links.map(([label, href]) => h('a', { href }, label))
      ))
    ),
    h('div.site-footer__bottom',
      h('span', `© ${new Date().getFullYear()} DiroxCode`),
      h('span', 'Built to be fast, secure and token efficient.')
    )
  );
}

export async function render(renderTo, { section } = {}) {
  const page = h('div.site',
    header(),
    h('main', { id: 'main' },
      h('section.hero',
        h('div.hero__inner',
          h('span.hero__eyebrow', h('span.dot.dot--success'), 'Autonomous coding agent'),
          h('h1.hero__title', 'Your ', h('em', 'AI software engineer'), '.'),
          h('p.hero__sub',
            'DiroxCode reads your codebase, plans the change, writes the code, runs the tests and reviews the result. ' +
            'It uses the smallest model and the least context that can do the job.'),
          h('div.hero__cta',
            h('a.btn.btn--primary.btn--lg', { href: '/signup' }, 'Start building', icon('arrowRight', { size: 15 })),
            h('a.btn.btn--lg.btn--outline', { href: '/#how' }, 'Explore DiroxCode')
          ),
          h('p.hero__note', 'Free plan available. No credit card required.')
        )
      ),
      productPreview(),

      h('section.section-block', { id: 'how' },
        h('div.section-block__inner',
          h('p.eyebrow', 'How it works'),
          h('h2.section-title', { style: { marginTop: 'var(--s-4)' } }, 'Describe the outcome. DiroxCode handles the engineering.'),
          h('div.steps', STEPS.map(([n, title, text]) => h('div.step',
            h('div.step__n', n),
            h('div.step__title', title),
            h('p.step__text', text)
          )))
        )
      ),

      h('section.section-block.section-block--alt', { id: 'features' },
        h('div.section-block__inner',
          h('p.eyebrow', 'Capabilities'),
          h('h2.section-title', { style: { marginTop: 'var(--s-4)' } }, 'Built like infrastructure, not like a chat window.'),
          h('div.features', FEATURES.map(([iconName, title, text]) => h('div.feature',
            h('div.feature__icon', icon(iconName, { size: 18 })),
            h('div.feature__title', title),
            h('p.feature__text', text)
          )))
        )
      ),

      h('div', { ref: node => pricingSection().then(element => node.replaceWith(element)) },
        h('div.section-block', h('div.section-block__inner', h('div.skeleton', { style: { height: '280px' } })))),

      securitySection(),
      faqSection(),

      h('section.section-block.section-block--alt',
        h('div.section-block__inner', { style: { textAlign: 'center' } },
          h('h2.section-title', { style: { margin: '0 auto' } }, 'Give DiroxCode your next task.'),
          h('p.section-lede', { style: { margin: 'var(--s-4) auto 0' } }, 'Connect a repository and describe what you want built.'),
          h('div.hero__cta', h('a.btn.btn--primary.btn--lg', { href: '/signup' }, 'Start building'))
        )
      )
    ),
    footer()
  );

  renderTo(page);

  if (section) {
    requestAnimationFrame(() => document.getElementById(section)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  } else {
    window.scrollTo(0, 0);
  }
}
