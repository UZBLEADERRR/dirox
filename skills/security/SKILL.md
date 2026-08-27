---
name: security
description: The handful of mistakes that actually get exploited, and how not to make them.
when: handling authentication, user input, file paths, URLs, SQL, uploads, secrets or permissions.
---

# Security

Most breaches are a short list of mistakes, made once, in code that looked
fine. These are the ones worth checking every time.

## Never build a query by concatenation

```js
// One apostrophe in a name and this is somebody else's database.
db.query(`select * from users where email = '${email}'`);

// Parameterised. The value can never become syntax.
db.query('select * from users where email = $1', [email]);
```

The same rule for shell commands, for HTML, for anything with a grammar: pass
values as values, never by pasting them into text.

## Resolve every path, then check it

`../../../etc/passwd` is a valid string. A path from a request is not a path
until it has been resolved and confirmed to be inside the directory it is
supposed to be in — and confirmed again after symlinks, because a link planted
inside can point out.

## Any URL from outside is a request your server will make

Server-side request forgery is the one people forget. Your container can reach
things the internet cannot: the cloud metadata endpoint at 169.254.169.254,
which hands out credentials; `localhost`, which is your own API. Before
fetching a URL nobody on your team wrote: allow only http and https, resolve
the hostname and check *every* address it returns against the private ranges,
and re-check each redirect hop.

## Authorisation is per object, not per route

Being signed in is not permission to read row 41. Every query that touches a
user's data filters by that user, at the database, every time. A check in the
handler is one refactor away from being skipped; a policy at the row is not.

## Secrets

Never in the repository, never in a log line, never in an error message, never
in a URL. Read from the environment, hold them in memory, and encrypt anything
stored. When something must be shown back to a person, show the last four
characters and nothing else.

Before committing: search the diff for anything shaped like a key.

## Uploads

A file from a person is bytes, not a type. Check the size before reading it,
decide the type from the content rather than the name or the header, store it
under a name you generated, and serve it from somewhere that cannot execute
it.

## Timing and comparison

Compare secrets with a constant-time function, not `===`. Rate-limit
authentication by account *and* by address. Make "no such user" and "wrong
password" indistinguishable, in wording and in time.

## Dependencies

Every dependency is code you are shipping. Before adding one, ask what it does
that fifty lines would not. Pin versions, and read what an update changed
before taking it.
