---
name: enrol
description: "Enrol this machine on the Crosstalk bus from a local browser page: join your estate, set up a new one, change the estate password, or re-enrol after it changed. The password is typed only in the browser, never in chat."
disable-model-invocation: true
---

# /crosstalk:enrol — enrol this machine (browser page)

Run exactly this ONE command with the Bash tool, and nothing else:

```sh
node "${CLAUDE_PLUGIN_ROOT}/src/cc-enrol-web.mjs"
```

It starts a one-shot enrol page on `127.0.0.1` (random port, one-time link), opens it in the user's
browser, prints ONE line, and returns at once. The page works out whether this machine is already
enrolled, whether an estate answers on the network, and offers the right form. It shuts itself
down after one enrolment, on Cancel, or after 5 minutes idle.

Then tell the user, in one or two sentences, what that line says: the link, and that they finish in
the browser tab. If it says the browser could not be opened, give them the link to click.

## The password never passes through this chat

- **Never ask for the estate password in chat**, and never offer to type or run it for them. The
  page is the only place it goes.
- If the user **pastes a password or passphrase into chat anyway**: do not use it, repeat it, or put
  it in any command. Tell them it is now in the conversation transcript and should be treated as
  exposed: enrol through the page, and if it was the estate's real password, choose a new one
  (on an enrolled machine: `/crosstalk:enrol` → **Change estate password**, then **Re-enrol** on
  the other machines).
- Do not read, print, or edit `~/.claude/.crosstalk` (it holds the derived keys), and do not set
  `CC_ENROL_PASSWORD_FOR_TESTS` — that is a test seam, not a way in.

## When the page can't be used

Headless machine, SSH session, or the command above failed: the user runs the terminal fallback
**themselves**, in their own terminal (it prompts with hidden input — do not run it for them):

```sh
node "${CLAUDE_PLUGIN_ROOT}/src/cc-enrol.mjs" --auto-supervisor
```

On Windows, run it from Windows Terminal or PowerShell (Git Bash's mintty has no TTY for the prompt).

## Afterwards

New sessions on this machine join the bus automatically. **This** session joins the next time it is
started or resumed; the SessionStart hook only runs then.
