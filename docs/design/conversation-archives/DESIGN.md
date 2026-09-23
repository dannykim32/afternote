---
name: Afternote Conversation Archives
description: Implemented design of the native macOS Archive list and read-only passage viewer.
---

# Design System: Conversation Archives

## Overview

This record applies only to `AfternoteArchiveWindow`, an Operate/Read extension of
the existing dark AppKit Notes surface. It records the implementation; it does not
establish or replace Afternote's global visual identity. The opening direction
contract in [`archive_window.mm`](../../../apps/local/native/archive_window.mm)
specifies system type, aligned toolbars, a bounded transcript list, and a
plain-text reader. Import is explicit, paused work remains visible, and locking
clears displayed Archive content.

The implementation and
[`native_appearance.mm`](../../../apps/local/native/native_appearance.mm) are the
visual sources of truth. [`CONVERSATION_ARCHIVES.md`](../../CONVERSATION_ARCHIVES.md)
owns the product, storage, authorization, and release contracts. There is no
project-wide `PRODUCT.md` or `DESIGN.md` to supersede.

This is native extraction, not a web token conversion. AppKit font roles, sRGB
components, and point measurements below retain their source semantics. No CSS
font substitutes, synthesized color ramps, or browser component previews are
specified; no `.impeccable/design.json` sidecar is generated.

## Colors

The window explicitly uses `NSAppearanceNameDarkAqua`. Its canvas, list, and
reader use `AfternoteCanvasColor`; ordinary text uses `AfternoteTextColor`, and
description/status text uses `AfternoteMutedTextColor`.

The following are native sRGB red/green/blue components with alpha 1, directly
from the shared appearance implementation:

| Native color | Components | Archive role |
| --- | --- | --- |
| `AfternoteCanvasColor` | 0.043, 0.051, 0.055 | Window, table, and reader background |
| `AfternoteTextColor` | 0.949, 0.941, 0.914 | Labels, reader text, ordinary button titles |
| `AfternoteMutedTextColor` | 0.573, 0.592, 0.588 | Description and status |
| `AfternoteRaisedSurfaceColor` | 0.110, 0.118, 0.129 | Ordinary action button fill |
| `AfternoteSurfaceColor` | 0.078, 0.086, 0.094 | Pressed action button fill |
| `AfternoteBorderColor` | 0.176, 0.188, 0.204 | Action button border |
| `StatusColor(@"error")` | 0.88, 0.44, 0.42 | Delete/discard button title tint |

Actions use the shared neutral secondary style, with a destructive tint for
deletion. This window does not assign Capture Teal to its actions.

## Typography

All explicit font assignments use `NSFont` system fonts. Measurements are AppKit
points, not CSS pixels; no fixed font-family name or scale ratio is prescribed.

| Element | Size | Weight |
| --- | --- | --- |
| Window content heading | 26 | Semibold |
| Description and status | 12 | Regular |
| Passage page label | 12 | Medium |
| Archive/search rows | 13 | Medium |
| Transcript reader | 14 | System default |
| Ordinary action buttons | 13 | Medium |
| Delete/discard button | 13 | Semibold |

Shared labels wrap by words. Archive rows override this with tail truncation and
a maximum of three lines; the full summary is also their tooltip and
accessibility label. The reader preserves transcript text without rich text,
graphics import, or automatic link detection.

## Layout

The resizable, titled window starts with a content rectangle of 980 by 720 points
and sets `NSWindow.minSize` to 820 by 600. These are distinct AppKit properties;
the minimum window size is not a guarantee of an identical content size. The
window is centered and is not restorable.

A vertical stack places the heading, description, action row, status, filter row,
list/reader body, and footer in that order. Insets are 28 points horizontally and
24 vertically; stack spacing is 16. Action, filter, paging, and footer stacks use
12-point spacing. The search field has a minimum width of 260 points.

