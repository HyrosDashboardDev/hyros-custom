---
name: update-from-template
description: Bring the HYROS dashboard template's latest changes (fixes, new tabs, core updates) into this dashboard, asking the user how each change that meets their customizations should apply, with a git merge that goes to production once the user confirms. Use when the user asks to update the dashboard, to get the template's latest version, fixes or tabs, or asks whether an update is available.
---

# Update from the template

This dashboard was generated from the public template
`https://github.com/HyrosEngineeringAI/hyros-custom`. Generating copied the
template's files into one new commit with no shared git history, so the
first update anchors the history once; after that every update is a plain
`git merge`. Run it only when the user asks. Nothing here changes `main`
without the user's confirmation.

The dashboard may have its own changes: its own tabs, template tabs it
edited or copied, its own styles. Before merging, map what the template
brings against those changes and ask the user how to apply each one that
meets them, so they end with the template's fixes and their own work intact.

GitHub access for `origin` (fetch, pull, push) depends on where you run,
as "GitHub access and deploys" in `AGENTS.md` says: on the user's
computer, get a token with `hyros_get_dashboard_repository_token` first; on
the web, `origin` works as it is. The template is public, so reading it
needs no token.

When `git remote get-url origin` ends in `HyrosEngineeringAI/hyros-custom.git`,
this is the template itself, not a dashboard: there is nothing to update
from, so say so and stop.

## 1. Start clean and up to date

- `git status` must be clean. If it is not, ask the user to commit or
  discard their changes first; never stash or reset them yourself.
- `git switch main` and `git pull origin main` (on the user's computer, with a
  fresh token).

## 2. Is there an update?

```bash
git remote get-url template >/dev/null 2>&1 \
  || git remote add template https://github.com/HyrosEngineeringAI/hyros-custom.git
git fetch template
git merge-base HEAD template/main || echo not-anchored
```

**Anchored** (a commit is printed): the history already shares an ancestor
with the template. That commit is `BASE`, the template commit the dashboard
last took.

```bash
git merge-base --is-ancestor template/main HEAD && echo up-to-date
git log --oneline --no-merges HEAD..template/main
```

**`not-anchored`** (no update ran yet): find the template commit this
dashboard was generated from now, before asking anything. Its files are
exactly those of the dashboard's first commit, so both commits point to the
same git tree:

```bash
TREE=$(git rev-parse "$(git rev-list --max-parents=0 HEAD | tail -1)^{tree}")
BASE=$(git log template/main --format='%H %T' | awk -v t="$TREE" '$2==t {print $1; exit}')
if [ -z "$BASE" ]; then echo "no match"
elif [ "$BASE" = "$(git rev-parse template/main)" ]; then echo up-to-date
else echo "BASE=$BASE"; git log --oneline --no-merges "$BASE..template/main"; fi
```

Note the `BASE` hash: steps 3 to 5 need it, and a shell variable does not
survive into the next command.

Do not use `HEAD..template/main` here: before the anchor, git sees no
shared history and lists every template commit ever made.

