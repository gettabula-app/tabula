# Code blocks

A code block puts code on the board as a card of coloured, fixed-width text: a title if you want one, the language, line numbers if you want them. It is an object like any other: you can move, lock, copy and comment on it, and it appears in exports.

> **One writer at a time.** The code of a block is one piece of text. If two people type in the *same* block at the same moment, the later change replaces the earlier one. Different blocks are independent.

## Add one

Open the **Text and content** tool in the tool rail (the first button, with a small arrow) and choose **Code block**, then click the board for a block 520 wide, or drag to set its width. It opens for typing at once. A new block starts in the language you used last on this board, or in Plain text; on a phone or tablet it wraps long lines.

## Type in it

Double-click the block, or select it and press `Enter`, to type in place. The text box sits exactly over the code, so nothing moves when you start. While you type the colours are off; they come back when you finish.

| Key | What it does |
|---|---|
| `Tab` | Two spaces. With several lines selected, indents all of them. |
| `Shift+Tab` | Takes up to two spaces off each selected line |
| `Enter` | A new line with the same indentation |
| `Esc` or `Ctrl+Enter` (`Cmd+Enter` on Mac) | Finish. Clicking away does too. |

A block holds up to 20,000 characters. A longer paste is cut, and you are told. Everything you type in one go is a single step for **Undo**.

## Copy, wrap and scroll

Move the pointer over a block (or select it) and two buttons appear at its top right: **Wrap lines** and **Copy code**. Copy puts the plain code on the clipboard, without colours or line numbers. On a touch screen the buttons are always shown.

With wrapping off, a long line is cut at the edge of the card. Scroll the code sideways with a sideways swipe or wheel, `Shift` + wheel, or click into the block with `Tab` and use `Left`, `Right`, `Home` and `End`.

## Properties

Select a block and open **More properties**:

- **Language**: a list with a search field. Plain text is first, then the common languages, then the rest by name.
- **Title**: shows in a header on the card. Empty means no header.
- **Line numbers** and **Wrap lines**.
- **Width**, like other objects. A block's height always fits its code.

The colours of the code follow the board's theme; there is nothing to set.

## Share and export

PNG, SVG and print show the block as it looks on the board, without the buttons. A board file (`.drift`) and a JSON snapshot keep the code, language and title. An AI agent connected with an access token can create and change code blocks, and Tabula's built-in AI reads the code like the text of any object. See [Code blocks](../code-blocks.md) for the details.

## Keyboard and screen readers

Each block is a region named by its title and language, for example "Code, Deploy script, Shell". Use `Tab` to reach its code area and the arrow keys to scroll it. In Windows high contrast the card has a plain edge and the code is shown in the system colours.

## Not yet

Code blocks inside Markdown blocks are not coloured yet, and there is no folding, no line highlighting and no choice of colour theme.
