---
name: update-from-template
description: Bring the HYROS dashboard template's latest changes (fixes, new tabs, core updates) into this dashboard with a git merge that goes to production once the user confirms. Use when the user asks to update the dashboard, to get the template's latest version, fixes or tabs, or asks whether an update is available.
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
- A commit: anchor on a local branch for the update:

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

Git merges on its own every change that touches different lines on each
side, including both sides' changes to the same file. What it cannot merge
it leaves as conflict blocks (`<<<<<<<` dashboard, `=======`, template
`>>>>>>>`), listed by `git status`. Work through them in this order.

### 4a. Tabs listed in `registry.js` (dashboards created before `custom.js`)

When `src/views/custom.js` did not exist in the dashboard before this merge,
its own tabs were listed in `VIEWS` in `src/views/registry.js`, and the
merge conflicts there. Move them before resolving that file, or they stop
showing:

1. Compare the dashboard's list (`git show HEAD:src/views/registry.js`)
   with the template's `TEMPLATE_VIEWS`.
2. Each id the dashboard has and the template does not is an own tab. If it
   does not start with `custom-`, rename it: `git mv src/views/<id>
   src/views/custom-<id>`, then set `id: 'custom-<id>'` in its `view.js`
   and rename its class prefix in `view.js` and `style.css`. Add every own
   tab, in the dashboard's order, to `CUSTOM_VIEWS` in
   `src/views/custom.js`.
3. Each template id missing from the dashboard's list was unplugged by the
   user: add it to `HIDDEN_VIEWS`.
4. Take the template's `registry.js` (`git checkout --theirs
   src/views/registry.js`): after the move nothing of the dashboard's is
   left in it.

Tell the user which tabs were renamed and which were hidden.

### 4b. Resolve each conflict

Resolve block by block, never a whole file at once: `git checkout --theirs`
or `--ours` on a file also throws away the other side's changes that git
had already merged in it.

| Path | Conflict blocks |
|---|---|
| `src/core/`, `src/views/registry.js` | keep the template's side of each block. The rules say these are not edited, and a dashboard that keeps its own version stops receiving the template's fixes there. Tell the user what was replaced. |
| everything else | the user decides, block by block |

For a block the user decides, show both sides in plain words: what the
dashboard has, what the template brings, and what each one does in the
dashboard. The user keeps the dashboard's, the template's, or a combination
you write and show them first. Group the small blocks of one file into one
question. When a file was deleted on one side and changed on the other, ask
whether to keep it.

When the user keeps their own version of a block in a template tab, tell
them that tab will conflict again whenever the template changes the same
lines, and that the template's fixes there will not reach it. The way out,
if they want it later: copy the tab to `custom-<id>`, keep their changes in
the copy and hide the original with `HIDDEN_VIEWS` (the `add-view` skill).

Then `git add` the resolved paths and `git commit --no-edit`.

`template-update` is a local branch only: it keeps `main` untouched until
the user confirms. Never push it.

## 5. Check and confirm

1. `npm run check` must pass. A failure in an own view usually means the
   template changed something the view used: fix the view, not the
   template's files.
2. Give the user a summary: the template commits brought in, the tabs moved
   to `custom.js`, and every conflict with the side kept.
3. Ask the user to confirm the update goes to production.

## 6. Production

Only when the user confirms:

```bash
git switch main
git merge --ff-only template-update
git push origin main
git branch -d template-update
```

A push to `main` is a production deploy. When the user does not confirm,
leave `main` as it is: `git switch main` and ask before deleting the
`template-update` branch.

The next update repeats steps 1, 2, 4, 5 and 6; step 3 is never needed
again.
