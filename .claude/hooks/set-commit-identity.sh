#!/bin/sh
# Sets this repository's commit identity to the GitHub account that owns it, read from the
# origin remote, so every commit from any session is authored by that account whatever the
# environment the repository was created in. Known owners get the GitHub noreply address that
# carries their account id, which is what links the commits to the account on GitHub. When
# Claude Code provides a session environment file, the identity is exported there too, so it
# also applies where git ignores the repository config. It also points git at .githooks, whose
# commit-msg drops the trailers a client adds on its own. Claude Code and Cursor both run it on
# session start (.claude/settings.json, .cursor/hooks.json).

dir="${CLAUDE_PROJECT_DIR:-.}"
url=$(git -C "$dir" remote get-url origin 2>/dev/null) || exit 0

# Accepted forms: https://host/owner/repo, https://user:token@host/owner/repo,
# ssh://git@host/owner/repo and git@host:owner/repo
owner=$(printf '%s\n' "$url" | sed -E 's#^[A-Za-z]+://[^/]+/##; s#^[^/:]+:##; s#/.*$##')
[ -n "$owner" ] || exit 0

case "$owner" in
    HyrosEngineeringAI) email="336926713+$owner@users.noreply.github.com" ;;
    HyrosDashboardDev) email="343558107+$owner@users.noreply.github.com" ;;
    *) email="$owner@users.noreply.github.com" ;;
esac

git -C "$dir" config user.name "$owner"
git -C "$dir" config user.email "$email"
[ -f "$dir/.githooks/commit-msg" ] && git -C "$dir" config core.hooksPath .githooks

if [ -n "$CLAUDE_ENV_FILE" ] && ! grep -qsF "export GIT_COMMITTER_EMAIL=$email" "$CLAUDE_ENV_FILE"; then
    {
        echo "export GIT_AUTHOR_NAME=$owner"
        echo "export GIT_AUTHOR_EMAIL=$email"
        echo "export GIT_COMMITTER_NAME=$owner"
        echo "export GIT_COMMITTER_EMAIL=$email"
    } >> "$CLAUDE_ENV_FILE"
fi

exit 0
