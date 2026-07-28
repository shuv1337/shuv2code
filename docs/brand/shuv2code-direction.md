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
- Make the dark terminal screen the dominant interior shape: approximately
  58% of the view-box width, with a compact 28–36 unit red casing around it.
- Keep the horns and tail subordinate to the screen rather than letting them
  define the apparent size of the mark.
- Do not add a face, rotary dial, flames, pitchfork, badge, or enclosing circle.
- The tail is optional below 24 px when it would blur into the phone body.

## Channel colors

| Channel     | Body                     | Screen                  | Prompt               |
| ----------- | ------------------------ | ----------------------- | -------------------- |
| Production  | midnight brick `#D35C46` | midnight navy `#0C1119` | cool white `#E7ECF3` |
| Nightly     | moonlit violet `#7656E8` | midnight navy `#0C1119` | cool white `#E7ECF3` |
| Development | blueprint blue `#176BFF` | midnight navy `#0C1119` | cool white `#E7ECF3` |

The application uses the paired Midnight Brick palettes sampled from the
approved dark and light references. Dark mode uses canvas `#0C1119`, sidebar
`#0F1621`, muted surface `#161D28`, elevated surface `#1F2835`, muted text
`#8995A6`, foreground `#E7ECF3`, and brick `#D35C46`. Light mode uses paper
`#FAF8F5`, sidebar `#F1EEE9`, white `#FFFFFF`, selected surface `#DBD7CD`,
muted text `#77736B`, ink `#1C1A17`, and brick `#B64E36`. Brick is the shared
warm accent family for identity, focus, selection, links, and primary actions.
Navy or paper remains dominant, while brick stays below roughly ten percent of
the working surface. Semantic warning amber, danger red, and diff green remain
available only for genuine status states.

For small muted text on the paper canvas, use the one-step darker
`#76726A` accessibility correction; it preserves the sampled hue while meeting
WCAG AA against `#FAF8F5`.

## Source-of-truth policy

- `assets/brand/shuv2code-devil-terminal.svg` is the full-color production
  vector master.
- `assets/brand/shuv2code-devil-terminal-monochrome.svg` is the mask and
  one-color master.
- Channel Icon Composer projects remain the source of truth for complete
  platform app icons.
- Generated PNG and ICO assets must not be edited directly.
