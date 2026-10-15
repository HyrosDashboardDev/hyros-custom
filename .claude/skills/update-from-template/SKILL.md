---
name: update-from-template
description: Bring the HYROS dashboard template's latest changes (fixes, new tabs, core updates) into this dashboard with a git merge, on a branch the user previews before production. Use when the user asks to update the dashboard, to get the template's latest version, fixes or tabs, or asks whether an update is available.
---

# Update from the template

This dashboard was generated from the public template
`https://github.com/HyrosEngineeringAI/hyros-custom`. Generating copied the
template's files into one new commit with no shared git history, so the
first update anchors the history once; after that every update is a plain
`git merge`. Run it only when the user asks. Nothing here changes `main`
without the user's confirmation.

GitHub access for `origin` (fetch, pull, push) follows "GitHub access and
deploys" in `CLAUDE.md`: get a token with
`hyros_get_dashboard_repository_token` first. The template is public, so
reading it needs no token.

When `git remote get-url origin` ends in `HyrosEngineeringAI/hyros-custom.git`,
this is the template itself, not a dashboard: there is nothing to update
from, so say so and stop.

## 1. Start clean and up to date

- `git status` must be clean. If it is not, ask the user to commit or
  discard their changes first; never stash or reset them yourself.
- `git switch main` and `git pull origin main` (with a fresh token).

## 2. Is there an update?

```bash
git remote get-url template >/dev/null 2>&1 \
  || git remote add template https://github.com/HyrosEngineeringAI/hyros-custom.git
git fetch template
git merge-base --is-ancestor template/main HEAD && echo up-to-date
```

`up-to-date`: tell the user the dashboard already has the latest template
and stop. Otherwise summarize what the update brings (`git log --oneline
--no-merges HEAD..template/main` once anchored; before the first anchor,
the template commits after the base found in step 3) and ask the user
whether to go on.

## 3. Anchor the history (first update only)

Skip this step when `git merge-base HEAD template/main` prints a commit:
the history is already anchored.

Otherwise find the template commit this dashboard was generated from. Its
files are exactly those of the dashboard's first commit, so both commits
point to the same git tree:

```bash
TREE=$(git rev-parse "$(git rev-list --max-parents=0 HEAD | tail -1)^{tree}")
BASE=$(git log template/main --format='%H %T' | awk -v t="$TREE" '$2==t {print $1; exit}')
echo "${BASE:-no match}"
```

- `no match`: this dashboard was not generated from this template (or the
  template's history was rewritten). Tell the user it cannot be updated
  automatically and stop. Never merge with `--allow-unrelated-histories`
  alone: without a base, every file the dashboard changed conflicts.
- A commit: anchor on a branch for the update:

```bash
git switch -c template-update
git merge -s ours --allow-unrelated-histories --no-edit -m "Anchor to template commit $BASE" "$BASE"
```

`-s ours` records `BASE` as a parent and keeps every file as it is: the
merge changes no file, it only tells git where the dashboard came from.

## 4. Merge

```bash
git switch template-update 2>/dev/null || git switch -c template-update
git merge --no-edit template/main
```

Resolve conflicts with this rule, and list each resolution for the user:

| Path | Keep |
|---|---|
| `src/core/`, `src/data/`, `src/ui/`, `src/app.js`, `src/views/registry.js`, the template's own views, `styles.css`, `index.html`, `build.mjs`, `vercel.json`, `tests/`, `docs/`, `.claude/skills/`, `CLAUDE.md`, `VIEWS.md`, `UI-STYLE-GUIDE.md` | the template's (`git checkout --theirs <path>`) |
| `src/views/custom.js`, `src/views/custom-*/` | the dashboard's (`git checkout --ours <path>`) |
| anything else | show the user both sides and ask |

When the user had edited a file the template's version replaces, say so:
the edit is lost unless it is moved somewhere the dashboard owns (an own
view, or `custom.js`). Then `git add` the resolved paths and
`git commit --no-edit`.

## 5. Check and preview

1. `npm run check` must pass. A failure in an own view usually means the
   template changed something the view used: fix the view, not the
   template's files.
2. Push the branch: `git push origin template-update`. Vercel deploys a
   preview of it.
3. Give the user the preview and a summary: the template commits brought
   in, the conflicts and how each was resolved.

## 6. Production

Only when the user confirms, after looking at the preview: merge
`template-update` into `main` (`git switch main`, `git merge --ff-only
template-update`, `git push origin main`). A push to `main` is a production
deploy. Then delete the branch locally and on `origin`.

The next update repeats steps 1, 2, 4, 5 and 6; step 3 is never needed
again.
