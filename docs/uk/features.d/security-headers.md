<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>

SPDX-License-Identifier: MIT
-->

<!-- textlint-disable terminology,common-misspellings -->

# Заголовки безпеки оцінюються, а не лише виявляються

- Content-Security-Policy читається директива за директивою, із заголовка чи `<meta>`: вбудовані скрипти без nonce чи хешу, `eval`, скрипти з будь-якого хосту та відсутні `object-src`, `base-uri`, `frame-ancestors` чи Trusted Types — кожне окрема знахідка.
- HSTS має тривати досить довго й охоплювати піддомени, а відповіді не мають вгадувати тип вмісту, вбудовуватися в чужі сайти чи розкривати повні URL через referrer.
- Ізоляція між джерелами, Permissions-Policy і точки звітування перевіряються на кожній сторінці, а не лише на головній.
- У звіт потрапляє заголовок X-XSS-Protection, що досі вмикає застарілий фільтр, бо сам цей фільтр можна використати для атаки.

<!-- textlint-enable -->
