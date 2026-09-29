<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
SPDX-License-Identifier: MIT
-->

# CSS checked as browsers read it

- Style sheets and inline CSS are parsed for what browsers silently drop: syntax errors that lose a whole rule, misspelled properties and values outside a property’s grammar.
- Each defect names its line and column, in the style sheet or in the page that holds the inline block.
- A style sheet every page loads is one finding with the pages that use it, and inline CSS folds per template.
- Features the project’s declared browsers lack are listed with the browsers that lack them, while code behind `@supports` is left alone.
- Vendor prefixes and old browser hacks are never reported, and the check needs no Java validator.
