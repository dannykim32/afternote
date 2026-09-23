---
name: Afternote Conversation Archives
description: Implemented design of the native macOS Archive list and read-only passage viewer.
---

# Design System: Conversation Archives

## Overview

This record covers only `AfternoteArchiveWindow`, an Operate/Read extension of the
existing dark AppKit Notes surface. It does not replace the global visual identity.
[`archive_window.mm`](../../../apps/local/native/archive_window.mm) and
[`native_appearance.mm`](../../../apps/local/native/native_appearance.mm) are the
visual sources of truth; [`CONVERSATION_ARCHIVES.md`](../../CONVERSATION_ARCHIVES.md)
owns function and release gates. Import is explicit, paused work stays visible,
and locking clears displayed content.

Native font roles, sRGB components, and point measurements retain their source
semantics. No CSS substitutes or browser previews are invented; the web-oriented
`.impeccable/design.json` sidecar is omitted.

## Colors

The window forces `NSAppearanceNameDarkAqua`. Shared native sRGB red/green/blue
components below all have alpha 1:

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

Explicit fonts use `NSFont` system fonts, measured in AppKit points.

| Element | Size | Weight |
| --- | --- | --- |
| Window content heading | 26 | Semibold |
| Description and status | 12 | Regular |
| Passage page label | 12 | Medium |
| Archive/search rows | 13 | Medium |
| Transcript reader | 14 | System default |
| Ordinary action buttons | 13 | Medium |
| Delete/discard button | 13 | Semibold |

Labels wrap by words; rows use three-line tail truncation with the full summary
in their tooltip and accessibility label. Reader text is plain, with graphics
import and automatic link detection disabled.

## Layout

The centered, resizable window starts at 980 by 720 content points and sets
`NSWindow.minSize` to 820 by 600 (a window size, not a content-size guarantee).
Window restoration is disabled.

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

The continuous dark canvas uses brighter, bordered button fills. No custom
shadows, gradients, cards, or blur are added. Chrome remains AppKit-owned.

## Shapes

Shared `AfternoteButton` controls have 6-point corners and a 1-point border when
the secondary style supplies one. Their intrinsic size adds 18 points of width
and 8 points of height to AppKit's result, with a 30-point minimum height. These
are sizing rules, not an extracted padding token. Search, segmentation, table
selection, and scrollbars retain their native control shapes.

## Components

Actions are Import transcript, conditional Pause import/Authenticate, and
Refresh. Filters are Saved/Paused imports and exact-word search. The footer offers
Next Archives, Resume with same file, and Delete Archive (Discard paused import
for incomplete work). Import and deletion use native sheets; deletion explains
that the source transcript stays unchanged.

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

Loading disables row selection and dependent actions; selection handlers also
reject input. Refresh/search clear old rows and reading state. Generation checks
ignore stale completions. Lock/close clear rows, selection, reader/undo state, and
query, and pause import. Errors clear plaintext and require authentication again.

Status, search, table, reader, and row summaries have accessibility labels.
VoiceOver navigation and announcements have not been verified by source review.

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
