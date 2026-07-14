# Publishing guide — Claude & Codex Tmux Sidebar

## 0. Verify package metadata

`package.json` currently uses publisher `Danesed` and the
`Danesed/claude-tmux-sidebar` repository. Confirm those values before release.

## 1. Publish the source on GitHub

```bash
cd claude-tmux-sidebar
git add -A && git commit -m "Claude & Codex Tmux Sidebar v0.7.0"
git branch -M main
git remote add origin https://github.com/Danesed/claude-tmux-sidebar.git
git push -u origin main
```

(Optional) tag releases and attach the `.vsix` to a GitHub Release.

## 2. Create a Marketplace publisher (one time)

1. Sign in at https://marketplace.visualstudio.com/manage with a Microsoft
   account.
2. **Create publisher** — the **ID** you choose goes into `package.json`
   (`"publisher"`).
3. Create an **Azure DevOps Personal Access Token (PAT)**:
   https://dev.azure.com → User settings → Personal Access Tokens → New Token →
   Organization: **All accessible**, Scope: **Marketplace → Manage**. Copy it.

## 3. Log in and publish

```bash
npm i -g @vscode/vsce          # or use npx
vsce login YOUR_PUBLISHER_ID   # paste the PAT
vsce publish                   # reads version from package.json
```

Bump + publish in one step later:

```bash
vsce publish patch   # 0.5.0 -> 0.5.1   (also: minor / major)
```

Or upload the `.vsix` manually at https://marketplace.visualstudio.com/manage.

## 4. (Optional) Open VSX — for Cursor / VSCodium users

```bash
npm i -g ovsx
ovsx create-namespace YOUR_PUBLISHER_ID -p <openvsx-token>
ovsx publish claude-tmux-sidebar-<version>.vsix -p <openvsx-token>
```

## 5. Checklist before publishing

- [ ] `publisher`, `repository`, `homepage`, `bugs` updated
- [ ] real `icon.png` (≥ 128×128) in place
- [ ] `README.md` looks right (it's the Marketplace page)
- [ ] `npm run check` passes
- [ ] `TESTING.md` smoke test passes for both tabs and scrolling
- [ ] `CHANGELOG.md` updated
- [ ] `npx @vscode/vsce package` builds with no errors
- [ ] installed the built `.vsix` and smoke-tested on a real remote machine
- [ ] LICENSE present (MIT)
