# Upstream sync policy

shuv2code is a long-lived fork of `pingdotgg/t3code`. Sync work should preserve
that ancestry and keep product identity changes reviewable.

1. Fetch the current upstream default branch.
2. Create a dedicated sync branch from the current shuv2code branch.
3. Merge `upstream/main`; do not rebase a published shuv2code branch.
4. Resolve conflicts in favor of shuv2code's observable identity while
   retaining compatible upstream behavior.
5. Run `vp run brand:check`, `vp run schema:check`, focused tests, and the
   affected client verification skills.
6. Submit the merge through a pull request and describe intentional divergence.

Never squash the upstream merge into an opaque rewrite. Generated brand assets
come from the canonical SVG and manifest, so upstream icon churn should be
resolved by regenerating rather than hand-editing binaries.
