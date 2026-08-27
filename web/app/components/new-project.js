/**
 * New project flow.
 *
 * Two honest paths: an empty workspace, or a GitHub import. The GitHub path
 * only appears when the deployment actually has GitHub configured, and it tells
 * you why when it does not.
 */

import { h, icon, mount, clear, debounce } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { store } from '../lib/store.js';
import { router } from '../lib/router.js';
import { openModal } from './modal.js';
import { toast, toastError } from '../lib/toast.js';
import { formatBytes, relativeTime } from '../lib/format.js';
import { loadSidebarData } from './shell.js';

async function createProject(payload) {
  const { project } = await api.post('/projects', payload);
  await loadSidebarData();
  router.navigate(`/app/projects/${project.id}`);
  return project;
}

function emptyProjectForm(close) {
  const error = h('div');
  const submit = h('button.btn.btn--primary', { type: 'submit' }, 'Create project');

  const form = h('form.stack', {
    onSubmit: async event => {
      event.preventDefault();
      submit.disabled = true;
      mount(submit, h('span.btn__spinner'), 'Creating…');
      mount(error);
      try {
        const data = new FormData(event.target);
        await createProject({
          name: String(data.get('name') || '').trim(),
          description: String(data.get('description') || '').trim(),
          source: 'empty'
        });
        toast.success('Project created.');
        close();
      } catch (err) {
        mount(error, h('p.field__error', { role: 'alert' }, err.message));
        submit.disabled = false;
        mount(submit, 'Create project');
      }
    }
  },
    h('div.field',
      h('label.label', { for: 'np-name' }, 'Project name'),
      h('input#np-name.input', { name: 'name', required: true, maxlength: '80', placeholder: 'Storefront', autofocus: true })
    ),
    h('div.field',
      h('label.label', { for: 'np-desc' }, 'What is it?'),
      h('textarea#np-desc.textarea', { name: 'description', maxlength: '500', rows: '3', placeholder: 'A Next.js storefront with Stripe checkout.' }),
      h('p.field__hint', 'This becomes the first thing DiroxCode knows about the project.')
    ),
    error,
    h('div.row', { style: { justifyContent: 'flex-end', gap: 'var(--s-2)' } },
      h('button.btn', { type: 'button', onClick: close }, 'Cancel'),
      submit
    )
  );

  return form;
}

