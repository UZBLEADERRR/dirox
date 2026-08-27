---
name: design
description: Building an interface that looks considered and works on a phone.
when: writing or changing any UI — a page, a component, a stylesheet, a colour, a layout.
---

# Design

Most interfaces fail for the same handful of reasons, and none of them are
taste. They are measurable, which means they are fixable before anybody sees
the work.

## Measure contrast; do not judge it

Grey text on a dark background is the single most common failure, and it is
invisible to whoever wrote it — they know what it says. WCAG AA is 4.5:1 for
body text and 3:1 for large text and UI edges.

Compute it rather than guessing:

```js
const luminance = ([r, g, b]) => {
  const channel = c => (c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};
const ratio = (a, b) => {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
};
```

If a colour is below the threshold, raise it. "It looks fine to me" is not a
measurement.

## A scale, not a set of numbers

Every size, space, radius and colour comes from a small scale defined in one
place. A value typed inline is a value nobody can change later.

```css
:root {
  --s-1: 4px;  --s-2: 8px;  --s-3: 12px; --s-4: 16px; --s-6: 24px; --s-8: 32px;
  --fs-xs: 13px; --fs-sm: 15px; --fs-md: 16px; --fs-lg: 20px; --fs-xl: 28px;
  --r-sm: 6px; --r-md: 10px; --r-lg: 14px; --r-full: 999px;
}
```

Three type sizes on a screen is usually one too many. Two weights is usually
enough.

## Both themes, from one definition

Define the whole palette on bare `:root`. Redefine only what changes under
`@media (prefers-color-scheme: dark)` and again under an explicit
`[data-theme="dark"]`, so a toggle wins in both directions. Never give a
colour its only definition inside a media query — a viewer whose system says
nothing then gets no colour at all.

Always paint `body` an explicit background. A transparent body borrows
whatever is behind it.

## The phone is the real test

- Widest media query first. A `max-width: 900px` block placed after a
  `max-width: 640px` block silently undoes it, and the bug only appears on
  small screens.
- Anything tappable is at least 24px, and 44px if it matters.
- Nothing may scroll sideways. Wide content — tables, code, diagrams — scrolls
  inside its own `overflow-x: auto` box, never the page.
- A `<select>` is as wide as its widest option, not its selected one. On a
  phone that overflows. Measure the selected text and set the width.
- Test at 390px wide. Not 375, not "narrow" — 390.

## Restraint reads as confidence

One accent colour, used for the one action that matters on each screen. A
second accent halves the meaning of the first. Green means success and
nothing else; red means danger or the brand, never both in the same place.

Borders before shadows. Shadows before gradients. Most gradients are a
decision nobody made.

## Empty, loading, error

Every list has three states beyond "full", and skipping them is what makes an
interface feel unfinished:

- **Empty**: say what would be here and how to make one. Never a blank box.
- **Loading**: reserve the space the content will occupy, so nothing jumps.
- **Error**: what failed, and what the person can do. Never "Something went
  wrong".

## Before you say it is done

1. Open it at 390px and at 1280px.
2. Read every piece of text at the size it will actually be.
3. Check the console is clean.
4. Check nothing scrolls sideways.
5. Tab through it: every control reachable, focus visible.

If a screenshot tool is available, take one at both widths and look.
