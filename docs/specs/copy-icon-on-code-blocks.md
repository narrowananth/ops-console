# Copy icon on code blocks

**Status:** shipped
**Design:** none. The icon follows the console's own Copy button on a step's raw output.

## Problem

The agent's text holds commands, paths and snippets in code blocks, and most of them cannot be copied with a click. The
operator selects the text by hand, and a long line or a block inside a scrolling area makes that slow and easy to get
wrong. A few places have a text Copy button; the rest have nothing, and the buttons that exist look different from each
other.

## Behavior

1. Every block of preformatted text the console draws has a copy icon in its top right corner. The block is one unit:
   a fenced code block in the agent's text, a code part of the transcript, an Approval's command, a Verification's
   replay request and response, the raw error of a run, the raw output of a step, and a text file in the viewer.
2. The icon sits in the block's corner and stays in view while a long block scrolls. It never covers text: a block
   keeps the room it needs under the icon's width.
3. The icon shows on hover and on keyboard focus of the block, and always on a touch screen. It is a button with the
   name "Copy" for a screen reader.
4. Click copies the block's whole text exactly as drawn: line breaks and indentation kept, no trailing newline added,
   not the part that fits the box. A text file in the viewer copies the part the viewer shows, the first 256 KB.
5. After the click the icon turns into a check for 1.5 seconds, then goes back. When the browser refuses to copy, it
   turns into a cross for the same time and the block's tooltip says to select the text and press ⌘C.
6. A block with no text draws no icon.
7. Where a block already had its own text Copy button or copy pill (a step's raw output, Copy error on a run), the icon
   replaces it. A button that copies something other than one block, such as Copy on a Report or on an operator's
   message, stays.
8. The icon works inside a dialog and inside a block that is itself a button's content. A click on it does not open,
   close or toggle what sits around it.
9. One block's state is its own: copying one never shows a check on another.
10. A block of a streaming message copies the text received so far. The icon stays while text arrives.
11. The terminal in Dev tools is a live shell and gets no icon; its text is the operator's to select.

## Settled

- **Icon, not word**: a small icon button, one component for every block, in place of the per-screen text buttons.
- **Whole block**: no "copy line" or selection copy. The browser's own selection stays.
- **Clipboard**: the console's existing copy path, with its fallback when the page lacks focus.

## Not required

- **A Copy all** for a whole message or a Session.
- **Syntax colors** or a language label on a block.
- **Icons on inline code** in a sentence. It is short enough to select.

## Safety

No change. The copy runs in the browser on text already shown; it reads nothing from the agent or the daemon.

## UI

Every screen that draws a block gets the icon: the Session transcript, a Report, a pull request thread and review, the
Alert view, the Agent runs page detail, Approvals and the attachment viewer. States: idle, hover or focus, copied,
not copied. No loading or empty state; PROD changes nothing. The Running tray has no block.

## Rejected

- **A text "Copy" button in each block**: crowds a short block and differs from screen to screen today.
- **Copy on click of the block**: a click is also how the operator starts a selection.
- **Always-visible icon on every block**: a long list of small blocks looks noisy.

## Glossary

- **Code block**: preformatted text the console draws in a box with a copy icon, however it got there: a fenced block in
  the agent's text, a command, a raw error, a request or a text file.

## Seams

- **Code block component** (frontend component): 2, 3, 4, 5, 6, 8, 9, 10.
- **Markdown rendering of a fenced block** (frontend component): 1, 4.
- **Screens that draw a block** (browser): 1, 7, 11, the UI list.

## Out of scope

- A Copy all for a message. Its own spec if the operator asks.