function githubPanel(close) {
  const container = h('div.stack');

  async function renderState() {
    clear(container);
    container.appendChild(h('div.skeleton', { style: { height: '120px' } }));

    let status;
    try {
      status = await api.get('/github/status');
    } catch (error) {
      return mount(container, h('div.empty',
        h('p.empty__body', error.message)));
    }

    if (!status.available) {
      return mount(container, h('div.empty',
        h('div.empty__title', 'GitHub is not configured'),
        h('p.empty__body', status.reason || 'This deployment has no GitHub OAuth application configured. Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET on the server to enable repository import.'),
        h('button.btn', { onClick: close }, 'Close')
      ));
    }

    if (!status.connected) {
      return mount(container, h('div.empty',
        h('span', { style: { color: 'var(--accent)' } }, icon('git', { size: 22 })),
        h('div.empty__title', 'Connect your GitHub account'),
        h('p.empty__body', 'DiroxCode reads the repository you choose and writes only where you approve. The token stays on the server.'),
        h('button.btn.btn--primary', {
          onClick: async event => {
            event.currentTarget.disabled = true;
            try {
              const { url } = await api.post('/github/connect', { returnTo: location.pathname });
              location.href = url;
            } catch (error) {
              toastError(error, 'GitHub could not be reached');
              event.currentTarget.disabled = false;
            }
          }
        }, 'Continue with GitHub')
      ));
    }

    renderRepoPicker(status.account);
  }

  function renderRepoPicker(account) {
    const list = h('div.stack--tight', { class: 'stack', style: { maxHeight: '340px', overflowY: 'auto' } });
    const search = h('input.input', { type: 'search', placeholder: 'Search your repositories…', 'aria-label': 'Search repositories' });

    const load = async query => {
      mount(list, h('div.skeleton', { style: { height: '60px' } }), h('div.skeleton', { style: { height: '60px' } }));
      try {
        const { repositories } = await api.get(`/github/repositories?${query ? `q=${encodeURIComponent(query)}&` : ''}perPage=40`);
        if (!repositories.length) {
          return mount(list, h('div.empty', h('p.empty__body', query ? 'No repository matched that search.' : 'No repositories found for this account.')));
        }
        mount(list, repositories.map(repoRow));
      } catch (error) {
        /*
           A rejected token is not a search failure.

           GitHub answers "Bad credentials", which under the word "Connected"
           tells nobody anything. The server clears the connection when that
           happens, so the honest thing to show is what to do next — and a
           button that does it.
        */
        const expired = /credential|reconnect|connect github again|no longer valid/i.test(error.message || '');
        mount(list, h('div.empty',
          h('div.empty__title', expired ? 'GitHub needs connecting again' : 'Could not list your repositories'),
          h('p.empty__body', expired
            ? 'GitHub rejected the saved access, so it has been cleared. This happens when the authorisation is revoked or expires.'
            : error.message),
          expired
            ? h('button.btn.btn--primary.btn--sm', {
              style: { marginTop: 'var(--s-3)' },
              // The same handshake as the first connection: the bearer token
              // cannot ride a redirect, so the URL is asked for and followed.
              onClick: async event => {
                event.currentTarget.disabled = true;
                try {
                  const { url } = await api.post('/github/connect', { returnTo: location.pathname });
                  location.href = url;
                } catch (problem) {
                  toastError(problem, 'GitHub could not be reached');
                  event.currentTarget.disabled = false;
                }
              }
            }, 'Connect GitHub')
            : null));
      }
    };

    const repoRow = repo => {
      const button = h('button.card.card--interactive', {
        style: { display: 'flex', gap: 'var(--s-3)', alignItems: 'center', textAlign: 'left', padding: 'var(--s-3) var(--s-4)', width: '100%' },
        onClick: async () => {
          button.disabled = true;
          const original = button.cloneNode(true);
          mount(button, h('span.btn__spinner'), h('span', `Importing ${repo.fullName}…`));
          try {
            await createProject({
              name: repo.name,
              description: repo.description || '',
              source: 'github',
              repository: {
                externalId: repo.id, fullName: repo.fullName, owner: repo.owner, name: repo.name,
                htmlUrl: repo.htmlUrl, cloneUrl: repo.cloneUrl,
                defaultBranch: repo.defaultBranch, private: repo.private
              },
              branch: repo.defaultBranch
            });
            toast.success(`Importing ${repo.fullName}. Indexing runs in the background.`);
            close();
          } catch (error) {
            toastError(error, 'Import failed');
            button.replaceWith(original);
          }
        }
      },
        icon(repo.private ? 'shield' : 'git', { size: 15 }),
        h('div', { style: { flex: '1', minWidth: '0' } },
          h('div.truncate', { style: { fontSize: 'var(--fs-sm)', color: 'var(--text-strong)' } }, repo.fullName),
          h('div.subtle.truncate', { style: { fontSize: 'var(--fs-2xs)', marginTop: '2px' } },
            [repo.language, repo.sizeKb ? formatBytes(repo.sizeKb * 1024) : null, relativeTime(repo.updatedAt)].filter(Boolean).join(' · '))
        ),
        h('span.badge', repo.defaultBranch)
      );
      return button;
    };

    mount(container,
      h('div.row.row--between',
        h('div.row',
          h('span.avatar', account?.avatarUrl ? h('img', { src: account.avatarUrl, alt: '' }) : icon('git', { size: 14 })),
          h('div',
            h('div', { style: { fontSize: 'var(--fs-sm)' } }, account?.login || 'GitHub'),
            h('div.subtle', { style: { fontSize: 'var(--fs-2xs)' } }, 'Connected')
          )
        ),
        h('button.btn.btn--ghost.btn--sm', {
          onClick: async () => {
            await api.delete('/github/connect').catch(() => {});
            renderState();
          }
        }, 'Disconnect')
      ),
      search,
      list
    );

    search.addEventListener('input', debounce(() => load(search.value.trim()), 260));
    load('');
  }

  renderState();
  return container;
}

/** @param {{ source?: 'empty'|'github' }} options */
export function openNewProject({ source = 'empty' } = {}) {
  let active = source;
  const bodySlot = h('div');

  const tabs = h('div.tabs', { role: 'tablist', style: { marginBottom: 'var(--s-5)' } },
    [['empty', 'Empty project'], ['github', 'From GitHub']].map(([id, label]) =>
      h('button.tab', {
        role: 'tab',
        'aria-selected': String(id === active),
        onClick: () => {
          active = id;
          for (const tab of tabs.children) tab.setAttribute('aria-selected', String(tab.textContent === (id === 'empty' ? 'Empty project' : 'From GitHub')));
          mount(bodySlot, id === 'empty' ? emptyProjectForm(() => modal.close()) : githubPanel(() => modal.close()));
        }
      }, label))
  );

  const modal = openModal({
    title: 'New project',
    wide: true,
    body: h('div', tabs, bodySlot)
  });

  mount(bodySlot, active === 'empty' ? emptyProjectForm(() => modal.close()) : githubPanel(() => modal.close()));
  return modal;
}
