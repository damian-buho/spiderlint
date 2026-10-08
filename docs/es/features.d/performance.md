<!--
SPDX-FileCopyrightText: 2026 Damián Búho <damian.buho@proton.me>

SPDX-License-Identifier: MIT
-->

<!-- textlint-disable terminology,common-misspellings -->

# Problemas de velocidad encontrados sin navegador

- Cada respuesta de texto debe ir comprimida con Brotli, Zstandard o gzip, y cada página debe poder guardarse en caché, revalidarse y entrar en la caché de ida y vuelta.
- Se informa de un servidor que sigue en HTTP/1.1, de uno que no anuncia HTTP/3 y de un certificado cuya clave RSA hace cada negociación más grande de lo que haría una clave EC.
- Se informa, por tipo de archivo, de un archivo que un navegador o una CDN puede guardar mucho tiempo en una URL que nunca cambia, de modo que sigue obsoleto tras la siguiente publicación.
- Los scripts y hojas de estilo que bloquean el primer renderizado, una primera imagen con carga diferida y las imágenes sin tamaño que les reserve su hueco se encuentran en el HTML de cada página.
- Las páginas renderizadas obtienen las puntuaciones de rendimiento, accesibilidad, buenas prácticas y SEO de Lighthouse y LCP, CLS, TBT y FCP de laboratorio, en una muestra de cada plantilla.

<!-- textlint-enable -->