- `no match`: this dashboard was not generated from this template (or the
  template's history was rewritten). Tell the user it cannot be updated
  automatically and stop. Never merge with `--allow-unrelated-histories`
  alone: without a base, every file the dashboard changed conflicts.
- `up-to-date`: tell the user the dashboard already has the latest template
  and stop. Do not anchor: there is nothing to merge.
- Otherwise: go on to step 3.

## 3. Map the update

Read only: nothing changes until the user agrees to the plan at the end of
this step.

### 3a. What the dashboard changed

```bash
git diff --name-status <BASE> HEAD
```

lists every file the dashboard changed since the template commit it last
took. Sort them:

- **Own tabs:** `src/views/custom.js` and the `src/views/custom-*/`
  folders. For each own tab, note the template files it imports (the
  `import ... from` lines of its files: `src/core/`, `src/data/`,
  `src/ui/`, or another tab's files such as `../report/columns.js`).
- **Copied template tabs:** an own tab made from a template tab, usually
  `custom-<id>` with `<id>` in `HIDDEN_VIEWS`. When it is not clear which
  template tab a copy came from, ask.
- **Edited template files:** everything else, such as a template tab
  changed in place, `styles.css`, `index.html` or `AGENTS.md`.

### 3b. What the template brings

```bash
git log --first-parent --reverse --format='%h %s' <BASE>..template/main
```

Each line is one change: a merged pull request (`Merge pull request #...`,
whose commits `git log --oneline <hash>^1..<hash>^2` lists) or a commit made
straight on the template's `main`. For each change, read what it does and
the files it touches:

```bash
git diff --name-status <hash>^1 <hash>
git diff <hash>^1 <hash> -- <file>
```

Also compare `TEMPLATE_VIEWS` in `git show <BASE>:src/views/registry.js`
with the one in `git show template/main:src/views/registry.js`: the
template may add or remove tabs.

### 3c. Sort each change

| The change | What happens |
|---|---|
| touches only files the dashboard did not change and its own tabs do not import | it applies. List it in the summary, with no question |
| touches `src/core/` or `src/views/registry.js` | it applies: the rules say these are not edited. When the dashboard changed the same lines, tell the user what is replaced |
| touches an edited template file | ask: keep the dashboard's version of those lines, take the template's, or combine both |
| touches a template file an own tab imports | it applies. Note the own tab: step 5d checks it still works and asks before changing it |
| touches a template tab the dashboard copied | it applies to the original, which stays hidden. Ask whether to bring the same change into the copy |
| adds a template tab | ask whether to show it or hide it with `HIDDEN_VIEWS` |
| removes a template tab listed in `HIDDEN_VIEWS` | tell the user; its id leaves `HIDDEN_VIEWS`, or `npm run check` fails |
| touches `src/views/custom.js` or a `custom-*` folder | the template never does this. Never apply it without asking |

"Take the template's" brings the template's change into the file; the
dashboard's own changes to other lines of that file stay. "Keep the
dashboard's" leaves the lines the template changed as the dashboard has
them: tell the user git counts that change as taken, so later updates never
bring it back, and the template's fixes to those lines will not reach the
dashboard.

### 3d. Dependencies between changes

A change depends on an earlier one when it changes lines that one added, or
uses something that one added or renamed: a function, an export, a class, a
token, a file. Before asking, check each change the table says to ask about
against the later changes in the list: search their diffs for the lines and
names it adds (`git diff <later>^1 <later>`).

When a change the user may keep out has later changes that depend on it,
say so in the same question: keeping it out breaks those, so the choice is
both in, both out, or a combination that keeps the dashboard's lines and
adds what the later change needs. The same goes for an own tab that uses
something a change removes or renames: say which tab and what it uses.

### 3e. Ask and agree on the plan

Ask about each change the table marks, in plain words: what it does in the
dashboard, what the dashboard has there now, and the choices. One question
per change, not per file; changes that depend on each other share one
question. When the user wants a combination, such as moving the template's
new feature into one of their own tabs, write how it will look and show it
before going on.

Then show the plan: the changes that apply with no question, each decision,
and the own tabs step 5d will check. Go on only when the user agrees.

## 4. Anchor the history (first update only)

Only when step 2 printed `not-anchored`. Anchor on a local branch for the
update, with the hash step 2 printed as `BASE=`:

```bash
BASE=<the hash step 2 printed>
git switch -c template-update
git merge -s ours --allow-unrelated-histories --no-edit -m "Anchor to template commit $BASE" "$BASE"
```

`-s ours` records `BASE` as a parent and keeps every file as it is: the
merge changes no file, it only tells git where the dashboard came from.

## 5. Merge

```bash
git switch template-update 2>/dev/null || git switch -c template-update
git merge --no-commit --no-ff template/main
```

Git merges on its own every change that touches different lines on each
side, including both sides' changes to the same file. What it cannot merge
it leaves as conflict blocks (`<<<<<<<` dashboard, `=======`, template
`>>>>>>>`), listed by `git status`. `--no-commit` stops before the merge
commit, so the decisions of step 3 apply to both. Work in this order.

### 5a. Tabs listed in `registry.js` (dashboards created before `custom.js`)

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
3. A template tab the user unplugged is one that was in the list of the
   template commit the dashboard last took and is missing from the
   dashboard's list. Compare against that commit, not against
   `TEMPLATE_VIEWS`: tabs the template added since then were never in the
   dashboard and must not be hidden.

   ```bash
   git show "$(git merge-base HEAD template/main)":src/views/registry.js
   ```

   Add each unplugged id to `HIDDEN_VIEWS`.
4. Take the template's `registry.js` (`git checkout --theirs
   src/views/registry.js`): after the move nothing of the dashboard's is
   left in it.

Tell the user which tabs were renamed and which were hidden.

### 5b. Own instructions in `CLAUDE.md` (dashboards created before `AGENTS.md`)

The instructions moved from `CLAUDE.md` to `AGENTS.md`, which Claude Code
and Cursor both read; `CLAUDE.md` is now only `@AGENTS.md`. When the
dashboard changed its `CLAUDE.md`, the merge conflicts there, and those
changes must move or they stop applying:

1. See what the dashboard changed:
   `git diff "$(git merge-base HEAD template/main)" HEAD -- CLAUDE.md`.
2. Make each change in `AGENTS.md`, at the same place in the text, and
   show the user the result.
3. Take the template's `CLAUDE.md` (`git checkout --theirs CLAUDE.md`).

### 5c. Apply the decisions to edited files

For each edited template file a change touched, `git diff HEAD -- <file>`
shows what the merge brings into the dashboard's version, conflict blocks
included. Make it match the decisions of step 3:

- **Take the template's:** keep what git merged; in a conflict block keep
  the template's side, and the dashboard's lines outside it.
- **Keep the dashboard's:** put back the dashboard's lines for that change
  (`git show HEAD:<file>` has them) and leave the rest of the merge.
- **Combine:** write what you showed the user.

Resolve block by block, never a whole file at once: `git checkout --theirs`
or `--ours` on a file also throws away the other side's changes that git
had already merged in it. Conflict blocks in `src/core/` and
`src/views/registry.js` keep the template's side. A block step 3 did not
foresee is asked the same way, showing both sides in plain words; when a
file was deleted on one side and changed on the other, ask whether to keep
it.

When the user keeps their own version of a block in a template tab, tell
them that tab will conflict again whenever the template changes the same
lines, and that the template's fixes there will not reach it. The way out,
if they want it later: copy the tab to `custom-<id>`, keep their changes in
the copy and hide the original with `HIDDEN_VIEWS` (the `add-view` skill).

`git add` each path once it is resolved.

### 5d. Own tabs

These are the user's files: change them only as agreed in step 3, or after
asking.

- **Changes brought into a copied tab:** apply the template's change to the
  original onto the copy, then resolve what does not fit with the user
  (the copy's id and class prefix differ, and the user changed it):

  ```bash
  git diff <BASE> template/main -- src/views/<id>/ \
    | sed 's#src/views/<id>/#src/views/custom-<id>/#g' \
    | git apply --3way
  ```

  Narrow the diff to the agreed change with `<hash>^1 <hash>` in place of
  `<BASE> template/main` when the user wants only some of the changes to
  that tab.

  Every line the patch brings, applied cleanly or not, carries the
  original's class prefix: rename it to the copy's (`<id>-` to
  `custom-<id>-` in `view.js`, its sibling files and `style.css`), leaving
  import paths alone. In conflict blocks, keep the copy's `id` and `title`
  and the user's own changes; the rest is usually only the prefix, so take
  the template's side with the copy's prefix.
- **New and removed template tabs:** add to or take from `HIDDEN_VIEWS` in
  `src/views/custom.js` as agreed.
- **Own tabs that import a changed file:** check each import still exists
  and still works the way the tab uses it. When it does not, tell the user
  what changed and how you would fix the tab, and fix it only when they
  agree. Fix the tab, never the template's file.

Then check nothing else of the user's changed:

```bash
git diff HEAD --stat -- src/views/custom.js 'src/views/custom-*'
```

must list only what the user agreed to.

### 5e. Commit the merge

```bash
git add <the resolved paths>
git commit --no-edit
```

`template-update` is a local branch only: it keeps `main` untouched until
the user confirms. Never push it.

## 6. Check and confirm

1. `npm run check` must pass. A failure in an own tab usually means the
   template changed something the tab used: fix the tab (with the user's
   agreement, as in 5d), not the template's files.
2. Give the user a summary: the changes applied with no question, each
   decision and the side kept, the changes brought into copied tabs, the
   own tabs fixed, the tabs moved to `custom.js` or hidden, and the
   template changes kept out, which later updates will not bring back.
3. Ask the user to confirm the update goes to production.

## 7. Production

Only when the user confirms:

```bash
git switch main
git merge --ff-only template-update
git push origin main
git branch -d template-update
```

A push to `main` is a production deploy. When the user does not confirm,
leave `main` as it is: `git switch main` and ask before deleting the
`template-update` branch. It is not merged into `main`, so deleting it takes
`git branch -D template-update`.

The next update repeats every step but 4, which is never needed again.