The body keeps a fixed 270-point list beside a flexible reader, separated by 20
points. Both columns match the body height, whose minimum is 260 points. Table
rows are 76 points high and have no column header. Each pane scrolls vertically.
The reader has horizontal/vertical text insets of 16/12 points and does not resize
horizontally. `ArchiveReadingScrollView.layout` recalculates its text-container
width from the visible clip area, so long lines wrap as the window narrows.

There is no compact single-column variant or mobile breakpoint in this surface.

## Elevation & Depth

The archive surface uses a continuous dark canvas and brighter button fills with
borders. The archive implementation adds no custom shadows, gradients, cards, or
blur. Window chrome and native control rendering remain AppKit-owned.

## Shapes

Shared `AfternoteButton` controls have 6-point corners and a 1-point border when
the secondary style supplies one. Their intrinsic size adds 18 points of width
and 8 points of height to AppKit's result, with a 30-point minimum height. These
are sizing rules, not an extracted padding token. Search, segmentation, table
selection, and scrollbars retain their native control shapes.

## Components

The action row contains Import transcript, conditional Pause import, conditional
Authenticate, and Refresh. The filter row combines Saved/Paused imports with an
exact-word search field. The footer contains Next Archives, Resume with same
file, and Delete Archive; selecting a paused import changes deletion to Discard
paused import. Import and deletion use native sheets. Deletion's sheet explains
that the original transcript file remains unchanged.

Ordinary buttons use the shared secondary style. Hover blends their raised fill
8% toward white; pressing uses the surface fill. Disabled rendering reduces fill
alpha to 0.42 and overall view alpha to 0.72. The button requests AppKit's exterior
focus ring. Delete/discard retains the secondary fill/border and changes its font
weight and title tint through the destructive style.

Lists request at most 20 Archives per page; search returns at most 20 matching
passages. Search rows show the Archive title, a one-based passage number, and an
excerpt. Selecting a hit opens that passage. Saved Archives open at the beginning;
paused imports instead show their ID and saved/expected byte counts.

The selectable, read-only reader requests two passages at a time and concatenates
their original text. Previous passages and Next passages navigate bounded pages.
Page labels show the one-based passage range and “Read only.” Loading replaces
the old label with “Loading passages…”; search resets it to “Select a matching
passage,” and list/lock resets use “Select an Archive.”

Loading disables row selection and actions that depend on a completed result.
Refresh/search clear previous rows and reading state before requesting new data.
Selection handlers also reject input while loading. Generation checks ignore
late completions after newer operations or lock/close. Lock and close clear rows,
selection, reader text and undo state, and the search query; an active import is
paused. Errors clear plaintext and require authentication again.

The implementation supplies accessibility labels for status, search, table,
reader, and row summaries. These source assignments do not establish that actual
VoiceOver navigation or announcements have been verified.

## Do's and Don'ts

- Do preserve the existing AppKit controls, shared appearance functions, and
  plain-text reading behavior when extending this window.
- Do clear obsolete rows and page context before a new request and reject stale
  completions; visible selection must correspond to the active result set.
- Do retain the excerpt and passage number in search results, including the full
  summary for assistive access when the displayed row is truncated.
- Do keep the reader's text measure tied to the visible scroll area and keep
  passage labels synchronized with loading, search, selection, and lock states.
- Don't describe exact-word search as semantic retrieval or a paused import as a
  saved Archive.
- Don't turn these surface measurements into global design rules or translate
  native controls into invented CSS tokens.

The finish-review disposition is **ship for the four material fixes at the
code/test scope**: stale-list interaction handling, search-result excerpts,
narrow-window transcript wrapping, and page-label state. The native smoke fixture
and its Bun wrapper cover bounded requests, stale completion rejection, cleared
rows/disabled selection during search, read-only content, page navigation, lock
clearing, and narrow text layout. Excerpt composition and the broader page-label
transitions are also supported by source review; this is not a claim of dedicated
runtime coverage for every label state.

Visual capture did not validate all platform-control layers. Full visual QA,
native hover/focus rendering, and VoiceOver interaction remain unverified by that
capture. This scoped design disposition is not release approval and does not
replace the verification, signing, and notarization gates in the feature document.
