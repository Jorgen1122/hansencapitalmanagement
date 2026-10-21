# Hansen Capital Management — Design System

Direction: dark navy with ivory serif text, plus terminal-style layouts.
- Header: pill navigation, with Client Login and Book a Call as pills on the right.
- Page layouts: ruled panels, tables and matrices, styled like a trading terminal.
- Type: Cormorant Garamond headings over Inter text.

Everything lives in `site.css`. Pages carry no inline `<style>` blocks.

## Tokens
| Token | Value | Use |
|---|---|---|
| navy | #071428 | Header and footer (matches the logo background) |
| ground | #050D1B | Page background |
| panel / panel-2 | #0A1628 / #0E1D35 | Panels / table heads and panel bars |
| line / line-2 | #1A2A45 / #26395C | Hairlines |
| ivory / text / muted / dim | #F4F0E6 / #DCE1EA / #A9B3C2 / #7E8BA1 | Headings, body text, secondary text, labels |
| gold / gold-hi | #D4AF37 / #E6C55A | Primary buttons, active pills, accents |
| up / down | #6FD3A4 / #EE9273 | Month-over-month changes |

## Type
- Headings: Cormorant Garamond 500–600, with italic for taglines and quotes.
- Text and UI: Inter 400–700.
- Fonts are self-hosted in `fonts/`.
- Numerals are always lining (`font-variant-numeric: lining-nums`), so 0 and 1 never read as O and I.

## Patterns
- **Pill nav:** a rounded track with the active page filled gold.
- **Terminal panel:** a bar with small uppercase labels on top, and a table underneath. Totals carry a 3px double gold rule.
- **Service table:** Cadence, Service, Scope and Details columns. On mobile it stacks into rows.
- **Matrix:** a grid of cells with 1px gaps, each with a small category tag.
- **Dashboard:**
  - a top strip of six numbers showing the change vs. the prior month and a 12-month sparkline;
  - a trends panel with View, Range (3M/6M/12M/All) and Metric controls;
  - a right column with the invoice, books-closed status and help card;
  - documents and security panels below.

## Rules
- Do not add inline styles or new font CDNs (the portal CSP is `font-src 'self'`).
- Don't rename IDs used by `login.js`, `reset-password.js`, `dashboard.js`, `portal-auth.js`, `consent.js` or the contact form script.
