# Unpinned Plugin Installation Documentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish README guidance that installs, configures, and upgrades `opencode-plugin-loop` without embedding a package version.

**Architecture:** Keep runtime code unchanged. Update the single source README used by GitHub and npm, bump package metadata to 0.2.7 so npm receives the new README, then verify and publish the exact tarball through npm staged publishing.

**Tech Stack:** Markdown, JSON package metadata, npm, Git, OpenCode CLI documentation

## Global Constraints

- Installation and configuration examples must use the bare package name `opencode-plugin-loop`.
- The upgrade command must be `opencode plugin opencode-plugin-loop --global --force`.
- Historical compatibility references to versions 0.2.4 and 0.2.6 must remain intact.
- Runtime TypeScript behavior must not change.
- The documentation release version is 0.2.7.

---

### Task 1: Update installation, configuration, and upgrade guidance

**Files:**
- Modify: `README.md:37-80`

**Interfaces:**
- Consumes: OpenCode's npm plugin syntax and the existing `opencode.json`/`tui.json` examples.
- Produces: The README content rendered by GitHub and embedded in the npm 0.2.7 tarball.

- [ ] **Step 1: Replace the recommended installer command**

Change the command to:

```bash
opencode plugin opencode-plugin-loop --global --force
```

Replace the pinning explanation with text explaining that the command adds the package to both global configs.

- [ ] **Step 2: Add explicit upgrade instructions**

Add a `### Upgrade` subsection after the installer explanation containing the same command:

```bash
opencode plugin opencode-plugin-loop --global --force
```

Explain that `--force` replaces the installed plugin with the current npm release and updates both config files without requiring users to edit a version number.

- [ ] **Step 3: Remove version pins from manual configuration**

Use the following package entries in both JSON examples:

```json
"plugin": ["opencode-plugin-loop"]
```

Change “same pinned package” to “same package name.”

- [ ] **Step 4: Verify documentation scope**

Run:

```bash
rg -n "opencode-plugin-loop@0\.2\.6|same pinned package|replace `0\.2\.6`" README.md
```

Expected: no output.

Run:

```bash
rg -n "Package entrypoints in 0\.2\.6|Versions before 0\.2\.4|Upgrade to 0\.2\.6" README.md
```

Expected: all three historical references remain.

- [ ] **Step 5: Commit the README change**

```bash
git add README.md
git commit -m "docs: use unpinned plugin install guidance"
```

### Task 2: Prepare package version 0.2.7

**Files:**
- Modify: `package.json:3`
- Modify: `package-lock.json:3,9`
- Modify: `tests/package-exports.test.mjs:10`

**Interfaces:**
- Consumes: The verified README from Task 1.
- Produces: npm package metadata for the immutable 0.2.7 release.

- [ ] **Step 1: Update package metadata**

Set every project version field currently equal to `0.2.6` in `package.json` and `package-lock.json` to `0.2.7`.

Update the published-release assertion in `tests/package-exports.test.mjs`:

```javascript
assert.equal(packageJson.version, "0.2.7")
```

- [ ] **Step 2: Verify synchronized versions**

Run:

```bash
node -e 'const p=require("./package.json"),l=require("./package-lock.json"); if(p.version!=="0.2.7"||l.version!=="0.2.7"||l.packages[""].version!=="0.2.7") process.exit(1); console.log("0.2.7")'
```

Expected: `0.2.7`.

- [ ] **Step 3: Verify the release assertion**

Run:

```bash
node --test tests/package-exports.test.mjs
```

Expected: all package export tests pass.

- [ ] **Step 4: Commit package metadata**

```bash
git add package.json package-lock.json tests/package-exports.test.mjs docs/superpowers/plans/2026-07-16-unpinned-plugin-install.md
git commit -m "chore: prepare 0.2.7 release"
```

### Task 3: Verify and push the documentation release

**Files:**
- Test: `README.md`
- Test: `package.json`
- Test: `package-lock.json`
- Test: npm tarball contents generated from the repository root

**Interfaces:**
- Consumes: Tasks 1 and 2 commits.
- Produces: A tested and pushed branch ready for npm publishing.

- [ ] **Step 1: Run the complete test suite**

Run:

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 2: Verify the publish payload**

Run:

```bash
npm publish --dry-run
```

Expected: package `opencode-plugin-loop@0.2.7`, README included, and no publish errors.

- [ ] **Step 3: Inspect the final change set**

Run:

```bash
git diff origin/codex/responsive-loop-dialog-impl...HEAD --check
git status --short --branch
```

Expected: no whitespace errors and a clean branch ahead of its remote.

- [ ] **Step 4: Create a documentation release branch**

```bash
git checkout -b codex/unpinned-plugin-install
```

Expected: the worktree is on `codex/unpinned-plugin-install`, based on the tested release commit.

- [ ] **Step 5: Push the release branch**

```bash
git push -u origin codex/unpinned-plugin-install
```

Expected: the remote branch contains the README and 0.2.7 metadata commits.

- [ ] **Step 6: Create and merge a focused pull request**

```bash
gh pr create --base main --head codex/unpinned-plugin-install --title "docs: simplify plugin installation and upgrades" --body "Use the unversioned npm package name in OpenCode installation and configuration examples, add an explicit upgrade command, and prepare the npm 0.2.7 documentation release."
gh pr merge --merge
```

Expected: the pull request contains only the unpinned documentation release changes and is merged into GitHub `main`.

- [ ] **Step 7: Verify GitHub main**

Run:

```bash
git fetch origin
git diff --exit-code HEAD:README.md origin/main:README.md
```

Expected: GitHub `main` contains the same README as the verified release commit.

### Task 4: Publish and verify npm 0.2.7

**Files:**
- Verify: npm registry metadata and tarball for `opencode-plugin-loop@0.2.7`

**Interfaces:**
- Consumes: The exact verified working-tree package from Task 3.
- Produces: Public npm release 0.2.7 with `latest` set to 0.2.7 and the updated README.

- [ ] **Step 1: Stage the release**

Run:

```bash
npx --yes npm@latest stage publish .
```

Expected: `opencode-plugin-loop@0.2.7` is staged and a stage ID is returned.

- [ ] **Step 2: Approve with npm 2FA**

Open npm's Staged Packages page, choose `opencode-plugin-loop@0.2.7`, click **Approve**, and complete the configured security-key challenge.

Expected: npm reports `opencode-plugin-loop@0.2.7 published successfully`.

- [ ] **Step 3: Verify registry metadata and README**

Run:

```bash
npm view opencode-plugin-loop version dist-tags --json
npm view opencode-plugin-loop@0.2.7 readme | rg -n "opencode plugin opencode-plugin-loop --global --force|\"plugin\": \[\"opencode-plugin-loop\"\]"
```

Expected: `version` and `latest` are both `0.2.7`; the unpinned install, upgrade, and configuration examples appear in the remote README.

- [ ] **Step 4: Verify the downloadable tarball**

Run:

```bash
npm pack https://registry.npmjs.org/opencode-plugin-loop/-/opencode-plugin-loop-0.2.7.tgz --dry-run --json
```

Expected: package ID `opencode-plugin-loop@0.2.7`, README included, and integrity metadata returned.
