<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
SPDX-License-Identifier: MIT
-->

# Page dependencies fetched once

- Scripts, style sheets, images and frames the pages load are fetched once per run, whatever their origin.
- A broken or insecure dependency is one finding listing the pages that use it, not one finding per page.
- Cross-origin scripts without integrity hashes and plain-HTTP resources on HTTPS pages are reported.
