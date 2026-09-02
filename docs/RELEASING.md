# Releasing Codex Control Plane

Desktop releases are built on GitHub's native macOS, Windows and Linux runners. The tag must exactly match the version in `package.json`.

## Prepare a release

1. Update `version` in `package.json`.
2. Run `npm install`, `npm test` and `npm run dist` on a supported development machine.
3. Commit the version change and push it to `main`.
4. Create and push the matching tag, for example `v0.1.0` for version `0.1.0`.

## Automated release output

The **Build desktop installers** workflow will:

- build DMG/ZIP, NSIS/portable EXE, AppImage and DEB artifacts;
- attest the build provenance through GitHub artifact attestations;
- generate `SHA256SUMS.txt` for every installer;
- create a GitHub Release with automatically generated notes;
- safely replace assets if the release job is re-run.

Verify a downloaded checksum on macOS or Linux:

```bash
sha256sum -c SHA256SUMS.txt --ignore-missing
```

Verify build provenance with GitHub CLI:

```bash
gh attestation verify <installer> --repo EIRCQi/codex-control-plane
```

## Signing status

The current workflow produces unsigned test packages. Do not describe them as trusted production installers until Windows code-signing and Apple Developer ID/notarization secrets are configured.
