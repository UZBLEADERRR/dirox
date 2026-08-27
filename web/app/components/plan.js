/**
 * The plan, as a thing you can watch.
 *
 * It used to be one sentence, printed once, and then nothing until the run
 * ended. The question anybody actually has while waiting is "how far along is
 * it", and a stream of tool calls does not answer it.
 *
 * So the plan is a list with a mark against each step, and the marks move as
 * the agent reports them. It is the same card before and during the run: first
 * as something to approve, then as something to follow. That matters — a
 * person who approved a list of five steps should watch those five steps, not
 * a different display of the same work.
 */

import { h, icon, mount } from '../lib/dom.js';

const STATE_LABEL = {
  todo: 'To do',
  in_progress: 'Working',
  done: 'Done',
  blocked: 'Blocked'
};

function stepRow(step) {
  const status = step.status || 'todo';
  return h('li.plan__step', { 'data-status': status },
    h('span.plan__mark', { 'aria-hidden': 'true' },
      status === 'done' ? icon('check', { size: 12 })
        : status === 'blocked' ? icon('warning', { size: 12 })
          : status === 'in_progress' ? h('span.plan__spinner') : h('span.plan__dot')),
    h('div.plan__body',
      h('div.plan__title', step.title),
      step.note ? h('div.plan__note', step.note) : null,
      step.files?.length
        ? h('div.plan__files.mono', step.files.slice(0, 4).join(', ') + (step.files.length > 4 ? ` +${step.files.length - 4}` : ''))
        : null
    ),
    h('span.plan__state.sr-only', STATE_LABEL[status])
  );
}

/**
 * @param {{plan: object, onStart?: Function, onDecline?: Function}} options
 * @returns {{element: HTMLElement, update: Function}}
 */
export function planCard({ plan, onStart, onDecline } = {}) {
  const list = h('ol.plan__steps');
  const count = h('span.plan__count');
  const summary = h('p.plan__summary');
  const actions = h('div.plan__actions', { hidden: true });

  const element = h('section.plan', { 'aria-label': 'Plan' },
    h('header.plan__head',
      h('span.plan__label', 'Plan'),
      count
    ),
    summary,
    list,
    actions
  );

  /** Waiting on a person: the buttons appear, and say what saying yes means. */
  function askToStart() {
    mount(actions,
      h('p.plan__consent',
        'Starting lets DiroxCode work through all of this without stopping at each step. ',
        h('span.plan__consent-limit', 'Deleting data, force-pushing and anything else destructive will still ask.')
      ),
      h('div.plan__buttons',
        h('button.btn.btn--primary.btn--sm', { onClick: () => onStart?.() }, 'Start'),
        h('button.btn.btn--sm', { onClick: () => onDecline?.() }, 'Not this')
      )
    );
    actions.hidden = false;
  }

  function update(next) {
    if (!next?.steps?.length) return;
    mount(summary, next.summary || '');
    summary.hidden = !next.summary;

    const done = next.done ?? next.steps.filter(step => step.status === 'done').length;
    mount(count, `${done} of ${next.steps.length}`);
    mount(list, next.steps.map(stepRow));
    element.dataset.complete = done === next.steps.length ? 'true' : 'false';
  }

  update(plan);
  return { element, update, askToStart, hideActions: () => { actions.hidden = true; } };
}
