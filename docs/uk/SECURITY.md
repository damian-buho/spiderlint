<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>
SPDX-License-Identifier: AGPL-3.0-only
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
| [CVE-2026-33671](https://nvd.nist.gov/vuln/detail/CVE-2026-33671) | transitive picomatch dep of a pinned upstream npm release; fixable only upstream |
| [CVE-2026-112366](https://nvd.nist.gov/vuln/detail/CVE-2026-112366) | blocked by upstream; picomatch ships no fixed release yet |
| [CVE-2026-123158](https://nvd.nist.gov/vuln/detail/CVE-2026-123158) | not affected on Ubuntu, sshd on musl without PAM only (ubuntu.com/security/CVE-2026-123158) |
| [GHSA-c2c7-rcm5-vvqj](https://github.com/advisories/GHSA-c2c7-rcm5-vvqj) | transitive picomatch dep of a pinned upstream npm release; fixable only upstream |
| [GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf) | blocked by upstream; picomatch ships no fixed release yet |

<!-- textlint-enable -->
