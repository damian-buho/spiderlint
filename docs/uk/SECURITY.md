<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
SPDX-License-Identifier: MIT
pf-cli-managed: yes
-->

<!-- textlint-disable terminology,common-misspellings -->
[English](../../SECURITY.md) · [Español](../es/SECURITY.md)

# Політика безпеки

## Як повідомити про вразливість

**Не повідомляйте про вразливості безпеки через публічні задачі, обговорення або запити на зміну.**

Зробіть це, написавши на **<damian.buho@proton.me>**.

Додайте стільки з наведеного, скільки зможете — це допоможе нам швидше розсортувати та вирішити повідомлення:

- Тип проблеми (наприклад переповнення буфера, ін'єкція SQL, cross-site scripting)
- Версію або версії, яких це стосується
- Вплив проблеми, зокрема як зловмисник може її використати
- Покрокові інструкції для відтворення проблеми
- Розташування відповідного вихідного коду (тег, гілка, коміт або пряме URL)
- Повні шляхи файлів вихідного коду, пов'язаних із проблемою
- Будь-яку конфігурацію, необхідну для відтворення проблеми
- Відповідні файли журналів, якщо можливо
- Доказ концепції або код експлойту, якщо можливо

Ми прагнемо підтвердити отримання повідомлення протягом 30 днів і
скоординувати розкриття, щойно буде готове виправлення.

## Шифрування повідомлення

Якщо ви хочете надіслати нам зашифроване повідомлення, виконайте ці кроки.

Імпортуйте наш відкритий ключ:

```sh
gpg --keyserver keys.openpgp.org --recv-keys B64C122EE16C3746
```

Перевірте, що відбиток збігається, перш ніж довіритися йому:

```sh
gpg --fingerprint B64C122EE16C3746
```

Вивід має показати:

```text
6F19 7084 3C9E 8406 AD70  0467 B64C 122E E16C 3746
```

Зашифруйте своє повідомлення для нас:

```sh
gpg --encrypt --armor --recipient B64C122EE16C3746 message.txt
```

## Винагорода за вразливості

Spiderlint наразі не має програми винагород за вразливості. Проте ми цінуємо
відповідальні повідомлення — див. канал контакту вище.

## Визнані вразливості

Наведені знахідки переглянуто та навмисно придушено (виправлення залежить від
наступного випуску upstream-проєкту, або повідомлення не стосується цього проєкту):

| ID | Причина |
| --- | --- |
| CVE-2026-12151 | bundled undici < 6.27.0 in npm; fixed upstream, drop after the node fleet rebuilds |
| GHSA-vxpw-j846-p89q | bundled undici < 6.27.0 in npm; fixed upstream, drop after the node fleet rebuilds |
| CVE-2026-13149 | bundled brace-expansion < 5.0.7 in npm; fixed upstream, drop after the node fleet rebuilds |
| CVE-2026-14257 | bundled inside npm (latest dist-tag); no npm release ships the fix |
| CVE-2026-19534 | bundled undici < 6.28.1 in npm (latest dist-tag); no npm release ships the fix |
| CVE-2026-26996 | bundled minimatch < 10.2.1 in npm; fixed upstream, drop after the node fleet rebuilds |
| CVE-2026-27903 | bundled minimatch < 10.2.3 in npm; fixed upstream, drop after the node fleet rebuilds |
| CVE-2026-27904 | bundled minimatch < 10.2.3 in npm; fixed upstream, drop after the node fleet rebuilds |
| CVE-2026-33671 | bundled picomatch < 4.0.4 (npm via tinyglobby, pnpm); fixed upstream, drop after the node fleet rebuilds |
| CVE-2026-69152 | bundled inside npm (latest dist-tag); no npm release ships the fix |
| CVE-2026-69192 | bundled inside npm (latest dist-tag); no npm release ships the fix |
| CVE-2026-73566 | bundled tar < 7.5.21 in npm; fixed upstream, drop after the node fleet rebuilds |
| CVE-2026-102276 | bundled brace-expansion < 5.0.10 in npm (latest dist-tag); no npm release ships the fix |
| CVE-2026-102278 | bundled brace-expansion < 5.0.11 in npm (latest dist-tag); no npm release ships the fix |
| GHSA-528h-pc64-c93x | transitive stream-json dep of a pinned crawlee release; fixable only upstream |
| GHSA-ch52-4w7c-c8xp | cache semantics |

<!-- textlint-enable -->
