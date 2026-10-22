---
name: interface-design
description: Build or refine application interfaces with visual fidelity to supplied mockups and the existing design system. Use for UI design, redesign, CSS/layout, SVG icons, and visual polish; especially when a user supplies a reference or reports inconsistent backgrounds, alignment, icons, or styling.
---

# Interface design

## Establish the visual target

- Render the supplied reference before implementing it. Reading its HTML/CSS alone does not establish its appearance. Inspect the existing application alongside it at the same viewport.
- Record the few measurements that define the screen: layout widths, spacing, density, typography, surface hierarchy, radii, icon sizes, and alignment. Reuse existing tokens/components when they fit that target.
- Later user clarifications override the reference. Preserve intentional exceptions explicitly; do not silently reinterpret the design or add decorative components.
- Keep a module visually continuous with its surrounding application. Do not introduce a differently tinted page background or unrelated card/button system unless requested.

## Build coherent components

- Use actual SVG icons with recognizable silhouettes. Prefer the application's existing coherent icon set; draw a custom SVG when the required symbol is missing. Do not substitute emoji, Unicode glyphs, text sketches, or arbitrary CSS shapes for interface icons.
- Match viewBox, stroke weight, optical size, and baseline across icons. Inspect the rendered SVG at its real size in both themes; a valid SVG can still be a poor icon.
- Align text, status dots, badges, and controls through explicit flex/grid containers. Check optical centering, not just equal numeric margins. A status dot next to a name belongs in the same centered row.
- Maintain a clear type hierarchy, deliberate whitespace, consistent control heights, and predictable truncation. Check long names, large counts, missing data, and error states against real data.
- Prefer fixing shared component structure and conflicting styles over accumulating overrides. Keep existing behavior, accessibility, and responsive states intact.

## Iterate against the rendered result

1. Complete one representative view, then compare its screenshot with the reference at the same viewport. Correct composition and density before small decoration, then apply the established components to other views.
2. Inspect every requested view and its major interaction states, including drawers and menus. Compare backgrounds, card geometry, typography, SVGs, alignment, spacing, and hierarchy explicitly. A successful build is not visual acceptance.
3. Verify relevant desktop/mobile widths and both themes when supported. Use DOM measurements to resolve uncertain alignment or overflow, then inspect the screenshot again.
4. Fix visible mismatches before delivery. Keep evidence of the final rendered application, and state any remaining differences honestly. Do not claim a match merely because a screenshot was taken.

Do this work within the user's authorized scope and the repository's task/branch process. This skill does not add approval gates, authorize deployments, or require external image generation. SVG icons and code-native UI should normally remain editable source.
