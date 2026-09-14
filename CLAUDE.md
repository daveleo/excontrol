# Working conventions for eXcontrol

## Commit and push early and often

This project is worked on from multiple machines (dev PCs, the CBLATest showroom
machine). A local machine crashing has previously cost real, verified work because it
sat uncommitted. To prevent that:

- Commit as soon as a change is working and tested, not at the end of a long session.
  A change verified against CBLATest or other real hardware and then left uncommitted
  is the exact failure mode to avoid.
- Push to `origin/main` right after committing. Don't let commits sit local-only —
  a crash before a push loses them just as easily as a crash before a commit.
- Prefer several small commits over one large batched one. If a session touches
  several unrelated things (UI fix + docs + version bump), split them into separate
  commits as normal, but commit/push each as it's finished rather than holding
  everything until the end.
- This repo has no feature-branch workflow today — commits go straight to `main`.
  That's fine and matches existing history; the point above is about *frequency*,
  not branch structure. If a change is experimental/likely to be reverted, a
  short-lived branch is fine, but push it too rather than leaving it local-only.

## Versioning

- Version bumps touch all of: root `package.json`, `backend/package.json`,
  `desktop/package.json`, `frontend/package.json`, `shared/package.json`, and
  `package-lock.json` — all set to the same version, in one commit titled `vX.Y.Z`
  with a short body describing what's included since the last bump. See the git
  history for examples (`e7afdc7`, `7d4c201`).
- A version bump commit does not by itself cut a GitHub Release — that needs an
  annotated tag `vX.Y.Z` pushed separately, which triggers `.github/workflows/release.yml`
  to build the Windows installer and publish it. Confirm with the user before pushing
  a release tag, since it publishes publicly.
- `docs/ROADMAP.md` is the changelog — keep it current per change, not just at
  version-bump time.
