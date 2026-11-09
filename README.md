# pi-session-personas-gs

Gentle Shell package that gives a session a persona chosen at runtime from your own markdown files.

The package ships **no personas**. It discovers every `.md` persona file in the project and in your
user config directory, offers them in a selector, and appends the chosen body to the prompt. The base
prompt is never replaced, so a persona **inherits the neutral persona** and every harness rule,
permission mode and project rule already in it.

The choice is persisted as a custom session entry, so a resumed session keeps its persona, and the
persona's display name becomes the session display name.

## Command

```
/gentle:sesion-persona            # selector with every discovered persona, plus None
/gentle:sesion-persona ada        # by file stem
/gentle:sesion-persona "Ada Lovelace"   # by frontmatter name
/gentle:sesion-persona none       # back to the neutral persona
```

Switching applies from the next turn. Selecting a persona also renames the session to the persona
name; clearing it leaves the session name untouched. Subagent sessions never receive a persona block.

## Where personas live

| Directory | Scope |
| --- | --- |
| `<project>/.pi/personas/*.md` | That project only; wins over a user persona with the same file stem. |
| `$GENTLE_PI_AGENT_HOME/personas/*.md`, else `$PI_CODING_AGENT_DIR/personas/*.md` | Every project; under Gentle Shell that is `~/.gentle-shell/agent/personas/`. |

The file stem is the persona id (`ada.md` → `ada`). Editing a file applies on the next turn; deleting
it stops the injection.

## Persona file format

Structured markdown, frontmatter optional:

```markdown
---
name: Ada
title: senior backend engineer
---

## Role

You are Ada, a senior backend engineer, and you inherit the neutral persona and every harness rule above.

## Scope

You own services, APIs, data models and their tests.

## How you work

You read the existing code before you write, and you return evidence instead of claims.

## Reporting

For every order you receive, report status to the session that delegated it, or to the human when
nobody did: what finished with its evidence, what blocks progress, and what decision is the human's.

## Limits

You do not commit, push, open a pull request, merge or run destructive operations without the
human's explicit authorization for that action.
```

Without frontmatter the file stem is the display name. The body is appended verbatim under a
`## Session persona: <name>` heading.

The copy-ready file is [`assets/persona-template.md`](assets/persona-template.md):

```bash
mkdir -p .pi/personas && cp assets/persona-template.md .pi/personas/ada.md
```

The agent home is resolved as Gentle Shell resolves it: `GENTLE_PI_AGENT_HOME`, then
`PI_CODING_AGENT_DIR`, then the Gentle Shell prefix `~/.gentle-shell/agent`, then `~/.pi/agent`.

## Install in Gentle Shell

Gentle Shell runs its own Pi home (`~/.gentle-shell/agent`), so the package is installed into that home,
not into a separate Pi install:

```bash
# from the public repository
gentle-shell install git+https://github.com/sdiazbarraza/pi-session-personas-gs

# or from a local checkout
gentle-shell install /path/to/pi-session-personas-gs
```

`gentle-shell install <spec>` runs Pi's own `install` against the resolved home. Without the CLI, add
the same spec to the `packages` array of `~/.gentle-shell/agent/settings.json`:

```json
"packages": ["/path/to/pi-session-personas-gs"]
```

Then restart Gentle Shell, or run `/reload`, so the extension is loaded.

## First run

1. Confirm the command is registered: `/gentle:sesion-persona` offers a selector (empty until a
   persona file exists, and it names the expected directory).
2. Create a persona from the template:

   ```bash
   mkdir -p .pi/personas
   cp /path/to/pi-session-personas-gs/assets/persona-template.md .pi/personas/ada.md
   ```

3. Select it: `/gentle:sesion-persona ada`. The session is renamed to `Ada` and the persona applies
   from the next turn.

For personas shared by every project, put the file in `~/.gentle-shell/agent/personas/` instead.

## Update and remove

```bash
gentle-shell update pi-session-personas-gs
gentle-shell remove pi-session-personas-gs
```

## Gentle Hub

[Gentle Hub](https://gentlemanprogramming.com/gentle-hub/) lists public repositories that carry the
GitHub topics `gentle-shell-package` (resource) and `gentle-shell-extension` (subtype). It reads the
repository description and this README; discovery is eventual.

```bash
gh repo edit sdiazbarraza/pi-session-personas-gs \
  --description "Switchable session personas for Gentle Shell, defined as your own structured markdown files" \
  --add-topic gentle-shell-package --add-topic gentle-shell-extension
```

## Test

```bash
node --test "tests/*.test.ts"
```

The suite covers frontmatter parsing, discovery and precedence, the selector, the activation and
clearing paths, the persistence and restore, the neutral-prompt inheritance, the subagent skip, and
the shipped template contract.

## Layout

```
extensions/session-persona.ts   discovery, selector, injection, persistence
assets/persona-template.md      copy-ready persona template (no personas are bundled)
tests/session-persona.test.ts   node:test suite
```
