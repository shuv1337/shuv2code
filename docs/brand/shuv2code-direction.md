# shuv2code Brand Direction

## Approved mark

Approved on 2026-07-28 from
[`shuv2code-mark-concepts.png`](./shuv2code-mark-concepts.png): **top row,
middle**.

The mark is a compact rounded phone-terminal with:

- slim horns integrated into the top corners;
- a small speaker slot;
- a deep inset screen;
- a minimal `>_` terminal prompt;
- a short, restrained pointed tail emerging from the right side.

This is a distinct sibling to the shuvscode devil rotary-phone mark. It keeps
the playful horn-and-tail family language while replacing the rotary telephone
body with a coding-agent terminal.

## Geometry rules

- Use one shared silhouette across production, nightly, and development.
- Preserve a near-square footprint and generous exterior padding.
- Keep horns broad enough to survive 16 px rasterization.
- Keep the prompt negative space open enough to remain legible at 32 px.
- Do not add a face, rotary dial, flames, pitchfork, badge, or enclosing circle.
- The tail is optional below 24 px when it would blur into the phone body.

## Channel colors

| Channel     | Body                     | Screen              | Prompt               |
| ----------- | ------------------------ | ------------------- | -------------------- |
| Production  | devil red `#F90E0A`      | deep navy `#011627` | warm white `#F7F1E6` |
| Nightly     | moonlit violet `#7656E8` | deep navy `#011627` | warm white `#F7F1E6` |
| Development | blueprint blue `#176BFF` | deep navy `#011627` | warm white `#F7F1E6` |

The application interface uses amber `#F3B042` for focus, selection, links,
and primary action. Red is not a general interaction accent.

## Source-of-truth policy

- `assets/brand/shuv2code-devil-terminal.svg` is the full-color production
  vector master.
- `assets/brand/shuv2code-devil-terminal-monochrome.svg` is the mask and
  one-color master.
- Channel Icon Composer projects remain the source of truth for complete
  platform app icons.
- Generated PNG and ICO assets must not be edited directly.
