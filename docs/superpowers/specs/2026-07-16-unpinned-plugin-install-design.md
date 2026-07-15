# Unpinned Plugin Installation Documentation Design

## Goal

Make the GitHub and npm README installation instructions easier to maintain and upgrade by using the unversioned `opencode-plugin-loop` package name in user-facing install and configuration examples.

## Scope

- Replace `opencode-plugin-loop@0.2.6` with `opencode-plugin-loop` in the recommended OpenCode installer command.
- Replace pinned package entries with `opencode-plugin-loop` in the `opencode.json` and `tui.json` examples.
- Add an explicit upgrade section that tells users to rerun:

  ```bash
  opencode plugin opencode-plugin-loop --global --force
  ```

- Explain that `--force` replaces the currently installed plugin version with the current npm release.
- Preserve historical compatibility references to versions 0.2.4 and 0.2.6 in troubleshooting and entrypoint documentation.
- Release the documentation change as package version 0.2.7 so npm can display the updated README; npm does not retroactively change the README of 0.2.6.

## Alternatives Considered

1. Use the bare package name. This matches OpenCode's official plugin configuration style and is the selected approach.
2. Use `opencode-plugin-loop@latest`. This is explicit but noisier and less consistent with OpenCode's documented examples.
3. Keep the initial install pinned and add only an unpinned upgrade command. This leaves users with pinned configuration and does not meet the upgrade goal.

## Documentation Behavior

The recommended installation and manual configuration paths will both store the bare package name. The README will distinguish installation from upgrading: first-time users run the installer once, while existing users rerun the same command with `--force` to replace the cached/installed package with the current npm release.

## Release and Verification

- Bump `package.json` and `package-lock.json` from 0.2.6 to 0.2.7.
- Confirm no `@0.2.6` pins remain in installation or configuration examples.
- Keep historical version references intact.
- Run the complete test suite and an npm publish dry run.
- Commit and push the existing pull-request branch.
- Publish 0.2.7 through npm staged publishing and approve it with 2FA.
- Verify the npm registry `latest` tag, downloadable tarball, and rendered README.

