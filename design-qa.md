# Midnight Brick Palette Design QA

## Evidence

- Source visual truth:
  - `/home/shuv/.codex/attachments/6f86e268-9ac4-4844-a9e9-e81150a539fb/codex-clipboard-724a5de6-83b0-4d51-b1df-580706e39c85.png`
  - `/home/shuv/.codex/attachments/cf40d1b9-6fd2-495f-af24-b1667ba1f64d/codex-clipboard-929ef7da-54c8-4155-acdd-6b2a1ec17d95.png`
- Dark implementation: `/tmp/shuv2code-midnight-brick-dark-final.png`
- Light implementation: `/tmp/shuv2code-midnight-brick-light-final.png`
- Combined comparison: `/tmp/shuv2code-palette-comparison.png`
- Browser viewport: `1440 x 960` CSS px at device scale factor `1`.
- Source pixels: `1834 x 1226` for the dark settings reference and
  `1296 x 1668` for the paired dark/light reference.
- Implementation pixels: `1440 x 960` for each theme.
- Comparison normalization: the paired reference was cropped into
  `1175 x 700` dark and light app regions; implementation captures were scaled
  into matching `1175 x 700` montage cells without changing their source
  aspect ratio.
- State: authenticated Settings > General with the same setting values in dark
  and light mode.

## Full-View Comparison

The final combined comparison shows the intended palette relationship in both
themes. Dark mode is carried by the four sampled navy surfaces with cool white
and slate text; light mode is carried by paper, white, warm gray, and ink. The
brick family remains a small, consistent interaction accent in both. Existing
shuv2code information architecture and density were intentionally preserved
because the supplied screens are palette references, not replacement layouts.

## Required Fidelity Surfaces

- Fonts and typography: existing DM Sans and JetBrains Mono typography,
  hierarchy, weights, wrapping, and antialiasing remain unchanged. The
  reference did not request a typography replacement.
- Spacing and layout rhythm: existing Settings layout, sidebar proportions,
  control alignment, radii, and spacing remain unchanged. No overflow or
  cropped persistent controls appeared at `1440 x 960`.
- Colors and visual tokens: browser-computed dark tokens match `#0C1119`,
  `#0F1621`, `#1F2835`, `#8995A6`, `#E7ECF3`, and `#D35C46`. Browser-computed
  light tokens match `#FAF8F5`, `#FFFFFF`, `#DBD7CD`, `#1C1A17`, and
  `#B64E36`. The sampled `#77736B` is represented by the visually equivalent
  `#76726A` for small muted text so it reaches WCAG AA. The additional sampled
  muted surfaces are present in the token system even when not exposed by this
  Settings state.
- Image quality and asset fidelity: the existing vector devil-terminal mark
  was recolored from its master SVG, and all 39 generated raster/ICO assets
  were regenerated. No placeholder, rasterized substitute, or CSS-drawn mark
  was introduced.
- Copy and content: app copy was preserved. Differences from the reference copy
  are expected because the references demonstrate color on illustrative
  Settings and diff content rather than specifying production copy changes.

## Focused Comparison

A separate focused crop was not needed: the sidebar/header, selected rows,
switches, fields, muted text, and brand mark are clearly readable at the full
comparison resolution. Exact browser-computed token values provide stronger
color evidence than resampling another screenshot crop.

## Comparison History

1. The first light browser capture showed the environment artwork using brick
   as a broad base gradient, which was a P2 mismatch against the reference's
   quiet paper surface.
2. The light stage base was changed to `#FAF8F5`, `#F1EEE9`, and `#DBD7CD`,
   leaving brick only in the low-opacity decorative glow.
3. The light and dark views were recaptured. The final combined comparison
   shows no large warm field and no remaining actionable P0, P1, or P2 palette
   mismatch.

## Interaction and Runtime Checks

- Navigated between General and Appearance.
- Changed the theme from Dark to Light and back to Dark through the visible
  theme control.
- Verified computed root theme tokens after each change.
- Checked the browser console and page error log; no application errors were
  present.

## Findings

No actionable P0, P1, or P2 findings remain for the palette-only scope.

## Follow-up Polish

None required for this iteration.

final result: passed
